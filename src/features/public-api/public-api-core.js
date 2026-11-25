/**
 * The public API's pure parts: its version, the events it emits, the groups it serves, the reasons, settings and
 * EventBase events its calls answer with, what a message source's answer says, the mark on VectFox's own requests,
 * readiness and the shape of the `VectFox` object (§4, §5.2, §5.3 and §5.4 of
 * InternalProject/Vectfox/plans/executed/vectfox-public-api.md). No host imports: public-api.js publishes the object, answers its
 * calls, asks the message sources and emits the events.
 */

/**
 * The API's version, semver. A minor version only adds a method, event, field or reason; a removed, renamed or changed
 * name raises the major version at once, and no code keeps the old name working. A reader compares the major only.
 */
export const PUBLIC_API_VERSION = '1.4.0';

/** The events VectFox emits on SillyTavern's eventSource, by name. */
export const PUBLIC_EVENTS = Object.freeze({
    ready: 'vectfox_ready',
    eventBaseSynced: 'vectfox_eventbase_synced',
    eventBaseEventsDeleted: 'vectfox_eventbase_events_deleted',
    eventBaseCollectionChanged: 'vectfox_eventbase_collection_changed',
    llmCallFinished: 'vectfox_llm_call_finished',
});

/** The groups this build serves, so a consumer checks once instead of probing each method. */
export const PUBLIC_API_CAPABILITIES = Object.freeze(['events', 'chat', 'settings', 'eventbase.read', 'chat.messageSource']);

/**
 * Why a call answered no (§4.2): VectFox has not finished starting up; no chat is open, or not the one named; the chat
 * uses no collection, or the one named is not the chat's; the backend keeps no change numbers to read EventBase's feed
 * by; or the read did not reach the events.
 */
export const PUBLIC_API_REASONS = Object.freeze({
    notReady: 'not-ready',
    noChat: 'no-chat',
    noCollection: 'no-collection',
    backendUnsupported: 'backend-unsupported',
    readFailed: 'read-failed',
});

/**
 * The fields of each event `eventBase.listEvents()` gives, each public name with the feed's field it reads
 * (features/eventbase/eventbase-feed.js). A public name stays when its field is renamed inside VectFox.
 */
export const PUBLIC_EVENT_FIELDS = Object.freeze({
    eventId: 'event_id',
    summary: 'summary',
    cause: 'cause',
    result: 'result',
    characters: 'characters',
    locations: 'locations',
    importance: 'importance',
    storyTime: 'DateTime',
    sceneTime: 'scene_time',
    windowStart: 'source_window_start',
    windowEnd: 'source_window_end',
    cursor: 'change_number',
});

/**
 * The settings getSettingsSnapshot() reads by key, each public name with the setting it reads: ghosting, Summarizer
 * Injection and auto-sync's window. Beside them the snapshot gives `enabled`, VectFox's own switch, which is read
 * through its gate, and `requestMarkEnabled`, the PublicAPI page's switch, read as the marker reads it
 * (isOwnRequestMarkOn). A public name stays when its setting is renamed inside VectFox, and none of them is a key or key
 * ID.
 */
export const PUBLIC_SETTINGS = Object.freeze({
    ghostingEnabled: 'eventbase_ghost_enabled',
    ghostingKeepRecent: 'eventbase_ghost_keep_recent',
    ghostingBatchSize: 'eventbase_ghost_batch_size',
    summarizerInjectionEnabled: 'summarizer_injection_enabled',
    summarizerInjectionCount: 'summarizer_injection_count',
    summarizerInjectionFullDetail: 'summarizer_injection_full_detail',
    summarizerInjectionMaxChars: 'summarizer_injection_max_chars',
    autoSyncWindowTurns: 'eventbase_autosync_window_turns',
    autoSyncSettleLag: 'eventbase_autosync_settle_lag',
});

/**
 * Whether VectFox emits an event of this name.
 * @param {string} name
 * @returns {boolean}
 */
export function isPublicEventName(name) {
    return Object.values(PUBLIC_EVENTS).includes(name);
}

/**
 * The payload of `vectfox_ready`, frozen so no listener changes what the next one reads.
 * @returns {Readonly<{apiVersion: string}>}
 */
export function readyPayload() {
    return Object.freeze({ apiVersion: PUBLIC_API_VERSION });
}

/**
 * The payload of `vectfox_eventbase_synced`: an EventBase run ended, finished, stopped or failed. Every payload below
 * takes its fields by name, so nothing else the caller holds reaches a listener, and is frozen.
 * @param {{chatId: string|null, collectionId: string, eventsAdded: number, windowsProcessed: number}} run - chatId:
 *   the chat the collection belongs to; eventsAdded: the events the run stored; windowsProcessed: the windows it read
 * @returns {Readonly<object>}
 */
export function eventBaseSyncedPayload({ chatId, collectionId, eventsAdded, windowsProcessed }) {
    return Object.freeze({ chatId: chatId ?? null, collectionId, eventsAdded, windowsProcessed });
}

/**
 * The payload of `vectfox_eventbase_events_deleted`: events removed from a collection.
 * @param {{chatId: string|null, collectionId: string, eventIds: string[]|null}} removal - eventIds: the removed
 *   events' IDs, null when the whole collection was emptied
 * @returns {Readonly<object>}
 */
export function eventBaseEventsDeletedPayload({ chatId, collectionId, eventIds }) {
    return Object.freeze({ chatId: chatId ?? null, collectionId, eventIds: eventIds === null ? null : Object.freeze([...eventIds]) });
}

/**
 * The payload of `vectfox_eventbase_collection_changed`: the collection the open chat uses changed, or another chat
 * opened.
 * @param {{chatId: string|null, collectionId: string|null}} inUse - chatId: the open chat, null with none open;
 *   collectionId: the collection it uses, null with none
 * @returns {Readonly<object>}
 */
export function eventBaseCollectionChangedPayload({ chatId, collectionId }) {
    return Object.freeze({ chatId: chatId ?? null, collectionId: collectionId ?? null });
}

/**
 * The payload of `vectfox_llm_call_finished`: one of VectFox's LLM calls ended. `usage` is there only when the reply
 * reported its tokens. No key or key ID: only the fields below are taken.
 * @param {object} call - As llm-provider reports it
 * @param {string} call.feature - 'eventbase', 'lorebase', 'storyarc' or 'agent'
 * @param {string} call.connection - 'profile' or 'manual'
 * @param {string|null} call.profileName
 * @param {string|null} call.provider
 * @param {string|null} call.model
 * @param {number} call.durationMs
 * @param {string} call.outcome - 'ok', 'timed-out' or 'failed'
 * @param {{prompt_tokens: number|null, completion_tokens: number|null, total_tokens: number|null,
 *   cached_tokens: number|null}|null} call.usage
 * @returns {Readonly<object>}
 */
export function llmCallFinishedPayload({ feature, connection, profileName, provider, model, durationMs, outcome, usage }) {
    return Object.freeze({
        feature,
        connection,
        profileName: profileName ?? null,
        provider: provider ?? null,
        model: model ?? null,
        durationMs,
        outcome,
        ...(usage ? {
            usage: Object.freeze({
                promptTokens: usage.prompt_tokens ?? null,
                completionTokens: usage.completion_tokens ?? null,
                totalTokens: usage.total_tokens ?? null,
                cachedTokens: usage.cached_tokens ?? null,
            }),
        } : {}),
    });
}

/**
 * The key of the mark VectFox writes on each of its own requests (D11, §4.3): a `Symbol.for` key, so a usage tracker
 * that watches fetch makes the same symbol and reads the mark with no import.
 */
const OWN_REQUEST_MARK = Symbol.for('vectfox.internal-request');

/**
 * Writes VectFox's mark on the signal one of its own requests is sent with, before it is sent:
 * `{ label: 'VectFox <feature>' }`, frozen, under OWN_REQUEST_MARK and not enumerable. The signal reaches fetch in its
 * init on every route, SillyTavern's fetch for a profile's request included, so a usage tracker reads the mark at
 * `init.signal`, and the request's body and headers stay as they are.
 * @param {AbortSignal} signal - The signal the request is sent with
 * @param {string} feature - The feature the call is made for, as `vectfox_llm_call_finished` names it
 */
export function markOwnRequest(signal, feature) {
    Object.defineProperty(signal, OWN_REQUEST_MARK, { value: Object.freeze({ label: `VectFox ${feature}` }) });
}

/**
 * Whether VectFox marks its LLM calls' requests: the PublicAPI page's switch, `own_request_mark_enabled`, on only when
 * set to true, so a store that never saved it reads off. The marker and the settings snapshot both ask here, so a
 * tracker reads what the marker does. Only the user changes the switch: the API has no call for it.
 * @param {object|null} settings - VectFox settings
 * @returns {boolean}
 */
export function isOwnRequestMarkOn(settings) {
    return settings?.own_request_mark_enabled === true;
}

/**
 * A call's answer of no, frozen. A call never throws for a state it expects (§4.2).
 * @param {string} reason - One of PUBLIC_API_REASONS
 * @returns {Readonly<{ok: false, reason: string}>}
 */
export function refusal(reason) {
    return Object.freeze({ ok: false, reason });
}

/**
 * The answer of `chat.getChatId()`.
 * @param {string|null} chatId - The open chat's UUID, null with none open
 * @returns {Readonly<object>} `{ ok: true, chatId }`, or a refusal with `no-chat`
 */
export function chatIdAnswer(chatId) {
    return chatId ? Object.freeze({ ok: true, chatId }) : refusal(PUBLIC_API_REASONS.noChat);
}

/**
 * The answer of `chat.getCollectionInUse()`.
 * @param {{chatId: string|null, collectionId: string|null}} inUse - The open chat and the collection it uses
 * @returns {Readonly<object>} `{ ok: true, collectionId }`, or a refusal with `no-chat` or `no-collection`
 */
export function collectionInUseAnswer({ chatId, collectionId }) {
    if (!chatId) return refusal(PUBLIC_API_REASONS.noChat);
    if (!collectionId) return refusal(PUBLIC_API_REASONS.noCollection);
    return Object.freeze({ ok: true, collectionId });
}

/**
 * The answer of `getSettingsSnapshot()`: whether VectFox is switched on, the settings PUBLIC_SETTINGS lists, as they
 * are when asked, by their public names, and whether VectFox marks its LLM calls' requests, frozen. A setting VectFox
 * does not hold reads as null. A copy: nothing written to it reaches VectFox's settings.
 * @param {object} settings - VectFox settings
 * @param {{isEnabled: boolean}} gate - isEnabled: VectFox's switch, as its gate reads it
 * @returns {Readonly<{ok: true, settings: Readonly<object>}>}
 */
export function settingsSnapshotAnswer(settings, { isEnabled }) {
    const listed = Object.fromEntries(Object.entries(PUBLIC_SETTINGS).map(([name, key]) => [name, settings[key] ?? null]));
    return Object.freeze({
        ok: true,
        settings: Object.freeze({ enabled: isEnabled, ...listed, requestMarkEnabled: isOwnRequestMarkOn(settings) }),
    });
}

/**
 * What a message source's answer for one message says (§5.4): null for an ordinary message, else the messages a
 * summary stands for, none for a summary of messages still in the chat or of none. Anything else is no answer, and
 * `problem` says what it was, for the console. The messages are the source's own, so nothing here copies or freezes
 * them.
 * @param {unknown} answer - What originalsOf returned
 * @returns {{originals: object[]|null}|{problem: string}}
 */
export function messageSourceAnswerOf(answer) {
    if (answer === null) return { originals: null };
    if (typeof answer?.then === 'function') return { problem: 'answered a promise, where it must answer at once' };
    if (!Array.isArray(answer)) {
        const kind = answer === undefined ? 'undefined' : `${/^[aeiou]/.test(typeof answer) ? 'an' : 'a'} ${typeof answer}`;
        return { problem: `answered ${kind}, where null or a list of messages was expected` };
    }
    if (answer.some(original => !original || typeof original !== 'object' || Array.isArray(original))) {
        return { problem: 'answered a list holding something that is not a message' };
    }
    return { originals: answer };
}

/**
 * One event of the feed by its public names, frozen, its lists copied and frozen too.
 * @param {object} event - As the feed gives it (features/eventbase/eventbase-feed.js)
 * @returns {Readonly<object>}
 */
function publicEventOf(event) {
    return Object.freeze(Object.fromEntries(Object.entries(PUBLIC_EVENT_FIELDS).map(([name, field]) => {
        const value = event[field];
        return [name, Array.isArray(value) ? Object.freeze([...value]) : value];
    })));
}

/**
 * The answer of `eventBase.listEvents()`: what changed in one EventBase collection after a change number, or every
 * event it holds with no number, frozen throughout.
 * @param {object} feed - As the feed gives it, with the collection it read
 * @param {string} feed.collectionId
 * @param {number|string} feed.schemaVersion - EventBase's schema version
 * @param {object[]} feed.events
 * @param {string[]} feed.removedEventIds
 * @param {boolean} feed.emptied
 * @param {number} feed.cursor
 * @param {boolean} feed.hasMore
 * @returns {Readonly<object>} `{ ok: true, schemaVersion, collectionId, events, removedEventIds, emptied, cursor, hasMore }`
 */
export function eventFeedAnswer({ collectionId, schemaVersion, events, removedEventIds, emptied, cursor, hasMore }) {
    return Object.freeze({
        ok: true,
        schemaVersion: String(schemaVersion),
        collectionId,
        events: Object.freeze(events.map(publicEventOf)),
        removedEventIds: Object.freeze([...removedEventIds]),
        emptied,
        cursor,
        hasMore,
    });
}

/**
 * Readiness: false until VectFox's initialization ends, then true for good. `whenReady()` gives one promise, which
 * resolves then; `markReady()` says whether this call made VectFox ready, so it is announced once.
 * @returns {{isReady: () => boolean, whenReady: () => Promise<void>, markReady: () => boolean}}
 */
export function createReadiness() {
    let isReadyNow = false;
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    return {
        isReady: () => isReadyNow,
        whenReady: () => readyPromise,
        markReady: () => {
            if (isReadyNow) return false;
            isReadyNow = true;
            resolveReady();
            return true;
        },
    };
}

/**
 * The frozen `VectFox` object (§4.1, §5.2, §5.3, §5.4). `extensionVersion` is read when asked: the manifest's version
 * once start-up has read it, null before then or when it could not be read.
 * @param {object} parts
 * @param {ReturnType<typeof createReadiness>} parts.readiness
 * @param {() => (string|null)} parts.readExtensionVersion
 * @param {(name: string, handler: Function) => (() => void)} parts.on - Subscribes; returns its own unsubscribe
 * @param {(name: string, handler: Function) => void} parts.off
 * @param {{getChatId: () => object, getCollectionInUse: () => object,
 *   registerMessageSource: (source: object) => (() => void)}} parts.chat - The `chat` group's calls
 * @param {() => object} parts.getSettingsSnapshot
 * @param {{listEvents: (request?: object) => Promise<object>}} parts.eventBase - The `eventBase` group's calls
 * @returns {Readonly<object>}
 */
export function buildPublicApi({ readiness, readExtensionVersion, on, off, chat, getSettingsSnapshot, eventBase }) {
    return Object.freeze({
        apiVersion: PUBLIC_API_VERSION,
        get extensionVersion() {
            return readExtensionVersion();
        },
        capabilities: PUBLIC_API_CAPABILITIES,
        isReady: readiness.isReady,
        whenReady: readiness.whenReady,
        on,
        off,
        chat: Object.freeze({
            getChatId: chat.getChatId,
            getCollectionInUse: chat.getCollectionInUse,
            registerMessageSource: chat.registerMessageSource,
        }),
        getSettingsSnapshot,
        eventBase: Object.freeze({ listEvents: eventBase.listEvents }),
    });
}
