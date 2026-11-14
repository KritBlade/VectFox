/**
 * LoreBase's book record (plan §5.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * the entries selected for LoreBase to decide, the pinned section names and the locks, in one settings record per book.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));

const { extension_settings, saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSelection } = await import('../src/features/lorebase/lorebase-books.js');

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

        setLoreBookLock(BOOK, { characterId: 7 }, true);
        expect(isLoreBookLocked(BOOK, { characterId: '7' })).toBe(true);
        setLoreBookLock(BOOK, { characterId: 7 }, false);
        expect(getLoreBook(BOOK).lockedToCharacterIds).toEqual([]);
    });
});
