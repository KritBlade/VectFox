// features/settings-panel — VectFox's settings panel and its pages. The top of the feature order: only
// src/index.js imports it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    mountSettingsPanel,
    refreshAutoSyncCheckbox,
} from './settings-panel.js';
export { scheduleManualConnectionNotice } from './manual-connection-notice.js';
