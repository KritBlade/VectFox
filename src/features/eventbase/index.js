// features/eventbase — EventBase, the event memory: extraction from chat windows, the event store, retrieval
// and injection, AgentMode retrieval, forking an EventBase onto a branch, and the summarizer injection. The settings
// panel runs the Test connection of the EventBase model, Agent Mode's planner and StoryArc's link model here.
//
// src/index.js runs the reply step (runEventBaseReplyStep) from the manifest's generation interceptor and auto-sync
// (synchronizeChat) on chat events, and hands clearCachesForDeletedOrImportedCollection to collection deletion and
// import; src/app/ runs ensureEventBaseIndexes at startup. The settings panel opens
// Vectorize Content and runs Sync chat and the auto-sync catch-up. The Database Browser runs a collection's StoryArc
// link actions and Compact collection here.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { testAgentModeConnection, testStoryArcConnection } from './agentic-retrieval.js';
export { backfillCurrentChatWithProgress, openContentVectorizer, syncOpenChat } from './content-vectorizer.js';
export {
    askWhichChatCollection, chatOwnCollections, collectionInUse, lockCollectionToOpenChat, showNoCollectionInUse, useChatCollection,
} from './eventbase-chat-collections.js';
export { describeCompaction } from './eventbase-compaction-core.js';
export { compactCollection, planCollectionCompaction } from './eventbase-compaction.js';
export { synchronizeChat } from './eventbase-chat-sync.js';
export { testEventBaseConnection } from './eventbase-extractor.js';
export { findEventBaseForkSource, forkEventBaseFromSource } from './eventbase-fork.js';
export { clearInterceptorPrompts, runEventBaseReplyStep } from './eventbase-reply.js';
export { packTimelineSortKey } from './eventbase-schema.js';
export {
    FAR_BEHIND_WINDOW_COUNT,
    clearAutoSyncMarker,
    clearCachesForDeletedOrImportedCollection,
    countWindowsBehind,
    ensureEventBaseIndexes,
    eventPointHash,
    getVectorizationTip,
    stampAutoSyncMarker,
} from './eventbase-store.js';
export {
    getAutoSyncWindowSize,
    getChatAutoSyncStatus,
    runEventBaseRetrieval,
} from './eventbase-workflow.js';
export { getEventBaseExtractionPrompt } from './prompts-i18n.js';
export { STORY_LINKS_FILE_TYPE, describeStoryLinkCoverage, describeStoryLinksImport, linkParallelCallsOf } from './story-arc-links-core.js';
export {
    buildCollectionLinksFile,
    deleteStoryLinks,
    describeStoryLinkPass,
    planStoryLinksDelete,
    planStoryLinksImport,
    readCollectionLinkCoverage,
    readStoryLinkCoverage,
    runStoryLinkPass,
    writeImportedStoryLinks,
} from './story-arc-links.js';
export { linkEstimateText, linkPassChoices, storyArcPageMarkup, storyLinkPill, storyLinkStatusMarkup } from './story-arc-page-markup.js';
export { hideStoryArcPage, showStoryArcPage, wireStoryArcPage } from './story-arc-page.js';
export {
    buildSummarizerInjection,
    refreshWorldInfoEntryDepthCache,
} from './summarizer-injection.js';
