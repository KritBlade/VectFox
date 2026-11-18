/**
 * LoreBase's vectors (§4.1 to §4.4 of InternalProject/Vectfox/plans/lorebook-multi-vector.md): the IDs that keep a
 * SillyTavern account's books apart inside one Qdrant collection (Q6), one point for each part of each selected entry,
 * which entries have their vectors from the embedding model set now, and what brings a book's vectors in line with its
 * selection. Pure: no SillyTavern, no network.
 */
import { COLLECTION_PREFIXES, sanitizeNameSegment } from '../../shared/collection-ids.js';
import { entryPassages } from './lorebase-splitter.js';

// A book's collection ID keeps at most this many characters of its name, for people reading it; the hash tells apart
// names that clean to the same text.
const ID_NAME_LENGTH = 30;
// The field separator inside a hashed key and a model key: no title, text or model name holds it.
const SEPARATOR = '\u001f';

/**
 * cyrb53: a fast 53-bit string hash with good spread (public domain, bryc). 53 bits keep it a whole number JavaScript
 * holds exactly and Qdrant stores as an integer.
 * @param {string} text
 * @param {number} [seed]
 * @returns {number}
 */
function cyrb53(text, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * An account's handle as an ID segment. SillyTavern makes handles of a to z, 0 to 9 and hyphens; anything else becomes
 * a hyphen, so the segment never holds an underscore and a book's ID names its account's collection.
 * @param {string} accountHandle
 * @returns {string}
 */
function accountSegment(accountHandle) {
    return String(accountHandle ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

/**
 * The Qdrant collection holding an account's LoreBase vectors while "One shared collection" is off (Q6):
 * vf_lorebase_<account>. With it on, they live in vectfox_main, as every collection does.
 * @param {string} accountHandle - The SillyTavern account's handle
 * @returns {string}
 */
export function loreBaseAccountCollection(accountHandle) {
    return `${COLLECTION_PREFIXES.VECTFOX_LOREBASE}${accountSegment(accountHandle)}`;
}

/**
 * A book's collection ID, its tenant inside its account's Qdrant collection: vf_lorebase_qdrant_<account>_<name>_<hash
 * of the exact name>, with no timestamp, so a book's vectors are found again every session.
 * @param {string} bookName - The lorebook's exact name
 * @param {string} accountHandle - The SillyTavern account's handle
 * @returns {string}
 */
export function loreBaseBookCollectionId(bookName, accountHandle) {
    const name = sanitizeNameSegment(bookName, ID_NAME_LENGTH).replace(/^_+|_+$/g, '') || 'book';
    return `${COLLECTION_PREFIXES.VECTFOX_LOREBASE}qdrant_${accountSegment(accountHandle)}_${name}_${cyrb53(bookName).toString(36)}`;
}

/**
 * A point's hash: its entry's uid and its text, so the same text in two entries is two points, and an edited part is a
 * new one.
 * @param {string|number} uid
 * @param {string} text
 * @returns {number}
 */
export function pointHash(uid, text) {
    return cyrb53(`${uid}${SEPARATOR}${text}`);
}

/**
 * A point's ID: a UUID from its book's collection ID and its hash, so two books' points never meet inside one Qdrant
 * collection, and a point written again by another embedding model replaces the old one.
 * @param {string} bookCollectionId
 * @param {number} hash
 * @returns {string}
 */
export function pointId(bookCollectionId, hash) {
    const key = `${bookCollectionId}${SEPARATOR}${hash}`;
    const hex = [1, 2, 3].map(seed => cyrb53(key, seed).toString(16).padStart(14, '0')).join('').slice(0, 32);
    // Version 8 (custom) and the RFC 4122 variant, so it reads as a UUID everywhere.
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The embedding model a point was made by, as one key: its source and model.
 * @param {string} source
 * @param {string} model
 * @returns {string}
 */
export function embeddingModelKey(source, model) {
    return `${source || ''}${SEPARATOR}${model || ''}`;
}

/**
 * An entry's points (§4.1): one for each part the splitter cuts, its entry's title on the line before the part's text,
 * as T26 to T30 searched them (`vector_points` in segment_trials.py).
 * @param {{uid: number|string, comment?: string, content?: string}} entry - The book's entry, as loadWorldInfo returns it
 * @param {string} bookCollectionId
 * @returns {Array<{id: string, hash: number, text: string, uid: string, partNumber: number}>}
 */
export function entryPoints(entry, bookCollectionId) {
    const { title, passages } = entryPassages(entry);
    return passages.filter(passage => passage.text).map(passage => {
        const text = `${title}\n${passage.text}`;
        const hash = pointHash(entry.uid, text);
        return { id: pointId(bookCollectionId, hash), hash, text, uid: String(entry.uid), partNumber: passage.passageIndex + 1 };
    });
}

/**
 * What Qdrant holds for a book, by hash, from its points as Similharity lists them: each point's entry and the model
 * that made it. A point with no hash is left out: it is no point of LoreBase's.
 * @param {Array<{hash?: number|string, metadata?: object}>} items - From the vector API's listChunks
 * @returns {Map<number, {uid: string, modelKey: string}>}
 */
export function storedPointsOf(items) {
    const stored = new Map();
    for (const item of items ?? []) {
        const hash = Number(item?.hash);
        if (!Number.isSafeInteger(hash) || hash < 0) continue;
        const payload = item.metadata ?? {};
        stored.set(hash, { uid: String(payload.entryUid ?? ''), modelKey: embeddingModelKey(payload.embeddingSource, payload.embeddingModel) });
    }
    return stored;
}

/**
 * Whether an entry has its vectors: every one of its points stored, made by the embedding model set now (§4.4). An
 * entry the splitter cuts into no part has none to write, so it never waits for them.
 * @param {Array<{hash: number}>} points - From entryPoints
 * @param {Map<number, {modelKey: string}>} stored - From storedPointsOf
 * @param {string} modelKey - The embedding model set now (embeddingModelKey)
 * @returns {boolean}
 */
export function hasCurrentVectors(points, stored, modelKey) {
    return points.every(point => stored.get(point.hash)?.modelKey === modelKey);
}

/**
 * What brings a book's vectors in line with its selection (§4.3): of the entries to write, each point not stored by
 * the embedding model set now; and the stored points to delete, each part an entry LoreBase decides no longer has, and
 * every point of an entry it no longer decides (unselected, deleted, or one it cannot decide).
 * @param {Array<{uid: string, points: object[]}>} decided - Every entry LoreBase decides in the book, with its points
 * @param {Iterable<string>} uidsToWrite - The entries whose vectors to write
 * @param {Map<number, {uid: string, modelKey: string}>} stored - What Qdrant holds for the book
 * @param {string} modelKey - The embedding model set now
 * @returns {{points: object[], deleteHashes: number[]}}
 */
export function bookVectorWork(decided, uidsToWrite, stored, modelKey) {
    const writing = new Set([...uidsToWrite].map(String));
    const currentHashes = new Set(decided.flatMap(entry => entry.points.map(point => point.hash)));
    const points = decided
        .filter(entry => writing.has(String(entry.uid)))
        .flatMap(entry => entry.points.filter(point => stored.get(point.hash)?.modelKey !== modelKey));
    const deleteHashes = [...stored.keys()].filter(hash => !currentHashes.has(hash));
    return { points, deleteHashes };
}

/**
 * The entries an edit SillyTavern saved should have written again in the background (§4.3): those LoreBase decides
 * that had vectors before, any of their points stored. One never written waits for the question that writes it.
 * @param {Array<{uid: string, points: object[]}>} decided
 * @param {Map<number, {uid: string}>} stored
 * @returns {string[]}
 */
export function uidsWithStoredVectors(decided, stored) {
    const storedUids = new Set([...stored.values()].map(point => point.uid));
    return decided.map(entry => String(entry.uid)).filter(uid => storedUids.has(uid));
}

/**
 * Insert batches of whole entries, each of at most `size` points, so an entry's points are written together and its
 * batch says when it is done. An entry of more points than `size` is a batch of its own.
 * @param {Array<{uid: string, points: object[]}>} entries - Each with the points it writes
 * @param {number} size
 * @returns {Array<Array<{uid: string, points: object[]}>>}
 */
export function pointBatches(entries, size) {
    const batches = [];
    let batch = [];
    let pointCount = 0;
    for (const entry of entries) {
        if (batch.length && pointCount + entry.points.length > size) {
            batches.push(batch);
            batch = [];
            pointCount = 0;
        }
        batch.push(entry);
        pointCount += entry.points.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
}
