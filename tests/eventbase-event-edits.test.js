/**
 * EventBase's route for an edit of its events (src/features/eventbase/eventbase-event-edits.js), which the Database
 * Browser's Chunk Visualizer calls. A new text is written from the event as stored at that moment, so a link StoryArc
 * wrote after the caller read the event stays; an event keeps the ID EventBase gives it, and a point without an event
 * ID takes one from its text, its old copy going after; a point gone since the read, or a text that cannot be
 * embedded, writes nothing; an old copy that cannot go leaves the new text saved, and says so. A text edit takes its
 * turn with StoryArc's link writes. A delete keeps the events' windows read and tells their IDs, after the delete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ getChunk: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn() }));
vi.mock('../src/features/vector-backend/index.js', async () => ({
    ...backend,
    describeEmbeddingFailure: (await import('../src/features/vector-backend/embedding-failure.js')).describeEmbeddingFailure,
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getStringHash: text => [...String(text)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000003, 7) }));
const keepWindowsOfRemovedEvents = vi.hoisted(() => vi.fn());
const pointHashOf = vi.hoisted(() => id => 7_000_000 + [...String(id)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000003, 3));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({ keepWindowsOfRemovedEvents, eventPointHash: pointHashOf }));
const announceEventsRemoved = vi.hoisted(() => vi.fn());
vi.mock('../src/features/eventbase/eventbase-announcements.js', () => ({ announceEventsRemoved }));

const { deleteEventPoints, writeEventText } = await import('../src/features/eventbase/eventbase-event-edits.js');
const { inStoryLinkWriteTurn } = await import('../src/features/eventbase/eventbase-write-turns.js');
const { getStringHash } = await import('../src/sillytavern/identifiers.js');

const HARBOR = 'vf_eventbase_qdrant_harbor';
const SETTINGS = { vector_backend: 'qdrant' };
const EVENT_HASH = pointHashOf('evt-key');
const LINKS = [{ event_id: 'evt-door', type: 'continues', thread: 'The key' }];

/** The event as Qdrant holds it: its hash and text in its payload too. */
const storedEvent = (payload = {}) => ({
    hash: EVENT_HASH,
    text: 'Orrin hid the key.',
    metadata: { hash: EVENT_HASH, text: 'Orrin hid the key.', event_id: 'evt-key', importance: 6, ...payload },
});

beforeEach(() => {
    for (const mock of Object.values(backend)) mock.mockReset().mockResolvedValue(undefined);
    keepWindowsOfRemovedEvents.mockReset();
    announceEventsRemoved.mockReset();
});

describe('writeEventText', () => {
    it("writes the new text from the event as stored now, keeping a link StoryArc wrote after the caller's read, in place", async () => {
        backend.getChunk.mockResolvedValue(storedEvent({ story_links: LINKS }));
        const saved = await writeEventText(HARBOR, { hash: EVENT_HASH, index: 4 }, { text: 'Orrin hid the brass key.', payload: { name: 'Brass key' } }, SETTINGS);
        expect(backend.getChunk).toHaveBeenCalledWith(HARBOR, EVENT_HASH, SETTINGS);
        const metadata = { event_id: 'evt-key', importance: 6, story_links: LINKS, name: 'Brass key' };
        expect(backend.insertVectorItems).toHaveBeenCalledWith(HARBOR, [{ hash: EVENT_HASH, text: 'Orrin hid the brass key.', index: 4, metadata }], SETTINGS);
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
        expect(saved).toEqual({ hash: EVENT_HASH, metadata });
    });

    it('moves an event stored under a text ID to its own ID, then deletes that copy', async () => {
        backend.getChunk.mockResolvedValue({ ...storedEvent(), hash: 5555 });
        const saved = await writeEventText(HARBOR, { hash: 5555, index: 4 }, { text: 'Orrin hid the brass key.', payload: {} }, SETTINGS);
        expect(backend.insertVectorItems.mock.calls[0][1][0].hash).toBe(EVENT_HASH);
        expect(backend.deleteVectorItems).toHaveBeenCalledWith(HARBOR, [5555], SETTINGS);
        expect(backend.insertVectorItems.mock.invocationCallOrder[0]).toBeLessThan(backend.deleteVectorItems.mock.invocationCallOrder[0]);
        expect(saved.hash).toBe(EVENT_HASH);
    });

    it('stores a point with no event ID under an ID from its new text, then deletes its old copy', async () => {
        backend.getChunk.mockResolvedValue({ hash: 1001, text: 'The tide came in.', metadata: { name: 'Tide' } });
        await writeEventText(HARBOR, { hash: 1001, index: 1 }, { text: 'The tide went out.', payload: {} }, SETTINGS);
        expect(backend.insertVectorItems).toHaveBeenCalledWith(HARBOR, [{ hash: getStringHash('The tide went out.'), text: 'The tide went out.', index: 1, metadata: { name: 'Tide' } }], SETTINGS);
        expect(backend.deleteVectorItems).toHaveBeenCalledWith(HARBOR, [1001], SETTINGS);
    });

    it('writes nothing for an event no longer stored', async () => {
        backend.getChunk.mockResolvedValue(null);
        await expect(writeEventText(HARBOR, { hash: EVENT_HASH, index: 4 }, { text: 'Orrin hid the brass key.', payload: {} }, SETTINGS))
            .rejects.toThrow('it could not be read from the collection as stored now (another edit or a delete may have replaced it), so nothing was written');
        expect(backend.insertVectorItems).not.toHaveBeenCalled();
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
    });

    it("leaves the stored event as it was when the new text cannot be embedded, and reads the provider's answer", async () => {
        backend.getChunk.mockResolvedValue({ ...storedEvent(), hash: 5555 });
        backend.insertVectorItems.mockRejectedValue(new Error('[Qdrant] Failed to insert 1 vectors: 500 Internal Server Error - 429 Too Many Requests'));
        const failure = await writeEventText(HARBOR, { hash: 5555, index: 4 }, { text: 'Orrin hid the brass key.', payload: {} }, SETTINGS).catch(error => error);
        expect(failure.message).toBe('[Qdrant] Failed to insert 1 vectors: 500 Internal Server Error - 429 Too Many Requests');
        expect(failure.embeddingFailure.advice).toMatch(/^The embedding provider is busy or slow right now/);
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
    });

    it('says the new text is saved, and what was written, when its old copy cannot be deleted', async () => {
        backend.getChunk.mockResolvedValue({ ...storedEvent(), hash: 5555 });
        backend.deleteVectorItems.mockRejectedValue(new Error('Qdrant is down'));
        const failure = await writeEventText(HARBOR, { hash: 5555, index: 4 }, { text: 'Orrin hid the brass key.', payload: {} }, SETTINGS).catch(error => error);
        expect(failure.message).toBe('the new text is saved, but the old copy is still in the collection: Qdrant is down');
        expect(failure.saved).toEqual({ hash: EVENT_HASH, metadata: { event_id: 'evt-key', importance: 6 } });
    });

    it('waits for a link write under way in the collection, so it reads the links that write stores', async () => {
        let storedLinks = [];
        let endLinkWrite;
        const linkWrite = inStoryLinkWriteTurn(HARBOR, () => new Promise((resolve) => {
            endLinkWrite = () => {
                storedLinks = LINKS;
                resolve();
            };
        }));
        backend.getChunk.mockImplementation(async () => storedEvent({ story_links: storedLinks }));
        const written = writeEventText(HARBOR, { hash: EVENT_HASH, index: 4 }, { text: 'Orrin hid the brass key.', payload: {} }, SETTINGS);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(backend.getChunk).not.toHaveBeenCalled();
        endLinkWrite();
        await linkWrite;
        await written;
        expect(backend.insertVectorItems.mock.calls[0][1][0].metadata.story_links).toEqual(LINKS);
    });
});

describe('deleteEventPoints', () => {
    const points = [
        { hash: 2001, metadata: { event_id: 'evt-tide', source_window_start: 4 } },
        { hash: 2002, metadata: {} },
        { hash: 2003 },
    ];

    it("deletes the points, keeps the events' windows read, and tells their IDs once they are gone", async () => {
        backend.deleteVectorItems.mockImplementation(async () => {
            expect(keepWindowsOfRemovedEvents).not.toHaveBeenCalled();
            expect(announceEventsRemoved).not.toHaveBeenCalled();
        });
        await deleteEventPoints(HARBOR, points, SETTINGS);
        expect(backend.deleteVectorItems).toHaveBeenCalledWith(HARBOR, [2001, 2002, 2003], SETTINGS);
        expect(keepWindowsOfRemovedEvents).toHaveBeenCalledWith(HARBOR, [{ event_id: 'evt-tide', source_window_start: 4 }, {}, {}], SETTINGS);
        expect(announceEventsRemoved).toHaveBeenCalledWith(HARBOR, ['evt-tide']);
    });

    it('changes nothing else when the delete does not get through', async () => {
        backend.deleteVectorItems.mockRejectedValue(new Error('Qdrant is down'));
        await expect(deleteEventPoints(HARBOR, points, SETTINGS)).rejects.toThrow('Qdrant is down');
        expect(keepWindowsOfRemovedEvents).not.toHaveBeenCalled();
        expect(announceEventsRemoved).not.toHaveBeenCalled();
    });
});
