/**
 * ============================================================================
 * BOUNDED RETRIEVAL
 * ============================================================================
 * One place for the rule every retrieval path in VectFox has to follow:
 *
 *   A retrieval must not freeze generation, must not break it when it fails,
 *   and must not fail SILENTLY.
 *
 * The first two were already honored everywhere — each call site wrapped itself
 * in AsyncUtils.timeout and caught its own errors. The third kept getting
 * missed, because "also surface it" lived only in five hand-maintained copies of
 * the same try/catch. It was missed for every EventBase/chunk path (fixed here)
 * and again for the Lorebook dry-run after a rebase. The failure mode is
 * invisible in review: the code looks complete, the message still sends, and the
 * user just watches the character forget things.
 *
 * Collapsing the pattern into one function makes the contract enforceable rather
 * than remembered. New retrieval paths get the surfacing for free.
 * ============================================================================
 */

import AsyncUtils from '../utils/async-utils.js';
import { resolveRetrievalTimeoutMs } from './retrieval-budget.js';
import { notifyRetrievalFailure } from './model-config-notifier.js';
import { describeEmbeddingTimeoutCause } from './embedding-latency-warning.js';
import { log } from './log.js';

/** A retrieval that never returned, vs. one that returned an error. */
const TIMEOUT_PATTERN = /timed out|timeout|aborted/i;

/**
 * Run a retrieval promise under the shared timeout, logging AND toasting on
 * failure, then degrading to `fallback` instead of throwing.
 *
 * Soft timeout: on expiry the turn proceeds without this memory and the orphaned
 * request is reaped server-side. Never rethrows — callers are mid-generation and
 * a lookup failure must not break the message.
 *
 * @template T
 * @param {Promise<T>} promise - the retrieval already in flight
 * @param {object} options
 * @param {string} options.contextLabel - user-facing subsystem: 'EventBase' | 'Lorebook' | 'Chat memory' | 'Summarizer'
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
export async function runBoundedRetrieval(promise, { contextLabel, sourceName, timeoutMessage, fallback, settings, timeoutMs } = {}) {
    const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : resolveRetrievalTimeoutMs(settings);
    try {
        return await AsyncUtils.timeout(promise, budgetMs, timeoutMessage);
    } catch (error) {
        // A bare "retrieval timed out" names nothing the user can change, so they
        // read it as "the extension is broken" (which is how it was reported). The
        // timeout carries no timings — the request is still in flight — so the
        // attribution has to come from configuration. See
        // core/embedding-latency-warning.js for the measurements behind it.
        //
        // Name the budget too: until it became a setting, users hitting this had
        // nothing to change even once they believed the diagnosis (issue #16).
        const rawMessage = error?.message || String(error || 'unknown error');
        const detail = TIMEOUT_PATTERN.test(rawMessage)
            ? `${rawMessage} after ${(budgetMs / 1000).toFixed(1)}s. ${describeEmbeddingTimeoutCause(settings)} `
              + `If it is simply slow rather than broken, raise "Retrieval Timeout" in the Core tab.`
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
