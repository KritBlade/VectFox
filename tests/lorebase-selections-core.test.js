/**
 * A lorebook's selections, the pure half (§3.7 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * the selection a chat uses, and every entry a book's selections hold. Which locks change when one is put in use is
 * src/shared/one-in-use-locks.js's (one-in-use-locks.test.js), and the name and ID New selection gives are
 * src/shared/new-group-member.js's (new-group-member.test.js).
 */
import { describe, expect, it } from 'vitest';
import { emptySelection, isSelectionLockedTo, selectionInUseOf, unionOfSelections } from '../src/features/lorebase/lorebase-selections-core.js';

const selectionOf = (id, locks = {}, selectedUids = []) => ({ ...emptySelection(id, `Selection ${id}`), selectedUids, ...locks });

describe('the selection a chat uses', () => {
    const record = {
        selections: [
            selectionOf('a', { lockedToCharacterAvatars: ['wren.png'] }),
            selectionOf('b', { lockedToChatIds: ['Harbor Night'] }),
        ],
    };

    it('is the one locked to the chat, else the one locked to its character, else none', () => {
        expect(selectionInUseOf(record, { chatId: 'Harbor Night', characterAvatar: 'wren.png' })?.id).toBe('b');
        expect(selectionInUseOf(record, { chatId: 'Low Tide', characterAvatar: 'wren.png' })?.id).toBe('a');
        expect(selectionInUseOf(record, { chatId: 'Low Tide', characterAvatar: 'keeper-orrin.png' })).toBeNull();
        expect(selectionInUseOf(record, { chatId: null, characterAvatar: null })).toBeNull();
        expect(selectionInUseOf(null, { chatId: 'Harbor Night' })).toBeNull();
    });

    it('reads a lock to the chat or to the character given', () => {
        expect(isSelectionLockedTo(record.selections[1], { chatId: 'Harbor Night' })).toBe(true);
        expect(isSelectionLockedTo(record.selections[1], { characterAvatar: 'Harbor Night' })).toBe(false);
        expect(isSelectionLockedTo(record.selections[0], {})).toBe(false);
    });
});

describe('unionOfSelections', () => {
    it("holds every entry any of the book's selections holds, each once, and none for a book with no record", () => {
        const record = { selections: [selectionOf('a', {}, ['1', '2']), selectionOf('b', {}, ['2', '3'])] };
        expect(unionOfSelections(record)).toEqual({ selectedUids: ['1', '2', '3'] });
        expect(unionOfSelections(null)).toEqual({ selectedUids: [] });
    });
});
