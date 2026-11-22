/**
 * The name the Database Browser lists a chat's EventBase collection under (getCollectionDisplayName through
 * loadAllCollections, in src/features/collections/collection-loader.js; §2.5 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): the name stored in its record, else its automatic name, the ID before the
 * chat's UUID. A later collection, whose ID ends in the time it was made after the UUID, gets the automatic name of the
 * chat's first collection; a legacy ID with no backend keeps its own.
 *
 * The real loader and ID module run on stubbed SillyTavern modules, as in collection-discovery-outage-guards.test.js,
 * and without the plugin, so each collection's points are counted through getSavedHashes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({ characterId: '0', name1: 'Wren', chatId: 'Harbor Night' })),
}));
vi.mock('../../../../../script.js', () => ({
    characters: [],
    getRequestHeaders: vi.fn(() => ({})),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => 'Harbor Night'),
}));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(async () => ['point-1']),
    queryCollection: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is read when
// embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

const { extension_settings } = await import('../../../../extensions.js');
const { loadAllCollections } = await import('../src/features/collections/collection-loader.js');
const { resetPluginAvailableCache } = await import('../src/shared/similharity-plugin.js');

const HARBOR_UUID = '3f2a9c1e-7b4d-4e8a-9c61-2d5f8e0b7a43';
const FIRST = `qdrant:vf_eventbase_qdrant_wren_keeper_${HARBOR_UUID}`;
const LATER = `${FIRST}_mh3k2x1a`;
const RENAMED_LATER = `${FIRST}_mh3k2x1b`;
const LEGACY = `vf_eventbase_wren_keeper_${HARBOR_UUID}`;

beforeEach(() => {
    resetPluginAvailableCache();
    extension_settings.vectfox = {
        collections: { [RENAMED_LATER]: { displayName: 'Harbor Night 2' } },
        vectfox_collection_registry: [FIRST, LATER, RENAMED_LATER, LEGACY],
    };
});

describe("a chat collection's name in the Database Browser", () => {
    it("names a later collection as the chat's first, by the ID before the chat's UUID, unless its record names it", async () => {
        const collections = await loadAllCollections({ vector_backend: 'qdrant' }, false);
        expect(Object.fromEntries(collections.map(collection => [collection.registryKey, collection.name]))).toEqual({
            [FIRST]: '💬 Chat: qdrant_wren_keeper',
            [LATER]: '💬 Chat: qdrant_wren_keeper',
            [RENAMED_LATER]: 'Harbor Night 2',
            [LEGACY]: '💬 Chat: wren_keeper',
        });
    });
});
