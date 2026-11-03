// features/database-browser — the database browser: collection cards and their actions, the chunk viewer, the
// size inspector, and the icons they share.
//
// world-info opens the browser when a vectorized lorebook was renamed or deleted.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { initializeVisualizer } from './chunk-visualizer.js';
export { initializeDatabaseBrowser, openDatabaseBrowser } from './database-browser.js';
