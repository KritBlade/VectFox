/**
 * ============================================================================
 * VECTFOX CONSTANTS
 * ============================================================================
 * Centralized configuration values used across the extension.
 * Change these values here instead of hunting through the codebase.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

// =============================================================================
// EXTENSION IDENTITY
// =============================================================================

/** Extension prompt tag for SillyTavern's prompt system */
export const EXTENSION_PROMPT_TAG = '3_vectfox';

/** Extension prompt tag for lorebook semantic WI injection */
export const LOREBOOK_PROMPT_TAG = '3_vectfox_lorebook';

/** Extension name for logging and UI */
export const EXTENSION_NAME = 'VectFox';

// =============================================================================
// PERFORMANCE & RATE LIMITING
// =============================================================================

/** LRU cache size for hash computations */
export const HASH_CACHE_SIZE = 10000;

/** Maximum items to fetch when listing vectors (for hash comparison) */
export const VECTOR_LIST_LIMIT = 10000;

/** Rate limiter: max calls per window */
export const RATE_LIMIT_CALLS = 50;

/** Rate limiter: window duration in ms (1 minute) */
export const RATE_LIMIT_WINDOW_MS = 60000;

/** API request timeout in ms (30 seconds) */
export const API_TIMEOUT_MS = 30000;

/**
 * DEFAULT per-turn retrieval timeout in ms (15 seconds) -- the fallback for the
 * user-facing `retrieval_timeout_ms` setting (Core tab -> Retrieval), not the
 * effective value. Always read the effective budget through
 * resolveRetrievalTimeoutMs() in core/retrieval-budget.js.
 *
 * Bounds the read/search path during generation (rearrangeChat -> EventBase
 * retrieval + chunk retrieval) so a hung embedding/query cannot freeze the whole
 * conversation. On timeout the turn proceeds WITHOUT memory injection -- soft
 * Promise.race via AsyncUtils.timeout; the orphaned fetch is reaped later by
 * ST's server-side timeout (read fetches carry no client AbortSignal). Matches
 * the write-side hedge threshold (vector_hedge_after_ms = 15000) for one
 * consistent "too slow" number. Unlike the write path, reads are NOT
 * hedged/retried -- a stalled retrieval fails soft (one turn without memory,
 * self-corrects next message), so a single bounded attempt is the right
 * tradeoff. See dev_helper.md sec 6.8.
 */
export const RETRIEVAL_TIMEOUT_DEFAULT_MS = 15000;

/**
 * Clamp range for `retrieval_timeout_ms`. The floor keeps a mistyped 1 from
 * disabling retrieval outright; the ceiling keeps a mistyped 1500000 from
 * hanging a generation for half an hour. Agent Mode legitimately needs more than
 * this ceiling and gets it by ADDING its own planner/fanout budget on top --
 * see agenticRetrievalExtraBudgetMs() in core/retrieval-budget.js.
 */
export const RETRIEVAL_TIMEOUT_MIN_MS = 3000;
export const RETRIEVAL_TIMEOUT_MAX_MS = 120000;

/**
 * Agent Mode planner/fanout timeout defaults and clamp range. Shared by the
 * resolvers in core/retrieval-budget.js, the settings defaults in index.js, and
 * the input bindings in ui/ui-manager.js.
 *
 * These were three hand-kept copies of the same numbers, which is how the
 * planner default (30s) came to exceed the retrieval budget it runs inside (15s)
 * with nobody noticing -- GitHub issue #16.
 */
export const AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS = 30000;
export const AGENTIC_QUERY_TIMEOUT_DEFAULT_MS = 10000;
export const AGENTIC_TIMEOUT_MIN_MS = 1000;
export const AGENTIC_TIMEOUT_MAX_MS = 60000;

// =============================================================================
// RETRY CONFIGURATION
// =============================================================================

/** Maximum retry attempts for failed API calls */
export const RETRY_MAX_ATTEMPTS = 4;

/** Initial delay between retries in ms.
 *  Backoff schedule with maxDelay=8000 and multiplier=2 produces 5s, 8s, 8s
 *  (3 backoffs between 4 attempts). Worst-case wait under T-per-attempt is
 *  4T + 21s — chosen to fit inside the ~150s pair-spike window observed on
 *  OpenRouter embedding routing so a retry has a real chance of landing on a
 *  rotated upstream. See conversation 2026-05-30 — Doc/log.txt analysis. */
export const RETRY_INITIAL_DELAY_MS = 5000;

/** Maximum delay between retries in ms (caps the exponential growth at 8s) */
export const RETRY_MAX_DELAY_MS = 8000;

/** Backoff multiplier for exponential retry */
export const RETRY_BACKOFF_MULTIPLIER = 2;

// =============================================================================
// CHUNKING DEFAULTS
// =============================================================================

/** Default chunk size in characters */
export const DEFAULT_CHUNK_SIZE = 500;

/** Default overlap between chunks in characters */
export const DEFAULT_CHUNK_OVERLAP = 50;

/** Characters to search back when finding sentence boundaries */
export const SENTENCE_SEARCH_WINDOW = 50;

// =============================================================================
// CONDITIONAL ACTIVATION DEFAULTS
// =============================================================================

/** Default recency threshold for activation rules (messages ago) */
export const DEFAULT_RECENCY_THRESHOLD = 50;

// =============================================================================
// UI DEFAULTS
// =============================================================================

/** Default score threshold for vector search results */
export const DEFAULT_SCORE_THRESHOLD = 0.25;

/** Default number of chunks to insert into prompt */
export const DEFAULT_INSERT_COUNT = 5;

/** Default number of recent messages to use for query */
export const DEFAULT_QUERY_COUNT = 5;

/** Default number of messages to protect from vectorization */
export const DEFAULT_PROTECT_COUNT = 5;
