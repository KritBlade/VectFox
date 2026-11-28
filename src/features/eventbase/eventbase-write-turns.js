/**
 * ============================================================================
 * EVENTBASE WRITE TURNS
 * ============================================================================
 * The two kinds of write to a collection's events that must never cross. A
 * text edit writes an event's whole point again, payload and all, from the
 * point as stored when it starts (eventbase-event-edits.js). A field write sets
 * some of a point's payload fields and keeps the rest (writeStoredFields):
 * StoryArc's links (`story_links`), an event's importance, a field the Chunk
 * Visualizer saves alone. A field written between a text edit's read and its
 * write would be put back to what the read held. So, per collection, field
 * writes go on together, and a text edit goes alone: it waits for the field
 * writes under way, and the field writes that come while it runs wait for it.
 * Text edits of one collection go one at a time, in the order they came.
 *
 * The turns last as long as the page, and hold within it only.
 * ============================================================================
 */

import { updateChunkMetadata } from '../vector-backend/index.js';

/**
 * Each collection's turn: the field writes under way, the call that tells the text edit waiting for them that they
 * ended, the text edit holding the collection (a promise that settles as it ends), and the end of the last text edit
 * queued.
 * @type {Map<string, {fieldWrites: number, onFieldWritesEnded: (() => void)|null, textEdit: Promise<void>|null, lastTextEdit: Promise<void>}>}
 */
const turns = new Map();

function turnOf(collectionId) {
    let turn = turns.get(collectionId);
    if (!turn) {
        turn = { fieldWrites: 0, onFieldWritesEnded: null, textEdit: null, lastTextEdit: Promise.resolve() };
        turns.set(collectionId, turn);
    }
    return turn;
}

/**
 * Run one field write to a collection's point: beside the collection's other field writes, but never while a text
 * edit holds the collection, which it waits for.
 * @template T
 * @param {string} collectionId
 * @param {() => Promise<T>} write
 * @returns {Promise<T>} What the write answers; its failure is the caller's
 */
export async function inFieldWriteTurn(collectionId, write) {
    const turn = turnOf(collectionId);
    while (turn.textEdit) await turn.textEdit;
    turn.fieldWrites++;
    try {
        return await write();
    } finally {
        turn.fieldWrites--;
        if (turn.fieldWrites === 0) turn.onFieldWritesEnded?.();
    }
}

/**
 * Set fields of a stored point's payload and keep the rest (Similharity's payload route), in the collection's field
 * write turn. The one way VectFox writes a field of a stored event alone.
 * @param {string} collectionId
 * @param {number|string} hash - The point's hash
 * @param {object} fields - The payload fields to set, by their stored names
 * @param {object} settings - VectFox settings
 * @returns {Promise<unknown>} What the backend answers
 * @throws {Error} When the write does not get through
 */
export function writeStoredFields(collectionId, hash, fields, settings) {
    return inFieldWriteTurn(collectionId, () => updateChunkMetadata(collectionId, hash, fields, settings));
}

/**
 * Run a text edit of a collection's event alone: after the collection's text edits queued before it and the field
 * writes under way, while the field writes that come meanwhile wait for it.
 * @template T
 * @param {string} collectionId
 * @param {() => Promise<T>} edit
 * @returns {Promise<T>} What the edit answers; its failure is the caller's, and ends its turn all the same
 */
export async function inTextEditTurn(collectionId, edit) {
    const turn = turnOf(collectionId);
    const queuedBefore = turn.lastTextEdit;
    let endTurn;
    const ended = new Promise(resolve => { endTurn = resolve; });
    turn.lastTextEdit = ended;
    await queuedBefore;
    turn.textEdit = ended;
    try {
        while (turn.fieldWrites > 0) await new Promise(resolve => { turn.onFieldWritesEnded = resolve; });
        return await edit();
    } finally {
        turn.onFieldWritesEnded = null;
        turn.textEdit = null;
        endTurn();
    }
}
