// world-info.js — SillyTavern's lorebooks: their names (`world_names`, a live binding), the globally selected books
// (`selected_world_info`, a live binding) and the chat metadata key of a chat's book, loading one, the entries in
// activation order, a scan of the books (`checkWorldInfo`) and whether it reads each message with its speaker's name
// (`world_info_include_names`, a live binding), and the World Info settings. And adding a book to a character's
// Additional Lorebooks, and taking one out of them, the way SillyTavern's own controls do; taking one off a chat as its
// Chat Lorebook, as its Chat Lore button does, and out of the global list every chat loads; creating a book, adding an
// entry to one, and saving one entry's title, text and keys, the way its World Info commands do.
// The rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
import {
    METADATA_KEY, charSetAuxWorlds, charUpdateAddAuxWorld, createWorldInfoEntry, getWorldInfoSettings, loadWorldInfo, reloadEditor,
    saveWorldInfo, selected_world_info, updateWorldInfoList, world_names,
} from '../../../../../world-info.js';
import { chat_metadata, saveMetadata } from '../../../../../../script.js';
import { equalsIgnoreCaseAndAccents } from '../../../../../utils.js';
import { getSanitizedFilename } from './identifiers.js';

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
 * Create an empty lorebook under the name nearest `bookName` that SillyTavern allows: the name as its server saves a
 * file, then with " (2)", " (3)" and so on while SillyTavern has a book of that name, matched as SillyTavern matches
 * book names, in any case and accents. The book is saved at once and SillyTavern's list of books read again, as its
 * own New button does (createNewWorldInfo), without that button's two steps for the user at the panel: the World Info
 * editor switched to the new book, and the toast for a name taken, which a free name never meets.
 * @param {string} bookName
 * @returns {Promise<string>} The name the book was saved under
 * @throws {Error} When the name cannot be made a file name (SillyTavern's own toast says why), or SillyTavern's list
 *   lacks the book once saved, as its save does not read the server's answer
 */
export async function createLorebook(bookName) {
    const fileName = await getSanitizedFilename(bookName);
    const isTaken = name => world_names.some(existing => equalsIgnoreCaseAndAccents(existing, name));
    let name = fileName;
    for (let number = 2; isTaken(name); number += 1) name = `${fileName} (${number})`;
    await saveWorldInfo(name, { entries: {} }, true);
    await updateWorldInfoList();
    if (!world_names.includes(name)) throw new Error(`SillyTavern did not save the lorebook "${name}".`);
    return name;
}

const noSuchBook = bookName => `SillyTavern has no lorebook named "${bookName}".`;

// Save a book changed on its loaded copy at once, which tells SillyTavern's listeners it was updated, then draw its
// World Info editor again when it shows that book, so the editor never saves its older copy over this one.
async function saveBookNow(bookName, book) {
    await saveWorldInfo(bookName, book, true);
    reloadEditor(bookName);
}

/**
 * Add an entry to a lorebook as SillyTavern's /createentry command does: the book loaded (a copy of SillyTavern's), a
 * new entry from SillyTavern's template at the book's first free uid, so every field not set here keeps SillyTavern's
 * default, not constant, and the user's World Info settings decide its scan depth and whole-word matching; its title
 * shown as its memo, its keys and its text set; then the book saved at once and its editor drawn again.
 * SillyTavern's save does not read the server's answer, so a save the server refused goes unseen here.
 * @param {string} bookName
 * @param {{comment: string, keys: string[], content: string}} fields - Its title, as SillyTavern's Title/Memo, its keys
 *   and its text
 * @returns {Promise<string>} The new entry's uid
 * @throws {Error} When SillyTavern has no such book, or finds the entry no uid
 */
export async function createLorebookEntry(bookName, { comment, keys, content }) {
    const book = await loadWorldInfo(bookName);
    if (!book?.entries) throw new Error(noSuchBook(bookName));
    const entry = createWorldInfoEntry(bookName, book);
    if (!entry) throw new Error(`SillyTavern found no uid for a new entry in lorebook "${bookName}".`);
    Object.assign(entry, { comment, addMemo: true, key: [...keys], content });
    await saveBookNow(bookName, book);
    return String(entry.uid);
}

/**
 * Save one entry's title and text in a lorebook, and its keys when given, as SillyTavern's World Info commands do: the
 * book loaded (a copy of SillyTavern's), the entry changed, then the book saved at once and its editor drawn again.
 * SillyTavern's save does not read the server's answer, so a save the server refused goes unseen here too.
 * @param {string} bookName
 * @param {string} uid - The entry's uid
 * @param {{comment: string, content: string, keys?: string[]}} fields - Its title, as SillyTavern's Title/Memo, its
 *   text, and its keys, which stay as they are when not given
 * @returns {Promise<void>}
 * @throws {Error} When SillyTavern has no such book, or the book no such entry
 */
export async function saveLorebookEntry(bookName, uid, { comment, content, keys }) {
    const book = await loadWorldInfo(bookName);
    if (!book?.entries) throw new Error(noSuchBook(bookName));
    const entry = Object.values(book.entries).find(candidate => String(candidate.uid) === String(uid));
    if (!entry) throw new Error(`Lorebook "${bookName}" has no entry ${uid} any more.`);
    entry.comment = comment;
    entry.content = content;
    if (keys) entry.key = [...keys];
    await saveBookNow(bookName, book);
}
