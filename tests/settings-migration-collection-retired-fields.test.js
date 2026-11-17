/**
 * settings-migration-collection-retired-fields.test.js — the fields nothing reads leave each collection's saved
 * metadata (src/app/settings-migration-collection-retired-fields.js):
 *   - every retired field is deleted from every collection, whatever its value, and every other field is left: the
 *     locks, pause, auto-sync, scope, names, tags and StoryArc's lists
 *   - collectionCount counts only the collections that lost a field
 *   - a second run is a no-op
 *   - settings with no collections, a non-object `collections` or entry, and a non-object are safe no-ops
 *
 * The migration is a pure in-memory field removal with no SillyTavern imports, so this file needs no module mocks.
 */
import { describe, it, expect } from 'vitest';
import {
    RETIRED_COLLECTION_FIELDS,
    migration_remove_retired_collection_fields,
} from '../src/app/settings-migration-collection-retired-fields.js';

/** The fields a collection keeps, as an event collection saved them. */
const keptFields = () => ({
    enabled: true,
    autoSync: true,
    scope: 'chat',
    lockedToChatIds: ['chat-harbor-1'],
    lockedToCharacterIds: ['3'],
    displayName: 'Harbor log',
    tags: ['harbor'],
    storyEntityMerges: { 'Keeper Orrin': ['Orrin'] },
    storyEntityHiddenNames: ['The Ledger'],
});

/** Every retired field, written out one by one so the list the migration deletes is pinned. */
const retiredFields = () => ({
    triggers: ['harbor', '/ledger/i'],
    triggerMatchMode: 'any',
    triggerCaseSensitive: false,
    triggerScanDepth: 5,
    conditions: { enabled: true, logic: 'AND', rules: [{ type: 'messageCount', settings: { operator: 'gte', count: 10 } }] },
    context: 'Notes from the harbor ledger.',
    xmlTag: 'harbor_notes',
    position: 1,
    depth: 2,
    alwaysActive: false,
    temporalDecay: { enabled: false, halfLife: 50 },
    lastUsed: 1700000000000,
    queryCount: 12,
});

const EVENTS = 'qdrant:vf_eventbase_harbor_1';
const ARCHIVE = 'vectra:vf_archiveevent_harbor_2';
const UNTOUCHED = 'vf_eventbase_tide_3';

/** What an install saved: one collection with every retired field, one with two of them, one with none. */
const savedBeforeRetirement = () => ({
    qdrant_host: 'localhost',
    collections: {
        [EVENTS]: { ...keptFields(), ...retiredFields() },
        [ARCHIVE]: { scope: 'chat', displayName: 'Harbor archive', context: '', queryCount: 0 },
        [UNTOUCHED]: { enabled: false, autoSync: false, displayName: 'Tide log', tags: [] },
    },
});

describe('migration_remove_retired_collection_fields', () => {
    it('deletes every retired field from every collection and leaves every other field and setting', () => {
        const settings = savedBeforeRetirement();
        const result = migration_remove_retired_collection_fields(settings);

        expect(result).toEqual({ migrated: RETIRED_COLLECTION_FIELDS.length + 2, collectionCount: 2 });
        for (const field of RETIRED_COLLECTION_FIELDS) expect(settings.collections[EVENTS], field).not.toHaveProperty(field);
        expect(settings).toEqual({
            qdrant_host: 'localhost',
            collections: {
                [EVENTS]: keptFields(),
                [ARCHIVE]: { scope: 'chat', displayName: 'Harbor archive' },
                [UNTOUCHED]: { enabled: false, autoSync: false, displayName: 'Tide log', tags: [] },
            },
        });
    });

    it('deletes a field saved as false, zero, empty or null too', () => {
        const settings = { collections: { [EVENTS]: { alwaysActive: false, queryCount: 0, xmlTag: '', lastUsed: null, triggers: [] } } };
        expect(migration_remove_retired_collection_fields(settings)).toEqual({ migrated: 5, collectionCount: 1 });
        expect(settings).toEqual({ collections: { [EVENTS]: {} } });
    });

    it('counts only the collections that lost a field', () => {
        const settings = {
            collections: {
                [EVENTS]: { ...keptFields(), lastUsed: 1700000000000 },
                [ARCHIVE]: keptFields(),
                [UNTOUCHED]: keptFields(),
            },
        };
        expect(migration_remove_retired_collection_fields(settings)).toEqual({ migrated: 1, collectionCount: 1 });
    });

    it('does nothing on a second run', () => {
        const settings = savedBeforeRetirement();
        migration_remove_retired_collection_fields(settings);
        const after = structuredClone(settings);
        expect(migration_remove_retired_collection_fields(settings)).toEqual({ migrated: 0, collectionCount: 0 });
        expect(settings).toEqual(after);
    });

    it('is a safe no-op on settings with no collections, a non-object collections or entry, and a non-object', () => {
        const nothingToDelete = { migrated: 0, collectionCount: 0 };
        expect(migration_remove_retired_collection_fields({ qdrant_host: 'localhost' })).toEqual(nothingToDelete);
        expect(migration_remove_retired_collection_fields({ collections: {} })).toEqual(nothingToDelete);
        expect(migration_remove_retired_collection_fields({ collections: null })).toEqual(nothingToDelete);
        expect(migration_remove_retired_collection_fields({ collections: 'collections' })).toEqual(nothingToDelete);
        const settings = { collections: { [EVENTS]: null, [ARCHIVE]: 'paused', [UNTOUCHED]: keptFields() } };
        expect(migration_remove_retired_collection_fields(settings)).toEqual(nothingToDelete);
        expect(settings).toEqual({ collections: { [EVENTS]: null, [ARCHIVE]: 'paused', [UNTOUCHED]: keptFields() } });
        expect(migration_remove_retired_collection_fields({})).toEqual(nothingToDelete);
        expect(migration_remove_retired_collection_fields(null)).toEqual(nothingToDelete);
        expect(migration_remove_retired_collection_fields('settings')).toEqual(nothingToDelete);
    });
});
