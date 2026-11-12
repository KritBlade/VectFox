/**
 * @vitest-environment jsdom
 *
 * StoryArc's Entity tab, on the page's real code and markup: a row's Merge panel offers as the name to keep only the
 * names of the kind the filter shows (people, factions or places), all of them whatever the search, never the row's
 * own name.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';

const host = vi.hoisted(() => ({
    events: [
        { _hash: 1, event_id: 'e1', text: 'Mara and Tobin meet the Tide Guild at the Harbor Library.', characters: ['Mara', 'Tobin'], locations: ['Harbor Library'], factions: ['Tide Guild'] },
        { _hash: 2, event_id: 'e2', text: 'Elsie climbs the Lighthouse for the Council.', characters: ['Elsie'], locations: ['Lighthouse'], factions: ['Council'] },
        { _hash: 3, event_id: 'e3', text: 'Tobin sells flour at the Old Mill.', characters: ['Tobin'], locations: ['Old Mill'], factions: [] },
    ],
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: () => {}, warn: () => {} } }));
vi.mock('../src/features/eventbase/story-arc-web.js', () => ({
    drawStoryWeb: async () => ({ destroy: () => {}, setPaused: () => {}, setLines: () => {} }),
}));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    readChatStoryEvents: async () => ({ events: host.events, registryKey: 'a-collection', problem: '' }),
}));
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({ readEntityMerges: () => ({}), saveEntityMerges: () => {} }));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));

function typeInto(id, value, eventName) {
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event(eventName));
}

/** Open the Merge panel of a row of one kind, and read the names it offers. */
function namesOfferedToKeep(kind, rowName) {
    typeInto('VectFox_story_arc_entity_kind', kind, 'change');
    const mergeButton = [...document.querySelectorAll('[data-entity-action="merge"]')].find(button => button.dataset.name === rowName);
    mergeButton.click();
    return [...document.querySelectorAll('#VectFox_story_arc_entity_names option')].map(option => option.value).sort();
}

describe('StoryArc Merge panel, the names offered to keep', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        document.body.innerHTML = storyArcPageMarkup();
        const { showStoryArcPage, wireStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js');
        wireStoryArcPage({});
        await showStoryArcPage();
    });

    it.each([
        ['places', 'Harbor Library', ['Lighthouse', 'Old Mill']],
        ['people', 'Elsie', ['Mara', 'Tobin']],
        ['factions', 'Council', ['Tide Guild']],
    ])('are the other %s only', (kind, rowName, offered) => {
        expect(namesOfferedToKeep(kind, rowName)).toEqual(offered);
    });

    it('are every name of the kind, the ones the search hides included', () => {
        typeInto('VectFox_story_arc_entity_search', 'Old', 'input');
        expect(namesOfferedToKeep('places', 'Old Mill')).toEqual(['Harbor Library', 'Lighthouse']);
    });
});
