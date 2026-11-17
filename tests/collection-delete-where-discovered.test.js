/**
 * deleteCollectionWhereDiscovered (src/features/collections/collection-loader.js), which start-up runs for each
 * collection VectFox no longer reads: it deletes the collection on the backend the plugin's last discovery found it
 * on, else on the backend its caller names, else on the settings' own, and hands the purge every source folder
 * discovery listed, so no folder brings the collection back on the next scan. A partial or failed delete is logged
 * under the caller's label and reads as not gone; it never throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({ characterId: '0', name1: 'TestPersona', chatId: 'chat-1' })),
}));

vi.mock('../../../../../script.js', () => ({
    characters: [],
    getRequestHeaders: vi.fn(() => ({})),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => 'chat-1'),
}));

vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    queryCollection: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { extension_settings } from '../../../../extensions.js';
import { purgeVectorIndex } from '../src/features/vector-backend/vector-api.js';
import { log } from '../src/sillytavern/log.js';
import {
    deleteCollectionWhereDiscovered,
    discoverExistingCollections,
    getCollectionRegistry,
    setDeletedOrImportedCollectionCleanup,
} from '../src/features/collections/collection-loader.js';
import { resetPluginAvailableCache } from '../src/shared/similharity-plugin.js';

const DISCOVERED_ID = 'vf_character_testpersona_harbor_1760000000000';
const DISCOVERED_KEY = `standard:${DISCOVERED_ID}`;
const UNDISCOVERED_ID = 'vf_document_testpersona_ledger_1760000000001';
const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter' };

/** Two source folders on disk hold the discovered collection: the populated one and an empty stub. */
const DISCOVERED_IN_TWO_FOLDERS = [
    { id: DISCOVERED_ID, backend: 'standard', source: 'transformers', chunkCount: 12, model: 'bge', models: [{ name: 'bge', chunkCount: 12 }] },
    { id: DISCOVERED_ID, backend: 'standard', source: 'openrouter', chunkCount: 0, model: '', models: [] },
];

/** fetch stub: /health ok, /collections returns what the plugin scanned. */
function mockPluginFetch(collections) {
    global.fetch = vi.fn(async (url) => {
        if (String(url).includes('/health')) return { ok: true, json: async () => ({ status: 'ok', version: 'test' }) };
        if (String(url).includes('/collections')) return { ok: true, json: async () => ({ success: true, qdrantScanned: true, collections }) };
        throw new Error(`unexpected fetch in test: ${url}`);
    });
}

const cleanup = vi.fn();

beforeEach(async () => {
    vi.clearAllMocks();
    extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [DISCOVERED_KEY] };
    resetPluginAvailableCache();
    setDeletedOrImportedCollectionCleanup(cleanup);
    mockPluginFetch(DISCOVERED_IN_TWO_FOLDERS);
    await discoverExistingCollections(SETTINGS);
    purgeVectorIndex.mockResolvedValue(true);
});

describe('deleteCollectionWhereDiscovered', () => {
    it('deletes on the backend discovery found, in every source folder it listed, and unregisters the collection', async () => {
        expect(getCollectionRegistry()).toContain(DISCOVERED_KEY);

        const isGone = await deleteCollectionWhereDiscovered({ registryKey: DISCOVERED_KEY, collectionId: DISCOVERED_ID, backend: 'qdrant' }, SETTINGS, 'VectFox');

        expect(isGone).toBe(true);
        expect(purgeVectorIndex).toHaveBeenCalledTimes(1);
        const [purgedId, purgeSettings] = purgeVectorIndex.mock.calls[0];
        expect(purgedId).toBe(DISCOVERED_ID);
        expect(purgeSettings.vector_backend).toBe('standard');
        expect(purgeSettings._discoveredSources).toEqual([
            { source: 'transformers', models: [{ name: 'bge', chunkCount: 12 }] },
            { source: 'openrouter', models: [] },
        ]);
        expect(purgeSettings.embedding_provider).toBe('openrouter');
        expect(SETTINGS.vector_backend).toBe('qdrant');
        expect(getCollectionRegistry()).not.toContain(DISCOVERED_KEY);
        expect(cleanup).toHaveBeenCalledWith(DISCOVERED_ID);
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('uses the backend its caller names for a collection discovery did not find, with no source folders', async () => {
        const isGone = await deleteCollectionWhereDiscovered({ registryKey: `standard:${UNDISCOVERED_ID}`, collectionId: UNDISCOVERED_ID, backend: 'standard' }, SETTINGS, 'VectFox');

        expect(isGone).toBe(true);
        const [, purgeSettings] = purgeVectorIndex.mock.calls[0];
        expect(purgeSettings.vector_backend).toBe('standard');
        expect(purgeSettings._discoveredSources).toEqual([]);
    });

    it('falls back to the settings\' own backend when neither discovery nor the caller names one', async () => {
        await deleteCollectionWhereDiscovered({ registryKey: `qdrant:${UNDISCOVERED_ID}`, collectionId: UNDISCOVERED_ID }, SETTINGS, 'VectFox');

        const [, purgeSettings] = purgeVectorIndex.mock.calls[0];
        expect(purgeSettings.vector_backend).toBe('qdrant');
        expect(purgeSettings._discoveredSources).toEqual([]);
    });

    it('reads a partial delete as not gone and logs what failed under the caller\'s label', async () => {
        purgeVectorIndex.mockResolvedValue(false);

        const isGone = await deleteCollectionWhereDiscovered({ registryKey: DISCOVERED_KEY, collectionId: DISCOVERED_ID }, SETTINGS, 'LoreBase');

        expect(isGone).toBe(false);
        expect(log.warn).toHaveBeenCalledWith(`LoreBase: the collection ${DISCOVERED_ID} was only partly deleted:`, ['Vectors: purge failed (see console)']);
    });

    it('reads a delete that throws as not gone, logs it under the caller\'s label, and never throws', async () => {
        const failure = new Error('Similharity is not reachable');
        purgeVectorIndex.mockRejectedValue(failure);

        await expect(deleteCollectionWhereDiscovered({ registryKey: DISCOVERED_KEY, collectionId: DISCOVERED_ID }, SETTINGS, 'VectFox')).resolves.toBe(false);
        expect(log.warn).toHaveBeenCalledWith(`VectFox: the collection ${DISCOVERED_ID} could not be deleted:`, failure);
    });
});
