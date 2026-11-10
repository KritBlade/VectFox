/**
 * @vitest-environment jsdom
 *
 * The Chunk Visualizer's wiring (src/features/database-browser/chunk-visualizer.js), driven as a user would while it is
 * open: it loads and lists a collection's chunks; one Save writes a chunk's fields, or, for a changed text, embeds the
 * new text before the old chunk goes and points its summaries at it; a failed embedding loses nothing; leaving or
 * closing with unsaved edits asks; the bulk bar acts only on ticked chunks the list shows.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, canClose: null, stored: {}, calls: [], items: [] }));

const backend = vi.hoisted(() => ({
    insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(),
    updateChunkMetadata: vi.fn(),
}));

vi.mock('../src/features/vector-backend/index.js', () => backend);
vi.mock('../src/features/collections/index.js', () => ({
    getChunkMetadata: hash => host.stored[String(hash)] ?? null,
    saveChunkMetadata: (hash, metadata) => { host.stored[String(hash)] = { ...metadata }; },
    deleteChunkMetadata: (hash) => { delete host.stored[String(hash)]; },
}));
vi.mock('../src/features/eventbase/index.js', () => ({ packTimelineSortKey: (message, order) => message * 1000 + order }));
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
const type = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
};
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};

async function openHarbor() {
    void openChunkVisualizer(COLLECTION, SETTINGS);
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
    host.stored = { 1001: { summaries: ['High water'] } };
    host.calls = [];
    host.items = [
        { hash: 1000, index: 0, text: 'The gate stood open.', metadata: { keywords: [{ text: 'gate', weight: 1.5 }] } },
        { hash: 1001, index: 1, text: 'The tide came in.', metadata: { name: 'Tide' } },
        { hash: 1002, index: 2, text: 'Gulls over the harbor.', metadata: { enabled: false } },
    ];
    for (const [name, mock] of Object.entries(backend)) {
        mock.mockReset();
        mock.mockImplementation(async (collectionId, ...rest) => { host.calls.push([name, ...rest]); });
    }
    confirmPopup.mockClear();
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
    it('writes only the fields that changed, without embedding again', async () => {
        await openHarbor();
        await openChunk('1');
        expect(actionButton('save').disabled).toBe(true);
        type($id('vectfox_chunk_name'), 'High tide');
        change($id('vectfox_chunk_position'), '1');
        type($id('vectfox_chunk_depth'), '0');
        expect(actionButton('save').disabled).toBe(false);
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.updateChunkMetadata).toHaveBeenCalledTimes(1));
        expect(backend.updateChunkMetadata.mock.calls[0].slice(1, 3)).toEqual([1001, { name: 'High tide', position: 1, depth: 0 }]);
        expect(backend.insertVectorItems).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(document.querySelector('[data-chunk-save-state]').textContent).toBe('No changes.'));
    });

    it('embeds a changed text before the old chunk goes, and points its summaries at the new one', async () => {
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_text'), 'The tide went out.');
        actionButton('save').click();
        const newHash = getStringHash('The tide went out.');
        await vi.waitFor(() => expect(host.calls.length).toBe(4));
        expect(host.calls.map(([name]) => name)).toEqual(['insertVectorItems', 'deleteVectorItems', 'deleteVectorItems', 'insertVectorItems']);
        expect(host.calls[0][1][0]).toMatchObject({ hash: newHash, text: 'The tide went out.', index: 1, metadata: { name: 'Tide' } });
        expect(host.calls[1][1]).toEqual([1001]);
        expect(host.calls[2][1]).toEqual([getStringHash('High water')]);
        expect(host.calls[3][1][0]).toMatchObject({ text: 'High water', metadata: { isSummary: true, parentHash: newHash } });
        expect(host.stored).toEqual({ [newHash]: { summaries: ['High water'] } });
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
        expect(document.querySelector('[data-chunk-save-state]').textContent).toBe('Unsaved changes.');
        expect(host.stored[1001]).toEqual({ summaries: ['High water'] });
    });

    it('adds a keyword and a summary, and writes each where it lives', async () => {
        await openHarbor();
        await openChunk('1');
        type($id('vectfox_chunk_keyword_new'), 'tide');
        actionButton('add-keyword').click();
        type(document.querySelector('[data-keyword-weight="0"]'), '1');
        type($id('vectfox_chunk_summary_new'), 'Water rising');
        actionButton('add-summary').click();
        actionButton('save').click();
        await vi.waitFor(() => expect(backend.insertVectorItems).toHaveBeenCalledTimes(1));
        expect(backend.updateChunkMetadata.mock.calls[0][2]).toEqual({ keywords: [{ text: 'tide', weight: 1 }] });
        expect(backend.insertVectorItems.mock.calls[0][1][0]).toMatchObject({ text: 'Water rising', metadata: { parentHash: 1001 } });
        expect(host.stored[1001].summaries).toEqual(['High water', 'Water rising']);
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
        change($id('vectfox_chunk_filter'), 'enabled');
        change($id('vectfox_chunk_select_all'), true);
        expect(document.querySelector('[data-chunk-bulk-count]').textContent).toBe('2 selected');
        change($id('vectfox_chunk_filter'), 'keywords');
        expect(document.querySelector('[data-chunk-bulk-count]').textContent).toBe('1 selected');
    });

    it('disables only the ticked chunks that are enabled, at once', async () => {
        await openHarbor();
        change(document.querySelector('[data-chunk-tick="1"]'), true);
        change(document.querySelector('[data-chunk-tick="2"]'), true);
        actionButton('bulk-disable').click();
        await vi.waitFor(() => expect(document.querySelectorAll('[data-chunk-entry] .vfx-pill.is-warning').length).toBe(2));
        expect(backend.updateChunkMetadata.mock.calls.map(call => call.slice(1, 3))).toEqual([[1001, { enabled: false }]]);
    });

    it('deletes the ticked chunks and their summaries after one question', async () => {
        await openHarbor();
        await openChunk('1');
        change(document.querySelector('[data-chunk-tick="1"]'), true);
        change(document.querySelector('[data-chunk-tick="2"]'), true);
        actionButton('bulk-delete').click();
        await vi.waitFor(() => expect(rowKeys()).toEqual(['0']));
        expect(confirmPopup).toHaveBeenCalledTimes(1);
        expect(confirmPopup.mock.calls[0][1]).toMatchObject({ okButton: 'Delete', isDestructive: true });
        expect(backend.deleteVectorItems.mock.calls[0][1]).toEqual([1001, getStringHash('High water'), 1002]);
        expect(host.stored).toEqual({});
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
        expect(rowKeys()).toEqual(['0', '1', '2']);
    });
});
