/**
 * LoreBase's book record (plan §5.4 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md, and
 * §3.7 of vectfox-multi-collection-per-chat.md): a book's selections, each with the entries selected for LoreBase to
 * decide, the pinned section names and the locks, and the entries the book held when the selection screen last opened
 * it, in one settings record per book; making, copying, renaming and deleting selections; one selection of a book per
 * chat and per character; the book's selected entries LoreBase decides, read against the book as SillyTavern loads it;
 * and Clean up locks dropping the locks on chats and characters that no longer exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: vi.fn() }));

const { extension_settings, saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const {
    cleanUpLoreBookLocks, deleteLoreSelection, ensureLoreSelection, getLoreBook, getLoreSelection, loadDecidedEntries, loreBookRecordCounts,
    loreSelectionsOf, newLoreSelection, onLoreBookChatLocksMoved, renameLoreBookCharacter, renameLoreBookChat, renameLoreSelection, selectedLoreBookNames,
    selectionInUse, setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection, setLoreSelectionLock,
} = await import('../src/features/lorebase/lorebase-books.js');

const BOOK = 'Harbor Lore';

beforeEach(() => {
    extension_settings.vectfox = {};
    vi.mocked(saveSettingsDebounced).mockClear();
});

// The book's first selection, made with nothing selected and named after the book.
const firstOf = bookName => ensureLoreSelection(bookName).id;

describe("a book's decided entries", () => {
    const HARBOR_BOOK = {
        entries: {
            0: { uid: 0, content: 'The harbor bells.' },
            // Emptied, made constant, and not selected since the selection was saved; uid 9 was deleted.
            1: { uid: 1, content: '  ' },
            2: { uid: 2, content: 'The tide clock.', constant: true },
            3: { uid: 3, content: 'Fog season.' },
            4: { uid: 4, content: 'The lamp room.' },
        },
    };

    it('reads the selected entries LoreBase decides, against the book as SillyTavern loads it now', async () => {
        setLoreBookSelection(BOOK, firstOf(BOOK), ['0', '1', '2', '3', '9']);
        loadWorldInfo.mockResolvedValueOnce(HARBOR_BOOK);
        expect((await loadDecidedEntries(BOOK)).map(entry => entry.uid)).toEqual([0, 3]);
        expect(loadWorldInfo).toHaveBeenCalledWith(BOOK);
    });

    it("reads every entry any selection holds by default, and one selection's when given it", async () => {
        setLoreBookSelection(BOOK, firstOf(BOOK), ['0']);
        const second = newLoreSelection(BOOK, firstOf(BOOK));
        setLoreBookSelection(BOOK, second.id, ['3', '4']);
        loadWorldInfo.mockResolvedValue(HARBOR_BOOK);
        expect((await loadDecidedEntries(BOOK)).map(entry => entry.uid)).toEqual([0, 3, 4]);
        expect((await loadDecidedEntries(BOOK, getLoreSelection(BOOK, second.id))).map(entry => entry.uid)).toEqual([3, 4]);
    });

    it('reads none when SillyTavern has no such book, and lets a failed load throw', async () => {
        setLoreBookSelection(BOOK, firstOf(BOOK), ['0']);
        loadWorldInfo.mockResolvedValueOnce(null);
        expect(await loadDecidedEntries(BOOK)).toEqual([]);
        loadWorldInfo.mockRejectedValueOnce(new Error('HTTP 500'));
        await expect(loadDecidedEntries(BOOK)).rejects.toThrow('HTTP 500');
    });
});

describe('the book record', () => {
    it("keeps a selection's entries, pins and locks in the book's one settings record", () => {
        const id = firstOf(BOOK);
        setLoreBookSelection(BOOK, id, [1, '2', 2]);
        setLoreBookPins(BOOK, id, ['SEALED KNOWLEDGE', ' ', 'SEALED KNOWLEDGE']);
        setLoreSelectionLock(BOOK, id, { chatId: 'chat-1' }, true);

        expect(getLoreBook(BOOK)).toEqual({ selections: [{
            id, name: BOOK, selectedUids: ['1', '2'], pinnedSections: ['SEALED KNOWLEDGE'], lockedToChatIds: ['chat-1'], lockedToCharacterAvatars: [],
        }] });
        expect(selectionInUse(BOOK, { chatId: 'chat-1' })?.id).toBe(id);
        expect(selectionInUse(BOOK, { chatId: 'chat-2', characterAvatar: 'keeper-orrin.png' })).toBeNull();
        expect(Object.keys(extension_settings.vectfox)).toEqual(['lorebase_books']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(4);
    });

    it('has no record for a book nothing was selected in, and unlocks what it locked', () => {
        expect(getLoreBook('Another Book')).toBeNull();
        expect(loreSelectionsOf('Another Book')).toEqual([]);
        expect(selectionInUse('Another Book', { chatId: 'chat-1' })).toBeNull();
        // Each reply reads the records of the books it loads, so a read writes nothing to the settings.
        expect(extension_settings.vectfox).toEqual({});

        const id = firstOf(BOOK);
        setLoreSelectionLock(BOOK, id, { characterAvatar: 'keeper-orrin.png' }, true);
        expect(selectionInUse(BOOK, { characterAvatar: 'keeper-orrin.png' })?.id).toBe(id);
        setLoreSelectionLock(BOOK, id, { characterAvatar: 'keeper-orrin.png' }, false);
        expect(getLoreSelection(BOOK, id).lockedToCharacterAvatars).toEqual([]);
    });

    it('refuses to change a selection the book does not have', () => {
        expect(() => setLoreBookSelection(BOOK, 'gone', ['1'])).toThrow('LoreBase has no selection "gone" of lorebook "Harbor Lore".');
        expect(() => setLoreSelectionLock(BOOK, 'gone', { chatId: 'chat-1' }, true)).toThrow('no selection "gone"');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('moves every lock on a renamed character to its new avatar file name, and saves only when one moved', () => {
        setLoreSelectionLock(BOOK, firstOf(BOOK), { characterAvatar: 'keeper-orrin.png' }, true);
        const tide = firstOf('Tide Tables');
        setLoreSelectionLock('Tide Tables', tide, { characterAvatar: 'keeper-orrin.png' }, true);
        setLoreSelectionLock('Tide Tables', tide, { characterAvatar: 'wren.png' }, true);
        vi.mocked(saveSettingsDebounced).mockClear();

        renameLoreBookCharacter('keeper-orrin.png', 'keeper-orrin-the-elder.png');
        expect(loreSelectionsOf(BOOK)[0].lockedToCharacterAvatars).toEqual(['keeper-orrin-the-elder.png']);
        expect(getLoreSelection('Tide Tables', tide).lockedToCharacterAvatars).toEqual(['keeper-orrin-the-elder.png', 'wren.png']);
        expect(selectionInUse(BOOK, { characterAvatar: 'keeper-orrin.png' })).toBeNull();
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);

        renameLoreBookCharacter('nobody.png', 'somebody.png');
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it("moves every selection's lock on a renamed chat to its new name, leaving the character locks alone", () => {
        const id = firstOf(BOOK);
        setLoreSelectionLock(BOOK, id, { chatId: 'Harbor Night' }, true);
        setLoreSelectionLock(BOOK, id, { characterAvatar: 'Harbor Night' }, true);
        const lowTide = newLoreSelection(BOOK, id);
        setLoreSelectionLock(BOOK, lowTide.id, { chatId: 'Low Tide' }, true);
        vi.mocked(saveSettingsDebounced).mockClear();

        renameLoreBookChat('Harbor Night', 'Harbor Night, the storm');
        expect(getLoreSelection(BOOK, id)).toMatchObject({ lockedToChatIds: ['Harbor Night, the storm'], lockedToCharacterAvatars: ['Harbor Night'] });
        expect(getLoreSelection(BOOK, lowTide.id).lockedToChatIds).toEqual(['Low Tide']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    // SillyTavern opens the renamed chat (CHAT_CHANGED) before CHAT_RENAMED, so a page drawn for it showed the old lock.
    it('tells its listeners once a chat rename moved a lock, and not when none moved', () => {
        const id = firstOf(BOOK);
        setLoreSelectionLock(BOOK, id, { chatId: 'Harbor Night' }, true);
        const listener = vi.fn();
        const stopListening = onLoreBookChatLocksMoved(listener);

        renameLoreBookChat('Low Tide', 'Low Tide, the calm');
        expect(listener).not.toHaveBeenCalled();
        renameLoreBookChat('Harbor Night', 'Harbor Night, the storm');
        expect(listener).toHaveBeenCalledTimes(1);

        stopListening();
        renameLoreBookChat('Harbor Night, the storm', 'Harbor Night');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('renames nothing before any book has a record', () => {
        renameLoreBookCharacter('keeper-orrin.png', 'keeper-orrin-the-elder.png');
        renameLoreBookChat('Harbor Night', 'Harbor Night, the storm');
        expect(extension_settings.vectfox).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('keeps the entries the book held when the selection screen opened it, missing until the first opening', () => {
        firstOf(BOOK);
        expect(getLoreBook(BOOK)).not.toHaveProperty('seenUids');
        setLoreBookSeenEntries(BOOK, [0, '1', 1]);
        expect(getLoreBook(BOOK).seenUids).toEqual(['0', '1']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
    });

    it('counts, for each book with a record, the entries its selections hold together and its selections', () => {
        setLoreBookSelection(BOOK, firstOf(BOOK), ['1', '2']);
        setLoreBookSelection(BOOK, newLoreSelection(BOOK, firstOf(BOOK)).id, ['2', '3']);
        firstOf('Tide Tables');
        expect(loreBookRecordCounts()).toEqual({
            [BOOK]: { selectedCount: 3, selectionCount: 2 },
            'Tide Tables': { selectedCount: 0, selectionCount: 1 },
        });
        expect(selectedLoreBookNames()).toEqual([BOOK]);
    });
});

describe("a book's selections", () => {
    it('makes the first one with nothing selected, named after the book, once', () => {
        const first = ensureLoreSelection(BOOK);
        expect(first).toMatchObject({ name: BOOK, selectedUids: [], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        expect(ensureLoreSelection(BOOK)).toBe(first);
        expect(loreSelectionsOf(BOOK)).toHaveLength(1);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('copies one with New selection: its entries and pins, none of its locks, under the next number of the book', () => {
        const id = firstOf(BOOK);
        setLoreBookSelection(BOOK, id, ['1', '2']);
        setLoreBookPins(BOOK, id, ['RUMORS']);
        setLoreSelectionLock(BOOK, id, { chatId: 'Harbor Night' }, true);

        const second = newLoreSelection(BOOK, id);
        expect(second).toMatchObject({ name: 'Harbor Lore 2', selectedUids: ['1', '2'], pinnedSections: ['RUMORS'], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        expect(second.id).not.toBe(id);
        // The copy is its own: changing it leaves the one it came from.
        setLoreBookSelection(BOOK, second.id, ['3']);
        expect(getLoreSelection(BOOK, id).selectedUids).toEqual(['1', '2']);
        expect(newLoreSelection(BOOK, second.id).name).toBe('Harbor Lore 3');
        expect(loreSelectionsOf(BOOK).map(selection => selection.name)).toEqual(['Harbor Lore', 'Harbor Lore 2', 'Harbor Lore 3']);
    });

    it("copies the book's first, made first, when none is named, and refuses a selection the book does not have", () => {
        expect(() => newLoreSelection(BOOK, 'gone')).toThrow(`LoreBase has no selection "gone" of lorebook "${BOOK}".`);
        expect(getLoreBook(BOOK)).toBeNull();
        const copy = newLoreSelection(BOOK, null);
        expect(loreSelectionsOf(BOOK).map(selection => selection.name)).toEqual([BOOK, 'Harbor Lore 2']);
        expect(copy.selectedUids).toEqual([]);
        expect(() => getLoreSelection(BOOK, 'gone')).toThrow(`LoreBase has no selection "gone" of lorebook "${BOOK}".`);
    });

    it('renames one, and refuses a name with nothing in it', () => {
        const id = firstOf(BOOK);
        renameLoreSelection(BOOK, id, '  Arc one  ');
        expect(getLoreSelection(BOOK, id).name).toBe('Arc one');
        expect(() => renameLoreSelection(BOOK, id, '   ')).toThrow('A selection needs a name.');
        expect(getLoreSelection(BOOK, id).name).toBe('Arc one');
    });

    it("deletes one with its entries, pins and locks, and keeps a book's last", () => {
        const id = firstOf(BOOK);
        const second = newLoreSelection(BOOK, id);
        setLoreSelectionLock(BOOK, second.id, { chatId: 'Harbor Night' }, true);
        deleteLoreSelection(BOOK, second.id);
        expect(loreSelectionsOf(BOOK).map(selection => selection.id)).toEqual([id]);
        expect(selectionInUse(BOOK, { chatId: 'Harbor Night' })).toBeNull();
        expect(() => deleteLoreSelection(BOOK, id)).toThrow('"Harbor Lore" is the only selection of "Harbor Lore": Remove from LoreBase removes the book.');
        expect(loreSelectionsOf(BOOK)).toHaveLength(1);
    });

    it('locks one selection of a book to a chat, taking that chat off the others, and leaves their other locks', () => {
        const first = firstOf(BOOK);
        const second = newLoreSelection(BOOK, first).id;
        setLoreSelectionLock(BOOK, first, { chatId: 'Harbor Night' }, true);
        setLoreSelectionLock(BOOK, first, { chatId: 'Low Tide' }, true);
        setLoreSelectionLock(BOOK, first, { characterAvatar: 'wren.png' }, true);

        setLoreSelectionLock(BOOK, second, { chatId: 'Harbor Night' }, true);
        expect(getLoreSelection(BOOK, first)).toMatchObject({ lockedToChatIds: ['Low Tide'], lockedToCharacterAvatars: ['wren.png'] });
        expect(getLoreSelection(BOOK, second).lockedToChatIds).toEqual(['Harbor Night']);
        expect(selectionInUse(BOOK, { chatId: 'Harbor Night' })?.id).toBe(second);

        // Locking it again changes nothing; another book is never touched.
        setLoreSelectionLock(BOOK, second, { chatId: 'Harbor Night' }, true);
        expect(getLoreSelection(BOOK, second).lockedToChatIds).toEqual(['Harbor Night']);
    });

    it('locks one selection of a book to a character the same way, and uses the chat lock before the character lock', () => {
        const first = firstOf(BOOK);
        const second = newLoreSelection(BOOK, first).id;
        setLoreSelectionLock(BOOK, first, { characterAvatar: 'wren.png' }, true);
        setLoreSelectionLock(BOOK, second, { characterAvatar: 'wren.png' }, true);
        expect(getLoreSelection(BOOK, first).lockedToCharacterAvatars).toEqual([]);

        setLoreSelectionLock(BOOK, first, { chatId: 'Harbor Night' }, true);
        expect(selectionInUse(BOOK, { chatId: 'Harbor Night', characterAvatar: 'wren.png' })?.id).toBe(first);
        expect(selectionInUse(BOOK, { chatId: 'Low Tide', characterAvatar: 'wren.png' })?.id).toBe(second);
    });
});

describe('Clean up locks on the lorebooks', () => {
    const presentIn = names => name => names.includes(name);
    const targets = { isChatPresent: presentIn(['Harbor Night']), isCharacterPresent: presentIn(['wren.png']) };
    let first;
    let second;

    beforeEach(() => {
        first = firstOf(BOOK);
        setLoreBookSelection(BOOK, first, ['1']);
        setLoreSelectionLock(BOOK, first, { chatId: 'Harbor Night' }, true);
        setLoreSelectionLock(BOOK, first, { characterAvatar: 'wren.png' }, true);
        second = newLoreSelection(BOOK, first).id;
        setLoreSelectionLock(BOOK, second, { chatId: 'Low Tide' }, true);
        setLoreSelectionLock(BOOK, second, { characterAvatar: 'keeper-orrin.png' }, true);
        setLoreSelectionLock('Tide Tables', firstOf('Tide Tables'), { chatId: 'Harbor Night' }, true);
        vi.mocked(saveSettingsDebounced).mockClear();
    });

    it('counts the locks on chats and characters that no longer exist, in every selection, changing nothing until told to apply', () => {
        expect(cleanUpLoreBookLocks(targets, { shouldApply: false })).toEqual({ goneChatLockCount: 1, goneCharacterLockCount: 1 });
        expect(getLoreSelection(BOOK, second)).toMatchObject({ lockedToChatIds: ['Low Tide'], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('removes them, keeping the selections and the other locks, and saves once', () => {
        expect(cleanUpLoreBookLocks(targets, { shouldApply: true })).toEqual({ goneChatLockCount: 1, goneCharacterLockCount: 1 });
        expect(getLoreSelection(BOOK, first)).toMatchObject({ selectedUids: ['1'], lockedToChatIds: ['Harbor Night'], lockedToCharacterAvatars: ['wren.png'] });
        expect(getLoreSelection(BOOK, second)).toMatchObject({ selectedUids: ['1'], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        expect(loreSelectionsOf('Tide Tables')[0].lockedToChatIds).toEqual(['Harbor Night']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('judges no lock of a kind with no test for it, and saves nothing when no lock goes', () => {
        expect(cleanUpLoreBookLocks({ isChatPresent: null, isCharacterPresent: null }, { shouldApply: true })).toEqual({ goneChatLockCount: 0, goneCharacterLockCount: 0 });
        expect(getLoreSelection(BOOK, second)).toMatchObject({ lockedToChatIds: ['Low Tide'], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('reads no book record, or a broken one, as nothing to clean up', () => {
        extension_settings.vectfox = { lorebase_books: { Broken: null, 'No Selections': {}, 'No Lists': { selections: [{ id: 'first', selectedUids: ['1'] }] } } };
        expect(cleanUpLoreBookLocks(targets, { shouldApply: true })).toEqual({ goneChatLockCount: 0, goneCharacterLockCount: 0 });
        extension_settings.vectfox = {};
        expect(cleanUpLoreBookLocks(targets, { shouldApply: true })).toEqual({ goneChatLockCount: 0, goneCharacterLockCount: 0 });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});
