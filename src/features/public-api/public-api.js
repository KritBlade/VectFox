/**
 * Publishes the `VectFox` object other extensions call (§4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md),
 * answers its calls and emits its events on SillyTavern's eventSource. src/index.js publishes the object when it is
 * evaluated, so it exists before VectFox's initialization ends, and announces readiness when that ends, handing over
 * the settings store the calls answer from (§5.2): until then every call answers `not-ready`. `eventBase.listEvents`
 * reads EventBase's feed, the events written and removed after a change number (§5.3). `chat.registerMessageSource`
 * keeps the message sources story order asks about each message it reads (§5.4), which src/index.js hands
 * src/shared/chat-messages.js as askMessageSources. It also hands the other features' listeners the announcements
 * below, which send EventBase's runs, removals and collection in use, and each LLM call, on as `vectfox_*` events, and
 * the LLM calls the marker that marks their requests while the PublicAPI page's switch is on. VectFox never awaits its
 * own events: SillyTavern's emit awaits each listener in turn, so a listener that never resolves would hold VectFox up.
 */
import { eventSource } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { COLLECTION_TYPES, getChatUUID, parseCollectionId } from '../../shared/collection-ids.js';
import { loadExtensionManifest } from '../../shared/extension-manifest.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { openChatCollectionInUse, readEventFeed } from '../eventbase/index.js';
import {
    PUBLIC_API_REASONS, PUBLIC_EVENTS, buildPublicApi, chatIdAnswer, collectionInUseAnswer, createReadiness,
    eventBaseCollectionChangedPayload, eventBaseEventsDeletedPayload, eventBaseSyncedPayload, eventFeedAnswer,
    isOwnRequestMarkOn, isPublicEventName, llmCallFinishedPayload, markOwnRequest, messageSourceAnswerOf, readyPayload,
    refusal, settingsSnapshotAnswer,
} from './public-api-core.js';

const readiness = createReadiness();

/** The manifest's version, once start-up has read it. */
let extensionVersion = null;

/** VectFox's settings, the store itself, handed over as start-up ends, before VectFox turns ready. */
let settingsStore = null;

/**
 * The message sources other extensions registered, in the order they did (§5.4), each with what the console was
 * already told of it.
 * @type {Array<{owner: string, originalsOf: Function, problemsSaid: Set<string>}>}
 */
const messageSources = [];

/**
 * `chat.getChatId()`: the ID VectFox keys the open chat's EventBase collections by.
 * @returns {Readonly<object>} `{ ok: true, chatId }`, or a refusal with `not-ready` or `no-chat`
 */
function getChatId() {
    if (!readiness.isReady()) return refusal(PUBLIC_API_REASONS.notReady);
    return chatIdAnswer(getChatUUID() ?? null);
}

/**
 * `chat.getCollectionInUse()`: the collection the open chat uses, from the route VectFox's own readers ask.
 * @returns {Readonly<object>} `{ ok: true, collectionId }`, or a refusal with `not-ready`, `no-chat` or `no-collection`
 */
function getCollectionInUse() {
    if (!readiness.isReady()) return refusal(PUBLIC_API_REASONS.notReady);
    return collectionInUseAnswer(openChatCollectionInUse(settingsStore));
}

/**
 * `chat.registerMessageSource()`: a function VectFox asks about each message it reads in story order, which tells it
 * the messages a summary stands for (§5.4). It counts from VectFox's next read, ready or not, and keeps counting until
 * its unregister is called.
 * @param {{owner: string, originalsOf: (message: object, asked: {chatMetadata: object}) => (object[]|null)}} source -
 *   owner: who registered it, as the console names it; originalsOf: null for an ordinary message, else the messages
 *   the summary stands for, none for a summary of messages still in the chat or of none
 * @returns {() => void} Its own unregister
 * @throws {TypeError} When the source cannot be right, a bug in the calling code
 */
function registerMessageSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new TypeError('VectFox.chat.registerMessageSource(): pass an object, { owner, originalsOf }');
    }
    const { owner, originalsOf } = source;
    if (typeof owner !== 'string' || !owner.trim()) {
        throw new TypeError('VectFox.chat.registerMessageSource(): owner must name your extension, as the console names it when your source fails');
    }
    if (typeof originalsOf !== 'function') {
        throw new TypeError(`VectFox.chat.registerMessageSource(): ${owner}'s originalsOf is not a function`);
    }
    const registered = { owner, originalsOf, problemsSaid: new Set() };
    messageSources.push(registered);
    return () => {
        const index = messageSources.indexOf(registered);
        if (index > -1) messageSources.splice(index, 1);
    };
}

/**
 * Says once in the console, for a source and a kind of problem, that it gave no answer for a message. Once, as the
 * source is asked about every message on every read: each failure after the first would repeat the same line.
 * @param {{owner: string, problemsSaid: Set<string>}} source
 * @param {string} problem - What it did, the same text for the same kind of problem
 * @param {unknown} [error] - What it threw
 */
function sayMessageSourceProblemOnce(source, problem, error) {
    if (source.problemsSaid.has(problem)) return;
    source.problemsSaid.add(problem);
    const said = `VectFox public API: ${source.owner} hook failed: its message source ${problem}, so VectFox reads that message as an ordinary one`;
    if (error === undefined) log.warn(said);
    else log.warn(`${said}:`, error);
}

/**
 * What the registered message sources answer for one message, for story order (src/shared/chat-messages.js, which
 * src/index.js hands this): each source in the order it registered, until one answers for it as a summary. A source
 * that throws, or answers anything but null or a list of messages, counts as answering null, and the console says so
 * once for each source and kind of problem.
 * @param {object} message - A message of the chat, or one a summary stands for
 * @param {{chatMetadata: object}} asked - The chat's metadata as it is now
 * @returns {{owner: string, originals: object[]}|null} The owner of the source that answered and the messages the
 *   summary stands for, or null for an ordinary message
 */
export function askMessageSources(message, asked) {
    for (const source of messageSources) {
        let answer;
        try {
            answer = source.originalsOf(message, asked);
        } catch (error) {
            sayMessageSourceProblemOnce(source, 'threw', error);
            continue;
        }
        const read = messageSourceAnswerOf(answer);
        if ('problem' in read) {
            sayMessageSourceProblemOnce(source, read.problem);
            continue;
        }
        if (read.originals) return { owner: source.owner, originals: read.originals };
    }
    return null;
}

/**
 * `getSettingsSnapshot()`: whether VectFox is switched on, by the gate every runtime check reads, the listed settings
 * as they are now, and whether VectFox marks its LLM calls' requests, as the marker reads the switch.
 * @returns {Readonly<object>} `{ ok: true, settings }`, or a refusal with `not-ready`
 */
function getSettingsSnapshot() {
    if (!readiness.isReady()) return refusal(PUBLIC_API_REASONS.notReady);
    return settingsSnapshotAnswer(settingsStore, { isEnabled: isVectFoxEnabled(settingsStore) });
}

/**
 * What `eventBase.listEvents()` was asked: each part optional, null when left out.
 * @param {unknown} request
 * @returns {{chatId: string|null, collectionId: string|null, after: number|null}}
 * @throws {TypeError} When the call cannot be right, a bug in the calling code
 */
function listEventsRequestOf(request) {
    if (request === undefined) return { chatId: null, collectionId: null, after: null };
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('VectFox.eventBase.listEvents(): pass an object, { chatId, collectionId, after }, each part optional');
    }
    const { chatId = null, collectionId = null, after = null } = request;
    if (chatId !== null && (typeof chatId !== 'string' || !chatId)) {
        throw new TypeError('VectFox.eventBase.listEvents(): chatId must be a chat\'s ID, as chat.getChatId() gives it');
    }
    if (collectionId !== null && !isEventBaseCollection(collectionId)) {
        throw new TypeError(`VectFox.eventBase.listEvents(): '${String(collectionId)}' is not the ID of an EventBase collection`);
    }
    if (after !== null && !(Number.isSafeInteger(after) && after >= 0)) {
        throw new TypeError('VectFox.eventBase.listEvents(): after must be a cursor a read gave, a whole number of 0 or more, or left out for a full read');
    }
    return { chatId, collectionId, after };
}

/**
 * `eventBase.listEvents()`: what changed in one EventBase collection after a change number, or with none every event it
 * holds (§5.3). It reads the collection named, or the one the open chat uses; a `chatId` given is the chat the read
 * must be about: the named collection's, or the open one.
 * @param {{chatId?: string, collectionId?: string, after?: number}} [request]
 * @returns {Promise<Readonly<object>>} The feed's answer (eventFeedAnswer), or a refusal with `not-ready`, `no-chat`,
 *   `no-collection`, `backend-unsupported` or `read-failed`
 * @throws {TypeError} When the request cannot be right, as a rejection
 */
async function listEvents(request) {
    const { chatId, collectionId, after } = listEventsRequestOf(request);
    if (!readiness.isReady()) return refusal(PUBLIC_API_REASONS.notReady);
    let target = collectionId;
    if (target) {
        if (chatId && chatIdOfCollection(target) !== chatId) return refusal(PUBLIC_API_REASONS.noCollection);
    } else {
        const inUse = openChatCollectionInUse(settingsStore);
        if (!inUse.chatId || (chatId && chatId !== inUse.chatId)) return refusal(PUBLIC_API_REASONS.noChat);
        if (!inUse.collectionId) return refusal(PUBLIC_API_REASONS.noCollection);
        target = inUse.collectionId;
    }
    let feed;
    try {
        feed = await readEventFeed(settingsStore, { collectionId: target, after });
    } catch (error) {
        log.warn(`VectFox public API: listEvents could not read ${target}, so it answers read-failed:`, error);
        return refusal(PUBLIC_API_REASONS.readFailed);
    }
    if (!feed.supported) {
        log.verbose(`VectFox public API: listEvents answers backend-unsupported for ${target}: ${feed.reason}`);
        return refusal(PUBLIC_API_REASONS.backendUnsupported);
    }
    return eventFeedAnswer({ collectionId: target, ...feed });
}

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
    globalThis.VectFox = buildPublicApi({
        readiness, readExtensionVersion: () => extensionVersion, on, off, chat: { getChatId, getCollectionInUse, registerMessageSource },
        getSettingsSnapshot, eventBase: { listEvents },
    });
}

/**
 * Marks VectFox ready once its initialization has ended, and emits `vectfox_ready` once. Keeps the settings store the
 * calls answer from, and reads the manifest's version first, so both are set when a consumer hears of readiness; a
 * manifest that cannot be read leaves `extensionVersion` null.
 * @param {object} settings - VectFox settings, the store itself
 * @returns {Promise<void>}
 */
export async function announcePublicApiReady(settings) {
    settingsStore = settings;
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

/**
 * The marker llm-provider runs on the signal of each LLM call's request (`setOwnRequestMarker`): writes VectFox's mark
 * while the PublicAPI page's switch, `own_request_mark_enabled`, is on. Off by default, as only a usage tracker reads
 * the mark. Read from the settings store at each call, so a change counts from the next call, and a call before VectFox
 * is ready goes unmarked.
 * @param {AbortSignal} signal - The signal the request is sent with
 * @param {string} feature - The feature the call is made for
 */
export function markOwnRequestWhenSwitchedOn(signal, feature) {
    if (isOwnRequestMarkOn(settingsStore)) markOwnRequest(signal, feature);
}
