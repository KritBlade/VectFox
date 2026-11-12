/**
 * @vitest-environment jsdom
 *
 * StoryArc's Entity tab hides names, on the page's real code and markup: Hide takes a row off the list and saves it in
 * the collection's metadata, Show hidden lists the hidden names of the kind shown, and Show again puts one back. A
 * hidden name is not offered as the name to keep, and merging into one typed in shows it again. Only the Entity tab
 * reads hidden names, so StoryArc's search, router and block read every name as before.
 */
/* global document -- this file runs under the jsdom environment */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';

const host = vi.hoisted(() => ({
    events: [
        { _hash: 1, event_id: 'e1', text: 'Mara and Tobin meet at the Harbor Library.', characters: ['Mara', 'Tobin'], locations: ['Harbor Library'], factions: [] },
        { _hash: 2, event_id: 'e2', text: 'Elsie pours tea for Mara at the Lighthouse.', characters: ['Elsie', 'Mara'], locations: ['Lighthouse'], factions: [] },
    ],
    storedHiddenNames: [],
    savedHiddenNames: [],
    savedMerges: [],
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: () => {}, warn: () => {} } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: async () => true }));
vi.mock('../src/features/eventbase/story-arc-web.js', () => ({
    drawStoryWeb: async () => ({ destroy: () => {}, setPaused: () => {}, setLines: () => {} }),
}));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    readChatStoryEvents: async () => ({ events: host.events, registryKey: 'qdrant:a-collection', problem: '' }),
}));
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({
    readEntityMerges: () => ({}),
    saveEntityMerges: (key, merges) => host.savedMerges.push(merges),
    readHiddenEntityNames: () => host.storedHiddenNames,
    saveHiddenEntityNames: (key, names) => host.savedHiddenNames.push({ key, names }),
}));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));

const rowNames = () => [...document.querySelectorAll('#VectFox_story_arc_entity_list .vfx-row-name')].map(name => name.textContent);
const toggleText = () => document.getElementById('VectFox_story_arc_entity_hidden_toggle').textContent.trim();
const actionsOf = action => [...document.querySelectorAll(`#VectFox_story_arc_entity_list [data-entity-action="${action}"]`)];

function press(action, name) {
    const button = name === undefined
        ? document.querySelector(`[data-entity-action="${action}"]`)
        : actionsOf(action).find(each => each.dataset.name === name);
    button.click();
}

describe('StoryArc Entity tab, hidden names', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        host.storedHiddenNames = [];
        host.savedHiddenNames = [];
        host.savedMerges = [];
        document.body.innerHTML = storyArcPageMarkup();
        const { showStoryArcPage, wireStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js');
        wireStoryArcPage({});
        await showStoryArcPage();
    });

    it('offers no Show hidden while nothing is hidden', () => {
        expect(rowNames()).toEqual(['Mara', 'Elsie', 'Tobin']);
        expect(toggleText()).toBe('');
    });

    it('Hide takes the row off the list, saves the name for the chat\'s collection, and offers Show hidden', () => {
        press('hide', 'Elsie');

        expect(rowNames()).toEqual(['Mara', 'Tobin']);
        expect(host.savedHiddenNames).toEqual([{ key: 'qdrant:a-collection', names: ['Elsie'] }]);
        expect(toggleText()).toBe('Show hidden');
    });

    it('Show hidden lists only the hidden names, each with Show again and no other action, and says StoryArc still reads them', () => {
        press('hide', 'Elsie');
        press('toggle-hidden');

        expect(rowNames()).toEqual(['Elsie']);
        expect(actionsOf('unhide').map(button => button.dataset.name)).toEqual(['Elsie']);
        expect(actionsOf('merge')).toEqual([]);
        expect(actionsOf('hide')).toEqual([]);
        expect(document.getElementById('VectFox_story_arc_entity_list').textContent).toContain('StoryArc still reads them in every search.');
        expect(toggleText()).toBe('Back to names');

        press('toggle-hidden');
        expect(rowNames()).toEqual(['Mara', 'Tobin']);
    });

    it('Show again puts the name back, saves that, and leaves the hidden list once none is left', () => {
        press('hide', 'Elsie');
        press('toggle-hidden');
        press('unhide', 'Elsie');

        expect(host.savedHiddenNames.at(-1).names).toEqual([]);
        expect(rowNames()).toEqual(['Mara', 'Elsie', 'Tobin']);
        expect(toggleText()).toBe('');
    });

    it('brings back a row hidden with its Merge panel open without the panel, as Show hidden closes panels', () => {
        press('merge', 'Elsie');
        press('hide', 'Elsie');
        press('toggle-hidden');
        press('unhide', 'Elsie');

        expect(document.getElementById('VectFox_story_arc_entity_merge_target')).toBeNull();
    });

    it('does not offer a hidden name as the name to keep', () => {
        press('hide', 'Tobin');
        press('merge', 'Mara');

        expect([...document.querySelectorAll('#VectFox_story_arc_entity_names option')].map(option => option.value)).toEqual(['Elsie']);
    });

    it('shows a hidden name again when another name is merged into it', async () => {
        press('hide', 'Tobin');
        press('merge', 'Mara');
        document.getElementById('VectFox_story_arc_entity_merge_target').value = 'Tobin';
        press('merge-confirm', 'Mara');

        await vi.waitFor(() => expect(host.savedMerges).toEqual([{ Tobin: ['Mara'] }]));
        expect(host.savedHiddenNames.at(-1).names).toEqual([]);
        expect(rowNames()).toContain('Tobin');
    });
});

describe('StoryArc Entity tab, hidden names read when it shows', () => {
    it('keeps the saved hidden names off the list', async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        host.storedHiddenNames = ['Elsie'];
        document.body.innerHTML = storyArcPageMarkup();
        const { showStoryArcPage, wireStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js');
        wireStoryArcPage({});
        await showStoryArcPage();

        expect(rowNames()).toEqual(['Mara', 'Tobin']);
        expect(toggleText()).toBe('Show hidden');
    });
});

describe('what reads hidden names', () => {
    it('is only the Entity tab, the metadata defaults, and Export, Import and the chat fork that carry them', () => {
        const sourceRoot = join(process.cwd(), 'src');
        const filesOf = folder => readdirSync(folder, { withFileTypes: true })
            .flatMap(entry => (entry.isDirectory() ? filesOf(join(folder, entry.name)) : [join(folder, entry.name)]));
        const readers = filesOf(sourceRoot)
            .filter(file => file.endsWith('.js') && /storyEntityHiddenNames|HiddenEntityNames/.test(readFileSync(file, 'utf8')))
            .map(file => relative(sourceRoot, file).replaceAll('\\', '/'))
            .sort();

        expect(readers).toEqual([
            'features/collections/collection-export.js',
            'features/collections/collection-metadata.js',
            'features/eventbase/eventbase-fork.js',
            'features/eventbase/story-arc-entities.js',
            'features/eventbase/story-arc-page.js',
        ]);
    });
});
