/**
 * The open chat's lorebooks, as SillyTavern's World Info scan loads them (world-info.js, getSortedEntries), and what
 * a book's selection can be locked to there: the open chat and its character (plan §5.2, §5.8 and D11 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md). The reply, the selection screen and the
 * WorldInfo page read them, each book through the selection in use here (§3.7 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md), which the page's switcher changes or makes anew; and a key run locks the books
 * it writes keys for to the chat it started in (§6.1 of InternalProject/Vectfox/plans/lorebook-multi-vector.md). Add a
 * lorebook adds a book the chat does not load, as its Chat Lorebook or to its character's Additional Lorebooks, through
 * SillyTavern's own places, and locks it where it was added (§6 of lorebook-multi-vector.md); the WorldInfo page's Unlink
 * takes a book out of those again, and out of SillyTavern's global list (§3.6 of vectfox-multi-collection-per-chat.md).
 */
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { getCharaFilename } from '../../sillytavern/identifiers.js';
import { log } from '../../sillytavern/log.js';
import {
    METADATA_KEY, addCharacterLorebook, addChatLorebook, getWorldInfoSettings, removeCharacterLorebook, removeChatLorebook,
    removeGlobalLorebook, selected_world_info, world_names,
} from '../../sillytavern/world-info.js';
import {
    decidedCountOf, ensureLoreSelection, getLoreBook, loreSelectionsOf, newLoreSelection, selectionInUse, setLoreSelectionLock,
} from './lorebase-books.js';
import { activeBookNames } from './lorebase-reply-core.js';
import { isSelectionLockedTo, unionOfSelections } from './lorebase-selections-core.js';

// The places SillyTavern's World Info scan loads the open chat's books from, in its order, and those the WorldInfo
// page's Unlink takes a book out of: the two Add a lorebook links a book through, the chat's Chat Lorebook and the
// character's Additional Lorebooks, and the global list. The character's own lorebook and the persona's reach other
// chats, so they stay SillyTavern's to change, and a book only they load has no Unlink.
const CHAT_BOOK_PLACES = ['globalList', 'characterBooks', 'characterOwnBook', 'chatBook', 'personaBook'];
const UNLINKABLE_PLACES = new Set(['globalList', 'characterBooks', 'chatBook']);

/**
 * The books each place loads for the open chat: the global list, the character's Additional Lorebooks and own book, the
 * chat's and the persona's; and the character's file name, which keys its Additional Lorebooks.
 */
function chatBookPlaces() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    const characterFileName = getCharaFilename(context.characterId);
    return {
        characterFileName,
        globalList: [...selected_world_info],
        characterBooks: getWorldInfoSettings().world_info?.charLore?.find(item => item.name === characterFileName)?.extraBooks ?? [],
        characterOwnBook: character?.data?.extensions?.world || null,
        chatBook: context.chatMetadata?.[METADATA_KEY] || null,
        personaBook: context.powerUserSettings?.persona_description_lorebook || null,
    };
}

/**
 * The books SillyTavern loads for the open chat, each once, in the order its scan loads them.
 * @returns {string[]}
 */
export function chatBookNames() {
    const places = chatBookPlaces();
    return activeBookNames({
        globalBooks: places.globalList,
        characterBooks: [places.characterOwnBook, ...places.characterBooks].filter(Boolean),
        chatBook: places.chatBook,
        personaBook: places.personaBook,
    });
}

/** The places that load a book for the open chat, in the scan's order. */
function placesLoading(bookName) {
    const places = chatBookPlaces();
    return CHAT_BOOK_PLACES.filter(place => (Array.isArray(places[place]) ? places[place].includes(bookName) : places[place] === bookName));
}

/**
 * What the WorldInfo page's Unlink does to the open chat's lists for a book (§3.6 of
 * vectfox-multi-collection-per-chat.md): the places it unlinks the book from (UNLINKABLE_PLACES), and those it leaves
 * to SillyTavern, which keep loading it: the character's own lorebook and the persona's. Each place by its name in
 * CHAT_BOOK_PLACES.
 * @param {string} bookName
 * @returns {{unlinkedFrom: string[], stillLoadedBy: string[]}}
 */
export function chatBookLinks(bookName) {
    const loading = placesLoading(bookName);
    return { unlinkedFrom: loading.filter(place => UNLINKABLE_PLACES.has(place)), stillLoadedBy: loading.filter(place => !UNLINKABLE_PLACES.has(place)) };
}

/**
 * Unlink a book from the open chat: take it out of the open character's Additional Lorebooks and SillyTavern's global
 * list, and off the open chat as its Chat Lorebook, wherever the chat loads it from them (chatBookLinks), through
 * SillyTavern's own lists. A list SillyTavern did not take it out of is among the places that still load it, and the
 * console says why.
 * @param {string} bookName
 * @returns {Promise<{unlinkedFrom: string[], stillLoadedBy: string[]}>} The places it went from, and those still loading it
 */
export async function unlinkLoreBookFromChat(bookName) {
    const { unlinkedFrom: places } = chatBookLinks(bookName);
    if (places.includes('characterBooks')) removeCharacterLorebook(chatBookPlaces().characterFileName, bookName);
    if (places.includes('globalList')) {
        try {
            removeGlobalLorebook(bookName);
        } catch (error) {
            log.warn(`LoreBase: lorebook "${bookName}" could not be taken out of SillyTavern's global list:`, error);
        }
    }
    if (places.includes('chatBook')) await removeChatLorebook(bookName);
    const stillLoadedBy = placesLoading(bookName);
    return { unlinkedFrom: places.filter(place => !stillLoadedBy.includes(place)), stillLoadedBy };
}

/**
 * What a book can be locked to here: the open chat, and its character by its avatar file name, with that character's
 * name. SillyTavern keys its own per-character settings by the avatar file name, which stays the same when characters
 * are added or deleted, where the character's place in its list does not. Each is null when there is none, as in a
 * group chat for the character.
 * @returns {{chatId: string|null, characterAvatar: string|null, characterName: string}}
 */
export function lockTarget() {
    const context = getContext();
    const character = context.characterId === undefined || context.characterId === null ? null : context.characters?.[context.characterId];
    return {
        chatId: getCurrentChatId() ?? null,
        characterAvatar: character?.avatar ? String(character.avatar) : null,
        characterName: character ? String(character.name ?? '') : '',
    };
}

/**
 * Where a key run locks the books it writes keys for (§6.1 of lorebook-multi-vector.md): the chat open as the run
 * starts, its character, and the books that chat loads, read then, so that a chat opened while the run goes is never
 * the one locked. Null with no chat open.
 * @param {Iterable<string>} [booksWithChosenLocks] - Books whose lock the user set on the selection screen that started
 *   the run: they keep the locks the user set
 * @returns {{chatId: string, characterAvatar: string|null, lockableBookNames: Set<string>}|null}
 */
export function keyRunLockPlace(booksWithChosenLocks = []) {
    const { chatId, characterAvatar } = lockTarget();
    if (!chatId) return null;
    const chosen = new Set(booksWithChosenLocks);
    return { chatId, characterAvatar, lockableBookNames: new Set(chatBookNames().filter(bookName => !chosen.has(bookName))) };
}

/**
 * Lock each book a key run wrote keys for to the chat the run started in (§6.1 of lorebook-multi-vector.md): its one
 * selection, when that chat loads the book and uses no selection of it, locked neither to the chat nor to its character.
 * A book with more than one selection stays as the user set it, as New selection locks the one it makes (§3.7 of
 * vectfox-multi-collection-per-chat.md).
 * @param {ReturnType<typeof keyRunLockPlace>} place - Read as the run started; null locks nothing
 * @param {string[]} keyedBookNames - The books the run wrote at least one entry's keys for
 * @returns {{chatId: string, bookNames: string[]}|null} The chat and the books locked to it, or null when none was
 */
export function lockKeyedBooks(place, keyedBookNames) {
    if (!place) return null;
    const where = { chatId: place.chatId, characterAvatar: place.characterAvatar };
    const bookNames = keyedBookNames.filter(bookName => place.lockableBookNames.has(bookName)
        && loreSelectionsOf(bookName).length === 1 && !selectionInUse(bookName, where));
    for (const bookName of bookNames) setLoreSelectionLock(bookName, loreSelectionsOf(bookName)[0].id, { chatId: place.chatId }, true);
    return bookNames.length ? { chatId: place.chatId, bookNames } : null;
}

// Where Add a lorebook adds a book (§6 and Q1 of lorebook-multi-vector.md): the open chat, as its Chat Lorebook, or the
// open character's Additional Lorebooks. The WorldInfo page's Add buttons carry these values.
export const ADD_TO_CHAT = 'chat';
export const ADD_TO_CHARACTER = 'character';

/**
 * What Add a lorebook offers in the open chat (§6 of lorebook-multi-vector.md): every book SillyTavern has that the
 * chat does not load, in SillyTavern's order, and whether the chat has one character to add a book to, which a group
 * chat has not.
 * @returns {{bookNames: string[], canAddToCharacter: boolean}}
 */
export function booksToAdd() {
    const loaded = new Set(chatBookNames());
    return { bookNames: world_names.filter(bookName => !loaded.has(bookName)), canAddToCharacter: Boolean(lockTarget().characterAvatar) };
}

/**
 * Add a lorebook the open chat does not load (§6 of lorebook-multi-vector.md): link it through SillyTavern's own
 * places, to the open chat as its Chat Lorebook or to the open character's Additional Lorebooks, then lock its first
 * selection, made with nothing selected while it has none, where it was added: to this chat, or to the character, so
 * LoreBase decides its entries here once they are chosen. A chat has one Chat Lorebook, so one SillyTavern loads already
 * is never replaced.
 * @param {string} bookName - One of booksToAdd's
 * @param {string} place - ADD_TO_CHAT or ADD_TO_CHARACTER
 * @returns {Promise<{chatId?: string, characterAvatar?: string}>} Where the book was locked
 * @throws {Error} With no chat open, a place it does not know, a book SillyTavern lacks or the chat already loads, the
 *   character asked for in a group chat, a chat with its Chat Lorebook already, or a link SillyTavern did not make; then
 *   it links and locks nothing
 */
export async function addLoreBookToChat(bookName, place) {
    const { chatId, characterAvatar } = lockTarget();
    if (!chatId) throw new Error('Open a chat to add a lorebook to it.');
    if (place !== ADD_TO_CHAT && place !== ADD_TO_CHARACTER) throw new Error(`Add a lorebook has no place called "${place}".`);
    if (!world_names.includes(bookName)) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    if (chatBookNames().includes(bookName)) throw new Error(`This chat already loads "${bookName}".`);
    const isToCharacter = place === ADD_TO_CHARACTER;
    if (isToCharacter && !characterAvatar) throw new Error('A group chat has no one character to add a lorebook to: add it to this chat.');
    const chatLorebook = chatBookPlaces().chatBook;
    if (!isToCharacter && chatLorebook && world_names.includes(chatLorebook)) {
        const elsewhere = characterAvatar ? `add "${bookName}" to this character instead` : "change it at SillyTavern's Chat Lore button";
        throw new Error(`This chat's Chat Lorebook is "${chatLorebook}" already, and a chat has one: ${elsewhere}.`);
    }
    if (isToCharacter) await addCharacterLorebook(characterAvatar, bookName);
    else await addChatLorebook(bookName);
    if (!chatBookNames().includes(bookName)) {
        throw new Error(`SillyTavern did not add "${bookName}" to ${isToCharacter ? "this character's lorebooks" : 'this chat'}.`);
    }
    const lock = isToCharacter ? { characterAvatar } : { chatId };
    setLoreSelectionLock(bookName, ensureLoreSelection(bookName).id, lock, true);
    return lock;
}

/**
 * The open chat's books as the WorldInfo page lists them: each book SillyTavern loads here and has, its selections and
 * the one in use here (§3.7 of vectfox-multi-collection-per-chat.md), how many of that one's selected entries LoreBase
 * decides, or of every entry its selections hold while none is in use (decidedCountOf), whether that one is locked to
 * this chat or to its character, where LoreBase decides them (D11), and whether its row offers Unlink: a list Unlink
 * takes books out of loads it here (chatBookLinks). Whether a row has Remove from LoreBase is the listing's to say
 * (removableLoreBookNames in lorebase-storage.js).
 * @returns {Promise<{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean, selections: Array<{id: string, name: string}>, selectionInUseId: string|null,
 *   canUnlink: boolean}>}>}
 */
export async function chatBookLocks() {
    const where = lockTarget();
    const known = new Set(world_names);
    const bookNames = chatBookNames().filter(bookName => known.has(bookName));
    const inUse = bookNames.map(bookName => selectionInUse(bookName, where));
    const counts = await Promise.all(bookNames.map((bookName, index) => decidedCountOf(bookName, inUse[index] ?? unionOfSelections(getLoreBook(bookName)))));
    return {
        hasChat: Boolean(where.chatId),
        books: bookNames.map((bookName, index) => ({
            bookName,
            selectedCount: counts[index],
            isLockedToChat: Boolean(inUse[index]) && isSelectionLockedTo(inUse[index], { chatId: where.chatId }),
            isLockedToCharacter: Boolean(inUse[index]) && isSelectionLockedTo(inUse[index], { characterAvatar: where.characterAvatar }),
            selections: loreSelectionsOf(bookName).map(({ id, name }) => ({ id, name })),
            selectionInUseId: inUse[index]?.id ?? null,
            canUnlink: chatBookLinks(bookName).unlinkedFrom.length > 0,
        })),
    };
}

/**
 * Put one of a book's selections in use in the open chat, as the WorldInfo page's switcher does (§1.2 of
 * vectfox-multi-collection-per-chat.md): lock it to the chat, which unlocks the book's other selections there.
 * @param {string} bookName
 * @param {string} selectionId
 * @throws {Error} With no chat open, or no such selection
 */
export function useLoreSelectionHere(bookName, selectionId) {
    const { chatId } = lockTarget();
    if (!chatId) throw new Error('Open a chat to choose the selection it uses.');
    setLoreSelectionLock(bookName, selectionId, { chatId }, true);
}

/**
 * New selection (§3.7 of vectfox-multi-collection-per-chat.md): a copy of a selection of the book, the one in use here
 * unless another is named, else of the book's first; on a book with none, as after its trash, its first, named after it
 * with nothing selected, as Choose entries makes it. Put in use in the open chat; with no chat open it is locked nowhere.
 * @param {string} bookName
 * @param {string|null} [sourceSelectionId] - The selection to copy, the selection screen's; the one in use here when null
 * @returns {import('./lorebase-selections-core.js').LoreSelection}
 */
export function newLoreSelectionHere(bookName, sourceSelectionId = null) {
    const where = lockTarget();
    const selection = loreSelectionsOf(bookName).length
        ? newLoreSelection(bookName, sourceSelectionId ?? selectionInUse(bookName, where)?.id ?? null)
        : ensureLoreSelection(bookName);
    if (where.chatId) setLoreSelectionLock(bookName, selection.id, { chatId: where.chatId }, true);
    return selection;
}
