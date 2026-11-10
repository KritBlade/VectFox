/**
 * Unit tests for src/features/database-browser/collection-settings-core.js — what a collection's dialogs show and
 * save: a rule shows the values the activation check uses for what it leaves out, a control's text becomes the saved
 * setting, the lock switch and summary say what a lock does here, and character 0 counts as a character.
 */

import { describe, it, expect } from 'vitest';
import {
    conditionKindOf,
    effectiveRuleSettings,
    lockDialogView,
    lockSummary,
    lockSwitchState,
    lorebookChoiceLabel,
    parseInjection,
    parseRuleField,
    parseTriggerList,
    sanitizeXmlTag,
} from '../src/features/database-browser/collection-settings-core.js';

describe('a condition rule', () => {
    it('runs an old keyword rule as a pattern rule, and names a kind it does not know', () => {
        expect(conditionKindOf('keyword').value).toBe('pattern');
        expect(conditionKindOf('weather').label).toBe('Unknown condition');
    });

    it('shows the values the activation check uses for the settings it leaves out', () => {
        expect(effectiveRuleSettings({ type: 'messageCount' })).toEqual({ count: 0, operator: 'gte' });
        expect(effectiveRuleSettings({ type: 'swipeCount', settings: {} }).operator).toBe('gte');
        expect(effectiveRuleSettings({ type: 'generationType', settings: {} }).values).toEqual(['normal']);
        expect(effectiveRuleSettings({ type: 'generationType', settings: { values: [] } }).values).toEqual([]);
        expect(effectiveRuleSettings({ type: 'isGroupChat' }).isGroup).toBe(true);
        expect(effectiveRuleSettings({ type: 'randomChance', settings: { probability: null } }).probability).toBe(50);
        expect(effectiveRuleSettings({ type: 'timeOfDay' })).toEqual({ startTime: '00:00', endTime: '23:59' });
        expect(effectiveRuleSettings({ type: 'pattern', settings: { scanDepth: 4 } })).toMatchObject({ scanDepth: 4, matchMode: 'any', searchIn: 'all' });
    });

    it('reads an old keyword rule\'s values as its patterns', () => {
        expect(effectiveRuleSettings({ type: 'keyword', settings: { values: ['bridge'] } }).patterns).toEqual(['bridge']);
    });

    it('turns a control\'s text into the saved setting', () => {
        expect(parseRuleField('patterns', ' river \n\n/fog/i ')).toEqual(['river', '/fog/i']);
        expect(parseRuleField('values', 'Mira, , Tomas ')).toEqual(['Mira', 'Tomas']);
        expect(parseRuleField('isGroup', 'false')).toBe(false);
        expect(parseRuleField('scanDepth', '0')).toBe(1);
        expect(parseRuleField('probability', '150')).toBe(100);
        expect(parseRuleField('count', 'many')).toBe(0);
        expect(parseRuleField('operator', 'lte')).toBe('lte');
    });
});

describe('the rest of the settings form', () => {
    it('reads triggers one per line or comma-separated', () => {
        expect(parseTriggerList('harbor, tide\n\nstorm ')).toEqual(['harbor', 'tide', 'storm']);
    });

    it('keeps an XML tag to letters, digits, _ and -', () => {
        expect(sanitizeXmlTag('<my memories!>_2-b')).toBe('mymemories_2-b');
    });

    it('saves a depth only for the in-chat position, 0 to 50, and 2 when its box holds no number', () => {
        expect(parseInjection('', '7')).toEqual({ position: null, depth: null });
        expect(parseInjection('0', '7')).toEqual({ position: 0, depth: null });
        expect(parseInjection('1', '0')).toEqual({ position: 1, depth: 0 });
        expect(parseInjection('1', '')).toEqual({ position: 1, depth: 2 });
        expect(parseInjection('1', '80')).toEqual({ position: 1, depth: 50 });
    });
});

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

describe('a lorebook choice', () => {
    it('names a whole lorebook, or one of its entries', () => {
        expect(lorebookChoiceLabel('Harbor Lore')).toBe('Harbor Lore');
        expect(lorebookChoiceLabel('Harbor Lore:12')).toBe('Harbor Lore, entry 12');
        expect(lorebookChoiceLabel('Notes: a city')).toBe('Notes: a city');
    });
});
