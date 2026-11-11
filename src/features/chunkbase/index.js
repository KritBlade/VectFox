// features/chunkbase — ChunkBase, chunk retrieval: rearrangeChat (which the manifest's generate_interceptor
// calls), chat and content vectorization with the content vectorizer, chunking, and Auto-Reformat.
//
// src/index.js runs synchronizeChat on chat events. The database browser lists and clears Auto-Reformat's
// cached originals (listReformatCacheEntries, clearAllReformatOriginals). The settings panel runs Auto-Reformat's
// Test connection (testAutoReformatConnection).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { clearInterceptorPrompts, rearrangeChat, synchronizeChat } from './chat-vectorization.js';
export { backfillCurrentChatWithProgress, openContentVectorizer, testAutoReformatConnection } from './content-vectorizer.js';
export { clearAllReformatOriginals, listReformatCacheEntries } from './reformat-store.js';
