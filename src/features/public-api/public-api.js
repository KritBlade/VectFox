/**
 * Publishes the `VectFox` object other extensions call (§4 of InternalProject/Vectfox/plans/vectfox-public-api.md) and
 * emits its events on SillyTavern's eventSource. src/index.js publishes the object when it is evaluated, so it exists
 * before VectFox's initialization ends, and announces readiness when that ends. It also hands the other features'
 * listeners the announcements below, which send EventBase's runs, removals and collection in use, and each LLM call,
 * on as `vectfox_*` events. VectFox never awaits its own events: SillyTavern's emit awaits each listener in turn, so a
 * listener that never resolves would hold VectFox up.
 */
import { eventSource } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { COLLECTION_TYPES, parseCollectionId } from '../../shared/collection-ids.js';
import { loadExtensionManifest } from '../../shared/extension-manifest.js';
import {
    PUBLIC_EVENTS, buildPublicApi, createReadiness, eventBaseCollectionChangedPayload, eventBaseEventsDeletedPayload,
    eventBaseSyncedPayload, isPublicEventName, llmCallFinishedPayload, readyPayload,
} from './public-api-core.js';

const readiness = createReadiness();

/** The manifest's version, once start-up has read it. */
let extensionVersion = null;

/**
 * Stops calling a handler for an event.
 * @param {string} name - The event's name
 * @param {Function} handler - The handler `on` was given
 */
function off(name, handler) {
    eventSource.removeListener(name, handler);
}

/**
 * Calls a handler each time VectFox emits an event. An event this VectFox does not emit subscribes nothing and says so
 * in the console, as a consumer written for a newer API may ask for it.
 * @param {string} name - The event's name, such as `vectfox_ready`
 * @param {Function} handler - Called with the event's payload
 * @returns {() => void} Its own unsubscribe
 * @throws {TypeError} When the handler is not a function
 */
function on(name, handler) {
    if (typeof handler !== 'function') throw new TypeError(`VectFox.on('${name}'): the handler is not a function`);
    if (!isPublicEventName(name)) {
        log.warn(`VectFox public API: on() was given '${name}', which this VectFox does not emit, so nothing is subscribed. It emits: ${Object.values(PUBLIC_EVENTS).join(', ')}`);
        return () => {};
    }
    eventSource.on(name, handler);
    return () => off(name, handler);
}

/**
 * Emits one of VectFox's events without waiting for its listeners.
 * @param {string} name
 * @param {object} payload
 */
function emitWithoutWaiting(name, payload) {
    eventSource.emit(name, payload).catch(error => log.warn(`VectFox public API: emitting ${name} failed:`, error));
}

/**
 * Sets `globalThis.VectFox`. Called once, when src/index.js is evaluated.
 */
export function publishPublicApi() {
    if (globalThis.VectFox) log.warn('VectFox public API: globalThis.VectFox was already set, by another copy of VectFox loaded in this page; this copy replaces it');
    globalThis.VectFox = buildPublicApi({ readiness, readExtensionVersion: () => extensionVersion, on, off });
}

/**
 * Marks VectFox ready once its initialization has ended, and emits `vectfox_ready` once. Reads the manifest's version
 * first, so `extensionVersion` is set when a consumer hears of readiness; a manifest that cannot be read leaves it
 * null.
 * @returns {Promise<void>}
 */
export async function announcePublicApiReady() {
    try {
        extensionVersion = (await loadExtensionManifest()).version ?? null;
    } catch (error) {
        log.warn('VectFox public API: manifest.json could not be read, so VectFox.extensionVersion stays null:', error);
    }
    if (!readiness.markReady()) return;
    emitWithoutWaiting(PUBLIC_EVENTS.ready, readyPayload());
}

/**
 * Whether a collection holds EventBase events: a chat's, or an archive's.
 * @param {string} collectionId
 * @returns {boolean}
 */
function isEventBaseCollection(collectionId) {
    const { type } = parseCollectionId(collectionId);
    return type === COLLECTION_TYPES.CHAT || type === COLLECTION_TYPES.ARCHIVE_EVENT;
}

/**
 * The chat an EventBase collection belongs to: the chat UUID its ID holds, an archive's own UUID for an archive's.
 * @param {string} collectionId
 * @returns {string|null}
 */
function chatIdOfCollection(collectionId) {
    return parseCollectionId(collectionId).chatUUID ?? null;
}

/**
 * Sends `vectfox_eventbase_synced`: an EventBase run ended, finished, stopped or failed.
 * @param {{collectionId: string, eventsAdded: number, windowsProcessed: number}} run
 */
export function announceEventBaseRunEnded({ collectionId, eventsAdded, windowsProcessed }) {
    emitWithoutWaiting(PUBLIC_EVENTS.eventBaseSynced, eventBaseSyncedPayload({
        chatId: chatIdOfCollection(collectionId), collectionId, eventsAdded, windowsProcessed,
    }));
}

/**
 * Sends `vectfox_eventbase_events_deleted` for events removed from an EventBase collection. A collection of another
 * kind, such as LoreBase's, sends nothing.
 * @param {string} collectionId
 * @param {string[]|null} eventIds - null when the whole collection was emptied
 */
export function announceEventBaseEventsRemoved(collectionId, eventIds) {
    if (!isEventBaseCollection(collectionId)) return;
    emitWithoutWaiting(PUBLIC_EVENTS.eventBaseEventsDeleted, eventBaseEventsDeletedPayload({
        chatId: chatIdOfCollection(collectionId), collectionId, eventIds,
    }));
}

/**
 * A collection was purged: an EventBase one is announced as emptied.
 * @param {string} collectionId
 */
export function announcePurgedCollection(collectionId) {
    announceEventBaseEventsRemoved(collectionId, null);
}

/**
 * Sends `vectfox_eventbase_collection_changed`: the collection the open chat uses changed, or another chat opened.
 * @param {{chatId: string|null, collectionId: string|null}} inUse
 */
export function announceCollectionInUseChanged(inUse) {
    emitWithoutWaiting(PUBLIC_EVENTS.eventBaseCollectionChanged, eventBaseCollectionChangedPayload(inUse));
}

/**
 * Sends `vectfox_llm_call_finished`: one of VectFox's LLM calls ended.
 * @param {object} call - As llm-provider reports it (llm-call-report.js)
 */
export function announceLlmCallFinished(call) {
    emitWithoutWaiting(PUBLIC_EVENTS.llmCallFinished, llmCallFinishedPayload(call));
}
