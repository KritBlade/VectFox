/**
 * ============================================================================
 * EVENTBASE EVENT EDITS
 * ============================================================================
 * The one route for writing an edit of a collection's stored events, which the
 * Database Browser's Chunk Visualizer calls: an event's new text, embedded and
 * stored under the ID EventBase gives the event, and events deleted, the
 * windows they were read from kept read and their IDs told to EventBase's
 * listener. A changed payload field alone needs no route of its own:
 * updateChunkMetadata sets the fields it is given and keeps the rest.
 *
 * A new text writes the whole point again, payload and all, so it is built from
 * the point as stored at that moment, never from the copy the caller read, and
 * it takes its turn with StoryArc's link writes (eventbase-write-turns.js): a
 * link StoryArc wrote after the caller's read stays on the event.
 * ============================================================================
 */

import { deleteVectorItems, describeEmbeddingFailure, getChunk, insertVectorItems } from '../vector-backend/index.js';
import { getStringHash } from '../../sillytavern/identifiers.js';
import { announceEventsRemoved } from './eventbase-announcements.js';
import { eventPointHash, keepWindowsOfRemovedEvents } from './eventbase-store.js';
import { inTextEditTurn } from './eventbase-write-turns.js';

/**
 * The ID a point with this text is stored under: an EventBase event keeps the one EventBase gives it from its event
 * ID, so its new text replaces it in place and a later read of its window replaces it again, never adding a second
 * copy; a point without an event ID, such as an older collection's chunk, takes its ID from its text.
 * @param {object} payload
 * @param {string} text
 * @returns {number}
 */
function storedHashFor(payload, text) {
    const eventId = payload.event_id;
    return typeof eventId === 'string' && eventId !== '' ? eventPointHash(eventId) : getStringHash(text);
}

/**
 * Write a stored event's new text, embedded: its payload as stored now with the fields changed beside the text, under
 * the ID storedHashFor gives; then a copy under another ID goes. The new text goes in first, so a failed embedding
 * leaves the stored event as it was, and a later failure leaves both, never neither. It runs in its turn with the
 * collection's StoryArc link writes.
 *
 * @param {string} collectionId
 * @param {{hash: number|string, index: number}} event - The event as the caller read it: its point's hash, and its
 *   place in the collection
 * @param {{text: string, payload: object}} changes - text: the new text; payload: the fields changed with it
 * @param {object} settings - VectFox settings
 * @returns {Promise<{hash: number, metadata: object}>} The ID it is stored under now, and the payload stored with it
 * @throws {Error} When it cannot be read as stored now, and then nothing is written; when its new text cannot be
 *   embedded, the error carrying `embeddingFailure` (describeEmbeddingFailure's reading of it); or when its old copy
 *   cannot be deleted, the error carrying `saved`, what was written
 */
export function writeEventText(collectionId, event, { text, payload }, settings) {
    return inTextEditTurn(collectionId, async () => {
        const stored = await getChunk(collectionId, event.hash, settings);
        if (!stored) throw new Error('it could not be read from the collection as stored now (another edit or a delete may have replaced it), so nothing was written');
        const metadata = { ...stored.metadata, ...payload };
        for (const field of ['hash', 'text']) delete metadata[field];
        const hash = storedHashFor(metadata, text);
        try {
            await insertVectorItems(collectionId, [{ hash, text, index: event.index, metadata }], settings);
        } catch (error) {
            throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), { embeddingFailure: describeEmbeddingFailure(error) });
        }
        const saved = { hash, metadata };
        if (String(hash) !== String(event.hash)) {
            try {
                await deleteVectorItems(collectionId, [event.hash], settings);
            } catch (error) {
                throw Object.assign(new Error(`the new text is saved, but the old copy is still in the collection: ${error.message}`, { cause: error }), { saved });
            }
        }
        return saved;
    });
}

/**
 * Delete stored events, and any other points listed with them. The windows the events among them were read from stay
 * read, on the collection's record, so the next Catch up does not write their events again, and their IDs go to
 * EventBase's listener once they are gone.
 *
 * @param {string} collectionId
 * @param {Array<{hash: number|string, metadata?: object}>} points - Each point's hash, and its payload as read
 * @param {object} settings - VectFox settings
 * @returns {Promise<void>}
 * @throws {Error} When the delete does not get through, and then nothing else changes
 */
export async function deleteEventPoints(collectionId, points, settings) {
    await deleteVectorItems(collectionId, points.map(point => point.hash), settings);
    keepWindowsOfRemovedEvents(collectionId, points.map(point => point.metadata ?? {}), settings);
    const eventIds = points.map(point => point.metadata?.event_id).filter(eventId => typeof eventId === 'string' && eventId !== '');
    announceEventsRemoved(collectionId, eventIds);
}
