/**
 * Where a Qdrant request for one VectFox collection goes. With "One shared collection" off, every collection is a
 * Qdrant collection of its own. With it on, every collection lives in vectfox_main, and each point carries its
 * collection's ID in the tenant field `content_type`, which Similharity indexes as a tenant (its TENANT_FIELD), so every
 * request about a collection's points sends that tenant as a filter. A request's settings can name another shared
 * collection in `qdrant_shared_collection`: LoreBase keeps every book of an account in one Qdrant collection, its own
 * when "One shared collection" is off (features/lorebase/lorebase-vectors.js). Imports only the pure point ID
 * (shared/point-ids.js), so any module can route a request without taking in the Qdrant backend.
 */
import { tenantPointId } from '../../shared/point-ids.js';

// NOTE: `vectfox_main` is kept verbatim for on-disk compatibility
// with existing user Qdrant data. Do not rebrand. See InternalProject/Vectfox/plans/executed/vectfox-rename-plan.md §1.5.
export const MULTITENANCY_COLLECTION = 'vectfox_main';

// The payload field that tells VectFox's collections apart inside vectfox_main.
export const TENANT_FIELD = 'content_type';

// The filter naming several collections of one shared collection, which a hybrid search reads in one request
// (Similharity's TENANTS_ANY_FILTER, 3.4.13 on); no change or delete takes it.
export const TENANTS_ANY_FILTER = `${TENANT_FIELD}_any`;

const KNOWN_BACKENDS = ['standard', 'vectra', 'qdrant'];
const KNOWN_SOURCES = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp', 'vllm', 'koboldcpp', 'webllm', 'openrouter'];

/**
 * Strip a registry key's prefix (backend:collectionId, the older backend:source:collectionId, or source:collectionId)
 * to get the collection ID alone.
 * @param {string} collectionId - A plain ID or a registry key
 * @returns {string} The collection ID
 */
export function stripRegistryPrefix(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') {
        return collectionId;
    }

    const parts = collectionId.split(':');

    // New format: backend:collectionId (2-part, part[0] is a known backend)
    if (parts.length >= 2 && KNOWN_BACKENDS.includes(parts[0]) && !KNOWN_SOURCES.includes(parts[1])) {
        return parts.slice(1).join(':');
    }
    // Old 3-part format: backend:source:collectionId
    if (parts.length >= 3 && KNOWN_BACKENDS.includes(parts[0]) && KNOWN_SOURCES.includes(parts[1])) {
        return parts.slice(2).join(':');
    }
    // Legacy source-only prefix: source:collectionId
    if (parts.length >= 2 && KNOWN_SOURCES.includes(parts[0])) {
        return parts.slice(1).join(':');
    }

    // Already plain collection ID
    return collectionId;
}

/**
 * The Qdrant collection a request about one VectFox collection names, and the filters that keep it to that
 * collection's points: its own collection and no filter, or with "One shared collection" on, the shared collection
 * (vectfox_main, or the one `qdrant_shared_collection` names) and the collection's ID as the tenant.
 * @param {string} collectionId - The collection's ID or registry key
 * @param {object} settings - VectFox settings, or a request's copy of them
 * @returns {{collectionId: string, filters: object}}
 */
export function qdrantTarget(collectionId, settings) {
    const ownId = stripRegistryPrefix(collectionId);
    return settings?.qdrant_multitenancy
        ? { collectionId: settings.qdrant_shared_collection || MULTITENANCY_COLLECTION, filters: { [TENANT_FIELD]: ownId } }
        : { collectionId: ownId, filters: {} };
}

/**
 * The ID a point copied into one VectFox collection is stored under: a fork's copy of its parent's events, or an
 * imported collection's points. A copy keeps its source's hash, and in the shared collection the source's point may be
 * stored under that hash, which the copy would replace, so there it takes an ID of the collection it goes into
 * (tenantPointId). Elsewhere none: in a Qdrant collection of its own, Similharity stores it under its hash, as every
 * other point there, and finds it by that ID.
 * @param {string} collectionId - The collection the copy goes into: its ID or registry key
 * @param {number} hash - The copy's hash
 * @param {object} settings - VectFox settings
 * @returns {string|undefined}
 */
export function copiedPointId(collectionId, hash, settings) {
    if (settings?.vector_backend !== 'qdrant') return undefined;
    const tenant = qdrantTarget(collectionId, settings).filters[TENANT_FIELD];
    return tenant ? tenantPointId(tenant, hash) : undefined;
}
