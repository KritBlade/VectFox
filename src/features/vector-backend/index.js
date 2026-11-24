// features/vector-backend — where vectors live: the Standard (Vectra) and Qdrant backends behind one registry,
// the vector API every feature stores and queries through, hybrid and sparse search, corpus statistics for BM25,
// and time-bounded retrieval.
//
// DynamicRateLimiter is exported because eventbase's generation rate limiter builds on it.
// setInsertedCollectionRegistrar lets src/index.js register the collections Qdrant inserts into without this
// feature importing collections, and setPurgedCollectionListener lets it tell the public API of each collection
// purged without this feature importing it. qdrantTarget is where every request about one collection's Qdrant points goes, for
// the features that call Similharity themselves (export, import, the Database Browser, the Chunk Visualizer).
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
export { UNBOUNDED_RUN, runBoundedRetrieval } from './bounded-retrieval.js';
export { clearCorpusStatsCache } from './corpus-stats.js';
export { reciprocalRankFusion, weightedCombination } from './hybrid-search.js';
export { setInsertedCollectionRegistrar } from './qdrant.js';
export { MULTITENANCY_COLLECTION, copiedPointId, qdrantTarget } from './qdrant-target.js';
export { describeEmbeddingFailure } from './embedding-failure.js';
export { encodeSparseVector } from './sparse-vector-encoder.js';
export { textWithKeywordSuffix, textWithoutKeywordSuffix } from './stored-chunk.js';
export {
    DynamicRateLimiter,
    deleteVectorItems,
    getQueryVector,
    getSavedHashes,
    insertVectorItems,
    listChunks,
    purgeVectorIndex,
    queryCollection,
    queryMultipleCollections,
    searchCollectionsTogether,
    setPurgedCollectionListener,
    updateChunkMetadata,
} from './vector-api.js';
