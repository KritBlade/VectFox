// installed-extensions.js — the names of the extensions SillyTavern found installed, such as "third-party/VectFox".
// Re-exports only: the rest of VectFox imports it here, never from SillyTavern (tools/check-host-imports.mjs).
export { extensionNames } from '../../../../../extensions.js';
