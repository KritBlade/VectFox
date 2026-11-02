// requests.js — the headers every request to SillyTavern's server needs (CSRF token, content type).
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getRequestHeaders } from '../../../../../../script.js';
