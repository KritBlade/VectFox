/**
 * ============================================================================
 * EVENTBASE EVENT EDITS
 * ============================================================================
 * The one route for writing an edit of a collection's stored events, which the
 * Database Browser's Chunk Visualizer and the public API call: an event's new
 * text, embedded and stored under the ID EventBase gives the event; an event's
 * changed fields, named by its event ID, its text built again from them; and
 * events deleted, the windows they were read from kept read and their IDs told
 * to EventBase's listener. A field its text does not hold, such as importance,
 * is written alone (writeStoredFields), with no embedding.
 *
 * A new text writes the whole point again, payload and all, so it is built from
 * the point as stored at that moment, never from the copy the caller read, and
 * it takes its turn with the collection's field writes (eventbase-write-turns.js):
 * a StoryArc link or a field written after the caller's read stays on the event.
 * ============================================================================
 */

import { deleteVectorItems, describeEmbeddingFailure, getChunk, insertVectorItems, textWithoutKeywordSuffix } from '../vector-backend/index.js';
import { getStringHash } from '../../sillytavern/identifiers.js';
import { announceEventsRemoved } from './eventbase-announcements.js';
import { buildEmbedText, parseEmbedText } from './eventbase-schema.js';
import { eventPointHash, keepWindowsOfRemovedEvents } from './eventbase-store.js';
import { inTextEditTurn, writeStoredFields } from './eventbase-write-turns.js';

/** The fields of an edit that only an event's payload holds: every other one is in its text too (buildEmbedText). */
const PAYLOAD_ONLY_FIELDS = new Set(['importance']);

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
 * Write a stored point's new text, embedded, in the collection's text edit turn: its payload as stored now with the
 * fields changed beside the text, under the ID storedHashFor gives; then a copy under another ID goes. The new text
 * goes in first, so a failed embedding leaves the stored point as it was, and a later failure leaves both, never
 * neither.
 *
 * @param {string} collectionId
 * @param {{hash: number|string, index?: number}} point - The point's hash, and its place in the collection when the
 *   caller read it
 * @param {(stored: {text?: string, metadata: object}) => ({text: string, payload: object}|null)} editOf - The new text
 *   and the payload fields changed with it, from the point as stored now; null writes nothing
 * @param {object} settings - VectFox settings
 * @returns {Promise<{hash: number, metadata: object}|null>} The ID it is stored under now, and the payload stored with
 *   it; null when no point of that hash is stored, or editOf wrote nothing
 * @throws {Error} When its new text cannot be embedded, the error carrying `embeddingFailure` (describeEmbeddingFailure's
 *   reading of it); or when its old copy cannot be deleted, the error carrying `saved`, what was written
 */
function writeStoredText(collectionId, point, editOf, settings) {
    return inTextEditTurn(collectionId, async () => {
        const stored = await getChunk(collectionId, point.hash, settings);
        const edit = stored ? editOf(stored) : null;
        if (!edit) return null;
        const metadata = { ...stored.metadata, ...edit.payload };
        for (const field of ['hash', 'text']) delete metadata[field];
        const hash = storedHashFor(metadata, edit.text);
        try {
            await insertVectorItems(collectionId, [{ hash, text: edit.text, index: point.index, metadata }], settings);
        } catch (error) {
            throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), { embeddingFailure: describeEmbeddingFailure(error) });
        }
        const saved = { hash, metadata };
        if (String(hash) !== String(point.hash)) {
            try {
                await deleteVectorItems(collectionId, [point.hash], settings);
            } catch (error) {
                throw Object.assign(new Error(`the new text is saved, but the old copy is still in the collection: ${error.message}`, { cause: error }), { saved });
            }
        }
        return saved;
    });
}

/**
 * Write a stored event's new text, embedded, from the event as stored now with the fields changed beside the text
 * (writeStoredText), as the Chunk Visualizer's Save does.
 *
 * @param {string} collectionId
 * @param {{hash: number|string, index: number}} event - The event as the caller read it: its point's hash, and its
 *   place in the collection
 * @param {{text: string, payload: object}} changes - text: the new text; payload: the fields changed with it
 * @param {object} settings - VectFox settings
 * @returns {Promise<{hash: number, metadata: object}>} The ID it is stored under now, and the payload stored with it
 * @throws {Error} When it cannot be read as stored now, and then nothing is written; or as writeStoredText throws
 */
export async function writeEventText(collectionId, event, { text, payload }, settings) {
    const saved = await writeStoredText(collectionId, event, () => ({ text, payload }), settings);
    if (!saved) throw new Error('it could not be read from the collection as stored now (another edit or a delete may have replaced it), so nothing was written');
    return saved;
}

/**
 * An event's fields as a stored point holds them: its payload, the fields an older event's payload lacks read back
 * from its text, and its summary, which only its text holds (insertEvents leaves it out of the payload), as the
 * EventBase feed reads them.
 * @param {{text?: string, metadata: object}} stored
 * @returns {object}
 */
function storedEventOf(stored) {
    const fromText = parseEmbedText(textWithoutKeywordSuffix(stored.text ?? stored.metadata.text));
    return { ...fromText, ...stored.metadata, summary: fromText.summary ?? '' };
}

/**
 * Read a stored event by its event ID, from the point EventBase stores it under (eventPointHash).
 * @param {string} collectionId
 * @param {string} eventId
 * @param {object} settings - VectFox settings
 * @returns {Promise<{hash: number, text?: string, metadata: object}|null>} null when that point holds no event of
 *   this ID
 */
async function readEventPoint(collectionId, eventId, settings) {
    const hash = eventPointHash(eventId);
    const stored = await getChunk(collectionId, hash, settings);
    return stored?.metadata?.event_id === eventId ? { ...stored, hash } : null;
}

/**
 * Read stored events by their event IDs, for a caller that names events it has not listed, as the public API's
 * deleteEvents does.
 * @param {string} collectionId
 * @param {string[]} eventIds
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array<{hash: number, summary: string, metadata: object}|null>>} One for each ID, in their order,
 *   null for an ID no stored event holds
 * @throws {Error} When the collection cannot be read
 */
export function readEventsById(collectionId, eventIds, settings) {
    return Promise.all(eventIds.map(async (eventId) => {
        const point = await readEventPoint(collectionId, eventId, settings);
        return point ? { hash: point.hash, summary: storedEventOf(point).summary, metadata: point.metadata } : null;
    }));
}

/**
 * Write changed fields of a stored event, named by its event ID. A field its text holds builds that text again
 * (buildEmbedText) from the event as stored now with the changes, and embeds it in place under the event's own ID
 * (writeStoredText); importance alone sets that payload field, with no embedding (writeStoredFields).
 *
 * @param {string} collectionId
 * @param {string} eventId
 * @param {object} fields - The changed fields by their stored names: any of summary, cause, result, characters,
 *   locations, importance, DateTime and scene_time
 * @param {object} settings - VectFox settings
 * @returns {Promise<boolean>} false when the collection holds no event of this ID, and then nothing is written
 * @throws {Error} When the write does not get through, as writeStoredText and writeStoredFields throw
 */
export async function writeEventFields(collectionId, eventId, fields, settings) {
    if (Object.keys(fields).every(field => PAYLOAD_ONLY_FIELDS.has(field))) {
        const point = await readEventPoint(collectionId, eventId, settings);
        if (!point) return false;
        await writeStoredFields(collectionId, point.hash, fields, settings);
        return true;
    }
    const { summary: _summaryInText, ...payload } = fields;
    const saved = await writeStoredText(collectionId, { hash: eventPointHash(eventId) }, (stored) => {
        if (stored.metadata?.event_id !== eventId) return null;
        return { text: buildEmbedText({ ...storedEventOf(stored), ...fields }), payload };
    }, settings);
    return saved !== null;
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
