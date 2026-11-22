/**
 * A collection's EventBase pointer (how far EventBase has read the chat into it, kept in its record) through an
 * export, an import and a delete (§2.3 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md).
 *
 * An import purges the collection and writes the file's events, so a pointer left behind would win over what the
 * collection now holds: ensureVectorizationTip probes only when nothing is saved, the panel reports the old number,
 * and ticking Auto-sync offers to re-extract a backlog that does not exist. So an import first clears the pointer of
 * the record it writes to, and once every chunk is in writes the file's.
 *
 * Runs the real exportCollection, importCollection and deleteCollection against the real EventBase pointer, with only
 * the backend, the plugin's chunk list and the host faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_CHAT_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const EXPORTED_COLLECTION_ID = `vf_eventbase_qdrant_wanderer_kagami_${CHAT_UUID}`;
const IMPORTED_COLLECTION_ID = `vf_eventbase_qdrant_rabbit_kagami_${CHAT_UUID}`;
const IMPORTED_KEY = `qdrant:${IMPORTED_COLLECTION_ID}`;
const OTHER_CHAT_KEY = `qdrant:vf_eventbase_qdrant_rabbit_kagami_${OTHER_CHAT_UUID}`;
const SAME_CHAT_OTHER_BACKEND_KEY = `vectra:vf_eventbase_standard_rabbit_kagami_${CHAT_UUID}`;

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ name1: 'Rabbit', name2: 'Kagami', chat: [] })),
}));
vi.mock('../../../../../script.js', () => ({
    characters: [],
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => 'chat.jsonl'),
}));
vi.mock('../../../../utils.js', () => ({ getStringHash: vi.fn(text => text.length) }));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: {
        show: vi.fn(),
        updateCurrentItem: vi.fn(),
        updateChunks: vi.fn(),
        updateProgress: vi.fn(),
        updateEmbeddingProgress: vi.fn(),
        setCancelHandler: vi.fn(),
        clearCancelHandler: vi.fn(),
        complete: vi.fn(),
        addError: vi.fn(),
    },
}));
vi.mock('../src/features/vector-backend/index.js', async () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    textWithKeywordSuffix: vi.fn(text => text),
    encodeSparseVector: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(),
    setInsertedCollectionRegistrar: vi.fn(),
    qdrantTarget: (await import('../src/features/vector-backend/qdrant-target.js')).qdrantTarget,
    copiedPointId: (await import('../src/features/vector-backend/qdrant-target.js')).copiedPointId,
}));

import { extension_settings } from '../../../../extensions.js';
import { log } from '../src/sillytavern/log.js';
import { getBackend, insertVectorItems, purgeVectorIndex } from '../src/features/vector-backend/index.js';
import { exportCollection, importCollection } from '../src/features/collections/collection-export.js';
import { getCollectionMeta } from '../src/features/collections/collection-metadata.js';
import { buildRegistryKey } from '../src/shared/collection-ids.js';
import { tenantPointId } from '../src/shared/point-ids.js';
import { deleteCollection, setDeletedOrImportedCollectionCleanup } from '../src/features/collections/collection-loader.js';
import {
    clearCachesForDeletedOrImportedCollection,
    ensureVectorizationTip,
    getAutoSyncMarker,
    getCollectionWindowSize,
    getUnfinishedWindowFingerprints,
    getVectorizationTip,
    isWindowAlreadyExtracted,
    markWindowExtracted,
    setVectorizationTip,
} from '../src/features/eventbase/eventbase-store.js';

const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter' };
const OLD_WINDOW = [11, 22];

function exportFile(collectionId = EXPORTED_COLLECTION_ID) {
    return {
        collection: { id: collectionId, name: collectionId },
        embedding: { source: 'openrouter', model: 'baai/bge-m3', backend: 'qdrant' },
        chunks: [{ text: 'an event', index: 0, metadata: { source_window_end: 2619 } }],
    };
}

/** What a collection's pointer looks like after an older run into it stopped at message 224. */
function seedOldPointer(registryKey) {
    markWindowExtracted(OLD_WINDOW, registryKey);
    setVectorizationTip(registryKey, 224);
}

function pointerState(registryKey) {
    return {
        tip: getVectorizationTip(registryKey),
        savedTip: extension_settings.vectfox.collections[registryKey]?.eventbaseProgress?.vectorizationTip,
        isWindowRemembered: isWindowAlreadyExtracted(OLD_WINDOW, registryKey),
    };
}

const NO_POINTER = { tip: undefined, savedTip: undefined, isWindowRemembered: false };
const OLD_POINTER = { tip: 224, savedTip: 224, isWindowRemembered: true };

describe('importing a collection resets its pointer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
        setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);
        seedOldPointer(IMPORTED_KEY);
    });

    it('forgets the old tip and window record of the imported collection', async () => {
        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(pointerState(IMPORTED_KEY)).toEqual(NO_POINTER);
    });

    it('makes the next read report what the imported collection holds', async () => {
        const listChunks = vi.fn().mockResolvedValue({ items: [{ metadata: { source_window_end: 2619 } }] });
        getBackend.mockResolvedValue({ listChunks });

        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(await ensureVectorizationTip(IMPORTED_KEY, SETTINGS)).toBe(2620);
        expect(listChunks).toHaveBeenCalledWith(IMPORTED_COLLECTION_ID, SETTINGS, expect.anything());
    });

    it("leaves every other collection's pointer alone: another chat's, and the same chat's on another backend", async () => {
        seedOldPointer(OTHER_CHAT_KEY);
        seedOldPointer(SAME_CHAT_OTHER_BACKEND_KEY);

        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(pointerState(OTHER_CHAT_KEY)).toEqual(OLD_POINTER);
        expect(pointerState(SAME_CHAT_OTHER_BACKEND_KEY)).toEqual(OLD_POINTER);
    });

    it('forgets it when the import fails after the purge', async () => {
        insertVectorItems.mockRejectedValue(new Error('insert refused'));

        await expect(importCollection(exportFile(), SETTINGS, { overwrite: true })).rejects.toThrow('insert refused');

        expect(purgeVectorIndex).toHaveBeenCalledTimes(1);
        expect(pointerState(IMPORTED_KEY)).toEqual(NO_POINTER);
    });

    it('keeps it when the file holds nothing to import', async () => {
        await expect(importCollection({ ...exportFile(), chunks: [] }, SETTINGS, { overwrite: true })).rejects.toThrow('No valid chunks');

        expect(purgeVectorIndex).not.toHaveBeenCalled();
        expect(pointerState(IMPORTED_KEY)).toEqual(OLD_POINTER);
    });

    it('does not fail an import over a cleanup that cannot run, and says so', async () => {
        setDeletedOrImportedCollectionCleanup(null);

        const result = await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(result.success).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(IMPORTED_COLLECTION_ID), expect.any(Error));
    });
});

describe('an export carries the pointer, and its import carries on from it', () => {
    const WINDOW_READ = '11,22';
    const WINDOW_FAILED = '33,44';
    const POINTER = { vectorizationTip: 40, extractedWindows: [WINDOW_READ], unfinishedWindows: [WINDOW_FAILED], autoSyncStartMarker: 30, windowSize: 2 };
    let file;

    beforeEach(async () => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: { [IMPORTED_KEY]: { eventbaseProgress: structuredClone(POINTER) } }, vectfox_collection_registry: [IMPORTED_KEY] };
        setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ success: true, items: [{ hash: 1, text: 'an event', vector: [0.1, 0.2], metadata: { source_window_end: 39 } }] }),
        })));
        file = await exportCollection(IMPORTED_COLLECTION_ID, SETTINGS, { backend: 'qdrant', source: 'openrouter', model: '' });
        // As on another install: the collection, its record and what is in memory of it are gone.
        await deleteCollection(IMPORTED_COLLECTION_ID, SETTINGS, IMPORTED_KEY);
    });

    it("writes the collection's pointer into the export file", () => {
        expect(file.settings.eventbaseProgress).toEqual(POINTER);
    });

    it('imports it with the events, so the collection reads on from its tip, its windows and its failed windows', async () => {
        await importCollection(file, SETTINGS, { overwrite: true, forceReembed: true });

        expect(getVectorizationTip(IMPORTED_KEY)).toBe(40);
        expect(await ensureVectorizationTip(IMPORTED_KEY, SETTINGS)).toBe(40);
        expect(getBackend).not.toHaveBeenCalled();
        expect(isWindowAlreadyExtracted([22, 11], IMPORTED_KEY)).toBe(true);
        expect(getUnfinishedWindowFingerprints(IMPORTED_KEY, 2)).toEqual(new Set([WINDOW_FAILED]));
        expect(getAutoSyncMarker(IMPORTED_KEY)).toBe(30);
        expect(getCollectionWindowSize(IMPORTED_KEY)).toBe(2);
    });

    it('imports a file made before the pointer was exported with none', async () => {
        delete file.settings.eventbaseProgress;

        await importCollection(file, SETTINGS, { overwrite: true, forceReembed: true });

        expect(getCollectionMeta(IMPORTED_KEY).eventbaseProgress).toBeUndefined();
        expect(getVectorizationTip(IMPORTED_KEY)).toBeUndefined();
    });

    it('leaves none after an import that is stopped, though the file holds one', async () => {
        insertVectorItems.mockRejectedValue(Object.assign(new Error('Import stopped by user'), { name: 'AbortError' }));

        await expect(importCollection(file, SETTINGS, { overwrite: true, forceReembed: true })).rejects.toThrow('stopped by user');

        expect(getCollectionMeta(IMPORTED_KEY).eventbaseProgress).toBeUndefined();
    });

    it('keeps only the parts of a pointer that have their shape', async () => {
        file.settings.eventbaseProgress = { vectorizationTip: '40', extractedWindows: [WINDOW_READ, 7], unfinishedWindows: [], autoSyncStartMarker: 30, windowSize: 0, isRead: true };

        await importCollection(file, SETTINGS, { overwrite: true, forceReembed: true });

        expect(getCollectionMeta(IMPORTED_KEY).eventbaseProgress).toEqual({ autoSyncStartMarker: 30 });
    });
});

describe('deleting a collection', () => {
    it('forgets its pointer, in its record and in memory', async () => {
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
        setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
        purgeVectorIndex.mockResolvedValue(true);
        seedOldPointer(IMPORTED_KEY);

        await deleteCollection(IMPORTED_COLLECTION_ID, SETTINGS, IMPORTED_KEY);

        expect(pointerState(IMPORTED_KEY)).toEqual(NO_POINTER);
        expect(buildRegistryKey(IMPORTED_COLLECTION_ID, SETTINGS)).toBe(IMPORTED_KEY);
    });
});

describe('importing a collection keeps its name', () => {
    // Exported and imported by the same persona, so the ID is not remapped.
    const SAME_PERSONA_ID = IMPORTED_COLLECTION_ID;
    const displayNameAfterImport = async (exported) => {
        await importCollection(exported, SETTINGS, { overwrite: true });
        return getCollectionMeta(buildRegistryKey(SAME_PERSONA_ID, SETTINGS)).displayName;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);
    });

    // An export of a collection with no typed name carries its ID as the name; the import once kept that ID as a
    // typed name, so the list showed the raw ID in place of the automatic name.
    it('leaves no typed name when the file carried the collection\'s ID as its name', async () => {
        expect(await displayNameAfterImport(exportFile(SAME_PERSONA_ID))).toBeFalsy();
    });

    it('leaves no typed name when the file carried none', async () => {
        expect(await displayNameAfterImport({ ...exportFile(SAME_PERSONA_ID), collection: { id: SAME_PERSONA_ID } })).toBeFalsy();
    });

    it('keeps a name the user typed', async () => {
        const named = { ...exportFile(SAME_PERSONA_ID), collection: { id: SAME_PERSONA_ID, name: 'Kagami at the shrine' } };
        expect(await displayNameAfterImport(named)).toBe('Kagami at the shrine');
    });
});

// An import keeps the hash of the point it was exported from, under which that point may still be stored in the shared
// collection (B3, probed on the NAS Qdrant on 2026-11-22).
describe("an import's point IDs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);
    });

    it('gives each point embedded again an ID of the collection it goes into, in the shared collection only', async () => {
        await importCollection(exportFile(), { ...SETTINGS, qdrant_multitenancy: true }, { overwrite: true });
        const [collectionId, chunks] = insertVectorItems.mock.calls[0];
        expect(chunks[0].id).toBe(tenantPointId(collectionId, chunks[0].hash));

        insertVectorItems.mockClear();
        await importCollection(exportFile(), SETTINGS, { overwrite: true });
        expect(insertVectorItems.mock.calls[0][1][0]).not.toHaveProperty('id');
    });
});
