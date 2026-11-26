/**
 * EventBase's window record keeps only what its collection cannot show (InternalProject/Vectfox/plans/
 * eventbase-window-record.md): a window is read when the record holds it or an event read back from the collection
 * carries its message hashes. Loading a collection's events trims its record of the windows they show, and only those;
 * a listing that fails, stops short or gives hashes only proves nothing; forgetting a collection's windows drops what
 * was loaded, a load under way included; removed events' windows stay read.
 *
 * Runs the real store and the real records, with only the host and the backend faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const backend = vi.hoisted(() => ({ listChunks: vi.fn() }));
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    encodeSparseVector: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(async () => backend),
    setInsertedCollectionRegistrar: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import {
    capAutoSyncMarker,
    clearCachesForDeletedOrImportedCollection,
    clearWindowCache,
    hasReadWindows,
    isWindowAlreadyExtracted,
    keepWindowsOfRemovedEvents,
    loadEventWindows,
    markWindowExtracted,
    readEventBaseProgress,
    windowsReadOf,
    writeEventBaseProgress,
} from '../src/features/eventbase/eventbase-store.js';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SETTINGS = { vector_backend: 'qdrant' };
let collectionNumber = 0;

/** A collection of the chat no test used yet: what is loaded of a collection is held per page load. */
function freshCollection() {
    collectionNumber += 1;
    const collectionId = `vf_eventbase_qdrant_wren_keeper${collectionNumber}_${CHAT_UUID}`;
    return { collectionId, registryKey: `qdrant:${collectionId}` };
}

/** A stored event of the window holding these messages, as the listing gives it. */
const eventPoint = (hash, messageHashes) => ({ hash, text: 'an event', metadata: { eventbase: true, event_id: `event-${hash}`, source_message_hashes: messageHashes } });

/** The listing answers these points, in one page. */
function listingHolds(points) {
    backend.listChunks.mockImplementation(async () => ({ items: points, total: points.length, hasMore: false }));
}

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.vectfox = { collections: {} };
});

describe('a window the events show', () => {
    it('is read once the events are loaded, though the record does not hold it', async () => {
        const { registryKey } = freshCollection();
        listingHolds([eventPoint(1, [11, 12])]);

        expect(isWindowAlreadyExtracted([12, 11], registryKey)).toBe(false);
        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: true });

        expect(isWindowAlreadyExtracted([12, 11], registryKey)).toBe(true);
        expect(hasReadWindows(registryKey)).toBe(true);
        expect(windowsReadOf(registryKey)).toEqual(['11,12']);
    });

    it('counts its messages as read for a window of another size', async () => {
        const { registryKey } = freshCollection();
        listingHolds([eventPoint(1, [11, 12]), eventPoint(2, [13, 14])]);
        await loadEventWindows(registryKey, SETTINGS);

        expect(isWindowAlreadyExtracted([11, 12, 13, 14], registryKey)).toBe(true);
        expect(isWindowAlreadyExtracted([13, 14, 15, 16], registryKey)).toBe(false);
    });

    it("counts in auto-sync's marker on a shorter chat, as the record's windows do", async () => {
        const { registryKey } = freshCollection();
        const messages = [1, 2, 3, 4, 5, 6].map(hash => ({ hash }));
        listingHolds([eventPoint(1, [1, 2]), eventPoint(2, [3, 4])]);
        await loadEventWindows(registryKey, SETTINGS);
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 10 });

        expect(capAutoSyncMarker(registryKey, messages, { windowSize: 2, step: 2, hashFn: message => message.hash })).toBe(4);
    });

    it('reads the listing once a page load, sharing a load under way', async () => {
        const { registryKey } = freshCollection();
        listingHolds([eventPoint(1, [11, 12])]);

        await Promise.all([loadEventWindows(registryKey, SETTINGS), loadEventWindows(registryKey, SETTINGS)]);
        await loadEventWindows(registryKey, SETTINGS);

        expect(backend.listChunks).toHaveBeenCalledTimes(1);
    });

    it('is listed page by page until the listing says none is left', async () => {
        const { registryKey } = freshCollection();
        backend.listChunks
            .mockResolvedValueOnce({ items: [eventPoint(1, [11, 12])], total: 2, hasMore: true })
            .mockResolvedValueOnce({ items: [eventPoint(2, [13, 14])], total: 2, hasMore: false });

        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: true });

        expect(backend.listChunks.mock.calls.map(([, , options]) => options.offset)).toEqual([0, 1]);
        expect(isWindowAlreadyExtracted([13, 14], registryKey)).toBe(true);
    });
});

describe('the trim', () => {
    it('drops from the record each window the events show, keeps the others, and marks the record trimmed', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        markWindowExtracted([13, 14], registryKey);
        listingHolds([eventPoint(1, [11, 12])]);

        await loadEventWindows(registryKey, SETTINGS);

        expect(readEventBaseProgress(registryKey)).toMatchObject({ extractedWindows: ['13,14'], isTrimmed: true });
        expect(isWindowAlreadyExtracted([11, 12], registryKey)).toBe(true);
        expect(isWindowAlreadyExtracted([13, 14], registryKey)).toBe(true);
    });

    it('drops every window when the events show them all, and keeps the trim mark', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        listingHolds([eventPoint(1, [11, 12])]);

        await loadEventWindows(registryKey, SETTINGS);

        expect(readEventBaseProgress(registryKey)).toEqual({ isTrimmed: true });
        expect(hasReadWindows(registryKey)).toBe(true);
    });

    it('leaves a record no event shows a window of as it was, unmarked', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        listingHolds([eventPoint(1, [21, 22])]);

        await loadEventWindows(registryKey, SETTINGS);

        expect(readEventBaseProgress(registryKey)).toEqual({ extractedWindows: ['11,12'] });
    });

    it('keeps a window the record gained while the listing ran', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        backend.listChunks.mockImplementation(async () => {
            markWindowExtracted([13, 14], registryKey);
            return { items: [eventPoint(1, [11, 12])], total: 1, hasMore: false };
        });

        await loadEventWindows(registryKey, SETTINGS);

        expect(readEventBaseProgress(registryKey).extractedWindows).toEqual(['13,14']);
    });
});

describe('a listing that proves nothing', () => {
    it('fails: nothing is loaded or trimmed, and the next load reads again', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        backend.listChunks.mockRejectedValueOnce(new Error('Qdrant is not answering'));

        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: false, problem: 'Qdrant is not answering' });
        expect(readEventBaseProgress(registryKey)).toEqual({ extractedWindows: ['11,12'] });

        listingHolds([eventPoint(1, [11, 12])]);
        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: true });
        expect(readEventBaseProgress(registryKey)).toEqual({ isTrimmed: true });
    });

    it('stops short of the total it gives', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        backend.listChunks.mockResolvedValue({ items: [eventPoint(1, [11, 12])], total: 3, hasMore: false });

        const answer = await loadEventWindows(registryKey, SETTINGS);

        expect(answer.isRead).toBe(false);
        expect(answer.problem).toContain('stopped at 1 of its 3 points');
        expect(readEventBaseProgress(registryKey)).toEqual({ extractedWindows: ['11,12'] });
        expect(isWindowAlreadyExtracted([11, 12], registryKey)).toBe(true);
    });

    it('gives the points without their payload, as Standard without Similharity lists them', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([11, 12], registryKey);
        listingHolds([{ hash: 1, text: '', metadata: {} }]);

        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: false, problem: 'its events came back without their payload', isWithoutPayload: true });
        expect(readEventBaseProgress(registryKey)).toEqual({ extractedWindows: ['11,12'] });
    });
});

describe("forgetting a collection's windows", () => {
    it('drops the windows its events showed with the record, on clear', async () => {
        const { registryKey } = freshCollection();
        markWindowExtracted([13, 14], registryKey);
        listingHolds([eventPoint(1, [11, 12])]);
        await loadEventWindows(registryKey, SETTINGS);

        clearWindowCache(registryKey);

        expect(readEventBaseProgress(registryKey)).toEqual({});
        expect(isWindowAlreadyExtracted([11, 12], registryKey)).toBe(false);
        expect(hasReadWindows(registryKey)).toBe(false);
    });

    it('keeps nothing of a load under way when the windows are cleared', async () => {
        const { registryKey } = freshCollection();
        let answerListing;
        backend.listChunks.mockImplementation(() => new Promise(resolve => { answerListing = resolve; }));
        const load = loadEventWindows(registryKey, SETTINGS);
        await vi.waitFor(() => expect(backend.listChunks).toHaveBeenCalledTimes(1));

        clearWindowCache(registryKey);
        answerListing({ items: [eventPoint(1, [11, 12])], total: 1, hasMore: false });

        expect((await load).isRead).toBe(false);
        expect(isWindowAlreadyExtracted([11, 12], registryKey)).toBe(false);
        listingHolds([]);
        expect(await loadEventWindows(registryKey, SETTINGS)).toEqual({ isRead: true });
    });

    it('drops them when the collection is deleted or imported, and no other collection\'s', async () => {
        const deleted = freshCollection();
        const other = freshCollection();
        listingHolds([eventPoint(1, [11, 12])]);
        await loadEventWindows(deleted.registryKey, SETTINGS);
        await loadEventWindows(other.registryKey, SETTINGS);

        clearCachesForDeletedOrImportedCollection(deleted.collectionId);

        expect(isWindowAlreadyExtracted([11, 12], deleted.registryKey)).toBe(false);
        expect(isWindowAlreadyExtracted([11, 12], other.registryKey)).toBe(true);
    });
});

describe('removed events', () => {
    it("keep their windows read on the record, once each, and a point that is no event adds none", () => {
        const { collectionId, registryKey } = freshCollection();

        keepWindowsOfRemovedEvents(collectionId, [
            { eventbase: true, source_message_hashes: [12, 11] },
            { eventbase: true, source_message_hashes: [11, 12] },
            { text: 'a LoreBase part' },
        ], SETTINGS);

        expect(readEventBaseProgress(registryKey).extractedWindows).toEqual(['11,12']);
    });

    it('stay read after a reload, when the events no longer show the window', async () => {
        const { collectionId, registryKey } = freshCollection();
        writeEventBaseProgress(registryKey, { isTrimmed: true });
        keepWindowsOfRemovedEvents(collectionId, [{ eventbase: true, source_message_hashes: [11, 12] }], SETTINGS);
        listingHolds([]);

        await loadEventWindows(registryKey, SETTINGS);

        expect(isWindowAlreadyExtracted([11, 12], registryKey)).toBe(true);
    });

    it('add nothing for points that carry no window', () => {
        const { collectionId, registryKey } = freshCollection();

        keepWindowsOfRemovedEvents(collectionId, [{ text: 'a chunk' }], SETTINGS);

        expect(readEventBaseProgress(registryKey)).toEqual({});
    });
});
