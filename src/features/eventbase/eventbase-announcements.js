/**
 * What EventBase tells the listeners src/index.js sets at start-up, the public API's, which send each on as a
 * `vectfox_eventbase_*` event: a run that ended, finished, stopped or failed; events removed from a collection; and
 * the collection the open chat uses, when that changes (followCollectionInUse in eventbase-chat-collections.js). A
 * whole collection purged is told by the vector backend's own listener (setPurgedCollectionListener). A listener that
 * throws is logged and never fails the work it hears of.
 */
import { log } from '../../sillytavern/log.js';

/** @type {{onRunEnded: Function|null, onEventsRemoved: Function|null, onCollectionInUseChanged: Function|null}} */
const listeners = { onRunEnded: null, onEventsRemoved: null, onCollectionInUseChanged: null };

/**
 * Sets the listeners told of EventBase's runs, removals and collection in use. One left out hears nothing.
 * @param {object} set
 * @param {(run: {collectionId: string, eventsAdded: number, windowsProcessed: number}) => void} [set.onRunEnded]
 * @param {(collectionId: string, eventIds: string[]|null) => void} [set.onEventsRemoved]
 * @param {(inUse: {chatId: string|null, collectionId: string|null}) => void} [set.onCollectionInUseChanged]
 */
export function setEventBaseListeners({ onRunEnded = null, onEventsRemoved = null, onCollectionInUseChanged = null } = {}) {
    Object.assign(listeners, { onRunEnded, onEventsRemoved, onCollectionInUseChanged });
}

/**
 * Calls one listener, if set; one that throws is logged.
 * @param {keyof listeners} name
 * @param {...unknown} args
 */
function tell(name, ...args) {
    const listener = listeners[name];
    if (!listener) return;
    try {
        listener(...args);
    } catch (error) {
        log.warn(`VectFox EventBase: the ${name} listener failed:`, error);
    }
}

/**
 * A run of EventBase ended, finished, stopped or failed.
 * @param {{collectionId: string, eventsAdded: number, windowsProcessed: number}} run - eventsAdded: the events it
 *   stored; windowsProcessed: the windows it read
 */
export function announceRunEnded(run) {
    tell('onRunEnded', run);
}

/**
 * Events were removed from a collection: their IDs, or null when the collection was emptied. A list with no ID says
 * nothing.
 * @param {string} collectionId
 * @param {string[]|null} eventIds
 */
export function announceEventsRemoved(collectionId, eventIds) {
    if (Array.isArray(eventIds) && eventIds.length === 0) return;
    tell('onEventsRemoved', collectionId, eventIds);
}

/**
 * The collection the open chat uses changed, or another chat opened.
 * @param {{chatId: string|null, collectionId: string|null}} inUse - chatId: the open chat's UUID, null with none
 *   open; collectionId: the collection it uses, null with none
 */
export function announceCollectionInUseChanged(inUse) {
    tell('onCollectionInUseChanged', inUse);
}
