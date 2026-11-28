/**
 * ============================================================================
 * EVENTBASE WRITE TURNS
 * ============================================================================
 * The two kinds of write to a collection's events that must never cross. A
 * text edit writes an event's whole point again, payload and all, from the
 * point as stored when it starts (writeEventText in eventbase-event-edits.js),
 * and StoryArc writes each event's links into that payload as `story_links`
 * (story-arc-links.js). A link written between the edit's read and its write
 * would be put back to what the read held. So, per collection, link writes go
 * on together, and a text edit goes alone: it waits for the link writes under
 * way, and the link writes that come while it runs wait for it. Text edits of
 * one collection go one at a time, in the order they came.
 *
 * Pure: no imports. The turns last as long as the page.
 * ============================================================================
 */

/**
 * Each collection's turn: the link writes under way, the call that tells the text edit waiting for them that they
 * ended, the text edit holding the collection (a promise that settles as it ends), and the end of the last text edit
 * queued.
 * @type {Map<string, {linkWrites: number, onLinkWritesEnded: (() => void)|null, textEdit: Promise<void>|null, lastTextEdit: Promise<void>}>}
 */
const turns = new Map();

function turnOf(collectionId) {
    let turn = turns.get(collectionId);
    if (!turn) {
        turn = { linkWrites: 0, onLinkWritesEnded: null, textEdit: null, lastTextEdit: Promise.resolve() };
        turns.set(collectionId, turn);
    }
    return turn;
}

/**
 * Run one StoryArc link write to a collection's event: beside the collection's other link writes, but never while a
 * text edit holds the collection, which it waits for.
 * @template T
 * @param {string} collectionId
 * @param {() => Promise<T>} write
 * @returns {Promise<T>} What the write answers; its failure is the caller's
 */
export async function inStoryLinkWriteTurn(collectionId, write) {
    const turn = turnOf(collectionId);
    while (turn.textEdit) await turn.textEdit;
    turn.linkWrites++;
    try {
        return await write();
    } finally {
        turn.linkWrites--;
        if (turn.linkWrites === 0) turn.onLinkWritesEnded?.();
    }
}

/**
 * Run a text edit of a collection's event alone: after the collection's text edits queued before it and the link
 * writes under way, while the link writes that come meanwhile wait for it.
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
        while (turn.linkWrites > 0) await new Promise(resolve => { turn.onLinkWritesEnded = resolve; });
        return await edit();
    } finally {
        turn.onLinkWritesEnded = null;
        turn.textEdit = null;
        endTurn();
    }
}
