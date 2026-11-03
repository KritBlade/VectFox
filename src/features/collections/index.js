// features/collections — collections and what VectFox knows about them: the registry and loader, per-collection
// metadata (enabled state, chat and character locks, triggers, conditions, auto-sync), the activation rules and
// chunk links, and JSON and PNG export and import.
//
// The widest surface of any feature: every feature that lists, locks, activates or exports a collection reads it
// here. setDeletedCollectionCleanup lets src/index.js hand EventBase's cache cleanup to collection deletion
// without this feature importing eventbase.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    MAX_IMPORT_FILE_BYTES,
    downloadExport,
    exportCollection,
    fetchPortableChunks,
    getExportInfo,
    importCollection,
    insertChunksWithVectors,
    readImportFile,
    validateImportData,
} from './collection-export.js';
export {
    cleanupCorruptedCollections,
    cleanupTestCollections,
    clearCollectionRegistry,
    deleteCollection,
    discoverExistingCollections,
    doesChatHaveVectors,
    getCollectionListing,
    getCollectionRegistry,
    isCollectionEmpty,
    loadAllCollections,
    registerCollection,
    sanitizeHandleId,
    setDeletedCollectionCleanup,
    unregisterCollection,
} from './collection-loader.js';
export {
    cleanupOrphanedMeta,
    deleteChunkMetadata,
    filterActiveCollections,
    getAllChunkMetadata,
    getChatLockedCollections,
    getChunkMetadata,
    getCollectionActivationSummary,
    getCollectionCharacterLockCount,
    getCollectionCharacterLocks,
    getCollectionConditions,
    getCollectionLockCount,
    getCollectionLocks,
    getCollectionMeta,
    getCollectionTriggers,
    isCollectionActiveForContext,
    isCollectionActiveForContextAnyKey,
    isCollectionAutoSyncEnabled,
    isCollectionEnabled,
    isCollectionLockedToCharacter,
    isCollectionLockedToChat,
    migrateOldEnabledKeys,
    removeCollectionCharacterLock,
    removeCollectionLock,
    saveChunkMetadata,
    setCollectionAutoSync,
    setCollectionCharacterLock,
    setCollectionConditions,
    setCollectionEnabled,
    setCollectionLock,
    setCollectionMeta,
    shouldCollectionActivate,
} from './collection-metadata.js';
export {
    VALID_GENERATION_TYPES,
    buildSearchContext,
    evaluateConditionRule,
    processChunkLinks,
    validateConditionRule,
} from './conditional-activation.js';
export { convertToPNG, downloadPNG, embedDataInPNG, extractDataFromPNG, readPNGFile } from './png-export.js';
