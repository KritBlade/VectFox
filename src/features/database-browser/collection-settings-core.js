/**
 * ============================================================================
 * COLLECTION SETTINGS, PURE RULES
 * ============================================================================
 * What the Database Browser shows of a collection's locks: the lock switch's
 * wording, the lock summary and the lock dialog's lists (collection-dialogs.js),
 * and the listing's Active here line (database-browser.js). A collection reads
 * one kind of lock, by its scope, as isCollectionActiveForContext does: a
 * chat-scoped one its chat locks, a character-scoped one its character locks.
 * A lock of the other kind saved before is shown as one it does not read, with
 * its Remove; nothing deletes it by itself. Pure.
 * ============================================================================
 */

import { counted } from '../../shared/counted.js';

const kindOf = isCharacterScope => (isCharacterScope ? 'character' : 'chat');
const otherKindOf = isCharacterScope => (isCharacterScope ? 'chat' : 'character');
const GROUP_CHAT_LINE = 'A group chat has no single character, so it cannot be active here.';

/**
 * The locks of the kind a collection does not read, in a line, or null when it keeps none.
 * @param {boolean} isCharacterScope
 * @param {number} unreadCount
 * @returns {string|null}
 */
function unreadLocksLine(isCharacterScope, unreadCount) {
    if (!unreadCount) return null;
    const kind = kindOf(isCharacterScope);
    const locks = counted(unreadCount, `${otherKindOf(isCharacterScope)} lock`);
    return `${locks} ${unreadCount === 1 ? 'does' : 'do'} nothing: a ${kind} collection reads ${kind} locks only.`;
}

/**
 * What the lock switch writes, said on the switch: a character lock or a chat lock, by the collection's scope. Without
 * the chat or character it would lock, the switch is off limits and its line says why.
 *
 * @param {{isCharacterScope: boolean, hasChat: boolean, hasCharacter: boolean}} context
 * @returns {{title: string, description: string, isDisabled: boolean}}
 */
export function lockSwitchState({ isCharacterScope, hasChat, hasCharacter }) {
    const title = isCharacterScope ? 'Active for this character' : 'Active for this chat';
    if (!hasChat) return { title, description: 'No chat is open. Open one to lock this collection to it.', isDisabled: true };
    if (isCharacterScope && !hasCharacter) return { title, description: GROUP_CHAT_LINE, isDisabled: true };
    return {
        title,
        description: isCharacterScope ? 'On: active in every chat with this character.' : 'On: active in this chat.',
        isDisabled: false,
    };
}

/**
 * A collection's locks in a few words: how many of the kind its scope reads, whether one matches here, and the locks
 * of the other kind it keeps but never reads. A character-scoped collection never matches in a group chat, which has
 * no single character.
 *
 * @param {{isCharacterScope: boolean, chatLockCount: number, characterLockCount: number, isLockedToThisChat: boolean,
 *   isLockedToThisCharacter: boolean, isGroupChat: boolean}} locks
 * @returns {{pill: string, isActiveHere: boolean, line: string, unreadLine: string|null}}
 */
export function lockSummary({ isCharacterScope, chatLockCount, characterLockCount, isLockedToThisChat, isLockedToThisCharacter, isGroupChat }) {
    const readCount = isCharacterScope ? characterLockCount : chatLockCount;
    const isActiveHere = Boolean(isCharacterScope ? isLockedToThisCharacter : isLockedToThisChat);
    let line;
    if (!readCount) line = 'Not locked, so it never activates.';
    else if (isActiveHere) line = `Active here: locked to this ${kindOf(isCharacterScope)}.`;
    else if (isCharacterScope && isGroupChat) line = 'Not active here: a group chat has no single character.';
    else line = `Not active here. Its locks are for other ${isCharacterScope ? 'characters' : 'chats'}.`;
    return {
        pill: readCount ? counted(readCount, 'lock') : 'No locks',
        isActiveHere,
        line,
        unreadLine: unreadLocksLine(isCharacterScope, isCharacterScope ? chatLockCount : characterLockCount),
    };
}

/**
 * The lock dialog: the locks of the kind the collection's scope reads, whether it can add one here and what it can do,
 * then the locks of the other kind saved before, which it never reads, each kept for its Remove.
 *
 * @param {{isCharacterScope: boolean, chatLocks: string[], characterLocks: Array<string|number>, chatId: string|null,
 *   characterId: string|number|null, characterNameOf: (id: string) => string}} locks
 * @returns {{kind: 'chat'|'character', locks: {id: string, name: string, isCurrent: boolean}[], canLock: boolean,
 *   line: string, unreadKind: 'chat'|'character', unreadLocks: {id: string, name: string}[], unreadLine: string|null}}
 */
export function lockDialogView({ isCharacterScope, chatLocks, characterLocks, chatId, characterId, characterNameOf }) {
    const hasChat = Boolean(chatId);
    const hasCharacter = characterId !== null && characterId !== undefined && characterId !== '';
    const chats = chatLocks.map(id => ({ id: String(id), name: String(id), isCurrent: hasChat && String(id) === String(chatId) }));
    const characters = characterLocks.map(id => ({
        id: String(id),
        name: characterNameOf(String(id)),
        isCurrent: hasCharacter && String(id) === String(characterId),
    }));
    const [locks, unread] = isCharacterScope ? [characters, chats] : [chats, characters];
    const isLockedHere = locks.some(lock => lock.isCurrent);
    let line;
    if (isCharacterScope) {
        if (hasCharacter) line = isLockedHere ? 'Locked to this character.' : 'Lock it to the open character.';
        else line = hasChat ? GROUP_CHAT_LINE : 'No character is open.';
    } else {
        line = hasChat ? (isLockedHere ? 'Locked to this chat.' : 'Lock it to the open chat.') : 'Open a chat to lock it to one.';
    }
    return {
        kind: kindOf(isCharacterScope),
        locks,
        canLock: (isCharacterScope ? hasCharacter : hasChat) && !isLockedHere,
        line,
        unreadKind: otherKindOf(isCharacterScope),
        unreadLocks: unread.map(({ id, name }) => ({ id, name })),
        unreadLine: unreadLocksLine(isCharacterScope, unread.length),
    };
}

/**
 * The listing's line for a collection active here: the lock its scope reads that makes it so, and the other chats a
 * chat-scoped one is locked to.
 *
 * @param {{isCharacterScope: boolean, chatLockCount: number}} locks
 * @returns {string}
 */
export function activeLockLine({ isCharacterScope, chatLockCount }) {
    if (isCharacterScope) return 'Locked to this character, so it is active in every chat with them';
    const otherChatCount = chatLockCount - 1;
    return otherChatCount > 0 ? `Locked to this chat, and to ${counted(otherChatCount, 'other chat')}` : 'Locked to this chat';
}
