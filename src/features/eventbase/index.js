// features/eventbase — EventBase, the event memory: extraction from chat windows, the event store, retrieval
// and injection, AgentMode retrieval, forking an EventBase onto a branch, and the summarizer injection. The settings
// panel runs the Test connection of the EventBase model, Agent Mode's planner and StoryArc's link model here.
//
// src/index.js runs the reply step (runEventBaseReplyStep) from the manifest's generation interceptor and auto-sync
// (synchronizeChat) on chat events, hands clearCachesForDeletedOrImportedCollection to collection deletion and
// import, and sets the listeners told of runs, removals and the collection in use (setEventBaseListeners,
// followCollectionInUse); the Database Browser tells them of the events it deletes (announceEventsRemoved); src/app/
// runs ensureEventBaseIndexes at startup. The settings panel opens
// Vectorize Content and runs Sync chat and the auto-sync catch-up. The Database Browser runs a collection's StoryArc
// link actions and Compact collection here. The public API answers which chat is open and the collection it uses from
// openChatCollectionInUse, and reads a collection's events and removals after a change number from readEventFeed.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { testAgentModeConnection, testStoryArcConnection } from './agentic-retrieval.js';
export { backfillCurrentChatWithProgress, openContentVectorizer, syncOpenChat } from './content-vectorizer.js';
export { announceEventsRemoved, setEventBaseListeners } from './eventbase-announcements.js';
export {
    askWhichChatCollection, chatOwnCollections, collectionInUse, followCollectionInUse, lockCollectionToOpenChat,
    openChatCollectionInUse, showNoCollectionInUse, useChatCollection,
} from './eventbase-chat-collections.js';
export { describeCompaction } from './eventbase-compaction-core.js';
export { compactCollection, planCollectionCompaction } from './eventbase-compaction.js';
export { synchronizeChat } from './eventbase-chat-sync.js';
export { testEventBaseConnection } from './eventbase-extractor.js';
export { readEventFeed } from './eventbase-feed.js';
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
export { formatStoryLine } from './eventbase-injection.js';
export { chineseScriptNameOf, getEventBaseExtractionPrompt } from './prompts-i18n.js';
export { isStoryArcActive } from './story-arc-core.js';
export { readEntityMerges } from './story-arc-entities.js';
export { buildEntityNameWriter, eventsNamingEntity, filterEntities, holdsName, listEntities, withKeptEntityNames } from './story-arc-entity-core.js';
export { readStoryLanguage } from './story-language.js';
export { STORY_LINKS_FILE_TYPE, describeStoryLinkCoverage, describeStoryLinksImport, inTimelineOrder, linkParallelCallsOf } from './story-arc-links-core.js';
export {
    buildCollectionLinksFile,
    deleteStoryLinks,
    describeStoryLinkPass,
    planStoryLinksDelete,
    planStoryLinksImport,
    readChatStoryEvents,
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
