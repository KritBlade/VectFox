/**
 * ============================================================================
 * BOUNDED RETRIEVAL
 * ============================================================================
 * One place for the rule every retrieval path in VectFox has to follow:
 *
 *   A retrieval must not freeze generation, must not break it when it fails,
 *   must not fail SILENTLY, and must not publish once its bound has passed.
 *
 * runBoundedRetrieval() keeps all four: it races the retrieval against the
 * retrieval budget, catches the failure, and both logs it and toasts the user.
 * A missing "also surface it" is invisible in review: the code looks complete,
 * the message still sends, and the user just watches the character forget
 * things. So every retrieval path goes through this one function rather than a
 * try/catch of its own, and a new path gets the surfacing for free.
 *
 * Nothing stops a retrieval that loses the race: its requests are already out.
 * So each one gets its bounded run, which ends when the bound passes, and checks
 * it before it publishes anything: its prompt block, or a toast saying what it
 * injected, would belong to a reply that went without it (GitHub issue #28).
 * ============================================================================
 */

import { resolveRetrievalTimeoutMs } from '../../shared/retrieval-budget.js';
import { notifyRetrievalFailure } from '../../shared/model-config-notifier.js';
import { describeEmbeddingTimeoutCause } from '../embedding/index.js';
import { log } from '../../sillytavern/log.js';

/** A retrieval that never returned, vs. one that returned an error. */
const TIMEOUT_PATTERN = /timed out|timeout|aborted/i;

/**
 * The bounded run of a retrieval no bound limits, such as the Query Tester's preview: always current.
 * @type {{isCurrent: () => boolean}}
 */
export const UNBOUNDED_RUN = Object.freeze({ isCurrent: () => true });

/**
 * Settles like the retrieval `startRetrieval` starts, or rejects with Error(`message`) once `ms` pass first. The
 * retrieval's bounded run ends in the same moment the bound passes, before anything else runs, so a retrieval that
 * settles later finds it ended.
 * @template T
 * @param {(boundedRun: {isCurrent: () => boolean}) => Promise<T>} startRetrieval
 * @param {number} ms
 * @param {string} [message]
 * @returns {Promise<T>}
 */
function raceWithTimeout(startRetrieval, ms, message = 'Operation timed out') {
    let hasBoundPassed = false;
    const boundedRun = Object.freeze({ isCurrent: () => !hasBoundPassed });
    let timer;
    const bound = new Promise((_, reject) => {
        timer = setTimeout(() => {
            hasBoundPassed = true;
            reject(new Error(message));
        }, ms);
    });
    const retrieval = (async () => startRetrieval(boundedRun))();
    return Promise.race([retrieval, bound]).finally(() => clearTimeout(timer));
}

/**
 * Run a retrieval under the shared timeout, logging AND toasting on failure,
 * then degrading to `fallback` instead of throwing. The retrieval gets its
 * bounded run, current until the bound passes; one that settles after it must
 * publish nothing, as its reply went without it.
 *
 * Soft timeout: on expiry the turn proceeds without this memory and the orphaned
 * request is reaped server-side. Never rethrows — callers are mid-generation and
 * a lookup failure must not break the message.
 *
 * @template T
 * @param {(boundedRun: {isCurrent: () => boolean}) => Promise<T>} startRetrieval - starts the retrieval, which checks
 *   `boundedRun.isCurrent()` before it publishes anything
 * @param {object} options
 * @param {string} options.contextLabel - user-facing subsystem: 'EventBase' | 'Chat memory' | 'Summarizer'
 * @param {string} options.sourceName - what was being searched, in the user's words
 * @param {string} options.timeoutMessage - message for the timeout Error
 * @param {T} [options.fallback] - value returned when the retrieval fails (default undefined)
 * @param {object} [options.settings] - VectFox settings; supplies the budget
 *   (`retrieval_timeout_ms`) and names the embedding provider in the timeout
 *   explanation. Omitting it costs the "why" and falls back to the default
 *   budget, not the surfacing.
 * @param {number} [options.timeoutMs] - explicit budget, overriding the one
 *   resolved from settings. Only for paths whose real cost is larger than a
 *   plain lookup — the EventBase path passes the Agent Mode-inclusive budget
 *   from resolveEventBaseRetrievalTimeoutMs().
 * @returns {Promise<T|undefined>} the result, or `fallback` on timeout/error
 */
export async function runBoundedRetrieval(startRetrieval, { contextLabel, sourceName, timeoutMessage, fallback, settings, timeoutMs } = {}) {
    const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : resolveRetrievalTimeoutMs(settings);
    try {
        return await raceWithTimeout(startRetrieval, budgetMs, timeoutMessage);
    } catch (error) {
        // A bare "retrieval timed out" names nothing the user can change, so they
        // read it as "the extension is broken" (which is how it was reported). The
        // timeout carries no timings — the request is still in flight — so the
        // attribution has to come from configuration. See
        // src/features/embedding/embedding-latency-warning.js for the measurements behind it.
        //
        // Name the budget too: until it became a setting, users hitting this had
        // nothing to change even once they believed the diagnosis (issue #16).
        const rawMessage = error?.message || String(error || 'unknown error');
        const detail = TIMEOUT_PATTERN.test(rawMessage)
            ? `${rawMessage} after ${(budgetMs / 1000).toFixed(1)}s. ${describeEmbeddingTimeoutCause(settings)} `
              + `If it is simply slow rather than broken, raise "Retrieval timeout" on the Core page.`
            : rawMessage;

        log.error(
            `VectFox ${contextLabel}: retrieval failed (non-fatal — the message still sends, without this memory):`,
            detail,
        );
        // De-duped per (context, source, message) inside the notifier, so a
        // persistently slow embedding provider warns once per session instead of
        // on every single generation.
        notifyRetrievalFailure(contextLabel, sourceName, detail);
        return fallback;
    }
}
