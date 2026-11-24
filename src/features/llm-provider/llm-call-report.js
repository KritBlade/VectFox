/**
 * How a usage tracker tells VectFox's own LLM calls from the story reply. Each call that ended is reported: the feature
 * that made it, the connection it went over, how long it took, how it ended and the tokens its reply reported. Each
 * request VectFox sends itself, on the manual route, is marked before it is sent; a profile's request is sent by
 * SillyTavern and carries no mark. src/index.js sets both from the public API at start-up: the listener, which sends
 * each report on as `vectfox_llm_call_finished`, and the marker, which writes VectFox's mark. Only a call that was sent
 * is reported: one a check stopped before it left VectFox cost nothing.
 */
import { log } from '../../sillytavern/log.js';

/** The feature behind a call, as its report names it. */
export const LLM_CALL_FEATURES = Object.freeze({
    eventBase: 'eventbase',
    loreBase: 'lorebase',
    storyArc: 'storyarc',
    agentMode: 'agent',
});

/** The connection a call went over: a SillyTavern connection profile, or a provider set in VectFox itself. */
export const LLM_CALL_CONNECTIONS = Object.freeze({
    profile: 'profile',
    manual: 'manual',
});

/** How a call ended: a reply with text, its time limit passing first, or any other failure. */
export const LLM_CALL_OUTCOMES = Object.freeze({
    ok: 'ok',
    timedOut: 'timed-out',
    failed: 'failed',
});

/**
 * @typedef {object} LlmCallFinished
 * @property {string} feature - One of LLM_CALL_FEATURES
 * @property {string} connection - One of LLM_CALL_CONNECTIONS
 * @property {string|null} profileName - The profile's name on a profile, null on a manual connection
 * @property {string|null} provider - The provider: the profile's source, or the manual provider
 * @property {string|null} model
 * @property {number} durationMs - From sending the request to its end
 * @property {string} outcome - One of LLM_CALL_OUTCOMES
 * @property {{prompt_tokens: number|null, completion_tokens: number|null, total_tokens: number|null,
 *   cached_tokens: number|null}|null} usage - The tokens the reply reported, null when it reported none
 */

/** @type {((call: LlmCallFinished) => void)|null} */
let llmCallFinishedListener = null;

/** @type {((init: object, feature: string) => void)|null} */
let ownRequestMarker = null;

/**
 * Sets the listener told of each finished call.
 * @param {(call: LlmCallFinished) => void} listener
 */
export function setLlmCallFinishedListener(listener) {
    llmCallFinishedListener = listener;
}

/**
 * Sets what marks each request VectFox sends itself.
 * @param {(init: object, feature: string) => void} marker - Writes the mark on a fetch's init, for the call's feature
 */
export function setOwnRequestMarker(marker) {
    ownRequestMarker = marker;
}

/**
 * A request VectFox sends itself, marked by the marker set at start-up for the feature the call is made for. A marker
 * that throws is logged, and the request goes unmarked rather than unsent.
 * @param {object} init - The fetch's init
 * @param {string} feature - One of LLM_CALL_FEATURES
 * @returns {object} The same init
 */
export function markedAsOwnRequest(init, feature) {
    if (!ownRequestMarker) return init;
    try {
        ownRequestMarker(init, feature);
    } catch (error) {
        log.warn('VectFox: marking one of its own requests failed, so it is sent unmarked:', error);
    }
    return init;
}

/**
 * Whether a name is one of the features an LLM call reports.
 * @param {string} feature
 * @returns {boolean}
 */
export function isLlmCallFeature(feature) {
    return Object.values(LLM_CALL_FEATURES).includes(feature);
}

/**
 * How a call that threw ended: its time limit passed, or it failed.
 * @param {unknown} error
 * @returns {string} One of LLM_CALL_OUTCOMES
 */
export function outcomeOfFailedCall(error) {
    return error?.name === 'TimeoutError' ? LLM_CALL_OUTCOMES.timedOut : LLM_CALL_OUTCOMES.failed;
}

/**
 * Tells the listener a call finished. A listener that throws is logged and never fails the call.
 * @param {LlmCallFinished} call
 */
export function reportLlmCallFinished(call) {
    if (!llmCallFinishedListener) return;
    try {
        llmCallFinishedListener(call);
    } catch (error) {
        log.warn('VectFox: the listener for finished LLM calls failed:', error);
    }
}
