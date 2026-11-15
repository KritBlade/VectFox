/**
 * The start-up deletion of the old vectorized lorebook collections LoreBase replaced (src/features/lorebase/
 * lorebase-old-collections.js, plan D5 and §6.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * once SillyTavern has loaded, each collection's locks move to its book, it is deleted where discovery found it, and
 * one notice names the books; nothing is asked, and a failure is logged, counted and tried again at the next start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ appReadyListeners: [], registry: [], locks: {}, discovered: {}, worldNames: [] }));

vi.mock('../src/features/collections/index.js', () => ({
    deleteCollection: vi.fn(async () => ({ success: true, errors: [] })),
    discoveredIndexesOf: vi.fn(key => host.discovered[key] ?? null),
    getCollectionCharacterLocks: vi.fn(key => host.locks[key]?.characters ?? []),
    getCollectionLocks: vi.fn(key => host.locks[key]?.chats ?? []),
    getCollectionRegistry: vi.fn(() => host.registry),
}));
vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: vi.fn(() => ({ characters: [{ avatar: 'wren.png' }, { avatar: 'keeper_orrin.png' }] })),
    getCurrentChatId: vi.fn(), chat_metadata: {},
}));
vi.mock('../src/sillytavern/events.js', () => ({
    event_types: { APP_READY: 'app_ready' },
    eventSource: { once: vi.fn((type, listener) => { if (type === 'app_ready') host.appReadyListeners.push(listener); }) },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ noticePopup: vi.fn(async () => {}) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
// SillyTavern's live list of lorebooks: one array, changed in place.
vi.mock('../src/sillytavern/world-info.js', () => ({ world_names: host.worldNames }));

const { deleteCollection, getCollectionRegistry } = await import('../src/features/collections/index.js');
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

/** Start the deletion, let SillyTavern finish loading, and wait for it. */
async function runAtStart() {
    const running = deleteOldLorebookCollections(SETTINGS);
    for (const listener of host.appReadyListeners.splice(0)) listener();
    await running;
}

/** A line's text as the dialog shows it. */
const shown = line => (line.parts ? line.parts.map(part => part.text ?? part.name).join('') : [line.text, line.name].filter(Boolean).join(' '));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteCollection).mockReset().mockResolvedValue({ success: true, errors: [] });
    extension_settings.vectfox = {};
    Object.assign(host, {
        appReadyListeners: [],
        registry: [ATLAS, EVENTS, ATLAS_AGAIN, TIDES],
        locks: { [ATLAS]: { chats: ['chat-1'], characters: ['1'] }, [TIDES]: { chats: ['chat-2'], characters: ['5'] } },
        discovered: { [ATLAS]: { backend: 'qdrant', sources: [{ source: 'openai', models: [{ path: 'text-embedding-3-large' }] }] } },
    });
    host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Tide Tables');
});

describe('deleting the old lorebook collections at start', () => {
    it('deletes each where discovery found it, else on its own backend, and leaves every other collection', async () => {
        await runAtStart();

        expect(vi.mocked(deleteCollection).mock.calls).toEqual([
            ['vf_lorebook_qdrant_wren_harbor_atlas_1700000000000',
                { ...SETTINGS, vector_backend: 'qdrant', _discoveredSources: host.discovered[ATLAS].sources }, ATLAS],
            ['vf_lorebook_vectra_wren_harbor_atlas_1700000000001', { ...SETTINGS, vector_backend: 'vectra', _discoveredSources: [] }, ATLAS_AGAIN],
            [TIDES, { ...SETTINGS, vector_backend: 'standard', _discoveredSources: [] }, TIDES],
        ]);
    });

    it("moves each collection's chat and character locks to its book before deleting it", async () => {
        vi.mocked(deleteCollection).mockImplementation(async () => {
            expect(getLoreBook('Harbor Atlas')?.lockedToChatIds).toEqual(['chat-1']);
            return { success: true, errors: [] };
        });

        await runAtStart();

        expect(getLoreBook('Harbor Atlas')).toMatchObject({ lockedToChatIds: ['chat-1'], lockedToCharacterAvatars: ['keeper_orrin.png'] });
        // No character sits at place 5 in SillyTavern's list, so that lock has no one to move to.
        expect(getLoreBook('Tide Tables')).toMatchObject({ lockedToChatIds: ['chat-2'], lockedToCharacterAvatars: [] });
    });

    it('then shows one notice naming each book once, without asking anything', async () => {
        await runAtStart();

        expect(noticePopup).toHaveBeenCalledTimes(1);
        const [lines] = vi.mocked(noticePopup).mock.calls[0];
        expect(lines.filter(line => line.icon === 'fa-book').map(line => line.name)).toEqual(['Harbor Atlas', 'Tide Tables']);
        expect(lines.map(shown)).toContain('Each book is locked to the chats and characters its old collections were locked to.');
    });

    it('waits for SillyTavern to load, as the books and characters are read there', async () => {
        const running = deleteOldLorebookCollections(SETTINGS);
        await Promise.resolve();
        expect(getCollectionRegistry).not.toHaveBeenCalled();
        expect(deleteCollection).not.toHaveBeenCalled();
        for (const listener of host.appReadyListeners.splice(0)) listener();
        await running;
        expect(deleteCollection).toHaveBeenCalledTimes(3);
    });

    it('joins a run already going rather than deleting twice', async () => {
        const first = deleteOldLorebookCollections(SETTINGS);
        const second = deleteOldLorebookCollections(SETTINGS);
        expect(second).toBe(first);
        for (const listener of host.appReadyListeners.splice(0)) listener();
        await first;
        expect(deleteCollection).toHaveBeenCalledTimes(3);
    });

    it('does nothing and shows nothing without an old lorebook collection', async () => {
        host.registry = [EVENTS];
        await runAtStart();
        expect(deleteCollection).not.toHaveBeenCalled();
        expect(noticePopup).not.toHaveBeenCalled();
    });

    it('counts what it could not delete in the notice, logging why', async () => {
        vi.mocked(deleteCollection)
            .mockResolvedValueOnce({ success: true, errors: [] })
            .mockResolvedValueOnce({ success: false, errors: ['Vectors: purge failed (see console)'] })
            .mockRejectedValueOnce(new Error('Complete deletion failure'));

        await runAtStart();

        expect(log.warn).toHaveBeenCalledTimes(2);
        const [lines] = vi.mocked(noticePopup).mock.calls[0];
        expect(lines.map(shown)).toContain('VectFox could not delete 2 other old lorebook collections. It tries again at the next start.');
    });

    it('shows no notice when none could be deleted, to try again at the next start', async () => {
        vi.mocked(deleteCollection).mockRejectedValue(new Error('the backend is down'));
        await runAtStart();
        expect(noticePopup).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledTimes(3);
    });

    it('never throws, logging a failure it did not expect', async () => {
        vi.mocked(getCollectionRegistry).mockImplementationOnce(() => { throw new Error('no settings'); });
        await expect(runAtStart()).resolves.toBeUndefined();
        expect(log.error).toHaveBeenCalledWith('LoreBase: deleting the old lorebook collections failed:', expect.any(Error));
    });
});
