/**
 * What VectFox keeps per lorebook for LoreBase (plan §5.2, §5.4): the entries the user selected for LoreBase to
 * decide, the section names whose parts are kept whenever their entry is picked (pins, D10), and the chats and
 * characters the book is locked to (D11). One record per book, keyed by the book's exact name, in VectFox's settings:
 * never a key per entry (§3.3), and never in the lorebook file.
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';

const BOOKS_KEY = 'lorebase_books';

function allBooks() {
    const settings = extension_settings.vectfox;
    if (!settings[BOOKS_KEY] || typeof settings[BOOKS_KEY] !== 'object') settings[BOOKS_KEY] = {};
    return settings[BOOKS_KEY];
}

function emptyRecord() {
    return { selectedUids: [], pinnedSections: [], lockedToChatIds: [], lockedToCharacterIds: [] };
}

/**
 * A book's record, or null when the user never selected anything in it.
 * @param {string} bookName
 * @returns {{selectedUids: string[], pinnedSections: string[], lockedToChatIds: string[], lockedToCharacterIds: string[]}|null}
 */
export function getLoreBook(bookName) {
    return allBooks()[bookName] ?? null;
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
 * Lock a book to a chat or a character, or unlock it. The lock is the master switch (D11): a book takes part only
 * where SillyTavern has it active and the user locked it.
 * @param {string} bookName
 * @param {{chatId?: string, characterId?: string}} target
 * @param {boolean} locked
 */
export function setLoreBookLock(bookName, { chatId, characterId }, locked) {
    const record = recordFor(bookName);
    const update = (list, id) => {
        if (id === undefined || id === null) return list;
        const others = list.filter(item => item !== String(id));
        return locked ? [...others, String(id)] : others;
    };
    record.lockedToChatIds = update(record.lockedToChatIds, chatId);
    record.lockedToCharacterIds = update(record.lockedToCharacterIds, characterId);
    saveSettingsDebounced();
}

/**
 * Whether a book is locked to this chat or this character.
 * @param {string} bookName
 * @param {{chatId?: string|null, characterId?: string|null}} where
 * @returns {boolean}
 */
export function isLoreBookLocked(bookName, { chatId, characterId }) {
    const record = getLoreBook(bookName);
    if (!record) return false;
    return (chatId != null && record.lockedToChatIds.includes(String(chatId)))
        || (characterId != null && record.lockedToCharacterIds.includes(String(characterId)));
}
