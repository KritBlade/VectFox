// features/vector-backend — where vectors live: the Standard (Vectra) and Qdrant backends behind one registry,
// the vector API every feature stores and queries through, hybrid and sparse search, corpus statistics for BM25,
// and time-bounded retrieval.
//
// DynamicRateLimiter is exported because eventbase's generation rate limiter builds on it.
// setInsertedCollectionRegistrar lets src/index.js register the collections Qdrant inserts into without this
// feature importing collections.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    getBackend,
    getBackendForCollection,
    getBackendMetrics,
    initializeBackend,
    isBackendAvailable,
    probeBackendHealth,
    resetBackendHealth,
} from './backend-registry.js';
export { runBoundedRetrieval } from './bounded-retrieval.js';
export { clearCorpusStatsCache } from './corpus-stats.js';
export { reciprocalRankFusion, weightedCombination } from './hybrid-search.js';
export { setInsertedCollectionRegistrar } from './qdrant.js';
export { encodeSparseVector } from './sparse-vector-encoder.js';
export {
    DynamicRateLimiter,
    deleteVectorItems,
    getAdditionalArgs,
    getQueryVector,
    getSavedHashes,
    insertVectorItems,
    listChunks,
    purgeVectorIndex,
    queryCollection,
    queryMultipleCollections,
    updateChunkMetadata,
} from './vector-api.js';
