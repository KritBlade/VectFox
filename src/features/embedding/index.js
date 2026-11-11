// features/embedding — embedding providers: the provider registry and its settings fields, embedding on a SillyTavern
// connection profile, query embedding, and the slow-embedding warning.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { describeEmbeddingTimeoutCause, warnIfEmbeddingSlow } from './embedding-latency-warning.js';
export { throwIfEmbeddingConfigError } from './embedding-request-failure.js';
export { embeddingProfileKind, refuseSillyTavernEmbeddingRoute } from './embedding-profile-core.js';
export {
    embeddingProfileRequestFields,
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
export { fetchQueryEmbedding } from './query-embedding.js';
