/**
 * Collection metadata defaults: every collection gets its own copy of the
 * default triggers, tags and conditions, so changing one collection's
 * metadata in place never reaches another collection or the defaults.
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
    getCollectionConditions,
    getCollectionMeta,
    setCollectionMeta,
} from '../src/features/collections/collection-metadata.js';

const ZERO_CHANCE_RULE = { type: 'randomChance', negate: false, settings: { probability: 0 } };

beforeEach(() => {
    extension_settings.vectfox = { collections: {} };
});

describe('collection metadata defaults', () => {
    it('gives each collection without stored conditions its own conditions object', () => {
        getCollectionConditions('qdrant:vf_lorebook_first').rules.push(ZERO_CHANCE_RULE);

        expect(getCollectionConditions('qdrant:vf_lorebook_second').rules).toEqual([]);
        expect(getCollectionConditions('qdrant:vf_lorebook_first').rules).toEqual([]);
    });

    it('stores separate default triggers, tags and conditions for each new entry', () => {
        setCollectionMeta('vectra:test', { displayName: 'Test' });
        ensureCollectionMeta('vectra:VectFox_diag');
        const stored = extension_settings.vectfox.collections;

        stored['vectra:test'].conditions.rules.push(ZERO_CHANCE_RULE);
        stored['vectra:test'].triggers.push('dragon');
        stored['vectra:test'].tags.push('lore');

        expect(stored['vectra:VectFox_diag'].conditions.rules).toEqual([]);
        expect(stored['vectra:VectFox_diag'].triggers).toEqual([]);
        expect(stored['vectra:VectFox_diag'].tags).toEqual([]);
        expect(getCollectionMeta('qdrant:vf_never_stored').conditions.rules).toEqual([]);
    });
});
