// features/database-browser — the Database Browser: its Collections page with each collection's actions, its Search
// page, the Size Inspector, and the Chunk Visualizer it opens.
//
// world-info opens the browser when a vectorized lorebook was renamed or deleted.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { initializeDatabaseBrowser, openDatabaseBrowser } from './database-browser.js';
