// identifiers.js — SillyTavern's string hash, which every VectFox chunk and message hash uses, and its UUID generator.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getStringHash, uuidv4 } from '../../../../../utils.js';
