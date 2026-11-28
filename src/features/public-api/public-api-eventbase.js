/**
 * The `eventBase` group of the `VectFox` object: the feed of a collection's events and removals (§5.3 of
 * InternalProject/Vectfox/plans/executed/vectfox-public-api.md), the open chat's collections, and an event's edit and
 * delete (§3.3 and §4.3 of InternalProject/Vectfox/plans/public-api-writes.md). Each write waits on the user's answer
 * (public-api-questions-core.js), then goes through EventBase's route for an edit of its events, the one the Chunk
 * Visualizer calls, so the feed gives it a change number like any other write. Writes work on Qdrant, where the feed
 * reads the events they name, and answer `backend-unsupported` elsewhere.
 */
import { log } from '../../sillytavern/log.js';
import { counted } from '../../shared/counted.js';
import { COLLECTION_TYPES, buildRegistryKey, parseCollectionId } from '../../shared/collection-ids.js';
import { collectionNameOf } from '../collections/index.js';
import {
    chatOwnCollections, deleteEventPoints, openChatCollectionInUse, readEventFeed, readEventsById, writeEventFields,
} from '../eventbase/index.js';
import { PUBLIC_API_REASONS, collectionsAnswer, eventChangesOf, eventFeedAnswer, refusal, writtenAnswer } from './public-api-core.js';
import { deleteEventsQuestionOf, writeOwnerOf } from './public-api-questions-core.js';

/** The group of writes an event's edit and delete ask under (PUBLIC_WRITE_GROUPS). */
const EVENTBASE_WRITE_GROUP = 'eventbase';

/** How many events one `deleteEvents()` takes. */
const MAX_DELETED_EVENTS = 100;

/**
 * Whether a collection holds EventBase events: a chat's, or an archive's.
 * @param {string} collectionId
 * @returns {boolean}
 */
export function isEventBaseCollection(collectionId) {
    const { type } = parseCollectionId(collectionId);
    return type === COLLECTION_TYPES.CHAT || type === COLLECTION_TYPES.ARCHIVE_EVENT;
}

/**
 * The chat an EventBase collection belongs to: the chat UUID its ID holds, an archive's own UUID for an archive's.
 * @param {string} collectionId
 * @returns {string|null}
 */
export function chatIdOfCollection(collectionId) {
    return parseCollectionId(collectionId).chatUUID ?? null;
}

/**
 * A call's request, which must be an object.
 * @param {unknown} request
 * @param {string} call - The call, as its TypeError names it
 * @param {string} shape - What it takes, as its TypeError names it
 * @returns {object}
 * @throws {TypeError}
 */
function requestObjectOf(request, call, shape) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError(`${call}: pass an object, ${shape}`);
    return request;
}

/**
 * The `chatId` a read was given, the chat it must be about: null when left out.
 * @param {unknown} chatId
 * @param {string} call
 * @returns {string|null}
 * @throws {TypeError}
 */
function chatIdOf(chatId, call) {
    if (chatId === undefined || chatId === null) return null;
    if (typeof chatId !== 'string' || !chatId) throw new TypeError(`${call}: chatId must be a chat's ID, as chat.getChatId() gives it`);
    return chatId;
}

/**
 * The EventBase collection a call names.
 * @param {unknown} collectionId
 * @param {string} call
 * @returns {string}
 * @throws {TypeError}
 */
function eventBaseCollectionOf(collectionId, call) {
    if (typeof collectionId !== 'string' || !isEventBaseCollection(collectionId)) {
        throw new TypeError(`${call}: '${String(collectionId)}' is not the ID of an EventBase collection`);
    }
    return collectionId;
}

/**
 * An event's ID a call names.
 * @param {unknown} eventId
 * @param {string} call
 * @returns {string}
 * @throws {TypeError}
 */
function eventIdOf(eventId, call) {
    if (typeof eventId !== 'string' || !eventId) throw new TypeError(`${call}: an event's ID must be a string, as listEvents gives it`);
    return eventId;
}

/**
 * What `eventBase.listEvents()` was asked: each part optional, null when left out.
 * @param {unknown} request
 * @returns {{chatId: string|null, collectionId: string|null, after: number|null}}
 * @throws {TypeError} When the call cannot be right, a bug in the calling code
 */
function listEventsRequestOf(request) {
    const call = 'VectFox.eventBase.listEvents()';
    if (request === undefined) return { chatId: null, collectionId: null, after: null };
    const { chatId = null, collectionId = null, after = null } = requestObjectOf(request, call, '{ chatId, collectionId, after }, each part optional');
    const read = {
        chatId: chatIdOf(chatId, call),
        collectionId: collectionId === null ? null : eventBaseCollectionOf(collectionId, call),
        after,
    };
    if (after !== null && !(Number.isSafeInteger(after) && after >= 0)) {
        throw new TypeError(`${call}: after must be a cursor a read gave, a whole number of 0 or more, or left out for a full read`);
    }
    return read;
}

/**
 * The `eventBase` group's calls, answering from the readiness and settings store public-api.js keeps, and asking the
 * user through its write questions.
 * @param {object} parts
 * @param {() => boolean} parts.isReady
 * @param {() => object} parts.readSettings - VectFox settings, the store itself
 * @param {{mayWrite: (owner: string, groupId: string) => Promise<boolean>,
 *   mayRunAfterAsking: (owner: string, groupId: string, question: object) => Promise<boolean>}} parts.writeQuestions
 * @returns {{listEvents: Function, listCollections: Function, updateEvent: Function, deleteEvents: Function}}
 */
export function createEventBaseGroup({ isReady, readSettings, writeQuestions }) {
    /**
     * `eventBase.listEvents()`: what changed in one EventBase collection after a change number, or with none every
     * event it holds (§5.3). It reads the collection named, or the one the open chat uses; a `chatId` given is the
     * chat the read must be about: the named collection's, or the open one.
     * @param {{chatId?: string, collectionId?: string, after?: number}} [request]
     * @returns {Promise<Readonly<object>>} The feed's answer (eventFeedAnswer), or a refusal with `not-ready`,
     *   `no-chat`, `no-collection`, `backend-unsupported` or `read-failed`
     * @throws {TypeError} When the request cannot be right, as a rejection
     */
    async function listEvents(request) {
        const { chatId, collectionId, after } = listEventsRequestOf(request);
        if (!isReady()) return refusal(PUBLIC_API_REASONS.notReady);
        const settings = readSettings();
        let target = collectionId;
        if (target) {
            if (chatId && chatIdOfCollection(target) !== chatId) return refusal(PUBLIC_API_REASONS.noCollection);
        } else {
            const inUse = openChatCollectionInUse(settings);
            if (!inUse.chatId || (chatId && chatId !== inUse.chatId)) return refusal(PUBLIC_API_REASONS.noChat);
            if (!inUse.collectionId) return refusal(PUBLIC_API_REASONS.noCollection);
            target = inUse.collectionId;
        }
        let feed;
        try {
            feed = await readEventFeed(settings, { collectionId: target, after });
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
     * `eventBase.listCollections()`: the open chat's own EventBase collections on the backend in use, as Collection in
     * use here lists them, each with whether it is the one the chat uses. A `chatId` given is the chat the read must be
     * about, which must be the open one: VectFox keeps which collection a chat uses by its chat file, which it knows
     * for the open chat alone.
     * @param {{chatId?: string}} [request]
     * @returns {Readonly<object>} `{ ok: true, chatId, collections }`, or a refusal with `not-ready` or `no-chat`
     * @throws {TypeError} When the request cannot be right
     */
    function listCollections(request) {
        const call = 'VectFox.eventBase.listCollections()';
        const chatId = request === undefined ? null : chatIdOf(requestObjectOf(request, call, '{ chatId }, chatId optional').chatId, call);
        if (!isReady()) return refusal(PUBLIC_API_REASONS.notReady);
        const settings = readSettings();
        const inUse = openChatCollectionInUse(settings);
        if (!inUse.chatId || (chatId && chatId !== inUse.chatId)) return refusal(PUBLIC_API_REASONS.noChat);
        return collectionsAnswer({
            chatId: inUse.chatId,
            collections: chatOwnCollections(settings).map(({ collectionId, name }) => ({ collectionId, name, isInUse: collectionId === inUse.collectionId })),
        });
    }

    /**
     * Whether VectFox can write the events of a collection: on Qdrant, where the feed reads them.
     * @param {object} settings
     * @returns {boolean}
     */
    const canWriteEvents = settings => settings?.vector_backend === 'qdrant';

    /**
     * `eventBase.updateEvent()`: changes some of an event's fields, after the user's answer for the `eventbase` group
     * (§2.1). A field the event's text holds builds that text again and embeds it, in place under the event's ID; a
     * change of importance alone embeds nothing. StoryArc's links stay as they are.
     * @param {{owner: string, collectionId: string, eventId: string, changes: object}} request - changes: some of
     *   PUBLIC_EDITABLE_EVENT_FIELDS by their public names
     * @returns {Promise<Readonly<object>>} `{ ok: true }`, or a refusal with `not-ready`, `backend-unsupported`,
     *   `declined`, `no-event` or `write-failed`
     * @throws {TypeError} When the request cannot be right, as a rejection
     */
    async function updateEvent(request) {
        const call = 'VectFox.eventBase.updateEvent()';
        const { owner, collectionId, eventId, changes } = requestObjectOf(request, call, '{ owner, collectionId, eventId, changes }');
        writeOwnerOf(owner, call);
        eventBaseCollectionOf(collectionId, call);
        eventIdOf(eventId, call);
        const fields = eventChangesOf(changes);
        if (!isReady()) return refusal(PUBLIC_API_REASONS.notReady);
        const settings = readSettings();
        if (!canWriteEvents(settings)) return refusal(PUBLIC_API_REASONS.backendUnsupported);
        if (!await writeQuestions.mayWrite(owner, EVENTBASE_WRITE_GROUP)) return refusal(PUBLIC_API_REASONS.declined);
        let isWritten;
        try {
            isWritten = await writeEventFields(collectionId, eventId, fields, settings);
        } catch (error) {
            log.warn(`VectFox public API: ${owner}'s updateEvent of event ${eventId} in ${collectionId} did not get through, so it answers write-failed:`, error);
            return refusal(PUBLIC_API_REASONS.writeFailed);
        }
        if (!isWritten) return refusal(PUBLIC_API_REASONS.noEvent);
        log.lifecycle(`VectFox public API: ${owner} changed ${Object.keys(changes).join(', ')} of event ${eventId} in ${collectionId}`);
        return writtenAnswer();
    }

    /**
     * `eventBase.deleteEvents()`: deletes events, after a question every time (§2.1), which names them; a Deny of the
     * `eventbase` group answers `declined` with no question. Every event named must be stored, or nothing is deleted.
     * The windows they were read from stay read, and `vectfox_eventbase_events_deleted` gives their IDs.
     * @param {{owner: string, collectionId: string, eventIds: string[]}} request - eventIds: 1 to 100 of them
     * @returns {Promise<Readonly<object>>} `{ ok: true }`, or a refusal with `not-ready`, `backend-unsupported`,
     *   `no-event`, `declined` or `write-failed`
     * @throws {TypeError} When the request cannot be right, as a rejection
     */
    async function deleteEvents(request) {
        const call = 'VectFox.eventBase.deleteEvents()';
        const { owner, collectionId, eventIds } = requestObjectOf(request, call, '{ owner, collectionId, eventIds }');
        writeOwnerOf(owner, call);
        eventBaseCollectionOf(collectionId, call);
        if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > MAX_DELETED_EVENTS) {
            throw new TypeError(`${call}: eventIds must list 1 to ${MAX_DELETED_EVENTS} events' IDs, as listEvents gives them`);
        }
        const namedIds = [...new Set(eventIds.map(eventId => eventIdOf(eventId, call)))];
        if (!isReady()) return refusal(PUBLIC_API_REASONS.notReady);
        const settings = readSettings();
        if (!canWriteEvents(settings)) return refusal(PUBLIC_API_REASONS.backendUnsupported);
        let events;
        try {
            events = await readEventsById(collectionId, namedIds, settings);
        } catch (error) {
            log.warn(`VectFox public API: ${owner}'s deleteEvents could not read the events of ${collectionId}, so it answers write-failed:`, error);
            return refusal(PUBLIC_API_REASONS.writeFailed);
        }
        if (events.some(event => !event)) return refusal(PUBLIC_API_REASONS.noEvent);
        const question = deleteEventsQuestionOf(owner, {
            collectionName: collectionNameOf(buildRegistryKey(collectionId, settings)),
            summaries: events.map(event => event.summary),
        });
        if (!await writeQuestions.mayRunAfterAsking(owner, EVENTBASE_WRITE_GROUP, question)) return refusal(PUBLIC_API_REASONS.declined);
        try {
            await deleteEventPoints(collectionId, events.map(({ hash, metadata }) => ({ hash, metadata })), settings);
        } catch (error) {
            log.warn(`VectFox public API: ${owner}'s deleteEvents in ${collectionId} did not get through, so nothing was deleted and it answers write-failed:`, error);
            return refusal(PUBLIC_API_REASONS.writeFailed);
        }
        log.lifecycle(`VectFox public API: ${owner} deleted ${counted(events.length, 'event')} from ${collectionId}`);
        return writtenAnswer();
    }

    return { listEvents, listCollections, updateEvent, deleteEvents };
}
