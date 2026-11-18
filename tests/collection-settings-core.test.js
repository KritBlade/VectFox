/**
 * Unit tests for src/features/database-browser/collection-settings-core.js — what the Database Browser shows of a
 * collection's locks, each by the kind its scope reads, as isCollectionActiveForContext does: the lock switch and
 * summary say what a lock does here, the lock dialog lists and offers that kind and marks a lock of the other kind as
 * not read, the listing's Active here line names the lock that counts, and character 0 counts as a character.
 */

import { describe, it, expect } from 'vitest';
import { activeLockLine, lockDialogView, lockSummary, lockSwitchState } from '../src/features/database-browser/collection-settings-core.js';

describe('the lock switch', () => {
    it('names the lock the switch writes, and is off limits without its chat or character', () => {
        expect(lockSwitchState({ isCharacterScope: true, hasChat: true, hasCharacter: true }))
            .toEqual({ title: 'Active for this character', description: 'On: active in every chat with this character.', isDisabled: false });
        expect(lockSwitchState({ isCharacterScope: false, hasChat: true, hasCharacter: false }).isDisabled).toBe(false);
        expect(lockSwitchState({ isCharacterScope: false, hasChat: false, hasCharacter: false }).isDisabled).toBe(true);
    });

    it('says a character collection cannot be active in a group chat, and points to no chat lock it would not read', () => {
        expect(lockSwitchState({ isCharacterScope: true, hasChat: true, hasCharacter: false })).toEqual({
            title: 'Active for this character', description: 'A group chat has no single character, so it cannot be active here.', isDisabled: true,
        });
    });
});

describe('the lock summary', () => {
    const none = { chatLockCount: 0, characterLockCount: 0, isLockedToThisChat: false, isLockedToThisCharacter: false, isGroupChat: false };

    it('counts and matches the locks a chat collection reads, its chat locks', () => {
        expect(lockSummary({ ...none, isCharacterScope: false }))
            .toEqual({ pill: 'No locks', isActiveHere: false, line: 'Not locked, so it never activates.', unreadLine: null });
        expect(lockSummary({ ...none, isCharacterScope: false, chatLockCount: 1, isLockedToThisChat: true }))
            .toEqual({ pill: '1 lock', isActiveHere: true, line: 'Active here: locked to this chat.', unreadLine: null });
        expect(lockSummary({ ...none, isCharacterScope: false, chatLockCount: 3 }))
            .toMatchObject({ pill: '3 locks', isActiveHere: false, line: 'Not active here. Its locks are for other chats.' });
    });

    it('never counts a character lock on a chat collection as active, and says it does nothing', () => {
        expect(lockSummary({ ...none, isCharacterScope: false, characterLockCount: 2, isLockedToThisCharacter: true })).toEqual({
            pill: 'No locks', isActiveHere: false, line: 'Not locked, so it never activates.',
            unreadLine: '2 character locks do nothing: a chat collection reads chat locks only.',
        });
    });

    it('counts and matches a character collection\'s character locks, and says a chat lock on it does nothing', () => {
        expect(lockSummary({ ...none, isCharacterScope: true, characterLockCount: 1, isLockedToThisCharacter: true, chatLockCount: 1, isLockedToThisChat: true }))
            .toEqual({
                pill: '1 lock', isActiveHere: true, line: 'Active here: locked to this character.',
                unreadLine: '1 chat lock does nothing: a character collection reads character locks only.',
            });
        expect(lockSummary({ ...none, isCharacterScope: true, characterLockCount: 1, isGroupChat: true }).line)
            .toBe('Not active here: a group chat has no single character.');
        expect(lockSummary({ ...none, isCharacterScope: true, characterLockCount: 2 }).line).toBe('Not active here. Its locks are for other characters.');
    });
});

describe('the lock dialog', () => {
    const view = overrides => lockDialogView({
        isCharacterScope: false,
        chatLocks: ['Mira - 1', 'Tomas - 2'],
        characterLocks: [0, '4'],
        chatId: 'Mira - 1',
        characterId: 0,
        characterNameOf: id => ({ 0: 'Mira', 4: 'Tomas' })[id],
        ...overrides,
    });

    it('on a chat collection lists and offers chat locks, and keeps its character locks apart as not read', () => {
        expect(view()).toEqual({
            kind: 'chat',
            locks: [{ id: 'Mira - 1', name: 'Mira - 1', isCurrent: true }, { id: 'Tomas - 2', name: 'Tomas - 2', isCurrent: false }],
            canLock: false,
            line: 'Locked to this chat.',
            unreadKind: 'character',
            unreadLocks: [{ id: '0', name: 'Mira' }, { id: '4', name: 'Tomas' }],
            unreadLine: '2 character locks do nothing: a chat collection reads chat locks only.',
        });
        expect(view({ chatId: 'New - 3' })).toMatchObject({ canLock: true, line: 'Lock it to the open chat.' });
        expect(view({ chatId: null })).toMatchObject({ canLock: false, line: 'Open a chat to lock it to one.' });
        expect(view({ characterLocks: [] })).toMatchObject({ unreadLocks: [], unreadLine: null });
    });

    it('on a character collection lists and offers character locks, character 0 being a character', () => {
        expect(view({ isCharacterScope: true })).toMatchObject({
            kind: 'character',
            locks: [{ id: '0', name: 'Mira', isCurrent: true }, { id: '4', name: 'Tomas', isCurrent: false }],
            canLock: false,
            line: 'Locked to this character.',
            unreadKind: 'chat',
            unreadLocks: [{ id: 'Mira - 1', name: 'Mira - 1' }, { id: 'Tomas - 2', name: 'Tomas - 2' }],
        });
        expect(view({ isCharacterScope: true, characterId: '7' })).toMatchObject({ canLock: true, line: 'Lock it to the open character.' });
        expect(view({ isCharacterScope: true, characterId: null }))
            .toMatchObject({ canLock: false, line: 'A group chat has no single character, so it cannot be active here.' });
        expect(view({ isCharacterScope: true, chatId: null, characterId: null })).toMatchObject({ canLock: false, line: 'No character is open.' });
    });
});

describe("the listing's Active here line", () => {
    it('names the lock the scope reads, and the other chats a chat collection is locked to', () => {
        expect(activeLockLine({ isCharacterScope: false, chatLockCount: 1 })).toBe('Locked to this chat');
        expect(activeLockLine({ isCharacterScope: false, chatLockCount: 3 })).toBe('Locked to this chat, and to 2 other chats');
        expect(activeLockLine({ isCharacterScope: false, chatLockCount: 2 })).toBe('Locked to this chat, and to 1 other chat');
        expect(activeLockLine({ isCharacterScope: true, chatLockCount: 4 })).toBe('Locked to this character, so it is active in every chat with them');
    });
});
