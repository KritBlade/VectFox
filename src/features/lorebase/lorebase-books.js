/**
 * What VectFox keeps per lorebook for LoreBase (plan §5.2, §5.4): the entries the user picked and how each is used,
 * the chats and characters the book is locked to, and what its index was built with. One record per book, keyed by
 * the book's exact name, in VectFox's settings: never a key per entry (§3.3), and never in the lorebook file. The
 * record belongs to the book, not to one index, so a change of model or backend builds a new index from the same
 * picks, under the same locks (D7, D11).
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';

const BOOKS_KEY = 'lorebase_books';

/** How a picked entry may be activated (plan §5.2): by its keys only, also by VectFox, or by VectFox alone. */
export const ACTIVATION = Object.freeze({
    KEYS: 'keys',
    KEYS_AND_VECTFOX: 'keys_and_vectfox',
    VECTFOX_ONLY: 'vectfox_only',
});
const ACTIVATIONS = new Set(Object.values(ACTIVATION));

function allBooks() {
    const settings = extension_settings.vectfox;
    if (!settings[BOOKS_KEY] || typeof settings[BOOKS_KEY] !== 'object') settings[BOOKS_KEY] = {};
    return settings[BOOKS_KEY];
}

function emptyRecord() {
    return { picks: {}, lockedToChatIds: [], lockedToCharacterIds: [], index: null };
}

/**
 * A book's record, or null when the user never picked anything in it.
 * @param {string} bookName
 * @returns {{picks: Object<string, {split: boolean, activation: string}>, lockedToChatIds: string[], lockedToCharacterIds: string[], index: object|null}|null}
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
 * Set the entries VectFox may use in a book. An entry absent from `picks` is not vectorized (every entry starts off,
 * D3). Each pick says whether Trim cuts it (split) and how it is activated.
 * @param {string} bookName
 * @param {Object<string|number, {split?: boolean, activation?: string}>} picks - By entry uid
 * @throws {Error} When a pick names an activation LoreBase does not have
 */
export function setLoreBookPicks(bookName, picks) {
    const clean = {};
    for (const [uid, pick] of Object.entries(picks)) {
        const activation = pick.activation ?? ACTIVATION.KEYS;
        if (!ACTIVATIONS.has(activation)) {
            throw new Error(`LoreBase: entry ${uid} of "${bookName}" has activation "${activation}", which is not one of ${[...ACTIVATIONS].join(', ')}.`);
        }
        clean[String(uid)] = { split: Boolean(pick.split), activation };
    }
    recordFor(bookName).picks = clean;
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

/**
 * Record what a book's index was last built with: its ID, backend, embedding source and model (D7's check), and how
 * many passages it holds.
 * @param {string} bookName
 * @param {{id: string, backend: string, embeddingSource: string, embeddingModel: string, passageCount: number}|null} index
 */
export function recordLoreBookIndex(bookName, index) {
    recordFor(bookName).index = index ? { ...index, syncedAt: Date.now() } : null;
    saveSettingsDebounced();
}
