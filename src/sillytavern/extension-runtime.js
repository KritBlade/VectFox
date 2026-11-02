// extension-runtime.js — what SillyTavern gives a running extension: the module worker wrapper, opening the
// extension's menu, and SillyTavern's debounce with its default delay.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { ModuleWorkerWrapper, openThirdPartyExtensionMenu } from '../../../../../extensions.js';
export { debounce } from '../../../../../utils.js';
export { debounce_timeout } from '../../../../../constants.js';
