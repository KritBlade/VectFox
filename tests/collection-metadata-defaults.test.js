/**
 * Collection metadata defaults (src/features/collections/collection-metadata.js): every collection gets its own copy
 * of the default tags and StoryArc lists, so changing one collection's metadata in place never reaches another
 * collection or the defaults; and a collection's metadata starts with none of the fields the start-up migration
 * deletes (src/app/settings-migration-collection-retired-fields.js), so it never writes them back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import {
    ensureCollectionMeta,
    getCollectionMeta,
    setCollectionMeta,
} from '../src/features/collections/collection-metadata.js';
import { RETIRED_COLLECTION_FIELDS } from '../src/app/settings-migration-collection-retired-fields.js';

const listsOf = meta => [meta.tags, meta.storyEntityMerges, meta.storyEntityHiddenNames];
const EMPTY_LISTS = [[], {}, []];

beforeEach(() => {
    extension_settings.vectfox = { collections: {} };
});

describe('collection metadata defaults', () => {
    it('gives each collection without stored metadata its own tags and StoryArc lists', () => {
        const first = getCollectionMeta('qdrant:vf_eventbase_qdrant_wren_first');
        first.tags.push('harbor');
        first.storyEntityMerges.Orrin = ['Keeper'];
        first.storyEntityHiddenNames.push('Gull');

        expect(listsOf(getCollectionMeta('qdrant:vf_eventbase_qdrant_wren_second'))).toEqual(EMPTY_LISTS);
        expect(listsOf(getCollectionMeta('qdrant:vf_eventbase_qdrant_wren_first'))).toEqual(EMPTY_LISTS);
    });

    it('stores separate default tags and StoryArc lists for each new entry', () => {
        setCollectionMeta('vectra:test', { displayName: 'Test' });
        ensureCollectionMeta('vectra:VectFox_diag');
        const stored = extension_settings.vectfox.collections;

        stored['vectra:test'].tags.push('lore');
        stored['vectra:test'].storyEntityMerges.Orrin = ['Keeper'];
        stored['vectra:test'].storyEntityHiddenNames.push('Gull');

        expect(listsOf(stored['vectra:VectFox_diag'])).toEqual(EMPTY_LISTS);
        expect(listsOf(getCollectionMeta('qdrant:vf_never_stored'))).toEqual(EMPTY_LISTS);
    });

    it('starts a collection\'s metadata with no trigger, condition, prompt context or other retired field', () => {
        setCollectionMeta('vectra:test', { displayName: 'Test' });
        ensureCollectionMeta('vectra:VectFox_diag');
        const stored = extension_settings.vectfox.collections;

        for (const meta of [stored['vectra:test'], stored['vectra:VectFox_diag'], getCollectionMeta('qdrant:vf_never_stored')]) {
            expect(Object.keys(meta).filter(field => RETIRED_COLLECTION_FIELDS.includes(field))).toEqual([]);
        }
    });
});
