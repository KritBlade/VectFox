/**
 * @vitest-environment jsdom
 *
 * LoreBase's rows in the Database Browser (src/features/database-browser/database-browser.js, §3.2 and §3.3 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), pressed as a user would: each lorebook of the list
 * after the collections, under All types and LoreBase alone, its row shaped as a chat collection's, in their column,
 * with its selected entries, where its vectors are stored and their ID, and its keys and vectors rows in one line each;
 * the ⚠ beside a lorebook with no entries selected, its words opening under the name on a click; what LoreBase cannot
 * use here behind Show leftovers, closed on each open; each row's actions as what it holds allows; View chunks opening
 * a vectors row's chunks read only, in the collection that holds them, with LoreBase's entry editor on a row of the
 * list alone, the rows read again once the visualizer closes after a save; Export downloading
 * the row's file and saying what it left out; Import confirming what it writes and skips before writing, and writing
 * nothing on Cancel or when nothing matches; Delete confirming what is lost; Remove from LoreBase on a lorebook of the
 * list, never a leftover, running LoreBase's one confirm and removal, then saying what went and reading the rows
 * again; Import a collection taking a LoreBase file
 * into the lorebook it names and refusing a StoryArc links file, naming its row; and a notice where the rows go when
 * they cannot be read.
 *
 * The real browser, its markup and LoreBase's file words (lorebase-files-core.js) run; the collections, LoreBase's
 * storage module, the file picker, the dialogs and the host modules are stubbed, and its dialog is the page.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, close: null, collections: [], rows: [], rowsError: null, fileData: null, rowReads: 0 }));
const storage = vi.hoisted(() => ({
    exportStored: vi.fn(), planImport: vi.fn(), writeImport: vi.fn(), deleteStoredRow: vi.fn(), loreBaseImportRow: vi.fn(), editLoreBookEntry: vi.fn(),
    removeLoreBookAfterConfirm: vi.fn(),
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
        describeRemovedLoreBook: files.describeRemovedLoreBook,
        modelWords: files.modelWords,
        nothingToImportText: files.nothingToImportText,
        // The embedding model set now, as lorebase-vectors.js reads it (lorebase-vectors.test.js holds it).
        currentEmbeddingModel: settings => ({ source: settings.embedding_provider || 'transformers', model: settings.embedding_model ?? '' }),
        tenantChunkSource: (row, settings) => ({ collection: { id: row.tenant, name: row.book }, settings: { ...settings, readsIn: row.collection } }),
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
const { openChunkVisualizer } = await import('../src/features/database-browser/chunk-visualizer.js');

const MIRA = { id: 'vf_eventbase_qdrant_rook_mira_aaaa', registryKey: 'qdrant:vf_eventbase_qdrant_rook_mira_aaaa', name: 'Mira', type: 'chat', backend: 'qdrant', chunkCount: 9, enabled: true, scope: 'chat' };
const HARBOR_TENANT = 'vf_lorebase_qdrant_rook_harbor_atlas_19qag9zxydm';
const WREN_TENANT = 'vf_lorebase_qdrant_rook_wren_journal_3k';
// The rows as storageRowsOf gives them: the list's, then the leftovers'.
const listed = (book, selectedCount, selectionCount) => ({ book, hasRecord: true, selectedCount, selectionCount, isInSillyTavern: true, isLeftover: false });
const HARBOR_KEYS = { key: 'keys|Harbor Atlas', kind: 'keys', ...listed('Harbor Atlas', 12, 1), entryCount: 313 };
const HARBOR_VECTORS = {
    key: `vectors|vf_lorebase_rook|${HARBOR_TENANT}`, kind: 'vectors', ...listed('Harbor Atlas', 12, 1), collection: 'vf_lorebase_rook',
    tenant: HARBOR_TENANT, isHere: true, pointCount: 504, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3',
};
const WREN_KEYS = { key: 'keys|Wren Journal', kind: 'keys', ...listed('Wren Journal', 0, 0), hasRecord: false, entryCount: 21 };
const WREN_VECTORS = {
    key: `vectors|vf_lorebase_rook|${WREN_TENANT}`, kind: 'vectors', ...listed('Wren Journal', 0, 0), hasRecord: false, collection: 'vf_lorebase_rook',
    tenant: WREN_TENANT, isHere: true, pointCount: 30, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3',
};
const leftover = book => ({ book, hasRecord: false, selectedCount: 0, selectionCount: 0, isInSillyTavern: false, isLeftover: true });
const PIER_KEYS = { key: 'keys|Old Pier', kind: 'keys', ...leftover('Old Pier'), entryCount: 2 };
const PIER_ELSEWHERE = {
    key: 'vectors|vectfox_main|vf_lorebase_qdrant_rook_old_pier_7k', kind: 'vectors', ...leftover('Old Pier'), collection: 'vectfox_main',
    tenant: 'vf_lorebase_qdrant_rook_old_pier_7k', isHere: false, pointCount: 50, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3',
};
const ROWS = [HARBOR_KEYS, HARBOR_VECTORS, WREN_KEYS, WREN_VECTORS, PIER_KEYS, PIER_ELSEWHERE];
const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter', superadmin: true };
const NO_SELECTION_WORDS = "No selected entry LoreBase decides: it leaves this lorebook out, and its vectors are erased on the next write. Select its entries on VectFox's WorldInfo page to keep them.";
initializeDatabaseBrowser(SETTINGS);

const books = () => [...document.querySelectorAll('[data-lorebase-book]')].map(book => book.dataset.lorebaseBook);
const bookRow = key => document.querySelector(`[data-lorebase-book="${key}"]`);
const subLinesOf = element => [...element.querySelectorAll(':scope > .vfx-row .vfx-row-sub')].map(line => line.textContent);
const actionsOf = row => [...document.querySelectorAll(`[data-lorebase-row="${row.key}"]`)].map(button => button.dataset.lorebaseAction);
const press = (row, action) => document.querySelector(`[data-lorebase-action="${action}"][data-lorebase-row="${row.key}"]`).click();
const leftoversButton = () => document.querySelector('[data-browser-action="toggle-leftovers"]');
const sentencesOf = lines => lines.flatMap(line => [line.text, line.name, ...(line.parts ?? []).map(part => part.name)]).filter(Boolean);
const filterBy = (selector, value) => $(selector).val(value).trigger('change');

async function openBrowser() {
    void openDatabaseBrowser();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-lorebase-book], [data-collection-entry]').length).toBeGreaterThan(0));
}

async function closeBrowser() {
    host.close?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.innerHTML = '';
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

afterEach(closeBrowser);

describe('LoreBase rows in the Database Browser', () => {
    it('draws each lorebook of the list after the collections under All types and LoreBase, and none under a filter they cannot pass', async () => {
        await openBrowser();
        expect(books()).toEqual(['list|Harbor Atlas', 'list|Wren Journal']);
        expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(1);
        expect($('[data-browser-count="lorebooks"]').text()).toBe('2 lorebooks');

        filterBy('#vectfox_browser_type', 'lorebase');
        expect(books()).toEqual(['list|Harbor Atlas', 'list|Wren Journal']);
        expect(document.querySelectorAll('[data-collection-entry]')).toHaveLength(0);

        $('#vectfox_collection_search').val('wren').trigger('input');
        expect(books()).toEqual(['list|Wren Journal']);
        expect(leftoversButton()).toBeNull();
        $('#vectfox_collection_search').val('').trigger('input');

        filterBy('#vectfox_browser_type', 'chat');
        expect(books()).toEqual([]);
        expect(leftoversButton()).toBeNull();
        expect($('[data-browser-count="lorebooks"]').is(':visible')).toBe(false);
        filterBy('#vectfox_browser_type', 'all');
        filterBy('#vectfox_browser_status', 'disabled');
        expect(books()).toEqual([]);
    });

    it("draws a lorebook's row as a chat collection's, in their column, and each of its rows in one line", async () => {
        await openBrowser();
        const harbor = bookRow('list|Harbor Atlas');
        expect(harbor.querySelector(':scope > .vfx-pick-check.is-blank input[type="checkbox"]').disabled).toBe(true);
        expect(harbor.querySelector('.vfx-row-name').textContent).toBe('📖 Lorebook: Harbor Atlas');
        expect(subLinesOf(harbor.querySelector('.vfx-pick-body'))).toEqual([
            'Selected entries: 12', 'Stored in: Qdrant, embedded by openrouter/baai/bge-m3', `ID: ${HARBOR_TENANT}`,
            '313 entries with keys', '504 parts',
        ]);
        expect(harbor.querySelector('[data-lorebase-flag]')).toBeNull();
        expect(harbor.textContent).not.toContain('LoreBase lorebook');
        expect(actionsOf(HARBOR_KEYS)).toEqual(['export', 'import', 'delete']);
        expect(actionsOf(HARBOR_VECTORS)).toEqual(['view-chunks', 'export', 'import', 'delete']);
    });

    it("counts a lorebook's selections on its Selected entries line once it has more than one", async () => {
        host.rows = [{ ...HARBOR_KEYS, selectionCount: 3 }, { ...HARBOR_VECTORS, selectionCount: 3 }];
        await openBrowser();
        expect(subLinesOf(bookRow('list|Harbor Atlas').querySelector('.vfx-pick-body'))[0]).toBe('Selected entries: 12, in 3 selections');
    });

    it("opens a vectors row's chunks read only, in the collection that holds them, and offers it only on a row holding some", async () => {
        await openBrowser();
        press(HARBOR_VECTORS, 'view-chunks');
        expect(openChunkVisualizer).toHaveBeenCalledWith(
            { id: HARBOR_TENANT, name: 'Harbor Atlas' },
            expect.objectContaining({ readsIn: 'vf_lorebase_rook', vector_backend: 'qdrant' }),
            { isLoreBaseParts: true, editEntry: expect.any(Function) },
        );

        host.rows = [{ ...HARBOR_KEYS }, { ...HARBOR_VECTORS, tenant: null, pointCount: 0, embeddingSource: '', embeddingModel: '' }];
        await closeBrowser();
        await openBrowser();
        expect(actionsOf(host.rows[1])).toEqual(['import']);
    });

    it("gives a list row's chunks LoreBase's entry editor, reading the rows again once the visualizer closes after a save, and a leftover's none", async () => {
        let closeVisualizer;
        openChunkVisualizer.mockImplementation(() => new Promise(resolve => { closeVisualizer = resolve; }));
        storage.editLoreBookEntry.mockResolvedValue(true);
        await openBrowser();
        press(HARBOR_VECTORS, 'view-chunks');
        const { editEntry } = openChunkVisualizer.mock.calls[0][2];
        expect(await editEntry({ hash: 501, metadata: { lorebookName: 'Harbor Atlas', entryUid: 12, partNumber: 2 } })).toBe(true);
        expect(storage.editLoreBookEntry).toHaveBeenCalledWith('Harbor Atlas', '12');
        const readsBefore = host.rowReads;
        closeVisualizer();
        await vi.waitFor(() => expect(host.rowReads).toBe(readsBefore + 1));

        // Closed with nothing saved: the rows stay as read.
        storage.editLoreBookEntry.mockResolvedValue(false);
        press(HARBOR_VECTORS, 'view-chunks');
        expect(await openChunkVisualizer.mock.calls[1][2].editEntry({ metadata: { entryUid: 3 } })).toBe(false);
        closeVisualizer();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(host.rowReads).toBe(readsBefore + 1);

        // A leftover's lorebook is not in SillyTavern, or its vectors not where LoreBase writes them.
        leftoversButton().click();
        press(PIER_ELSEWHERE, 'view-chunks');
        expect(openChunkVisualizer.mock.calls[2][2]).toEqual({ isLoreBaseParts: true, editEntry: null });
        closeVisualizer();
        openChunkVisualizer.mockReset();
        storage.editLoreBookEntry.mockReset();
    });

    it('flags a lorebook with no entries selected, its words on hover and, on a click, under its name until the next click', async () => {
        await openBrowser();
        const flag = () => bookRow('list|Wren Journal').querySelector('[data-lorebase-flag]');
        const words = () => bookRow('list|Wren Journal').querySelector('.vfx-row-flag-words');
        expect(flag().title).toBe(NO_SELECTION_WORDS);
        expect(flag().getAttribute('aria-expanded')).toBe('false');
        expect(words()).toBeNull();
        expect(subLinesOf(bookRow('list|Wren Journal').querySelector('.vfx-pick-body'))[0]).toBe('Selected entries: 0');

        flag().click();
        expect(words().textContent).toBe(NO_SELECTION_WORDS);
        expect(flag().getAttribute('aria-expanded')).toBe('true');
        flag().click();
        expect(words()).toBeNull();

        host.rows = [{ ...WREN_KEYS }, { ...WREN_VECTORS, key: 'vectors|vf_lorebase_rook|Wren Journal', tenant: null, pointCount: 0, embeddingSource: '', embeddingModel: '' }];
        await closeBrowser();
        await openBrowser();
        expect(flag().title).toBe("No selected entry LoreBase decides: it leaves this lorebook out. Select its entries on VectFox's WorldInfo page.");
    });

    it('shows what LoreBase cannot use here behind Show leftovers, each with Export and Delete, closed again on the next open', async () => {
        await openBrowser();
        expect(leftoversButton().textContent).toBe('Show leftovers');
        expect(leftoversButton().nextElementSibling.textContent).toBe('1 lorebook');
        expect(books()).not.toContain('leftovers|Old Pier');

        leftoversButton().click();
        expect(books()).toEqual(['list|Harbor Atlas', 'list|Wren Journal', 'leftovers|Old Pier']);
        expect(leftoversButton().textContent).toBe('Hide leftovers');
        expect(document.querySelector('[data-lorebase-leftovers]').textContent).toContain('LoreBase leftovers');
        expect($('[data-browser-count="lorebooks"]').text()).toBe('3 lorebooks');
        const pier = bookRow('leftovers|Old Pier');
        expect(pier.querySelector('.vfx-row-name').textContent).toBe('📖 Lorebook: Old Pier');
        expect(subLinesOf(pier.querySelector('.vfx-pick-body'))).toEqual([
            'Stored in: Qdrant, embedded by custom/baai/bge-m3', 'ID: vf_lorebase_qdrant_rook_old_pier_7k',
            '2 entries with keys', '50 parts, in vectfox_main, which LoreBase does not read now',
        ]);
        expect(pier.textContent).toContain('Not in SillyTavern');
        expect(pier.textContent).toContain('Not read');
        expect(pier.querySelector('[data-lorebase-flag]')).toBeNull();
        // SillyTavern has no Old Pier, and LoreBase does not read vectfox_main now, so no file can write there.
        expect(actionsOf(PIER_KEYS)).toEqual(['export', 'delete']);
        expect(actionsOf(PIER_ELSEWHERE)).toEqual(['view-chunks', 'export', 'delete']);

        $('#vectfox_collection_search').val('pier').trigger('input');
        expect(books()).toEqual(['leftovers|Old Pier']);
        $('#vectfox_collection_search').val('').trigger('input');

        leftoversButton().click();
        expect(books()).not.toContain('leftovers|Old Pier');
        leftoversButton().click();
        await closeBrowser();
        await openBrowser();
        expect(books()).not.toContain('leftovers|Old Pier');
        expect(leftoversButton().textContent).toBe('Show leftovers');
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
        storage.planImport.mockResolvedValue({
            writes: [], uids: [], replaceCount: 0, unselectedCount: 0, unmatchedCount: 3, damagedCount: 0, embedding: {}, needsEmbedding: false,
        });
        await openBrowser();
        press(HARBOR_VECTORS, 'import');
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(toastr.error.mock.calls[0][0]).toBe('None of this file\'s 3 parts is a part of an entry of Harbor Atlas now, so nothing was written.');
        expect(confirmPopup).not.toHaveBeenCalled();

        host.answer = false;
        storage.planImport.mockResolvedValue({
            writes: [{ point: { uid: '0' } }], uids: ['0'], replaceCount: 0, unselectedCount: 0, unmatchedCount: 0, damagedCount: 0,
            embedding: { source: 'openrouter', model: 'baai/bge-m3' }, needsEmbedding: false,
        });
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
            'Its selected entries send nothing where they are in use until Generate vectors writes their vectors again. LoreBase stays on. Export them first to keep a copy.',
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

    it('takes a LoreBase file in Import a collection into the lorebook it names, through the row the storage module finds', async () => {
        await openBrowser();
        const importButton = () => document.querySelector('[data-browser-action="import"]');
        const LANTERN_KEYS = { key: 'keys|Lantern Atlas', kind: 'keys', ...listed('Lantern Atlas', 0, 0), hasRecord: false, entryCount: 0 };
        storage.loreBaseImportRow.mockReturnValue(LANTERN_KEYS);
        storage.planImport.mockResolvedValue({ writes: [{ uid: '0' }], replaceCount: 0, unmatchedCount: 0, damagedCount: 0 });
        storage.writeImport.mockResolvedValue({ written: 1, failed: 0, isEmbedded: false });
        host.fileData = { type: 'vectfox-lorebase-keys', book: { name: 'Lantern Atlas' }, exportDate: '2026-11-19T08:00:00.000Z', entries: [] };
        importButton().click();
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledWith('Imported the keys of 1 entry into Lantern Atlas', 'VectFox LoreBase'));
        expect(storage.loreBaseImportRow).toHaveBeenCalledWith('keys', 'Lantern Atlas', expect.any(Array), SETTINGS);
        expect(storage.loreBaseImportRow.mock.calls[0][2].map(row => row.key)).toEqual(ROWS.map(row => row.key));
        expect(storage.planImport).toHaveBeenCalledWith(LANTERN_KEYS, host.fileData, SETTINGS);
        expect(sentencesOf(confirmPopup.mock.calls[0][0]).slice(0, 3)).toEqual(['Import LoreBase keys into this lorebook?', 'Lorebook:', 'Lantern Atlas']);
        await vi.waitFor(() => expect(host.rowReads).toBe(2));

        storage.loreBaseImportRow.mockClear();
        host.fileData = { type: 'vectfox-lorebase-vectors', book: { name: 'Lantern Atlas' }, points: [] };
        importButton().click();
        await vi.waitFor(() => expect(storage.loreBaseImportRow).toHaveBeenCalledWith('vectors', 'Lantern Atlas', expect.any(Array), SETTINGS));
    });

    it('says why Import a collection writes no LoreBase file: no lorebook of its name, or none named, and refuses a StoryArc links file', async () => {
        await openBrowser();
        const importButton = () => document.querySelector('[data-browser-action="import"]');
        const NO_BOOK = 'SillyTavern has no lorebook named "Lost Atlas". Bring the lorebook into SillyTavern first, or use Import on the keys row of the lorebook you want this file in.';
        storage.loreBaseImportRow.mockImplementation(() => { throw new Error(NO_BOOK); });
        host.fileData = { type: 'vectfox-lorebase-keys', book: { name: 'Lost Atlas' }, entries: [] };
        importButton().click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith(NO_BOOK, 'VectFox LoreBase'));

        toastr.error.mockClear();
        host.fileData = { type: 'vectfox-lorebase-vectors', points: [] };
        importButton().click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith(
            'This LoreBase vectors file names no lorebook. Use Import on the vectors row of the lorebook you want it in.', 'VectFox LoreBase'));

        toastr.error.mockClear();
        host.fileData = { type: 'vectfox-story-links' };
        importButton().click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith(
            "This is a StoryArc links file. Use Import links on its collection's row in this list.", 'VectFox Import'));
        expect(storage.planImport).not.toHaveBeenCalled();
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

describe("Remove from LoreBase on a lorebook's row", () => {
    const remover = key => bookRow(key).querySelector('[data-lorebase-remove]');

    it('offers it on each lorebook of the list, never on a leftover, whose rows are deleted one at a time', async () => {
        const HARBOR_ELSEWHERE = {
            ...HARBOR_VECTORS, key: `vectors|vectfox_main|${HARBOR_TENANT}`, collection: 'vectfox_main', isHere: false, isLeftover: true, pointCount: 30,
        };
        host.rows = [HARBOR_KEYS, HARBOR_VECTORS, WREN_KEYS, WREN_VECTORS, HARBOR_ELSEWHERE, PIER_KEYS, PIER_ELSEWHERE];
        await openBrowser();
        leftoversButton().click();
        const removers = [...document.querySelectorAll('[data-lorebase-remove]')];
        expect(removers.map(button => [button.closest('[data-lorebase-book]').dataset.lorebaseBook, button.dataset.lorebaseRemove, button.title]))
            .toEqual([
                ['list|Harbor Atlas', 'Harbor Atlas', 'Remove from LoreBase'],
                ['list|Wren Journal', 'Wren Journal', 'Remove from LoreBase'],
            ]);
        expect([remover('leftovers|Harbor Atlas'), remover('leftovers|Old Pier')]).toEqual([null, null]);
        expect(removers.every(button => button.classList.contains('vfx-btn-danger'))).toBe(true);
    });

    it('removes the lorebook once confirmed, says what went, and reads the rows again, so it leaves the list', async () => {
        storage.removeLoreBookAfterConfirm.mockResolvedValue({ bookName: 'Wren Journal', keysDeleted: 21, partsDeleted: 30 });
        await openBrowser();
        remover('list|Wren Journal').click();
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalledTimes(1));
        expect(storage.removeLoreBookAfterConfirm).toHaveBeenCalledWith('Wren Journal', SETTINGS);
        expect(toastr.success.mock.calls[0][0]).toBe('Removed "Wren Journal" from LoreBase, with the keys of 21 entries and the vectors of 30 parts.');
        await vi.waitFor(() => expect(host.rowReads).toBe(2));
    });

    it('does nothing on Cancel, and says why when it is refused', async () => {
        storage.removeLoreBookAfterConfirm.mockResolvedValue(null);
        await openBrowser();
        remover('list|Harbor Atlas').click();
        await vi.waitFor(() => expect(storage.removeLoreBookAfterConfirm).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(toastr.success).not.toHaveBeenCalled();
        expect(host.rowReads).toBe(1);

        const offQdrant = "LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.";
        storage.removeLoreBookAfterConfirm.mockRejectedValue(new Error(offQdrant));
        remover('list|Harbor Atlas').click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(toastr.error.mock.calls[0][0]).toBe(`Remove failed: ${offQdrant}`);
    });
});
