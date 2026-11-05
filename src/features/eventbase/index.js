// features/eventbase — EventBase, the event memory: extraction from chat windows, the event store, retrieval
// and injection, AgentMode retrieval, forking an EventBase onto a branch, and the summarizer injection.
//
// chunkbase imports this feature dynamically: its generation interceptor runs EventBase retrieval and the
// summarizer injection, and its content vectorizer runs ingestion. src/index.js hands
// clearCachesForDeletedOrImportedCollection to collection deletion and import; src/app/ runs
// ensureEventBaseIndexes and pruneOrphanedEventBaseChatMaps at startup.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { findEventBaseForkSource, forkEventBaseFromSource } from './eventbase-fork.js';
export { packTimelineSortKey } from './eventbase-schema.js';
export {
    FAR_BEHIND_WINDOW_COUNT,
    checkWindowSizeChanged,
    clearAutoSyncMarker,
    clearCachesForDeletedOrImportedCollection,
    countWindowsBehind,
    ensureEventBaseIndexes,
    findEventBaseCollectionsForChat,
    getVectorizationTip,
    pauseAutoSyncForChat,
    prepareForFreshExtraction,
    pruneOrphanedEventBaseChatMaps,
    resolveEventBaseWriteTarget,
    setLastUsedWindowSize,
    stampAutoSyncMarker,
} from './eventbase-store.js';
export {
    countUnfinishedWindows,
    getAutoSyncWindowSize,
    getChatAutoSyncStatus,
    notifyUnfinishedWindows,
    runEventBaseIngestion,
    runEventBaseRetrieval,
} from './eventbase-workflow.js';
export { getEventBaseExtractionPrompt } from './prompts-i18n.js';
export { STORY_LINKS_FILE_TYPE, describeStoryLinkCoverage, describeStoryLinksImport } from './story-arc-links-core.js';
export {
    buildCollectionLinksFile,
    describeStoryLinkPass,
    planStoryLinksImport,
    readCollectionLinkCoverage,
    readStoryLinkCoverage,
    runStoryLinkPass,
    writeImportedStoryLinks,
} from './story-arc-links.js';
export {
    applyGhosting,
    buildSummarizerInjection,
    refreshWorldInfoEntryDepthCache,
    runSummarizerInjection,
} from './summarizer-injection.js';
