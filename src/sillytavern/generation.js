// generation.js — whether SillyTavern is sending a message (`is_send_press`, a live binding) and the call that stops
// a generation.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { is_send_press, stopGeneration } from '../../../../../../script.js';
