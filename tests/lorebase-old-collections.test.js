/**
 * The start-up deletion of the old vectorized lorebook collections LoreBase replaced (src/features/lorebase/
 * lorebase-old-collections.js, plan D5 and §6.4 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md):
 * each collection's locks move to its book, it goes to the collections feature's delete where discovery found it, with
 * its own backend as the fallback and LoreBase as the name its log gives, and the notice's lines, naming the books, go
 * back to src/app/retired-collections.js, which shows them in its one notice; this part shows and asks nothing itself.
 * A collection that could not be deleted is counted in the lines and tried again at the next start, and a failure it
 * did not expect is logged, never thrown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ registry: [], locks: {}, worldNames: [] }));

vi.mock('../src/features/collections/index.js', () => ({
    deleteCollectionWhereDiscovered: vi.fn(async () => true),
    getCollectionCharacterLocks: vi.fn(key => host.locks[key]?.characters ?? []),
    getCollectionLocks: vi.fn(key => host.locks[key]?.chats ?? []),
    getCollectionRegistry: vi.fn(() => host.registry),
}));
vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: vi.fn(() => ({ characters: [{ avatar: 'wren.png' }, { avatar: 'keeper_orrin.png' }] })),
    getCurrentChatId: vi.fn(), chat_metadata: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ noticePopup: vi.fn(async () => {}) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
// SillyTavern's live list of lorebooks: one array, changed in place.
vi.mock('../src/sillytavern/world-info.js', () => ({ world_names: host.worldNames }));

const { deleteCollectionWhereDiscovered, getCollectionRegistry } = await import('../src/features/collections/index.js');
const { log } = await import('../src/sillytavern/log.js');
const { noticePopup } = await import('../src/sillytavern/popup.js');
const { extension_settings } = await import('../src/sillytavern/settings.js');
const { getLoreBook } = await import('../src/features/lorebase/lorebase-books.js');
const { deleteOldLorebookCollections } = await import('../src/features/lorebase/lorebase-old-collections.js');

const SETTINGS = { vector_backend: 'standard', embedding_provider: 'transformers' };
const ATLAS = 'qdrant:vf_lorebook_qdrant_wren_harbor_atlas_1700000000000';
const ATLAS_AGAIN = 'vectra:vf_lorebook_vectra_wren_harbor_atlas_1700000000001';
const TIDES = 'vf_lorebook_wren_tide_tables_1690000000000';
const EVENTS = 'qdrant:vf_eventbase_wren_harbor_1';

/** A line's text as the dialog shows it. */
const shown = line => (line.parts ? line.parts.map(part => part.text ?? part.name).join('') : [line.text, line.name].filter(Boolean).join(' '));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteCollectionWhereDiscovered).mockReset().mockResolvedValue(true);
    extension_settings.vectfox = {};
    Object.assign(host, {
        registry: [ATLAS, EVENTS, ATLAS_AGAIN, TIDES],
        locks: { [ATLAS]: { chats: ['chat-1'], characters: ['1'] }, [TIDES]: { chats: ['chat-2'], characters: ['5'] } },
    });
    host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Tide Tables');
});

describe('deleting the old lorebook collections at start', () => {
    it('deletes each where discovery found it, its own backend the fallback, under LoreBase\'s name, and leaves every other collection', async () => {
        await deleteOldLorebookCollections(SETTINGS);

        expect(vi.mocked(deleteCollectionWhereDiscovered).mock.calls).toEqual([
            [expect.objectContaining({ registryKey: ATLAS, collectionId: 'vf_lorebook_qdrant_wren_harbor_atlas_1700000000000', backend: 'qdrant' }), SETTINGS, 'LoreBase'],
            [expect.objectContaining({ registryKey: ATLAS_AGAIN, collectionId: 'vf_lorebook_vectra_wren_harbor_atlas_1700000000001', backend: 'vectra' }), SETTINGS, 'LoreBase'],
            [expect.objectContaining({ registryKey: TIDES, collectionId: TIDES, backend: null }), SETTINGS, 'LoreBase'],
        ]);
    });

    it("moves each collection's chat and character locks to its book before deleting it", async () => {
        vi.mocked(deleteCollectionWhereDiscovered).mockImplementation(async () => {
            expect(getLoreBook('Harbor Atlas')?.selections[0].lockedToChatIds).toEqual(['chat-1']);
            return true;
        });

        await deleteOldLorebookCollections(SETTINGS);

        expect(getLoreBook('Harbor Atlas').selections).toEqual([expect.objectContaining({ name: 'Harbor Atlas', lockedToChatIds: ['chat-1'], lockedToCharacterAvatars: ['keeper_orrin.png'] })]);
        // No character sits at place 5 in SillyTavern's list, so that lock has no one to move to.
        expect(getLoreBook('Tide Tables').selections[0]).toMatchObject({ lockedToChatIds: ['chat-2'], lockedToCharacterAvatars: [] });
    });

    it('returns the notice lines, naming each book once, and shows nothing itself', async () => {
        const lines = await deleteOldLorebookCollections(SETTINGS);

        expect(lines.filter(line => line.icon === 'fa-book').map(line => line.name)).toEqual(['Harbor Atlas', 'Tide Tables']);
        expect(lines.map(shown)).toContain('A book whose old collections were locked to chats or characters is already locked to the same ones.');
        expect(noticePopup).not.toHaveBeenCalled();
    });

    it('deletes nothing and returns no lines without an old lorebook collection', async () => {
        host.registry = [EVENTS];
        await expect(deleteOldLorebookCollections(SETTINGS)).resolves.toEqual([]);
        expect(deleteCollectionWhereDiscovered).not.toHaveBeenCalled();
    });

    it('counts what it could not delete in the lines', async () => {
        vi.mocked(deleteCollectionWhereDiscovered)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);

        const lines = await deleteOldLorebookCollections(SETTINGS);

        expect(deleteCollectionWhereDiscovered).toHaveBeenCalledTimes(3);
        expect(lines.map(shown)).toContain('VectFox could not delete 2 other old lorebook collections. It tries again at the next start.');
    });

    it('returns no lines when none could be deleted, to try again at the next start', async () => {
        vi.mocked(deleteCollectionWhereDiscovered).mockResolvedValue(false);
        await expect(deleteOldLorebookCollections(SETTINGS)).resolves.toEqual([]);
        expect(deleteCollectionWhereDiscovered).toHaveBeenCalledTimes(3);
    });

    it('never throws, logging a failure it did not expect and returning no lines', async () => {
        vi.mocked(getCollectionRegistry).mockImplementationOnce(() => { throw new Error('no settings'); });
        await expect(deleteOldLorebookCollections(SETTINGS)).resolves.toEqual([]);
        expect(log.error).toHaveBeenCalledWith('LoreBase: deleting the old lorebook collections failed:', expect.any(Error));
    });
});
