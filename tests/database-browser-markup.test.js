/**
 * @vitest-environment jsdom
 *
 * The Database Browser on GUI-DNA (src/features/database-browser/database-browser-markup.js): the top-bar shell holds
 * every control its wiring looks up, a collection's row carries its actions and pills from its view, values are
 * escaped, and the Search and Size pages paint their rows, empty states and pager.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BROWSER_PAGES,
    browserPageId,
    browserTabId,
    collectionEntryMarkup,
    databaseBrowserMarkup,
    keywordTagsMarkup,
    searchResultsMarkup,
    sizeEntriesMarkup,
    sizeSummaryRowMarkup,
    storyLinksRowMarkup,
} from '../src/features/database-browser/database-browser-markup.js';

const FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'database-browser');

function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const VIEW = {
    key: 'qdrant:vf_eventbase_qdrant_mira_road',
    name: 'Mira\'s road',
    id: 'vf_eventbase_qdrant_mira_road',
    type: 'chat',
    chunkCount: 14,
    isEnabled: true,
    isSelected: false,
    scope: 'chat',
    backend: 'Qdrant',
    source: 'openrouter',
    model: '',
    hasMultipleModels: false,
    activeHereLine: '',
    activationMode: 'auto',
    hasStoryLinks: false,
};

const actionsOf = fragment => [...fragment.querySelectorAll('[data-collection-action]')].map(button => button.dataset.collectionAction);
const pillsOf = fragment => [...fragment.querySelectorAll('.vfx-pill')].map(pill => pill.textContent);

describe('the browser shell', () => {
    it('is a top bar with one nav item and one page per page, the first one shown', () => {
        const root = parse(databaseBrowserMarkup()).firstElementChild;
        expect(root.id).toBe('vectfox_database_browser');
        expect(root.classList.contains('vfx-ui') && root.classList.contains('is-topbar')).toBe(true);
        expect(root.querySelector('.vfx-nav-brand').textContent).toBe('Database Browser');
        for (const [index, page] of BROWSER_PAGES.entries()) {
            const tab = root.querySelector(`#${browserTabId(page.name)}`);
            const pageElement = root.querySelector(`#${browserPageId(page.name)}`);
            expect(tab.classList.contains('is-active')).toBe(index === 0);
            expect(pageElement.style.display).toBe(index === 0 ? '' : 'none');
        }
        expect(BROWSER_PAGES.map(page => page.name)).toEqual(['collections', 'search', 'size']);
    });

    it('holds every element its wiring looks up by id', () => {
        const root = parse(databaseBrowserMarkup()).firstElementChild;
        const wiring = ['database-browser.js', 'size-inspector.js'].map(name => readFileSync(path.join(FOLDER, name), 'utf8')).join('\n');
        // The dialogs the browser still opens over itself (Rename, Switch model, Collection Settings, Manage locks)
        // build their own elements.
        const madeByDialogs = new Set([...wiring.matchAll(/\bid="(vectfox_\w+)"/g)].map(match => match[1]));
        const lookedUp = [...new Set([...wiring.matchAll(/#(vectfox_\w+)/g)].map(match => match[1]))]
            .filter(id => !madeByDialogs.has(id));
        expect(lookedUp.length).toBeGreaterThan(20);
        expect(lookedUp.filter(id => !root.querySelector(`#${id}`))).toEqual([]);
    });

    it('starts every bulk button disabled, Delete as danger', () => {
        const root = parse(databaseBrowserMarkup()).firstElementChild;
        const bulk = [...root.querySelectorAll('[data-browser-action^="bulk-"]')];
        expect(bulk.map(button => button.dataset.browserAction)).toEqual(['bulk-enable', 'bulk-disable', 'bulk-export', 'bulk-delete']);
        expect(bulk.every(button => button.disabled)).toBe(true);
        expect(bulk.at(-1).classList.contains('vfx-btn-danger')).toBe(true);
    });
});

describe('a collection in the list', () => {
    it('has its selection box, then its row with every action, Delete last as danger', () => {
        const entry = parse(collectionEntryMarkup(VIEW));
        const box = entry.querySelector('[data-collection-select]');
        expect(box.dataset.collectionSelect).toBe(VIEW.key);
        expect(box.checked).toBe(false);
        expect(actionsOf(entry)).toEqual(['toggle', 'rename', 'settings', 'view-chunks', 'export-json', 'export-png', 'delete']);
        expect([...entry.querySelectorAll('[data-collection-action]')].every(button => button.dataset.collectionKey === VIEW.key)).toBe(true);
        expect(entry.querySelector('[data-collection-action="delete"]').classList.contains('vfx-btn-danger')).toBe(true);
        expect(entry.querySelector('[data-collection-action="toggle"]').title).toBe('Pause');
        expect(entry.querySelector('.vfx-row-name').textContent).toBe('Mira\'s road');
        expect(entry.textContent).toContain('Chunks: 14');
        expect(entry.textContent).toContain(`ID: ${VIEW.id}`);
        expect(entry.textContent).toContain('Stored in: Qdrant, embedded by openrouter');
        expect(pillsOf(entry)).toEqual(['Chat']);
    });

    it('a paused one says so and offers Resume; a ticked one is checked', () => {
        const entry = parse(collectionEntryMarkup({ ...VIEW, isEnabled: false, isSelected: true }));
        expect(entry.querySelector('[data-collection-action="toggle"]').title).toBe('Resume');
        expect(pillsOf(entry)).toContain('Paused');
        expect(entry.querySelector('[data-collection-select]').checked).toBe(true);
    });

    it('shows its model and a Switch model button only with more than one model', () => {
        const entry = parse(collectionEntryMarkup({ ...VIEW, hasMultipleModels: true, model: 'bge-m3' }));
        expect(actionsOf(entry)).toContain('switch-model');
        expect(pillsOf(entry)).toContain('bge-m3');
    });

    it('says which lock makes it active here, and names its activation mode', () => {
        const line = 'Locked to this chat';
        const entry = parse(collectionEntryMarkup({ ...VIEW, activeHereLine: line, activationMode: 'triggers' }));
        expect(pillsOf(entry)).toEqual(expect.arrayContaining(['Active here', 'Triggers']));
        expect(entry.textContent).toContain(line);
        expect(pillsOf(parse(collectionEntryMarkup({ ...VIEW, activationMode: 'conditions' })))).toContain('Conditions');
    });

    it('gets a StoryArc links row only when it holds links, reading until its count is in', () => {
        expect(parse(collectionEntryMarkup(VIEW)).querySelector('[data-story-links-row]')).toBeNull();
        const reading = parse(collectionEntryMarkup({ ...VIEW, hasStoryLinks: true }));
        expect(reading.querySelector('[data-story-links-row]').dataset.storyLinksRow).toBe(VIEW.key);
        expect(reading.querySelector('[data-story-links-row]').textContent).toContain('Reading…');
        const counted = parse(storyLinksRowMarkup(VIEW.key, '3 of 14 events linked'));
        expect(counted.textContent).toContain('3 of 14 events linked');
        expect(actionsOf(counted)).toEqual(['export-links', 'import-links', 'delete-links']);
    });

    it('escapes its name and key', () => {
        const hostile = '<img src=x onerror="alert(1)">';
        const entry = parse(collectionEntryMarkup({ ...VIEW, name: hostile, key: `"${hostile}` }));
        expect(entry.querySelector('img')).toBeNull();
        expect(entry.querySelector('.vfx-row-name').textContent).toBe(hostile);
        expect(entry.querySelector('[data-collection-select]').dataset.collectionSelect).toBe(`"${hostile}`);
    });
});

describe('the Search page', () => {
    const result = { score: '87.5', vectorScore: null, textScore: null, isHybrid: false, preview: 'Mira crossed the bridge.', keywords: ['bridge'], moreKeywordCount: 0 };

    it('groups results by collection, each with View chunks for its collection', () => {
        const results = parse(searchResultsMarkup({ groups: [{ key: VIEW.key, name: 'Mira\'s road', results: [result] }], totalCount: 1, countBeforeKeywords: null }));
        expect(results.querySelector('.vfx-hint').textContent).toBe('1 result in 1 collection');
        expect(results.querySelector('.vfx-group-title').textContent).toBe('Mira\'s road (1)');
        expect(results.querySelector('.vfx-row-name').textContent).toBe('87.5% match');
        expect(results.textContent).toContain('Keywords: bridge');
        const view = results.querySelector('[data-collection-action="view-chunks"]');
        expect(view.dataset.collectionKey).toBe(VIEW.key);
    });

    it('scores a hybrid result by meaning and by words', () => {
        const hybrid = { ...result, isHybrid: true, vectorScore: '80', textScore: '20' };
        const results = parse(searchResultsMarkup({ groups: [{ key: 'k', name: 'n', results: [hybrid] }], totalCount: 1 }));
        expect(pillsOf(results)).toEqual(['Meaning 80%', 'Words 20%']);
    });

    it('says when nothing scored, and how many results the keyword filter dropped', () => {
        expect(parse(searchResultsMarkup({ groups: [], totalCount: 0 })).textContent).toContain('Nothing scored');
        const filtered = parse(searchResultsMarkup({ groups: [], totalCount: 0, countBeforeKeywords: 4 }));
        expect(filtered.textContent).toContain('No result carries those keywords.');
        expect(filtered.textContent).toContain('4 results before the keyword filter.');
    });

    it('offers the 30 most common keywords, the ones in the filter pressed, and escapes them', () => {
        const keywords = Array.from({ length: 32 }, (_, index) => ({ text: index === 0 ? '<b>bridge</b>' : `word${index}`, count: 40 - index }));
        const tags = parse(keywordTagsMarkup(keywords, ['word1']));
        const buttons = [...tags.querySelectorAll('[data-keyword]')];
        expect(buttons).toHaveLength(30);
        expect(tags.querySelector('b')).toBeNull();
        expect(buttons[0].dataset.keyword).toBe('<b>bridge</b>');
        expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
        expect(buttons[2].getAttribute('aria-pressed')).toBe('false');
        expect(pillsOf(tags)).toEqual(['2 more']);
        expect(parse(keywordTagsMarkup([], [])).textContent).toContain('The scan found no keywords.');
    });
});

describe('the Size page', () => {
    const row = { key: 'qdrant:vf_x', collectionId: 'vf_x', backend: 'qdrant', count: 3, maxChars: 900, avgChars: 400, totalKB: 1, worstPreview: 'A long event' };

    it('ranks a collection with Show entries, and a failed one without', () => {
        const summary = parse(sizeSummaryRowMarkup(row));
        expect(summary.querySelector('[data-size-action="show"]').dataset.sizeKey).toBe('qdrant:vf_x');
        expect(summary.textContent).toContain('3 entries, largest 900 characters');
        const failed = parse(sizeSummaryRowMarkup({ ...row, count: 0, error: true, worstPreview: 'Could not read it: boom' }));
        expect(failed.querySelector('[data-size-action]')).toBeNull();
        expect(pillsOf(failed)).toContain('Failed');
        expect(parse(sizeSummaryRowMarkup({ ...row, count: 0 })).querySelector('[data-size-action]')).toBeNull();
    });

    it('lists 50 entries a page, with a pager only past one page', () => {
        const entries = Array.from({ length: 120 }, (_, index) => ({ rank: index + 1, chars: 1000 - index, hash: `h${index}`, preview: `entry ${index}` }));
        const second = sizeEntriesMarkup(entries, 1);
        const list = parse(second.list);
        expect(list.querySelectorAll('.vfx-row')).toHaveLength(50);
        expect(list.querySelector('.vfx-row-name').textContent).toBe('#51: 950 characters');
        const pager = parse(second.pager);
        expect(pager.textContent).toContain('2 / 3');
        expect([...pager.querySelectorAll('[data-size-page]')].map(button => button.dataset.sizePage)).toEqual(['0', '2']);
        expect(sizeEntriesMarkup(entries.slice(0, 10), 0).pager).toBe('');
    });
});
