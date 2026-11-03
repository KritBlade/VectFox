// features/world-info — semantic World Info: lorebook entries activated by vector search, and the check for
// vectorized lorebooks whose source lorebook was renamed or deleted.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    clearLorebookPrompt,
    getSemanticWorldInfoEntries,
    initializeWorldInfoIntegration,
    runLorebookWIDryRun,
} from './world-info-integration.js';
