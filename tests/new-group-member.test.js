/**
 * A new member of a group (src/shared/new-group-member.js): the name EventBase's New collection and LoreBase's New
 * selection give, and the ID each is told apart by.
 */
import { describe, expect, it } from 'vitest';
import { newTimeId, numberedName } from '../src/shared/new-group-member.js';

describe('numberedName', () => {
    it('gives the base name the lowest number from 2 that no member uses', () => {
        expect(numberedName('Harbor Atlas', ['Harbor Atlas'])).toBe('Harbor Atlas 2');
        expect(numberedName('Harbor Atlas', ['Harbor Atlas', 'Harbor Atlas 2', 'Harbor Atlas 3'])).toBe('Harbor Atlas 4');
        expect(numberedName('Harbor Atlas', [])).toBe('Harbor Atlas 2');
    });

    it('takes a number again once a rename or a delete freed it', () => {
        expect(numberedName('Harbor Atlas', ['Harbor Atlas', 'Arc two', 'Harbor Atlas 3'])).toBe('Harbor Atlas 2');
    });
});

describe('newTimeId', () => {
    it("is the time in base 36, moved on a step while one of the group's members has it", () => {
        const now = 1_700_000_000_000;
        expect(newTimeId([], now)).toBe(now.toString(36));
        expect(newTimeId([now.toString(36), (now + 1).toString(36)], now)).toBe((now + 2).toString(36));
    });
});
