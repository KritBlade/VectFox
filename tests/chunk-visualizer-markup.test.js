/**
 * @vitest-environment jsdom
 *
 * The Chunk Visualizer's markup (src/features/database-browser/chunk-visualizer-markup.js): the shell is a workbench
 * page whose split holds the list and the chunk, and whose bulk bar only deletes; a row says where its chunk came from
 * and marks the open one; a chunk's form holds its name and its text beside the event EventBase wrote; every value is
 * escaped.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import { eventFields, savedChunkFields } from '../src/features/database-browser/chunk-visualizer-core.js';
import {
    VISUALIZER_IDS as ids,
    chunkFormMarkup,
    chunkRowMarkup,
    chunkVisualizerMarkup,
    collectionRecordMarkup,
    listFooterMarkup,
    tokenizerLockMarkup,
} from '../src/features/database-browser/chunk-visualizer-markup.js';

function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const pillsOf = root => [...root.querySelectorAll('.vfx-pill')].map(pill => pill.textContent);

const formView = (metadata = {}) => {
    const chunk = { text: '<b>The tide</b> came in.', index: 4, metadata };
    return { number: 5, hash: 1004, message: { text: 'Message', name: '4' }, fields: savedChunkFields(chunk), event: eventFields(chunk) };
};

describe('the shell', () => {
    it('holds the list and the chunk in a split with a divider a keyboard can move', () => {
        const shell = parse(chunkVisualizerMarkup({ collectionName: '<i>Harbor</i>', collectionType: 'chat', fetchLimit: 500 }));
        expect(shell.querySelector('.vfx-page-title').textContent).toBe('<i>Harbor</i>');
        const split = shell.querySelector(`#${ids.split}.vfx-split`);
        expect([...split.children].map(child => child.className)).toEqual(['vfx-card is-pane', 'vfx-split-divider', 'vfx-card is-pane']);
        const divider = split.querySelector('.vfx-split-divider');
        expect([divider.getAttribute('role'), divider.getAttribute('tabindex')]).toEqual(['separator', '0']);
        expect(shell.querySelector(`#${ids.fetchLimit}`).value).toBe('500');
        expect(shell.querySelector('.vfx-split .vfx-collapse')).toBeNull();
    });

    it('offers Delete alone in the bulk bar, starting disabled', () => {
        const shell = parse(chunkVisualizerMarkup({ collectionName: 'Events', collectionType: 'chat', fetchLimit: 0 }));
        const bulk = [...shell.querySelectorAll('[data-chunk-action^="bulk-"]')];
        expect(bulk.map(button => button.dataset.chunkAction)).toEqual(['bulk-delete']);
        expect(bulk[0].disabled).toBe(true);
    });
});

describe('a row', () => {
    const view = { key: '3', title: '<b>Gate</b>', message: { text: 'Messages', name: '40 to 44, event 3' }, characterCount: 1234, keywordCount: 2, isOpen: true, isTicked: true };

    it('says where its chunk came from, how big it is, and how many keywords it has', () => {
        const row = parse(chunkRowMarkup(view));
        expect(row.querySelector('.vfx-row-name').textContent).toBe('<b>Gate</b>');
        expect([...row.querySelectorAll('.vfx-row-sub')].map(line => line.textContent)).toEqual(['Messages: 40 to 44, event 3']);
        expect(pillsOf(row)).toEqual(['1,234 characters', '2 keywords']);
        expect(pillsOf(parse(chunkRowMarkup({ ...view, keywordCount: 0 })))).toEqual(['1,234 characters']);
    });

    it('marks the open chunk and its tick', () => {
        const entry = parse(chunkRowMarkup(view)).querySelector('[data-chunk-entry="3"]');
        expect(entry.classList.contains('is-open')).toBe(true);
        expect(entry.getAttribute('aria-current')).toBe('true');
        expect(entry.querySelector('[data-chunk-tick="3"]').checked).toBe(true);
        expect(entry.querySelector('[data-chunk-action="open"]').dataset.chunkKey).toBe('3');
        const closed = parse(chunkRowMarkup({ ...view, isOpen: false, isTicked: false })).querySelector('[data-chunk-entry="3"]');
        expect([closed.classList.contains('is-open'), closed.hasAttribute('aria-current'), closed.querySelector('.vfx-check').checked]).toEqual([false, false, false]);
    });

    it('says how many of the matching chunks the list shows', () => {
        expect(parse(listFooterMarkup({ shownCount: 50, matchCount: 120, hasMore: true })).textContent).toContain('Showing 50 of 120 chunks.');
        expect(listFooterMarkup({ shownCount: 0, matchCount: 0, hasMore: false })).toBe('');
    });
});

describe('the chunk form', () => {
    it('holds the chunk\'s name and its text, where it came from, and Save, each value escaped', () => {
        const form = parse(chunkFormMarkup(formView({ name: 'Tide <i>high</i>' })));
        expect(form.querySelector('.vfx-card-title').textContent).toBe('Tide <i>high</i>');
        // Each pill names its value: the DNA's pill shows a word or a value, so each is drawn as one value.
        expect(pillsOf(form.querySelector('.vfx-control-row'))).toEqual(['Message: 4', 'ID: 1004']);
        expect(form.querySelector(`#${ids.name}`).value).toBe('Tide <i>high</i>');
        expect(form.querySelector(`#${ids.text}`).value).toBe('<b>The tide</b> came in.');
        expect(form.querySelector('b, i:not(.fa-solid):not(.fa-brands)')).toBeNull();
        expect([...form.querySelectorAll('input, select, textarea')].map(control => control.id)).toEqual([ids.name, ids.text]);
        expect(form.querySelector('[data-chunk-action="save"]').disabled).toBe(true);
    });

    it('shows the event EventBase wrote, and when its message was sent', () => {
        const form = parse(chunkFormMarkup(formView({
            event_type: 'decision', importance: 7, concepts: ['trust'], open_threads: ['the <b>map</b>'], real_world_date: '2026-11-05T09:30:12.345Z',
        })));
        expect([...form.querySelectorAll('.vfx-result-line')].map(line => line.textContent)).toEqual([
            'Type: decision', 'Importance: 7 of 10', 'Concepts: trust', 'Open thread: the <b>map</b>',
        ]);
        expect(form.querySelector('.vfx-result b')).toBeNull();
        expect(pillsOf(form.querySelector('.vfx-control-row'))).toEqual(['Message: 4', 'Sent: 2026-11-05 09:30 UTC', 'ID: 1004']);
    });

    it('names a chunk with no name by its number', () => {
        expect(parse(chunkFormMarkup(formView())).querySelector('.vfx-card-title').textContent).toBe('Chunk 5');
    });

    it('shows the collection\'s Qdrant record as pills that name each value', () => {
        expect(pillsOf(parse(collectionRecordMarkup([{ text: 'CJK tokenizer', name: 'Simplified Chinese (Jieba WASM)' }]))))
            .toEqual(['CJK tokenizer: Simplified Chinese (Jieba WASM)']);
    });

    it('warns, on a chunk of a collection made with another CJK tokenizer, which two differ and what cannot be saved', () => {
        const notice = parse(tokenizerLockMarkup({ madeWith: 'Intl.Segmenter (English / Latin)', setTo: 'Traditional Chinese (Jieba WASM)' }));
        expect(notice.querySelector('.vfx-notice.is-warning')).not.toBeNull();
        expect(notice.textContent.replace(/\s+/g, ' ').trim()).toBe('This collection was made with the CJK tokenizer Intl.Segmenter (English / Latin), '
            + 'and VectFox is set to Traditional Chinese (Jieba WASM). A changed text can\'t be saved here; the name can.');
        expect(parse(chunkFormMarkup(formView())).querySelector('[data-chunk-tokenizer-notice]').hidden).toBe(true);
    });
});
