// secrets.js — SillyTavern's secret store: the key names, which keys are set, and reading, writing and deleting them.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { SECRET_KEYS, deleteSecret, readSecretState, secret_state, writeSecret } from '../../../../../secrets.js';
