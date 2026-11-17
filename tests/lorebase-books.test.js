/**
 * LoreBase's book record (plan §5.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * the entries selected for LoreBase to decide, the pinned section names, the locks, and the entries the book held when
 * the selection screen last opened it, in one settings record per book; and the book's selected entries LoreBase
 * decides, read against the book as SillyTavern loads it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: vi.fn() }));

const { extension_settings, saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const {
    getLoreBook, isLoreBookLocked, loadDecidedEntries, renameLoreBookCharacter, renameLoreBookChat, setLoreBookLock, setLoreBookPins, setLoreBookSeenEntries,
    setLoreBookSelection,
} = await import('../src/features/lorebase/lorebase-books.js');

const BOOK = 'Harbor Lore';

beforeEach(() => {
    extension_settings.vectfox = {};
    vi.mocked(saveSettingsDebounced).mockClear();
});

describe("a book's decided entries", () => {
    it('reads the selected entries LoreBase decides, against the book as SillyTavern loads it now', async () => {
        setLoreBookSelection(BOOK, ['0', '1', '2', '3', '9']);
        loadWorldInfo.mockResolvedValueOnce({
            entries: {
                0: { uid: 0, content: 'The harbor bells.' },
                // Emptied, made constant, and not selected since the selection was saved; uid 9 was deleted.
                1: { uid: 1, content: '  ' },
                2: { uid: 2, content: 'The tide clock.', constant: true },
                3: { uid: 3, content: 'Fog season.' },
                4: { uid: 4, content: 'The lamp room.' },
            },
        });
        expect((await loadDecidedEntries(BOOK)).map(entry => entry.uid)).toEqual([0, 3]);
        expect(loadWorldInfo).toHaveBeenCalledWith(BOOK);
    });

    it('reads none when SillyTavern has no such book, and lets a failed load throw', async () => {
        setLoreBookSelection(BOOK, ['0']);
        loadWorldInfo.mockResolvedValueOnce(null);
        expect(await loadDecidedEntries(BOOK)).toEqual([]);
        loadWorldInfo.mockRejectedValueOnce(new Error('HTTP 500'));
        await expect(loadDecidedEntries(BOOK)).rejects.toThrow('HTTP 500');
    });
});

describe('the book record', () => {
    it('keeps the selection, the pins and the locks of a book in one settings record', () => {
        setLoreBookSelection(BOOK, [1, '2', 2]);
        setLoreBookPins(BOOK, ['SEALED KNOWLEDGE', ' ', 'SEALED KNOWLEDGE']);
        setLoreBookLock(BOOK, { chatId: 'chat-1' }, true);

        expect(getLoreBook(BOOK)).toEqual({ selectedUids: ['1', '2'], pinnedSections: ['SEALED KNOWLEDGE'], lockedToChatIds: ['chat-1'], lockedToCharacterAvatars: [] });
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-1' })).toBe(true);
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-2', characterAvatar: 'keeper-orrin.png' })).toBe(false);
        expect(Object.keys(extension_settings.vectfox)).toEqual(['lorebase_books']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(3);
    });

    it('has no record for a book nothing was selected in, and unlocks what it locked', () => {
        expect(getLoreBook('Another Book')).toBeNull();
        expect(isLoreBookLocked('Another Book', { chatId: 'chat-1' })).toBe(false);
        // Each reply reads the records of the books it loads, so a read writes nothing to the settings.
        expect(extension_settings.vectfox).toEqual({});

        setLoreBookLock(BOOK, { characterAvatar: 'keeper-orrin.png' }, true);
        expect(isLoreBookLocked(BOOK, { characterAvatar: 'keeper-orrin.png' })).toBe(true);
        setLoreBookLock(BOOK, { characterAvatar: 'keeper-orrin.png' }, false);
        expect(getLoreBook(BOOK).lockedToCharacterAvatars).toEqual([]);
    });

    it('moves every lock on a renamed character to its new avatar file name, and saves only when one moved', () => {
        setLoreBookLock(BOOK, { characterAvatar: 'keeper-orrin.png' }, true);
        setLoreBookLock('Tide Tables', { characterAvatar: 'keeper-orrin.png' }, true);
        setLoreBookLock('Tide Tables', { characterAvatar: 'wren.png' }, true);
        vi.mocked(saveSettingsDebounced).mockClear();

        renameLoreBookCharacter('keeper-orrin.png', 'keeper-orrin-the-elder.png');
        expect(getLoreBook(BOOK).lockedToCharacterAvatars).toEqual(['keeper-orrin-the-elder.png']);
        expect(getLoreBook('Tide Tables').lockedToCharacterAvatars).toEqual(['keeper-orrin-the-elder.png', 'wren.png']);
        expect(isLoreBookLocked(BOOK, { characterAvatar: 'keeper-orrin.png' })).toBe(false);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);

        renameLoreBookCharacter('nobody.png', 'somebody.png');
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('moves every lock on a renamed chat to its new name, leaving the character locks alone', () => {
        setLoreBookLock(BOOK, { chatId: 'Harbor Night' }, true);
        setLoreBookLock(BOOK, { characterAvatar: 'Harbor Night' }, true);
        setLoreBookLock('Tide Tables', { chatId: 'Harbor Night' }, true);
        setLoreBookLock('Tide Tables', { chatId: 'Low Tide' }, true);
        vi.mocked(saveSettingsDebounced).mockClear();

        renameLoreBookChat('Harbor Night', 'Harbor Night, the storm');
        expect(getLoreBook(BOOK)).toMatchObject({ lockedToChatIds: ['Harbor Night, the storm'], lockedToCharacterAvatars: ['Harbor Night'] });
        expect(getLoreBook('Tide Tables').lockedToChatIds).toEqual(['Harbor Night, the storm', 'Low Tide']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('renames nothing before any book has a record', () => {
        renameLoreBookCharacter('keeper-orrin.png', 'keeper-orrin-the-elder.png');
        renameLoreBookChat('Harbor Night', 'Harbor Night, the storm');
        expect(extension_settings.vectfox).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('keeps the entries the book held when the selection screen opened it, missing until the first opening', () => {
        setLoreBookLock(BOOK, { chatId: 'chat-1' }, true);
        expect(getLoreBook(BOOK)).not.toHaveProperty('seenUids');
        setLoreBookSeenEntries(BOOK, [0, '1', 1]);
        expect(getLoreBook(BOOK).seenUids).toEqual(['0', '1']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
    });
});
