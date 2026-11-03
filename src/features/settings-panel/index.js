// features/settings-panel — VectFox's settings drawer and its tabs. The top of the feature order: only
// src/index.js imports it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    loadWebLlmModels,
    openDiagnosticsModal,
    refreshAutoSyncCheckbox,
    renderSettings,
    updateWebLlmStatus,
} from './settings-panel.js';
