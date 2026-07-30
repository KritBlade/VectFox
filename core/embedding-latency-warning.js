/**
 * ============================================================================
 * EMBEDDING LATENCY WARNING
 * ============================================================================
 * Surfaces a slow-but-successful embedding call to the user.
 *
 * Every retrieval embeds the search text server-side BEFORE touching the vector
 * DB. Qdrant on LAN answers a hybrid query in ~20ms, so when a retrieval takes
 * seconds the embedding provider is effectively the entire cost.
 *
 * Existing code already blames the embedding provider when a query FAILS
 * (see backends/qdrant.js::_embedTimeoutHint). The gap this module closes is the
 * slow-but-successful case: the request returns 200, nothing is logged above
 * `verbose`, and the only user-visible effect is that semantic retrieval
 * silently produces nothing whenever the embed happens to exceed
 * RETRIEVAL_TIMEOUT_MS. That reads to the user as "the extension randomly
 * stopped working" (GitHub issue #11).
 *
 * Measured on a real setup (2026-07-30) — identical query, same collection:
 *   - Qdrant hybrid search with a pre-computed vector: 18-23ms
 *   - Same request letting the server embed via OpenRouter
 *     `qwen/qwen3-embedding-8b`: 2,895ms - 16,003ms
 * The 15s retrieval timeout sits inside that spread, so retrieval became a coin
 * flip with no feedback. Hence: warn loudly, and name the provider + model.
 * ============================================================================
 */

import { log } from './log.js';
import { getModelFromSettings } from './providers.js';

/**
 * Embed durations at or above this are considered slow enough to tell the user
 * about. Well under RETRIEVAL_TIMEOUT_MS (15s) so the warning arrives BEFORE the
 * provider starts costing retrievals, not only once it already has.
 */
export const SLOW_EMBEDDING_WARN_MS = 5000;

/**
 * Minimum gap between toasts. Retrieval runs on every generation, so an
 * unthrottled toast would fire continuously on a persistently slow provider and
 * bury the rest of the UI. The log line is NOT throttled — the console keeps the
 * full record.
 */
const TOAST_THROTTLE_MS = 120000;

let lastToastAt = 0;

/** Test seam: forget the throttle window so each test starts clean. */
export function _resetEmbeddingLatencyWarningThrottle() {
    lastToastAt = 0;
}

/**
 * Warn when a server-side embedding call was slow.
 *
 * Always logs above the threshold; toasts at most once per TOAST_THROTTLE_MS.
 * Safe to call on every query — a null/absent/fast `embedMs` is a no-op, so
 * callers don't need to branch (an older Similharity plugin that doesn't report
 * `timings` simply never triggers this).
 *
 * @param {number|null|undefined} embedMs - server-reported embed duration, or null
 *   when the caller supplied its own queryVector (nothing was embedded)
 * @param {object} settings - VectFox settings (for provider + model names)
 * @param {string} [label] - call site, e.g. 'hybrid-query' (log only)
 * @returns {boolean} true when the call was slow enough to warn about
 */
export function warnIfEmbeddingSlow(embedMs, settings, label = 'query') {
    if (typeof embedMs !== 'number' || !Number.isFinite(embedMs)) return false;
    if (embedMs < SLOW_EMBEDDING_WARN_MS) return false;

    const provider = settings?.embedding_provider || 'transformers';
    let model = '';
    try {
        model = getModelFromSettings(settings) || '';
    } catch (_) { /* provider without a model field — name it by provider alone */ }

    const seconds = (embedMs / 1000).toFixed(1);
    const modelLabel = model ? `${provider} (${model})` : provider;

    log.warn(
        `[VectFox] Slow embedding: ${modelLabel} took ${seconds}s to embed the ${label} text. ` +
        `The vector database is NOT the bottleneck — it answers in ~20ms. Semantic retrieval is ` +
        `dropped when embedding exceeds 15s, so a provider this slow makes retrieval intermittent. ` +
        `Consider a faster embedding model or a locally hosted one.`,
    );

    const now = Date.now();
    if (now - lastToastAt < TOAST_THROTTLE_MS) return true;
    lastToastAt = now;

    try {
        toastr.warning(
            `Embedding took ${seconds}s via ${modelLabel}. Semantic retrieval times out at 15s, ` +
            `so results may be missing. Try a faster embedding model.`,
            'VectFox — slow embedding provider',
            { timeOut: 12000 },
        );
    } catch (_) { /* toastr unavailable (unit tests / headless) — the log line stands alone */ }

    return true;
}
