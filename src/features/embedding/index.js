// features/embedding — embedding providers: the provider registry and its settings fields, query embedding, the
// slow-embedding warning, and the WebLLM provider.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { describeEmbeddingTimeoutCause, warnIfEmbeddingSlow } from './embedding-latency-warning.js';
export {
    getModelField,
    getModelFromSettings,
    getProviderConfig,
    getSecretKey,
    isValidProvider,
    requiresApiKey,
    requiresUrl,
    resolveProviderApiUrl,
} from './providers.js';
export { fetchQueryEmbedding } from './query-embedding.js';
export { getWebLlmProvider } from './webllm-provider.js';
