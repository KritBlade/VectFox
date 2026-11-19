/**
 * LoreBase's books as Qdrant holds them, for one SillyTavern account (§3.5 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md): how many entries of each book have keys (lorebase-keys.js), and each of the
 * account's book tenants, in the account's own LoreBase collection and in vectfox_main alike, with its point count,
 * the book its points name and the embedding source and model one of them was stored with. VectFox's Database Browser
 * draws a Keys row and a Vectors row from them.
 *
 * The account's names are built from its handle as VectFox builds them (accountSegment in src/features/lorebase/
 * lorebase-vectors-core.js): the account's segment never holds an underscore, so the tenant prefix
 * vf_lorebase_qdrant_<account>_ holds this account's books alone. Discovery's collection listing (describeCollections)
 * stays as it is, so a VectFox that knows nothing of LoreBase sees no more than before.
 */

import { MULTITENANCY_COLLECTION, TENANT_FIELD } from './qdrant-backend.js';
import { countLoreKeysByBook } from './lorebase-keys.js';

const LOREBASE_PREFIX = 'vf_lorebase_';
// What one point of a book tenant is read for.
const SAMPLED_FIELDS = ['lorebookName', 'embeddingSource', 'embeddingModel'];

/**
 * An account's handle as VectFox writes it into LoreBase's IDs: lower case, each run of characters outside a to z, 0 to
 * 9 and the hyphen turned into one hyphen, so it never holds an underscore.
 * @param {string} handle - The SillyTavern user's handle
 * @returns {string}
 * @throws {RangeError} When the handle is not a name
 */
export function loreBaseAccountSegment(handle) {
    if (typeof handle !== 'string' || !handle.trim()) throw new RangeError('The user must be a name.');
    return handle.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

/**
 * The Qdrant collection holding an account's LoreBase vectors while VectFox's "One shared collection" is off:
 * vf_lorebase_<account>. With it on, they live in vectfox_main.
 * @param {string} handle - The SillyTavern user's handle
 * @returns {string}
 */
export function loreBaseAccountCollection(handle) {
    return `${LOREBASE_PREFIX}${loreBaseAccountSegment(handle)}`;
}

/**
 * The start of each of the account's book tenants, in its own collection and in vectfox_main alike.
 * @param {string} handle - The SillyTavern user's handle
 * @returns {string}
 */
export function loreBaseTenantPrefix(handle) {
    return `${LOREBASE_PREFIX}qdrant_${loreBaseAccountSegment(handle)}_`;
}

/**
 * The account's book tenants in one Qdrant collection, each with its point count, the book its points name and the
 * embedding source and model one of them was stored with. A collection that does not exist holds none.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} collectionName
 * @param {string} prefix - loreBaseTenantPrefix
 * @param {Set<string>} existing - The names of the Qdrant collections there are
 * @returns {Promise<Array<{collection: string, tenant: string, book: string|null, pointCount: number,
 *   embeddingSource: string, embeddingModel: string}>>}
 */
async function bookTenantsIn(backend, collectionName, prefix, existing) {
    if (!existing.has(collectionName)) return [];
    const tenants = (await backend.listTenants(collectionName)).filter(({ tenant }) => tenant.startsWith(prefix));
    const described = [];
    for (const { tenant, count } of tenants) {
        const sample = await backend.samplePayload(collectionName, { [TENANT_FIELD]: tenant }, SAMPLED_FIELDS);
        described.push({
            collection: collectionName,
            tenant,
            book: typeof sample?.lorebookName === 'string' ? sample.lorebookName : null,
            pointCount: count,
            embeddingSource: sample?.embeddingSource || 'unknown',
            embeddingModel: sample?.embeddingModel || '',
        });
    }
    return described;
}

/**
 * One account's LoreBase books as Qdrant holds them: how many entries of each book have keys, and each book tenant in
 * the account's own LoreBase collection, then in vectfox_main. A tenant's book is the `lorebookName` its points carry,
 * null when the point read names none, so a renamed book's vectors are listed under its old name.
 * @param {object} backend - The Qdrant backend, initialized
 * @param {string} handle - The SillyTavern user's handle
 * @returns {Promise<{keys: Array<{book: string, entryCount: number}>, vectors: Array<{collection: string, tenant: string,
 *   book: string|null, pointCount: number, embeddingSource: string, embeddingModel: string}>}>}
 * @throws {RangeError} When the handle is not a name; {Error} when Qdrant is not set up, cannot be read, or holds more
 *   books or tenants than one count lists
 */
export async function listLoreBooks(backend, handle) {
    const prefix = loreBaseTenantPrefix(handle);
    const keys = await countLoreKeysByBook(backend, handle);
    const listed = await backend._request('GET', '/collections');
    const existing = new Set((listed?.result?.collections ?? []).map(collection => collection.name));
    const vectors = [
        ...await bookTenantsIn(backend, loreBaseAccountCollection(handle), prefix, existing),
        ...await bookTenantsIn(backend, MULTITENANCY_COLLECTION, prefix, existing),
    ];
    return { keys, vectors };
}
