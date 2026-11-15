// vector-storage.js — SillyTavern's own Vector Storage extension, where LoreBase meets it: whether its World Info search
// is on ("Enabled for World Info"), which force-activates lorebook entries by similarity, and turning that search off
// through Vector Storage's own /vector-worldinfo-state command, so its settings, its checkbox and the saved value
// change together. Its chat-message and file search are never touched.
//
// SillyTavern's context comes from its page global, read at each call, so importing this file loads nothing of
// SillyTavern's.
import { log } from './log.js';

const getContext = () => globalThis.SillyTavern.getContext();

// Vector Storage's folder name, as SillyTavern lists it among the extensions turned off.
const VECTOR_STORAGE = 'vectors';

/** Whether Vector Storage runs with its World Info search on. */
export function isVectorStorageWorldInfoOn() {
    const extensionSettings = getContext().extensionSettings;
    if (extensionSettings?.disabledExtensions?.includes(VECTOR_STORAGE)) return false;
    return extensionSettings?.vectors?.enabled_world_info === true;
}

/**
 * Turn Vector Storage's World Info search off, leaving its chat-message and file search as they are.
 * @returns {Promise<boolean>} Whether the search is off afterwards
 */
export async function turnOffVectorStorageWorldInfo() {
    try {
        await getContext().executeSlashCommandsWithOptions('/vector-worldinfo-state false');
    } catch (error) {
        log.warn("Vector Storage's World Info search could not be turned off:", error);
    }
    return !isVectorStorageWorldInfoOn();
}
