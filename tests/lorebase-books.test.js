/**
 * LoreBase's book record (plan §5.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * the entries selected for LoreBase to decide, the pinned section names, the locks, and the entries the book held when
 * the selection screen last opened it, in one settings record per book.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));

const { extension_settings, saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection } = await import('../src/features/lorebase/lorebase-books.js');

const BOOK = 'Harbor Lore';

beforeEach(() => {
    extension_settings.vectfox = {};
    vi.mocked(saveSettingsDebounced).mockClear();
});

describe('the book record', () => {
    it('keeps the selection, the pins and the locks of a book in one settings record', () => {
        setLoreBookSelection(BOOK, [1, '2', 2]);
        setLoreBookPins(BOOK, ['SEALED KNOWLEDGE', ' ', 'SEALED KNOWLEDGE']);
        setLoreBookLock(BOOK, { chatId: 'chat-1' }, true);

        expect(getLoreBook(BOOK)).toEqual({ selectedUids: ['1', '2'], pinnedSections: ['SEALED KNOWLEDGE'], lockedToChatIds: ['chat-1'], lockedToCharacterIds: [] });
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-1' })).toBe(true);
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-2', characterId: '7' })).toBe(false);
        expect(Object.keys(extension_settings.vectfox)).toEqual(['lorebase_books']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(3);
    });

    it('has no record for a book nothing was selected in, and unlocks what it locked', () => {
        expect(getLoreBook('Another Book')).toBeNull();
        expect(isLoreBookLocked('Another Book', { chatId: 'chat-1' })).toBe(false);
        // Each reply reads the records of the books it loads, so a read writes nothing to the settings.
        expect(extension_settings.vectfox).toEqual({});

        setLoreBookLock(BOOK, { characterId: 7 }, true);
        expect(isLoreBookLocked(BOOK, { characterId: '7' })).toBe(true);
        setLoreBookLock(BOOK, { characterId: 7 }, false);
        expect(getLoreBook(BOOK).lockedToCharacterIds).toEqual([]);
    });

    it('keeps the entries the book held when the selection screen opened it, missing until the first opening', () => {
        setLoreBookLock(BOOK, { chatId: 'chat-1' }, true);
        expect(getLoreBook(BOOK)).not.toHaveProperty('seenUids');
        setLoreBookSeenEntries(BOOK, [0, '1', 1]);
        expect(getLoreBook(BOOK).seenUids).toEqual(['0', '1']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
    });
});
