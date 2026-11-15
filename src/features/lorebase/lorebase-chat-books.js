/**
 * The open chat's lorebooks, as SillyTavern's World Info scan loads them (world-info.js, getSortedEntries), and what
 * a book can be locked to there: the open chat and its character (plan §5.2, §5.8 and D11 of InternalProject/Vectfox/
 * plans/lorebook-semantic-overhaul-passage-index.md). The reply, the selection screen and the WorldInfo page read them.
 */
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { getCharaFilename } from '../../sillytavern/identifiers.js';
import { METADATA_KEY, getWorldInfoSettings, selected_world_info, world_names } from '../../sillytavern/world-info.js';
import { getLoreBook, isLoreBookLocked } from './lorebase-books.js';
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
 * The open chat's books as the WorldInfo page lists them: each book SillyTavern loads here and has, how many entries
 * are selected in it, and whether it is locked to this chat or to its character, where LoreBase decides them (D11).
 * @returns {{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean}>}}
 */
export function chatBookLocks() {
    const { chatId, characterAvatar } = lockTarget();
    const known = new Set(world_names);
    return {
        hasChat: Boolean(chatId),
        books: chatBookNames().filter(bookName => known.has(bookName)).map(bookName => ({
            bookName,
            selectedCount: getLoreBook(bookName)?.selectedUids.length ?? 0,
            isLockedToChat: Boolean(chatId) && isLoreBookLocked(bookName, { chatId }),
            isLockedToCharacter: Boolean(characterAvatar) && isLoreBookLocked(bookName, { characterAvatar }),
        })),
    };
}
