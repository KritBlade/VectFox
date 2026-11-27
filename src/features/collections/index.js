// features/collections — collections and what VectFox knows about them: the registry and loader, per-collection
// metadata (enabled state, chat and character locks, auto-sync), and JSON and PNG export and import.
//
// The widest surface of any feature: every feature that lists, locks, activates or exports a collection reads it
// here. setDeletedOrImportedCollectionCleanup and setEventBaseWindowsForExport let src/index.js hand EventBase's cache
// cleanup to collection deletion and import, and its windows read to export, without this feature importing eventbase.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    MAX_IMPORT_FILE_BYTES,
    downloadExport,
    exportCollection,
    exportFileKind,
    fetchPortableChunks,
    getExportInfo,
    importCollection,
    insertChunksWithVectors,
    readImportFile,
    setEventBaseWindowsForExport,
    validateImportData,
} from './collection-export.js';
export {
    cleanupCorruptedCollections,
    cleanupTestCollections,
    clearCollectionRegistry,
    deleteCollection,
    collectionNameOf,
    deleteCollectionWhereDiscovered,
    deleteVectorsFolder,
    discoverExistingCollections,
    getCollectionListing,
    getCollectionRegistry,
    loadAllCollections,
    registerCollection,
    sanitizeHandleId,
    setDeletedOrImportedCollectionCleanup,
    unregisterCollection,
} from './collection-loader.js';
export {
    cleanUpCollectionLocks,
    cleanupOrphanedMeta,
    followChatRenameOfCollections,
    getCollectionCharacterLockCount,
    getCollectionCharacterLocks,
    getCollectionLockCount,
    getCollectionLocks,
    getCollectionMeta,
    isCollectionActiveForContext,
    isCollectionActiveForContextAnyKey,
    isCollectionAutoSyncEnabled,
    isCollectionEnabled,
    isCollectionLockedToCharacter,
    isCollectionLockedToChat,
    migrateOldEnabledKeys,
    removeCollectionCharacterLock,
    removeCollectionLock,
    setCollectionAutoSync,
    setCollectionCharacterLock,
    setCollectionEnabled,
    setCollectionLock,
    setCollectionMeta,
} from './collection-metadata.js';
export { accountHandlesOf, isCollectionOfAccount } from './collection-ownership-core.js';
export { convertToPNG, downloadPNG, embedDataInPNG, extractDataFromPNG, readPNGFile } from './png-export.js';
export { deleteRetiredContentCollections } from './retired-content-collections.js';
