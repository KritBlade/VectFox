/**
 * What VectFox keeps per lorebook for LoreBase (plan §5.2, §5.4, and §3.7 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): the book's selections, each with the entries the user selected for LoreBase to
 * decide, the section names whose parts are kept whenever their entry is picked (pins, D10), and the chats and
 * characters it is locked to (D11), each character by its avatar file name; and the entries the book held when the
 * selection screen last opened it, so a later one shows as new. A chat uses one selection of a book at a time, the one
 * locked to it, else the one locked to its character (selectionInUse), and locking a selection takes that lock off the
 * book's others (setLoreSelectionLock). One record per book, keyed by the book's exact name, in VectFox's settings:
 * never a key per entry (§3.3), and never in the lorebook file. A book's selected entries LoreBase decides are read here
 * too, against the book as SillyTavern loads it (loadDecidedEntries): what the reply sends from, and the one count of
 * them every LoreBase page shows (decidedCountOf). Clean up locks,
 * on the Action page, drops the locks on chats and characters that no longer exist, and Remove from LoreBase deletes a
 * book's record once its keys and vectors are deleted.
 */

import { log } from '../../sillytavern/log.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { loadWorldInfo } from '../../sillytavern/world-info.js';
import { newTimeId, numberedName } from '../../shared/new-group-member.js';
import { oneInUseLockChanges } from '../../shared/one-in-use-locks.js';
import { decidedEntries } from './lorebase-reply-core.js';
import { emptySelection, selectionInUseOf, unionOfSelections } from './lorebase-selections-core.js';

/** @typedef {import('./lorebase-selections-core.js').LoreSelection} LoreSelection */

const BOOKS_KEY = 'lorebase_books';
// Each kind of lock a selection holds, by the place it names.
const LOCK_LISTS = Object.freeze({ chatId: 'lockedToChatIds', characterAvatar: 'lockedToCharacterAvatars' });

function allBooks() {
    const settings = extension_settings.vectfox;
    if (!settings[BOOKS_KEY] || typeof settings[BOOKS_KEY] !== 'object') settings[BOOKS_KEY] = {};
    return settings[BOOKS_KEY];
}

/**
 * A book's record, or null when the user never selected, pinned, locked or opened anything in it. Reading writes
 * nothing: each reply reads the records of the books it loads. `seenUids` is missing until the selection screen first
 * opens the book.
 * @param {string} bookName
 * @returns {{selections: LoreSelection[], seenUids?: string[]}|null}
 */
export function getLoreBook(bookName) {
    return extension_settings.vectfox[BOOKS_KEY]?.[bookName] ?? null;
}

/**
 * A book's selections, in the order they were made; none while it has no record.
 * @param {string} bookName
 * @returns {LoreSelection[]}
 */
export function loreSelectionsOf(bookName) {
    return getLoreBook(bookName)?.selections ?? [];
}

/**
 * One of a book's selections, by its ID.
 * @param {string} bookName
 * @param {string} selectionId
 * @returns {LoreSelection}
 * @throws {Error} When the book has no selection of that ID
 */
export function getLoreSelection(bookName, selectionId) {
    const selection = loreSelectionsOf(bookName).find(each => each.id === selectionId);
    if (!selection) throw new Error(`LoreBase has no selection "${selectionId}" of lorebook "${bookName}".`);
    return selection;
}

/**
 * The selection of a book a chat uses: the one locked to the chat, else the one locked to its character, else none.
 * @param {string} bookName
 * @param {{chatId?: string|null, characterAvatar?: string|null}} where
 * @returns {LoreSelection|null}
 */
export function selectionInUse(bookName, where) {
    return selectionInUseOf(getLoreBook(bookName), where);
}

/**
 * The selected entries LoreBase decides in a book, as SillyTavern loads it now (decidedEntries): of one selection, or
 * by default every entry any of the book's selections holds, which LoreBase writes keys and vectors for. What the
 * WorldInfo page's book rows count, the keys count reads and the reply sends from. None when SillyTavern has no such
 * book.
 * @param {string} bookName
 * @param {{selectedUids: string[]}} [selection] - A selection, or every entry the book's selections hold by default
 * @returns {Promise<object[]>}
 * @throws {Error} When SillyTavern cannot load the book
 */
export async function loadDecidedEntries(bookName, selection = unionOfSelections(getLoreBook(bookName))) {
    return decidedEntries(await loadWorldInfo(bookName), selection);
}

/**
 * How many entries LoreBase decides in a book (loadDecidedEntries): of one selection, or by default every entry its
 * selections hold. The one "N selected" every LoreBase page shows: the WorldInfo page's rows, the selection screen's
 * book list and the Database Browser's rows. A book SillyTavern cannot load counts its saved selection, and the console
 * says why.
 * @param {string} bookName
 * @param {{selectedUids: string[]}} [selection] - A selection, or every entry the book's selections hold by default
 * @returns {Promise<number>}
 */
export async function decidedCountOf(bookName, selection = unionOfSelections(getLoreBook(bookName))) {
    if (!selection.selectedUids.length) return 0;
    try {
        return (await loadDecidedEntries(bookName, selection)).length;
    } catch (error) {
        log.warn(`LoreBase: lorebook "${bookName}" could not be loaded, so its saved selection is counted:`, error);
        return selection.selectedUids.length;
    }
}

/**
 * Every entry LoreBase would decide in a book were it selected, as SillyTavern loads it now (decidedEntries with each
 * entry selected): what a vectors file matches, selected or not. None when SillyTavern has no such book.
 * @param {string} bookName
 * @returns {Promise<object[]>}
 * @throws {Error} When SillyTavern cannot load the book
 */
export async function loadDecidableEntries(bookName) {
    const book = await loadWorldInfo(bookName);
    return decidedEntries(book, { selectedUids: Object.values(book?.entries ?? {}).map(entry => String(entry.uid)) });
}

/**
 * Every entry of a book as SillyTavern loads it now, selected or not: what a keys file matches by uid and title. None
 * when SillyTavern has no such book.
 * @param {string} bookName
 * @returns {Promise<object[]>}
 * @throws {Error} When SillyTavern cannot load the book
 */
export async function loadBookEntries(bookName) {
    return Object.values((await loadWorldInfo(bookName))?.entries ?? {});
}

/**
 * Every book with a record, by name, with how many entries its selections hold together and how many selections it
 * has: the Database Browser's lorebooks with a record, and which of them selects none.
 * @returns {Record<string, {selectedCount: number, selectionCount: number}>}
 */
export function loreBookRecordCounts() {
    return Object.fromEntries(Object.entries(extension_settings.vectfox[BOOKS_KEY] ?? {}).map(([bookName, record]) => [bookName, {
        selectedCount: unionOfSelections(record).selectedUids.length,
        selectionCount: record?.selections?.length ?? 0,
    }]));
}

/**
 * The names of the books with entries selected for LoreBase, in any of their selections.
 * @returns {string[]}
 */
export function selectedLoreBookNames() {
    return Object.entries(extension_settings.vectfox[BOOKS_KEY] ?? {})
        .filter(([, record]) => unionOfSelections(record).selectedUids.length)
        .map(([bookName]) => bookName);
}

function recordFor(bookName) {
    const books = allBooks();
    books[bookName] ??= { selections: [] };
    return books[bookName];
}

/**
 * A book's first selection, made with nothing selected and named after the book while it has none: what the selection
 * screen opens on a book never opened, and Add a lorebook locks.
 * @param {string} bookName
 * @returns {LoreSelection}
 */
export function ensureLoreSelection(bookName) {
    const record = recordFor(bookName);
    if (!record.selections.length) {
        record.selections.push(emptySelection(newTimeId([]), bookName));
        saveSettingsDebounced();
    }
    return record.selections[0];
}

/**
 * New selection: a copy of one of the book's selections, its selected entries and pinned sections but none of its locks,
 * named by numberedName from the book's name ("Harbor Atlas 2").
 * @param {string} bookName
 * @param {string|null} sourceSelectionId - The selection to copy; null copies the book's first, made when it has none
 * @returns {LoreSelection} The new selection, locked nowhere
 * @throws {Error} When the book has no selection of that ID
 */
export function newLoreSelection(bookName, sourceSelectionId) {
    const source = sourceSelectionId ? getLoreSelection(bookName, sourceSelectionId) : ensureLoreSelection(bookName);
    const { selections } = recordFor(bookName);
    const selection = {
        ...emptySelection(newTimeId(selections.map(item => item.id)), numberedName(bookName, selections.map(item => item.name))),
        selectedUids: [...source.selectedUids],
        pinnedSections: [...source.pinnedSections],
    };
    selections.push(selection);
    saveSettingsDebounced();
    return selection;
}

/**
 * Rename one of a book's selections.
 * @param {string} bookName
 * @param {string} selectionId
 * @param {string} name
 * @throws {Error} With nothing in the name, or no such selection
 */
export function renameLoreSelection(bookName, selectionId, name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('A selection needs a name.');
    getLoreSelection(bookName, selectionId).name = trimmed;
    saveSettingsDebounced();
}

/**
 * Delete one of a book's selections, with its selected entries, pinned sections and locks; the vectors of the entries
 * no other selection holds go with the book's next prune (pruneBookVectors). A book's last selection stays: Remove from
 * LoreBase removes the book.
 * @param {string} bookName
 * @param {string} selectionId
 * @throws {Error} For the book's last selection, or no such selection
 */
export function deleteLoreSelection(bookName, selectionId) {
    const selection = getLoreSelection(bookName, selectionId);
    const { selections } = getLoreBook(bookName);
    if (selections.length === 1) throw new Error(`"${selection.name}" is the only selection of "${bookName}": Remove from LoreBase removes the book.`);
    selections.splice(selections.indexOf(selection), 1);
    saveSettingsDebounced();
}

/**
 * Set the entries LoreBase decides in a book while a selection is in use: a selected entry goes in only when LoreBase
 * picks it, Jev on Fast and Cheap [Jev] or Luna on High Accuracy (D14, D16). Every entry starts unselected (D3).
 * @param {string} bookName
 * @param {string} selectionId
 * @param {Iterable<string|number>} entryUids
 */
export function setLoreBookSelection(bookName, selectionId, entryUids) {
    getLoreSelection(bookName, selectionId).selectedUids = [...new Set([...entryUids].map(String))];
    saveSettingsDebounced();
}

/**
 * Set a selection's section names whose parts are kept whenever their entry is picked, whatever its review says (D10).
 * @param {string} bookName
 * @param {string} selectionId
 * @param {Iterable<string>} sectionNames
 */
export function setLoreBookPins(bookName, selectionId, sectionNames) {
    getLoreSelection(bookName, selectionId).pinnedSections = [...new Set([...sectionNames].map(name => String(name).trim()).filter(Boolean))];
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
 * Lock a selection to a chat or a character, or unlock it: every lock of a selection goes through here. The lock is the
 * master switch (D11): a book takes part only where SillyTavern has it active and one of its selections is locked.
 * Locking a selection takes that chat's or character's lock off the book's other selections (oneInUseLockChanges), so
 * a chat or a character uses one selection of a book. A character is named by its avatar file name, which stays the
 * same when characters are added or deleted, where its place in SillyTavern's character list does not.
 * @param {string} bookName
 * @param {string} selectionId
 * @param {{chatId?: string|null, characterAvatar?: string|null}} where - The places to lock it to or unlock it from
 * @param {boolean} isLocked
 * @throws {Error} When the book has no such selection
 */
export function setLoreSelectionLock(bookName, selectionId, where, isLocked) {
    const chosen = getLoreSelection(bookName, selectionId);
    const selections = loreSelectionsOf(bookName);
    for (const [placeName, list] of Object.entries(LOCK_LISTS)) {
        if (where[placeName] === undefined || where[placeName] === null) continue;
        const place = String(where[placeName]);
        if (!isLocked) {
            chosen[list] = chosen[list].filter(item => item !== place);
            continue;
        }
        const { lockIds, unlockIds } = oneInUseLockChanges(
            selections.map(selection => ({ id: selection.id, isLockedHere: selection[list].includes(place) })), selectionId);
        for (const selection of selections) {
            if (lockIds.includes(selection.id)) selection[list] = [...selection[list], place];
            if (unlockIds.includes(selection.id)) selection[list] = selection[list].filter(item => item !== place);
        }
    }
    saveSettingsDebounced();
}

/**
 * Delete a book's record, with its selections and seen entries: the last step of Remove from LoreBase (removeLoreBook
 * in lorebase-storage.js), once the book's keys and vectors are deleted. Saves only when the book had a record.
 * @param {string} bookName
 */
export function deleteLoreBookRecord(bookName) {
    const books = extension_settings.vectfox[BOOKS_KEY];
    if (!books || !Object.hasOwn(books, bookName)) return;
    delete books[bookName];
    saveSettingsDebounced();
}

// Every selection of every book, for the functions that act on the locks of all of them.
const everySelection = () => Object.values(extension_settings.vectfox[BOOKS_KEY] ?? {})
    .flatMap(record => (Array.isArray(record?.selections) ? record.selections : []));

/**
 * Move every selection's lock on one chat or character to its new name, saving only when a lock moved.
 * @returns {boolean} Whether a lock moved
 */
function moveLocks(lockList, oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    let hasMoved = false;
    for (const selection of everySelection()) {
        if (!selection[lockList].includes(oldName)) continue;
        selection[lockList] = [...new Set(selection[lockList].map(name => (name === oldName ? newName : name)))];
        hasMoved = true;
    }
    if (hasMoved) saveSettingsDebounced();
    return hasMoved;
}

const chatLocksMovedListeners = new Set();

/**
 * Call `listener` each time a chat's rename moved a selection's lock to the chat's new name. SillyTavern opens the
 * renamed chat (CHAT_CHANGED) before it says the chat was renamed (CHAT_RENAMED), so a page drawn for the chat then
 * showed the lock still on the old name.
 * @param {() => void} listener
 * @returns {() => void} Stops the calls
 */
export function onLoreBookChatLocksMoved(listener) {
    chatLocksMovedListeners.add(listener);
    return () => chatLocksMovedListeners.delete(listener);
}

/**
 * Keep every selection's locks on a character SillyTavern renamed: the rename gives it a new avatar file name, and
 * SillyTavern moves its own per-character settings (tags, extra lorebooks, the character's Author's Note) the same way.
 * @param {string} oldAvatar
 * @param {string} newAvatar
 */
export function renameLoreBookCharacter(oldAvatar, newAvatar) {
    moveLocks(LOCK_LISTS.characterAvatar, oldAvatar, newAvatar);
}

/**
 * Keep every selection's locks on a chat SillyTavern renamed: a chat lock holds the chat's file name, which the rename
 * changes.
 * @param {string} oldChatId
 * @param {string} newChatId
 */
export function renameLoreBookChat(oldChatId, newChatId) {
    if (!moveLocks(LOCK_LISTS.chatId, oldChatId, newChatId)) return;
    for (const listener of chatLocksMovedListeners) {
        try {
            listener();
        } catch (error) {
            log.warn("LoreBase: a listener to a chat rename's moved locks failed:", error);
        }
    }
}

/**
 * Clean up locks, LoreBase's part (§1.1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): count,
 * and with `shouldApply` remove, each selection's locks on a chat or a character that no longer exists. A null test
 * judges no lock of its kind: the chat list could not be read whole, or no character list is loaded. Saves only when a
 * lock goes.
 * @param {{isChatPresent: ((chatId: string) => boolean)|null, isCharacterPresent: ((avatar: string) => boolean)|null}} targets
 * @param {{shouldApply: boolean}} options
 * @returns {{goneChatLockCount: number, goneCharacterLockCount: number}}
 */
export function cleanUpLoreBookLocks({ isChatPresent, isCharacterPresent }, { shouldApply }) {
    let goneChatLockCount = 0;
    let goneCharacterLockCount = 0;
    for (const selection of everySelection()) {
        if (!selection || typeof selection !== 'object') continue;
        const chatLocks = Array.isArray(selection.lockedToChatIds) ? selection.lockedToChatIds : [];
        const characterLocks = Array.isArray(selection.lockedToCharacterAvatars) ? selection.lockedToCharacterAvatars : [];
        const keptChats = isChatPresent ? chatLocks.filter(chatId => isChatPresent(String(chatId))) : chatLocks;
        const keptCharacters = isCharacterPresent ? characterLocks.filter(avatar => isCharacterPresent(String(avatar))) : characterLocks;
        goneChatLockCount += chatLocks.length - keptChats.length;
        goneCharacterLockCount += characterLocks.length - keptCharacters.length;
        if (!shouldApply) continue;
        if (keptChats.length < chatLocks.length) selection.lockedToChatIds = keptChats;
        if (keptCharacters.length < characterLocks.length) selection.lockedToCharacterAvatars = keptCharacters;
    }
    if (shouldApply && (goneChatLockCount || goneCharacterLockCount)) saveSettingsDebounced();
    return { goneChatLockCount, goneCharacterLockCount };
}
