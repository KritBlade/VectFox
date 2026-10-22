/**
 * ============================================================================
 * VECTOR BACKEND INTERFACE
 * ============================================================================
 * Common interface that all vector backends must implement.
 * Keeps backends small, focused, and swappable.
 *
 * @author VectFox
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { log } from '../core/log.js';

/**
 * Base class for all vector backends.
 * All backends must extend this and implement all methods.
 */
export class VectorBackend {
    /**
     * Initialize the backend with settings
     * @param {object} settings - VectFox settings
     */
    async initialize(settings) {
        throw new Error('Backend must implement initialize()');
    }

    /**
     * Check if backend is available/healthy
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        throw new Error('Backend must implement healthCheck()');
    }

    /**
     * Get saved hashes for a collection
     * @param {string} collectionId
     * @param {object} settings
     * @returns {Promise<number[]>}
     */
    async getSavedHashes(collectionId, settings) {
        throw new Error('Backend must implement getSavedHashes()');
    }

    /**
     * Insert vector items into collection
     * @param {string} collectionId
     * @param {object[]} items - {hash, text, index, vector}
     * @param {object} settings
     * @returns {Promise<void>}
     */
    async insertVectorItems(collectionId, items, settings, abortSignal = null) {
        throw new Error('Backend must implement insertVectorItems()');
    }

    /**
     * Delete specific items by hash
     * @param {string} collectionId
     * @param {number[]} hashes
     * @param {object} settings
     * @returns {Promise<void>}
     */
    async deleteVectorItems(collectionId, hashes, settings) {
        throw new Error('Backend must implement deleteVectorItems()');
    }

    /**
     * Embed a query text once, so every request of the query (its routes and
     * fallbacks) reuses the vector instead of re-embedding the text. The default
     * returns null: the backend can only embed per request, server-side.
     * See core/core-vector-api.js getQueryVector.
     * @param {string} searchText
     * @param {object} settings
     * @returns {Promise<number[]|null>}
     */
    async embedQuery(searchText, settings) {
        return null;
    }

    /**
     * Query collection for similar vectors
     * @param {string} collectionId
     * @param {string} searchText
     * @param {number} topK
     * @param {object} settings
     * @param {number[]|null} [queryVector] Pre-computed query embedding; when
     *   provided, query by vector instead of re-embedding searchText
     * @returns {Promise<object[]>}
     */
    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        throw new Error('Backend must implement queryCollection()');
    }

    /**
     * Query multiple collections
     * @param {string[]} collectionIds
     * @param {string} searchText
     * @param {number} topK
     * @param {number} threshold
     * @param {object} settings
     * @param {number[]|null} [queryVector] Optional pre-computed embedding;
     *   when provided, implementations should query by vector instead of
     *   re-embedding searchText. Callers (core-vector-api.js:1071) pass this
     *   on the vector-first retrieval path; null on the text-first path.
     * @returns {Promise<object[]>}
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        throw new Error('Backend must implement queryMultipleCollections()');
    }

    /**
     * Purge entire collection
     * @param {string} collectionId
     * @param {object} settings
     * @returns {Promise<void>}
     */
    async purgeVectorIndex(collectionId, settings) {
        throw new Error('Backend must implement purgeVectorIndex()');
    }

    /**
     * Purge file-based collection
     * @param {string} collectionId
     * @param {object} settings
     * @returns {Promise<void>}
     */
    async purgeFileVectorIndex(collectionId, settings) {
        throw new Error('Backend must implement purgeFileVectorIndex()');
    }

    /**
     * Purge all collections
     * @param {object} settings
     * @returns {Promise<void>}
     */
    async purgeAllVectorIndexes(settings) {
        throw new Error('Backend must implement purgeAllVectorIndexes()');
    }

    /**
     * Check if backend supports a backend-native/server-side hybrid search path.
     * This means the backend can combine dense vector retrieval with an additional
     * lexical/full-text style signal on the backend side, rather than requiring
     * client-side fusion.
     *
     * NOTE: This does not guarantee true dense+sparse-vector hybrid at the
     * database level; some backends may implement server-side keyword/text
     * matching plus plugin-side fusion instead.
     *
     * Override in backends that support native hybrid search (e.g., Qdrant)
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return false;
    }

    /**
     * Perform hybrid search using dense vectors plus a backend-side lexical/text
     * signal. Default implementation falls back to regular vector search.
     * Override in backends with native/server-side hybrid support.
     *
     * NOTE: Depending on backend implementation, the lexical side may be sparse
     * vectors, full-text search, payload keyword matching, or another backend-
     * local retrieval strategy.
     *
     * @param {string} collectionId
     * @param {string} searchText
     * @param {number} topK
     * @param {object} settings - VectFox settings
     * @param {object} hybridOptions - Hybrid search options
     * @param {number} hybridOptions.vectorWeight - Weight for vector scores (0-1)
     * @param {number} hybridOptions.textWeight - Weight for text scores (0-1)
     * @param {string} hybridOptions.fusionMethod - Fusion method ('rrf' or 'weighted')
     * @param {number} hybridOptions.rrfK - RRF constant (default 60)
     * @param {object} [filters] - Payload filters
     * @param {number[]|null} [queryVector] - Pre-computed query embedding
     * @returns {Promise<{hashes: number[], metadata: object[]}>}
     */
    async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}, filters = {}, queryVector = null) {
        // Default: fallback to vector-only search
        log.warn(`VectFox: Backend ${this.constructor.name} does not support native hybrid search, using vector-only`);
        return this.queryCollection(collectionId, searchText, topK, settings, queryVector);
    }
}
