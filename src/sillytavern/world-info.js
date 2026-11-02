// world-info.js — SillyTavern's lorebooks: their names (`world_names`, a live binding), loading one, the entries in
// activation order, and the World Info settings.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getSortedEntries, getWorldInfoSettings, loadWorldInfo, world_names } from '../../../../../world-info.js';
