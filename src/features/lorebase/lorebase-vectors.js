/**
 * LoreBase's vectors in Qdrant (§4 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the points of each
 * selected entry, embedded by VectFox's embedding model through the vector API every collection goes through, every book
 * of a SillyTavern account a tenant inside one Qdrant collection (Q6): vectfox_main while "One shared collection" is on,
 * the account's own otherwise. What Qdrant holds for a book is read the first time this session needs it in the
 * collection read now, again when the selection screen opens the book, at turning LoreBase on and at each Generate
 * button, and kept current by what this session writes and deletes. An entry is ready once it has its keys and its
 * vectors from the embedding model set now (§4.4, isEntryReady in lorebase-readiness.js).
 * While an entry's vectors are written, and after they fail, its state is kept for this session and told to the vector
 * listeners, so the selection screen's row and the books card say so (§7.1, §7.3). An
 * edit SillyTavern saves writes the changed parts of the entries that had vectors again in the background and deletes
 * their gone parts; the points of an entry no longer selected go when the selection screen closes. For the Database
 * Browser's rows (§3.2 and §3.3 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), a book tenant's
 * points are read whole, vectors included, in whichever collection holds them, and its View chunks reads them there
 * (tenantChunkSource), a vectors file's points are stored with
 * their vectors and no embedding call, and a tenant is deleted whole (deleteTenantPoints, the one delete of a tenant,
 * Delete all's too). A reply on Fast and Cheap [Jev] searches every
 * book taking part in one request for each of its two texts (§4.5).
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { getCurrentUserHandle } from '../../sillytavern/user.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { getModelFromSettings, searchPieceTokensOf, searchTokens } from '../embedding/index.js';
import {
    MULTITENANCY_COLLECTION, deleteVectorItems, insertVectorItems, listChunks, purgeVectorIndex, searchCollectionsTogether,
} from '../vector-backend/index.js';
import { getLoreBook, loadDecidedEntries } from './lorebase-books.js';
import { POOL_SEATS } from './lorebase-jev-core.js';
import { writingFailuresMessage } from './lorebase-keys-core.js';
import { entryTitle } from './lorebase-splitter.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn } from './lorebase-switch.js';
import {
    PARTS_PER_SEAT, bookVectorWork, embeddingModelKey, entryPoints, hasCurrentVectors, hasOtherModelVectors, loreBaseAccountCollection,
    loreBaseBookCollectionId, newestWithin, pointBatches, searchPool, searchTextsOf, storedPointsOf, uidsWithStoredVectors,
} from './lorebase-vectors-core.js';

// Similharity lists every point of a book, then returns at most this many: all of them.
const ALL_POINTS = Number.MAX_SAFE_INTEGER;
// Points per insert batch when the settings name none, as the vector API's insert batches them.
const DEFAULT_BATCH_SIZE = 50;
// How long after SillyTavern's last save of a book its edited entries' vectors are written, so a burst of saves while
// the user types writes once.
const EDIT_SETTLE_MS = 2000;

// What Qdrant holds, as last read or written in this session: Qdrant collection -> book name -> hash -> {uid, modelKey},
// read through storedPointsHere.
const storedVectors = new Map();
// Each entry's points, made again only when its title or text changes: collection ID and uid -> {comment, content, points}.
const pointsMemo = new Map();
// Each book's refresh after an edit, waiting for SillyTavern's saves to settle: book name -> timer.
const editTimers = new Map();
// Entries whose vectors are being written or whose writing failed: book name -> uid -> {status: 'writing'} |
// {status: 'failed', detail}.
const writeStates = new Map();
const stateListeners = new Set();

/** The book's collection ID for this SillyTavern account. */
const bookCollectionIdOf = bookName => loreBaseBookCollectionId(bookName, getCurrentUserHandle());

const statesOf = bookName => {
    if (!writeStates.has(bookName)) writeStates.set(bookName, new Map());
    return writeStates.get(bookName);
};

function tellStateListeners(bookName) {
    for (const listener of stateListeners) {
        try {
            listener(bookName);
        } catch (error) {
            log.warn('LoreBase: a vector listener failed:', error);
        }
    }
}

/**
 * Call `listener` with a book's name each time some of its entries' vectors start being written, are written, fail or
 * are stopped.
 * @param {(bookName: string) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onVectorStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
}

/**
 * The Qdrant collection LoreBase reads and writes this account's vectors in now: vectfox_main while "One shared
 * collection" is on, the account's own otherwise (Q6).
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function loreBaseVectorsCollection(settings) {
    return settings.qdrant_multitenancy ? MULTITENANCY_COLLECTION : loreBaseAccountCollection(getCurrentUserHandle());
}

/**
 * The settings a request about books' points in one Qdrant collection goes with: a copy naming every book a tenant
 * there (qdrantTarget), vectfox_main named by no shared collection of its own.
 * @param {object} settings - VectFox settings
 * @param {string} collection - The Qdrant collection
 * @returns {object}
 */
function settingsInCollection(settings, collection) {
    return { ...settings, qdrant_multitenancy: true, qdrant_shared_collection: collection === MULTITENANCY_COLLECTION ? null : collection };
}

/**
 * The settings a request about LoreBase's vectors goes with: every book a tenant of the collection LoreBase reads now.
 * @param {object} settings - VectFox settings
 * @returns {object}
 */
function vectorSettings(settings) {
    return settingsInCollection(settings, loreBaseVectorsCollection(settings));
}

/**
 * The embedding model set now: the source and model the vector API's insert sends, which Similharity stores on each
 * point. The one reading of it: what each point's model is compared with (currentEmbeddingModelKey), and what the
 * Database Browser's import names as the model set now.
 * @param {object} settings - VectFox settings
 * @returns {{source: string, model: string}}
 */
export function currentEmbeddingModel(settings) {
    return { source: settings.embedding_provider || 'transformers', model: getModelFromSettings(settings) };
}

/**
 * The embedding model set now (currentEmbeddingModel), as the key each point's model is compared with.
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function currentEmbeddingModelKey(settings) {
    const { source, model } = currentEmbeddingModel(settings);
    return embeddingModelKey(source, model);
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
 * Each of a book's entries with its points, each point's ID made for this book and account.
 * @param {string} bookName
 * @param {object[]} entries
 * @returns {Array<{entry: object, uid: string, points: Array<{id: string, hash: number, text: string, uid: string, partNumber: number}>}>}
 */
export function entriesWithPoints(bookName, entries) {
    const collectionId = bookCollectionIdOf(bookName);
    return entries.map(entry => ({ entry, uid: String(entry.uid), points: pointsOf(collectionId, entry) }));
}

/**
 * What this session read of the books' points in the collection LoreBase reads now (loreBaseVectorsCollection): every
 * reader of the session's points goes through here, so flipping "One shared collection" reads the other collection's.
 * @param {object} settings - VectFox settings
 * @returns {Map<string, Map<number, {uid: string, modelKey: string}>>} book name -> hash -> point, kept for the session
 */
function storedPointsHere(settings) {
    const collection = loreBaseVectorsCollection(settings);
    if (!storedVectors.has(collection)) storedVectors.set(collection, new Map());
    return storedVectors.get(collection);
}

/** Forget what this session read of a book's points in every collection, so the next read finds what is there. */
function forgetStoredPoints(bookName) {
    for (const books of storedVectors.values()) books.delete(bookName);
}

/**
 * Read what Qdrant holds for the named books now, in the collection LoreBase reads now, and keep it for this session.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, Map<number, {uid: string, modelKey: string}>>>}
 * @throws {Error} When Similharity cannot list a book's points
 */
export async function readBookVectors(bookNames, settings) {
    const requestSettings = vectorSettings(settings);
    const listed = await Promise.all(bookNames.map(bookName => listChunks(bookCollectionIdOf(bookName), requestSettings, { limit: ALL_POINTS })));
    const held = storedPointsHere(settings);
    bookNames.forEach((bookName, index) => held.set(bookName, storedPointsOf(listed[index]?.items)));
    return new Map(bookNames.map(bookName => [bookName, held.get(bookName)]));
}

/**
 * What Qdrant holds for the named books, in the collection LoreBase reads now, read from Qdrant only for those this
 * session has not read there yet.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, Map<number, {uid: string, modelKey: string}>>>}
 * @throws {Error} When Similharity cannot list a book's points
 */
export async function bookVectors(bookNames, settings) {
    const unread = bookNames.filter(bookName => !storedPointsHere(settings).has(bookName));
    if (unread.length) await readBookVectors(unread, settings);
    const held = storedPointsHere(settings);
    return new Map(bookNames.map(bookName => [bookName, held.get(bookName)]));
}


/**
 * Where an entry's vectors stand, as this session knows them (§7.3): being written; ready, every part stored by the
 * embedding model set now; failed, with the reason; made by another embedding model; missing; or unknown while this
 * session has not read the book's vectors.
 * @param {string} bookName
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @param {object} settings - VectFox settings
 * @returns {{status: 'writing'}|{status: 'ready'}|{status: 'failed', detail: string}|{status: 'other-model'}|
 *   {status: 'missing'}|{status: 'unknown'}}
 */
export function vectorStateOf(bookName, entry, settings) {
    const state = writeStates.get(bookName)?.get(String(entry.uid));
    if (state?.status === 'writing') return state;
    const stored = storedPointsHere(settings).get(bookName);
    if (!stored) return { status: 'unknown' };
    if (hasStoredCurrentVectors(bookName, entry, settings)) return { status: 'ready' };
    if (state) return state;
    return { status: hasOtherModelVectors(pointsOf(bookCollectionIdOf(bookName), entry), stored, currentEmbeddingModelKey(settings)) ? 'other-model' : 'missing' };
}

/**
 * Whether Qdrant holds every part of an entry's vectors from the embedding model set now (hasCurrentVectors), as this
 * session last read or wrote them, while they are written anew too: half of whether it is ready (isEntryReady in
 * lorebase-readiness.js). False for a book whose vectors this session has not read.
 * @param {string} bookName
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @param {object} settings - VectFox settings
 * @returns {boolean}
 */
export function hasStoredCurrentVectors(bookName, entry, settings) {
    const stored = storedPointsHere(settings).get(bookName);
    return Boolean(stored) && hasCurrentVectors(pointsOf(bookCollectionIdOf(bookName), entry), stored, currentEmbeddingModelKey(settings));
}

/**
 * A reply's pool on Fast and Cheap [Jev] (§4.5): the user's last message and the message before it, each cut to its
 * newest tokens within the embedding provider's piece size, embedded in one request, each searched in one request over
 * every book taking part; the entries of the table of contents the searches rank best (searchPool).
 * @param {Array<{bookName: string}>} books - The books taking part
 * @param {Array<{number: number, bookName: string, uid: number}>} contents - Their table of contents
 * @param {Array<{text: string}>} messages - The scene's messages, oldest first, the user's last
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array<{number: number, bookName: string, uid: number}>>} At most POOL_SEATS items of `contents`, in
 *   its order
 * @throws {Error} When the embedding or a search fails
 */
export async function searchReplyPool(books, contents, messages, settings) {
    const pieceTokens = searchPieceTokensOf(settings);
    const texts = searchTextsOf(messages).map(text => newestWithin(text, pieceTokens, searchTokens)).filter(Boolean);
    const collectionIds = books.map(book => bookCollectionIdOf(book.bookName));
    const searches = await searchCollectionsTogether(collectionIds, texts, POOL_SEATS * PARTS_PER_SEAT, vectorSettings(settings));
    return searchPool(searches, contents, POOL_SEATS);
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
        const stored = storedPointsHere(settings).get(bookName);
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
    const states = statesOf(bookName);
    const fail = (entries, detail) => {
        for (const entry of entries) {
            const failure = { title: entryTitle(entry), detail };
            states.set(String(entry.uid), { status: 'failed', detail });
            result.failures.push(failure);
            onEntryDone?.(entry, failure);
        }
        if (entries.length) tellStateListeners(bookName);
    };
    // Written or stopped: the entry's state is what Qdrant holds again.
    const settle = entries => {
        for (const entry of entries) states.delete(String(entry.uid));
        if (entries.length) tellStateListeners(bookName);
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
    const { points, deleteHashes } = bookVectorWork(entriesWithPoints(bookName, decidedEntries), entriesToWrite.map(entry => String(entry.uid)), stored, modelKey);
    const pointsByUid = new Map();
    for (const point of points) pointsByUid.set(point.uid, [...(pointsByUid.get(point.uid) ?? []), point]);
    const writing = entriesToWrite.map(entry => ({ entry, uid: String(entry.uid), points: pointsByUid.get(String(entry.uid)) ?? [] }));
    // An entry whose every point is stored already has nothing to write.
    const unchanged = writing.filter(item => !item.points.length).map(item => item.entry);
    for (const entry of unchanged) {
        result.written += 1;
        onEntryDone?.(entry, null);
    }
    settle(unchanged);
    const toSend = writing.filter(item => item.points.length);
    for (const { uid } of toSend) states.set(uid, { status: 'writing' });
    if (toSend.length) tellStateListeners(bookName);
    const collectionId = bookCollectionIdOf(bookName);
    const requestSettings = vectorSettings(settings);
    // A wrong embedding setup fails every batch the same way: once met, here or earlier in the run, no batch is sent.
    let setupProblem = run?.vectorProblem ?? null;
    for (const batch of pointBatches(toSend, settings.insert_batch_size || DEFAULT_BATCH_SIZE)) {
        const entries = batch.map(item => item.entry);
        if (run?.isStopped) {
            result.stopped += entries.length;
            settle(entries);
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
            settle(entries);
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
        const { deleteHashes } = bookVectorWork(entriesWithPoints(bookName, decidedEntries), [], stored, currentEmbeddingModelKey(settings));
        await deleteStoredPoints(bookName, deleteHashes, settings);
    } catch (error) {
        log.warn(`LoreBase: the vectors of lorebook "${bookName}" that no selected entry holds could not be read, so none were deleted:`, error);
    }
}

/**
 * Every point of one book tenant in one Qdrant collection, its dense vector included, for its vectors file: the
 * tenant LoreBase reads now, or one left in the other place. Qdrant gives a collection with a sparse vector its dense
 * one under the empty name; it is taken from there.
 * @param {string} tenant - The tenant's ID, as Similharity's listing names it
 * @param {string} collection - The Qdrant collection holding it
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array<{hash: number, text: string, vector: number[]|null, metadata: object}>>}
 * @throws {Error} When Similharity cannot list them
 */
export async function readTenantPoints(tenant, collection, settings) {
    const listed = await listChunks(tenant, settingsInCollection(settings, collection), { limit: ALL_POINTS, includeVectors: true });
    return (listed?.items ?? []).map(item => {
        const vector = Array.isArray(item.vector) ? item.vector : item.vector?.[''] ?? null;
        return { hash: item.hash, text: item.text ?? '', vector: Array.isArray(vector) ? vector : null, metadata: item.metadata ?? {} };
    });
}

/**
 * What the Database Browser's View chunks reads for a book tenant (§3.2 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): the tenant as a lorebook's collection, and the settings that read it in the
 * Qdrant collection holding it, whichever that is.
 * @param {{tenant: string, collection: string, book: string|null, pointCount: number, embeddingSource: string,
 *   embeddingModel: string}} row - A Vectors row holding points, from loreBaseStorageRows
 * @param {object} settings - VectFox settings
 * @returns {{collection: object, settings: object}} What the Chunk Visualizer opens, and the settings it reads with
 */
export function tenantChunkSource(row, settings) {
    return {
        collection: {
            id: row.tenant,
            name: row.book ?? row.tenant,
            type: 'lorebook',
            backend: 'qdrant',
            source: row.embeddingSource,
            model: row.embeddingModel,
            chunkCount: row.pointCount,
        },
        settings: { ...settingsInCollection(settings, row.collection), vector_backend: 'qdrant' },
    };
}

/**
 * Store the points a vectors file holds for some of a book's parts with the file's vectors, through the vector API as
 * Generate vectors stores them, each with its ID for this book and account, its entry and part; Similharity embeds
 * nothing for a point that brings its vector. The file's embedding model is the one set now (planVectorsImport), so
 * this session keeps them as that model's. When a batch fails, the batches before it stay, and this session reads the
 * book again next time.
 * @param {string} bookName
 * @param {Array<{point: {id: string, hash: number, text: string, uid: string, partNumber: number}, vector: number[]}>} writes
 * @param {object} settings - VectFox settings
 * @param {(done: number, total: number) => void} [onProgress] - After each batch
 * @returns {Promise<void>}
 * @throws {Error} When Similharity cannot store them
 */
export async function importBookPoints(bookName, writes, settings, onProgress) {
    const items = writes.map(({ point, vector }) => ({ ...pointItem(bookName, point), vector }));
    try {
        await insertVectorItems(bookCollectionIdOf(bookName), items, vectorSettings(settings), onProgress);
    } catch (error) {
        forgetStoredPoints(bookName);
        throw error;
    }
    const stored = (await bookVectors([bookName], settings)).get(bookName);
    const modelKey = currentEmbeddingModelKey(settings);
    for (const { point } of writes) stored.set(point.hash, { uid: point.uid, modelKey });
    log.lifecycle(`LoreBase: stored ${writes.length} points of lorebook "${bookName}" from a vectors file`);
}

/**
 * Delete every point of one book tenant in one Qdrant collection, and forget what this session read of the books, so
 * the next read finds what is left: the one delete of a tenant, which Remove from LoreBase, a Database Browser row's
 * delete and Delete all run.
 * @param {string} tenant - The tenant's ID, as Similharity's listing names it
 * @param {string} collection - The Qdrant collection holding it
 * @param {object} settings - VectFox settings
 * @returns {Promise<void>}
 * @throws {Error} When Similharity cannot delete them
 */
export async function deleteTenantPoints(tenant, collection, settings) {
    const isDeleted = await purgeVectorIndex(tenant, settingsInCollection(settings, collection));
    if (!isDeleted) throw new Error(`Similharity could not delete the vectors of ${tenant} in ${collection}. The console says why.`);
    storedVectors.clear();
    log.lifecycle(`LoreBase: deleted the vectors of ${tenant} in ${collection}`);
}

/**
 * Forget what this session read of one book's vectors, and its entries whose writing failed, telling the vector
 * listeners: Remove from LoreBase deleted the book's vectors (removeLoreBook in lorebase-storage.js), so the next read
 * finds what is left.
 * @param {string} bookName
 */
export function forgetBookVectors(bookName) {
    forgetStoredPoints(bookName);
    if (writeStates.delete(bookName)) tellStateListeners(bookName);
}

/**
 * Forget every book's entries whose writing failed, telling the vector listeners: Delete all deleted every vector
 * (deleteStored in lorebase-storage.js), so no failure stands for vectors that are gone.
 */
export function forgetVectorWriteFailures() {
    const bookNames = [...writeStates.keys()];
    writeStates.clear();
    for (const bookName of bookNames) tellStateListeners(bookName);
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
        const uids = new Set(uidsWithStoredVectors(entriesWithPoints(bookName, decidedEntries), stored));
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
