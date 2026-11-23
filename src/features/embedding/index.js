// features/embedding — embedding providers: the provider registry and its settings fields, embedding on a SillyTavern
// connection profile, query embedding, the pieces a long search text is searched in, and the slow-embedding warning.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    describeEmbeddingTimeoutCause,
    embeddingProviderLabel,
    slowEmbeddingWarnMs,
    warnIfEmbeddingSlow,
} from './embedding-latency-warning.js';
export { throwIfEmbeddingConfigError } from './embedding-request-failure.js';
export { embeddingProfileKind, refuseSillyTavernEmbeddingRoute } from './embedding-profile-core.js';
export {
    embeddingModelName,
    embeddingProfileRequestFields,
    embeddingSetupProblem,
    getModelField,
    getModelFromSettings,
    getProviderConfig,
    getSecretKey,
    isValidProvider,
    requiresApiKey,
    requiresUrl,
    resolveEmbeddingProfile,
    resolveProviderApiUrl,
} from './providers.js';
export { fetchQueryEmbedding, fetchQueryEmbeddings } from './query-embedding.js';
export { searchTokens } from './search-pieces-core.js';
export { searchPieceTokensOf, searchPieces } from './search-pieces.js';
