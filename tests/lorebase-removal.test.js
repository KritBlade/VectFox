/**
 * Remove from LoreBase's one confirm and removal (removeLoreBookAfterConfirm in src/features/lorebase/lorebase-removal.js,
 * §3.6 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), which the Database Browser's lorebook
 * row and the WorldInfo page's book row both run: what the book holds read first, then the confirm naming it, which
 * opens on Cancel; Remove deleting it all and unlinking nothing, Cancel nothing; and a refusal before the confirm, as
 * while LoreBase writes, showing none. The WorldInfo page's Unlink runs them too: its confirm, whose button is Unlink,
 * also names the chat's lists the book is unlinked from, and once removed from LoreBase it is unlinked from them. And
 * the one delete of a single selection (deleteLoreSelectionAfterConfirm, §3.7), which Choose entries' Delete and the
 * WorldInfo row's trash on one of several selections both run: Choose entries' confirm, opening on Cancel, then the
 * selection deleted and, on Qdrant, the vectors no other selection holds pruned; the book itself never removed. The
 * storage module, the record, the vectors, the chat's lists and the dialog are stubbed; the words are the real
 * lorebase-files-core.js's and lorebase-selection-markup.js's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ answer: true }));

vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.answer) }));
// SillyTavern modules the ID module behind LoreBase's words reaches; nothing this test runs uses them.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/features/lorebase/lorebase-storage.js', () => ({ loreBookHoldings: vi.fn(), removeLoreBook: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-chat-books.js', () => ({ chatBookLinks: vi.fn(), unlinkLoreBookFromChat: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-books.js', () => ({ getLoreSelection: vi.fn(), deleteLoreSelection: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-vectors.js', () => ({ pruneBookVectors: vi.fn(async () => {}) }));
vi.mock('../src/features/lorebase/lorebase-switch.js', () => ({ isLoreBaseBackend: vi.fn() }));

const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { loreBookHoldings, removeLoreBook } = await import('../src/features/lorebase/lorebase-storage.js');
const { chatBookLinks, unlinkLoreBookFromChat } = await import('../src/features/lorebase/lorebase-chat-books.js');
const { deleteLoreSelection, getLoreSelection } = await import('../src/features/lorebase/lorebase-books.js');
const { pruneBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
const { isLoreBaseBackend } = await import('../src/features/lorebase/lorebase-switch.js');
const { removalConfirmLines } = await import('../src/features/lorebase/lorebase-files-core.js');
const { deleteSelectionLines } = await import('../src/features/lorebase/lorebase-selection-markup.js');
const { deleteLoreSelectionAfterConfirm, removeLoreBookAfterConfirm } = await import('../src/features/lorebase/lorebase-removal.js');

const SETTINGS = { vector_backend: 'qdrant' };
const HOLDINGS = {
    bookName: 'Harbor Atlas', selectedCount: 18, pinnedCount: 0, chatLockCount: 0, characterLockCount: 1, keyCount: 0, tenants: [],
};
const REMOVED = { bookName: 'Harbor Atlas', keysDeleted: 0, partsDeleted: 0 };
const LINKS = { unlinkedFrom: ['characterBooks'], stillLoadedBy: [] };
const UNLINKED = { unlinkedFrom: ['characterBooks'], stillLoadedBy: [] };

beforeEach(() => {
    vi.clearAllMocks();
    host.answer = true;
    loreBookHoldings.mockResolvedValue(HOLDINGS);
    removeLoreBook.mockResolvedValue(REMOVED);
    chatBookLinks.mockReturnValue(LINKS);
    unlinkLoreBookFromChat.mockResolvedValue(UNLINKED);
    getLoreSelection.mockReturnValue({ id: 'night', name: 'Night watch' });
    isLoreBaseBackend.mockReturnValue(true);
});

describe('Deleting one selection', () => {
    it("asks with Choose entries' words, opening on Cancel, then deletes the selection and prunes the book's vectors, never removing the book", async () => {
        expect(await deleteLoreSelectionAfterConfirm('Harbor Atlas', 'night', SETTINGS)).toEqual({ bookName: 'Harbor Atlas', selectionName: 'Night watch' });
        expect(confirmPopup).toHaveBeenCalledWith(deleteSelectionLines('Night watch'), { okButton: 'Delete', isDestructive: true });
        expect(deleteLoreSelection).toHaveBeenCalledWith('Harbor Atlas', 'night');
        expect(pruneBookVectors).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(deleteLoreSelection.mock.invocationCallOrder[0]).toBeLessThan(pruneBookVectors.mock.invocationCallOrder[0]);
        expect(removeLoreBook).not.toHaveBeenCalled();
    });

    it('deletes nothing on Cancel, and prunes no vectors off Qdrant', async () => {
        host.answer = false;
        expect(await deleteLoreSelectionAfterConfirm('Harbor Atlas', 'night', SETTINGS)).toBeNull();
        expect(deleteLoreSelection).not.toHaveBeenCalled();
        host.answer = true;
        isLoreBaseBackend.mockReturnValue(false);
        await deleteLoreSelectionAfterConfirm('Harbor Atlas', 'night', SETTINGS);
        expect(deleteLoreSelection).toHaveBeenCalledTimes(1);
        expect(pruneBookVectors).not.toHaveBeenCalled();
    });

    it("shows no confirm for a selection the book lacks, and prunes nothing when the book's last selection is refused", async () => {
        getLoreSelection.mockImplementationOnce(() => { throw new Error('Lorebook "Harbor Atlas" has no selection "gone".'); });
        await expect(deleteLoreSelectionAfterConfirm('Harbor Atlas', 'gone', SETTINGS)).rejects.toThrow('has no selection');
        expect(confirmPopup).not.toHaveBeenCalled();
        deleteLoreSelection.mockImplementationOnce(() => { throw new Error('"Night watch" is the only selection of "Harbor Atlas": Remove from LoreBase removes the book.'); });
        await expect(deleteLoreSelectionAfterConfirm('Harbor Atlas', 'night', SETTINGS)).rejects.toThrow('only selection');
        expect(pruneBookVectors).not.toHaveBeenCalled();
    });
});

describe('Remove from LoreBase', () => {
    it('confirms with what the book holds, opening on Cancel, then removes it, unlinking nothing, and gives what was deleted', async () => {
        expect(await removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS)).toEqual(REMOVED);
        expect(loreBookHoldings).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(confirmPopup).toHaveBeenCalledWith(removalConfirmLines(HOLDINGS), { okButton: 'Remove', isDestructive: true });
        expect(removeLoreBook).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(confirmPopup.mock.invocationCallOrder[0]).toBeLessThan(removeLoreBook.mock.invocationCallOrder[0]);
        expect(chatBookLinks).not.toHaveBeenCalled();
        expect(unlinkLoreBookFromChat).not.toHaveBeenCalled();
    });

    it("Unlink names the chat's lists in its confirm, whose button is Unlink, then unlinks the book from them once it is removed", async () => {
        expect(await removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS, { shouldUnlink: true })).toEqual({ ...REMOVED, ...UNLINKED });
        expect(confirmPopup).toHaveBeenCalledWith(removalConfirmLines(HOLDINGS, LINKS), { okButton: 'Unlink', isDestructive: true });
        expect(removeLoreBook).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(unlinkLoreBookFromChat).toHaveBeenCalledWith('Harbor Atlas');
        expect(removeLoreBook.mock.invocationCallOrder[0]).toBeLessThan(unlinkLoreBookFromChat.mock.invocationCallOrder[0]);
    });

    it("Unlink unlinks the book from no list when it cannot be removed from LoreBase, nor on Cancel", async () => {
        host.answer = false;
        expect(await removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS, { shouldUnlink: true })).toBeNull();
        host.answer = true;
        removeLoreBook.mockRejectedValue(new Error('Similharity could not delete LoreBase\'s keys (HTTP 500)'));
        await expect(removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS, { shouldUnlink: true })).rejects.toThrow('HTTP 500');
        expect(unlinkLoreBookFromChat).not.toHaveBeenCalled();
    });

    it('removes nothing on Cancel', async () => {
        host.answer = false;
        expect(await removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS)).toBeNull();
        expect(removeLoreBook).not.toHaveBeenCalled();
    });

    it('shows no confirm when what the book holds cannot be read, as while LoreBase writes, and says why', async () => {
        loreBookHoldings.mockRejectedValue(new Error('LoreBase is already writing keys or vectors; the progress panel shows them.'));
        await expect(removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS)).rejects.toThrow('LoreBase is already writing keys or vectors');
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(removeLoreBook).not.toHaveBeenCalled();
    });
});
