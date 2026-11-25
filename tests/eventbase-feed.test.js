/**
 * EventBase's feed (R2 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md, §5.3,
 * src/features/eventbase/eventbase-feed.js): what changed in one collection after a change number, read from
 * Similharity's change route through the vector backend, a stand-in here that answers as the route does. Each event
 * comes with its stored fields and its summary from its text; events stored before change numbers read as 0 and come
 * first, in story order; a chat position is data, so a chat a summary shortened loses no new event; removals come as
 * event IDs, and an emptied collection says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ answer: null, error: null, asked: [] }));

vi.mock('../src/features/vector-backend/index.js', async () => {
    const { textWithoutKeywordSuffix } = await import('../src/features/vector-backend/stored-chunk.js');
    return {
        textWithoutKeywordSuffix,
        readCollectionChanges: async (collectionId, settings, page) => {
            backend.asked.push({ collectionId, settings, page });
            if (backend.error) throw backend.error;
            return backend.answer;
        },
    };
});

const { readEventFeed } = await import('../src/features/eventbase/eventbase-feed.js');
const { EVENTBASE_SCHEMA_VERSION, buildEmbedText, packTimelineSortKey } = await import('../src/features/eventbase/eventbase-schema.js');
const { textWithKeywordSuffix } = await import('../src/features/vector-backend/stored-chunk.js');

const HARBOR_EVENTS = 'vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const settings = { vector_backend: 'qdrant' };

/** A made-up event, as validateEvent and the extractor leave one. */
function harborEvent(eventId, windowStart, overrides = {}) {
    return {
        event_type: 'discovery',
        importance: 6,
        summary: `Mara finds a brass key the tide left under the pier (${eventId})`,
        DateTime: '1802-04-11T21:00:00.000Z',
        scene_time: 'the night the lighthouse went dark',
        cause: 'A storm broke the pier lamps',
        result: 'Tobin keeps the brass key',
        characters: ['Mara', 'Tobin'],
        locations: ['Saltmarsh harbor'],
        keywords: ['brass key', 'pier'],
        event_id: eventId,
        source_window_start: windowStart,
        source_window_end: windowStart + 1,
        window_event_order: 0,
        timeline_sort_key: packTimelineSortKey(windowStart, 0),
        ...overrides,
    };
}

/** An event as Similharity's change route gives it: the payload Qdrant holds, without the summary, and its text. */
function storedPoint(event, changeNumber = null) {
    const { summary: _summary, ...payloadFields } = event;
    const text = textWithKeywordSuffix(buildEmbedText(event), event.keywords);
    const payload = { ...payloadFields, eventbase: true, text, hash: 41000 + event.source_window_start };
    if (changeNumber !== null) payload.change_number = changeNumber;
    return { hash: payload.hash, text, metadata: payload };
}

/** The feed's fields of an event stored with a number. */
function feedFieldsOf(event, changeNumber) {
    return {
        event_id: event.event_id,
        summary: event.summary,
        cause: event.cause,
        result: event.result,
        characters: event.characters,
        locations: event.locations,
        importance: event.importance,
        DateTime: event.DateTime,
        scene_time: event.scene_time,
        source_window_start: event.source_window_start,
        source_window_end: event.source_window_end,
        change_number: changeNumber,
    };
}

const changesAnswer = (parts) => ({ success: true, supported: true, points: [], removed: [], emptied: false, cursor: 0, hasMore: false, ...parts });

beforeEach(() => {
    backend.answer = null;
    backend.error = null;
    backend.asked = [];
});

describe('a full read', () => {
    it('gives every event with its stored fields and summary, those stored before change numbers first in story order', async () => {
        const anchor = harborEvent('eb-anchor', 20);
        const pier = harborEvent('eb-pier', 0);
        const ferry = harborEvent('eb-ferry', 4);
        const plainChunk = { hash: 7, text: 'A note about the harbor', metadata: { text: 'A note about the harbor', change_number: 6 } };
        backend.answer = changesAnswer({ points: [storedPoint(anchor), storedPoint(pier, 5), plainChunk, storedPoint(ferry)], cursor: 6 });

        const feed = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: null });

        expect(backend.asked).toEqual([{ collectionId: HARBOR_EVENTS, settings, page: { after: null, limit: 100 } }]);
        expect(feed).toEqual({
            supported: true,
            schemaVersion: EVENTBASE_SCHEMA_VERSION,
            events: [feedFieldsOf(ferry, 0), feedFieldsOf(anchor, 0), feedFieldsOf(pier, 5)],
            removedEventIds: [],
            emptied: false,
            cursor: 6,
            hasMore: false,
        });
    });

    it('gives a field as the payload holds it when an edit changed it there and not in the text', async () => {
        const pier = harborEvent('eb-pier', 0);
        const point = storedPoint(pier, 8);
        point.metadata.cause = 'A smuggler cut the lamp ropes';
        point.metadata.characters = ['Mara'];
        backend.answer = changesAnswer({ points: [point], cursor: 8 });

        const [event] = (await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 7 })).events;

        expect(event).toMatchObject({ cause: 'A smuggler cut the lamp ropes', characters: ['Mara'], result: pier.result });
    });

    it('reads back from its text what an older event\'s payload lacks, and its summary whatever keyword suffix the text carries', async () => {
        const older = harborEvent('eb-older', 2);
        const point = storedPoint(older);
        for (const field of ['cause', 'result', 'characters', 'locations', 'DateTime', 'scene_time']) delete point.metadata[field];
        const oneLine = { hash: 9, text: '[travel] Tobin rows to the lighthouse [KEYWORDS: oars]', metadata: { event_id: 'eb-one-line', importance: 3 } };
        backend.answer = changesAnswer({ points: [point, oneLine], cursor: 0 });

        const { events } = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: null });

        expect(events[0]).toEqual({
            event_id: 'eb-one-line', summary: 'Tobin rows to the lighthouse', cause: '', result: '', characters: [], locations: [],
            importance: 3, DateTime: null, scene_time: '', source_window_start: null, source_window_end: null, change_number: 0,
        });
        expect(events[1]).toEqual(feedFieldsOf(older, 0));
    });
});

describe('a read after a number', () => {
    it('gives the events written since in number order, the removals as event IDs once each, and whether more follow', async () => {
        const ferry = harborEvent('eb-ferry', 4);
        const storm = harborEvent('eb-storm', 6);
        backend.answer = changesAnswer({
            points: [storedPoint(ferry, 7), storedPoint(storm, 9)],
            removed: [
                { hash: 41002, event_id: 'eb-pier', change_number: 8 },
                { hash: 41002, event_id: 'eb-pier', change_number: 10 },
                { hash: 41003, event_id: 'eb-lantern', change_number: 11 },
                { hash: 41004, change_number: 12 },
            ],
            cursor: 11,
            hasMore: true,
        });

        const feed = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 6 });

        expect(backend.asked[0].page).toEqual({ after: 6, limit: 100 });
        expect(feed.events).toEqual([feedFieldsOf(ferry, 7), feedFieldsOf(storm, 9)]);
        expect(feed.removedEventIds).toEqual(['eb-pier', 'eb-lantern']);
        expect(feed).toMatchObject({ emptied: false, cursor: 11, hasMore: true });
    });

    it('loses no new event of a chat a summary shortened: numbers decide what is new, and positions are data', async () => {
        // The reader has read every event up to number 12, the last of them read from messages 9320 to 9329. A summary
        // then shortened the chat, so the next events come from messages near 3160, below every position read before.
        const afterSummary = harborEvent('eb-after-summary', 3158);
        const nextTurn = harborEvent('eb-next-turn', 3160);
        backend.answer = changesAnswer({ points: [storedPoint(afterSummary, 13), storedPoint(nextTurn, 14)], cursor: 14 });

        const feed = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 12 });

        expect(feed.events.map(event => [event.event_id, event.change_number, event.source_window_start])).toEqual([
            ['eb-after-summary', 13, 3158],
            ['eb-next-turn', 14, 3160],
        ]);
        expect(feed.cursor).toBe(14);
    });

    it('says the collection was emptied, with only what was written after it', async () => {
        const restored = harborEvent('eb-restored', 0);
        backend.answer = changesAnswer({ points: [storedPoint(restored, 12)], emptied: true, cursor: 12 });

        const feed = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 9 });

        expect(feed).toMatchObject({ emptied: true, events: [feedFieldsOf(restored, 12)], removedEventIds: [], cursor: 12 });
    });
});

describe('a read the feed cannot answer', () => {
    it('passes on that the backend keeps no change numbers, with its reason or a reason of its own', async () => {
        backend.answer = { supported: false, reason: 'Change numbers need Qdrant 1.8 or newer, and this Qdrant\'s version is 1.7.4.' };
        const withReason = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: null });
        backend.answer = { supported: false };
        const withoutReason = await readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: null });

        expect(withReason).toEqual({ supported: false, reason: 'Change numbers need Qdrant 1.8 or newer, and this Qdrant\'s version is 1.7.4.' });
        expect(withoutReason).toEqual({ supported: false, reason: 'The backend gave no reason.' });
    });

    it('throws for a read that failed, and for an answer with no cursor', async () => {
        backend.error = new Error('Qdrant not initialized');
        await expect(readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 3 })).rejects.toThrow('Qdrant not initialized');

        backend.error = null;
        backend.answer = { supported: true, points: [] };
        await expect(readEventFeed(settings, { collectionId: HARBOR_EVENTS, after: 3 })).rejects.toThrow('answered with no cursor');
    });
});
