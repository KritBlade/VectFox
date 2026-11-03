/**
 * ============================================================================
 * GENERATION (chat-completions) RATE LIMITER
 * ============================================================================
 * Shared sliding-window throttle for non-embedding LLM calls:
 *   - EventBase summarization extraction (core/eventbase-workflow.js)
 *   - Agent Mode planner             (core/agentic-retrieval.js)
 *
 * Both POST to /api/backends/chat-completions/generate, and Agent Mode's model
 * defaults to the summarizer's model — so they typically hit the SAME provider
 * quota. They therefore draw from ONE shared rate budget here, distinct from the
 * embedding limiter (`dynamicRateLimiter` in core/core-vector-api.js) which
 * throttles the embedding endpoint on its own separate budget.
 *
 * Throttled by settings.generation_rate_limit_calls / _interval (0 = disabled,
 * pure passthrough — the default, so existing users see no behavior change).
 * ============================================================================
 */

import { DynamicRateLimiter } from '../vector-backend/index.js';

/** Single shared instance — one sliding window across summarizer + agent mode. */
export const generationRateLimiter = new DynamicRateLimiter();

/**
 * Map VectFox's `generation_*` keys onto the generic keys `DynamicRateLimiter`
 * reads, so the limiter class stays unaware of our setting names.
 * @param {object} settings - VectFox settings
 * @returns {{rate_limit_calls: number, rate_limit_interval: number}}
 */
export function generationRateLimitSettings(settings) {
    return {
        rate_limit_calls: settings?.generation_rate_limit_calls || 0,
        rate_limit_interval: settings?.generation_rate_limit_interval || 60,
    };
}
