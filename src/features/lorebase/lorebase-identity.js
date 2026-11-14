/**
 * LoreBase's stable names (plan §5.4): one index per book, per SillyTavern account, backend and embedding model, with
 * no timestamp, so a book is vectorized into the same index every time and two accounts that share a Qdrant never
 * share a book's index. A passage is known by a hash of its entry and its text, and its Qdrant point ID derives from
 * the index and that hash, never from the text alone, so the same text in two books or two entries is two points.
 */

import { COLLECTION_PREFIXES, normalizeBackendForId, sanitizeHandleId, sanitizeNameSegment } from '../../shared/collection-ids.js';

/**
 * cyrb53: a fast 53-bit string hash with good spread (public domain, bryc). 53 bits keep it a whole number JavaScript
 * holds exactly and Qdrant stores as an integer; a book's few thousand passages are far from colliding.
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
 * A book's index ID: vf_lorebase_<backend>_<account>_<name>_<hash of the exact book name>. The name part is for
 * people reading a collection list; the hash tells apart names that clean to the same text.
 * @param {string} bookName - The lorebook's exact name
 * @param {string} backend - The vector backend ('qdrant' or 'standard')
 * @param {string} accountHandle - The SillyTavern account's handle
 * @returns {string}
 */
export function loreBaseIndexId(bookName, backend, accountHandle) {
    const name = sanitizeNameSegment(bookName, 30).replace(/^_+|_+$/g, '') || 'book';
    return `${COLLECTION_PREFIXES.VECTFOX_LOREBASE}${normalizeBackendForId(backend)}_${sanitizeHandleId(accountHandle)}_${name}_${cyrb53(bookName).toString(36)}`;
}

/**
 * A passage's hash: its entry and the text it is embedded as. A changed passage gets a new hash, so sync re-embeds
 * exactly the passages an edit changed.
 * @param {number} entryUid
 * @param {string} embeddingText
 * @returns {number}
 */
export function passageHash(entryUid, embeddingText) {
    return cyrb53(`${entryUid}\u001f${embeddingText}`);
}

/**
 * A passage's Qdrant point ID: a UUID from the index ID and the passage hash.
 * @param {string} indexId
 * @param {number} hash
 * @returns {string}
 */
export function passagePointId(indexId, hash) {
    const key = `${indexId}\u001f${hash}`;
    const hex = [1, 2, 3].map(seed => cyrb53(key, seed).toString(16).padStart(14, '0')).join('').slice(0, 32);
    // Version 8 (custom) and the RFC 4122 variant, so it reads as a UUID everywhere.
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
