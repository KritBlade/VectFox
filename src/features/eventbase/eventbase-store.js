/**
 * ============================================================================
 * EVENTBASE STORE
 * ============================================================================
 * Qdrant insert / query / list / delete wrappers for EventBase collections.
 * All operations target a per-chat EventBase collection, isolated from the
 * legacy chunk collection.
 * ============================================================================
 */

import { insertVectorItems, deleteVectorItems, getSavedHashes, updateChunkMetadata, qdrantTarget } from '../vector-backend/index.js';
import { saveSettingsDebounced, extension_settings } from '../../sillytavern/settings.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { storyMessages } from '../../shared/chat-messages.js';
import { getRegistryBackend, COLLECTION_PREFIXES, parseCollectionId, parseRegistryKey } from '../../shared/collection-ids.js';
import {
    registerCollection,
    getCollectionRegistry,
    getCollectionMeta,
    setCollectionMeta,
    setCollectionAutoSync,
} from '../collections/index.js';
import { buildEmbedText } from './eventbase-schema.js';
import { findReplacedEvents, linksMovedToReplacements, mayHoldEarlierEvents, replacementIdsOf, windowSpanOf } from './eventbase-window-replacement-core.js';
import { log } from '../../sillytavern/log.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { announceEventsRemoved } from './eventbase-announcements.js';

// ---------------------------------------------------------------------------
// The pointer: how far EventBase has read a chat into one collection
// ---------------------------------------------------------------------------
// Each EventBase or archive collection keeps its own pointer in its record
// (extension_settings.vectfox.collections[<registry key>].eventbaseProgress), so
// two collections of one chat never share one:
//   vectorizationTip     — one past the last message any extracted window covers
//   extractedWindows     — the fingerprints of the windows read, so no message is read twice
//   unfinishedWindows    — the fingerprints of the windows that failed, sent again
//   autoSyncStartMarker  — the first message auto-sync reads; its windows start there
//   windowSize           — the window size Vectorize read it with, which Catch up reads with too: set at
//                          the chat's first read, by New collection and by Start over
// Every function below that takes a registryKey reads or writes that collection's
// pointer, and only through readEventBaseProgress and writeEventBaseProgress.
// Deleting the collection deletes its record, the pointer with it.

// Each extractedWindows array's fingerprints as a Set, and the hashes of the messages they
// hold as another, for O(1) lookups. Keyed by the array itself, so a record whose array is
// replaced (an import, a clear) is read again from the new array.
const _extractedWindowSets = new WeakMap(); // extractedWindows array → Set<fingerprint>
const _readMessageHashSets = new WeakMap(); // extractedWindows array → Set<message hash, as a string>

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
 * The hashes of every message an extractedWindows array's windows hold, as strings, built once per array: a fingerprint
 * holds one hash per message (windowFingerprint).
 */
function readMessageHashSetOf(windows) {
    let hashes = _readMessageHashSets.get(windows);
    if (!hashes) {
        hashes = new Set(windows.flatMap(fingerprint => fingerprint.split(',')));
        _readMessageHashSets.set(windows, hashes);
    }
    return hashes;
}

/** Whether every message of a window, by its fingerprint, is in a window read already. */
const isFingerprintRead = (fingerprint, readHashes) => fingerprint.split(',').every(hash => readHashes.has(hash));

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
export async function readStoredEvents(collectionId, settings) {
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
    return (await readStoredEvents(collectionId, settings))
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
 * @param {AbortSignal|null} abortSignal
 * @param {string} collectionId - The run's collection (runEventBaseIngestion): never an ID built again here, which
 *   changes with the persona and, in a group chat, with each speaker
 * @returns {Promise<void>}
 * @throws {Error} When no collection is given
 */
export async function insertEvents(events, settings, abortSignal, collectionId) {
    if (!events?.length) return;
    if (!collectionId) throw new Error('EventBase: no collection to write these events into.');

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
 * run, and only when a window may hold such events, so an ordinary turn reads nothing more. The IDs of the events
 * removed go to EventBase's listener (announceEventsRemoved).
 *
 * Neither method throws. A window whose earlier events could not be removed keeps both versions
 * until it is extracted again, and a link left on a removed event is one no walk can follow.
 *
 * @param {{collectionId: string, settings: object, tipAtRunStart: number|null|undefined}} run
 * @returns {{replaceEarlierEvents: (newEvents: object[], windowsReadEmpty?: object[]) => Promise<void>,
 *   moveLinksOffReplacedEvents: () => Promise<string[]>}}
 */
export function createWindowReplacement({ collectionId, settings, tipAtRunStart }) {
    const runEvents = [];
    const runWindowsReadEmpty = [];
    let uncheckedEvents = [];
    let uncheckedWindowsReadEmpty = [];
    let storedEventsRead = null;
    const replacementById = new Map();

    return {
        /**
         * After a batch is stored: removes the earlier events of the windows these new events
         * belong to. A window whose new extraction found no events is not among them, so it keeps
         * its earlier events, unless the run reads a stretch again and names it in windowsReadEmpty.
         *
         * @param {object[]} newEvents - The batch's stored events
         * @param {object[]} [windowsReadEmpty] - The batch's windows read again with no event found, as
         *   findReplacedEvents takes them
         */
        async replaceEarlierEvents(newEvents, windowsReadEmpty = []) {
            runEvents.push(...newEvents);
            runWindowsReadEmpty.push(...windowsReadEmpty);
            uncheckedEvents.push(...newEvents);
            uncheckedWindowsReadEmpty.push(...windowsReadEmpty);
            if (!storedEventsRead && !mayHoldEarlierEvents([...runEvents, ...runWindowsReadEmpty], tipAtRunStart)) return;
            storedEventsRead ??= readStoredEvents(collectionId, settings).catch((err) => {
                log.warn(`[EventBase] Could not read ${collectionId} for the events of earlier extractions, so windows extracted again keep both versions:`, err);
                return null;
            });
            const storedEvents = await storedEventsRead;
            const eventsToCheck = uncheckedEvents;
            const emptyWindowsToCheck = uncheckedWindowsReadEmpty;
            uncheckedEvents = [];
            uncheckedWindowsReadEmpty = [];
            if (!storedEvents) return;

            const replacedEvents = findReplacedEvents(storedEvents, eventsToCheck, new Set(runEvents.map(event => event.event_id)), emptyWindowsToCheck);
            if (!replacedEvents.length) return;
            try {
                await deleteVectorItems(collectionId, replacedEvents.map(event => event._hash), settings);
            } catch (err) {
                log.warn(`[EventBase] Could not remove ${replacedEvents.length} event(s) of earlier extractions from ${collectionId}, so their windows keep both versions:`, err);
                return;
            }
            announceEventsRemoved(collectionId, replacedEvents.map(event => event.event_id));
            for (const [replacedId, newId] of replacementIdsOf(replacedEvents, eventsToCheck)) replacementById.set(replacedId, newId);
            log.lifecycle(`[EventBase] Replaced ${replacedEvents.length} event(s) of earlier extractions in ${new Set(replacedEvents.map(windowSpanOf)).size} window(s)`);
        },

        /**
         * When the run ends, finished, stopped or failed: points the StoryArc links that went to
         * replaced events at the events that replaced them, and drops those to replaced events with
         * no replacement. Reads the collection again, since links change while a run goes on.
         *
         * @returns {Promise<string[]>} event_id of each event that held a link to a replaced event,
         *   whether or not its links were stored; none when the collection could not be read
         */
        async moveLinksOffReplacedEvents() {
            if (!replacementById.size) return [];
            let writes;
            try {
                writes = linksMovedToReplacements(await readStoredEvents(collectionId, settings), replacementById);
            } catch (err) {
                log.warn(`[EventBase] Could not read ${collectionId} to move links off replaced events, so walks skip those links:`, err);
                return [];
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
            return writes.map(({ event }) => event.event_id);
        },
    };
}

// ---------------------------------------------------------------------------
// AutoSync start-marker (per-chat) — see InternalProject/Vectfox/plans/executed/autosync-independent-window-and-last-n-injection.md §9
// ---------------------------------------------------------------------------
//
// The window record below skips a window only once every message in it was
// read, in windows of any size (isWindowAlreadyExtracted), so a window of
// auto-sync's size that holds messages read before at another size would read
// them again. The marker is the first message auto-sync reads: its windows
// start at the marker and every step after it (autoSyncFirstWindowStart), and
// it reads none that starts before it, so whatever window size stamped the
// marker, auto-sync reads no message twice and skips none after it. Stamped on
// auto-sync enable and re-stamped whenever the auto-sync window size setting
// changes (Phase 2 — see §9.8 of the linked plan). An auto-sync run moves it
// back to the chat's unread end when the chat got shorter than it
// (capAutoSyncMarker).

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
 * Move a collection's auto-sync start marker back when the chat got shorter than it, as it does when messages are
 * deleted or a summarizer replaces some with a summary. Past the end, the marker would keep auto-sync from reading
 * anything until the chat grew past it again, the new messages before it included. It moves to the chat's unread end:
 * the messages after the last one the window record holds, among the last that auto-sync leaves unread while it keeps
 * up (the turn it holds back and a window not yet full). So the turn held back before the chat got shorter is read
 * with the new messages, and no message read before is read again.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object[]} messages - The messages auto-sync reads in the chat
 * @param {{windowSize: number, step: number, hashFn: (message: object) => number}} autoSyncWindow - Auto-sync's window
 *   size, how far apart its windows start, and the hash a window's fingerprint holds for each message
 * @returns {number|undefined} The marker after the move, or undefined if none is stamped
 */
export function capAutoSyncMarker(registryKey, messages, { windowSize, step, hashFn }) {
    const marker = getAutoSyncMarker(registryKey);
    const messageCount = messages.length;
    if (typeof marker !== 'number' || marker <= messageCount) return marker;
    const readHashes = readMessageHashSetOf(readEventBaseProgress(registryKey).extractedWindows ?? []);
    const earliestUnreadEnd = Math.max(0, messageCount - (windowSize + step - 1));
    let movedMarker = messageCount;
    while (movedMarker > earliestUnreadEnd && !readHashes.has(String(hashFn(messages[movedMarker - 1])))) movedMarker--;
    writeEventBaseProgress(registryKey, { autoSyncStartMarker: movedMarker });
    log.lifecycle(`[EventBase] AutoSyncMarker ${marker} is past the chat's ${messageCount} messages: moved to ${movedMarker}`);
    return movedMarker;
}

/**
 * Where auto-sync's windows start counting: the start marker's place among windows of the step, so one window starts
 * exactly at the marker whatever window size stamped it, or the chat's first message while none is stamped.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} step - How far apart auto-sync's windows start
 * @returns {number} The message auto-sync's first window starts at, below step
 */
export function autoSyncFirstWindowStart(registryKey, step) {
    const marker = getAutoSyncMarker(registryKey);
    if (typeof marker !== 'number' || marker <= 0) return 0;
    return marker % Math.max(1, step);
}

/**
 * Stamp a collection's auto-sync start marker, which gates the windows auto-sync
 * reads into it. The collection is the chat's collection in use, on the current backend
 * (collectionInUse): the marker is a message index into the open chat.
 *
 * Smart placement:
 *   - If the collection has events → marker = max(source_window_end) + 1
 *     (backfill the gap between last-covered message and current chat tail
 *     at the user's new window size).
 *   - If the collection is empty → marker = the chat's length
 *     (auto-sync starts "from now on" — no full backfill of a long pre-existing
 *     chat that was never vectorized).
 *
 * Floor override: pass `{ floor: 'chatLength' }` to force "from now on" placement
 * regardless of existing coverage — used by the auto-sync enable flow's "Just keep
 * up from here" choice, where the user explicitly declines backfilling the gap.
 *
 * The chat's length counts its messages as a run does, those with text in story order (storyMessages), the positions
 * its windows and stored events use. Auto-sync's windows start at the marker (autoSyncFirstWindowStart), so the window
 * holding the next message starts with it.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object} settings
 * @param {{ floor?: 'chatLength' }} [options]
 * @returns {Promise<number>}  The marker that was stamped.
 */
export async function stampAutoSyncMarker(registryKey, settings, options = {}) {
    if (!registryKey) return 0;
    const chatLength = storyMessages().length;

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
 * The window size a collection is read with (§2.7 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * the Vectorize dialog's size at the chat's first read, at New collection or at Start over, which Catch up reads with
 * too. No run changes it afterwards; auto-sync reads at the AutoSync page's own size.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {number|undefined}
 */
export function getCollectionWindowSize(registryKey) {
    return readEventBaseProgress(registryKey).windowSize;
}

/**
 * Set the window size a collection is read with: at the chat's first read, by New collection, by Start over, by a run
 * on a collection that keeps none, and on a fork, from the collection the branch's events came from.
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {number} windowSize
 */
export function setCollectionWindowSize(registryKey, windowSize) {
    if (!Number.isFinite(windowSize)) return;
    writeEventBaseProgress(registryKey, { windowSize });
}

// ---------------------------------------------------------------------------
// Re-extraction coordination helpers
// ---------------------------------------------------------------------------
// These two helpers are the single source of truth for:
//   1. "Should the workflow apply its Qdrant-side tip fallback?"  → shouldUseTipFallback()
//   2. "User asked for fresh extraction — prep the chat state"    → prepareForFreshExtraction()
//
// Code that touches these concerns must use these helpers, not inline the logic: a
// caller that clears the local cache while the Qdrant-side tip fallback still fires
// gets a silent "0 events, X skipped" run. If a check needs new behavior, extend the
// helper, don't fork it at a call site.

/**
 * Workflow helper. Decide whether `runEventBaseIngestion` should perform its
 * Qdrant-side tip-derived fast-forward. Pure function — caller passes the
 * current state, gets a yes/no.
 *
 * The fallback fires ONLY when ALL of:
 *   - Caller did NOT explicitly opt out (skipTipFallback === false)
 *   - A collection exists to probe (hasCollection === true)
 *   - The window record holds no window of the collection, read or unfinished (hasWindowRecord === false)
 *
 * The tip is the furthest window stored, so falling back to it marks every window
 * before it extracted. That is right only when the record was lost, as an import
 * without its pointer leaves it. A record that holds windows proves the local cache
 * is alive, so a window it lacks is unread: a summary or an edit changed the first
 * window, or the window failed, and each window is checked against the record instead.
 *
 * Only the workflow asks it; the dialogs that request a fresh extraction opt out
 * through skipTipFallback (prepareForFreshExtraction).
 *
 * @param {{ skipTipFallback: boolean, hasCollection: boolean, hasWindowRecord: boolean }} state
 * @returns {boolean}
 */
export function shouldUseTipFallback({ skipTipFallback, hasCollection, hasWindowRecord }) {
    if (skipTipFallback) return false;
    if (!hasCollection) return false;
    if (hasWindowRecord) return false;
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
 * Call this whenever a run promises to read from the Start from message whatever
 * was read before: a chat's first read, Start over (after emptyEventBaseCollection),
 * New collection, and a chat file's Vectorize. If another trigger is ever added,
 * route it through this helper too.
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
 * Marks a window as extracted in a collection's pointer, and takes off its unfinished record that window and every
 * failed window whose messages have all been read now, in windows of any size.
 * Stored in the settings, so it survives page reloads without requiring a chat save.
 * @param {number[]} sourceHashes
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function markWindowExtracted(sourceHashes, registryKey) {
    if (!sourceHashes?.length || !registryKey) return;
    const fingerprint = windowFingerprint(sourceHashes);
    const windows = readEventBaseProgress(registryKey).extractedWindows ?? [];
    const extracted = extractedWindowSetOf(windows);
    const readHashes = readMessageHashSetOf(windows);
    if (!extracted.has(fingerprint)) {
        // A new array, which the record then holds: both Sets move to it with the window added.
        const nextWindows = [...windows, fingerprint];
        extracted.add(fingerprint);
        for (const hash of fingerprint.split(',')) readHashes.add(hash);
        _extractedWindowSets.set(nextWindows, extracted);
        _readMessageHashSets.set(nextWindows, readHashes);
        writeEventBaseProgress(registryKey, { extractedWindows: nextWindows });
    }
    _keepUnfinishedWindows(registryKey, recorded => recorded !== fingerprint && !isFingerprintRead(recorded, readHashes));
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
 * Start over's emptying (§2.6 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): delete every event
 * a collection holds, and with them the StoryArc links stored on them; only once none is left, forget the windows it
 * read, the windows that failed and how far it read, and take the window size given. Where auto-sync started stays, as
 * do the collection's ID, name, locks, auto-sync switch and StoryArc merges, and the collection itself, empty, so
 * discovery keeps listing it. Deletes as many events as a listing gives at a time, until none is listed. Once a
 * collection that held events is empty, EventBase's listener hears that it was emptied (announceEventsRemoved).
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @param {object} settings - VectFox settings
 * @param {{windowSize: number}} reading - The window size the collection is read with from now on
 * @returns {Promise<number>} How many events were deleted
 * @throws {Error} When the backend refuses a delete, or a delete leaves events it was given; the pointer stays as it was
 */
export async function emptyEventBaseCollection(registryKey, settings, { windowSize }) {
    const { collectionId } = parseRegistryKey(registryKey);
    let deletedCount = 0;
    let listed = await getSavedHashes(collectionId, settings);
    while (listed.length) {
        await deleteVectorItems(collectionId, listed, settings);
        const deleted = new Set(listed);
        const next = await getSavedHashes(collectionId, settings);
        const keptCount = next.filter(hash => deleted.has(hash)).length;
        if (keptCount) throw new Error(`${keptCount} of the ${listed.length} events it was asked to delete are still stored`);
        deletedCount += listed.length;
        listed = next;
    }
    clearExtractionCaches(registryKey);
    setCollectionWindowSize(registryKey, windowSize);
    log.lifecycle(`[EventBase] Start over emptied ${registryKey}: ${deletedCount} event(s) deleted, window size ${windowSize}`);
    if (deletedCount > 0) announceEventsRemoved(collectionId, null);
    return deletedCount;
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
 * @param {number}   [firstWindowStart] - The message the first window starts at: auto-sync's from its start marker
 *   (autoSyncFirstWindowStart), 0 for every other run
 * @returns {boolean}
 */
export function isLastWindowExtracted(messages, windowSize, step, registryKey, hashFn, firstWindowStart = 0) {
    const messagesInWindows = messages.length - firstWindowStart;
    if (!registryKey || messagesInWindows < windowSize) return false;

    const totalPossible = Math.floor((messagesInWindows - windowSize) / step) + 1;
    if (totalPossible <= 0) return false;

    const lastStart = firstWindowStart + (totalPossible - 1) * step;
    const lastMsgs = messages.slice(lastStart, lastStart + windowSize);
    if (lastMsgs.length < windowSize) return false;

    return isWindowAlreadyExtracted(lastMsgs.map(hashFn), registryKey);
}

/**
 * Whether a collection has read a window (no DB query), from its window record: the window's fingerprint is on it, or
 * every message in the window is in a window read already, of any size (§2.7 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md). So a Catch up after auto-sync read at another
 * size reads only the unread messages, and a deleted message or a changed overlap, which move every later window,
 * read nothing again.
 *
 * @param {number[]} sourceHashes
 * @param {string} registryKey - The collection's registry key ("backend:id")
 * @returns {boolean}
 */
export function isWindowAlreadyExtracted(sourceHashes, registryKey) {
    if (!sourceHashes?.length || !registryKey) return false;
    const windows = readEventBaseProgress(registryKey).extractedWindows;
    if (!Array.isArray(windows)) return false;
    if (extractedWindowSetOf(windows).has(windowFingerprint(sourceHashes))) return true;
    const readHashes = readMessageHashSetOf(windows);
    return sourceHashes.every(hash => readHashes.has(String(hash)));
}

/**
 * Every EventBase collection registered for the given chat UUID, on every backend and of every account: each whose ID
 * holds it, as parseCollectionId reads it, so the chat's later collections are found beside its first. Never an
 * archive. Which of them the chat uses is collectionInUse's answer (eventbase-chat-collections.js), the one route every
 * reader and writer of a chat's events asks; this list is what that route, and the lock function unlocking the chat's
 * others, read.
 *
 * The registry, not `buildEventBaseCollectionId`, is the source of truth for which collection holds a chat's data: the
 * ID embeds a sanitized form of `name1`/`name2`, whose sanitization has changed over time.
 *
 * @param {string} uuid Chat UUID
 * @returns {{ registryKey: string, collectionId: string, backend: string|null }[]} In registry order, a legacy ID's backend null
 */
export function findEventBaseCollectionsForChat(uuid) {
    if (!uuid) return [];
    const matches = [];
    for (const registryKey of getCollectionRegistry()) {
        const { backend, collectionId } = parseRegistryKey(registryKey);
        if (!collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) continue;
        if (parseCollectionId(collectionId).chatUUID !== uuid) continue;
        matches.push({ registryKey, collectionId, backend });
    }
    return matches;
}

/**
 * Turn auto-sync off for a collection, the one in use whose run failed on a model the provider no longer knows, so it
 * stops failing on every message. The user turns it on again after fixing the model. Dispatches
 * `vectfox:collections-updated` so the AutoSync page's switch follows.
 *
 * @param {string} registryKey - The collection's registry key ("backend:id")
 */
export function pauseCollectionAutoSync(registryKey) {
    if (!registryKey) return;
    setCollectionAutoSync(registryKey, false);
    globalThis.document?.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
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
