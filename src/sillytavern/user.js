// user.js — the SillyTavern account this page runs as: its handle, which keeps one account's LoreBase indexes apart
// from another's in a Qdrant both use.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getCurrentUserHandle } from '../../../../../user.js';
