// user.js — the SillyTavern account this page runs as: its handle, which keeps one account's LoreBase vectors apart
// from another's in a Qdrant both use, and its personas' names, which its collection IDs name their maker by.
// The rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
import { getContext } from '../../../../../extensions.js';

export { getCurrentUserHandle } from '../../../../../user.js';

/**
 * The names of this account's personas, the one in use first, each once: SillyTavern's persona list
 * (power_user.personas) and the name in use (name1), which a page with no persona saved still has.
 *
 * @returns {string[]}
 */
export function accountPersonaNames() {
    const context = getContext();
    const names = [context?.name1, ...Object.values(context?.powerUserSettings?.personas ?? {})];
    return [...new Set(names.filter(name => typeof name === 'string' && name.trim()))];
}
