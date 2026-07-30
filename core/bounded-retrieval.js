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
import { RETRIEVAL_TIMEOUT_MS } from './constants.js';
import { notifyRetrievalFailure } from './model-config-notifier.js';
import { log } from './log.js';

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
 * @returns {Promise<T|undefined>} the result, or `fallback` on timeout/error
 */
export async function runBoundedRetrieval(promise, { contextLabel, sourceName, timeoutMessage, fallback } = {}) {
    try {
        return await AsyncUtils.timeout(promise, RETRIEVAL_TIMEOUT_MS, timeoutMessage);
    } catch (error) {
        log.error(
            `VectFox ${contextLabel}: retrieval failed (non-fatal — the message still sends, without this memory):`,
            error?.message || error,
        );
        // De-duped per (context, source, message) inside the notifier, so a
        // persistently slow embedding provider warns once per session instead of
        // on every single generation.
        notifyRetrievalFailure(contextLabel, sourceName, error);
        return fallback;
    }
}
