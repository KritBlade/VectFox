/**
 * Importing a collection resets what VectFox remembers about its chat.
 *
 * A chat's saved vectorization tip and window record describe the events its collection held
 * before the import. importCollection purges the collection and writes the file's events, so a
 * record left behind wins over what the collection now holds: ensureVectorizationTip probes only
 * when nothing is saved, the panel reports the old number, and ticking Auto-sync offers to
 * re-extract a backlog that does not exist.
 *
 * Runs the real importCollection and deleteCollection against the real EventBase records, with
 * only the backend and the host faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_CHAT_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const EXPORTED_COLLECTION_ID = `vf_eventbase_qdrant_critblade_kagami_${CHAT_UUID}`;
const IMPORTED_COLLECTION_ID = `vf_eventbase_qdrant_rabbit_kagami_${CHAT_UUID}`;

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
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    encodeSparseVector: vi.fn(),
    getAdditionalArgs: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(),
    setInsertedCollectionRegistrar: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import { log } from '../src/sillytavern/log.js';
import { getBackend, insertVectorItems, purgeVectorIndex } from '../src/features/vector-backend/index.js';
import { importCollection } from '../src/features/collections/collection-export.js';
import { deleteCollection, setDeletedOrImportedCollectionCleanup } from '../src/features/collections/collection-loader.js';
import {
    clearCachesForDeletedOrImportedCollection,
    ensureVectorizationTip,
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

/** What a chat's records look like after an older run on this account stopped at message 224. */
function seedOldRecords(chatUUID) {
    markWindowExtracted(OLD_WINDOW, chatUUID);
    setVectorizationTip(chatUUID, 224);
}

async function hasOldRecords(chatUUID) {
    return {
        tip: getVectorizationTip(chatUUID),
        savedTip: extension_settings.vectfox.eventbase_vectorization_tip?.[chatUUID],
        isWindowRemembered: await isWindowAlreadyExtracted(OLD_WINDOW, null, SETTINGS, chatUUID),
    };
}

const NO_RECORDS = { tip: undefined, savedTip: undefined, isWindowRemembered: false };
const OLD_RECORDS = { tip: 224, savedTip: 224, isWindowRemembered: true };

describe('importing a collection resets its chat records', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [], chunk_metadata: {} };
        setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);
        seedOldRecords(CHAT_UUID);
    });

    it('forgets the old tip and window record of the imported chat', async () => {
        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(await hasOldRecords(CHAT_UUID)).toEqual(NO_RECORDS);
    });

    it('makes the next read report what the imported collection holds', async () => {
        const listChunks = vi.fn().mockResolvedValue({ items: [{ metadata: { source_window_end: 2619 } }] });
        getBackend.mockResolvedValue({ listChunks });

        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(await ensureVectorizationTip(CHAT_UUID, IMPORTED_COLLECTION_ID, SETTINGS)).toBe(2620);
        expect(listChunks).toHaveBeenCalledWith(IMPORTED_COLLECTION_ID, SETTINGS, expect.anything());
    });

    it('leaves other chats alone', async () => {
        seedOldRecords(OTHER_CHAT_UUID);

        await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(await hasOldRecords(OTHER_CHAT_UUID)).toEqual(OLD_RECORDS);
    });

    it('forgets them when the import fails after the purge', async () => {
        insertVectorItems.mockRejectedValue(new Error('insert refused'));

        await expect(importCollection(exportFile(), SETTINGS, { overwrite: true })).rejects.toThrow('insert refused');

        expect(purgeVectorIndex).toHaveBeenCalledTimes(1);
        expect(await hasOldRecords(CHAT_UUID)).toEqual(NO_RECORDS);
    });

    it('forgets them when the import is stopped', async () => {
        insertVectorItems.mockRejectedValue(Object.assign(new Error('Import stopped by user'), { name: 'AbortError' }));

        await expect(importCollection(exportFile(), SETTINGS, { overwrite: true })).rejects.toThrow('stopped by user');

        expect(await hasOldRecords(CHAT_UUID)).toEqual(NO_RECORDS);
    });

    it('keeps them when the imported collection is not an EventBase', async () => {
        await importCollection(exportFile(`vf_lorebook_qdrant_critblade_worldlore_${CHAT_UUID}`), SETTINGS, { overwrite: true });

        expect(await hasOldRecords(CHAT_UUID)).toEqual(OLD_RECORDS);
    });

    it('keeps them when the file holds nothing to import', async () => {
        await expect(importCollection({ ...exportFile(), chunks: [] }, SETTINGS, { overwrite: true })).rejects.toThrow('No valid chunks');

        expect(purgeVectorIndex).not.toHaveBeenCalled();
        expect(await hasOldRecords(CHAT_UUID)).toEqual(OLD_RECORDS);
    });

    it('does not fail an import over a cleanup that cannot run, and says so', async () => {
        setDeletedOrImportedCollectionCleanup(null);

        const result = await importCollection(exportFile(), SETTINGS, { overwrite: true });

        expect(result.success).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(IMPORTED_COLLECTION_ID), expect.any(Error));
    });
});

describe('deleting a collection', () => {
    it('still forgets the chat records', async () => {
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [], chunk_metadata: {} };
        setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
        purgeVectorIndex.mockResolvedValue(true);
        seedOldRecords(CHAT_UUID);

        await deleteCollection(IMPORTED_COLLECTION_ID, SETTINGS, `qdrant:${IMPORTED_COLLECTION_ID}`);

        expect(await hasOldRecords(CHAT_UUID)).toEqual(NO_RECORDS);
    });
});
