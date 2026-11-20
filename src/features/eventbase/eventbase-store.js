/**
 * ============================================================================
 * EVENTBASE STORE
 * ============================================================================
 * Qdrant insert / query / list / delete wrappers for EventBase collections.
 * All operations target a per-chat EventBase collection, isolated from the
 * legacy chunk collection.
 * ============================================================================
 */

import { insertVectorItems, deleteVectorItems, updateChunkMetadata, qdrantTarget } from '../vector-backend/index.js';
import { saveSettingsDebounced, extension_settings } from '../../sillytavern/settings.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { getCurrentChatId, getContext } from '../../sillytavern/chat.js';
import { getChatUUID, buildEventBaseCollectionId, buildRegistryKey, getRegistryBackend, COLLECTION_PREFIXES, parseCollectionId, parseRegistryKey, buildChatSearchPatterns, matchesPatterns } from '../../shared/collection-ids.js';
import {
    registerCollection,
    getCollectionRegistry,
    getCollectionListing,
    getCollectionMeta,
    setCollectionMeta,
    getChatLockedCollections,
    isCollectionActiveForContextAnyKey,
    setCollectionAutoSync,
} from '../collections/index.js';
import { buildEmbedText } from './eventbase-schema.js';
import { findReplacedEvents, linksMovedToReplacements, mayHoldEarlierEvents, replacementIdsOf, windowSpanOf } from './eventbase-window-replacement-core.js';
import { log } from '../../sillytavern/log.js';
import { readErrorBody } from '../../shared/server-error-text.js';

// Re-export so callers can import from here if needed
export { buildEventBaseCollectionId };

// ---------------------------------------------------------------------------
// The pointer: how far EventBase has read a chat into one collection
// ---------------------------------------------------------------------------
// Each EventBase or archive collection keeps its own pointer in its record
// (extension_settings.vectfox.collections[<registry key>].eventbaseProgress), so
// two collections of one chat never share one:
//   vectorizationTip     — one past the last message any extracted window covers
//   extractedWindows     — the fingerprints of the windows read, so none is read twice
//   unfinishedWindows    — the fingerprints of the windows that failed, sent again
//   autoSyncStartMarker  — the message auto-sync started from
//   windowSize           — the window size of the last run that read a window
// Every function below that takes a registryKey reads or writes that collection's
// pointer, and only through readEventBaseProgress and writeEventBaseProgress.
// Deleting the collection deletes its record, the pointer with it.

// Each extractedWindows array's fingerprints as a Set, for O(1) lookups. Keyed by the
// array itself, so a record whose array is replaced (an import, a clear) is read
// again from the new array.
const _extractedWindowSets = new WeakMap(); // extractedWindows array → Set<fingerprint>

// The tip, in memory: the pointer's tip once read, or a tip probed from the
// collection's events (ensureVectorizationTip) that is not stored. The Auto-Sync page
// shows it as "vectorization: N msgs". Written by the ingestion loop after each
// window it marks extracted; probed only when neither memory nor the record has one,
// and once per page load when the known tip is far behind the chat.
const _vectorizationTipByRegistryKey = new Map(); // registry key → number (tip)

// Collections whose far-behind tip was read against the backend on this page load.
const _tipsCheckedThisPageLoad = new Set();

/**
 * A collection's pointer, from its record: an object holding the parts it has, empty when it has none. Read only:
 * change it through writeEventBaseProgress.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {{vectorizationTip?: number, extractedWindows?: string[], unfinishedWindows?: string[], autoSyncStartMarker?: number, windowSize?: number}}
 */
export function readEventBaseProgress(registryKey) {
    if (!registryKey) return {};
    const progress = getCollectionMeta(registryKey).eventbaseProgress;
    return progress && typeof progress === 'object' ? progress : {};
}

/**
 * Write parts of a collection's pointer into its record, keeping the parts not named; a part given as undefined is
 * removed. Writes nothing when no part changes, so clearing a collection with no record makes none.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object} parts - Parts of the pointer, as readEventBaseProgress returns them
 */
export function writeEventBaseProgress(registryKey, parts) {
    if (!registryKey) return;
    const current = readEventBaseProgress(registryKey);
    const isChanged = Object.entries(parts).some(([part, value]) =>
        value === undefined ? Object.prototype.hasOwnProperty.call(current, part) : current[part] !== value);
    if (!isChanged) return;
    const progress = { ...current };
    for (const [part, value] of Object.entries(parts)) {
        if (value === undefined) delete progress[part];
        else progress[part] = value;
    }
    setCollectionMeta(registryKey, { eventbaseProgress: Object.keys(progress).length ? progress : undefined });
}

/** The fingerprints of an extractedWindows array as a Set, built once per array. */
function extractedWindowSetOf(windows) {
    let fingerprints = _extractedWindowSets.get(windows);
    if (!fingerprints) {
        fingerprints = new Set(windows);
        _extractedWindowSets.set(windows, fingerprints);
    }
    return fingerprints;
}

/**
 * Whole Auto-sync windows behind the sync boundary at which a chat counts as far behind: the
 * auto-sync enable flow asks before spending on the backlog, and ensureVectorizationTip checks the
 * tip against the backend.
 */
export const FAR_BEHIND_WINDOW_COUNT = 5;

/**
 * Whole Auto-sync windows between a tip and the sync boundary.
 *
 * @param {number} commitBoundary - messages eligible for auto-sync (getCommitBoundary)
 * @param {number} tip
 * @param {number} windowSize - messages per Auto-sync window (getAutoSyncWindowSize)
 * @returns {number}
 */
export function countWindowsBehind(commitBoundary, tip, windowSize) {
    return Math.floor(Math.max(0, commitBoundary - tip) / windowSize);
}

/**
 * A collection's tip: from memory, else from its pointer, so it is right at once after a reload with no backend
 * round-trip. Undefined only when nothing is known yet.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {number|undefined}
 */
export function getVectorizationTip(registryKey) {
    if (!registryKey) return undefined;
    const cached = _vectorizationTipByRegistryKey.get(registryKey);
    if (typeof cached === 'number') return cached;
    const stored = readEventBaseProgress(registryKey).vectorizationTip;
    if (typeof stored === 'number') {
        _vectorizationTipByRegistryKey.set(registryKey, stored);
        return stored;
    }
    return undefined;
}

/**
 * Raise a collection's tip, in memory and in its pointer. Never lowers it, so calls arriving out of order keep the
 * highest.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} tip
 */
export function setVectorizationTip(registryKey, tip) {
    if (!registryKey || typeof tip !== 'number' || !Number.isFinite(tip)) return;
    const current = _vectorizationTipByRegistryKey.get(registryKey) ?? -1;
    if (tip > current) _vectorizationTipByRegistryKey.set(registryKey, tip);
    if (tip > (readEventBaseProgress(registryKey).vectorizationTip ?? -1)) {
        writeEventBaseProgress(registryKey, { vectorizationTip: tip });
    }
}

/**
 * Forget a collection's tip, in memory and in its pointer.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function clearVectorizationTip(registryKey) {
    if (!registryKey) return;
    _vectorizationTipByRegistryKey.delete(registryKey);
    writeEventBaseProgress(registryKey, { vectorizationTip: undefined });
}

/** Reads a whole collection: a limit below its size would return an arbitrary part of it. */
const WHOLE_COLLECTION_LIMIT = 50000;

/**
 * Every event a collection holds, as its stored metadata, with the point hash it is stored under
 * as `_hash`. Without the Similharity plugin the Standard backend lists hashes only, so its events
 * carry no metadata.
 *
 * @param {string} collectionId - Bare or registry-key form; passed straight to listChunks.
 * @param {object} settings
 * @returns {Promise<object[]>}
 * @throws when the backend cannot list the collection
 */
async function _readStoredEvents(collectionId, settings) {
    const { getBackend } = await import('../vector-backend/index.js');
    const backendInstance = await getBackend(settings);
    const result = await backendInstance.listChunks(collectionId, settings, { limit: WHOLE_COLLECTION_LIMIT });
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.map(item => ({ ...item?.metadata, _hash: Number(item?.hash) }));
}

/**
 * Reads where a collection's events sit, from their stored source_window_end.
 *
 * @param {string} collectionId - Bare or registry-key form; passed straight to listChunks.
 * @param {object} settings
 * @returns {Promise<{ end: number, createdAt: number|undefined }[]>}
 */
async function _readEventPositions(collectionId, settings) {
    return (await _readStoredEvents(collectionId, settings))
        .filter(event => typeof event.source_window_end === 'number')
        .map(event => ({ end: event.source_window_end, createdAt: event.created_at }));
}

/** The tip those positions prove: one past the highest message any event covers, 0 with none. */
function _tipOfPositions(positions) {
    return positions.reduce((tip, { end }) => Math.max(tip, end + 1), 0);
}

/** The later of two event times, either of which an older event may lack. */
function _laterEventTime(first, second) {
    return second === undefined || first > second ? first : second;
}

/**
 * Whether the events at the collection's end are older than events below a tip. Vectorize reads a
 * chat again from the start, replacing each window's events as it reaches the window, so a run
 * stopped part way leaves the windows past its tip with older events, and its tip is the run's own
 * progress. A stale tip does not: the collection's end is newest.
 *
 * @param {{ end: number, createdAt: number|undefined }[]} positions
 * @param {number} tip
 * @returns {boolean}
 */
function _isReExtractionUnfinished(positions, tip) {
    let highestEnd = -1;
    let newestAtHighestEnd;
    let newestBelowTip;
    for (const { end, createdAt } of positions) {
        if (end > highestEnd) {
            highestEnd = end;
            newestAtHighestEnd = createdAt;
        } else if (end === highestEnd) {
            newestAtHighestEnd = _laterEventTime(createdAt, newestAtHighestEnd);
        }
        if (end < tip) newestBelowTip = _laterEventTime(createdAt, newestBelowTip);
    }
    return newestBelowTip > newestAtHighestEnd;
}

/**
 * Checks a far-behind tip against its collection, once per collection per page load. SillyTavern saves
 * the whole settings file from whichever tab saves last, so a tab left open or a restored backup can put
 * back a tip from long before the collection's events, and a known tip is otherwise never re-read.
 *
 * Only ever raises: windows that produced no events leave nothing in the backend, so it can prove a
 * tip too low but never too high. The window record goes too, because it describes the same old
 * state and a non-empty one makes Resume start where it ends instead of at the tip
 * (shouldUseTipFallback).
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object} settings
 * @param {number} knownTip
 * @returns {Promise<number>} the tip to use
 */
async function _checkFarBehindTip(registryKey, settings, knownTip) {
    const { collectionId } = parseRegistryKey(registryKey);
    _tipsCheckedThisPageLoad.add(registryKey);
    let positions;
    try {
        positions = await _readEventPositions(collectionId, settings);
    } catch (err) {
        _tipsCheckedThisPageLoad.delete(registryKey); // the next status read tries again
        log.warn(`[EventBase VectorizationTip] check of far-behind tip ${knownTip} failed for ${collectionId}, keeping it:`, err);
        return knownTip;
    }
    const collectionTip = _tipOfPositions(positions);
    if (collectionTip <= knownTip) return knownTip; // the backlog is real
    if (_isReExtractionUnfinished(positions, knownTip)) {
        log.lifecycle(`[EventBase VectorizationTip] tip ${knownTip} is an unfinished re-extraction in ${collectionId}, keeping it`);
        return knownTip;
    }
    clearWindowCache(registryKey);
    setVectorizationTip(registryKey, collectionTip);
    log.warn(`[EventBase VectorizationTip] saved tip ${knownTip} was behind ${collectionId}, which reaches ${collectionTip}: raised it and dropped the window record`);
    return collectionTip;
}

/**
 * Reads a collection's tip, going to the backend only when the known one cannot answer. On a hit
 * (in memory or in its pointer, via getVectorizationTip), returns the tip with no backend round-trip,
 * unless syncProgress shows it far behind (_checkFarBehindTip). When nothing is known yet it reads
 * the collection's events ONCE, keeps the tip in memory, and returns it. Same shape as
 * stampAutoSyncMarker's scan, so a collection read for the first time costs what stamping its marker
 * does.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id"); its events are read
 *   from the current backend
 * @param {object} settings
 * @param {{ commitBoundary: number, windowSize: number }} [syncProgress] - where the chat stands
 *   (see countWindowsBehind). Without it a known tip is returned as it is.
 * @returns {Promise<number|null>}  Tip, or null if the collection has no events yet.
 */
export async function ensureVectorizationTip(registryKey, settings, syncProgress = null) {
    if (!registryKey) return null;
    const cached = getVectorizationTip(registryKey); // in memory, else from the pointer
    if (typeof cached === 'number') {
        const isFarBehind = syncProgress
            && countWindowsBehind(syncProgress.commitBoundary, cached, syncProgress.windowSize) >= FAR_BEHIND_WINDOW_COUNT;
        if (!isFarBehind || _tipsCheckedThisPageLoad.has(registryKey)) return cached;
        return _checkFarBehindTip(registryKey, settings, cached);
    }
    const { collectionId } = parseRegistryKey(registryKey);
    try {
        const tip = _tipOfPositions(await _readEventPositions(collectionId, settings));
        if (tip === 0) return null;
        _vectorizationTipByRegistryKey.set(registryKey, tip);
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

    // Build insertable items. They carry no vector: the backend embeds each text server-side.
    const items = events.map((event, idx) => {
        const embedText = embedTexts[idx];
        const hash = eventPointHash(event.event_id);

        // The summary string lives inside `text` (first line, after the [event_type] prefix).
        // Storing it again as a separate field is pure duplication, so we strip it from both
        // the top-level item and the metadata spread before sending to the backend.
        const { summary: _droppedSummary, ...eventWithoutSummary } = event;

        return {
            hash,
            text: embedText,
            index: event.source_window_end ?? (event.source_window_start != null ? event.source_window_start + 1 : idx + 1), // source_window_end for consistency with message_order injection field
            // Top-level fields read by qdrant.js's payload builder.
            // qdrant.js spreads item.metadata first then explicitly overwrites these
            // fields from the top-level item. Without them defined here, they are
            // undefined → JSON.stringify drops them → Similharity server applies its
            // own defaults (importance=100).
            importance: event.importance,
            keywords: event.keywords || [],
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
    // N", Qdrant returns 200, we'd never know). The 53-bit eventPointHash makes a
    // collision statistically rare (expected first collision near 134M points),
    // but "rare" silent-loss bugs are worse than "occasional" loud ones — so we
    // assert it explicitly here, throw if it ever happens, and surface the
    // colliding event_ids to the user instead of dropping their data.
    const hashSeen = new Map();   // hash → event_id (first occurrence)
    for (const item of items) {
        const ev = events.find(e => eventPointHash(e.event_id) === item.hash);
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
// Window replacement: a window extracted again replaces its earlier events
// ---------------------------------------------------------------------------

/**
 * What one ingestion run uses to replace the events its windows hold from earlier extractions;
 * eventbase-window-replacement-core.js decides which those are. The collection is read once per
 * run, and only when a window may hold such events, so an ordinary turn reads nothing more.
 *
 * Neither method throws. A window whose earlier events could not be removed keeps both versions
 * until it is extracted again, and a link left on a removed event is one no walk can follow.
 *
 * @param {{collectionId: string, settings: object, tipAtRunStart: number|null|undefined}} run
 * @returns {{replaceEarlierEvents: (newEvents: object[]) => Promise<void>, moveLinksOffReplacedEvents: () => Promise<void>}}
 */
export function createWindowReplacement({ collectionId, settings, tipAtRunStart }) {
    const runEvents = [];
    let uncheckedEvents = [];
    let storedEventsRead = null;
    const replacementById = new Map();

    return {
        /**
         * After a batch is stored: removes the earlier events of the windows these new events
         * belong to. A window whose new extraction found no events is not among them, so it keeps
         * its earlier events.
         *
         * @param {object[]} newEvents - The batch's stored events
         */
        async replaceEarlierEvents(newEvents) {
            runEvents.push(...newEvents);
            uncheckedEvents.push(...newEvents);
            if (!storedEventsRead && !mayHoldEarlierEvents(runEvents, tipAtRunStart)) return;
            storedEventsRead ??= _readStoredEvents(collectionId, settings).catch((err) => {
                log.warn(`[EventBase] Could not read ${collectionId} for the events of earlier extractions, so windows extracted again keep both versions:`, err);
                return null;
            });
            const storedEvents = await storedEventsRead;
            const eventsToCheck = uncheckedEvents;
            uncheckedEvents = [];
            if (!storedEvents) return;

            const replacedEvents = findReplacedEvents(storedEvents, eventsToCheck, new Set(runEvents.map(event => event.event_id)));
            if (!replacedEvents.length) return;
            try {
                await deleteVectorItems(collectionId, replacedEvents.map(event => event._hash), settings);
            } catch (err) {
                log.warn(`[EventBase] Could not remove ${replacedEvents.length} event(s) of earlier extractions from ${collectionId}, so their windows keep both versions:`, err);
                return;
            }
            for (const [replacedId, newId] of replacementIdsOf(replacedEvents, eventsToCheck)) replacementById.set(replacedId, newId);
            log.lifecycle(`[EventBase] Replaced ${replacedEvents.length} event(s) of earlier extractions in ${new Set(replacedEvents.map(windowSpanOf)).size} window(s)`);
        },

        /**
         * At the end of the run: points the StoryArc links that went to replaced events at the
         * events that replaced them. Reads the collection again, since links change while a run goes on.
         */
        async moveLinksOffReplacedEvents() {
            if (!replacementById.size) return;
            let writes;
            try {
                writes = linksMovedToReplacements(await _readStoredEvents(collectionId, settings), replacementById);
            } catch (err) {
                log.warn(`[EventBase] Could not read ${collectionId} to move links off replaced events, so walks skip those links:`, err);
                return;
            }
            let movedCount = 0;
            for (const { event, links } of writes) {
                try {
                    await updateChunkMetadata(collectionId, event._hash, { story_links: links }, settings);
                    movedCount++;
                } catch (err) {
                    log.warn(`[EventBase] Could not move the links of the event at message ${event.source_window_start} off replaced events:`, err);
                }
            }
            if (writes.length) log.lifecycle(`[EventBase] Moved links off replaced events on ${movedCount} of ${writes.length} event(s)`);
        },
    };
}

// ---------------------------------------------------------------------------
// AutoSync start-marker (per-chat) — see InternalProject/Vectfox/plans/executed/autosync-independent-window-and-last-n-injection.md §9
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
 * A collection's auto-sync start marker.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {number|undefined}  Marker (message index), or undefined if not stamped.
 */
export function getAutoSyncMarker(registryKey) {
    return readEventBaseProgress(registryKey).autoSyncStartMarker;
}

/**
 * Clear a collection's auto-sync start marker. Called when auto-sync is
 * disabled, so re-enabling later re-computes a fresh marker.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function clearAutoSyncMarker(registryKey) {
    writeEventBaseProgress(registryKey, { autoSyncStartMarker: undefined });
}

/**
 * Stamp a collection's auto-sync start marker, which gates the windows auto-sync
 * reads into it. The collection is the chat's own, on the current backend (the
 * write target): the marker is a message index into the open chat.
 *
 * Smart placement:
 *   - If the collection has events → marker = max(source_window_end) + 1
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
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object} settings
 * @param {{ floor?: 'chatLength' }} [options]
 * @returns {Promise<number>}  The marker that was stamped.
 */
export async function stampAutoSyncMarker(registryKey, settings, options = {}) {
    if (!registryKey) return 0;
    const chatLength = getContext()?.chat?.length ?? 0;

    // Explicit "from now on" — skip the coverage scan entirely.
    if (options.floor === 'chatLength') {
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: chatLength });
        log.lifecycle(`[EventBase] AutoSyncMarker stamped (floor=chatLength): collection=${registryKey}, marker=${chatLength}`);
        return chatLength;
    }

    const { collectionId } = parseRegistryKey(registryKey);
    let maxEnd = -1;
    try {
        const { getBackend } = await import('../vector-backend/index.js');
        const backendInstance = await getBackend(settings);
        // Overfetch generously; per-chat EventBase collections are typically
        // O(hundreds to low thousands) of events. listChunks is paged anyway.
        const result = await backendInstance.listChunks(collectionId, settings, { limit: 10000 });
        const items = Array.isArray(result?.items) ? result.items : [];
        for (const it of items) {
            const end = it?.metadata?.source_window_end;
            if (typeof end === 'number' && end > maxEnd) maxEnd = end;
        }
    } catch (err) {
        log.warn(`[EventBase AutoSyncMarker] listChunks failed for ${collectionId} — falling back to chat-tail marker:`, err?.message || err);
    }

    const marker = maxEnd >= 0 ? maxEnd + 1 : chatLength;
    writeEventBaseProgress(registryKey, { autoSyncStartMarker: marker });
    log.lifecycle(`[EventBase] AutoSyncMarker stamped: collection=${registryKey}, marker=${marker} (maxEnd=${maxEnd}, chatLength=${chatLength})`);
    return marker;
}

/**
 * The window size a collection was last read with, by a run that read a window or by the answer to the window-size
 * question. Vectorize Content compares the dialog's size with it before a run (checkWindowSizeChanged).
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {number|undefined}
 */
export function getLastUsedWindowSize(registryKey) {
    return readEventBaseProgress(registryKey).windowSize;
}

/**
 * Record the window size a collection was read with.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} windowSize
 */
export function setLastUsedWindowSize(registryKey, windowSize) {
    if (!Number.isFinite(windowSize)) return;
    writeEventBaseProgress(registryKey, { windowSize });
}

// ---------------------------------------------------------------------------
// Re-extraction coordination helpers
// ---------------------------------------------------------------------------
// These three helpers are the single source of truth for:
//   1. "Did the window size change since last extraction?"        → checkWindowSizeChanged()
//   2. "Should the workflow apply its Qdrant-side tip fallback?"  → shouldUseTipFallback()
//   3. "User asked for fresh extraction — prep the chat state"    → prepareForFreshExtraction()
//
// Code that touches these concerns must use these helpers, not inline the logic: a
// caller that clears the local cache while the Qdrant-side tip fallback still fires
// gets a silent "0 events, X skipped" run. If a check needs new behavior, extend the
// helper, don't fork it at a call site.

/**
 * UI helper. Detect whether the current window size differs from the one the
 * collection was last read with. Single source of truth — callers MUST NOT
 * inline `getLastUsedWindowSize(...) !== currentSize`; use this helper instead so
 * any future refinement (e.g. tolerance, schema migration) applies uniformly.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} currentSize - The window size the next run would use
 * @returns {{ changed: boolean, oldSize: number|undefined, newSize: number }}
 */
export function checkWindowSizeChanged(registryKey, currentSize) {
    const oldSize = getLastUsedWindowSize(registryKey);
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
 *   - No window of this chat is on the unfinished record (hasUnfinishedWindows === false)
 *
 * The tip is the furthest window stored, so falling back to it would mark every
 * window before it extracted, unfinished ones included. A record also proves the
 * local cache is alive, so zero skips means the first window is the unfinished one.
 *
 * The workflow and the UI popups that request fresh extraction share this
 * rule, so a change to the condition is made here only.
 *
 * @param {{ skipTipFallback: boolean, fastForwardSkipped: number, hasCollection: boolean, hasUnfinishedWindows?: boolean }} state
 * @returns {boolean}
 */
export function shouldUseTipFallback({ skipTipFallback, fastForwardSkipped, hasCollection, hasUnfinishedWindows = false }) {
    if (skipTipFallback) return false;
    if (fastForwardSkipped > 0) return false;
    if (!hasCollection) return false;
    if (hasUnfinishedWindows) return false;
    return true;
}

/**
 * UI helper. Prepare a collection for an explicitly user-requested fresh re-extraction.
 *
 * Does TWO things, both required:
 *   1. Clears its extraction caches (the window records + tip)
 *   2. Returns options block to spread into runEventBaseOnOpenChat / runEventBaseIngestion
 *      so the workflow's Qdrant-side tip fallback ALSO skips this run
 *
 * Without step 2 the workflow re-derives the tip from existing Qdrant points and
 * silently fast-forwards past everything — the "0 events, X skipped" surprise.
 * Without step 1 the local fingerprints linger as dead-but-harmless entries.
 *
 * Call this whenever a popup promises to read the chat again from the start:
 * Vectorize, and Read again on the window-size question. If a third trigger is
 * ever added, route it through this helper too.
 *
 * @param {string} registryKey - The registry key ("backend:id") of the collection the run reads into
 * @returns {Promise<{ skipTipFallback: true }>}
 */
export async function prepareForFreshExtraction(registryKey) {
    if (!registryKey) return { skipTipFallback: true };
    clearExtractionCaches(registryKey);
    log.lifecycle(`[EventBase] prepareForFreshExtraction: caches cleared for ${registryKey} (skipTipFallback will be propagated)`);
    return { skipTipFallback: true };
}

// ---------------------------------------------------------------------------
// Window records (which windows a collection has read, and which failed)
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
 * Marks a window as extracted in a collection's pointer, and takes it off its unfinished record.
 * Stored in the settings, so it survives page reloads without requiring a chat save.
 * @param {number[]} sourceHashes
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function markWindowExtracted(sourceHashes, registryKey) {
    if (!sourceHashes?.length || !registryKey) return;
    const fingerprint = windowFingerprint(sourceHashes);
    _keepUnfinishedWindows(registryKey, recordedFingerprint => recordedFingerprint !== fingerprint);

    const windows = readEventBaseProgress(registryKey).extractedWindows ?? [];
    const extracted = extractedWindowSetOf(windows);
    if (extracted.has(fingerprint)) return;
    // A new array, which the record then holds: the Set moves to it with the fingerprint added.
    const nextWindows = [...windows, fingerprint];
    extracted.add(fingerprint);
    _extractedWindowSets.set(nextWindows, extracted);
    writeEventBaseProgress(registryKey, { extractedWindows: nextWindows });
}

/**
 * Puts a window on a collection's unfinished record: its extraction failed, so it must be
 * sent again. The window record cannot say this by itself, because a failed window
 * is merely absent from it, while the windows after it are present, and the quick exit
 * and the tip look only at the furthest window reached.
 *
 * @param {number[]} sourceHashes
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function markWindowUnfinished(sourceHashes, registryKey) {
    if (!registryKey || !sourceHashes?.length) return;
    const unfinished = readEventBaseProgress(registryKey).unfinishedWindows ?? [];
    const fingerprint = windowFingerprint(sourceHashes);
    if (unfinished.includes(fingerprint)) return;
    writeEventBaseProgress(registryKey, { unfinishedWindows: [...unfinished, fingerprint] });
}

/**
 * The windows of this size on a collection's unfinished record. A fingerprint holds one hash
 * per message, so a run at another window size does not see them: its windows are different.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} windowSize
 * @returns {Set<string>} window fingerprints
 */
export function getUnfinishedWindowFingerprints(registryKey, windowSize) {
    const unfinished = readEventBaseProgress(registryKey).unfinishedWindows;
    if (!Array.isArray(unfinished)) return new Set();
    return new Set(unfinished.filter(fingerprint => fingerprint.split(',').length === windowSize));
}

/**
 * Takes windows of this size off the record when the chat no longer has them, because a
 * message in the window was edited or deleted. An edited window has a new fingerprint and
 * goes through the run like any window not yet extracted.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} windowSize
 * @param {Set<string>} chatFingerprints - every window fingerprint the chat has now
 */
export function forgetUnfinishedWindowsNotInChat(registryKey, windowSize, chatFingerprints) {
    _keepUnfinishedWindows(registryKey, fingerprint =>
        fingerprint.split(',').length !== windowSize || chatFingerprints.has(fingerprint));
}

/**
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {(fingerprint: string) => boolean} shouldKeep
 */
function _keepUnfinishedWindows(registryKey, shouldKeep) {
    const unfinished = readEventBaseProgress(registryKey).unfinishedWindows;
    if (!Array.isArray(unfinished)) return;
    const kept = unfinished.filter(shouldKeep);
    if (kept.length === unfinished.length) return;
    writeEventBaseProgress(registryKey, { unfinishedWindows: kept.length > 0 ? kept : undefined });
}

/**
 * Clears a collection's window record and its unfinished record, so its next run reads
 * every window again.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function clearWindowCache(registryKey) {
    writeEventBaseProgress(registryKey, { extractedWindows: undefined, unfinishedWindows: undefined });
}

/**
 * Drops BOTH "already-extracted" caches of a collection — its window records and its
 * vectorization tip. These are two representations of the same fact ("how far this
 * collection is already extracted"), so they must always be cleared together: clearing
 * one but not the other was the stale-tip bug where re-vectorizing a deleted collection
 * fast-forwarded past every window and extracted 0 events.
 *
 * Use this anywhere a collection's extraction state is invalidated wholesale:
 *   - the backend is found empty but a local cache lingers (eventbase-workflow.js)
 *   - the user hits Vectorize for a fresh start (content-vectorizer.js)
 *
 * Does NOT touch the auto-sync marker — that's a separate concept (where
 * auto-sync should resume), intentionally preserved across these resets.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function clearExtractionCaches(registryKey) {
    if (!registryKey) return;
    clearWindowCache(registryKey);
    clearVectorizationTip(registryKey);
}

/**
 * Forgets what is held in memory of a collection that was deleted or imported, on any backend, so
 * the next read takes its pointer from its record: deleting the collection deleted its record, and an
 * import wrote the file's pointer into it, or none. index.js hands it to collection-loader's
 * setDeletedOrImportedCollectionCleanup(), so deleteCollection() and importCollection() run it.
 *
 * @param {string} collectionId - the collection's bare ID
 */
export function clearCachesForDeletedOrImportedCollection(collectionId) {
    const isThatCollection = registryKey => parseRegistryKey(registryKey).collectionId === collectionId;
    // Leaving the tip in memory makes the next re-vectorize fast-forward past every window (the tip
    // says "already at message N") and extract 0 events.
    for (const registryKey of [..._vectorizationTipByRegistryKey.keys()]) {
        if (isThatCollection(registryKey)) _vectorizationTipByRegistryKey.delete(registryKey);
    }
    for (const registryKey of [..._tipsCheckedThisPageLoad]) {
        if (isThatCollection(registryKey)) _tipsCheckedThisPageLoad.delete(registryKey);
    }
}

/**
 * Quick-exit check: returns true if the LAST complete window in the message list
 * is already extracted. Avoids building O(n) window objects. True does NOT mean every
 * earlier window succeeded, since a run carries on past a window that failed: check
 * getUnfinishedWindowFingerprints for those.
 *
 * @param {object[]} messages  - Filtered message array (same as passed to runEventBaseIngestion)
 * @param {number}   windowSize
 * @param {number}   step       - windowSize - windowOverlap
 * @param {string}   registryKey - The collection's registry key ("backend:id")
 * @param {Function} hashFn     - (message) => number hash for that message
 * @returns {boolean}
 */
export function isLastWindowExtracted(messages, windowSize, step, registryKey, hashFn) {
    if (!registryKey || messages.length < windowSize) return false;

    const totalPossible = Math.floor((messages.length - windowSize) / step) + 1;
    if (totalPossible <= 0) return false;

    const lastStart = (totalPossible - 1) * step;
    const lastMsgs = messages.slice(lastStart, lastStart + windowSize);
    if (lastMsgs.length < windowSize) return false;

    return isWindowAlreadyExtracted(lastMsgs.map(hashFn), registryKey);
}

/**
 * Whether a collection has read a window (O(1), no DB query), from its window record.
 *
 * @param {number[]} sourceHashes
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {boolean}
 */
export function isWindowAlreadyExtracted(sourceHashes, registryKey) {
    if (!sourceHashes?.length || !registryKey) return false;
    const windows = readEventBaseProgress(registryKey).extractedWindows;
    if (!Array.isArray(windows)) return false;
    return extractedWindowSetOf(windows).has(windowFingerprint(sourceHashes));
}

/**
 * The collection a run on the chat reads into: its write target (resolveEventBaseWriteTarget), else
 * the collection its first run makes, under the ID that run builds.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} chatUUID
 * @returns {{ collectionId: string, registryKey: string }}
 */
export function resolveEventBaseRunTarget(settings, chatUUID) {
    const writeTarget = resolveEventBaseWriteTarget(settings, chatUUID);
    if (writeTarget) return writeTarget;
    const collectionId = buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    return { collectionId, registryKey: buildRegistryKey(collectionId, settings) };
}

/**
 * Find every EventBase collection registered for the given chat UUID: each whose ID holds it, as parseCollectionId
 * reads it, so the chat's later collections are found beside its first.
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
        if (parseCollectionId(colId).chatUUID !== uuid) continue;
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
 * Turn OFF auto-sync for the chat's EventBase collection(s) so a bad model
 * stops silently re-failing on every message. The user re-enables it after fixing
 * the model. Dispatches `vectfox:collections-updated` so the UI checkbox updates.
 *
 * @param {string} chatUUID
 * @param {string} backend - registry backend, i.e. getRegistryBackend(settings.vector_backend)
 */
export function pauseAutoSyncForChat(chatUUID, backend) {
    if (!chatUUID || !backend) return;
    let paused = 0;
    for (const { registryKey } of findEventBaseCollectionsForChat(chatUUID, backend)) {
        setCollectionAutoSync(registryKey, false);
        paused++;
    }
    if (paused > 0) {
        globalThis.document?.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    }
}

/**
 * Resolve THE active EventBase collection for a chat — the canonical answer to
 * "which EventBase collection does this chat use right now?".
 *
 * This is the single entry point callers should use when they want one
 * collection (not a list). It is:
 *   - ownership-filtered (via getCollectionListing → drops collections owned by
 *     other personas/users, matching the DB Browser and the auto-sync status), and
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
 * @param {{ requireUuidMatch?: boolean, shouldLogResolution?: boolean }} [options]
 *   `requireUuidMatch` — write mode: reject collections whose embedded chat UUID
 *   differs from this chat (a foreign lock can never become a write target) or
 *   that are registered on a backend other than `vector_backend`.
 *   `shouldLogResolution` — false skips the `[EventBase][resolve]` lifecycle
 *   diagnostics, for passive UI refreshes while VectFox is disabled.
 * @returns {{ collectionId: string, registryKey: string } | null}
 */
export function resolveActiveEventBaseCollection(settings, chatUUID, { requireUuidMatch = false, shouldLogResolution = true } = {}) {
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
    const wantBackend = getRegistryBackend(settings?.vector_backend);
    const isEbMatch = (entry) => {
        const { collectionId } = entry;
        const idLower = String(collectionId || '').toLowerCase();
        if (!idLower.startsWith('vf_eventbase_') && !idLower.includes('eventbase_')) return false;
        // Write mode: the UUID match is mandatory, so a lock can widen ownership
        // but never redirect ingestion into another conversation's collection.
        // The collection must also live on the current backend: every write caller
        // sends the bare ID to the current backend, so a collection registered on
        // another backend would be re-created there under that backend's name
        // (a Qdrant collection called vf_eventbase_standard_…).
        // Returning null here is the correct outcome on a chat's first ingestion —
        // runEventBaseIngestion then falls through to buildEventBaseCollectionId
        // and creates this chat's own collection.
        if (requireUuidMatch) {
            return entry.backend === wantBackend && hasUuidMatch(entry) && (isLocked(entry) || entry.isOwn);
        }
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
    const logResolution = shouldLogResolution ? log.lifecycle : () => {};
    if (shouldLogResolution && log.enabled('lifecycle')) {
        const ebAll = listing.filter(e => {
            const il = String(e.collectionId || '').toLowerCase();
            return il.startsWith('vf_eventbase_') || il.includes('eventbase_');
        });
        const rows = ebAll.map(e =>
            `${e.collectionId} [own=${e.isOwn} locked=${isLocked(e)} uuidMatch=${hasUuidMatch(e)} eligible=${isEbMatch(e)}]`);
        logResolution(`[EventBase][resolve] chatUUID=${uuid} chatId=${chatId || '(none)'} requireUuidMatch=${requireUuidMatch}: ${ebAll.length} eb collection(s), ${ebMatches.length} eligible`);
        for (const r of rows) logResolution(`[EventBase][resolve]   ${r}`);
    }

    if (ebMatches.length === 0) {
        logResolution('[EventBase][resolve] → no eligible collection (auto-sync will report "no-collection")');
        return null;
    }

    // Ranking tiers, most significant first: lock, then own-UUID, then current
    // backend. The UUID tier matters when a chat has BOTH its own collection and
    // a foreign one locked in for cross-chat retrieval — without it both score 0
    // and the winner is decided by registry insertion order, which silently flips
    // if a collection is ever deleted and re-registered.
    const rank = (m) => (isLocked(m) ? 0 : 10)
        + (hasUuidMatch(m) ? 0 : 4)
        + (m.backend === wantBackend ? 0 : 1);
    const active = ebMatches.slice().sort((a, b) => rank(a) - rank(b))[0];
    logResolution(`[EventBase][resolve] → picked ${active.collectionId} (locked=${isLocked(active)} uuidMatch=${hasUuidMatch(active)})`);
    return { collectionId: active.collectionId, registryKey: active.registryKey };
}

/**
 * Resolve the EventBase collection that ingestion may WRITE to for this chat.
 *
 * Same resolution as {@link resolveActiveEventBaseCollection} with two extra
 * requirements:
 *   - The collection's embedded chat UUID must match; a foreign lock is not
 *     enough. A lock is a read-side sharing mechanism (lock an older chat's
 *     EventBase into this chat so its events are retrieved here). Honoring it on
 *     the write side put this chat's events into that older collection, where the
 *     two chats' independent `source_window_end` values collide inside one sort
 *     frame — the injected timeline then interleaves both conversations, and
 *     Resume reads the foreign collection's tip and skips every window
 *     ("0 events extracted").
 *   - The collection must be registered on the current `vector_backend`. Write
 *     callers send the bare ID to the current backend, so a collection from the
 *     other backend would be re-created there under the wrong backend's name.
 *
 * Returns null when this chat has no collection of its own on the current
 * backend yet; the caller is expected to fall back to `buildEventBaseCollectionId`
 * and create one.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} [chatUUID] - defaults to the current chat's UUID
 * @param {{ shouldLogResolution?: boolean }} [options] - see resolveActiveEventBaseCollection
 * @returns {{ collectionId: string, registryKey: string } | null}
 */
export function resolveEventBaseWriteTarget(settings, chatUUID, { shouldLogResolution = true } = {}) {
    return resolveActiveEventBaseCollection(settings, chatUUID, { requireUuidMatch: true, shouldLogResolution });
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

    // Collect all EventBase + ArchiveEvent Qdrant collections from the registry, by the Qdrant collection that holds
    // their points: with "One shared collection" on, every one of them is vectfox_main, indexed once.
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
            const { collectionId: physical } = qdrantTarget(colId, settings);
            if (!qdrantCollections.includes(physical)) qdrantCollections.push(physical);
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
                const msg = await readErrorBody(resp, resp.statusText);
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
                `VectFox: EventBase index upgrade failed for ${errors.length} collection(s) — see console. Searches may run slower.`,
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
 * The point ID an event is stored under, from its event_id: two-seed djb2 packed into
 * a 53-bit-safe integer. An event read again and an event edited in the Chunk Visualizer keep it, so either replaces
 * the stored event in place. Qdrant accepts uint64 point IDs, but JS only
 * round-trips uint53 without loss, so the value stays at or below
 * MAX_SAFE_INTEGER (2^53 - 1) and survives JSON.stringify / parseInt on every
 * hop.
 *
 * Qdrant treats a same-ID upsert as an overwrite, so a collision silently
 * destroys one event. At 53 bits the expected first collision comes near 134M
 * points (2^27), against ~93k for a 32-bit hash. Two checks surface any loss:
 * the per-batch uniqueness assertion in insertEvents() and the end-of-run count
 * check in runEventBaseIngestion (eventbase-workflow.js).
 *
 * @param {string} id
 * @returns {number}
 */
export function eventPointHash(id) {
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
