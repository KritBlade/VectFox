/**
 * LoreBase's vectors in Qdrant (§4 of InternalProject/Vectfox/plans/lorebook-multi-vector.md): the points of each
 * selected entry, embedded by VectFox's embedding model through the vector API every collection goes through, every book
 * of a SillyTavern account a tenant inside one Qdrant collection (Q6): vectfox_main while "One shared collection" is on,
 * the account's own otherwise. What Qdrant holds for a book is read the first time this session needs it, again when the
 * selection screen opens the book, at turning LoreBase on and at Generate all, and kept current by what this session
 * writes and deletes. An entry is ready once it has its keys and its vectors from the embedding model set now (§4.4). An
 * edit SillyTavern saves writes the changed parts of the entries that had vectors again in the background and deletes
 * their gone parts; the points of an entry no longer selected go when the selection screen closes.
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { getCurrentUserHandle } from '../../sillytavern/user.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { getModelFromSettings } from '../embedding/index.js';
import { deleteVectorItems, insertVectorItems, listChunks, purgeVectorIndex } from '../vector-backend/index.js';
import { getLoreBook, loadDecidedEntries } from './lorebase-books.js';
import { writingFailuresMessage } from './lorebase-keys-core.js';
import { entryTitle } from './lorebase-splitter.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn } from './lorebase-switch.js';
import {
    bookVectorWork, embeddingModelKey, entryPoints, hasCurrentVectors, loreBaseAccountCollection, loreBaseBookCollectionId,
    pointBatches, storedPointsOf, uidsWithStoredVectors,
} from './lorebase-vectors-core.js';

// Similharity lists every point of a book, then returns at most this many: all of them.
const ALL_POINTS = Number.MAX_SAFE_INTEGER;
// Points per insert batch when the settings name none, as the vector API's insert batches them.
const DEFAULT_BATCH_SIZE = 50;
// How long after SillyTavern's last save of a book its edited entries' vectors are written, so a burst of saves while
// the user types writes once.
const EDIT_SETTLE_MS = 2000;

// What Qdrant holds, as last read or written in this session: book name -> hash -> {uid, modelKey}.
const storedVectors = new Map();
// Each entry's points, made again only when its title or text changes: collection ID and uid -> {comment, content, points}.
const pointsMemo = new Map();
// Each book's refresh after an edit, waiting for SillyTavern's saves to settle: book name -> timer.
const editTimers = new Map();

/** The book's collection ID for this SillyTavern account. */
const bookCollectionIdOf = bookName => loreBaseBookCollectionId(bookName, getCurrentUserHandle());

/**
 * The settings a request about LoreBase's vectors goes with: a copy that names every book as a tenant, inside
 * vectfox_main while "One shared collection" is on, else inside the account's own collection (Q6, qdrantTarget).
 * @param {object} settings - VectFox settings
 * @returns {object}
 */
function vectorSettings(settings) {
    return {
        ...settings,
        qdrant_multitenancy: true,
        qdrant_shared_collection: settings.qdrant_multitenancy ? null : loreBaseAccountCollection(getCurrentUserHandle()),
    };
}

/**
 * The embedding model set now, as the key each point's model is compared with: the source and model the vector API's
 * insert sends, which Similharity stores on each point.
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function currentEmbeddingModelKey(settings) {
    return embeddingModelKey(settings.embedding_provider || 'transformers', getModelFromSettings(settings));
}

/**
 * An entry's points (entryPoints), made again only when its title or text changes.
 * @param {string} collectionId - The book's collection ID
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @returns {object[]}
 */
function pointsOf(collectionId, entry) {
    const key = `${collectionId}\u001f${entry.uid}`;
    const known = pointsMemo.get(key);
    if (known && known.comment === entry.comment && known.content === entry.content) return known.points;
    const points = entryPoints(entry, collectionId);
    pointsMemo.set(key, { comment: entry.comment, content: entry.content, points });
    return points;
}

/**
 * Each of a book's entries with its points.
 * @param {string} bookName
 * @param {object[]} entries
 * @returns {Array<{entry: object, uid: string, points: object[]}>}
 */
function withPoints(bookName, entries) {
    const collectionId = bookCollectionIdOf(bookName);
    return entries.map(entry => ({ entry, uid: String(entry.uid), points: pointsOf(collectionId, entry) }));
}

/**
 * Read what Qdrant holds for the named books now, and keep it for this session.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, Map<number, {uid: string, modelKey: string}>>>}
 * @throws {Error} When Similharity cannot list a book's points
 */
export async function readBookVectors(bookNames, settings) {
    const requestSettings = vectorSettings(settings);
    const listed = await Promise.all(bookNames.map(bookName => listChunks(bookCollectionIdOf(bookName), requestSettings, { limit: ALL_POINTS })));
    bookNames.forEach((bookName, index) => storedVectors.set(bookName, storedPointsOf(listed[index]?.items)));
    return new Map(bookNames.map(bookName => [bookName, storedVectors.get(bookName)]));
}

/**
 * What Qdrant holds for the named books, read from Qdrant only for those this session has not read yet.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, Map<number, {uid: string, modelKey: string}>>>}
 * @throws {Error} When Similharity cannot list a book's points
 */
export async function bookVectors(bookNames, settings) {
    const unread = bookNames.filter(bookName => !storedVectors.has(bookName));
    if (unread.length) await readBookVectors(unread, settings);
    return new Map(bookNames.map(bookName => [bookName, storedVectors.get(bookName)]));
}

/**
 * The uids of a book's entries that have their vectors from the embedding model set now (hasCurrentVectors), as
 * `stored` holds them.
 * @param {string} bookName
 * @param {object[]} entries
 * @param {Map<number, {modelKey: string}>} stored - From bookVectors
 * @param {object} settings - VectFox settings
 * @returns {Set<string>}
 */
export function uidsWithCurrentVectors(bookName, entries, stored, settings) {
    const modelKey = currentEmbeddingModelKey(settings);
    return new Set(withPoints(bookName, entries).filter(({ points }) => hasCurrentVectors(points, stored, modelKey)).map(({ uid }) => uid));
}

/** A point as the vector API inserts it: its own ID and hash, its text, and the book, entry and part it belongs to. */
function pointItem(bookName, point) {
    return {
        id: point.id,
        hash: point.hash,
        text: point.text,
        keywords: [],
        metadata: { lorebookName: bookName, entryUid: point.uid, partNumber: point.partNumber },
    };
}

/**
 * Delete stored points of a book by their hashes, and forget them. Never throws: a point left behind belongs to no
 * entry LoreBase decides, so it is logged and deleted again next time.
 * @param {string} bookName
 * @param {number[]} hashes
 * @param {object} settings - VectFox settings
 */
async function deleteStoredPoints(bookName, hashes, settings) {
    if (!hashes.length) return;
    try {
        await deleteVectorItems(bookCollectionIdOf(bookName), hashes, vectorSettings(settings));
        const stored = storedVectors.get(bookName);
        for (const hash of hashes) stored?.delete(hash);
        log.verbose(`LoreBase: deleted ${hashes.length} vectors of lorebook "${bookName}" that no selected entry holds`);
    } catch (error) {
        log.warn(`LoreBase: ${hashes.length} vectors of lorebook "${bookName}" that no selected entry holds could not be deleted:`, error);
    }
}

/**
 * Write the vectors of some of a book's entries: each one's points not stored by the embedding model set now, in
 * batches of whole entries of at most Insert batch size points; then delete what no entry LoreBase decides holds
 * (bookVectorWork). Stored before deleted, so a failure part way leaves extra points, never a hole. A run passes its
 * `run`, whose stop leaves the batches not yet sent, each of their entries stopped; `onEntryDone` is called with each
 * entry done, and null or its failure. Never throws: a failed batch fails its entries, each named; a wrong embedding
 * setup, which fails every batch the same way, fails every entry left in the run at once and raises the sticky popup.
 * @param {string} bookName
 * @param {object[]} decidedEntries - Every entry LoreBase decides in the book now
 * @param {object[]} entriesToWrite - Those whose vectors to write
 * @param {object} settings - VectFox settings
 * @param {{run?: {isStopped: boolean, vectorProblem?: string|null}, onEntryDone?: (entry: object, failure: object|null) => void}} [options]
 * @returns {Promise<{written: number, failures: Array<{title: string, detail: string}>, stopped: number}>}
 */
export async function writeBookVectors(bookName, decidedEntries, entriesToWrite, settings, { run = null, onEntryDone = null } = {}) {
    const result = { written: 0, failures: [], stopped: 0 };
    const fail = (entries, detail) => {
        for (const entry of entries) {
            const failure = { title: entryTitle(entry), detail };
            result.failures.push(failure);
            onEntryDone?.(entry, failure);
        }
    };
    let stored;
    try {
        stored = (await bookVectors([bookName], settings)).get(bookName);
    } catch (error) {
        log.warn(`LoreBase: the vectors of lorebook "${bookName}" could not be read, so none were written:`, error);
        fail(entriesToWrite, String(error?.message || error));
        return result;
    }
    const modelKey = currentEmbeddingModelKey(settings);
    const { points, deleteHashes } = bookVectorWork(withPoints(bookName, decidedEntries), entriesToWrite.map(entry => String(entry.uid)), stored, modelKey);
    const pointsByUid = new Map();
    for (const point of points) pointsByUid.set(point.uid, [...(pointsByUid.get(point.uid) ?? []), point]);
    const writing = entriesToWrite.map(entry => ({ entry, uid: String(entry.uid), points: pointsByUid.get(String(entry.uid)) ?? [] }));
    // An entry whose every point is stored already has nothing to write.
    for (const { entry } of writing.filter(item => !item.points.length)) {
        result.written += 1;
        onEntryDone?.(entry, null);
    }
    const collectionId = bookCollectionIdOf(bookName);
    const requestSettings = vectorSettings(settings);
    // A wrong embedding setup fails every batch the same way: once met, here or earlier in the run, no batch is sent.
    let setupProblem = run?.vectorProblem ?? null;
    for (const batch of pointBatches(writing.filter(item => item.points.length), settings.insert_batch_size || DEFAULT_BATCH_SIZE)) {
        const entries = batch.map(item => item.entry);
        if (run?.isStopped) {
            result.stopped += entries.length;
            continue;
        }
        if (setupProblem) {
            fail(entries, setupProblem);
            continue;
        }
        const batchPoints = batch.flatMap(item => item.points);
        try {
            await insertVectorItems(collectionId, batchPoints.map(point => pointItem(bookName, point)), requestSettings);
            for (const point of batchPoints) stored.set(point.hash, { uid: point.uid, modelKey });
            result.written += entries.length;
            for (const entry of entries) onEntryDone?.(entry, null);
        } catch (error) {
            const detail = String(error?.message || error);
            log.warn(`LoreBase: the vectors of ${entries.length} entries in lorebook "${bookName}" could not be written:`, error);
            if (error?.code === 'invalid_model_config') {
                notifyInvalidModel(error.message);
                setupProblem = detail;
                if (run) run.vectorProblem = detail;
            }
            fail(entries, detail);
        }
    }
    await deleteStoredPoints(bookName, deleteHashes, settings);
    log.lifecycle(`LoreBase: wrote the vectors of ${result.written} of ${entriesToWrite.length} entries in lorebook "${bookName}"`
        + (result.stopped ? `, ${result.stopped} stopped` : ''));
    return result;
}

/**
 * Say which entries' vectors a run could not write, in one toast for the book.
 * @param {string} bookName
 * @param {Array<{title: string, detail: string}>} failures
 */
export function showVectorFailures(bookName, failures) {
    if (!failures.length) return;
    const message = writingFailuresMessage({ what: 'vectors', bookName, failures, remedy: "Generate all on VectFox's WorldInfo page writes them again." });
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(message, 'VectFox — LoreBase vectors', { timeOut: 30000, extendedTimeOut: 10000 });
}

/**
 * Delete the points of a book that no entry LoreBase decides holds now: those of entries no longer selected, deleted, or
 * ones it cannot decide, and parts an entry no longer has (§4.3), as the selection screen closes on a changed
 * selection. Writes nothing. Never throws.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @returns {Promise<void>}
 */
export async function pruneBookVectors(bookName, settings) {
    try {
        const decidedEntries = await loadDecidedEntries(bookName);
        const stored = (await bookVectors([bookName], settings)).get(bookName);
        const { deleteHashes } = bookVectorWork(withPoints(bookName, decidedEntries), [], stored, currentEmbeddingModelKey(settings));
        await deleteStoredPoints(bookName, deleteHashes, settings);
    } catch (error) {
        log.warn(`LoreBase: the vectors of lorebook "${bookName}" that no selected entry holds could not be read, so none were deleted:`, error);
    }
}

/**
 * Delete every LoreBase vector of this SillyTavern account (Delete all, §4.3): its own Qdrant collection while "One
 * shared collection" is off, else each named book's points in vectfox_main.
 * @param {string[]} bookNames - Every book VectFox keeps a LoreBase record of
 * @param {object} settings - VectFox settings
 * @returns {Promise<void>}
 * @throws {Error} When Similharity cannot delete them
 */
export async function deleteAllVectors(bookNames, settings) {
    if (settings.qdrant_multitenancy) {
        const requestSettings = vectorSettings(settings);
        for (const bookName of bookNames) await purgeVectorIndex(bookCollectionIdOf(bookName), requestSettings);
    } else {
        await purgeVectorIndex(loreBaseAccountCollection(getCurrentUserHandle()), { ...settings, qdrant_multitenancy: false });
    }
    storedVectors.clear();
    log.lifecycle('LoreBase: deleted every vector of this account');
}

/**
 * After SillyTavern saves an edited book: write the changed parts of its entries that had vectors, and delete what no
 * entry it decides holds, in the background (§4.3). Only while LoreBase is on, on Qdrant, with VectFox on; turning it on
 * finds what changed while it was off. Never throws.
 * @param {string} bookName
 * @returns {Promise<void>}
 */
async function refreshEditedBook(bookName) {
    const settings = extension_settings.vectfox;
    if (!isVectFoxEnabled(settings) || !isLoreBaseSwitchedOn(settings) || !isLoreBaseBackend(settings) || !getLoreBook(bookName)) return;
    try {
        const decidedEntries = await loadDecidedEntries(bookName);
        const stored = (await bookVectors([bookName], settings)).get(bookName);
        if (!stored.size) return;
        const uids = new Set(uidsWithStoredVectors(withPoints(bookName, decidedEntries), stored));
        const { failures } = await writeBookVectors(bookName, decidedEntries, decidedEntries.filter(entry => uids.has(String(entry.uid))), settings);
        if (failures.length) log.warn(`LoreBase: after an edit, the vectors of ${failures.length} entries in lorebook "${bookName}" could not be written: ${failures[0].detail}`);
    } catch (error) {
        log.warn(`LoreBase: after an edit, the vectors of lorebook "${bookName}" could not be brought up to date:`, error);
    }
}

/**
 * Follow SillyTavern's saves of edited books, each written once its saves settle. Called once at start-up.
 */
export function initializeLoreBaseVectors() {
    eventSource.on(event_types.WORLDINFO_UPDATED, bookName => {
        if (!bookName) return;
        clearTimeout(editTimers.get(bookName));
        editTimers.set(bookName, setTimeout(() => {
            editTimers.delete(bookName);
            void refreshEditedBook(bookName);
        }, EDIT_SETTLE_MS));
    });
}
