/**
 * How a usage tracker tells VectFox's own LLM calls from the story reply. Each call that ended is reported: the feature
 * that made it, the connection it went over, how long it took, how it ended and the tokens its reply reported. Each
 * call's request is sent with a signal the marker sees before it is sent: VectFox's own fetch takes it on a manual
 * connection and for Jev, and SillyTavern's on a profile, which hands the signal it is given to fetch as is
 * (tools/check-profile-request-signal.mjs reads SillyTavern's source to check that it still does). src/index.js sets
 * both from the public API at start-up: the listener, which sends each report on as `vectfox_llm_call_finished`, and the
 * marker, which writes VectFox's mark while the PublicAPI page's switch is on. Only a call that was sent is reported:
 * one a check stopped before it left VectFox cost nothing.
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

/** @type {((signal: AbortSignal, feature: string) => void)|null} */
let ownRequestMarker = null;

/**
 * Sets the listener told of each finished call.
 * @param {(call: LlmCallFinished) => void} listener
 */
export function setLlmCallFinishedListener(listener) {
    llmCallFinishedListener = listener;
}

/**
 * Sets what marks the signal of each request a call sends.
 * @param {(signal: AbortSignal, feature: string) => void} marker - Writes the mark on a request's signal, for the
 *        call's feature
 */
export function setOwnRequestMarker(marker) {
    ownRequestMarker = marker;
}

/**
 * The signal a call's request is sent with: it ends the request once `timeoutMs` pass, and is handed to the marker set
 * at start-up, which writes the mark for the feature the call is made for while the PublicAPI page's switch is on. A
 * marker that throws is logged, and the request goes unmarked rather than unsent.
 * @param {number} timeoutMs - The request's time limit
 * @param {string} feature - One of LLM_CALL_FEATURES
 * @returns {AbortSignal}
 */
export function ownRequestSignal(timeoutMs, feature) {
    const signal = AbortSignal.timeout(timeoutMs);
    if (!ownRequestMarker) return signal;
    try {
        ownRequestMarker(signal, feature);
    } catch (error) {
        log.warn('VectFox: marking one of its own requests failed, so it is sent unmarked:', error);
    }
    return signal;
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
