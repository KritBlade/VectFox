/**
 * The open chat's lorebooks, as a World Info scan loads them (world-info.js, getSortedEntries): those SillyTavern loads
 * from its own places, then the books added to the chat through LoreBase's Add to this chat, which LoreBase adds to the
 * scan while it acts (lorebase-delivery.js, L1 of InternalProject/Vectfox/plans/entity-lore.md); and what a book's
 * selection can be locked to there: the open chat and its character (plan §5.2, §5.8 and D11 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md). The reply, the selection screen and the
 * WorldInfo page read them, each book through the selection in use here (§3.7 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md), which the page's switcher changes or makes anew; and a key run locks the books
 * it writes keys for to the chat it started in (§6.1 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md). Add a
 * lorebook adds a book the chat does not load, to this chat on LoreBase's own list of the chat's books, which holds any
 * number, or to its character's Additional Lorebooks through SillyTavern's own place, and locks it where it was added
 * (§6 of lorebook-multi-vector.md); the WorldInfo page's Unlink takes a book out of those again, and out of SillyTavern's
 * Chat Lorebook and global list (§3.6 of vectfox-multi-collection-per-chat.md).
 */
import { getContext, getCurrentChatId, saveChatMetadataField } from '../../sillytavern/chat.js';
import { getCharaFilename } from '../../sillytavern/identifiers.js';
import { log } from '../../sillytavern/log.js';
import {
    METADATA_KEY, addCharacterLorebook, characterLorebooks, removeCharacterLorebook, removeChatLorebook,
    removeGlobalLorebook, selected_world_info, world_names,
} from '../../sillytavern/world-info.js';
import {
    decidedCountOf, ensureLoreSelection, getLoreBook, loreSelectionsOf, newLoreSelection, selectionInUse, setLoreSelectionLock,
} from './lorebase-books.js';
import { activeBookNames } from './lorebase-reply-core.js';
import { isSelectionLockedTo, unionOfSelections } from './lorebase-selections-core.js';

// The places a World Info scan loads the open chat's books from, in their order: SillyTavern's own, then the books added
// to the chat through LoreBase (addedChatBookNames). And those the WorldInfo page's Unlink takes a book out of: the two
// Add a lorebook adds a book to, the chat's added books and the character's Additional Lorebooks, and SillyTavern's
// Chat Lorebook and global list. The character's own lorebook and the persona's reach other chats, so they stay
// SillyTavern's to change, and a book only they load has no Unlink.
const CHAT_BOOK_PLACES = ['globalList', 'characterBooks', 'characterOwnBook', 'chatBook', 'personaBook', 'addedChatBooks'];
const UNLINKABLE_PLACES = new Set(['globalList', 'characterBooks', 'chatBook', 'addedChatBooks']);
// The field of a chat's metadata that holds the books added to that chat through LoreBase's Add to this chat.
const ADDED_CHAT_BOOKS_KEY = 'vectfox_chat_lorebooks';

/**
 * The books added to the open chat through LoreBase's Add to this chat (L1 of entity-lore.md), in the order they were
 * added: LoreBase's own list beside SillyTavern's one Chat Lorebook, any number of them, kept in the chat's metadata, so
 * each chat, a group chat too, has its own, and a branch copies its chat's. A scan loads them only while LoreBase acts
 * (lorebase-delivery.js), so with LoreBase off nothing of them is sent. What in the field is no book name is skipped.
 * @returns {string[]}
 */
export function addedChatBookNames() {
    const names = getContext()?.chatMetadata?.[ADDED_CHAT_BOOKS_KEY];
    return Array.isArray(names) ? [...new Set(names.filter(name => typeof name === 'string' && name))] : [];
}

/** Save the open chat's added books with the chat; the field goes with the last of them. */
async function saveAddedChatBookNames(bookNames) {
    await saveChatMetadataField(ADDED_CHAT_BOOKS_KEY, bookNames.length ? bookNames : undefined);
}

/**
 * The characters whose own lorebook and Additional Lorebooks the open chat loads: the chat's character; in a group
 * chat, the member SillyTavern drafted for the reply it writes now, as its scan loads that member's books alone, and
 * between replies every member not muted, in the group's order, so the WorldInfo page, the selection screen and Try a
 * pick show each member's books and locks, which count on that member's turn. Each by its avatar file name, its name,
 * its file name (which keys its Additional Lorebooks), its own book and its Additional Lorebooks, and its card's
 * description, which Entity-Lore reads for the names the card already holds.
 * @returns {Array<{avatar: string, name: string, fileName: string, ownBook: string|null, extraBooks: string[], description: string}>}
 */
export function chatCharacters() {
    const context = getContext();
    const characterOf = character => {
        const avatar = String(character.avatar);
        const fileName = getCharaFilename(null, { manualAvatarKey: avatar });
        return {
            avatar, name: String(character.name ?? ''), fileName, ownBook: character.data?.extensions?.world || null, extraBooks: characterLorebooks(fileName),
            description: String(character.description ?? ''),
        };
    };
    const drafted = context.characterId === undefined || context.characterId === null ? null : context.characters?.[context.characterId];
    if (drafted?.avatar) return [characterOf(drafted)];
    const group = context.groupId ? context.groups?.find(item => item.id === context.groupId) : null;
    const muted = new Set(group?.disabled_members ?? []);
    const characters = Object.values(context.characters ?? {});
    return (group?.members ?? []).filter(avatar => !muted.has(avatar))
        .map(avatar => characters.find(character => character?.avatar === avatar)).filter(character => character?.avatar).map(characterOf);
}

/**
 * The books each place loads for the open chat: the global list, the Additional Lorebooks and own lorebooks of its
 * characters (chatCharacters), the chat's and the persona's, and the books added to the chat through LoreBase; and those
 * characters. Read from SillyTavern each time, so a book the user binds in SillyTavern counts at once.
 */
function chatBookPlaces() {
    const context = getContext();
    const characters = chatCharacters();
    return {
        characters,
        globalList: [...selected_world_info],
        characterBooks: [...new Set(characters.flatMap(character => character.extraBooks))],
        characterOwnBook: [...new Set(characters.map(character => character.ownBook).filter(Boolean))],
        chatBook: context.chatMetadata?.[METADATA_KEY] || null,
        personaBook: context.powerUserSettings?.persona_description_lorebook || null,
        addedChatBooks: addedChatBookNames(),
    };
}

/**
 * The books a scan loads for the open chat, each once, in their order: SillyTavern's, between replies in a group chat
 * every member's (chatCharacters), then the books added to it through LoreBase that SillyTavern has, which load only
 * while LoreBase acts.
 * @returns {string[]}
 */
export function chatBookNames() {
    const places = chatBookPlaces();
    return activeBookNames({
        globalBooks: places.globalList,
        characterBooks: places.characters.flatMap(character => [character.ownBook, ...character.extraBooks]).filter(Boolean),
        chatBook: places.chatBook,
        personaBook: places.personaBook,
        addedBooks: places.addedChatBooks.filter(bookName => world_names.includes(bookName)),
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
 * Unlink a book from the open chat: take it off the chat's books added through LoreBase, and out of the Additional
 * Lorebooks of the chat's characters that list it, in a group chat each member's, SillyTavern's global list, and off the
 * open chat as its Chat Lorebook, wherever the chat loads it from them (chatBookLinks), SillyTavern's through its own
 * lists. A list SillyTavern did not take it out of is among the places that still load it, and the console says why.
 * @param {string} bookName
 * @returns {Promise<{unlinkedFrom: string[], stillLoadedBy: string[]}>} The places it went from, and those still loading it
 */
export async function unlinkLoreBookFromChat(bookName) {
    const { unlinkedFrom: places } = chatBookLinks(bookName);
    if (places.includes('characterBooks')) {
        for (const character of chatCharacters().filter(each => each.extraBooks.includes(bookName))) removeCharacterLorebook(character.fileName, bookName);
    }
    if (places.includes('globalList')) {
        try {
            removeGlobalLorebook(bookName);
        } catch (error) {
            log.warn(`LoreBase: lorebook "${bookName}" could not be taken out of SillyTavern's global list:`, error);
        }
    }
    if (places.includes('chatBook')) await removeChatLorebook(bookName);
    if (places.includes('addedChatBooks')) await saveAddedChatBookNames(addedChatBookNames().filter(name => name !== bookName));
    const stillLoadedBy = placesLoading(bookName);
    return { unlinkedFrom: places.filter(place => !stillLoadedBy.includes(place)), stillLoadedBy };
}

/**
 * The open chat and its one character, by its avatar file name, with that character's name: what Add a lorebook adds
 * to. SillyTavern keys its own per-character settings by the avatar file name, which stays the same when characters are
 * added or deleted, where the character's place in its list does not. Each is null when there is none, as in a group
 * chat between replies for the character; a book's own "here" is whereFor's.
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
 * Where a book's selection is in use here (D11): the open chat, and the character the chat loads the book through, by
 * its avatar file name and name: the chat's character, or in a group chat the member SillyTavern drafted for the reply
 * it writes now; between replies, the first member whose own lorebook or Additional Lorebooks load the book, none for a
 * book another place loads. The one "here" of a book: the selection in use (selectionInUseHere), its row's locks, the
 * selection screen's lock switches and the locks a key run sets go by it.
 * @param {string} bookName
 * @returns {{chatId: string|null, characterAvatar: string|null, characterName: string}}
 */
export function whereFor(bookName) {
    const target = lockTarget();
    if (target.characterAvatar || !target.chatId) return target;
    const member = chatCharacters().find(character => character.ownBook === bookName || character.extraBooks.includes(bookName));
    return { chatId: target.chatId, characterAvatar: member?.avatar ?? null, characterName: member?.name ?? '' };
}

/**
 * The selection of a book the open chat uses (selectionInUse where whereFor says): the one route every reader of it
 * takes, the reply, the scan, the WorldInfo page, the selection screen and New selection alike.
 * @param {string} bookName
 * @returns {import('./lorebase-selections-core.js').LoreSelection|null}
 */
export function selectionInUseHere(bookName) {
    return selectionInUse(bookName, whereFor(bookName));
}

/**
 * Where a key run locks the books it writes keys for (§6.1 of lorebook-multi-vector.md): the chat open as the run
 * starts, and each book that chat loads with where its selection is in use (whereFor), read then, so that a chat opened
 * while the run goes is never the one locked. Null with no chat open.
 * @param {Iterable<string>} [booksWithChosenLocks] - Books whose lock the user set on the selection screen that started
 *   the run: they keep the locks the user set
 * @returns {{chatId: string, whereByBook: Map<string, ReturnType<typeof whereFor>>}|null}
 */
export function keyRunLockPlace(booksWithChosenLocks = []) {
    const { chatId } = lockTarget();
    if (!chatId) return null;
    const chosen = new Set(booksWithChosenLocks);
    return { chatId, whereByBook: new Map(chatBookNames().filter(bookName => !chosen.has(bookName)).map(bookName => [bookName, whereFor(bookName)])) };
}

/**
 * Lock each book a key run wrote keys for to the chat the run started in (§6.1 of lorebook-multi-vector.md): its one
 * selection, when that chat loads the book and uses no selection of it, locked neither to the chat nor to the character
 * it loads the book through. A book with more than one selection stays as the user set it, as New selection locks the
 * one it makes (§3.7 of vectfox-multi-collection-per-chat.md).
 * @param {ReturnType<typeof keyRunLockPlace>} place - Read as the run started; null locks nothing
 * @param {string[]} keyedBookNames - The books the run wrote at least one entry's keys for
 * @returns {{chatId: string, bookNames: string[]}|null} The chat and the books locked to it, or null when none was
 */
export function lockKeyedBooks(place, keyedBookNames) {
    if (!place) return null;
    const bookNames = keyedBookNames.filter(bookName => place.whereByBook.has(bookName)
        && loreSelectionsOf(bookName).length === 1 && !selectionInUse(bookName, place.whereByBook.get(bookName)));
    for (const bookName of bookNames) setLoreSelectionLock(bookName, loreSelectionsOf(bookName)[0].id, { chatId: place.chatId }, true);
    return bookNames.length ? { chatId: place.chatId, bookNames } : null;
}

// Where Add a lorebook adds a book (§6 and Q1 of lorebook-multi-vector.md, L1 of entity-lore.md): the open chat, on
// LoreBase's own list of its books, or the open character's Additional Lorebooks. The WorldInfo page's Add buttons carry
// these values.
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
 * Add a lorebook the open chat does not load (§6 of lorebook-multi-vector.md, L1 of entity-lore.md): to this chat, on
 * LoreBase's own list of the chat's books (addedChatBookNames), which holds any number and leaves SillyTavern's one Chat
 * Lorebook to the user; or to the open character's Additional Lorebooks, through SillyTavern's own place. Then lock its
 * first selection, made with nothing selected while it has none, where it was added: to this chat, or to the
 * character, so LoreBase decides its entries here once they are chosen. A book added to this chat loads only while
 * LoreBase acts.
 * @param {string} bookName - One of booksToAdd's
 * @param {string} place - ADD_TO_CHAT or ADD_TO_CHARACTER
 * @returns {Promise<{chatId?: string, characterAvatar?: string}>} Where the book was locked
 * @throws {Error} With no chat open, a place it does not know, a book SillyTavern lacks or the chat already loads, the
 *   character asked for in a group chat, or a book that did not reach the place it was added to; then it locks nothing
 */
export async function addLoreBookToChat(bookName, place) {
    const { chatId, characterAvatar } = lockTarget();
    if (!chatId) throw new Error('Open a chat to add a lorebook to it.');
    if (place !== ADD_TO_CHAT && place !== ADD_TO_CHARACTER) throw new Error(`Add a lorebook has no place called "${place}".`);
    if (!world_names.includes(bookName)) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    if (chatBookNames().includes(bookName)) throw new Error(`This chat already loads "${bookName}".`);
    const isToCharacter = place === ADD_TO_CHARACTER;
    if (isToCharacter && !characterAvatar) throw new Error('A group chat has no one character to add a lorebook to: add it to this chat.');
    if (isToCharacter) await addCharacterLorebook(characterAvatar, bookName);
    else await saveAddedChatBookNames([...addedChatBookNames(), bookName]);
    if (!chatBookNames().includes(bookName)) {
        throw new Error(isToCharacter ? `SillyTavern did not add "${bookName}" to this character's lorebooks.` : `"${bookName}" did not reach this chat's books.`);
    }
    const lock = isToCharacter ? { characterAvatar } : { chatId };
    setLoreSelectionLock(bookName, ensureLoreSelection(bookName).id, lock, true);
    return lock;
}

/**
 * The open chat's books as the WorldInfo page lists them: each book a scan loads here and SillyTavern has, its
 * selections and the one in use here (§3.7 of vectfox-multi-collection-per-chat.md), how many of that one's selected
 * entries LoreBase decides, or of every entry its selections hold while none is in use (decidedCountOf), whether that
 * one is locked to this chat or to its character, where LoreBase decides them (D11), whether its row offers Unlink: a
 * list Unlink takes books out of loads it here (chatBookLinks), and whether only the chat's books added through LoreBase
 * load it, so it loads while LoreBase acts alone (L1 of entity-lore.md). Then each book added to the chat that
 * SillyTavern no longer has, as renamed or deleted there, missing, with Unlink to take it off. Whether a row has Remove
 * from LoreBase is the listing's to say (removableLoreBookNames in lorebase-storage.js).
 * @returns {Promise<{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean, selections: Array<{id: string, name: string}>, selectionInUseId: string|null,
 *   canUnlink: boolean, isAddedToChat: boolean, isMissing: boolean}>}>}
 */
export async function chatBookLocks() {
    const known = new Set(world_names);
    const bookNames = chatBookNames().filter(bookName => known.has(bookName));
    const wheres = bookNames.map(whereFor);
    const inUse = bookNames.map(selectionInUseHere);
    const counts = await Promise.all(bookNames.map((bookName, index) => decidedCountOf(bookName, inUse[index] ?? unionOfSelections(getLoreBook(bookName)))));
    const isLoadedByAddingAlone = bookName => placesLoading(bookName).join() === 'addedChatBooks';
    const missingBook = bookName => ({
        bookName, selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, selections: [], selectionInUseId: null,
        canUnlink: true, isAddedToChat: true, isMissing: true,
    });
    return {
        hasChat: Boolean(lockTarget().chatId),
        books: [
            ...bookNames.map((bookName, index) => ({
                bookName,
                selectedCount: counts[index],
                isLockedToChat: Boolean(inUse[index]) && isSelectionLockedTo(inUse[index], { chatId: wheres[index].chatId }),
                isLockedToCharacter: Boolean(inUse[index]) && isSelectionLockedTo(inUse[index], { characterAvatar: wheres[index].characterAvatar }),
                selections: loreSelectionsOf(bookName).map(({ id, name }) => ({ id, name })),
                selectionInUseId: inUse[index]?.id ?? null,
                canUnlink: chatBookLinks(bookName).unlinkedFrom.length > 0,
                isAddedToChat: isLoadedByAddingAlone(bookName),
                isMissing: false,
            })),
            ...addedChatBookNames().filter(bookName => !known.has(bookName)).map(missingBook),
        ],
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
    const { chatId } = lockTarget();
    const selection = loreSelectionsOf(bookName).length
        ? newLoreSelection(bookName, sourceSelectionId ?? selectionInUseHere(bookName)?.id ?? null)
        : ensureLoreSelection(bookName);
    if (chatId) setLoreSelectionLock(bookName, selection.id, { chatId }, true);
    return selection;
}
