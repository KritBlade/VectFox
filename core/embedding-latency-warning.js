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
 * silently produces nothing whenever the embed happens to exceed the retrieval
 * budget. That reads to the user as "the extension randomly stopped working"
 * (GitHub issue #11).
 *
 * Measured on a real setup (2026-07-30) — identical query, same collection:
 *   - Qdrant hybrid search with a pre-computed vector: 18-23ms
 *   - Same request letting the server embed via OpenRouter
 *     `qwen/qwen3-embedding-8b`: 2,895ms - 16,003ms
 * The default 15s retrieval budget sits inside that spread, so retrieval became
 * a coin flip with no feedback. Hence: log it, and name the provider + model.
 *
 * LOG ONLY — no toast. A slow-but-SUCCESSFUL embed costs the user nothing: the
 * results arrive. The case that actually costs them memory is the retrieval
 * timing out, and core/bounded-retrieval.js already raises a red error toast for
 * exactly that, naming this same provider via describeEmbeddingTimeoutCause().
 * A second, earlier, orange toast on the success path only taught users to
 * dismiss popups (GitHub issue #12).
 * ============================================================================
 */

import { log } from './log.js';
import { getModelFromSettings } from './providers.js';
import { resolveRetrievalTimeoutMs } from './retrieval-budget.js';

/**
 * Embed durations at or above this get a log line.
 *
 * Derived from the user's retrieval budget rather than hard-coded so "warn while
 * approaching the cliff" stays true wherever the user set the budget. Two thirds
 * of the budget = 10s at the default 15s.
 *
 * Was a module constant, and before that a flat 5000. The flat value is a third
 * of the default budget, and a perfectly healthy local provider reaches it:
 * Ollama on a 10Gb LAN crosses 5s from time to time while returning full results
 * well inside the timeout. Warning there described normal operation as a
 * problem. The constant then went stale the moment the budget became a setting
 * (GitHub issue #16) — a user who raised the budget to 60s would still have been
 * warned at 10s. Hence: a function of settings, resolved per call.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds
 */
export function slowEmbeddingWarnMs(settings) {
    return Math.round(resolveRetrievalTimeoutMs(settings) * (2 / 3));
}

/**
 * Name the configured embedding provider the way the user configured it, e.g.
 * `openrouter (qwen/qwen3-embedding-8b)`. Falls back to the provider alone when
 * the provider has no model field (transformers) or the lookup throws.
 *
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function embeddingProviderLabel(settings) {
    const provider = settings?.embedding_provider || 'transformers';
    let model = '';
    try {
        model = getModelFromSettings(settings) || '';
    } catch (_) { /* provider without a model field — name it by provider alone */ }
    return model ? `${provider} (${model})` : provider;
}

/**
 * The "why did this time out?" sentence, for a retrieval that never came back.
 *
 * A timeout has no timings to report — the request is still in flight when we
 * give up — so warnIfEmbeddingSlow() below can never fire for it, and the user
 * is left with a bare "retrieval timed out" that names nothing they can act on.
 * This supplies the attribution from configuration instead of measurement, on
 * the same evidence as the module header: the vector DB answers in ~20ms, so
 * everything else in the budget is the embedding call.
 *
 * @param {object} settings - VectFox settings
 * @returns {string} sentence naming the likely culprit and the fix
 */
export function describeEmbeddingTimeoutCause(settings) {
    return `Almost always the embedding provider — ${embeddingProviderLabel(settings)} — `
        + `not the vector database, which answers in ~20ms. Try a faster embedding model.`;
}

/**
 * Log when a server-side embedding call was slow.
 *
 * Console only, never a toast — see the LOG ONLY note in the module header.
 * Unthrottled: the console keeps the full record, and it costs the user nothing.
 * Safe to call on every query — a null/absent/fast `embedMs` is a no-op, so
 * callers don't need to branch (an older Similharity plugin that doesn't report
 * `timings` simply never triggers this).
 *
 * @param {number|null|undefined} embedMs - server-reported embed duration, or null
 *   when the caller supplied its own queryVector (nothing was embedded)
 * @param {object} settings - VectFox settings (for provider + model names)
 * @param {string} [label] - call site, e.g. 'hybrid-query'
 * @returns {boolean} true when the call was slow enough to log
 */
export function warnIfEmbeddingSlow(embedMs, settings, label = 'query') {
    if (typeof embedMs !== 'number' || !Number.isFinite(embedMs)) return false;
    if (embedMs < slowEmbeddingWarnMs(settings)) return false;

    const seconds = (embedMs / 1000).toFixed(1);
    const modelLabel = embeddingProviderLabel(settings);
    const budgetSeconds = (resolveRetrievalTimeoutMs(settings) / 1000).toFixed(1);

    log.warn(
        `[VectFox] Slow embedding: ${modelLabel} took ${seconds}s to embed the ${label} text. ` +
        `The vector database is NOT the bottleneck — it answers in ~20ms. Semantic retrieval is ` +
        `dropped when embedding exceeds ${budgetSeconds}s, so a provider this slow makes retrieval intermittent. ` +
        `Consider a faster embedding model or a locally hosted one, or raise "Retrieval Timeout" in the Core tab.`,
    );

    return true;
}
