/**
 * The public API's pure parts: its version, the events it emits, the groups it serves, readiness and the shape of the
 * `VectFox` object (§4 of InternalProject/Vectfox/plans/vectfox-public-api.md). No host imports: public-api.js
 * publishes the object and emits the events.
 */

/**
 * The API's version, semver. A minor version only adds a method, event, field or reason; a removed, renamed or changed
 * name raises the major version at once, and no code keeps the old name working. A reader compares the major only.
 */
export const PUBLIC_API_VERSION = '1.0.0';

/** The events VectFox emits on SillyTavern's eventSource, by name. */
export const PUBLIC_EVENTS = Object.freeze({
    ready: 'vectfox_ready',
    eventBaseSynced: 'vectfox_eventbase_synced',
    eventBaseEventsDeleted: 'vectfox_eventbase_events_deleted',
    eventBaseCollectionChanged: 'vectfox_eventbase_collection_changed',
    llmCallFinished: 'vectfox_llm_call_finished',
});

/** The groups this build serves, so a consumer checks once instead of probing each method. */
export const PUBLIC_API_CAPABILITIES = Object.freeze(['events']);

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
 * The frozen `VectFox` object (§4.1). `extensionVersion` is read when asked: the manifest's version once start-up has
 * read it, null before then or when it could not be read.
 * @param {object} parts
 * @param {ReturnType<typeof createReadiness>} parts.readiness
 * @param {() => (string|null)} parts.readExtensionVersion
 * @param {(name: string, handler: Function) => (() => void)} parts.on - Subscribes; returns its own unsubscribe
 * @param {(name: string, handler: Function) => void} parts.off
 * @returns {Readonly<object>}
 */
export function buildPublicApi({ readiness, readExtensionVersion, on, off }) {
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
    });
}
