/**
 * LoreBase's keys: the keys VectFox's LoreBase has its model write for each lorebook entry the user turns on, kept in
 * Qdrant (plan D15 and D17 of lorebook-semantic-overhaul-passage-index.md). One collection with no vectors holds a
 * point per entry: the SillyTavern user who owns the book (the indexed tenant), the book's name, the entry's uid and
 * its keys, an empty list when the model found nothing in the entry to key. Each user reads, writes and deletes only
 * their own points, as two users may hold books of the same name.
 */

import crypto from 'node:crypto';
import { LOREBASE_KEYS_COLLECTION } from './qdrant-backend.js';

const USER_FIELD = 'user';
const BOOK_FIELD = 'book';
// Qdrant takes this many points in one upsert comfortably, and a book of 313 entries goes in two.
const POINTS_PER_WRITE = 256;
const POINTS_PER_READ = 1000;
// Limits on what one write may hold, so a request cannot fill Qdrant with junk.
const MOST_ENTRIES_PER_WRITE = 2000;
const MOST_KEYS_PER_ENTRY = 200;
const LONGEST_KEY = 300;
const LONGEST_NAME = 500;

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
 * The entries of a write, checked: each with a uid and a list of up to 200 keys, every key a short string; an empty
 * list is an entry the model found nothing in to key.
 * @param {unknown} entries
 * @returns {Array<{uid: string, keys: string[]}>}
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
        return { uid, keys };
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
 * Write the keys of some of a book's entries, replacing any they had.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @param {string} book - The book's exact name
 * @param {unknown} entries - [{uid, keys: string[]}]
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
        const points = checked.slice(start, start + POINTS_PER_WRITE).map(({ uid, keys }) => ({
            id: keysPointId(user, book, uid),
            vector: {},
            payload: { [USER_FIELD]: user, [BOOK_FIELD]: book, uid, keys, written_at: writtenAt },
        }));
        await backend._request('PUT', `/collections/${LOREBASE_KEYS_COLLECTION}/points?wait=true`, { points });
    }
    return checked.length;
}

/**
 * The keys of every entry of the named books that has them, for one user.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @param {unknown} books - The books' exact names
 * @returns {Promise<Record<string, Record<string, string[]>>>} {book: {uid: keys}}, every named book present
 * @throws {RangeError} When books is not a list of names; {Error} when Qdrant cannot be read
 */
export async function readLoreKeys(backend, user, books) {
    assertName(user, 'The user');
    if (!Array.isArray(books) || books.length > MOST_ENTRIES_PER_WRITE) throw new RangeError('books must be a list of book names.');
    books.forEach(book => assertName(book, 'A book'));
    const found = Object.fromEntries(books.map(book => [book, {}]));
    if (!books.length) return found;
    await ensureKeysCollection(backend);
    const filter = { must: [{ key: USER_FIELD, match: { value: user } }, { key: BOOK_FIELD, match: { any: books } }] };
    let offset = null;
    do {
        const response = await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/scroll`, {
            filter, limit: POINTS_PER_READ, with_payload: { include: [BOOK_FIELD, 'uid', 'keys'] }, with_vector: false,
            ...(offset === null ? {} : { offset }),
        });
        for (const point of response?.result?.points ?? []) {
            const { book, uid, keys } = point.payload ?? {};
            if (Object.hasOwn(found, book) && Array.isArray(keys)) found[book][String(uid)] = keys;
        }
        offset = response?.result?.next_page_offset ?? null;
    } while (offset !== null);
    return found;
}

/**
 * Delete the keys of every entry, in every book, for one user: LoreBase's Delete all keys. Other users' points stay.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} user - The SillyTavern user's handle
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {RangeError} When the user is not a name; {Error} when Qdrant refuses it
 */
export async function deleteLoreKeys(backend, user) {
    assertName(user, 'The user');
    await ensureKeysCollection(backend);
    const filter = { must: [{ key: USER_FIELD, match: { value: user } }] };
    const counted = await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/count`, { filter, exact: true });
    await backend._request('POST', `/collections/${LOREBASE_KEYS_COLLECTION}/points/delete?wait=true`, { filter });
    return counted?.result?.count ?? 0;
}
