/**
 * @vitest-environment jsdom
 *
 * LoreBase's rows in the Database Browser (src/features/database-browser/database-browser.js, §3.2 and §3.3 of
 * InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md), pressed as a user would: each lorebook's keys
 * row and vectors rows after the collections, under All types and LoreBase alone; each row's actions as what it holds
 * allows; Export downloading the row's file and saying what it left out; Import confirming what it writes and skips
 * before writing, and writing nothing on Cancel or when nothing matches; Delete confirming what is lost; Import a
 * collection refusing a row's file and naming its row; and a notice where the rows go when they cannot be read.
 *
 * The real browser, its markup and LoreBase's file words (lorebase-files-core.js) run; the collections, LoreBase's
 * storage module, the file picker, the dialogs and the host modules are stubbed, and its dialog is the page.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, close: null, collections: [], rows: [], rowsError: null, fileData: null, rowReads: 0 }));
const storage = vi.hoisted(() => ({
    exportStored: vi.fn(), planImport: vi.fn(), writeImport: vi.fn(), deleteStoredRow: vi.fn(),
}));

vi.mock('../src/features/collections/index.js', () => ({
    loadAllCollections: async () => host.collections.map(collection => ({ ...collection })),
    getCollectionListing: () => [],
    cleanupOrphanedMeta: () => ({ removed: 0 }),
    sanitizeHandleId: name => String(name ?? '').toLowerCase(),
    downloadExport: vi.fn(),
    readImportFile: vi.fn(async () => host.fileData),
    exportFileKind: data => (typeof data?.type === 'string' && data.type !== 'multi' ? data.type : 'collection'),
    MAX_IMPORT_FILE_BYTES: 400 * 1024 * 1024,
}));
vi.mock('../src/features/lorebase/index.js', async () => {
    const files = await import('../src/features/lorebase/lorebase-files-core.js');
    return {
        KEYS: 'keys',
        VECTORS: 'vectors',
        LOREBASE_KEYS_FILE_TYPE: files.LOREBASE_KEYS_FILE_TYPE,
        LOREBASE_VECTORS_FILE_TYPE: files.LOREBASE_VECTORS_FILE_TYPE,
        describeDelete: files.describeDelete,
        describeExport: files.describeExport,
        describeImport: files.describeImport,
        describeImported: files.describeImported,
        nothingToImportText: files.nothingToImportText,
        loreBaseStorageRows: async () => {
            host.rowReads += 1;
            if (host.rowsError) throw host.rowsError;
            return host.rows.map(row => ({ ...row }));
        },
        ...storage,
    };
});
vi.mock('../src/features/eventbase/index.js', () => ({ STORY_LINKS_FILE_TYPE: 'vectfox-story-links' }));
vi.mock('../src/features/vector-backend/index.js', () => ({}));
vi.mock('../src/features/embedding/index.js', () => ({ searchPieces: text => [text], getModelFromSettings: () => 'baai/bge-m3' }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: async () => true }));
vi.mock('../src/shared/pick-files.js', () => ({ pickFiles: vi.fn(async () => [{ name: 'harbor-lorebase-keys.vectfox.json', size: 100, type: 'application/json' }]) }));
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
const { downloadExport } = await import('../src/features/collections/index.js');

const MIRA = { id: 'vf_eventbase_qdrant_rook_mira_aaaa', registryKey: 'qdrant:vf_eventbase_qdrant_rook_mira_aaaa', name: 'Mira', type: 'chat', backend: 'qdrant', chunkCount: 9, enabled: true, scope: 'chat' };
const HARBOR_TENANT = 'vf_lorebase_qdrant_rook_harbor_atlas_19qag9zxydm';
const facts = (book, isInSillyTavern) => ({ book, hasRecord: true, isInSillyTavern });
const HARBOR_KEYS = { key: 'keys|Harbor Atlas', kind: 'keys', ...facts('Harbor Atlas', true), entryCount: 313 };
const HARBOR_VECTORS = {
    key: `vectors|vf_lorebase_rook|${HARBOR_TENANT}`, kind: 'vectors', ...facts('Harbor Atlas', true), collection: 'vf_lorebase_rook',
    tenant: HARBOR_TENANT, isHere: true, pointCount: 504, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3',
};
const PIER_KEYS = { key: 'keys|Old Pier', kind: 'keys', ...facts('Old Pier', false), entryCount: 2 };
const PIER_HERE = {
    key: 'vectors|vf_lorebase_rook|Old Pier', kind: 'vectors', ...facts('Old Pier', false), collection: 'vf_lorebase_rook', tenant: null,
    isHere: true, pointCount: 0, embeddingSource: '', embeddingModel: '',
};
const PIER_ELSEWHERE = {
    key: 'vectors|vectfox_main|vf_lorebase_qdrant_rook_old_pier_7k', kind: 'vectors', ...facts('Old Pier', false), collection: 'vectfox_main',
    tenant: 'vf_lorebase_qdrant_rook_old_pier_7k', isHere: false, pointCount: 50, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3',
};
const ROWS = [HARBOR_KEYS, HARBOR_VECTORS, PIER_KEYS, PIER_HERE, PIER_ELSEWHERE];
const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter', superadmin: true };
initializeDatabaseBrowser(SETTINGS);

const books = () => [...document.querySelectorAll('[data-lorebase-book]')].map(book => book.dataset.lorebaseBook);
const actionsOf = row => [...document.querySelectorAll(`[data-lorebase-row="${row.key}"]`)].map(button => button.dataset.lorebaseAction);
const press = (row, action) => document.querySelector(`[data-lorebase-action="${action}"][data-lorebase-row="${row.key}"]`).click();
const sentencesOf = lines => lines.flatMap(line => [line.text, line.name, ...(line.parts ?? []).map(part => part.name)]).filter(Boolean);
const filterBy = (selector, value) => $(selector).val(value).trigger('change');

async function openBrowser() {
    void openDatabaseBrowser();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-lorebase-book], [data-collection-entry]').length).toBeGreaterThan(0));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
    host.answer = true;
    host.collections = [MIRA];
    host.rows = ROWS;
    host.rowsError = null;
    host.fileData = null;
    host.rowReads = 0;
});

afterEach(async () => {
    host.close?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.innerHTML = '';
});

describe('LoreBase rows in the Database Browser', () => {
    it('draws each lorebook after the collections under All types and LoreBase, and none under a filter they cannot pass', async () => {
        await openBrowser();
        expect(books()).toEqual(['Harbor Atlas', 'Old Pier']);
        expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(1);
        expect($('[data-browser-count="lorebooks"]').text()).toBe('2 lorebooks');

        filterBy('#vectfox_browser_type', 'lorebase');
        expect(books()).toEqual(['Harbor Atlas', 'Old Pier']);
        expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(0);

        filterBy('#vectfox_collection_search', '').val('pier').trigger('input');
        expect(books()).toEqual(['Old Pier']);
        filterBy('#vectfox_collection_search', '').trigger('input');

        filterBy('#vectfox_browser_type', 'chat');
        expect(books()).toEqual([]);
        expect($('[data-browser-count="lorebooks"]').is(':visible')).toBe(false);
        filterBy('#vectfox_browser_type', 'all');
        filterBy('#vectfox_browser_status', 'disabled');
        expect(books()).toEqual([]);
    });

    it('gives each row the actions what it holds allows, and says which vectors LoreBase does not read', async () => {
        await openBrowser();
        expect(actionsOf(HARBOR_KEYS)).toEqual(['export', 'import', 'delete']);
        expect(actionsOf(HARBOR_VECTORS)).toEqual(['export', 'import', 'delete']);
        // SillyTavern has no Old Pier, so no file can write there; its vectors in the other place are left over.
        expect(actionsOf(PIER_KEYS)).toEqual(['export', 'delete']);
        expect(actionsOf(PIER_HERE)).toEqual([]);
        expect(actionsOf(PIER_ELSEWHERE)).toEqual(['export', 'delete']);
        const pier = document.querySelector('[data-lorebase-book="Old Pier"]').textContent;
        expect(pier).toContain('Not in SillyTavern');
        expect(pier).toContain('Not read');
        expect(pier).toContain('LoreBase reads its vectors from another collection now, so it does not read these.');
        expect(document.querySelector('[data-lorebase-book="Harbor Atlas"]').textContent).toContain('vf_lorebase_rook, embedded by openrouter/baai/bge-m3');
    });

    it("downloads a row's file and says what it left out", async () => {
        storage.exportStored.mockResolvedValue({ file: { type: 'vectfox-lorebase-keys' }, count: 311, leftOutCount: 2 });
        await openBrowser();
        press(HARBOR_KEYS, 'export');
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledTimes(1));
        expect(storage.exportStored).toHaveBeenCalledWith(expect.objectContaining({ key: HARBOR_KEYS.key }), SETTINGS);
        expect(downloadExport).toHaveBeenCalledWith({ type: 'vectfox-lorebase-keys' }, 'Harbor Atlas-lorebase-keys');
        expect(toastr.success.mock.calls[0][0]).toBe('Exported the keys of 311 entries; 2 entries were left out, as neither SillyTavern nor the stored keys name their title');
    });

    it('confirms what an import writes and skips before writing, and draws the rows again once written', async () => {
        host.fileData = { type: 'vectfox-lorebase-keys', book: { name: 'Harbor Atlas' }, exportDate: '2026-11-19T08:00:00.000Z', entries: [] };
        const plan = { writes: [{ uid: '0' }, { uid: '3' }], replaceCount: 1, unmatchedCount: 1, damagedCount: 0 };
        storage.planImport.mockResolvedValue(plan);
        storage.writeImport.mockResolvedValue({ written: 2, failed: 0, isEmbedded: false });
        await openBrowser();
        press(HARBOR_KEYS, 'import');
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledTimes(1));

        const [lines, options] = confirmPopup.mock.calls[0];
        expect(sentencesOf(lines)).toEqual([
            'Import LoreBase keys into this lorebook?',
            'Lorebook:', 'Harbor Atlas',
            'It writes the keys of 2 entries, 1 of them replacing the keys that entry has.',
            'It skips 1 entry whose number and title match no entry of this lorebook.',
            'Saved from:', 'Harbor Atlas, on 2026-11-19',
            'This makes no LLM call.',
            'Import keys writes them. Cancel leaves the lorebook as it is.',
        ]);
        expect(options).toEqual({ okButton: 'Import keys', isDestructive: true });
        expect(storage.writeImport).toHaveBeenCalledWith(plan, SETTINGS);
        expect(toastr.success.mock.calls[0][0]).toBe('Imported the keys of 2 entries into Harbor Atlas');
        await vi.waitFor(() => expect(host.rowReads).toBe(2));
    });

    it('writes nothing on Cancel, nor when nothing in the file matches, and says so then', async () => {
        host.fileData = { type: 'vectfox-lorebase-vectors', book: { name: 'Harbor Atlas' }, points: [] };
        storage.planImport.mockResolvedValue({ writes: [], uids: [], replaceCount: 0, unmatchedCount: 3, damagedCount: 0, embedding: {}, needsEmbedding: false });
        await openBrowser();
        press(HARBOR_VECTORS, 'import');
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(toastr.error.mock.calls[0][0]).toBe('None of this file\'s 3 parts is a part of a selected entry of Harbor Atlas now, so nothing was written.');
        expect(confirmPopup).not.toHaveBeenCalled();

        host.answer = false;
        storage.planImport.mockResolvedValue({ writes: [{ point: { uid: '0' } }], uids: ['0'], replaceCount: 0, unmatchedCount: 0, damagedCount: 0, embedding: { source: 'openrouter', model: 'baai/bge-m3' }, needsEmbedding: false });
        press(HARBOR_VECTORS, 'import');
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(storage.writeImport).not.toHaveBeenCalled();
    });

    it('confirms what a delete loses and that LoreBase stays on, then deletes the row and draws the rows again', async () => {
        storage.deleteStoredRow.mockResolvedValue(504);
        await openBrowser();
        press(HARBOR_VECTORS, 'delete');
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledTimes(1));
        const [lines, options] = confirmPopup.mock.calls[0];
        expect(sentencesOf(lines)).toEqual([
            'Delete the LoreBase vectors of this lorebook?',
            'Lorebook:', 'Harbor Atlas',
            'Lost:', 'the vectors of 504 parts, made by openrouter/baai/bge-m3',
            'Its selected entries leave replies until Generate vectors writes their vectors again. LoreBase stays on. Export them first to keep a copy.',
            'Delete vectors deletes them. Cancel keeps them.',
        ]);
        expect(options).toEqual({ okButton: 'Delete vectors', isDestructive: true });
        expect(storage.deleteStoredRow).toHaveBeenCalledWith(expect.objectContaining({ key: HARBOR_VECTORS.key }), SETTINGS);
        expect(toastr.success.mock.calls[0][0]).toBe('Deleted the vectors of 504 parts');
        await vi.waitFor(() => expect(host.rowReads).toBe(2));
    });

    it('says why when a row action is refused, as while LoreBase writes', async () => {
        storage.deleteStoredRow.mockRejectedValue(new Error('LoreBase is already writing keys or vectors; the progress panel shows them.'));
        await openBrowser();
        press(HARBOR_KEYS, 'delete');
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(toastr.error.mock.calls[0][0]).toBe('Delete failed: LoreBase is already writing keys or vectors; the progress panel shows them.');
    });

    it("refuses a row's file in Import a collection, and names the row whose Import takes it", async () => {
        await openBrowser();
        const importButton = () => document.querySelector('[data-browser-action="import"]');
        for (const [type, place] of [
            ['vectfox-lorebase-keys', "This is a LoreBase keys file. Use Import keys on its lorebook's keys row in this list."],
            ['vectfox-lorebase-vectors', "This is a LoreBase vectors file. Use Import vectors on its lorebook's vectors row in this list."],
            ['vectfox-story-links', "This is a StoryArc links file. Use Import links on its collection's row in this list."],
        ]) {
            toastr.error.mockClear();
            host.fileData = { type };
            importButton().click();
            await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith(place, 'VectFox Import'));
        }
        expect(confirmPopup).not.toHaveBeenCalled();
    });

    it("leaves a notice where its rows go when LoreBase's keys and vectors cannot be read, and draws the collections", async () => {
        host.rowsError = new Error("Similharity could not list LoreBase's books (HTTP 404): Not Found");
        await openBrowser();
        expect(books()).toEqual([]);
        expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(1);
        expect(document.querySelector('#vectfox_collections_list').textContent)
            .toContain("LoreBase's keys and vectors could not be read: Similharity could not list LoreBase's books (HTTP 404): Not Found");
    });
});
