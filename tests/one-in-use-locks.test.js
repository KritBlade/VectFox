/**
 * src/shared/one-in-use-locks.js: which locks change when one member of a group is put in use at a place, the rule
 * EventBase's collections and LoreBase's selections both follow (§1 of vectfox-multi-collection-per-chat.md).
 */
import { describe, expect, it } from 'vitest';
import { oneInUseLockChanges } from '../src/shared/one-in-use-locks.js';

describe('oneInUseLockChanges', () => {
    it('locks the one chosen and unlocks every other member locked at the place', () => {
        const members = [{ id: 'a', isLockedHere: true }, { id: 'b', isLockedHere: false }, { id: 'c', isLockedHere: true }];
        expect(oneInUseLockChanges(members, 'b')).toEqual({ lockIds: ['b'], unlockIds: ['a', 'c'] });
    });

    it('leaves out a member already as it should be, and locks nothing for a member the group lacks', () => {
        expect(oneInUseLockChanges([{ id: 'a', isLockedHere: true }, { id: 'b', isLockedHere: false }], 'a')).toEqual({ lockIds: [], unlockIds: [] });
        expect(oneInUseLockChanges([{ id: 'a', isLockedHere: true }], 'gone')).toEqual({ lockIds: [], unlockIds: ['a'] });
    });
});
