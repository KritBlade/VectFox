/**
 * The open chat's lorebooks, as SillyTavern's World Info scan loads them (world-info.js, getSortedEntries), and what
 * a book can be locked to there: the open chat and its character (plan §5.2, §5.8 and D11 of InternalProject/Vectfox/
 * plans/lorebook-semantic-overhaul-passage-index.md). The reply, the selection screen and the WorldInfo page read them,
 * and a key run locks the books it writes keys for to the chat it started in (§6.1 of InternalProject/Vectfox/plans/
 * lorebook-multi-vector.md). Add a lorebook adds a book the chat does not load, through SillyTavern's own lists, and
 * locks it where it was added (§6 of lorebook-multi-vector.md).
 */
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { getCharaFilename } from '../../sillytavern/identifiers.js';
import { log } from '../../sillytavern/log.js';
import {
    METADATA_KEY, addCharacterLorebook, addGlobalLorebook, getWorldInfoSettings, selected_world_info, world_names,
} from '../../sillytavern/world-info.js';
import { getLoreBook, isLoreBookLocked, loadDecidedEntries, setLoreBookLock } from './lorebase-books.js';
import { activeBookNames } from './lorebase-reply-core.js';

/**
 * The books SillyTavern loads for the open chat, each once, in the order its scan loads them.
 * @returns {string[]}
 */
export function chatBookNames() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    const fileName = getCharaFilename(context.characterId);
    const extraBooks = getWorldInfoSettings().world_info?.charLore?.find(item => item.name === fileName)?.extraBooks ?? [];
    return activeBookNames({
        globalBooks: [...selected_world_info],
        characterBooks: [character?.data?.extensions?.world, ...extraBooks].filter(Boolean),
        chatBook: context.chatMetadata?.[METADATA_KEY] || null,
        personaBook: context.powerUserSettings?.persona_description_lorebook || null,
    });
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
 * Lock each book a key run wrote keys for to the chat the run started in, when that chat loads it and it is locked to
 * neither that chat nor its character (§6.1 of lorebook-multi-vector.md).
 * @param {ReturnType<typeof keyRunLockPlace>} place - Read as the run started; null locks nothing
 * @param {string[]} keyedBookNames - The books the run wrote at least one entry's keys for
 * @returns {{chatId: string, bookNames: string[]}|null} The chat and the books locked to it, or null when none was
 */
export function lockKeyedBooks(place, keyedBookNames) {
    if (!place) return null;
    const where = { chatId: place.chatId, characterAvatar: place.characterAvatar };
    const bookNames = keyedBookNames.filter(bookName => place.lockableBookNames.has(bookName) && !isLoreBookLocked(bookName, where));
    for (const bookName of bookNames) setLoreBookLock(bookName, { chatId: place.chatId }, true);
    return bookNames.length ? { chatId: place.chatId, bookNames } : null;
}

// Where Add a lorebook adds a book (§6 and Q1 of lorebook-multi-vector.md): the open character's Additional
// Lorebooks, or SillyTavern's global list, which every chat loads. The WorldInfo page's Add buttons carry these values.
export const ADD_TO_CHARACTER = 'character';
export const ADD_TO_ALL_CHATS = 'all-chats';

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
 * lists, to the open character's Additional Lorebooks or to the global list every chat loads, then lock it where it was
 * added, to the character, or to this chat for all chats, so LoreBase decides its entries here once they are chosen.
 * @param {string} bookName - One of booksToAdd's
 * @param {string} place - ADD_TO_CHARACTER or ADD_TO_ALL_CHATS
 * @returns {Promise<{chatId?: string, characterAvatar?: string}>} Where the book was locked
 * @throws {Error} With no chat open, a place it does not know, a book SillyTavern lacks or the chat already loads, the
 *   character asked for in a group chat, or a link SillyTavern did not make; then it locks nothing
 */
export async function addLoreBookToChat(bookName, place) {
    const { chatId, characterAvatar } = lockTarget();
    if (!chatId) throw new Error('Open a chat to add a lorebook to it.');
    if (place !== ADD_TO_CHARACTER && place !== ADD_TO_ALL_CHATS) throw new Error(`Add a lorebook has no place called "${place}".`);
    if (!world_names.includes(bookName)) throw new Error(`SillyTavern has no lorebook named "${bookName}".`);
    if (chatBookNames().includes(bookName)) throw new Error(`This chat already loads "${bookName}".`);
    const isToCharacter = place === ADD_TO_CHARACTER;
    if (isToCharacter && !characterAvatar) throw new Error('A group chat has no one character to add a lorebook to: add it to all chats.');
    if (isToCharacter) await addCharacterLorebook(characterAvatar, bookName);
    else addGlobalLorebook(bookName);
    if (!chatBookNames().includes(bookName)) {
        throw new Error(`SillyTavern did not add "${bookName}" to ${isToCharacter ? "this character's lorebooks" : 'the lorebooks every chat loads'}.`);
    }
    const lock = isToCharacter ? { characterAvatar } : { chatId };
    setLoreBookLock(bookName, lock, true);
    return lock;
}

/**
 * How many selected entries LoreBase decides in a book (loadDecidedEntries), as the keys count reads them; a book that
 * cannot be loaded counts its saved selection, and the console says why.
 * @param {string} bookName
 * @returns {Promise<number>}
 */
async function decidedCountOf(bookName) {
    const record = getLoreBook(bookName);
    if (!record?.selectedUids.length) return 0;
    try {
        return (await loadDecidedEntries(bookName, record)).length;
    } catch (error) {
        log.warn(`LoreBase: lorebook "${bookName}" could not be loaded, so its row counts its saved selection:`, error);
        return record.selectedUids.length;
    }
}

/**
 * The open chat's books as the WorldInfo page lists them: each book SillyTavern loads here and has, how many of its
 * selected entries LoreBase decides, and whether it is locked to this chat or to its character, where LoreBase decides
 * them (D11).
 * @returns {Promise<{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean}>}>}
 */
export async function chatBookLocks() {
    const { chatId, characterAvatar } = lockTarget();
    const known = new Set(world_names);
    const bookNames = chatBookNames().filter(bookName => known.has(bookName));
    const counts = await Promise.all(bookNames.map(decidedCountOf));
    return {
        hasChat: Boolean(chatId),
        books: bookNames.map((bookName, index) => ({
            bookName,
            selectedCount: counts[index],
            isLockedToChat: Boolean(chatId) && isLoreBookLocked(bookName, { chatId }),
            isLockedToCharacter: Boolean(characterAvatar) && isLoreBookLocked(bookName, { characterAvatar }),
        })),
    };
}
