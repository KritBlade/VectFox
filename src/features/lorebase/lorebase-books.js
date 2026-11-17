/**
 * What VectFox keeps per lorebook for LoreBase (plan §5.2, §5.4): the entries the user selected for LoreBase to
 * decide, the section names whose parts are kept whenever their entry is picked (pins, D10), the chats and characters
 * the book is locked to (D11), each character by its avatar file name, and the entries it held when the selection
 * screen last opened it, so a later one shows as new. One record per book, keyed by the book's exact name, in
 * VectFox's settings: never a key per entry (§3.3), and never in the lorebook file.
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';

const BOOKS_KEY = 'lorebase_books';

function allBooks() {
    const settings = extension_settings.vectfox;
    if (!settings[BOOKS_KEY] || typeof settings[BOOKS_KEY] !== 'object') settings[BOOKS_KEY] = {};
    return settings[BOOKS_KEY];
}

function emptyRecord() {
    return { selectedUids: [], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] };
}

/**
 * A book's record, or null when the user never selected, pinned, locked or opened anything in it. Reading writes
 * nothing: each reply reads the records of the books it loads. `seenUids` is missing until the selection screen first
 * opens the book.
 * @param {string} bookName
 * @returns {{selectedUids: string[], pinnedSections: string[], lockedToChatIds: string[],
 *   lockedToCharacterAvatars: string[], seenUids?: string[]}|null}
 */
export function getLoreBook(bookName) {
    return extension_settings.vectfox[BOOKS_KEY]?.[bookName] ?? null;
}

/**
 * The names of the books with entries selected for LoreBase, as their records hold them.
 * @returns {string[]}
 */
export function selectedLoreBookNames() {
    return Object.entries(extension_settings.vectfox[BOOKS_KEY] ?? {})
        .filter(([, record]) => record?.selectedUids?.length)
        .map(([bookName]) => bookName);
}

function recordFor(bookName) {
    const books = allBooks();
    books[bookName] ??= emptyRecord();
    return books[bookName];
}

/**
 * Set the entries LoreBase decides in a book: a selected entry goes in only when Luna picks it (D14). Every entry
 * starts unselected (D3).
 * @param {string} bookName
 * @param {Iterable<string|number>} entryUids
 */
export function setLoreBookSelection(bookName, entryUids) {
    recordFor(bookName).selectedUids = [...new Set([...entryUids].map(String))];
    saveSettingsDebounced();
}

/**
 * Set the section names whose parts are kept whenever their entry is picked, whatever its review says (D10).
 * @param {string} bookName
 * @param {Iterable<string>} sectionNames
 */
export function setLoreBookPins(bookName, sectionNames) {
    recordFor(bookName).pinnedSections = [...new Set([...sectionNames].map(name => String(name).trim()).filter(Boolean))];
    saveSettingsDebounced();
}

/**
 * Keep the entries a book holds as the selection screen opens it, so an entry added later shows as new there.
 * @param {string} bookName
 * @param {Iterable<string|number>} entryUids
 */
export function setLoreBookSeenEntries(bookName, entryUids) {
    recordFor(bookName).seenUids = [...new Set([...entryUids].map(String))];
    saveSettingsDebounced();
}

/**
 * Lock a book to a chat or a character, or unlock it. The lock is the master switch (D11): a book takes part only
 * where SillyTavern has it active and the user locked it. A character is named by its avatar file name, which stays
 * the same when characters are added or deleted, where its place in SillyTavern's character list does not.
 * @param {string} bookName
 * @param {{chatId?: string, characterAvatar?: string}} target
 * @param {boolean} locked
 */
export function setLoreBookLock(bookName, { chatId, characterAvatar }, locked) {
    const record = recordFor(bookName);
    const update = (list, id) => {
        if (id === undefined || id === null) return list;
        const others = list.filter(item => item !== String(id));
        return locked ? [...others, String(id)] : others;
    };
    record.lockedToChatIds = update(record.lockedToChatIds, chatId);
    record.lockedToCharacterAvatars = update(record.lockedToCharacterAvatars, characterAvatar);
    saveSettingsDebounced();
}

/**
 * Whether a book is locked to this chat or this character.
 * @param {string} bookName
 * @param {{chatId?: string|null, characterAvatar?: string|null}} where
 * @returns {boolean}
 */
export function isLoreBookLocked(bookName, { chatId, characterAvatar }) {
    const record = getLoreBook(bookName);
    if (!record) return false;
    return (chatId != null && record.lockedToChatIds.includes(String(chatId)))
        || (characterAvatar != null && record.lockedToCharacterAvatars.includes(String(characterAvatar)));
}

/** Move every book's lock on one chat or character to its new name, saving only when a lock moved. */
function moveLocks(lockList, oldName, newName) {
    const books = extension_settings.vectfox[BOOKS_KEY];
    if (!books || !oldName || !newName || oldName === newName) return;
    let hasMoved = false;
    for (const record of Object.values(books)) {
        if (!record[lockList].includes(oldName)) continue;
        record[lockList] = [...new Set(record[lockList].map(name => (name === oldName ? newName : name)))];
        hasMoved = true;
    }
    if (hasMoved) saveSettingsDebounced();
}

/**
 * Keep every book's locks on a character SillyTavern renamed: the rename gives it a new avatar file name, and
 * SillyTavern moves its own per-character settings (tags, extra lorebooks, the character's Author's Note) the same way.
 * @param {string} oldAvatar
 * @param {string} newAvatar
 */
export function renameLoreBookCharacter(oldAvatar, newAvatar) {
    moveLocks('lockedToCharacterAvatars', oldAvatar, newAvatar);
}

/**
 * Keep every book's locks on a chat SillyTavern renamed: a chat lock holds the chat's file name, which the rename
 * changes.
 * @param {string} oldChatId
 * @param {string} newChatId
 */
export function renameLoreBookChat(oldChatId, newChatId) {
    moveLocks('lockedToChatIds', oldChatId, newChatId);
}
