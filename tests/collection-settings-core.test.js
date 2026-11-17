/**
 * Unit tests for src/features/database-browser/collection-settings-core.js — what a collection's lock dialogs show: the
 * lock switch and summary say what a lock does here, the lock dialog lists the locks and the ones it can add, and
 * character 0 counts as a character.
 */

import { describe, it, expect } from 'vitest';
import { lockDialogView, lockSummary, lockSwitchState } from '../src/features/database-browser/collection-settings-core.js';

describe('the lock switch and summary', () => {
    it('names the lock the switch writes, and is off limits without its chat or character', () => {
        expect(lockSwitchState({ isCharacterScope: true, hasChat: true, hasCharacter: true }))
            .toEqual({ title: 'Active for this character', description: 'On: active in every chat with this character.', isDisabled: false });
        expect(lockSwitchState({ isCharacterScope: false, hasChat: true, hasCharacter: false }).isDisabled).toBe(false);
        expect(lockSwitchState({ isCharacterScope: true, hasChat: true, hasCharacter: false }).description).toContain('group chat');
        expect(lockSwitchState({ isCharacterScope: false, hasChat: false, hasCharacter: false }).isDisabled).toBe(true);
    });

    it('counts the locks and says whether one matches here', () => {
        const none = { chatLockCount: 0, characterLockCount: 0, isLockedToThisChat: false, isLockedToThisCharacter: false, isGroupChat: false };
        expect(lockSummary(none)).toEqual({ pill: 'No locks', isActiveHere: false, line: 'Not locked, so it never activates.' });
        expect(lockSummary({ ...none, chatLockCount: 1, characterLockCount: 1, isLockedToThisChat: true, isLockedToThisCharacter: true }))
            .toEqual({ pill: '2 locks', isActiveHere: true, line: 'Active here: locked to this chat and this character.' });
        expect(lockSummary({ ...none, characterLockCount: 1, isLockedToThisCharacter: true }).line).toBe('Active here: locked to this character.');
        expect(lockSummary({ ...none, characterLockCount: 1, isGroupChat: true }).line).toContain('add a chat lock');
        expect(lockSummary({ ...none, chatLockCount: 3 })).toMatchObject({ pill: '3 locks', isActiveHere: false });
    });
});

describe('the lock dialog', () => {
    const view = overrides => lockDialogView({
        chatLocks: ['Mira - 1', 'Tomas - 2'],
        characterLocks: [0, '4'],
        chatId: 'Mira - 1',
        characterId: 0,
        characterNameOf: id => ({ 0: 'Mira', 4: 'Tomas' })[id],
        ...overrides,
    });

    it('marks this chat and this character, and character 0 is a character', () => {
        const { chats, characters, canLockChat, canLockCharacter, characterLine } = view();
        expect(chats).toEqual([{ id: 'Mira - 1', isCurrent: true }, { id: 'Tomas - 2', isCurrent: false }]);
        expect(characters).toEqual([{ id: '0', name: 'Mira', isCurrent: true }, { id: '4', name: 'Tomas', isCurrent: false }]);
        expect([canLockChat, canLockCharacter]).toEqual([false, false]);
        expect(characterLine).toBe('Locked to this character.');
    });

    it('offers each lock it can add, and says why it cannot', () => {
        expect(view({ chatId: 'New - 3', characterId: '7' })).toMatchObject({ canLockChat: true, canLockCharacter: true });
        expect(view({ characterId: null }).characterLine).toBe('A group chat has no single character, so use a chat lock.');
        expect(view({ chatId: null, characterId: null })).toMatchObject({
            canLockChat: false, chatLine: 'Open a chat to lock it to one.', canLockCharacter: false, characterLine: 'No character is open.',
        });
    });
});
