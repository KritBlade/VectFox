// features/settings-panel — VectFox's settings panel and its pages. The top of the feature order: only
// src/index.js imports it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    loadWebLlmModels,
    mountSettingsPanel,
    refreshAutoSyncCheckbox,
    updateWebLlmStatus,
} from './settings-panel.js';
