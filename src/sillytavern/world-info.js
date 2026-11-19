// world-info.js — SillyTavern's lorebooks: their names (`world_names`, a live binding), the globally selected books
// (`selected_world_info`, a live binding) and the chat metadata key of a chat's book, loading one, the entries in
// activation order, a scan of the books (`checkWorldInfo`) and whether it reads each message with its speaker's name
// (`world_info_include_names`, a live binding), and the World Info settings. And adding a book the way SillyTavern's
// own World Info controls do: to a character's Additional Lorebooks, or to the global list every chat loads.
// The rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
import { charUpdateAddAuxWorld, selected_world_info, world_names } from '../../../../../world-info.js';

export {
    METADATA_KEY, checkWorldInfo, getSortedEntries, getWorldInfoSettings, loadWorldInfo, selected_world_info, world_info_include_names, world_names,
} from '../../../../../world-info.js';

/**
 * Add a lorebook to a character's Additional Lorebooks, as the character's World Info button in SillyTavern does: the
 * book loads in that character's chats only, and SillyTavern saves the list with its settings.
 * @param {string} characterAvatar - The character's avatar file name, which SillyTavern keys the list by
 * @param {string} bookName
 * @returns {Promise<void>}
 */
export async function addCharacterLorebook(characterAvatar, bookName) {
    await charUpdateAddAuxWorld(characterAvatar, bookName);
}

/**
 * Turn a lorebook on in SillyTavern's global list, which every chat loads, as choosing it in the World Info panel
 * does: the panel's list (`#world_info`, each option valued by its book's place in `world_names`) gets the book beside
 * those already on, and the list's change handler sets `selected_world_info`, saves the settings and tells the
 * extensions. Any name works, where the /world command reads a comma as a list. A book on the global list that
 * SillyTavern no longer has drops off it, as any change made in the panel drops it.
 * @param {string} bookName - A book SillyTavern has
 * @throws {Error} When SillyTavern has no such book, or the panel's list is not on the page
 */
export function addGlobalLorebook(bookName) {
    const list = document.getElementById('world_info');
    if (!(list instanceof HTMLSelectElement)) throw new Error("SillyTavern's World Info panel is not on the page.");
    if (!world_names.includes(bookName)) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    const turnedOn = new Set([...selected_world_info, bookName].map(name => String(world_names.indexOf(name))));
    for (const option of list.options) option.selected = turnedOn.has(option.value);
    list.dispatchEvent(new Event('change', { bubbles: true }));
}
