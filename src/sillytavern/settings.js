// settings.js — SillyTavern's extension settings store and the calls that save it.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { extension_settings } from '../../../../../extensions.js';
export { saveSettings, saveSettingsDebounced } from '../../../../../../script.js';
