/**
 * @vitest-environment jsdom
 *
 * The Chunk Visualizer's wiring (src/features/database-browser/chunk-visualizer.js), driven as a user would while it is
 * open: it loads and lists a collection's chunks; one Save writes a changed name, or, for a changed text, embeds the
 * new text before the old chunk goes, an event of a chat or of a chat file keeping its own ID; a failed embedding loses
 * nothing; a collection made with another CJK tokenizer locks the text; leaving or closing with unsaved edits asks; the
 * bulk bar deletes only ticked chunks the list shows; a lorebook's LoreBase parts open read only, in their entries'
 * order, from the collection that holds them, and Edit entry, where the browser gives an entry editor, waits for it and
 * reads the list again after a save, the same part open.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, canClose: null, calls: [], items: [] }));

const backend = vi.hoisted(() => ({
    insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(),
    updateChunkMetadata: vi.fn(),
}));

vi.mock('../src/features/vector-backend/index.js', async () => ({
    ...backend,
    textWithoutKeywordSuffix: (await import('../src/features/vector-backend/stored-chunk.js')).textWithoutKeywordSuffix,
    describeEmbeddingFailure: (await import('../src/features/vector-backend/embedding-failure.js')).describeEmbeddingFailure,
    qdrantTarget: (await import('../src/features/vector-backend/qdrant-target.js')).qdrantTarget,
}));
const announceEventsRemoved = vi.hoisted(() => vi.fn());
vi.mock('../src/features/eventbase/index.js', () => ({
    announceEventsRemoved,
    packTimelineSortKey: (message, order) => message * 1000 + order,
    eventPointHash: id => 7_000_000 + [...String(id)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000003, 3),
}));
vi.mock('../src/features/keyword-search/index.js', () => ({
    languageModeLabel: mode => ({ intl: 'Intl.Segmenter (English / Latin)', jieba_tw: 'Traditional Chinese (Jieba WASM)' })[mode] ?? String(mode),
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getStringHash: text => [...String(text)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000003, 7) }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    confirmPopup: vi.fn(async () => host.answer),
    // The dialog door: the visualizer is on the page while it is open, and its close asks canClose.
    openPanelPopup: vi.fn((root, { canClose }) => {
        document.body.append(root);
        host.canClose = canClose;
        return new Promise(() => {});
    }),
}));

const { openChunkVisualizer } = await import('../src/features/database-browser/chunk-visualizer.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { getStringHash } = await import('../src/sillytavern/identifiers.js');

const COLLECTION = { id: 'vf_lorebook_harbor', name: 'Harbor', type: 'lorebook', backend: 'qdrant', chunkCount: 3 };
const SETTINGS = { vector_backend: 'standard' };

const $id = id => document.getElementById(id);
const actionButton = (name, scope = document) => scope.querySelector(`[data-chunk-action="${name}"]`);
const rowKeys = () => [...document.querySelectorAll('[data-chunk-entry]')].map(entry => entry.dataset.chunkEntry);
const saveState = () => document.querySelector('[data-chunk-save-state]').textContent;
const type = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
};
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};

async function openHarbor(settings = SETTINGS, collection = COLLECTION) {
    void openChunkVisualizer(collection, settings);
    // The visualizer keeps its order and filter from one opening to the next; each test starts from the defaults.
    change($id('vectfox_chunk_sort'), 'index');
    change($id('vectfox_chunk_filter'), 'all');
    await vi.waitFor(() => expect(rowKeys().length).toBe(host.items.length));
}

async function openChunk(key) {
    document.querySelector(`[data-chunk-action="open"][data-chunk-key="${key}"]`).click();
    await vi.waitFor(() => expect(document.querySelector(`[data-chunk-entry="${key}"]`).classList.contains('is-open')).toBe(true));
}

beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { error: vi.fn() });
    host.answer = true;
    host.calls = [];
    host.items = [
        { hash: 1000, index: 0, text: 'The gate stood open.', metadata: { keywords: [{ text: 'gate', weight: 1.5 }] } },
        { hash: 1001, index: 1, text: 'The tide came in.', metadata: { name: 'Tide' } },
        { hash: 1002, index: 2, text: 'Gulls over the harbor.', metadata: {} },
    ];
    for (const [name, mock] of Object.entries(backend)) {
        mock.mockReset();
        mock.mockImplementation(async (collectionId, ...rest) => { host.calls.push([name, ...rest]); });
    }
    confirmPopup.mockClear();
    announceEventsRemoved.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: host.items, total: 5 }) })));
});

describe('loading', () => {
    it('lists the chunks it loads in the chat\'s order, and says how many the collection holds', async () => {
        await openHarbor();
        expect(rowKeys()).toEqual(['0', '1', '2']);
        expect(document.querySelector('[data-chunk-count]').textContent).toBe('3 of 5 chunks loaded');
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ backend: 'qdrant', collectionId: 'vf_lorebook_harbor' });
    });
});

describe('saving a chunk', () => {
    it('writes a changed name alone, without embedding again', async () => {
        await openHarbor();
        await openChunk('1');
        expect(actionButton('save').disabled).toBe(true);
        type($id('vectfox_chunk_name'), 'High tide');
        expect(actionButton('save').disabled).toBe(false);
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.updateChunkMetadata).toHaveBeenCalledTimes(1));
        expect(backend.updateChunkMetadata.mock.calls[0].slice(1, 3)).toEqual([1001, { name: 'High tide' }]);
        expect(backend.insertVectorItems).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(saveState()).toBe('No changes.'));
    });

    it('embeds a changed text before the old chunk goes, and nothing else', async () => {
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_text'), 'The tide went out.');
        actionButton('save').click();
        await vi.waitFor(() => expect(saveState()).toBe('No changes.'));
        expect(host.calls.map(([name]) => name)).toEqual(['insertVectorItems', 'deleteVectorItems']);
        expect(host.calls[0][1]).toEqual([{ hash: getStringHash('The tide went out.'), text: 'The tide went out.', index: 1, metadata: { name: 'Tide' } }]);
        expect(host.calls[1][1]).toEqual([1001]);
    });

    it('shows a Qdrant chunk\'s text without the keyword suffix, and stores the edit with its keywords and importance', async () => {
        host.items[0] = {
            hash: 1000,
            index: 0,
            text: 'The gate stood open. [KEYWORDS: gate]',
            metadata: { keywords: [{ text: 'gate', weight: 1.5 }], importance: 7 },
        };
        await openHarbor();
        await openChunk('0');
        expect($id('vectfox_chunk_text').value).toBe('The gate stood open.');
        type($id('vectfox_chunk_text'), 'The gate stood shut.');
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.insertVectorItems).toHaveBeenCalledTimes(1));
        const [stored] = backend.insertVectorItems.mock.calls[0][1];
        expect(stored.text).toBe('The gate stood shut.');
        expect(stored.metadata).toMatchObject({ keywords: [{ text: 'gate', weight: 1.5 }], importance: 7 });
    });

    it('tells, on a failed embedding, that a busy provider can be tried again, and gives the error', async () => {
        backend.insertVectorItems.mockRejectedValueOnce(new Error('[Qdrant] Failed to insert 1 vectors: 500 Internal Server Error - 429 Too Many Requests'));
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_text'), 'The tide went out.');
        actionButton('save').click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        const [message, title, options] = toastr.error.mock.calls[0];
        expect(message).toMatch(/^The chunk was not saved\. The embedding provider is busy or slow right now/);
        expect(message).toContain('Embedding error: [Qdrant] Failed to insert 1 vectors: 500 Internal Server Error - 429 Too Many Requests');
        expect([title, options]).toEqual(['VectFox — chunk not saved', { timeOut: 0, extendedTimeOut: 0 }]);
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
        expect($id('vectfox_chunk_text').value).toBe('The tide went out.');
    });

    it('loses nothing when the new text cannot be embedded, and keeps the edit', async () => {
        backend.insertVectorItems.mockRejectedValueOnce(new Error('Query embedding failed: 500'));
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_text'), 'The tide went out.');
        actionButton('save').click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
        expect($id('vectfox_chunk_text').value).toBe('The tide went out.');
        expect(saveState()).toBe('Unsaved changes.');
    });
});

describe('editing an event', () => {
    const EVENTS = { id: 'vf_eventbase_qdrant_harbor', name: 'Harbor chat', type: 'chat', backend: 'qdrant', chunkCount: 1 };
    const ARCHIVED_EVENTS = { id: 'vf_archiveevent_qdrant_harbor', name: 'Harbor chat file', type: 'chat', backend: 'qdrant', chunkCount: 1 };
    const pointHashOf = id => 7_000_000 + [...String(id)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000003, 3);
    const eventItem = hash => ({ hash, index: 4, text: 'Orrin hid the key. [KEYWORDS: orrin key]', metadata: { event_id: 'evt-harbor-1', keywords: ['orrin', 'key'], importance: 6 } });

    it.each([['a chat', EVENTS], ['a chat file', ARCHIVED_EVENTS]])('stores the new text of %s\'s event under the event\'s own ID, replacing it in place', async (_source, collection) => {
        host.items = [eventItem(pointHashOf('evt-harbor-1'))];
        await openHarbor(SETTINGS, collection);
        await openChunk('0');
        expect($id('vectfox_chunk_text').value).toBe('Orrin hid the key.');
        // The form drew to its end: its last step counts the text.
        expect(document.querySelector('[data-chunk-text-count]').textContent).toBe('18 characters.');
        type($id('vectfox_chunk_text'), 'Orrin hid the brass key.');
        actionButton('save').click();
        await vi.waitFor(() => expect(saveState()).toBe('No changes.'));
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(1);
        const [stored] = backend.insertVectorItems.mock.calls[0][1];
        expect(stored).toMatchObject({ hash: pointHashOf('evt-harbor-1'), text: 'Orrin hid the brass key.', metadata: { event_id: 'evt-harbor-1', keywords: ['orrin', 'key'], importance: 6 } });
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
    });

    it('moves an event an earlier edit stored under a text ID back to its own ID, and deletes that copy', async () => {
        host.items = [eventItem(5555)];
        await openHarbor(SETTINGS, EVENTS);
        await openChunk('0');
        type($id('vectfox_chunk_text'), 'Orrin hid the brass key.');
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.deleteVectorItems).toHaveBeenCalledTimes(1));
        expect(backend.insertVectorItems.mock.calls[0][1][0].hash).toBe(pointHashOf('evt-harbor-1'));
        expect(backend.deleteVectorItems.mock.calls[0][1]).toEqual([5555]);
    });
});

describe('a collection made with another CJK tokenizer than VectFox is set to', () => {
    // Similharity refuses any new vector in such a collection, so a changed text cannot be saved.
    const QDRANT_SETTINGS = { vector_backend: 'qdrant', cjk_tokenizer_mode: 'jieba_tw' };
    const isRecordRequest = url => String(url).endsWith('/chunks/collection-metadata');
    const answer = body => ({ ok: true, json: async () => body });
    const chunksAnswer = () => answer({ items: host.items, total: 3 });
    const tokenizerNotice = () => document.querySelector('[data-chunk-tokenizer-notice]');

    it('says so on the open chunk, locks its text, and still saves its name', async () => {
        fetch.mockImplementation(async url => (isRecordRequest(url) ? answer({ payload: { cjk_tokenizer_mode: 'intl' } }) : chunksAnswer()));
        await openHarbor(QDRANT_SETTINGS);
        await openChunk('1');
        await vi.waitFor(() => expect(tokenizerNotice().hidden).toBe(false));
        expect(tokenizerNotice().textContent).toContain('Intl.Segmenter (English / Latin)');
        expect(tokenizerNotice().textContent).toContain('Traditional Chinese (Jieba WASM)');
        expect($id('vectfox_chunk_text').readOnly).toBe(true);
        expect(document.querySelector('#vectfox_chunk_record').textContent).toContain('Intl.Segmenter (English / Latin)');

        type($id('vectfox_chunk_name'), 'High tide');
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.updateChunkMetadata).toHaveBeenCalledTimes(1));
        expect(backend.insertVectorItems).not.toHaveBeenCalled();
    });

    it('will not save a text typed before the collection\'s record came, and says why', async () => {
        let sendRecord;
        const recordArrives = new Promise(resolve => { sendRecord = resolve; });
        fetch.mockImplementation(async url => (isRecordRequest(url)
            ? recordArrives.then(() => answer({ payload: { cjk_tokenizer_mode: 'intl' } }))
            : chunksAnswer()));
        await openHarbor(QDRANT_SETTINGS);
        await openChunk('1');
        type($id('vectfox_chunk_text'), 'The tide went out.');
        expect(actionButton('save').disabled).toBe(false);

        sendRecord();
        await vi.waitFor(() => expect(actionButton('save').disabled).toBe(true));
        expect(saveState()).toBe('A changed text can\'t be saved here: see above.');
        expect(backend.insertVectorItems).not.toHaveBeenCalled();
    });

    it('locks nothing in a collection made with the CJK tokenizer VectFox is set to', async () => {
        fetch.mockImplementation(async url => (isRecordRequest(url) ? answer({ payload: { cjk_tokenizer_mode: 'jieba_tw' } }) : chunksAnswer()));
        await openHarbor(QDRANT_SETTINGS);
        await openChunk('1');
        await vi.waitFor(() => expect(document.querySelector('#vectfox_chunk_record').hidden).toBe(false));
        expect(tokenizerNotice().hidden).toBe(true);
        expect($id('vectfox_chunk_text').readOnly).toBe(false);
    });
});

describe('unsaved edits', () => {
    it('asks before another chunk opens or the visualizer closes, and Cancel stays', async () => {
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_name'), 'Changed');
        host.answer = false;
        document.querySelector('[data-chunk-action="open"][data-chunk-key="2"]').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(document.querySelector('[data-chunk-entry="1"]').classList.contains('is-open')).toBe(true);
        expect(await host.canClose()).toBe(false);
        host.answer = true;
        expect(await host.canClose()).toBe(true);
        await openChunk('2');
        expect($id('vectfox_chunk_name').value).toBe('');
    });

    it('closes without asking when nothing changed', async () => {
        await openHarbor();
        await openChunk('0');
        expect(await host.canClose()).toBe(true);
        expect(confirmPopup).not.toHaveBeenCalled();
    });
});

describe('the bulk bar', () => {
    it('ticks only the chunks the filter shows, and a filter that hides a ticked chunk unticks it', async () => {
        await openHarbor();
        change($id('vectfox_chunk_filter'), 'keywords');
        change($id('vectfox_chunk_select_all'), true);
        expect(document.querySelector('[data-chunk-bulk-count]').textContent).toBe('1 selected');
        change($id('vectfox_chunk_filter'), 'all');
        change($id('vectfox_chunk_select_all'), true);
        expect(document.querySelector('[data-chunk-bulk-count]').textContent).toBe('3 selected');
        change($id('vectfox_chunk_filter'), 'keywords');
        expect(document.querySelector('[data-chunk-bulk-count]').textContent).toBe('1 selected');
    });

    it('deletes the ticked chunks after one question', async () => {
        await openHarbor();
        await openChunk('1');
        change(document.querySelector('[data-chunk-tick="1"]'), true);
        change(document.querySelector('[data-chunk-tick="2"]'), true);
        actionButton('bulk-delete').click();
        await vi.waitFor(() => expect(rowKeys()).toEqual(['0']));
        expect(confirmPopup).toHaveBeenCalledTimes(1);
        expect(confirmPopup.mock.calls[0][1]).toMatchObject({ okButton: 'Delete', isDestructive: true });
        expect(backend.deleteVectorItems).toHaveBeenCalledTimes(1);
        expect(backend.deleteVectorItems.mock.calls[0][1]).toEqual([1001, 1002]);
        expect(document.querySelector('#vectfox_chunk_pane .vfx-empty')).not.toBeNull();
        expect(document.querySelector('[data-chunk-count]').textContent).toBe('1 of 3 chunks loaded');
    });

    it('deletes nothing when the question is cancelled', async () => {
        host.answer = false;
        await openHarbor();
        change(document.querySelector('[data-chunk-tick="0"]'), true);
        actionButton('bulk-delete').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
        expect(announceEventsRemoved).not.toHaveBeenCalled();
        expect(rowKeys()).toEqual(['0', '1', '2']);
    });

    it("tells EventBase's listener the IDs of the events it deleted, after the delete", async () => {
        const events = { id: 'vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Harbor events', type: 'chat', backend: 'qdrant', chunkCount: 3 };
        host.items = [
            { hash: 2000, index: 0, text: 'Wren reached the gate.', metadata: { event_id: 'evt-gate' } },
            { hash: 2001, index: 1, text: 'The tide came in.', metadata: { event_id: 'evt-tide' } },
            { hash: 2002, index: 2, text: 'A note with no event.', metadata: {} },
        ];
        backend.deleteVectorItems.mockImplementation(async () => {
            expect(announceEventsRemoved).not.toHaveBeenCalled();
        });
        await openHarbor(SETTINGS, events);
        change(document.querySelector('[data-chunk-tick="1"]'), true);
        change(document.querySelector('[data-chunk-tick="2"]'), true);
        actionButton('bulk-delete').click();
        await vi.waitFor(() => expect(rowKeys()).toEqual(['0']));
        expect(announceEventsRemoved).toHaveBeenCalledTimes(1);
        expect(announceEventsRemoved).toHaveBeenCalledWith(events.id, ['evt-tide']);
    });
});

describe("a lorebook's LoreBase parts", () => {
    const TENANT = 'vf_lorebase_qdrant_rook_harbor_atlas_19qag9zxydm';
    const PARTS = { id: TENANT, name: 'Harbor Atlas', type: 'lorebook', backend: 'qdrant', source: 'openrouter', model: 'baai/bge-m3', chunkCount: 3 };
    // The settings tenantChunkSource gives for a tenant of the account's own LoreBase collection.
    const IN_ACCOUNT_COLLECTION = { vector_backend: 'qdrant', qdrant_multitenancy: true, qdrant_shared_collection: 'vf_lorebase_rook' };

    beforeEach(() => {
        host.items = [
            { hash: 501, text: 'Lighthouse\nIts keeper.', metadata: { lorebookName: 'Harbor Atlas', entryUid: '12', partNumber: 2 } },
            { hash: 502, text: 'Gate\nThe harbor gate.', metadata: { lorebookName: 'Harbor Atlas', entryUid: '3', partNumber: 1 } },
            { hash: 503, text: 'Lighthouse\nIts history.', metadata: { lorebookName: 'Harbor Atlas', entryUid: '12', partNumber: 1 } },
        ];
    });

    async function openParts(editEntry = null) {
        void openChunkVisualizer(PARTS, IN_ACCOUNT_COLLECTION, { isLoreBaseParts: true, editEntry });
        change($id('vectfox_chunk_sort'), 'index');
        await vi.waitFor(() => expect(rowKeys().length).toBe(host.items.length));
    }

    it("reads the tenant's parts in the collection holding them, and lists them by entry and part under each entry's title", async () => {
        await openParts();
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ backend: 'qdrant', collectionId: 'vf_lorebase_rook', filters: { content_type: TENANT } });
        // Only the parts are read, not the Qdrant collection's own record, which every lorebook there shares.
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(rowKeys()).toEqual(['1', '2', '0']);
        expect([...document.querySelectorAll('[data-chunk-entry] .vfx-row-name')].map(name => name.textContent)).toEqual(['Gate', 'Lighthouse', 'Lighthouse']);
        expect([...document.querySelectorAll('[data-chunk-entry] .vfx-row-sub')].map(line => line.textContent))
            .toEqual(['Entry: 3, part 1', 'Entry: 12, part 1', 'Entry: 12, part 2']);
        expect(document.querySelector('[data-chunk-tick]')).toBeNull();
    });

    it('opens a part read only: its text takes no typing, nothing saves or deletes it, and another opens without a question', async () => {
        await openParts();
        await openChunk('0');
        expect($id('vectfox_chunk_text').readOnly).toBe(true);
        expect(document.querySelector('[data-chunk-text-count]').textContent).toBe('22 characters.');
        expect(document.querySelector('[data-chunk-action="save"], [data-chunk-action="delete"], [data-chunk-action="bulk-delete"]')).toBeNull();
        // No entry editor was given, as for a leftover's parts.
        expect(actionButton('edit-entry')).toBeNull();
        await openChunk('2');
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(Object.values(backend).every(mock => mock.mock.calls.length === 0)).toBe(true);
    });

    it('opens the entry editor on the open part, waiting meanwhile, and after a save reads the list again with the same part open', async () => {
        let finishEdit;
        const editEntry = vi.fn(() => new Promise(resolve => { finishEdit = resolve; }));
        await openParts(editEntry);
        await openChunk('0');
        actionButton('edit-entry').click();
        expect(editEntry).toHaveBeenCalledTimes(1);
        expect(editEntry.mock.calls[0][0]).toMatchObject({ hash: 501, metadata: { entryUid: '12', partNumber: 2 } });
        expect(actionButton('edit-entry').disabled).toBe(true);

        // The edit changed the part's text, so LoreBase wrote it again under a new ID.
        host.items = [{ hash: 601, text: 'Lighthouse\nIts keeper, now retired.', metadata: { lorebookName: 'Harbor Atlas', entryUid: '12', partNumber: 2 } }, ...host.items.slice(1)];
        finishEdit(true);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect($id('vectfox_chunk_text').value).toBe('Lighthouse\nIts keeper, now retired.'));
        expect(document.querySelector('[data-chunk-entry].is-open').dataset.chunkEntry).toBe('0');
        expect(actionButton('edit-entry').disabled).toBe(false);
    });

    it('reads nothing again when the editor saves nothing', async () => {
        const editEntry = vi.fn(async () => false);
        await openParts(editEntry);
        await openChunk('2');
        actionButton('edit-entry').click();
        await vi.waitFor(() => expect(actionButton('edit-entry').disabled).toBe(false));
        expect(editEntry).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-chunk-entry].is-open').dataset.chunkEntry).toBe('2');
    });

    it("keeps a collection's order for the next one when the parts do not offer it, and the parts list in entry order", async () => {
        await openHarbor();
        change($id('vectfox_chunk_sort'), 'keywords');
        document.body.innerHTML = '';
        void openChunkVisualizer(PARTS, IN_ACCOUNT_COLLECTION, { isLoreBaseParts: true });
        await vi.waitFor(() => expect(rowKeys().length).toBe(host.items.length));
        expect($id('vectfox_chunk_sort').value).toBe('index');
        expect(rowKeys()).toEqual(['1', '2', '0']);

        document.body.innerHTML = '';
        void openChunkVisualizer(COLLECTION, SETTINGS);
        await vi.waitFor(() => expect(rowKeys().length).toBe(host.items.length));
        expect($id('vectfox_chunk_sort').value).toBe('keywords');
    });
});
