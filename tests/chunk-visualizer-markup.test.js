/**
 * @vitest-environment jsdom
 *
 * The Chunk Visualizer's markup (src/features/database-browser/chunk-visualizer-markup.js): the shell is a workbench
 * page whose split holds the list and the chunk; a row says where its chunk came from and marks the open one; an
 * EventBase chunk's form shows its event and leaves out the switch, keywords and links its retrieval never reads, but
 * keeps where it goes in the prompt; every value is escaped.
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
    keywordRowsMarkup,
    linkRowsMarkup,
    listFooterMarkup,
} from '../src/features/database-browser/chunk-visualizer-markup.js';

function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const pillsOf = root => [...root.querySelectorAll('.vfx-pill')].map(pill => pill.textContent);

const formView = ({ isEventBase = false, metadata = {}, stored = {} } = {}) => {
    const chunk = { text: '<b>The tide</b> came in.', index: 4, metadata };
    return {
        number: 5,
        hash: 1004,
        isEventBase,
        message: { text: 'Message', name: '4' },
        part: '',
        fields: savedChunkFields(chunk, stored),
        event: eventFields(chunk),
        links: [{ label: 'Message 2: Harbor gate', isLoaded: true, mode: 'soft' }],
        linkTargets: [{ value: '1002', label: 'Message 2: Harbor gate' }],
    };
};

describe('the shell', () => {
    it('holds the list and the chunk in a split with a divider a keyboard can move', () => {
        const shell = parse(chunkVisualizerMarkup({ collectionName: '<i>Harbor</i>', collectionType: 'lorebook', isEventBase: false, fetchLimit: 500 }));
        expect(shell.querySelector('.vfx-page-title').textContent).toBe('<i>Harbor</i>');
        const split = shell.querySelector(`#${ids.split}.vfx-split`);
        expect([...split.children].map(child => child.className)).toEqual(['vfx-card is-pane', 'vfx-split-divider', 'vfx-card is-pane']);
        const divider = split.querySelector('.vfx-split-divider');
        expect([divider.getAttribute('role'), divider.getAttribute('tabindex')]).toEqual(['separator', '0']);
        expect(shell.querySelector(`#${ids.fetchLimit}`).value).toBe('500');
        expect(shell.querySelector('.vfx-split .vfx-collapse')).toBeNull();
        expect(shell.querySelectorAll('[data-chunk-action^="bulk-"]').length).toBe(3);
    });

    it('offers no bulk switch for an EventBase collection, whose retrieval reads none', () => {
        const shell = parse(chunkVisualizerMarkup({ collectionName: 'Events', collectionType: 'chat', isEventBase: true, fetchLimit: 0 }));
        expect([...shell.querySelectorAll('[data-chunk-action^="bulk-"]')].map(button => button.dataset.chunkAction)).toEqual(['bulk-delete']);
    });
});

describe('a row', () => {
    const view = { key: '3', title: '<b>Gate</b>', message: { text: 'Messages', name: '40 to 44, event 3' }, part: '2 of 3', characterCount: 1234, keywordCount: 2, isEnabled: false, isOpen: true, isTicked: true };

    it('says where its chunk came from, how big it is, and its keywords and Disabled pills', () => {
        const row = parse(chunkRowMarkup(view));
        expect(row.querySelector('.vfx-row-name').textContent).toBe('<b>Gate</b>');
        expect([...row.querySelectorAll('.vfx-row-sub')].map(line => line.textContent)).toEqual(['Messages: 40 to 44, event 3', 'Part: 2 of 3']);
        expect(pillsOf(row)).toEqual(['1,234 characters', '2 keywords', 'Disabled']);
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
    it('holds the switch, keywords, links and summaries for a chunk collection, each value escaped', () => {
        const form = parse(chunkFormMarkup(formView({
            metadata: { name: 'Tide', keywords: [{ text: '<b>mast</b>', weight: 2 }] },
            stored: { summaries: ['High <i>water</i>'] },
        })));
        expect(form.querySelector('.vfx-card-title').textContent).toBe('Tide');
        // Each pill names its value: the DNA's pill shows a word or a value, so each is drawn as one value.
        expect(pillsOf(form.querySelector('.vfx-control-row'))).toEqual(['Message: 4', 'ID: 1004']);
        expect(form.querySelector(`#${ids.text}`).value).toBe('<b>The tide</b> came in.');
        expect(form.querySelector(`#${ids.enabled}`)).not.toBeNull();
        expect(form.querySelector('b, i:not(.fa-solid):not(.fa-brands)')).toBeNull();
        const weight = form.querySelector('[data-keyword-weight="0"]');
        expect([weight.value, weight.classList.contains('vfx-boost-box')]).toEqual(['2', true]);
        expect(form.querySelector('[data-chunk-links]').textContent).toContain('Message 2: Harbor gate');
        expect(form.querySelector('[data-chunk-summaries]').textContent).toContain('High <i>water</i>');
        expect(form.querySelector('[data-chunk-action="save"]').disabled).toBe(true);
    });

    it('shows an EventBase event and where it goes in the prompt, without the switch, keywords and links', () => {
        const form = parse(chunkFormMarkup(formView({ isEventBase: true, metadata: { event_type: 'decision', importance: 7, xmlTag: 'events' } })));
        expect(form.querySelector(`#${ids.enabled}`)).toBeNull();
        expect(form.querySelector('[data-chunk-keywords]')).toBeNull();
        expect(form.querySelector('[data-chunk-links]')).toBeNull();
        expect(form.querySelector(`#${ids.xmlTag}`).value).toBe('events');
        expect(form.querySelector(`#${ids.position}`)).not.toBeNull();
        expect(form.querySelector('.vfx-result').textContent).toContain('Importance: 7 of 10');
        expect(form.querySelector('[data-chunk-summaries]')).not.toBeNull();
    });

    it('shows the depth only for the in-chat position, and names a chunk with no name by its number', () => {
        const inChat = parse(chunkFormMarkup(formView({ metadata: { position: 1, depth: 0 } })));
        expect(inChat.querySelector(`#${ids.depthField}`).hidden).toBe(false);
        expect(inChat.querySelector(`#${ids.depth}`).value).toBe('0');
        expect(inChat.querySelector(`#${ids.position}`).value).toBe('1');
        expect(inChat.querySelector('.vfx-card-title').textContent).toBe('Chunk 5');
        const byDefault = parse(chunkFormMarkup(formView()));
        expect(byDefault.querySelector(`#${ids.depthField}`).hidden).toBe(true);
        expect(byDefault.querySelector(`#${ids.position} option:checked`).textContent).toBe('Collection default');
    });

    it('shows the collection\'s Qdrant record as pills that name each value', () => {
        expect(pillsOf(parse(collectionRecordMarkup([{ text: 'Keyword tokenizer', name: 'jieba' }])))).toEqual(['Keyword tokenizer: jieba']);
    });

    it('lists no keyword or link with a line saying so', () => {
        expect(parse(keywordRowsMarkup([])).textContent).toContain('No keywords yet.');
        expect(parse(linkRowsMarkup([{ label: 'ID 77', isLoaded: false, mode: 'force' }])).textContent).toContain('Not among the loaded chunks');
    });
});
