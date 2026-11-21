// world-info.js — SillyTavern's lorebooks: their names (`world_names`, a live binding), the globally selected books
// (`selected_world_info`, a live binding) and the chat metadata key of a chat's book, loading one, the entries in
// activation order, a scan of the books (`checkWorldInfo`) and whether it reads each message with its speaker's name
// (`world_info_include_names`, a live binding), and the World Info settings. And adding a book, or taking one out, the
// way SillyTavern's own controls do: a character's Additional Lorebooks and a chat's Chat Lorebook, its Chat Lore button's;
// taking one out of the global list every chat loads too; and saving one entry's title and text the way its World Info
// commands do.
// The rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
import {
    METADATA_KEY, charSetAuxWorlds, charUpdateAddAuxWorld, getWorldInfoSettings, loadWorldInfo, reloadEditor, saveWorldInfo,
    selected_world_info, world_names,
} from '../../../../../world-info.js';
import { chat_metadata, saveMetadata } from '../../../../../../script.js';

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
 * Take a lorebook out of a character's Additional Lorebooks, as unticking it at the character's World Info button in
 * SillyTavern does: the character's list without it, set through charSetAuxWorlds, which saves it with SillyTavern's
 * settings and drops the character's entry once its list is empty.
 * @param {string} characterFileName - The character's file name, its avatar's without the extension (getCharaFilename),
 *   which SillyTavern keys the list by
 * @param {string} bookName
 */
export function removeCharacterLorebook(characterFileName, bookName) {
    charSetAuxWorlds(characterFileName, characterLorebooks(characterFileName).filter(name => name !== bookName));
}

/**
 * A character's Additional Lorebooks, as its World Info button in SillyTavern lists them.
 * @param {string} characterFileName - The character's file name, its avatar's without the extension (getCharaFilename),
 *   which SillyTavern keys the list by
 * @returns {string[]}
 */
export function characterLorebooks(characterFileName) {
    return getWorldInfoSettings().world_info?.charLore?.find(item => item.name === characterFileName)?.extraBooks ?? [];
}

/**
 * Set SillyTavern's global list, which every chat loads, as choosing books in the World Info panel does: the panel's
 * list (`#world_info`, each option valued by its book's place in `world_names`) gets these books on and the rest off,
 * and the list's change handler sets `selected_world_info`, saves the settings and tells the extensions. A book
 * SillyTavern no longer has drops off it, as any change made in the panel drops it.
 * @param {string[]} bookNames
 * @throws {Error} When the panel's list is not on the page
 */
function setGlobalLorebooks(bookNames) {
    const list = document.getElementById('world_info');
    if (!(list instanceof HTMLSelectElement)) throw new Error("SillyTavern's World Info panel is not on the page.");
    const turnedOn = new Set(bookNames.map(name => String(world_names.indexOf(name))));
    for (const option of list.options) option.selected = turnedOn.has(option.value);
    list.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Turn a lorebook off in SillyTavern's global list, the others left on (setGlobalLorebooks).
 * @param {string} bookName
 * @throws {Error} When the panel's list is not on the page
 */
export function removeGlobalLorebook(bookName) {
    setGlobalLorebooks(selected_world_info.filter(name => name !== bookName));
}

/**
 * Make a lorebook the open chat's Chat Lorebook, as choosing it in SillyTavern's Chat Lorebook popup does
 * (assignLorebookToChat): the chat's metadata naming it in place of any book it named, the Chat Lore buttons marked as
 * set, and the chat's metadata saved. The chat then loads it, and only this chat.
 * @param {string} bookName - A book SillyTavern has
 * @returns {Promise<void>}
 * @throws {Error} When SillyTavern has no such book
 */
export async function addChatLorebook(bookName) {
    if (!world_names.includes(bookName)) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    chat_metadata[METADATA_KEY] = bookName;
    for (const button of document.querySelectorAll('.chat_lorebook_button')) button.classList.add('world_set');
    await saveMetadata();
}

/**
 * Take a lorebook off the open chat as its Chat Lorebook, as choosing None in SillyTavern's Chat Lorebook popup does
 * (assignLorebookToChat): the chat's metadata without its book, the Chat Lore buttons no longer marked as set, and the
 * chat's metadata saved. A chat whose Chat Lorebook is another book is left as it is.
 * @param {string} bookName
 * @returns {Promise<void>}
 */
export async function removeChatLorebook(bookName) {
    if (chat_metadata[METADATA_KEY] !== bookName) return;
    delete chat_metadata[METADATA_KEY];
    for (const button of document.querySelectorAll('.chat_lorebook_button')) button.classList.remove('world_set');
    await saveMetadata();
}

/**
 * Save one entry's title and text in a lorebook as SillyTavern's World Info commands do: the book loaded (a copy of
 * SillyTavern's), the entry changed, the book saved at once, which tells SillyTavern's listeners it was updated, and its
 * World Info editor drawn again when it shows that book, so the editor never saves its older copy over this one.
 * SillyTavern's save does not read the server's answer, so a save the server refused goes unseen here too.
 * @param {string} bookName
 * @param {string} uid - The entry's uid
 * @param {{comment: string, content: string}} fields - Its title, as SillyTavern's Title/Memo, and its text
 * @returns {Promise<void>}
 * @throws {Error} When SillyTavern has no such book, or the book no such entry
 */
export async function saveLorebookEntry(bookName, uid, { comment, content }) {
    const book = await loadWorldInfo(bookName);
    if (!book?.entries) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    const entry = Object.values(book.entries).find(candidate => String(candidate.uid) === String(uid));
    if (!entry) throw new Error(`Lorebook "${bookName}" has no entry ${uid} any more.`);
    entry.comment = comment;
    entry.content = content;
    await saveWorldInfo(bookName, book, true);
    reloadEditor(bookName);
}
