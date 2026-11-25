/**
 * The EventBase feed (§5.3 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md): what changed in one EventBase
 * collection after a change number, which the public API's eventBase.listEvents answers from. Similharity gives every
 * point it writes to Qdrant a change number and records each removed event under the same counter, so a reader that
 * keeps the last number it read catches up on the events written and removed since, from any tab or device. A chat
 * position is an event's data, never the cursor: a summary that shortens the chat moves no number.
 *
 * Each event comes back with its stored fields, its summary, which only its text holds (insertEvents leaves it out of
 * the payload), and its change number in `change_number`: 0 for an event stored before numbers existed, which a full
 * read returns and a read after a number never does.
 */
import { readCollectionChanges, textWithoutKeywordSuffix } from '../vector-backend/index.js';
import { EVENTBASE_SCHEMA_VERSION, packTimelineSortKey, parseEmbedText } from './eventbase-schema.js';

/** How many changes, events written and events removed together, one page of the feed holds. */
const FEED_PAGE_SIZE = 100;

/** A text field as stored, '' when the field holds none. */
const textOf = value => (typeof value === 'string' ? value : '');

/** A list of words as stored, an empty list when the field holds none. */
const wordsOf = value => (Array.isArray(value) ? value.filter(word => typeof word === 'string') : []);

/** A whole number as stored, null when the field holds none. */
const wholeNumberOf = value => (Number.isSafeInteger(value) ? value : null);

/**
 * A feed event from a point the change route gave, with where it sits in the story for ordering: its stored fields,
 * those an older event's payload lacks read back from its text, and its summary from its text. Null for a point that
 * holds no event.
 * @param {{text?: string, metadata?: object}} point - As Similharity's change route gives it
 * @returns {{event: object, storyOrder: number}|null}
 */
function feedEventOf(point) {
    const payload = point?.metadata ?? {};
    if (typeof payload.event_id !== 'string' || !payload.event_id) return null;
    const fromText = parseEmbedText(textWithoutKeywordSuffix(point.text ?? payload.text));
    const stored = { ...fromText, ...payload };
    return {
        event: {
            event_id: payload.event_id,
            summary: textOf(fromText.summary),
            cause: textOf(stored.cause),
            result: textOf(stored.result),
            characters: wordsOf(stored.characters),
            locations: wordsOf(stored.locations),
            importance: Number.isFinite(stored.importance) ? stored.importance : null,
            DateTime: textOf(stored.DateTime) || null,
            scene_time: textOf(stored.scene_time),
            source_window_start: wholeNumberOf(stored.source_window_start),
            source_window_end: wholeNumberOf(stored.source_window_end),
            change_number: Number.isSafeInteger(payload.change_number) ? payload.change_number : 0,
        },
        storyOrder: packTimelineSortKey(stored.source_window_start, stored.window_event_order),
    };
}

/** Feed order: by change number, and those without one, stored before numbers existed, in story order. */
function byFeedOrder(first, second) {
    return first.event.change_number - second.event.change_number
        || first.storyOrder - second.storyOrder
        || first.event.event_id.localeCompare(second.event.event_id);
}

/**
 * What changed in an EventBase collection after a change number. With no number, a full read: every event the
 * collection holds, and as the cursor the highest number among its events and its recorded removals. With one, a page
 * of the events written and removed since, in number order; `emptied` when the collection was emptied since, with only
 * what came after that, and `hasMore` when another page follows from the cursor.
 * @param {object} settings - VectFox settings
 * @param {{collectionId: string, after: number|null}} read
 * @returns {Promise<{supported: false, reason: string}|{supported: true, schemaVersion: number, events: object[],
 *   removedEventIds: string[], emptied: boolean, cursor: number, hasMore: boolean}>}
 * @throws {Error} When the backend cannot be read, or answers with no cursor
 */
export async function readEventFeed(settings, { collectionId, after }) {
    const changes = await readCollectionChanges(collectionId, settings, { after, limit: FEED_PAGE_SIZE });
    if (!changes?.supported) return { supported: false, reason: textOf(changes?.reason) || 'The backend gave no reason.' };
    if (!Number.isSafeInteger(changes.cursor)) {
        throw new Error(`The change read of ${collectionId} answered with no cursor.`);
    }
    const events = (Array.isArray(changes.points) ? changes.points : [])
        .map(feedEventOf)
        .filter(Boolean)
        .sort(byFeedOrder)
        .map(({ event }) => event);
    const removedEventIds = (Array.isArray(changes.removed) ? changes.removed : [])
        .map(removal => removal?.event_id)
        .filter(eventId => typeof eventId === 'string' && eventId);
    return {
        supported: true,
        schemaVersion: EVENTBASE_SCHEMA_VERSION,
        events,
        removedEventIds: [...new Set(removedEventIds)],
        emptied: changes.emptied === true,
        cursor: changes.cursor,
        hasMore: changes.hasMore === true,
    };
}
