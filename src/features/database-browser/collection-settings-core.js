/**
 * ============================================================================
 * COLLECTION SETTINGS, PURE RULES
 * ============================================================================
 * What the Database Browser's collection dialogs (collection-dialogs.js) show:
 * the lock switch's wording, the lock summary and the lock dialog's lists. Pure.
 * ============================================================================
 */

import { counted } from '../../shared/counted.js';

/**
 * What the lock switch writes, said on the switch: a character lock or a chat lock, by the collection's scope. Without
 * the chat or character it would lock, the switch is off limits and its line says where to go instead.
 *
 * @param {{isCharacterScope: boolean, hasChat: boolean, hasCharacter: boolean}} context
 * @returns {{title: string, description: string, isDisabled: boolean}}
 */
export function lockSwitchState({ isCharacterScope, hasChat, hasCharacter }) {
    const title = isCharacterScope ? 'Active for this character' : 'Active for this chat';
    if (!hasChat) return { title, description: 'No chat is open. Open one to lock this collection to it.', isDisabled: true };
    if (isCharacterScope && !hasCharacter) {
        return { title, description: 'A group chat has no single character. Use Manage locks to lock this chat.', isDisabled: true };
    }
    return {
        title,
        description: isCharacterScope ? 'On: active in every chat with this character.' : 'On: active in this chat.',
        isDisabled: false,
    };
}

/**
 * A collection's locks in a few words: how many, and whether one matches here. A collection with only character locks
 * never matches in a group chat, which has no single character, so the line says to add a chat lock there.
 *
 * @param {{chatLockCount: number, characterLockCount: number, isLockedToThisChat: boolean,
 *   isLockedToThisCharacter: boolean, isGroupChat: boolean}} locks
 * @returns {{pill: string, isActiveHere: boolean, line: string}}
 */
export function lockSummary({ chatLockCount, characterLockCount, isLockedToThisChat, isLockedToThisCharacter, isGroupChat }) {
    const total = chatLockCount + characterLockCount;
    const isActiveHere = Boolean(isLockedToThisChat || isLockedToThisCharacter);
    const pill = total === 0 ? 'No locks' : counted(total, 'lock');
    if (total === 0) return { pill, isActiveHere, line: 'Not locked, so it never activates.' };
    if (isActiveHere) {
        const here = isLockedToThisChat && isLockedToThisCharacter
            ? 'this chat and this character'
            : isLockedToThisChat ? 'this chat' : 'this character';
        return { pill, isActiveHere, line: `Active here: locked to ${here}.` };
    }
    if (isGroupChat && chatLockCount === 0) {
        return { pill, isActiveHere, line: 'Not active here. A group chat has no single character, so add a chat lock.' };
    }
    return { pill, isActiveHere, line: 'Not active here. Its locks are for other chats or characters.' };
}

/**
 * The lock dialog's two lists and what each section can do here.
 *
 * @param {{chatLocks: string[], characterLocks: Array<string|number>, chatId: string|null,
 *   characterId: string|number|null, characterNameOf: (id: string) => string}} locks
 * @returns {{chats: {id: string, isCurrent: boolean}[], characters: {id: string, name: string, isCurrent: boolean}[],
 *   canLockChat: boolean, chatLine: string, canLockCharacter: boolean, characterLine: string}}
 */
export function lockDialogView({ chatLocks, characterLocks, chatId, characterId, characterNameOf }) {
    const hasChat = Boolean(chatId);
    const hasCharacter = characterId !== null && characterId !== undefined && characterId !== '';
    const chats = chatLocks.map(id => ({ id: String(id), isCurrent: hasChat && String(id) === String(chatId) }));
    const characters = characterLocks.map(id => ({
        id: String(id),
        name: characterNameOf(String(id)),
        isCurrent: hasCharacter && String(id) === String(characterId),
    }));
    const isChatLocked = chats.some(chat => chat.isCurrent);
    const isCharacterLocked = characters.some(character => character.isCurrent);
    let characterLine;
    if (hasCharacter) characterLine = isCharacterLocked ? 'Locked to this character.' : 'Lock it to the open character.';
    else if (hasChat) characterLine = 'A group chat has no single character, so use a chat lock.';
    else characterLine = 'No character is open.';
    return {
        chats,
        characters,
        canLockChat: hasChat && !isChatLocked,
        chatLine: hasChat ? (isChatLocked ? 'Locked to this chat.' : 'Lock it to the open chat.') : 'Open a chat to lock it to one.',
        canLockCharacter: hasCharacter && !isCharacterLocked,
        characterLine,
    };
}
