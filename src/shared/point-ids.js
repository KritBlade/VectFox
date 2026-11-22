/**
 * The hash VectFox builds its own point hashes and IDs with, and the ID a point of one VectFox collection is stored
 * under inside a Qdrant collection several share: LoreBase's books (features/lorebase/lorebase-vectors-core.js), and a
 * point copied into the shared collection by a fork or an import (copiedPointId in
 * features/vector-backend/qdrant-target.js). Pure: no host or feature imports.
 */

// The field separator inside a hashed key: no collection ID holds it.
const SEPARATOR = '\u001f';

/**
 * cyrb53: a fast 53-bit string hash with good spread (public domain, bryc). 53 bits keep it a whole number JavaScript
 * holds exactly and Qdrant stores as an integer.
 * @param {string} text
 * @param {number} [seed]
 * @returns {number}
 */
export function cyrb53(text, seed = 0) {
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
 * A point's ID inside a Qdrant collection several VectFox collections share: a UUID from its collection's ID and its
 * hash, so one hash in two collections makes two points, and the point written again replaces itself. Similharity
 * stores a point the client gives no ID under its hash, which another collection's point with that hash shares.
 * @param {string} collectionId - The VectFox collection the point belongs to (its tenant)
 * @param {number} hash
 * @returns {string}
 */
export function tenantPointId(collectionId, hash) {
    const key = `${collectionId}${SEPARATOR}${hash}`;
    const hex = [1, 2, 3].map(seed => cyrb53(key, seed).toString(16).padStart(14, '0')).join('').slice(0, 32);
    // Version 8 (custom) and the RFC 4122 variant, so it reads as a UUID everywhere.
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
