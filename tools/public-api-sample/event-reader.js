/**
 * An EventBase reader for VectFox's public API: the worked example of the Reading EventBase section of VectFox's
 * developer page (Doc/public-api.md). It keeps the events of each EventBase collection it has read, with one cursor per
 * collection, and catches up when VectFox says a run ended, events were removed, or the chat moved to another
 * collection. It uses only the VectFox object and SillyTavern's eventSource, so it can go in any extension.
 */

/**
 * What the reader keeps of each collection it has read: the cursor its last read stopped at, undefined before its
 * first read, and its events by ID.
 * @type {Map<string, {cursor: number|undefined, events: Map<string, object>}>}
 */
const collections = new Map();

/** Each collection's last read, so the next one waits for it and every change is read once, in order. */
const lastReads = new Map();

/**
 * Reads one collection's changes from its cursor, page after page, until there are no more. Its first read has no
 * cursor, as only a full read gives the events stored before change numbers existed.
 * @param {object} VectFox - The VectFox object
 * @param {string} collectionId
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>} A no leaves what the reader keeps as it was
 */
async function readChanges(VectFox, collectionId) {
    if (!collections.has(collectionId)) collections.set(collectionId, { cursor: undefined, events: new Map() });
    const kept = collections.get(collectionId);
    let answer;
    do {
        answer = await VectFox.eventBase.listEvents({ collectionId, after: kept.cursor });
        if (!answer.ok) return answer;
        if (answer.emptied) kept.events.clear();
        for (const eventId of answer.removedEventIds) kept.events.delete(eventId);
        for (const event of answer.events) kept.events.set(event.eventId, event);
        kept.cursor = answer.cursor;
    } while (answer.hasMore);
    return { ok: true };
}

/**
 * Catches up with one collection once its last read has ended: two events close together never read the same changes
 * twice, or apply them out of order.
 * @param {object} VectFox - The VectFox object
 * @param {string} collectionId
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
export function catchUpWith(VectFox, collectionId) {
    const readAfterLast = () => readChanges(VectFox, collectionId);
    const read = (lastReads.get(collectionId) ?? Promise.resolve()).then(readAfterLast, readAfterLast);
    lastReads.set(collectionId, read);
    return read;
}

/**
 * Starts the reader: it reads the collection the open chat uses, then catches up whenever the chat moves to another
 * collection, an EventBase run ends, or events are removed. It works whether its extension loads before VectFox or
 * after it. The handlers start each read without returning it, so they hold up no other extension listening.
 */
export function startEventReader() {
    const start = (VectFox) => {
        if (!VectFox.capabilities.includes('eventbase.read')) return;
        const inUse = VectFox.chat.getCollectionInUse();
        if (inUse.ok) catchUpWith(VectFox, inUse.collectionId);
        VectFox.on('vectfox_eventbase_collection_changed', ({ collectionId }) => { if (collectionId) catchUpWith(VectFox, collectionId); });
        VectFox.on('vectfox_eventbase_synced', ({ collectionId }) => { catchUpWith(VectFox, collectionId); });
        VectFox.on('vectfox_eventbase_events_deleted', ({ collectionId }) => { catchUpWith(VectFox, collectionId); });
    };
    if (globalThis.VectFox?.isReady()) {
        start(globalThis.VectFox);
    } else {
        SillyTavern.getContext().eventSource.on('vectfox_ready', () => start(globalThis.VectFox));
    }
}

/**
 * What the reader keeps now: for each collection it has read, its cursor and its events, by ID.
 * @returns {Record<string, {cursor: number|undefined, events: object[]}>}
 */
export function eventReaderState() {
    return Object.fromEntries([...collections].map(([collectionId, kept]) => [collectionId, { cursor: kept.cursor, events: [...kept.events.values()] }]));
}
