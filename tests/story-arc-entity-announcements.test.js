/**
 * @vitest-environment jsdom
 *
 * StoryArc's Entity tab tells of each merge and split it saves (src/features/eventbase/story-arc-page.js), on the
 * page's real code and markup: once Merge is confirmed and saved, EventBase's announcements hear the collection, the
 * kept name and every other name of the entity now; once Split is saved, the collection, the kept name and the name
 * split off it. src/index.js passes each on to Entity-Lore (D14 and D17 of InternalProject/Vectfox/plans/entity-lore.md).
 * A merge the user cancels tells nothing.
 *
 * Names are made up and match no story.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';

const host = vi.hoisted(() => ({
    events: [
        { _hash: 1, event_id: 'e1', text: 'Mara and Tobin meet at the Harbor Library.', characters: ['Mara', 'Tobin'], locations: ['Harbor Library'], factions: [] },
        { _hash: 2, event_id: 'e2', text: 'Elsie pours tea for Mara at the Lighthouse.', characters: ['Elsie', 'Mara'], locations: ['Lighthouse'], factions: [] },
    ],
    merges: {},
    savedMerges: [],
    announced: [],
    isConfirmed: true,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: () => {}, warn: () => {} } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: async () => host.isConfirmed }));
vi.mock('../src/features/eventbase/story-arc-web.js', () => ({
    drawStoryWeb: async () => ({ destroy: () => {}, setPaused: () => {}, setLines: () => {} }),
}));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    readChatStoryEvents: async () => ({ events: host.events, registryKey: 'qdrant:a-collection', problem: '' }),
}));
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({
    readEntityMerges: () => host.merges,
    saveEntityMerges: (key, merges) => host.savedMerges.push({ key, merges }),
    readHiddenEntityNames: () => [],
    saveHiddenEntityNames: () => {},
}));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));
vi.mock('../src/features/eventbase/eventbase-announcements.js', () => ({
    announceEntityNamesMerged: merge => host.announced.push({ merge }),
    announceEntityNameSplit: split => host.announced.push({ split }),
}));

function press(action, name) {
    [...document.querySelectorAll(`[data-entity-action="${action}"]`)].find(button => button.dataset.name === name).click();
}

function mergeInto(sourceName, targetName) {
    press('merge', sourceName);
    document.getElementById('VectFox_story_arc_entity_merge_target').value = targetName;
    press('merge-confirm', sourceName);
}

describe('StoryArc Entity tab, the announcements of its merges and splits', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        Object.assign(host, { merges: { Mara: ['Marigold'] }, savedMerges: [], announced: [], isConfirmed: true });
        document.body.innerHTML = storyArcPageMarkup();
        const { showStoryArcPage, wireStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js');
        wireStoryArcPage({});
        await showStoryArcPage();
    });

    it('tells of the merge once it is saved: the collection, the kept name and every other name of the entity now', async () => {
        mergeInto('Elsie', 'Mara');

        await vi.waitFor(() => expect(host.announced).toEqual([{ merge: { collectionKey: 'qdrant:a-collection', keptName: 'Mara', otherNames: ['Marigold', 'Elsie'] } }]));
        expect(host.savedMerges).toEqual([{ key: 'qdrant:a-collection', merges: { Mara: ['Marigold', 'Elsie'] } }]);
    });

    it('tells nothing of a merge the user cancels', async () => {
        host.isConfirmed = false;
        mergeInto('Elsie', 'Mara');
        await new Promise((resolve) => { setTimeout(resolve, 20); });

        expect(host.savedMerges).toEqual([]);
        expect(host.announced).toEqual([]);
    });

    it('tells of a split once it is saved: the collection, the kept name and the name split off it', async () => {
        press('split', 'Mara');
        document.getElementById('VectFox_story_arc_entity_split_name').value = 'Marigold';
        press('split-confirm', 'Mara');

        await vi.waitFor(() => expect(host.announced).toEqual([{ split: { collectionKey: 'qdrant:a-collection', keptName: 'Mara', splitName: 'Marigold' } }]));
        expect(host.savedMerges).toEqual([{ key: 'qdrant:a-collection', merges: {} }]);
    });
});
