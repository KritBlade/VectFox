/**
 * ============================================================================
 * RETRIEVAL BUDGET
 * ============================================================================
 * What a single turn is allowed to SPEND on looking things up — milliseconds
 * for every retrieval path, plus the output-token cap for the one path that
 * calls an LLM (Agent Mode's planner). Resolved from settings. Pure arithmetic
 * over settings + constants — no I/O, no host imports, no dependency on the
 * modules that consume it.
 *
 * Time and tokens live together because they are the same kind of knob with the
 * same failure mode: set too low, retrieval quietly returns nothing and the user
 * is told the extension is broken (issues #16 and #18 respectively). Keeping
 * every `agentic_retrieval_*` limit resolvable from one import is also what
 * stops the UI's clamp and the request's clamp from drifting apart.
 *
 * It lives in its own module for two reasons:
 *
 * 1. TWO CONSUMERS THAT CANNOT IMPORT EACH OTHER. core/bounded-retrieval.js
 *    enforces the budget; core/embedding-latency-warning.js warns while
 *    APPROACHING it (its threshold is two thirds of the budget) — and
 *    bounded-retrieval already imports the warning module for its "why did this
 *    time out?" sentence. Putting the resolver in either one makes a cycle.
 *
 * 2. THE BUDGET IS NOT ONE NUMBER ANYMORE. Agent Mode runs a planner LLM call
 *    and a query fanout INSIDE the retrieval it is bounded by, each with its own
 *    user-configurable timeout. Those settings were clamped to 60s apiece in the
 *    UI while the retrieval wrapping them was hard-capped at 15s, so raising
 *    either knob past the cap did nothing and agent mode timed out on its own
 *    defaults (planner default 30s > budget 15s). Users read that as "the
 *    extension is broken and I can't change the threshold" — GitHub issue #16.
 *
 *    The fix is here: the EventBase budget ADDS the agent-mode timeouts the user
 *    configured, so the outer bound can never contradict the inner ones.
 * ============================================================================
 */

import {
    RETRIEVAL_TIMEOUT_DEFAULT_MS,
    RETRIEVAL_TIMEOUT_MIN_MS,
    RETRIEVAL_TIMEOUT_MAX_MS,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,
    AGENTIC_TIMEOUT_MIN_MS,
    AGENTIC_TIMEOUT_MAX_MS,
    AGENTIC_MAX_TOKENS_DEFAULT,
    AGENTIC_MAX_TOKENS_MIN,
    AGENTIC_MAX_TOKENS_MAX,
} from './constants.js';

/**
 * Read one numeric setting, falling back to `fallback` when it is absent,
 * non-numeric, or zero/negative, then clamp it into [min, max].
 *
 * Unit-agnostic on purpose — the same read/fallback/clamp shape serves both the
 * millisecond budgets and the token cap below.
 *
 * @param {*} raw - the settings value as stored (may be a string from an input)
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function _resolveBoundedSetting(raw, fallback, min, max) {
    const value = Number(raw);
    const chosen = Number.isFinite(value) && value > 0 ? value : fallback;
    return Math.max(min, Math.min(max, chosen));
}

/**
 * The base per-turn retrieval budget: how long any single retrieval path
 * (EventBase, chunk, lorebook, summarizer injection) may run before the turn
 * proceeds without that memory.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds
 */
export function resolveRetrievalTimeoutMs(settings) {
    return _resolveBoundedSetting(
        settings?.retrieval_timeout_ms,
        RETRIEVAL_TIMEOUT_DEFAULT_MS,
        RETRIEVAL_TIMEOUT_MIN_MS,
        RETRIEVAL_TIMEOUT_MAX_MS,
    );
}

/**
 * Agent Mode: hard timeout for the planner LLM call.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds
 */
export function resolveAgenticPlannerTimeoutMs(settings) {
    return _resolveBoundedSetting(
        settings?.agentic_retrieval_timeout_ms,
        AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,
        AGENTIC_TIMEOUT_MIN_MS,
        AGENTIC_TIMEOUT_MAX_MS,
    );
}

/**
 * Agent Mode: hard timeout for each parallel fanout query.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds
 */
export function resolveAgenticQueryTimeoutMs(settings) {
    return _resolveBoundedSetting(
        settings?.agentic_retrieval_query_timeout_ms,
        AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,
        AGENTIC_TIMEOUT_MIN_MS,
        AGENTIC_TIMEOUT_MAX_MS,
    );
}

/**
 * Agent Mode: output-token cap for the planner LLM call.
 *
 * The planner returns a small JSON object, so the default is ample for a model
 * that answers directly. A model that REASONS spends this same budget on its
 * thinking first, and a cap that runs out mid-thought yields truncated or empty
 * content — which fails JSON.parse and drops Agent Mode to pre-search with only
 * a log line to show for it (GitHub issue #18). Raising this is the fix for a
 * thinking planner; `should_disable_thinking` is only a request, and plenty of
 * models ignore it.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} tokens
 */
export function resolveAgenticMaxTokens(settings) {
    return _resolveBoundedSetting(
        settings?.agentic_retrieval_max_tokens,
        AGENTIC_MAX_TOKENS_DEFAULT,
        AGENTIC_MAX_TOKENS_MIN,
        AGENTIC_MAX_TOKENS_MAX,
    );
}

/**
 * Extra milliseconds Agent Mode adds to the EventBase retrieval budget, on top
 * of the base timeout.
 *
 * Agent Mode is three sequential stages inside one retrieval: the ordinary
 * pre-search, then the planner LLM call, then the query fanout. The base budget
 * already covers the pre-search (it IS an ordinary retrieval), so the extra is
 * planner + fanout. The fanout runs in parallel, so it costs one per-query
 * timeout regardless of how many queries the planner emitted.
 *
 * Returns 0 unless the agent path can actually run — same gate as STAGE 2 of
 * retrieveEventsWithAgent(). A user who leaves the agent timeouts cranked up but
 * turns agent mode OFF gets the plain base budget back, not a silently inflated
 * one.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds (0 when agent mode is inactive)
 */
export function agenticRetrievalExtraBudgetMs(settings) {
    if (!settings?.agentic_retrieval_enabled) return 0;
    if (settings.vector_backend !== 'qdrant') return 0;
    return resolveAgenticPlannerTimeoutMs(settings) + resolveAgenticQueryTimeoutMs(settings);
}

/**
 * The budget for the EventBase retrieval path specifically — the only path that
 * can route through Agent Mode.
 *
 * @param {object} [settings] - VectFox settings
 * @returns {number} milliseconds
 */
export function resolveEventBaseRetrievalTimeoutMs(settings) {
    return resolveRetrievalTimeoutMs(settings) + agenticRetrievalExtraBudgetMs(settings);
}
