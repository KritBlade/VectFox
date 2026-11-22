/**
 * LoreBase's vectors (§4.1 to §4.5 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the IDs that keep a
 * SillyTavern account's books apart inside one Qdrant collection (Q6), one point for each part of each selected entry,
 * which entries have their vectors from the embedding model set now, what brings a book's vectors in line with its
 * selection, and a reply's search: its two texts, and the pool of entries Jev is asked about from the searches' points.
 * Pure: no SillyTavern, no network.
 */
import { COLLECTION_PREFIXES, sanitizeNameSegment } from '../../shared/collection-ids.js';
import { cyrb53, tenantPointId } from '../../shared/point-ids.js';
import { entryPassages } from './lorebase-splitter.js';

// A book's collection ID keeps at most this many characters of its name, for people reading it; the hash tells apart
// names that clean to the same text.
const ID_NAME_LENGTH = 30;
// The field separator inside a hashed key and a model key: no title, text or model name holds it.
const SEPARATOR = '\u001f';

/** Each search returns this many parts for each of the pool's seats (POOL_SEATS in lorebase-jev-core.js), so that as
 * many different entries are among them, as the trials searched (PARTS_PER_PICK in segment_trials.py). */
export const PARTS_PER_SEAT = 4;
// How much of a text over the size a cut keeps each time it tries again, the tokens of its characters being uneven.
const SHORTEN_BY = 0.9;

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
        // A UUID from the book's collection ID and the hash, so two books' points never meet inside one Qdrant
        // collection, and a point written again by another embedding model replaces the old one.
        return { id: tenantPointId(bookCollectionId, hash), hash, text, uid: String(entry.uid), partNumber: passage.passageIndex + 1 };
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
    return points.every(point => isPointCurrent(point, stored, modelKey));
}

/**
 * Whether one point is stored, made by the embedding model set now: what hasCurrentVectors asks of every part, and
 * what bookVectorWork writes again when not.
 * @param {{hash: number}} point - From entryPoints
 * @param {Map<number, {modelKey: string}>} stored - From storedPointsOf
 * @param {string} modelKey - The embedding model set now (embeddingModelKey)
 * @returns {boolean}
 */
export function isPointCurrent(point, stored, modelKey) {
    return stored.get(point.hash)?.modelKey === modelKey;
}

/**
 * Whether an entry holds a part whose vectors another embedding model made: the part's text unchanged, so its point
 * is stored, but by a model other than the one set now, as after the user switches embedding models (§7.1).
 * @param {Array<{hash: number}>} points - From entryPoints
 * @param {Map<number, {modelKey: string}>} stored - From storedPointsOf
 * @param {string} modelKey - The embedding model set now (embeddingModelKey)
 * @returns {boolean}
 */
export function hasOtherModelVectors(points, stored, modelKey) {
    return points.some(point => stored.has(point.hash) && stored.get(point.hash).modelKey !== modelKey);
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
        .flatMap(entry => entry.points.filter(point => !isPointCurrent(point, stored, modelKey)));
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
 * A reply's two search texts (§4.5), as EventBase's two channels read the chat: the user's last message, then the
 * message before it, the reply it answers, as the scene's messages hold them. A scene of one message has one search.
 * @param {Array<{text: string}>} messages - The scene's messages, oldest first, the user's last (sceneMessages)
 * @returns {string[]}
 */
export function searchTextsOf(messages) {
    return messages.slice(-2).reverse().map(message => message.text);
}

/**
 * A search text's newest part within a size (§4.5): the text whole when it fits, else its end, as the trials cut it
 * (newest_tokens in segment_trials.py): the share of its characters the size allows, shortened again while it still
 * measures over the size.
 * @param {string} text
 * @param {number} limit - The size, in the tokens countTokens counts; Infinity keeps every text whole
 * @param {(text: string) => number} countTokens
 * @returns {string}
 */
export function newestWithin(text, limit, countTokens) {
    const trimmed = String(text ?? '').trim();
    const tokens = countTokens(trimmed);
    if (tokens <= limit) return trimmed;
    const characters = Array.from(trimmed);
    let keep = Math.floor(characters.length * limit / tokens);
    let newest = characters.slice(characters.length - keep).join('');
    while (keep > 0 && countTokens(newest) > limit) {
        keep = Math.floor(keep * SHORTEN_BY);
        newest = characters.slice(characters.length - keep).join('');
    }
    return newest.trim();
}

/**
 * The pool Jev is asked about (§4.5): each entry of the table of contents keeps its best part's score of either
 * search, and the `seats` best are kept, a tie going to the earlier search, then to the table's order, the pool coming
 * back in the table's order, as the trials asked it (rank_entries and arm_pool in segment_trials.py). A point counts
 * only for an entry the table holds, by the book and entry its payload names, so the parts of an entry LoreBase does
 * not decide in its book now, which a vectors import can leave until the book's next write, count for nothing.
 * @param {Array<Array<{score: number, metadata?: {lorebookName?: string, entryUid?: string|number}}>>} searches - Each
 *   search's points, best first, as searchCollectionsTogether returns them
 * @param {Array<{number: number, bookName: string, uid: number|string}>} contents - From tableOfContents
 * @param {number} seats
 * @returns {Array<{number: number, bookName: string, uid: number|string}>} Items of `contents`
 */
export function searchPool(searches, contents, seats) {
    const itemOf = new Map(contents.map(item => [`${item.bookName}${SEPARATOR}${item.uid}`, item]));
    const best = new Map();
    searches.forEach((points, searchIndex) => {
        for (const point of points) {
            const item = itemOf.get(`${point.metadata?.lorebookName}${SEPARATOR}${point.metadata?.entryUid}`);
            if (!item || !Number.isFinite(point.score)) continue;
            const known = best.get(item);
            if (!known || point.score > known.score) best.set(item, { score: point.score, searchIndex });
        }
    });
    const ranked = [...best].sort(([itemA, a], [itemB, b]) => b.score - a.score || a.searchIndex - b.searchIndex || itemA.number - itemB.number);
    return ranked.slice(0, seats).map(([item]) => item).sort((a, b) => a.number - b.number);
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
