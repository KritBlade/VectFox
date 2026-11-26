/**
 * LoreBase's keys: the keys VectFox's LoreBase has its model write for each lorebook entry the user turns on, kept in
 * Qdrant (plan D15 and D17 of lorebook-semantic-overhaul-passage-index.md). One collection with no vectors holds a
 * point per entry: the SillyTavern user who owns the book (the indexed tenant), the book's name, the entry's uid, its
 * title when the write gave one (D11 of vectfox-multi-collection-per-chat.md), and its keys, an empty list when the
 * model found nothing in the entry to key. Each user reads, writes, counts and deletes only their own points, as two
 * users may hold books of the same name.
 */

import crypto from 'node:crypto';
import { LOREBASE_KEYS_COLLECTION } from './qdrant-backend.js';

const USER_FIELD = 'user';
const BOOK_FIELD = 'book';
// Qdrant takes this many points in one upsert comfortably, and a book of 313 entries goes in two.
const POINTS_PER_WRITE = 256;
const POINTS_PER_READ = 1000;
// Limits on what one request may hold, so it cannot fill Qdrant with junk.
const MOST_ENTRIES_PER_WRITE = 2000;
const MOST_KEYS_PER_ENTRY = 200;
const LONGEST_KEY = 300;
const LONGEST_NAME = 500;
// An entry's title is SillyTavern's Title/Memo field, which some books fill with a sentence or two.
const LONGEST_TITLE = 2000;
const MOST_BOOKS_PER_REQUEST = 2000;
// The most books one count lists. A facet answer this long may be cut, so the count refuses rather than miss some.
const MOST_BOOKS_COUNTED = 10000;

/**
 * The point ID of one entry's keys: a UUID from the user, the book and the uid, so writing an entry's keys again
 * replaces its point.
 * @param {string} user
 * @param {string} book
 * @param {string} uid
 * @returns {string}
 */
export function keysPointId(user, book, uid) {
    const hex = crypto.createHash('sha256').update(`${user}\u0000${book}\u0000${uid}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function assertName(value, what) {
    if (typeof value !== 'string' || !value.trim() || value.length > LONGEST_NAME) {
        throw new RangeError(`${what} must be a name of 1 to ${LONGEST_NAME} characters.`);
    }
}

/**
 * The entries of a write, checked: each with a uid, a list of up to 200 keys, every key a short string, and its title
 * when the write gives one; an empty list is an entry the model found nothing in to key.
 * @param {unknown} entries
 * @returns {Array<{uid: string, keys: string[], title?: string}>}
 * @throws {RangeError} When the write holds anything else
 */
function checkedEntries(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > MOST_ENTRIES_PER_WRITE) {
        throw new RangeError(`entries must list 1 to ${MOST_ENTRIES_PER_WRITE} entries.`);
    }
    return entries.map(entry => {
        const uid = String(entry?.uid ?? '');
        assertName(uid, 'An entry\'s uid');
        const keys = entry?.keys;
        if (!Array.isArray(keys) || keys.length > MOST_KEYS_PER_ENTRY
            || keys.some(key => typeof key !== 'string' || !key.trim() || key.length > LONGEST_KEY)) {
            throw new RangeError(`Entry ${uid}'s keys must be 0 to ${MOST_KEYS_PER_ENTRY} strings of up to ${LONGEST_KEY} characters.`);
        }
        const title = entry?.title;
        if (title === undefined) return { uid, keys };
        if (typeof title !== 'string' || title.length > LONGEST_TITLE) {
            throw new RangeError(`Entry ${uid}'s title must be a string of up to ${LONGEST_TITLE} characters.`);
        }
        return { uid, keys, title };
    });
}

/**
 * Make the keys collection, with no vectors, and index its tenant and book fields, once per process.
 * @param {object} backend - The Qdrant backend, initialized
 * @returns {Promise<void>}
 */
async function ensureKeysCollection(backend) {
    if (backend._loreKeysCollectionReady) return;
    if (!backend.baseUrl) throw new Error('Qdrant is not set up, and LoreBase keeps its keys in Qdrant.');
    const collections = await backend._request('GET', '/collections');
    if (!collections?.result?.collections?.some(collection => collection.name === LOREBASE_KEYS_COLLECTION)) {
        try {
            await backend._request('PUT', `/collections/${LOREBASE_KEYS_COLLECTION}`, { vectors: {} });
        } catch (error) {
            // EXPECTED: another request made it between the listing and this one.
            if (!error.message?.includes('already exists') && !error.message?.includes('409')) throw error;
        }
    }
    for (const [field, schema] of [[USER_FIELD, { type: 'keyword', is_tenant: true }], [BOOK_FIELD, { type: 'keyword' }]]) {
        try {
            await backend._request('PUT', `/collections/${LOREBASE_KEYS_COLLECTION}/index?wait=true`, { field_name: field, field_schema: schema });
        } catch (error) {
            // EXPECTED: the index was made by an earlier process.
            if (!error.message?.includes('already exists') && !error.message?.includes('409')) throw error;
        }
    }
    backend._loreKeysCollectionReady = true;
}

/**
 * Write the keys of some of a book's entries, each with its title when given, replacing any they had: an entry written
 * with no title keeps none.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @param {string} book - The book's exact name
 * @param {unknown} entries - [{uid, keys: string[], title?: string}]
 * @returns {Promise<number>} How many entries were written
 * @throws {RangeError} When the write is malformed; {Error} when Qdrant refuses it
 */
export async function writeLoreKeys(backend, user, book, entries) {
    assertName(user, 'The user');
    assertName(book, 'The book');
    const checked = checkedEntries(entries);
    await ensureKeysCollection(backend);
    const writtenAt = new Date().toISOString();
    for (let start = 0; start < checked.length; start += POINTS_PER_WRITE) {
        const points = checked.slice(start, start + POINTS_PER_WRITE).map(({ uid, keys, title }) => ({
            id: keysPointId(user, book, uid),
            vector: {},
            payload: { [USER_FIELD]: user, [BOOK_FIELD]: book, uid, keys, ...(title === undefined ? {} : { title }), written_at: writtenAt },
        }));
        await backend._request('PUT', `/collections/${LOREBASE_KEYS_COLLECTION}/points?wait=true`, { points });
    }
    return checked.length;
}

/**
 * The keys of every entry of the named books that has them, and the title stored with each one that has a title, for
 * one user.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @param {unknown} books - The books' exact names
 * @returns {Promise<{books: Record<string, Record<string, string[]>>, titles: Record<string, Record<string, string>>}>}
 *   {book: {uid: keys}} and {book: {uid: title}}, every named book present in each
 * @throws {RangeError} When books is not a list of names; {Error} when Qdrant cannot be read
 */
export async function readLoreKeys(backend, user, books) {
    assertName(user, 'The user');
    if (!Array.isArray(books) || books.length > MOST_BOOKS_PER_REQUEST) throw new RangeError('books must be a list of book names.');
    books.forEach(book => assertName(book, 'A book'));
    const found = { books: Object.fromEntries(books.map(book => [book, {}])), titles: Object.fromEntries(books.map(book => [book, {}])) };
    if (!books.length) return found;
    await ensureKeysCollection(backend);
    const filter = { must: [{ key: USER_FIELD, match: { value: user } }, { key: BOOK_FIELD, match: { any: books } }] };
    let offset = null;
    do {
        const response = await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/scroll`, {
            filter, limit: POINTS_PER_READ, with_payload: { include: [BOOK_FIELD, 'uid', 'keys', 'title'] }, with_vector: false,
            ...(offset === null ? {} : { offset }),
        });
        for (const point of response?.result?.points ?? []) {
            const { book, uid, keys, title } = point.payload ?? {};
            if (!Object.hasOwn(found.books, book) || !Array.isArray(keys)) continue;
            found.books[book][String(uid)] = keys;
            if (typeof title === 'string') found.titles[book][String(uid)] = title;
        }
        offset = response?.result?.next_page_offset ?? null;
    } while (offset !== null);
    return found;
}

/**
 * How many entries of each of one user's books have keys, an empty list included: Qdrant's facet count of the book
 * field inside the user's tenant (Qdrant 1.12+).
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @returns {Promise<Array<{book: string, entryCount: number}>>} As Qdrant lists them, the most entries first
 * @throws {RangeError} When the user is not a name; {Error} when Qdrant cannot count them, or the answer may be cut
 */
export async function countLoreKeysByBook(backend, user) {
    assertName(user, 'The user');
    await ensureKeysCollection(backend);
    const response = await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/facet`, {
        key: BOOK_FIELD,
        filter: { must: [{ key: USER_FIELD, match: { value: user } }] },
        limit: MOST_BOOKS_COUNTED,
        exact: true,
    });
    const hits = response?.result?.hits ?? [];
    if (hits.length >= MOST_BOOKS_COUNTED) {
        throw new Error(`The user has LoreBase keys in at least ${MOST_BOOKS_COUNTED} books, more than one count lists.`);
    }
    return hits.filter(hit => hit.count > 0).map(hit => ({ book: String(hit.value), entryCount: hit.count }));
}

/**
 * Delete one user's keys: those of some entries of one book, those of the named books' entries, or, with no books
 * named, of every entry in every book (LoreBase's Delete all). Other users' points stay. VectFox's LoreBase deletes
 * the keys of entries a book no longer holds, as SillyTavern gives a new entry the first free uid, a deleted one's.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @param {unknown} [books] - The books' exact names, 1 to 2,000 of them; left out, every book
 * @param {unknown} [uids] - The uids of the entries whose keys go, 1 to 2,000 of them, with books naming their one
 *   book; left out, every entry of the books named
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {RangeError} When the user is not a name, books is given and is not a list of 1 to 2,000 names, or uids is
 *   given and is not a list of 1 to 2,000 uids with books naming one book; {Error} when Qdrant refuses it
 */
export async function deleteLoreKeys(backend, user, books, uids) {
    assertName(user, 'The user');
    if (books !== undefined) {
        if (!Array.isArray(books) || !books.length || books.length > MOST_BOOKS_PER_REQUEST) {
            throw new RangeError(`books must list 1 to ${MOST_BOOKS_PER_REQUEST} book names; leave it out to delete every book's keys.`);
        }
        books.forEach(book => assertName(book, 'A book'));
    }
    if (uids !== undefined) {
        if (books?.length !== 1) throw new RangeError('uids must come with books naming the one book that holds them.');
        if (!Array.isArray(uids) || !uids.length || uids.length > MOST_ENTRIES_PER_WRITE) {
            throw new RangeError(`uids must list 1 to ${MOST_ENTRIES_PER_WRITE} entry uids; leave it out to delete every entry's keys of the book.`);
        }
        uids.forEach(uid => assertName(typeof uid === 'number' ? String(uid) : uid, 'An entry\'s uid'));
    }
    await ensureKeysCollection(backend);
    const must = [{ key: USER_FIELD, match: { value: user } }];
    if (books !== undefined) must.push({ key: BOOK_FIELD, match: { any: books } });
    if (uids !== undefined) must.push({ has_id: uids.map(uid => keysPointId(user, books[0], String(uid))) });
    const filter = { must };
    const counted = await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/count`, { filter, exact: true });
    await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/delete?wait=true`, { filter });
    return counted?.result?.count ?? 0;
}
