/**
 * EventBase's pointer, how far it has read a chat into one collection, kept in that collection's record
 * (`collections[<registry key>].eventbaseProgress`, §2.3 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): each part read and written through the store, two collections of one chat
 * never sharing one, the window records' in-memory Sets following the record, no message read twice in windows of any
 * size (§2.7), Start over's emptying (§2.6), and a deleted or imported collection forgotten in memory.
 *
 * Runs the real store and the real records, with only the host and the backend faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ name1: 'Wren', name2: 'Keeper', chat: [] })),
}));
vi.mock('../../../../../script.js', () => ({
    characters: [],
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => 'Harbor Night'),
}));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    encodeSparseVector: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(),
    setInsertedCollectionRegistrar: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { deleteVectorItems, getSavedHashes } from '../src/features/vector-backend/index.js';
import {
    clearAutoSyncMarker,
    clearCachesForDeletedOrImportedCollection,
    clearExtractionCaches,
    emptyEventBaseCollection,
    getAutoSyncMarker,
    getCollectionWindowSize,
    getUnfinishedWindowFingerprints,
    getVectorizationTip,
    isWindowAlreadyExtracted,
    markWindowExtracted,
    markWindowUnfinished,
    readEventBaseProgress,
    setCollectionWindowSize,
    setVectorizationTip,
    stampAutoSyncMarker,
    windowFingerprint,
    writeEventBaseProgress,
} from '../src/features/eventbase/eventbase-store.js';
import { setEventBaseListeners } from '../src/features/eventbase/eventbase-announcements.js';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
let collectionNumber = 0;

/** A collection of the chat no test used yet, on one backend or the other: the tip is held in memory per page load. */
function freshCollectionKey(backend = 'qdrant') {
    collectionNumber += 1;
    const backendInId = backend === 'vectra' ? 'standard' : backend;
    return `${backend}:vf_eventbase_${backendInId}_wren_keeper${collectionNumber}_${CHAT_UUID}`;
}

const FIRST_WINDOW = [101, 102];
const SECOND_WINDOW = [103, 104];

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
});

describe("a collection's pointer, in its record", () => {
    it('merges the parts written, removes a part written as undefined, and keeps the rest of the record', () => {
        const registryKey = freshCollectionKey();
        extension_settings.vectfox.collections[registryKey] = { scope: 'chat', lockedToChatIds: ['Harbor Night'] };

        writeEventBaseProgress(registryKey, { vectorizationTip: 12, autoSyncStartMarker: 10 });
        writeEventBaseProgress(registryKey, { windowSize: 4, autoSyncStartMarker: undefined });

        expect(readEventBaseProgress(registryKey)).toEqual({ vectorizationTip: 12, windowSize: 4 });
        expect(extension_settings.vectfox.collections[registryKey]).toMatchObject({ scope: 'chat', lockedToChatIds: ['Harbor Night'] });
    });

    it('writes nothing when no part changes, so clearing a collection with no record makes none', () => {
        const registryKey = freshCollectionKey();

        clearExtractionCaches(registryKey);
        clearAutoSyncMarker(registryKey);

        expect(extension_settings.vectfox.collections).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('drops the pointer from the record once its last part goes', () => {
        const registryKey = freshCollectionKey();
        setCollectionWindowSize(registryKey, 4);

        writeEventBaseProgress(registryKey, { windowSize: undefined });

        expect(readEventBaseProgress(registryKey)).toEqual({});
        expect(JSON.parse(JSON.stringify(extension_settings.vectfox.collections[registryKey]))).not.toHaveProperty('eventbaseProgress');
    });

    it("keeps every part apart for two collections of one chat, on two backends", () => {
        const first = freshCollectionKey('qdrant');
        const second = freshCollectionKey('vectra');

        markWindowExtracted(FIRST_WINDOW, first);
        markWindowUnfinished(SECOND_WINDOW, first);
        setVectorizationTip(first, 2);
        writeEventBaseProgress(first, { autoSyncStartMarker: 2 });
        setCollectionWindowSize(first, 2);
        setCollectionWindowSize(second, 6);

        expect(isWindowAlreadyExtracted(FIRST_WINDOW, first)).toBe(true);
        expect(isWindowAlreadyExtracted(FIRST_WINDOW, second)).toBe(false);
        expect(getUnfinishedWindowFingerprints(first, 2).size).toBe(1);
        expect(getUnfinishedWindowFingerprints(second, 2).size).toBe(0);
        expect(getVectorizationTip(first)).toBe(2);
        expect(getVectorizationTip(second)).toBeUndefined();
        expect(getAutoSyncMarker(first)).toBe(2);
        expect(getAutoSyncMarker(second)).toBeUndefined();
        expect(getCollectionWindowSize(first)).toBe(2);
        expect(getCollectionWindowSize(second)).toBe(6);
    });

    it('takes a window read at last off the unfinished record, and keeps the windows read in order', () => {
        const registryKey = freshCollectionKey();
        markWindowUnfinished(SECOND_WINDOW, registryKey);

        markWindowExtracted(FIRST_WINDOW, registryKey);
        markWindowExtracted(SECOND_WINDOW, registryKey);
        markWindowExtracted(FIRST_WINDOW, registryKey);

        expect(readEventBaseProgress(registryKey)).toEqual({ extractedWindows: [windowFingerprint(FIRST_WINDOW), windowFingerprint(SECOND_WINDOW)] });
    });

    it('never lowers the tip', () => {
        const registryKey = freshCollectionKey();
        setVectorizationTip(registryKey, 8);
        setVectorizationTip(registryKey, 4);

        expect(getVectorizationTip(registryKey)).toBe(8);
        expect(readEventBaseProgress(registryKey).vectorizationTip).toBe(8);
    });

    it('clears the windows, the failed windows and the tip together, keeping the auto-sync marker and window size', () => {
        const registryKey = freshCollectionKey();
        markWindowExtracted(FIRST_WINDOW, registryKey);
        markWindowUnfinished(SECOND_WINDOW, registryKey);
        setVectorizationTip(registryKey, 2);
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 2, windowSize: 2 });

        clearExtractionCaches(registryKey);

        expect(readEventBaseProgress(registryKey)).toEqual({ autoSyncStartMarker: 2, windowSize: 2 });
        expect(getVectorizationTip(registryKey)).toBeUndefined();
        expect(isWindowAlreadyExtracted(FIRST_WINDOW, registryKey)).toBe(false);
    });

    it('reads the windows again from a record whose window list was replaced, as an import replaces it', () => {
        const registryKey = freshCollectionKey();
        markWindowExtracted(FIRST_WINDOW, registryKey);
        expect(isWindowAlreadyExtracted(FIRST_WINDOW, registryKey)).toBe(true);

        extension_settings.vectfox.collections[registryKey].eventbaseProgress = { extractedWindows: [windowFingerprint(SECOND_WINDOW)] };

        expect(isWindowAlreadyExtracted(FIRST_WINDOW, registryKey)).toBe(false);
        expect(isWindowAlreadyExtracted(SECOND_WINDOW, registryKey)).toBe(true);
    });

    it("stamps the auto-sync marker from the collection's events, read from the collection the key names", async () => {
        const registryKey = freshCollectionKey();
        const listChunks = vi.fn().mockResolvedValue({ items: [{ metadata: { source_window_end: 9 } }, { metadata: { source_window_end: 3 } }] });
        const { getBackend } = await import('../src/features/vector-backend/index.js');
        getBackend.mockResolvedValue({ listChunks });

        expect(await stampAutoSyncMarker(registryKey, {})).toBe(10);
        expect(listChunks).toHaveBeenCalledWith(registryKey.slice('qdrant:'.length), {}, expect.anything());
        expect(getAutoSyncMarker(registryKey)).toBe(10);
    });
});

describe('no message read twice (§2.7)', () => {
    it('reads no window whose messages were all read in windows of another size, as a Catch up after auto-sync', () => {
        const registryKey = freshCollectionKey();
        for (const autoSyncWindow of [[1, 2], [3, 4], [5, 6]]) markWindowExtracted(autoSyncWindow, registryKey);

        expect(isWindowAlreadyExtracted([1, 2, 3, 4], registryKey)).toBe(true);
        expect(isWindowAlreadyExtracted([3, 4, 5, 6], registryKey)).toBe(true);
        expect(isWindowAlreadyExtracted([5, 6, 7, 8], registryKey)).toBe(false);
    });

    it('reads nothing again once a deleted message or a changed overlap moves every later window', () => {
        const registryKey = freshCollectionKey();
        for (const window of [[1, 2], [3, 4], [5, 6]]) markWindowExtracted(window, registryKey);

        // Message 3 deleted: the windows after it are [4, 5] and [6, 7].
        expect(isWindowAlreadyExtracted([4, 5], registryKey)).toBe(true);
        expect(isWindowAlreadyExtracted([6, 7], registryKey)).toBe(false);
        // An overlap of 1: the windows are [1, 2], [2, 3], [3, 4]...
        expect(isWindowAlreadyExtracted([2, 3], registryKey)).toBe(true);
    });

    it('takes a failed window off the unfinished record once its messages have all been read, in windows of any size', () => {
        const registryKey = freshCollectionKey();
        markWindowUnfinished([3, 4, 5, 6], registryKey);

        markWindowExtracted([3, 4], registryKey);
        expect(getUnfinishedWindowFingerprints(registryKey, 4).size).toBe(1);
        markWindowExtracted([5, 6], registryKey);
        expect(getUnfinishedWindowFingerprints(registryKey, 4).size).toBe(0);
        expect(readEventBaseProgress(registryKey).unfinishedWindows).toBeUndefined();
    });
});

describe("Start over's emptying (§2.6)", () => {
    const removals = [];
    beforeEach(() => {
        removals.length = 0;
        setEventBaseListeners({ onEventsRemoved: (collectionId, eventIds) => removals.push([collectionId, eventIds]) });
    });
    afterEach(() => setEventBaseListeners());

    const pointerOf = (registryKey) => {
        markWindowExtracted(FIRST_WINDOW, registryKey);
        markWindowUnfinished(SECOND_WINDOW, registryKey);
        setVectorizationTip(registryKey, 2);
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 2, windowSize: 2 });
        return readEventBaseProgress(registryKey);
    };

    it('deletes every event, listing again after each delete until none is left, then forgets the windows, the failed windows and the tip, keeping where auto-sync started, at the window size given', async () => {
        const registryKey = freshCollectionKey();
        pointerOf(registryKey);
        getSavedHashes.mockResolvedValueOnce([11, 12, 13]).mockResolvedValueOnce([14]).mockResolvedValueOnce([]);

        expect(await emptyEventBaseCollection(registryKey, {}, { windowSize: 6 })).toBe(4);
        expect(deleteVectorItems.mock.calls).toEqual([
            [registryKey.slice('qdrant:'.length), [11, 12, 13], {}],
            [registryKey.slice('qdrant:'.length), [14], {}],
        ]);
        expect(readEventBaseProgress(registryKey)).toEqual({ autoSyncStartMarker: 2, windowSize: 6 });
        expect(getVectorizationTip(registryKey)).toBeUndefined();
        expect(removals).toEqual([[registryKey.slice('qdrant:'.length), null]]);
    });

    it('says nothing was removed from a collection that held no event', async () => {
        const registryKey = freshCollectionKey();
        getSavedHashes.mockResolvedValueOnce([]);
        expect(await emptyEventBaseCollection(registryKey, {}, { windowSize: 6 })).toBe(0);
        expect(removals).toEqual([]);
    });

    it('keeps the pointer as it was when a delete fails, or leaves an event it was given', async () => {
        const registryKey = freshCollectionKey();
        const pointer = pointerOf(registryKey);
        getSavedHashes.mockResolvedValue([11, 12]);
        deleteVectorItems.mockRejectedValueOnce(new Error('Qdrant refused the delete'));
        await expect(emptyEventBaseCollection(registryKey, {}, { windowSize: 6 })).rejects.toThrow('Qdrant refused the delete');
        expect(readEventBaseProgress(registryKey)).toEqual(pointer);

        getSavedHashes.mockReset();
        getSavedHashes.mockResolvedValueOnce([11, 12]).mockResolvedValueOnce([12]);
        await expect(emptyEventBaseCollection(registryKey, {}, { windowSize: 6 })).rejects.toThrow('1 of the 2 events it was asked to delete are still stored');
        expect(readEventBaseProgress(registryKey)).toEqual(pointer);
        expect(getVectorizationTip(registryKey)).toBe(2);
        // Not emptied: the feed carries what each delete removed.
        expect(removals).toEqual([]);
    });
});

describe('a collection deleted or imported', () => {
    it('is forgotten in memory on every backend that holds it, and no other collection is', () => {
        const registryKey = freshCollectionKey();
        const otherKey = freshCollectionKey();
        setVectorizationTip(registryKey, 8);
        setVectorizationTip(otherKey, 6);
        // The record is gone, as deleting the collection deletes it; only the tip in memory is left.
        extension_settings.vectfox.collections = {};

        clearCachesForDeletedOrImportedCollection(registryKey.slice('qdrant:'.length));

        expect(getVectorizationTip(registryKey)).toBeUndefined();
        expect(getVectorizationTip(otherKey)).toBe(6);
    });
});
