/**
 * ============================================================================
 * EVENTBASE STORE
 * ============================================================================
 * Qdrant insert / query / list / delete wrappers for EventBase collections.
 * All operations target a per-chat EventBase collection, isolated from the
 * legacy chunk collection.
 * ============================================================================
 */

import {
    insertVectorItems,
    queryCollection,
    deleteVectorItems,
    getAdditionalArgs,
    getSavedHashes,
} from './core-vector-api.js';
import { saveSettingsDebounced, getRequestHeaders, getCurrentChatId } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getChatUUID, buildEventBaseCollectionId, getRegistryBackend, COLLECTION_PREFIXES, parseRegistryKey, buildChatSearchPatterns, matchesPatterns } from './collection-ids.js';
import { registerCollection, getCollectionRegistry, getCollectionListing } from './collection-loader.js';
import { getChatLockedCollections, isCollectionActiveForContextAnyKey } from './collection-metadata.js';
import { buildEmbedText } from './eventbase-schema.js';
import { log } from './log.js';

// Re-export so callers can import from here if needed
export { buildEventBaseCollectionId };

// In-memory Set cache for O(1) window dedup lookups.
// Backed by the serialized array in extension_settings (which survives reload).
// Built lazily on first access per chat UUID.
const _windowCacheSet = new Map(); // chatUUID → Set<fingerprint>

// In-memory cache for the "vectorization tip" — the index one past the last
// message that has any extracted event window covering it (== max(source_window_end)+1).
// Used by the Auto-Sync UI to show "vectorization: N msgs" honestly. The
// auto-sync START marker (eventbase_autosync_start_marker) only records where
// auto-sync was first enabled, so it lies as new windows extract after enable.
// This cache is the truth source for the UI.
//
// Lifecycle:
//   - written by the ingestion loop after each successful markWindowExtracted
//   - persisted to extension_settings.vectfox.eventbase_vectorization_tip so the
//     value survives reload WITHOUT a backend probe (benefits standard+plugin and
//     qdrant+plugin users; standard-no-plugin can't probe anyway). See getter.
//   - probed via ensureVectorizationTip only when neither the in-memory cache nor
//     the persisted map has a value (i.e. the very first read on a chat)
//   - cleared by clearVectorizationTip (parity with clearAutoSyncMarker)
const _vectorizationTipByUuid = new Map(); // chatUUID → number (tip)

/**
 * Sync getter. On in-memory miss, warms the cache from the persisted
 * extension_settings map, so the tip is correct immediately after a reload with
 * no backend round-trip. Returns undefined only when nothing is known yet.
 */
export function getVectorizationTip(chatUUID) {
    if (!chatUUID) return undefined;
    const cached = _vectorizationTipByUuid.get(chatUUID);
    if (typeof cached === 'number') return cached;
    const persisted = extension_settings?.vectfox?.eventbase_vectorization_tip?.[chatUUID];
    if (typeof persisted === 'number') {
        _vectorizationTipByUuid.set(chatUUID, persisted);
        return persisted;
    }
    return undefined;
}

/** Sync setter — monotonic max (in-memory + persisted) so out-of-order calls don't regress the tip. */
export function setVectorizationTip(chatUUID, tip) {
    if (!chatUUID || typeof tip !== 'number' || !Number.isFinite(tip)) return;
    const current = _vectorizationTipByUuid.get(chatUUID) ?? -1;
    if (tip > current) _vectorizationTipByUuid.set(chatUUID, tip);
    // Persist (also monotonic) so the value survives reload without a probe.
    const store = extension_settings?.vectfox;
    if (store) {
        if (!store.eventbase_vectorization_tip) store.eventbase_vectorization_tip = {};
        if (tip > (store.eventbase_vectorization_tip[chatUUID] ?? -1)) {
            store.eventbase_vectorization_tip[chatUUID] = tip;
            saveSettingsDebounced();
        }
    }
}

/** Clear the cached + persisted tip (e.g. when the user clears EventBase for this chat). */
export function clearVectorizationTip(chatUUID) {
    if (!chatUUID) return;
    _vectorizationTipByUuid.delete(chatUUID);
    const store = extension_settings?.vectfox?.eventbase_vectorization_tip;
    if (store && Object.prototype.hasOwnProperty.call(store, chatUUID)) {
        delete store[chatUUID];
        saveSettingsDebounced();
    }
}

// Per-chat maps in extension_settings.vectfox that are keyed by chat UUID and only
// shrink via explicit clear paths (collection delete / fresh-extraction). Without a
// sweep they accumulate one stale entry per chat deleted OUTSIDE the EventBase flow.
const _ORPHANABLE_CHAT_MAPS = [
    'eventbase_autosync_start_marker',
    'eventbase_last_used_window_size',
    'eventbase_vectorization_tip',
];

/**
 * Prune orphaned per-chat entries from the EventBase maps above (+ the in-memory
 * tip cache). An entry is orphaned when its chat UUID is NOT in `liveUuids` — the
 * set of UUIDs that still have an EventBase/archive-event collection, supplied by
 * the caller (which owns the registry). All pruned values are regenerable: a live
 * chat that loses its marker/tip re-stamps/re-probes on the next ingestion, so an
 * over-eager prune self-heals rather than losing real data.
 *
 * @param {Set<string>} liveUuids
 * @returns {number} entries removed across the persisted maps
 */
export function pruneOrphanedChatMaps(liveUuids) {
    if (!(liveUuids instanceof Set)) return 0;
    const store = extension_settings?.vectfox;
    if (!store) return 0;

    let removed = 0;
    for (const mapKey of _ORPHANABLE_CHAT_MAPS) {
        const m = store[mapKey];
        if (!m || typeof m !== 'object') continue;
        for (const uuid of Object.keys(m)) {
            if (!liveUuids.has(uuid)) {
                delete m[uuid];
                removed++;
            }
        }
    }
    // Drop in-memory tip entries for the same orphans (their persisted copy is gone).
    for (const uuid of [..._vectorizationTipByUuid.keys()]) {
        if (!liveUuids.has(uuid)) _vectorizationTipByUuid.delete(uuid);
    }
    if (removed > 0) {
        saveSettingsDebounced();
        log.lifecycle(`[EventBase] Pruned ${removed} orphaned per-chat entries (marker / last-window-size / tip)`);
    }
    return removed;
}

/**
 * Async cache-miss reader. On hit (in-memory OR persisted, via getVectorizationTip),
 * returns the tip immediately with no backend round-trip. Only when nothing is
 * known yet does it probe the backend via listChunks ONCE, populate the cache, and
 * return the value. Same shape as stampAutoSyncMarker's existing scan, so cost on a
 * genuinely-cold chat is the same as the existing marker-stamp flow.
 *
 * @param {string} chatUUID
 * @param {string} collectionId  - Bare or registry-key form; passed straight to listChunks.
 * @param {object} settings
 * @returns {Promise<number|null>}  Tip, or null if the collection has no events yet.
 */
export async function ensureVectorizationTip(chatUUID, collectionId, settings) {
    if (!chatUUID) return null;
    const cached = getVectorizationTip(chatUUID); // in-memory, else warms from persisted
    if (typeof cached === 'number') return cached;
    if (!collectionId) return null;
    try {
        const { getBackend } = await import('../backends/backend-manager.js');
        const backendInstance = await getBackend(settings);
        const result = await backendInstance.listChunks(collectionId, settings, { limit: 10000 });
        const items = Array.isArray(result?.items) ? result.items : [];
        let maxEnd = -1;
        for (const it of items) {
            const end = it?.metadata?.source_window_end;
            if (typeof end === 'number' && end > maxEnd) maxEnd = end;
        }
        if (maxEnd < 0) return null;
        const tip = maxEnd + 1;
        _vectorizationTipByUuid.set(chatUUID, tip);
        return tip;
    } catch (err) {
        log.warn(`[EventBase VectorizationTip] probe failed for ${collectionId} — falling back to marker:`, err?.message || err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Embed and insert a batch of validated EventRecord objects into Qdrant.
 * Each event gets its own Qdrant point (vector = embedText embedding, payload = full record).
 *
 * @param {object[]} events      - Array of full EventRecord objects (with ingestion metadata)
 * @param {object}   settings    - VectFox settings
 * @param {AbortSignal|null} [abortSignal]
 * @returns {Promise<void>}
 */
export async function insertEvents(events, settings, abortSignal = null, collectionIdOverride = null) {
    if (!events?.length) return;

    const chatUUID = events[0].chat_uuid;
    const collectionId = collectionIdOverride || buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    if (!collectionId) throw new Error('EventBase: Cannot build collection ID — no active chat');

    // Build embed texts for all events at once (for efficient batched embedding)
    const embedTexts = events.map(e => buildEmbedText(e));

    // Per-item embed-text preview log. Goal: when a batched embedding call
    // stalls, we need to know WHICH text was in the payload — so if it's a
    // single-item-induced stall (one unusually-long text, weird tokenization,
    // safety-trigger content) we can re-embed each in isolation to identify
    // the bad apple. Logged BEFORE the call so the preceding console lines
    // tell us the exact payload that the next "FAILED after 120s" refers to.
    // Format: len + first 80 chars (enough to identify, short enough to scan).
    // Per-item → Trace. Guarded so the preview loop is skipped when off.
    if (log.enabled('trace')) {
        log.trace(`[EventBase] Preparing embedding batch — ${embedTexts.length} item(s):`);
        for (let i = 0; i < embedTexts.length; i++) {
            const t = embedTexts[i] || '';
            const preview = t.slice(0, 80).replace(/\s+/g, ' ');
            log.trace(`  [${i}] len=${t.length} eventId=${events[i]?.event_id || '(no-id)'} text="${preview}${t.length > 80 ? '...' : ''}"`);
        }
    }

    // Generate embeddings (reuses same provider/model as legacy path)
    const additionalArgs = await getAdditionalArgs(embedTexts, settings);
    const clientEmbeddings = additionalArgs.embeddings || null;

    // Build insertable items
    const items = events.map((event, idx) => {
        const embedText = embedTexts[idx];
        const hash = _eventHash(event.event_id);
        const vector = clientEmbeddings?.[embedText] || null;

        // The summary string lives inside `text` (first line, after the [event_type] prefix).
        // Storing it again as a separate field is pure duplication, so we strip it from both
        // the top-level item and the metadata spread before sending to the backend.
        const { summary: _droppedSummary, ...eventWithoutSummary } = event;

        return {
            hash,
            text: embedText,
            index: event.source_window_end ?? (event.source_window_start != null ? event.source_window_start + 1 : idx + 1), // source_window_end for consistency with message_order injection field
            vector,             // null → server-side embedding
            // Top-level fields read by qdrant.js's payload builder.
            // qdrant.js spreads item.metadata first then explicitly overwrites these
            // fields from the top-level item. Without them defined here, they are
            // undefined → JSON.stringify drops them → Similharity server applies its
            // own defaults (importance=100).
            importance: event.importance,
            keywords: event.keywords || [],
            conditions: null,
            isSummaryChunk: false,
            parentHash: null,
            metadata: {
                ...eventWithoutSummary,
                eventbase: true,        // marker for filter queries
                eventbase_schema_version: event.schema_version,
            },
        };
    });

    // Defensive hash-uniqueness check. Qdrant treats same-ID upserts as
    // overwrites — silently. If two events in this batch produce the same hash,
    // one of them disappears with no error from any layer (plugin logs "Inserted
    // N", Qdrant returns 200, we'd never know). The hash widening to 53 bits
    // makes this collision statistically rare (~birthday-bound at 1.3M points),
    // but "rare" silent-loss bugs are worse than "occasional" loud ones — so we
    // assert it explicitly here, throw if it ever happens, and surface the
    // colliding event_ids to the user instead of dropping their data.
    const hashSeen = new Map();   // hash → event_id (first occurrence)
    for (const item of items) {
        const ev = events.find(e => _eventHash(e.event_id) === item.hash);
        const evid = ev?.event_id || '(unknown)';
        if (hashSeen.has(item.hash)) {
            const prevId = hashSeen.get(item.hash);
            throw new Error(
                `EventBase: hash collision inside one insert batch — events "${prevId}" and "${evid}" both hash to ${item.hash}. ` +
                `One would have been silently overwritten by Qdrant upsert. Aborting batch to prevent data loss. ` +
                `If this happens repeatedly, the hash function may need to be widened further.`,
            );
        }
        hashSeen.set(item.hash, evid);
    }

    log.lifecycle(`[EventBase] Inserting ${items.length} event(s) into collection "${collectionId}"`);

    await insertVectorItems(collectionId, items, settings, null, abortSignal);

    // Register collection so it appears in the registry / DB browser.
    // Use backend:collectionId format so the key survives plugin-based discovery
    // (which only knows about vectra/standard collections, not qdrant).
    const registryBackend = getRegistryBackend(settings?.vector_backend);
    const registryKey = `${registryBackend}:${collectionId}`;
    registerCollection(registryKey);

    log.lifecycle(`[EventBase] Insert complete for collection "${collectionId}"`);
}

// ---------------------------------------------------------------------------
// Query (for retrieval)
// ---------------------------------------------------------------------------

/**
 * Query the EventBase collection for events semantically similar to searchText.
 * Returns raw metadata array sorted by score (descending).
 *
 * @param {string} searchText
 * @param {number} topK
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<object[]>}  Array of event metadata objects with `.score`
 */
export async function queryEvents(searchText, topK, settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    const collectionId = await _resolveEventBaseCollectionIdForRead(settings, uuid);
    if (!collectionId) return [];

    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
    const { hashes, metadata } = await queryCollection(collectionId, searchText, topK, ebSettings);
    if (!hashes?.length) return [];

    // Attach hash to each metadata item for dedup / downstream use
    return metadata.map((meta, i) => ({
        ...meta,
        _hash: hashes[i],
    }));
}

// ---------------------------------------------------------------------------
// List (for Event Browser)
// ---------------------------------------------------------------------------

/**
 * List all stored events for the current chat.
 * @param {object} settings
 * @param {number} [limit]
 * @param {string} [chatUUID]
 * @returns {Promise<object[]>}
 */
export async function listEvents(settings, limit = 100, chatUUID) {
    // Reuse queryEvents with a broad query (empty string → backend returns recent/all items)
    // We overfetch and return up to `limit` items.
    return queryEvents('', Math.min(limit, 200), settings, chatUUID);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a stored event by its numeric hash.
 * @param {number} hash
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<void>}
 */
export async function deleteEventByHash(hash, settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    const collectionId = await _resolveEventBaseCollectionIdForRead(settings, uuid);
    if (!collectionId) return;

    await deleteVectorItems(collectionId, [hash], settings);
}

// ---------------------------------------------------------------------------
// Deduplication check
// ---------------------------------------------------------------------------

/**
 * Check which event IDs already exist in the collection for the given source
 * message hash set. Returns a Set of existing event_id strings.
 * Used by the ingestion pipeline to skip already-processed windows.
 *
 * NOTE: This is a best-effort check — it queries by overlap in
 * source_message_hashes. If Qdrant returns relevant existing events we
 * compare their source_message_hashes to find exact-coverage matches.
 *
 * @param {number[]} sourceHashes   - Hashes of messages in the candidate window
 * @param {number[]} messageIds     - 0-based message indices in the window
 * @param {object}   settings
 * @param {string}   [chatUUID]
 * @returns {Promise<boolean>}  true if this exact window is fully covered
 */
// ---------------------------------------------------------------------------
// Window fingerprint cache (stored in extension_settings, keyed by chatUUID)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AutoSync start-marker (per-chat) — see plans/autosync-independent-window-and-last-n-injection.md §9
// ---------------------------------------------------------------------------
//
// The window fingerprint dedup below is window-size-dependent: changing window
// size invalidates every cached fingerprint and would trigger a full chat
// re-extraction when auto-sync next runs. The marker is an additional gate
// stamped at "everything before this message index is considered covered;
// auto-sync should only process windows whose start >= marker." Stamped on
// auto-sync enable and re-stamped whenever the auto-sync window size setting
// changes (Phase 2 — see §9.8 of the linked plan).

/**
 * Look up the auto-sync start marker for a chat.
 * @param {string} chatUUID
 * @returns {number|undefined}  Marker (message index), or undefined if not stamped.
 */
export function getAutoSyncMarker(chatUUID) {
    if (!chatUUID) return undefined;
    return extension_settings?.vectfox?.eventbase_autosync_start_marker?.[chatUUID];
}

/**
 * Clear the auto-sync start marker for a chat. Called when auto-sync is
 * disabled, so re-enabling later re-computes a fresh marker.
 * @param {string} chatUUID
 */
export function clearAutoSyncMarker(chatUUID) {
    const store = extension_settings?.vectfox?.eventbase_autosync_start_marker;
    if (!store || !chatUUID) return;
    if (Object.prototype.hasOwnProperty.call(store, chatUUID)) {
        delete store[chatUUID];
        saveSettingsDebounced();
    }
}

/**
 * Stamp the auto-sync start marker for a chat. Used to gate which windows
 * the auto-sync workflow will process.
 *
 * Smart placement:
 *   - If the EventBase collection has existing events → marker = max(source_window_end) + 1
 *     (backfill the gap between last-covered message and current chat tail
 *     at the user's new window size).
 *   - If the collection is empty → marker = current chat length
 *     (auto-sync starts "from now on" — no full backfill of a long pre-existing
 *     chat that was never vectorized).
 *
 * Floor override: pass `{ floor: 'chatLength' }` to force "from now on" placement
 * regardless of existing coverage — used by the auto-sync enable flow's "Just keep
 * up from here" choice, where the user explicitly declines backfilling the gap.
 *
 * @param {string} chatUUID
 * @param {object} settings
 * @param {{ floor?: 'chatLength' }} [options]
 * @returns {Promise<number>}  The marker that was stamped.
 */
export async function stampAutoSyncMarker(chatUUID, settings, options = {}) {
    if (!chatUUID) return 0;
    const store = extension_settings?.vectfox;
    if (!store) return 0;

    const chatLength = getContext()?.chat?.length ?? 0;

    // Explicit "from now on" — skip the coverage scan entirely.
    if (options.floor === 'chatLength') {
        if (!store.eventbase_autosync_start_marker) store.eventbase_autosync_start_marker = {};
        store.eventbase_autosync_start_marker[chatUUID] = chatLength;
        saveSettingsDebounced();
        log.lifecycle(`[EventBase] AutoSyncMarker stamped (floor=chatLength): uuid=${chatUUID}, marker=${chatLength}`);
        return chatLength;
    }

    // Resolve the write target, so the marker is computed from the collection the
    // user is actually vectorizing — not an arbitrary per-persona sibling (the
    // stale-import bug). The marker is a message index into THIS chat, so it must
    // never be derived from a foreign-UUID collection locked in for retrieval.
    const active = resolveEventBaseWriteTarget(settings, chatUUID);

    let maxEnd = -1;
    if (active) {
        try {
            const { getBackend } = await import('../backends/backend-manager.js');
            const backendInstance = await getBackend(settings);
            // Overfetch generously; per-chat EventBase collections are typically
            // O(hundreds to low thousands) of events. listChunks is paged anyway.
            const result = await backendInstance.listChunks(active.collectionId, settings, { limit: 10000 });
            const items = Array.isArray(result?.items) ? result.items : [];
            for (const it of items) {
                const end = it?.metadata?.source_window_end;
                if (typeof end === 'number' && end > maxEnd) maxEnd = end;
            }
        } catch (err) {
            log.warn(`[EventBase AutoSyncMarker] listChunks failed for ${active.collectionId} — falling back to chat-tail marker:`, err?.message || err);
        }
    }

    const marker = maxEnd >= 0 ? maxEnd + 1 : chatLength;

    if (!store.eventbase_autosync_start_marker) store.eventbase_autosync_start_marker = {};
    store.eventbase_autosync_start_marker[chatUUID] = marker;
    saveSettingsDebounced();

    log.lifecycle(`[EventBase] AutoSyncMarker stamped: uuid=${chatUUID}, marker=${marker} (maxEnd=${maxEnd}, chatLength=${chatLength}, active=${active?.collectionId ?? 'none'})`);
    return marker;
}

/**
 * Look up the last successfully-used window size for a chat.
 * Used by Vectorize Content → Continue to detect window-size changes that
 * would trigger a full re-extraction (and warn the user before proceeding).
 * @param {string} chatUUID
 * @returns {number|undefined}
 */
export function getLastUsedWindowSize(chatUUID) {
    if (!chatUUID) return undefined;
    return extension_settings?.vectfox?.eventbase_last_used_window_size?.[chatUUID];
}

/**
 * Record the window size used for a successful extraction run.
 * @param {string} chatUUID
 * @param {number} windowSize
 */
export function setLastUsedWindowSize(chatUUID, windowSize) {
    const store = extension_settings?.vectfox;
    if (!store || !chatUUID || !Number.isFinite(windowSize)) return;
    if (!store.eventbase_last_used_window_size) store.eventbase_last_used_window_size = {};
    if (store.eventbase_last_used_window_size[chatUUID] !== windowSize) {
        store.eventbase_last_used_window_size[chatUUID] = windowSize;
        saveSettingsDebounced();
    }
}

// ---------------------------------------------------------------------------
// Re-extraction coordination helpers
// ---------------------------------------------------------------------------
// Two bugs on 2026-05-30 (Reset & Vectorize popup, window-size-change popup)
// came from the same root cause: callers inlined their own "should I re-extract?"
// and "should the workflow fall back to Qdrant?" logic, and they got the
// combination subtly wrong — local cache cleared but the Qdrant-side tip fallback
// still fired → silent "0 events, X skipped" runs.
//
// These three helpers are the single source of truth for:
//   1. "Did the window size change since last extraction?"        → checkWindowSizeChanged()
//   2. "Should the workflow apply its Qdrant-side tip fallback?"  → shouldUseTipFallback()
//   3. "User asked for fresh extraction — prep the chat state"    → prepareForFreshExtraction()
//
// Any new code that touches these concerns MUST use these helpers — do not
// inline the logic. If a check needs new behavior, extend the helper, don't
// fork it at a call site.

/**
 * UI helper. Detect whether the current window size differs from the last
 * successfully-used one for this chat. Single source of truth — callers MUST NOT
 * inline `getLastUsedWindowSize(...) !== currentSize`; use this helper instead so
 * any future refinement (e.g. tolerance, schema migration) applies uniformly.
 *
 * @param {string} chatUUID
 * @param {number} currentSize - The window size the next run would use
 * @returns {{ changed: boolean, oldSize: number|undefined, newSize: number }}
 */
export function checkWindowSizeChanged(chatUUID, currentSize) {
    const oldSize = getLastUsedWindowSize(chatUUID);
    const changed = typeof oldSize === 'number' && oldSize !== currentSize;
    return { changed, oldSize, newSize: currentSize };
}

/**
 * Workflow helper. Decide whether `runEventBaseIngestion` should perform its
 * Qdrant-side tip-derived fast-forward. Pure function — caller passes the
 * current state, gets a yes/no.
 *
 * The fallback fires ONLY when ALL of:
 *   - Caller did NOT explicitly opt out (skipTipFallback === false)
 *   - The local cache gave zero skips (fastForwardSkipped === 0)
 *   - A collection exists to probe (hasCollection === true)
 *
 * Centralizing this rule was the structural fix for the two 2026-05-30 bugs:
 * before, the rule was inlined at the workflow site and the two UI popups
 * couldn't see it, so they forgot to set skipTipFallback. Now any future
 * change to the condition lives here in one place.
 *
 * @param {{ skipTipFallback: boolean, fastForwardSkipped: number, hasCollection: boolean }} state
 * @returns {boolean}
 */
export function shouldUseTipFallback({ skipTipFallback, fastForwardSkipped, hasCollection }) {
    if (skipTipFallback) return false;
    if (fastForwardSkipped > 0) return false;
    if (!hasCollection) return false;
    return true;
}

/**
 * UI helper. Prepare a chat for an explicitly user-requested fresh re-extraction.
 *
 * Does TWO things, both required:
 *   1. Clears the local extraction caches (window fingerprint cache + tip)
 *   2. Returns options block to spread into vectorizeAll / runEventBaseIngestion
 *      so the workflow's Qdrant-side tip fallback ALSO skips this run
 *
 * Without step 2 the workflow re-derives the tip from existing Qdrant points and
 * silently fast-forwards past everything — the "0 events, X skipped" surprise.
 * Without step 1 the local fingerprints linger as dead-but-harmless entries.
 *
 * Call this whenever a popup promises "re-extract from message 1" — Reset &
 * Vectorize, Window-size-change Proceed, etc. If a third trigger is ever added,
 * route it through this helper too.
 *
 * @param {string} chatUUID
 * @returns {Promise<{ skipTipFallback: true }>}
 */
export async function prepareForFreshExtraction(chatUUID) {
    if (!chatUUID) return { skipTipFallback: true };
    clearExtractionCachesForChat(chatUUID);
    log.lifecycle(`[EventBase] prepareForFreshExtraction: caches cleared for ${chatUUID} (skipTipFallback will be propagated)`);
    return { skipTipFallback: true };
}

// ---------------------------------------------------------------------------
// Window-fingerprint cache (in-session dedup of identical extraction windows)
// ---------------------------------------------------------------------------

/**
 * Returns a stable string fingerprint for a window from its source hashes.
 * @param {number[]} sourceHashes
 * @returns {string}
 */
export function windowFingerprint(sourceHashes) {
    return [...sourceHashes].map(String).sort().join(',');
}

/**
 * Marks a window as extracted. Stored in extension_settings so it survives
 * page reloads without requiring a chat save.
 * @param {number[]} sourceHashes
 * @param {string} [chatUUID]
 */
export function markWindowExtracted(sourceHashes, chatUUID) {
    if (!sourceHashes?.length) return;
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return;

    const store = extension_settings.vectfox;
    if (!store) return;
    if (!store.eventbase_extracted_windows) store.eventbase_extracted_windows = {};
    if (!store.eventbase_extracted_windows[uuid]) store.eventbase_extracted_windows[uuid] = [];

    const fp = windowFingerprint(sourceHashes);

    // Update the in-memory Set first (O(1) check)
    if (!_windowCacheSet.has(uuid)) {
        _windowCacheSet.set(uuid, new Set(store.eventbase_extracted_windows[uuid]));
    }
    const set = _windowCacheSet.get(uuid);
    if (!set.has(fp)) {
        set.add(fp);
        store.eventbase_extracted_windows[uuid].push(fp);
        saveSettingsDebounced();
    }
}

/**
 * Clears the extraction cache for a specific chat.
 * Call this whenever an EventBase collection is deleted so that
 * the next vectorization run starts fresh.
 * @param {string} [chatUUID]
 */
export function clearWindowCacheForChat(chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return;
    const store = extension_settings?.vectfox;
    if (!store?.eventbase_extracted_windows) return;
    delete store.eventbase_extracted_windows[uuid];
    _windowCacheSet.delete(uuid);
    saveSettingsDebounced();
}

/**
 * Drops BOTH "already-extracted" caches for a chat — the persisted window
 * fingerprint Set and the in-memory vectorization tip. These are two
 * representations of the same fact ("how far this chat is already extracted"),
 * so they must always be cleared together: clearing one but not the other was
 * the stale-tip bug where re-vectorizing a deleted collection fast-forwarded
 * past every window and extracted 0 events.
 *
 * Use this anywhere a chat's extraction state is invalidated wholesale:
 *   - the EventBase collection is deleted (collection-loader.js)
 *   - the backend is found empty but a local cache lingers (eventbase-workflow.js)
 *   - the user hits Vectorize for a fresh start (content-vectorizer.js)
 *
 * Does NOT touch the auto-sync marker — that's a separate concept (where
 * auto-sync should resume), intentionally preserved across these resets.
 *
 * @param {string} [chatUUID] - defaults to the current chat
 */
export function clearExtractionCachesForChat(chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return;
    clearWindowCacheForChat(uuid);
    clearVectorizationTip(uuid);
}

/**
 * Quick-exit check: returns true if the LAST complete window in the message list
 * is already extracted. When true, all prior windows are also done (windows are
 * always processed in-order from the tail). Avoids building O(n) window objects.
 *
 * @param {object[]} messages  - Filtered message array (same as passed to runEventBaseIngestion)
 * @param {number}   windowSize
 * @param {number}   step       - windowSize - windowOverlap
 * @param {string}   [chatUUID]
 * @param {Function} hashFn     - (message) => number hash for that message
 * @returns {boolean}
 */
export function isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn) {
    const uuid = chatUUID;
    if (!uuid || messages.length < windowSize) return false;

    const totalPossible = Math.floor((messages.length - windowSize) / step) + 1;
    if (totalPossible <= 0) return false;

    const lastStart = (totalPossible - 1) * step;
    const lastMsgs = messages.slice(lastStart, lastStart + windowSize);
    if (lastMsgs.length < windowSize) return false;

    const hashes = lastMsgs.map(hashFn);

    if (!_windowCacheSet.has(uuid)) {
        const arr = extension_settings?.vectfox?.eventbase_extracted_windows?.[uuid];
        _windowCacheSet.set(uuid, new Set(Array.isArray(arr) ? arr : []));
    }

    return _windowCacheSet.get(uuid).has(windowFingerprint(hashes));
}

/**
 * Checks whether a window has already been extracted (O(1), no DB query).
 * Uses an in-memory Set keyed by chatUUID; built lazily from the persisted array.
 *
 * @param {number[]} sourceHashes
 * @param {number[]} messageIds     - unused, kept for API compat
 * @param {object}   settings       - unused, kept for API compat
 * @param {string}   [chatUUID]
 * @returns {Promise<boolean>}
 */
export async function isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID) {
    if (!sourceHashes?.length) return false;
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return false;

    // Build the Set from the persisted array on first access for this chat
    if (!_windowCacheSet.has(uuid)) {
        const arr = extension_settings?.vectfox?.eventbase_extracted_windows?.[uuid];
        _windowCacheSet.set(uuid, new Set(Array.isArray(arr) ? arr : []));
    }

    const fp = windowFingerprint(sourceHashes);
    return _windowCacheSet.get(uuid).has(fp);  // O(1)
}

/**
 * Find every EventBase collection registered for the given chat UUID.
 *
 * The registry — not `buildEventBaseCollectionId` — is the source of truth for
 * which collection holds a chat's data. The collection ID embeds a sanitized
 * form of `name1`/`name2`, and that sanitization can change over time
 * (e.g. the CJK-name fix). Recomputing the ID at read-time therefore can't
 * be trusted; the registry remembers the actual stored ID.
 *
 * Returned entries are ordered most-preferred first:
 *   1. Backend-scoped IDs matching the current backend setting
 *   2. Other backend-scoped IDs
 *   3. Legacy (no backend) IDs
 *
 * Naming convention (see Doc/collection_helper.md):
 *   - `find…`  → ALL candidates, returns an array (this function).
 *   - `resolve…` → THE single active answer (see resolveActiveEventBaseCollection).
 * Take care before reaching for `[0]` here — if you want the one active
 * collection for the current chat, call resolveActiveEventBaseCollection instead.
 *
 * @param {string} uuid Chat UUID
 * @param {string} [preferredBackend] Backend to prefer (e.g. 'qdrant', 'vectra')
 * @returns {{ registryKey: string, collectionId: string }[]}
 */
export function findEventBaseCollectionsForChat(uuid, preferredBackend) {
    if (!uuid) return [];
    const matches = [];
    for (const registryKey of getCollectionRegistry()) {
        const parsed = parseRegistryKey(registryKey);
        const colId = parsed.collectionId;
        if (!colId?.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) continue;
        if (!colId.endsWith(uuid)) continue;
        matches.push({ registryKey, collectionId: colId, backend: parsed.backend });
    }

    // A single chat UUID can have MULTIPLE EventBase collections on the same
    // backend — one per persona/handle (e.g. an imported archive under a different
    // name1). Backend rank alone then picks an arbitrary one, which is how the
    // auto-sync marker ended up reading a stale import instead of the active
    // collection. Disambiguate by the chat lock: the collection locked to the
    // CURRENT chat is the one the rest of the system treats as active (DB Browser
    // "Active here only", isCollectionActiveForContext). Rank it first so callers
    // that take [0] resolve correctly. Only meaningful when resolving the current
    // chat; for any other UUID lock state is irrelevant and we keep backend order.
    const lockedKeys = (uuid === getChatUUID())
        ? new Set(getChatLockedCollections(getCurrentChatId()))
        : new Set();
    const isLocked = (m) => lockedKeys.has(m.registryKey) || lockedKeys.has(m.collectionId);

    const wantBackend = String(preferredBackend || '').toLowerCase();
    const backendRank = (m) => {
        if (wantBackend && m.backend === wantBackend) return 0;
        if (m.backend) return 1;
        return 2;
    };
    // Lock dominates; backend preference tie-breaks within each lock tier.
    const rank = (m) => (isLocked(m) ? 0 : 10) + backendRank(m);
    matches.sort((a, b) => rank(a) - rank(b));
    return matches.map(({ registryKey, collectionId }) => ({ registryKey, collectionId }));
}

/**
 * Resolve THE active EventBase collection for a chat — the canonical answer to
 * "which EventBase collection does this chat use right now?".
 *
 * This is the single entry point callers should use when they want one
 * collection (not a list). It is:
 *   - ownership-filtered (via getCollectionListing → drops collections owned by
 *     other personas/users, matching the DB Browser and the auto-sync LED), and
 *   - lock-aware (a chat UUID can map to MULTIPLE per-persona collections; the
 *     lock picks the one the rest of the system treats as active — "Active here
 *     only" / the auto-sync write target).
 *
 * Prefer this over `findEventBaseCollectionsForChat(...)[0]`. The plural `find…`
 * is only for the rare case where you genuinely need every candidate (e.g.
 * pausing auto-sync on all of a chat's collections).
 *
 * READ vs WRITE: the default (read) semantics honor a lock even when the locked
 * collection belongs to another conversation — that is the documented way to
 * share an older chat's EventBase with the current one. Ingestion must NOT use
 * those semantics: writing this chat's events into another conversation's
 * collection mixes two `source_window_end` index spaces in one sort frame and
 * corrupts chronology (see `_orderEventsForPresentation` in
 * eventbase-injection.js). Write callers go through
 * {@link resolveEventBaseWriteTarget}, which passes `requireUuidMatch`.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} [chatUUID] - defaults to the current chat's UUID
 * @param {{ requireUuidMatch?: boolean }} [options]
 *   `requireUuidMatch` — reject collections whose embedded chat UUID differs
 *   from this chat, so a foreign lock can never become a write target.
 * @returns {{ collectionId: string, registryKey: string } | null}
 */
export function resolveActiveEventBaseCollection(settings, chatUUID, { requireUuidMatch = false } = {}) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    // Disambiguate persona collections: lock dominates, current backend
    // tie-breaks, otherwise listing order. The lock index is keyed by the active
    // chat id, so the lock is only meaningful when resolving the current chat.
    // Computed up front because the ownership filter below also consults it.
    const chatId = (uuid === getChatUUID()) ? getCurrentChatId() : null;
    const isLocked = (m) => !!chatId && isCollectionActiveForContextAnyKey(
        [m.registryKey, m.collectionId], { chatId });

    // Match by UUID (stable across legacy ID formats and character renames).
    const patterns = buildChatSearchPatterns(null, uuid);
    const hasUuidMatch = (entry) =>
        matchesPatterns(entry.collectionId, patterns) || matchesPatterns(entry.registryKey, patterns);
    const isEbMatch = (entry) => {
        const { collectionId } = entry;
        const idLower = String(collectionId || '').toLowerCase();
        if (!idLower.startsWith('vf_eventbase_') && !idLower.includes('eventbase_')) return false;
        // Write mode: the UUID match is mandatory, so a lock can widen ownership
        // but never redirect ingestion into another conversation's collection.
        // Returning null here is the correct outcome on a chat's first ingestion —
        // runEventBaseIngestion then falls through to buildEventBaseCollectionId
        // and creates this chat's own collection.
        if (requireUuidMatch) return hasUuidMatch(entry) && (isLocked(entry) || entry.isOwn);
        // An explicit per-chat lock is a deliberate user override: the collection
        // is eligible regardless of ownership AND regardless of whether its
        // embedded UUID still matches this chat. The UUID can drift from the lock
        // after a delete + re-vectorize cycle (the chat gets a fresh UUID, but the
        // user re-locks the old collection), or when intentionally binding another
        // chat's EventBase here. This matches the DB Browser's lock-only "Active
        // here" badge and the retrieval path (_gatherLockedEventBaseCollections),
        // both of which honor the lock without a UUID check. Without this the lock
        // resolves as ACTIVE in the UI yet auto-sync reports "no collection".
        if (isLocked(entry)) return true;
        // Auto-association (no lock): must be owned by the current persona AND its
        // embedded UUID must match the current chat.
        if (!entry.isOwn) return false;
        return hasUuidMatch(entry);
    };
    const listing = getCollectionListing(settings);
    const ebMatches = listing.filter(isEbMatch);

    // Diagnostic: why each EventBase collection was/ wasn't picked. Surfaces the
    // exact reason auto-sync sees "no collection" (e.g. lock missing, or UUID
    // drifted after a re-vectorize and no lock to override it).
    if (log.enabled('lifecycle')) {
        const ebAll = listing.filter(e => {
            const il = String(e.collectionId || '').toLowerCase();
            return il.startsWith('vf_eventbase_') || il.includes('eventbase_');
        });
        const rows = ebAll.map(e =>
            `${e.collectionId} [own=${e.isOwn} locked=${isLocked(e)} uuidMatch=${hasUuidMatch(e)} eligible=${isEbMatch(e)}]`);
        log.lifecycle(`[EventBase][resolve] chatUUID=${uuid} chatId=${chatId || '(none)'} requireUuidMatch=${requireUuidMatch}: ${ebAll.length} eb collection(s), ${ebMatches.length} eligible`);
        for (const r of rows) log.lifecycle(`[EventBase][resolve]   ${r}`);
    }

    if (ebMatches.length === 0) {
        log.lifecycle('[EventBase][resolve] → no eligible collection (auto-sync will report "no-collection")');
        return null;
    }

    // Ranking tiers, most significant first: lock, then own-UUID, then current
    // backend. The UUID tier matters when a chat has BOTH its own collection and
    // a foreign one locked in for cross-chat retrieval — without it both score 0
    // and the winner is decided by registry insertion order, which silently flips
    // if a collection is ever deleted and re-registered.
    const wantBackend = getRegistryBackend(settings?.vector_backend);
    const rank = (m) => (isLocked(m) ? 0 : 10)
        + (hasUuidMatch(m) ? 0 : 4)
        + (m.backend === wantBackend ? 0 : 1);
    const active = ebMatches.slice().sort((a, b) => rank(a) - rank(b))[0];
    log.lifecycle(`[EventBase][resolve] → picked ${active.collectionId} (locked=${isLocked(active)} uuidMatch=${hasUuidMatch(active)})`);
    return { collectionId: active.collectionId, registryKey: active.registryKey };
}

/**
 * Resolve the EventBase collection that ingestion may WRITE to for this chat.
 *
 * Same resolution as {@link resolveActiveEventBaseCollection} except a foreign
 * lock is not enough: the collection's embedded chat UUID must match. A lock is
 * a read-side sharing mechanism (lock an older chat's EventBase into this chat
 * so its events are retrieved here). Honoring it on the write side put this
 * chat's events into that older collection, where the two chats' independent
 * `source_window_end` values collide inside one sort frame — the injected
 * timeline then interleaves both conversations, and Resume reads the foreign
 * collection's tip and skips every window ("0 events extracted").
 *
 * Returns null when this chat has no collection of its own yet; the caller is
 * expected to fall back to `buildEventBaseCollectionId` and create one.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} [chatUUID] - defaults to the current chat's UUID
 * @returns {{ collectionId: string, registryKey: string } | null}
 */
export function resolveEventBaseWriteTarget(settings, chatUUID) {
    return resolveActiveEventBaseCollection(settings, chatUUID, { requireUuidMatch: true });
}

/**
 * Resolve which EventBase collection ID to read from for the given chat.
 *
 * Looks up the registered collection(s) by UUID and returns the first one
 * that actually has data. When no collection has been registered yet (first
 * ingestion), returns the freshly-computed backend-scoped ID so the write
 * path has somewhere to insert.
 *
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<string|null>}
 */
async function _resolveEventBaseCollectionIdForRead(settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    const backend = getRegistryBackend(settings?.vector_backend);
    const registered = findEventBaseCollectionsForChat(uuid, backend);

    for (const { collectionId, registryKey } of registered) {
        // Only probe collections that match the current backend.
        // Cross-backend probing causes the similharity plugin's getIndex() to
        // auto-create empty vectra directories for qdrant-named collections (and
        // vice versa), producing ghost 0-chunk entries in the DB Browser.
        const { backend: ownBackend } = parseRegistryKey(registryKey);
        if (ownBackend && ownBackend !== backend) continue;

        try {
            const hashes = await getSavedHashes(collectionId, settings);
            if (hashes?.length > 0) return collectionId;
        } catch {
            // Try next candidate.
        }
    }

    // No registered collection has data yet — return the would-be ID so
    // first-time writers have a target. May be null if no chat is active.
    return buildEventBaseCollectionId(uuid, settings?.vector_backend);
}

// ---------------------------------------------------------------------------
// Phase 1.5 — one-time index backfill
// ---------------------------------------------------------------------------

/**
 * Ensure the 6 Phase-1.5 EventBase payload indexes exist on all registered
 * EventBase collections. Called once per page load from index.js; skipped after
 * the first successful run via the `eventbase_indexes_v1_backfilled` flag.
 *
 * Non-blocking — errors are caught and logged, toastr shown, never bubbles up.
 *
 * @param {object} settings - VectFox settings
 * @returns {Promise<void>}
 */
export async function ensureEventBaseIndexes(settings) {
    if (settings?.vector_backend !== 'qdrant') return;
    if (extension_settings?.vectfox?.eventbase_indexes_v1_backfilled) return;

    // Collect all EventBase + ArchiveEvent Qdrant collections from the registry.
    const qdrantCollections = [];
    for (const registryKey of getCollectionRegistry()) {
        const parsed = parseRegistryKey(registryKey);
        if (parsed.backend !== 'qdrant') continue;
        const colId = parsed.collectionId;
        if (!colId) continue;
        if (
            colId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) ||
            colId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT)
        ) {
            qdrantCollections.push(colId);
        }
    }

    if (qdrantCollections.length === 0) {
        // No EventBase collections yet — mark done so we don't re-check every load.
        if (extension_settings?.vectfox) {
            extension_settings.vectfox.eventbase_indexes_v1_backfilled = true;
            saveSettingsDebounced();
        }
        return;
    }

    // Show a non-blocking start toast only when there is actually work to do.
    if (typeof toastr !== 'undefined') {
        toastr.info(
            `VectFox: upgrading EventBase index (one-time, ~${Math.ceil(qdrantCollections.length * 5)}s)…`,
            'VectFox',
            { timeOut: 8000 },
        );
    }

    const errors = [];
    for (const collectionId of qdrantCollections) {
        try {
            const resp = await fetch('/api/plugins/similharity/chunks/ensure-eventbase-indexes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ collectionId }),
            });
            if (!resp.ok) {
                const msg = await resp.text().catch(() => resp.statusText);
                errors.push(`${collectionId}: ${msg}`);
            }
        } catch (err) {
            errors.push(`${collectionId}: ${err?.message || err}`);
        }
    }

    if (errors.length === 0) {
        if (extension_settings?.vectfox) {
            extension_settings.vectfox.eventbase_indexes_v1_backfilled = true;
            saveSettingsDebounced();
        }
        if (typeof toastr !== 'undefined') {
            toastr.success(
                `VectFox: EventBase index upgrade complete (${qdrantCollections.length} collection(s)).`,
                'VectFox',
                { timeOut: 5000 },
            );
        }
    } else {
        log.warn('[VectFox] EventBase index backfill errors:', errors);
        if (typeof toastr !== 'undefined') {
            toastr.warning(
                `VectFox: EventBase index upgrade failed for ${errors.length} collection(s) — see console. AgentMode filters may run slower.`,
                'VectFox',
                { timeOut: 10000 },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic numeric hash for an event_id string.
 * Uses the same djb2 algorithm as bm25-scorer.js / chat-vectorization.js.
 * @param {string} id
 * @returns {number}
 */
// Two-seed djb2 packed into a 53-bit-safe integer (JavaScript's safe-integer
// range). Qdrant accepts uint64 point IDs, but JS only round-trips uint53 without
// loss — we deliberately stay below MAX_SAFE_INTEGER (2^53 - 1) so the value
// survives JSON.stringify / parseInt on every hop.
//
// History: this used to be single-seed djb2 returning a 32-bit unsigned int.
// In Qdrant's point-ID space (uint64), the 32-bit collisions were rare in theory
// but devastating in practice — Qdrant treats same-ID upserts as overwrites, so
// every collision silently destroys one event. A 2026-05-30 backfill of a 2382-
// message chat sent 524 events to the plugin and only 315 unique IDs landed in
// Qdrant — a 40% silent data loss rate. Widening to 53 bits eliminates this
// class of bug for any realistically-sized collection (birthday-bound collision
// at ~1.3M points vs ~93k for 32-bit). Combined with the post-insert count
// verification in eventbase-workflow.js _finalizeBatch, any future silent loss
// surfaces as a fatal popup instead of accumulating quietly.
function _eventHash(id) {
    let h1 = 5381;
    let h2 = 0xABCDEF;
    for (let i = 0; i < id.length; i++) {
        const c = id.charCodeAt(i);
        h1 = ((h1 << 5) + h1) ^ c;
        h2 = ((h2 << 5) + h2) ^ c ^ (c << 16);
        h1 >>>= 0;
        h2 >>>= 0;
    }
    // Pack: high 21 bits of h2 + low 32 bits of h1 = 53 bits total.
    // (2^21 - 1) << 32 + (2^32 - 1) = 2^53 - 1 = Number.MAX_SAFE_INTEGER.
    return (h2 >>> 11) * 4294967296 + h1;
}
