/**
 * @vitest-environment jsdom
 *
 * Compact collection in the Database Browser (src/features/database-browser/database-browser.js), pressed as a user
 * would: only EventBase collections in Qdrant get the button; it says when there is nothing to compact, counts what it
 * removes before it runs, removes nothing on Cancel, and shows the collection's new count once it ran.
 *
 * The real browser and its markup run; the collections, the EventBase compaction, the dialogs it opens over itself and
 * the host modules are stubbed, and its dialog is the page.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, close: null, collections: [] }));
const compaction = vi.hoisted(() => ({ planCollectionCompaction: vi.fn(), compactCollection: vi.fn() }));

vi.mock('../src/features/collections/index.js', () => ({
    loadAllCollections: async () => host.collections.map(collection => ({ ...collection })),
    getCollectionListing: () => [],
    cleanupOrphanedMeta: () => ({ removed: 0 }),
    sanitizeHandleId: name => String(name ?? '').toLowerCase(),
}));
vi.mock('../src/features/eventbase/index.js', async () => ({
    ...compaction,
    STORY_LINKS_FILE_TYPE: 'vectfox-story-links',
    describeCompaction: (await import('../src/features/eventbase/eventbase-compaction-core.js')).describeCompaction,
}));
vi.mock('../src/features/lorebase/index.js', () => ({
    KEYS: 'keys', VECTORS: 'vectors', LOREBASE_KEYS_FILE_TYPE: 'vectfox-lorebase-keys', LOREBASE_VECTORS_FILE_TYPE: 'vectfox-lorebase-vectors',
    loreBaseStorageRows: async () => [],
}));
vi.mock('../src/features/vector-backend/index.js', () => ({}));
vi.mock('../src/features/embedding/index.js', () => ({ searchPieces: text => (String(text ?? '').trim() ? [text] : []) }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: async () => true }));
vi.mock('../src/sillytavern/popup.js', () => ({
    confirmPopup: vi.fn(async () => host.answer),
    // The dialog door: the browser is on the page while it is open, until the test closes it.
    openPanelPopup: vi.fn((root) => {
        document.body.append(root);
        return new Promise((resolve) => { host.close = resolve; });
    }),
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getCurrentChatId: () => 'chat-1', getContext: () => ({ name1: 'Rook' }), chat_metadata: {} }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/features/database-browser/chunk-visualizer.js', () => ({ openChunkVisualizer: vi.fn() }));
vi.mock('../src/features/database-browser/size-inspector.js', () => ({ bindSizeInspector: vi.fn() }));
vi.mock('../src/features/database-browser/collection-dialogs.js', () => ({ editCollectionSettings: vi.fn(), renameCollection: vi.fn(), switchCollectionModel: vi.fn() }));

const { initializeDatabaseBrowser, openDatabaseBrowser } = await import('../src/features/database-browser/database-browser.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');

const MIRA = { id: 'vf_eventbase_qdrant_rook_mira_aaaa', registryKey: 'qdrant:vf_eventbase_qdrant_rook_mira_aaaa', name: 'Mira', type: 'chat', backend: 'qdrant', chunkCount: 9, enabled: true, scope: 'chat' };
const COLLECTIONS = [
    MIRA,
    { id: 'vf_archiveevent_qdrant_rook_mira_bbbb', registryKey: 'qdrant:vf_archiveevent_qdrant_rook_mira_bbbb', name: 'Mira, a chat file', type: 'chat', backend: 'qdrant', chunkCount: 5, enabled: true, scope: 'chat' },
    { id: 'vf_eventbase_standard_rook_mira_cccc', registryKey: 'standard:vf_eventbase_standard_rook_mira_cccc', name: 'Mira, stored locally', type: 'chat', backend: 'standard', chunkCount: 4, enabled: true, scope: 'chat' },
    { id: 'vf_lorebook_qdrant_rook_harbor', registryKey: 'qdrant:vf_lorebook_qdrant_rook_harbor', name: 'Harbor', type: 'lorebook', backend: 'qdrant', chunkCount: 3, enabled: true },
];
const SETTINGS = { vector_backend: 'qdrant', superadmin: true };
initializeDatabaseBrowser(SETTINGS);

const PLAN = { repeats: [{ _hash: 1 }, { _hash: 2 }, { _hash: 3 }], repeatWindowCount: 2, linkMoves: [{}], movedLinkCount: 1 };
const EMPTY_PLAN = { repeats: [], repeatWindowCount: 0, linkMoves: [], movedLinkCount: 0 };

const compactButton = collection => document.querySelector(`[data-collection-action="compact"][data-collection-key="${collection.registryKey}"]`);
const rowOf = collection => document.querySelector(`[data-collection-entry="${collection.registryKey}"]`);

async function openBrowser() {
    void openDatabaseBrowser();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(COLLECTIONS.length));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
    host.answer = true;
    host.collections = COLLECTIONS;
    SETTINGS.vector_backend = 'qdrant';
    compaction.planCollectionCompaction.mockResolvedValue(PLAN);
    compaction.compactCollection.mockResolvedValue({ removedCount: 3, linkMoves: { writtenCount: 1, failedCount: 0, isStopped: false } });
});

afterEach(async () => {
    host.close?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.innerHTML = '';
});

describe('Compact collection', () => {
    it('is offered on EventBase collections in Qdrant, of a chat or a chat file, and on no other', async () => {
        await openBrowser();
        const keys = [...document.querySelectorAll('[data-collection-action="compact"]')].map(button => button.dataset.collectionKey);
        expect(keys).toEqual([COLLECTIONS[0].registryKey, COLLECTIONS[1].registryKey]);
    });

    it('is offered on none while VectFox uses another backend', async () => {
        SETTINGS.vector_backend = 'standard';
        await openBrowser();
        expect(document.querySelectorAll('[data-collection-action="compact"]')).toHaveLength(0);
    });

    it('says when a collection has nothing to compact, and asks nothing', async () => {
        compaction.planCollectionCompaction.mockResolvedValue(EMPTY_PLAN);
        await openBrowser();
        compactButton(MIRA).click();
        await vi.waitFor(() => expect(toastr.info).toHaveBeenCalledWith('This collection has nothing to compact.', 'VectFox'));
        expect(compaction.planCollectionCompaction).toHaveBeenCalledWith(MIRA.id, SETTINGS);
        expect(confirmPopup).not.toHaveBeenCalled();
    });

    it('counts what it removes before it runs, and Cancel removes nothing', async () => {
        host.answer = false;
        await openBrowser();
        compactButton(MIRA).click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        const [lines, options] = confirmPopup.mock.calls[0];
        const sentences = lines.flatMap(line => [line.text, line.name, ...(line.parts ?? []).map(part => part.name)]).filter(Boolean);
        expect(sentences).toEqual(expect.arrayContaining([
            'Mira',
            'It removes 3 repeated events in 2 windows. Each window keeps the events of its newest reading.',
            '1 StoryArc link points at a repeated event, so it moves to the event that stays in its window.',
        ]));
        expect(options).toMatchObject({ okButton: 'Compact', isDestructive: true });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(compaction.compactCollection).not.toHaveBeenCalled();
    });

    it('removes them on Compact, and the row shows the collection\'s new count', async () => {
        await openBrowser();
        compactButton(MIRA).click();
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledWith('Removed 3 repeated events from Mira', 'VectFox'));
        expect(compaction.compactCollection).toHaveBeenCalledWith(PLAN, MIRA.id, SETTINGS);
        expect(rowOf(MIRA).textContent).toContain('Chunks: 6');
    });

    it('says nothing was removed when the links did not all move, and keeps the count', async () => {
        compaction.compactCollection.mockResolvedValue({ removedCount: 0, linkMoves: { writtenCount: 0, failedCount: 1, isStopped: false } });
        await openBrowser();
        compactButton(MIRA).click();
        await vi.waitFor(() => expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('Nothing was removed'), 'VectFox'));
        expect(toastr.success).not.toHaveBeenCalled();
        expect(rowOf(MIRA).textContent).toContain('Chunks: 9');
    });

    it('says what broke when the collection cannot be read', async () => {
        compaction.planCollectionCompaction.mockRejectedValue(new Error('Could not read this collection\'s events. See the console.'));
        await openBrowser();
        compactButton(MIRA).click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith('Compact collection failed: Could not read this collection\'s events. See the console.', 'VectFox'));
    });
});
