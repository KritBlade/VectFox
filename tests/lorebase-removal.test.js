/**
 * Remove from LoreBase's one confirm and removal (removeLoreBookAfterConfirm in src/features/lorebase/lorebase-removal.js,
 * §3.6 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md), which the Database Browser's lorebook
 * row and the WorldInfo page's book row both run: what the book holds read first, then the confirm naming it, which
 * opens on Cancel; Remove deleting it all, Cancel nothing; and a refusal before the confirm, as while LoreBase writes,
 * showing none. The storage module and the dialog are stubbed; the words are the real lorebase-files-core.js's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ answer: true }));

vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.answer) }));
// SillyTavern modules the ID module behind LoreBase's words reaches; nothing this test runs uses them.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/features/lorebase/lorebase-storage.js', () => ({ loreBookHoldings: vi.fn(), removeLoreBook: vi.fn() }));

const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { loreBookHoldings, removeLoreBook } = await import('../src/features/lorebase/lorebase-storage.js');
const { removalConfirmLines } = await import('../src/features/lorebase/lorebase-files-core.js');
const { removeLoreBookAfterConfirm } = await import('../src/features/lorebase/lorebase-removal.js');

const SETTINGS = { vector_backend: 'qdrant' };
const HOLDINGS = {
    bookName: 'Harbor Atlas', selectedCount: 18, pinnedCount: 0, chatLockCount: 0, characterLockCount: 1, keyCount: 0, tenants: [],
};
const REMOVED = { bookName: 'Harbor Atlas', keysDeleted: 0, partsDeleted: 0 };

beforeEach(() => {
    vi.clearAllMocks();
    host.answer = true;
    loreBookHoldings.mockResolvedValue(HOLDINGS);
    removeLoreBook.mockResolvedValue(REMOVED);
});

describe('Remove from LoreBase', () => {
    it('confirms with what the book holds, opening on Cancel, then removes it and gives what was deleted', async () => {
        expect(await removeLoreBookAfterConfirm('Harbor Atlas', SETTINGS)).toEqual(REMOVED);
        expect(loreBookHoldings).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(confirmPopup).toHaveBeenCalledWith(removalConfirmLines(HOLDINGS), { okButton: 'Remove', isDestructive: true });
        expect(removeLoreBook).toHaveBeenCalledWith('Harbor Atlas', SETTINGS);
        expect(confirmPopup.mock.invocationCallOrder[0]).toBeLessThan(removeLoreBook.mock.invocationCallOrder[0]);
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
