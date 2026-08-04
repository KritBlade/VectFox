/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API (Standard) or Qdrant.
 *
 * Functions:
 * - getVectorsRequestBody() - Builds request body for embedding providers
 * - getAdditionalArgs() - Special handling for WebLLM/KoboldCpp
 * - throwIfSourceInvalid() - Validates provider configuration
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 * - purgeFileVectorIndex() - DELETE file-specific collection
 *
 * @author Base: Cohee#1207 | VectFox: Backend abstraction
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings, modules } from '../../../../extensions.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
// Embedding-side: no key helpers needed here. vLLM, Ollama, and other
// "local-or-self-hosted" providers either resolve keys server-side via ST
// (vLLM → SECRET_KEYS.VLLM) or send no auth at all (Ollama — ST has no
// auth path for it). Cloud providers like OpenRouter route through ST's
// chat-completions proxy from elsewhere, not through this file.
import { oai_settings } from '../../../../openai.js';
import { isWebLlmSupported } from '../../../shared.js';
import { getWebLlmProvider } from '../providers/webllm.js';
import { getBackend, getBackendForCollection, invalidateBackendHealth, recordQuery, recordInsert, recordDelete, recordError } from '../backends/backend-manager.js';
import { parseRegistryKey, resolveBackendForCollection } from './collection-ids.js';
import {
    getProviderConfig,
    getModelField,
    getModelFromSettings,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    getUrlProviders,
    resolveProviderApiUrl
} from './providers.js';
import { isConnectionError, notifyConnectionError } from './model-config-notifier.js';
import { getOverfetchAmount } from './keyword-boost.js';
import { applyBM25Scoring, porterStemmer } from './bm25-scorer.js';
import { hybridSearch } from './hybrid-search.js';
import { extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken } from './query-keyword-extractor.js';
import { log } from './log.js';

/**
 * Lazy + best-effort cache invalidation for the corpus-IDF stats.
 *
 * Called from the chunk-write paths (insert / delete / purge). Any failure
 * here must NOT break the write — worst case is stale IDF until the next page
 * reload, which is the pre-fix behavior anyway. Dynamic import keeps the
 * corpus-stats module load deferred to when it's actually needed.
 */
async function _invalidateCorpusStats(collectionId, reason) {
    if (!collectionId) return;
    try {
        const mod = await import('./corpus-stats.js');
        mod.clearCorpusStatsCache(collectionId);
        log.trace(`[CorpusStats] Invalidated cache for ${collectionId} (${reason})`);
    } catch (err) {
        // Silent — invalidation is best-effort. Stale stats are acceptable;
        // a stack trace mid-write is not.
    }
}
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    RATE_LIMIT_CALLS,
    RATE_LIMIT_WINDOW_MS,
    API_TIMEOUT_MS,
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER
} from './constants.js';

// Get shared WebLLM provider singleton (lazy-initialized)
const webllmProvider = getWebLlmProvider();

/**
 * VEC-33: Wrapper for backend operations that invalidates health cache on error
 * @param {Function} operation - Async function that performs the backend operation
 * @param {object} settings - Settings object (used to determine backend name)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Re-throws the original error after invalidating cache
 */
async function withHealthInvalidation(operation, settings) {
    try {
        return await operation();
    } catch (error) {
        // Invalidate health cache for the backend that failed
        const backendName = settings?.vector_backend || 'standard';
        invalidateBackendHealth(backendName, error);
        throw error;
    }
}

/**
 * Rate limiter that respects user settings dynamically.
 */
export class DynamicRateLimiter {
    constructor() {
        this.timestamps = [];
    }

    /**
     * Executes a function if rate limits allow, or waits until they do.
     * @param {Function} fn Function to execute
     * @param {object} settings Settings containing rate_limit_calls and rate_limit_interval
     * @param {string} [label] Optional source tag for the "rate limit reached" log
     *   (e.g. 'embedding', 'extraction', 'agent') so logs are distinguishable now
     *   that more than one limiter instance exists.
     * @returns {Promise<any>} Result of the function
     */
    async execute(fn, settings, label = '') {
        const maxCalls = settings.rate_limit_calls || 0; // 0 = disabled
        const intervalMs = (settings.rate_limit_interval || 60) * 1000;

        if (maxCalls <= 0) {
            return await fn();
        }

        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < intervalMs);

        if (this.timestamps.length >= maxCalls) {
            // Calculate wait time
            const oldest = this.timestamps[0];
            const waitTime = (oldest + intervalMs) - now;

            if (waitTime > 0) {
                log.verbose(`VectFox: Rate limit reached${label ? ` [${label}]` : ''}. Waiting ${Math.round(waitTime / 1000)}s...`);
                await AsyncUtils.sleep(waitTime + 100); // Add small buffer
            }

            // Recursive call to re-check
            return this.execute(fn, settings, label);
        }

        // Add timestamp and execute
        this.timestamps.push(Date.now());
        return await fn();
    }
}

// Global rate limiter instance
const dynamicRateLimiter = new DynamicRateLimiter();

/**
 * Helper to batch array into chunks
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * callWithHedge — fire a duplicate request after a threshold to dodge connection-level
 * routing stalls on multi-upstream embedding providers (OpenRouter, SiliconFlow behind
 * the vllm slot, etc.). Race-first-wins via Promise — whoever finishes first settles.
 *
 * Why it works: routing affinity at OpenRouter and similar gateways is per-HTTP-connection.
 * Once your traffic lands on a stuck upstream, the SAME request stays stuck until ST's
 * 120s timeout fires. A NEW connection at t=15s gets a fresh routing decision and often
 * lands on a healthy upstream — confirmed 2026-05-30 (attempt 1 hung 120s, identical
 * payload on attempt 2 succeeded in 1.1s).
 *
 * Safety: same input → deterministic embedding → same hash → Qdrant upsert idempotent on
 * point ID. Whichever attempt wins, the data is correct. Late-arriving losers harmlessly
 * upsert the same point with identical data.
 *
 * Two triggers, one ordered sequence of hedges:
 *   - the fixed schedule (t = i × thresholdMs) covers the case this was built for, an
 *     attempt that hangs rather than returning;
 *   - an attempt that FAILS brings the next hedge forward immediately, because the
 *     schedule measures slowness and a failure is not slowness. Without this a fast
 *     failure just idles until its slot (measured 2026-08-04: a 0.7s insert failure
 *     waited 14.3s for t=15s).
 * Attempts still cap at maxHedges + 1 either way.
 *
 * Hedge-fatal: if all (maxHedges + 1) attempts fail, throw an error with
 * `name === 'HedgeFatalError'` and `isHedgeFatal === true` — immediately once the last
 * one fails, or at the hard cutoff at (maxHedges + 1) × thresholdMs if attempts are
 * still in flight. The shouldRetry filter in RETRY_CONFIG checks this flag and skips
 * retrying — the user can resume manually via Continue button. See
 * plans/embedding-resilience-hedge-and-diagnostics.md §6.
 *
 * @param {Function} fn - Async function to call (each invocation must be safe to repeat)
 * @param {number} thresholdMs - Time between attempts (e.g., 15000)
 * @param {number} maxHedges - Number of hedges to fire after primary (e.g., 3)
 * @param {object} ctx - { debugOn, batchIdx, totalBatches, provider } for logging
 * @returns {Promise<*>} - Result of the first attempt to succeed
 */
export async function callWithHedge(fn, thresholdMs, maxHedges, ctx) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timers = [];
        const errors = [];
        const { debugOn, batchIdx, totalBatches, provider } = ctx || {};

        const settle = (kind, val) => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            kind === 'ok' ? resolve(val) : reject(val);
        };

        const label = (i) => (i === 0 ? 'primary' : `hedge ${i}/${maxHedges}`);

        // Hedges fire in order, from either the fixed schedule below or early when an
        // attempt fails. Both routes go through startHedge, and each slot checks
        // `hedgesFired`, so a slot can never fire twice and the total attempt count
        // stays at maxHedges + 1.
        let hedgesFired = 0;
        let attemptsInFlight = 0;
        const hedgeTimers = new Map();

        const buildHedgeFatal = () => {
            const lastError = errors.length ? errors[errors.length - 1].error : null;
            const tail = lastError
                ? `last error: ${lastError?.name || 'Error'}: ${lastError?.message || lastError}`
                : `${maxHedges + 1} attempts still in-flight at cutoff, none returned`;
            const fatalErr = new Error(
                `Hedge fatal: ${maxHedges + 1} attempts to ${provider} over ${((maxHedges + 1) * thresholdMs) / 1000}s — ${tail}`,
            );
            fatalErr.name = 'HedgeFatalError';
            fatalErr.isHedgeFatal = true;
            return fatalErr;
        };

        const startHedge = (i, isEarly) => {
            if (settled || i > maxHedges) return;
            hedgesFired = i;
            const scheduled = hedgeTimers.get(i);
            if (scheduled) {
                clearTimeout(scheduled);
                hedgeTimers.delete(i);
            }
            if (debugOn) {
                log.warn(isEarly
                    ? `VectFox: hedge ${i}/${maxHedges} firing early — batch ${batchIdx}/${totalBatches} via ${provider} (previous attempt FAILED; not waiting for t=${(i * thresholdMs) / 1000}s)`
                    : `VectFox: hedge ${i}/${maxHedges} firing at t=${(i * thresholdMs) / 1000}s — batch ${batchIdx}/${totalBatches} via ${provider} (previous attempt still running)`);
            }
            fire(i);
        };

        const fire = (attemptIdx) => {
            const start = performance.now();
            attemptsInFlight++;
            fn().then(
                (r) => {
                    attemptsInFlight--;
                    if (settled) return; // someone else already won
                    if (attemptIdx > 0) {
                        // A hedge (not the primary) won — recovered-from anomaly.
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.warn(`VectFox: hedge — ${label(attemptIdx)} WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s`);
                    } else {
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.lifecycle(`VectFox: hedge — primary WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s`);
                    }
                    settle('ok', r);
                },
                (e) => {
                    attemptsInFlight--;
                    errors.push({ attemptIdx, error: e });
                    if (debugOn && !settled) {
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.warn(
                            `VectFox: hedge — ${label(attemptIdx)} FAILED after ${elapsed}s for batch ${batchIdx}/${totalBatches} — ${e?.name || 'Error'}: ${e?.message || e}`,
                        );
                    }
                    // Abort short-circuit: user pressed Stop, every future hedge would
                    // also bail with AbortError before even making the HTTP request,
                    // spamming the console for up to (maxHedges + 1) × thresholdMs (60s
                    // with defaults). Settle the whole race as failed immediately so
                    // the scheduled hedge timers' `!settled` check turns them into no-ops.
                    // Same applies to any abort propagated from the caller's signal.
                    // See 2026-05-30 bug: hedge kept firing for 60s after Stop.
                    if (e?.name === 'AbortError') {
                        settle('err', e);
                        return;
                    }
                    // Don't settle on other individual failures — later hedges may still
                    // succeed. But don't idle either. The schedule below measures "this
                    // attempt is slow", and a failure is not slowness: leaving the batch
                    // dead until the next slot comes round wastes the whole threshold.
                    // Measured 2026-08-04: an insert that 500'd after 0.7s sat idle for
                    // 14.3s waiting for t=15s, and the log claimed "primary still slow"
                    // about an attempt that had already failed.
                    if (settled) return;
                    if (hedgesFired < maxHedges) {
                        startHedge(hedgesFired + 1, true);
                        return;
                    }
                    // Last attempt, and nothing left in flight: every attempt has failed,
                    // so the hard cutoff below can only add dead time before saying so.
                    if (attemptsInFlight === 0) settle('err', buildHedgeFatal());
                },
            );
        };

        // Primary at t=0
        fire(0);

        // Schedule hedges at t=thresholdMs, 2×thresholdMs, ..., maxHedges×thresholdMs
        for (let i = 1; i <= maxHedges; i++) {
            const scheduled = setTimeout(() => {
                // A failure may already have brought this slot forward; the clock must
                // not fire it a second time.
                if (settled || hedgesFired >= i) return;
                startHedge(i, false);
            }, i * thresholdMs);
            hedgeTimers.set(i, scheduled);
            timers.push(scheduled);
        }

        // Hard fatal cutoff at t=(maxHedges + 1) × thresholdMs.
        // Catches both "all attempts failed" and "all attempts still in flight, none returned"
        // — either way, after 4 attempts to a routing-variant provider, more retries won't help.
        timers.push(setTimeout(() => {
            if (settled) return;
            settle('err', buildHedgeFatal());
        }, (maxHedges + 1) * thresholdMs));
    });
}

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: (error) => {
        // Hedge-fatal errors carry an isHedgeFatal flag. After hedge already
        // burned 4 fresh-connection attempts in ~60s without success, an
        // immediate outer retry would just trigger another 60s of hedge —
        // upstream is genuinely broken for our payload. Throw straight up to
        // the coordinator so the user can press Continue later. See
        // plans/embedding-resilience-hedge-and-diagnostics.md §6.5.
        if (error?.isHedgeFatal === true) return false;
        // Catch AbortSignal.timeout()'s DOMException ("TimeoutError" / message
        // "signal timed out") before the keyword fallback. The string "timed
        // out" is a separate word form from "timeout" and the keyword list
        // missed it, so OpenRouter embedding stalls that tripped ST's HTTP
        // timeout silently bypassed retry and killed the backfill mid-run.
        // See production failure 2026-05-30 10:26:26 — Doc/log.txt.
        if (error?.name === 'TimeoutError') return true;
        const message = error?.message?.toLowerCase() || '';
        const isRetryable =
            message.includes('network') ||
            message.includes('timeout') ||
            message.includes('timed out') ||
            message.includes('failed to fetch') ||
            message.includes('fetch') ||
            message.includes('suspended') ||
            message.includes('429') ||
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504');
        return isRetryable;
    }
};

/**
 * Strips HTML and Markdown formatting from text before embedding.
 * Uses StringUtils from ST-Helpers for consistent text cleaning.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function stripFormatting(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    // Strip HTML first, then Markdown
    let cleaned = StringUtils.stripHtml(text, true);
    cleaned = StringUtils.stripMarkdown(cleaned);
    return cleaned.trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @param {object} settings VectFox settings object
 * @returns {object} Request body
 */
export function getVectorsRequestBody(args = {}, settings) {
    const body = Object.assign({}, args);
    switch (settings.embedding_provider) {
        case 'openrouter':
            body.model = settings.embedding_openrouter_model;
            break;
        case 'ollama':
            body.model = settings.embedding_ollama_model;
            body.apiUrl = resolveProviderApiUrl(settings, 'ollama');
            body.keep = !!settings.ollama_keep;
            // No apiKey: ST has no ollama auth path. See backends/qdrant.js for
            // the full rationale.
            break;
        case 'vllm':
            body.apiUrl = resolveProviderApiUrl(settings, 'vllm')
                ?.replace(/\/$/, '')
                .replace(/\/v1\/embeddings$/, '')
                .replace(/\/embeddings$/, '');
            body.model = settings.embedding_vllm_model;
            // No apiKey passed: ST's vLLM embedding handler reads
            // SECRET_KEYS.VLLM server-side. See backends/standard.js for the
            // full rationale.
            break;
        // case 'extras': body.extrasUrl = extension_settings.apiUrl; body.extrasKey = extension_settings.apiKey; break;
        // case 'electronhub': body.model = settings.electronhub_model; break;
        // case 'togetherai': body.model = settings.togetherai_model; break;
        // case 'openai': body.model = settings.openai_model; break;
        // case 'cohere': body.model = settings.cohere_model; break;
        // case 'llamacpp': body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]; break;
        // case 'webllm': body.model = settings.webllm_model; break;
        // case 'palm': body.model = settings.google_model; body.api = 'makersuite'; break;
        // case 'vertexai': body.model = settings.google_model; body.api = 'vertexai'; body.vertexai_auth_mode = oai_settings.vertexai_auth_mode; body.vertexai_region = oai_settings.vertexai_region; body.vertexai_express_project_id = oai_settings.vertexai_express_project_id; break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for embeddings.
 * For client-side providers (webllm, koboldcpp), this generates embeddings.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<object>} Additional arguments
 */
export async function getAdditionalArgs(items, settings, onProgress = null) {
    const args = {};
    switch (settings.embedding_provider) {
        // case 'webllm': args.embeddings = await createWebLlmEmbeddings(items, settings); break;
        // case 'koboldcpp': { const { embeddings, model } = await createKoboldCppEmbeddings(items, settings, onProgress); args.embeddings = embeddings; args.model = model; break; }
    }
    return args;
}

/**
 * Creates WebLLM embeddings for a list of items.
 * Wrapped with retry and timeout for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @returns {Promise<Record<string, number[]>>} Calculated embeddings
 */
async function createWebLlmEmbeddings(items, settings) {
    if (items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }

    if (!isWebLlmSupported()) {
        throw new Error('VectFox: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }

    // Clean text before embedding
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    return await AsyncUtils.retry(async () => {
        const embedPromise = webllmProvider.embedTexts(cleanedItems, settings.webllm_model);
        const embeddings = await AsyncUtils.timeout(embedPromise, API_TIMEOUT_MS * 2, 'WebLLM embedding request timed out');

        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            // Map back to original items for hash consistency
            result[items[i]] = embeddings[i];
        }
        return result;
    }, {
        ...RETRY_CONFIG,
        onRetry: (attempt, error) => {
            log.warn(`VectFox: WebLLM embedding retry ${attempt} - ${error.message}`);
        }
    });
}

/**
 * Creates KoboldCpp embeddings for a list of items.
 * Wrapped with retry and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>} Calculated embeddings
 */
async function createKoboldCppEmbeddings(items, settings, onProgress = null) {
    // Clean text before embedding (strip HTML/Markdown)
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    // Batch size for progress tracking
    const BATCH_SIZE = 10;
    const allEmbeddings = /** @type {Record<string, number[]>} */ ({});
    let modelName = 'koboldcpp';

    // Process in batches to show progress
    for (let i = 0; i < cleanedItems.length; i += BATCH_SIZE) {
        const batchItems = cleanedItems.slice(i, Math.min(i + BATCH_SIZE, cleanedItems.length));
        const originalBatchItems = items.slice(i, Math.min(i + BATCH_SIZE, items.length));

        const result = await dynamicRateLimiter.execute(async () => {
            return await AsyncUtils.retry(async () => {
                const serverUrl = resolveProviderApiUrl(settings, 'koboldcpp');
                if (!serverUrl) {
                    throw new Error('KoboldCpp URL not found');
                }

                const cleanUrl = serverUrl.replace(/\/$/, '');
                const response = await fetch(`${cleanUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        input: batchItems,
                        model: settings.koboldcpp_model || 'koboldcpp',
                    }),
                });

                if (!response.ok) {
                    // Try legacy endpoint if v1 fails (fallback)
                    if (response.status === 404) {
                        log.warn('VectFox: KoboldCpp /v1/embeddings not found, trying legacy endpoint...');
                        // Fallthrough to retry or handle legacy?
                        // Better to throw specific error so we can potentially retry with legacy logic if we wanted,
                        // but for now let's stick to the directive of using OpenAI compatible endpoint.
                    }
                    throw new Error(`Failed to get KoboldCpp embeddings: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();

                // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
                if (!data.data || !Array.isArray(data.data) || data.data.length !== batchItems.length) {
                     throw new Error('Invalid response from KoboldCpp embeddings (OpenAI format)');
                }

                // Sort by index to ensure order matches items
                data.data.sort((a, b) => a.index - b.index);

                const batchEmbeddings = {};
                for (let j = 0; j < data.data.length; j++) {
                    const embedding = data.data[j].embedding;
                    if (!Array.isArray(embedding) || embedding.length === 0) {
                        throw new Error('KoboldCpp returned an empty embedding.');
                    }
                    // Map back to original items (not cleaned) for hash consistency
                    batchEmbeddings[originalBatchItems[j]] = embedding;
                }

                return {
                    embeddings: batchEmbeddings,
                    model: data.model || 'koboldcpp',
                };
            }, {
                ...RETRY_CONFIG,
                onRetry: (attempt, error) => {
                    log.warn(`VectFox: KoboldCpp embedding retry ${attempt} - ${error.message}`);
                }
            });
        }, settings);

        // Merge batch embeddings into all embeddings
        Object.assign(allEmbeddings, result.embeddings);
        modelName = result.model;

        // Call progress callback after each batch
        const embeddedSoFar = Math.min(i + BATCH_SIZE, items.length);
        if (onProgress) {
            log.verbose(`[KoboldCpp] Calling progress callback: ${embeddedSoFar}/${items.length}`);
            onProgress(embeddedSoFar, items.length);
        }
    }

    return {
        embeddings: allEmbeddings,
        model: modelName,
    };
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 * @param {object} settings VectFox settings object
 */
export function throwIfSourceInvalid(settings) {
    const source = settings.embedding_provider;
    const config = getProviderConfig(source);

    if (!config) {
        throw new Error(`VectFox: Unknown provider ${source}`, { cause: 'unknown_provider' });
    }

    // Check API key requirement
    if (requiresApiKey(source)) {
        const secretKey = getSecretKey(source);
        if (secretKey && !secret_state[secretKey]) {
            // Special case: VertexAI can use service account as fallback
            if (source === 'vertexai' && secret_state['VERTEXAI_SERVICE_ACCOUNT']) {
                // Service account auth is available, continue
            } else {
                throw new Error('VectFox: API key missing', { cause: 'api_key_missing' });
            }
        }
    }

    // Check URL requirement. resolveProviderApiUrl() reads the canonical
    // per-provider alt-endpoint keys and falls back to ST's native server URL,
    // so an empty result means nothing is configured for this provider.
    if (requiresUrl(source)) {
        if (!resolveProviderApiUrl(settings, source)) {
            throw new Error('VectFox: API URL missing', { cause: 'api_url_missing' });
        }
    }

    // Check model requirement
    if (config.requiresModel) {
        const modelField = getModelField(source);
        if (modelField && !settings[modelField]) {
            throw new Error('VectFox: API model missing', { cause: 'api_model_missing' });
        }
    }

    // Special case: extras requires embeddings module
    if (source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('VectFox: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    // Special case: WebLLM requires browser support
    if (source === 'webllm' && !isWebLlmSupported()) {
        throw new Error('VectFox: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Gets the saved hashes for a collection
 * @param {string} collectionId Collection ID
 * @param {object} settings VectFox settings object
 * @param {boolean} includeMetadata If true, returns {hashes: [], metadata: []} instead of just hashes
 * @returns {Promise<number[]|{hashes: number[], metadata: object[]}>} Saved hashes or full data
 */
export async function getSavedHashes(collectionId, settings, includeMetadata = false) {
    const backend = await getBackend(settings);
    const hashes = await backend.getSavedHashes(collectionId, settings);

    if (!includeMetadata) {
        return hashes;
    }

    // Use unified chunks API to get full metadata (works with all backends)
    try {
        const backendName = settings.vector_backend || 'standard';
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendName === 'standard' ? 'vectra' : backendName,
                collectionId: collectionId,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
                limit: 10000
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success && data.items) {
                return {
                    hashes: hashes,
                    metadata: data.items.map(item => item.metadata || item)
                };
            }
        }
    } catch (error) {
        log.warn('VectFox: Failed to get full metadata from chunks API, returning hashes only', error);
    }

    // Fallback: return hashes as array (old format)
    return hashes;
}

/**
 * Inserts vector items into a collection
 * Handles batching and rate limiting.
 * For client-side embedding sources (webllm, koboldcpp), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<void>}
 */
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp'];

    try {
        // If source requires client-side embeddings, use streaming approach
        if (clientSideEmbeddingSources.includes(settings.embedding_provider)) {
            log.lifecycle(`VectFox: Streaming embeddings and writing for ${settings.embedding_provider}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal);
        } else {
            // Server-side embeddings - backend handles everything
            // VEC-6: Use configurable batch size for optimized bulk inserts
            // Some providers need smaller batches - Ollama and Transformers work best with batch size of 1
            // Qdrant with local GPU sources (transformers/ollama/llamacpp) also defaults to 1:
            // the Similharity server embeds all items in a single HTTP request sequentially,
            // so 5 items = 5×T on the GPU inside one request, which 504s for large models.
            // Sending 1 item per call keeps each request under the gateway timeout.
            // API-based sources (openai, openrouter, etc.) can batch safely — the server
            // runs those in parallel so total time stays ~T regardless of item count.
            const localGpuSources = new Set(['transformers', 'ollama', 'llamacpp', 'koboldcpp']);
            const configuredBatchSize = settings.insert_batch_size || 50;
            const hasExplicitBatchSize = !!settings.insert_batch_size;
            const hasRateLimit = settings.rate_limit_calls > 0;

            // Parallel-split insert — see plans/embedding-resilience-hedge-and-diagnostics.md §5.
            // Default behavior: each event becomes its own embedding+insert POST, fired in
            // parallel waves. Contains the blast radius when ONE upstream worker is stuck
            // (SiliconFlow, vLLM-the-software) or ONE routing decision is bad (OpenRouter) —
            // the stuck item retries in isolation while the rest finish normally.
            //
            // The `vector_group_embedding_call` setting (UI checkbox in the Core tab →
            // Embedding section — path-agnostic, applies to every caller of insertVectorItems
            // including EventBase ingestion AND content/document vectorization in
            // content-vectorization.js). Default unchecked. Checking it
            // opts INTO the legacy production behavior: a single batched POST containing all
            // items. Cheaper (fewer HTTP calls) but ONE stuck item hangs the WHOLE batch —
            // see the 555s monster batches observed 2026-05-30.
            //
            // Gated to non-local, non-rate-limited providers regardless of the setting —
            // Ollama already uses batch=1 sequentially, and rate-limit requires serial
            // execution via dynamicRateLimiter.
            const groupEmbeddingCall = settings?.vector_group_embedding_call === true;
            const shouldParallelSplit = (
                !groupEmbeddingCall
                && !localGpuSources.has(settings.embedding_provider)
                && !hasRateLimit
                && items.length > 1
            );

            // Force 1-item batches for local GPU sources unless user overrides explicitly.
            // Also force 1-item batches when parallel-split experiment is active.
            const BATCH_SIZE = shouldParallelSplit
                ? 1
                : ((!hasExplicitBatchSize && localGpuSources.has(settings.embedding_provider)) ? 1 : configuredBatchSize);
            const batches = chunkArray(items, BATCH_SIZE);

            log.verbose(`VectFox: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}${shouldParallelSplit ? ` [parallel-split: ${batches.length} concurrent POSTs in waves of up to 16]` : ''}`);

            if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });

            // Hedge gating — opt-in via `vector_hedge_after_ms` setting (0 = off).
            // Skipped for local providers where opening a new HTTP connection wouldn't
            // change routing (Ollama / transformers / llama.cpp / KoboldCpp all land on
            // the same single endpoint regardless of connection identity).
            // See plans/embedding-resilience-hedge-and-diagnostics.md §6.
            const rawHedgeAfterMs = Number(settings?.vector_hedge_after_ms) || 0;
            const HEDGE_MAX_COUNT = 3;
            const hedgeEnabled = (
                rawHedgeAfterMs > 0
                && !localGpuSources.has(settings.embedding_provider)
            );
            const hedgeAfterMs = hedgeEnabled ? rawHedgeAfterMs : 0;

            if (hedgeEnabled) {
                log.lifecycle(`VectFox: hedge enabled — threshold ${hedgeAfterMs}ms, max ${HEDGE_MAX_COUNT} hedges, total budget ${((HEDGE_MAX_COUNT + 1) * hedgeAfterMs) / 1000}s per insert call`);
            }

            // Factored-out per-batch retry+log closure shared by serial and parallel paths.
            // Each invocation gets its OWN attempt counter and timing — under parallel-split
            // the per-item logs interleave but each line carries `batch X/Y` so they remain
            // attributable.
            const makeProcessBatch = (batch, batchIdx, batchItemCount) => async () => {
                let attemptCount = 0;
                await AsyncUtils.retry(async () => {
                    attemptCount++;
                    const attemptStart = performance.now();
                    const debugOn = log.enabled('verbose');
                    log.verbose(
                        `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} — POST ${batchItemCount} item(s) via ${settings.embedding_provider}${hedgeEnabled ? ' [hedge armed]' : ''}`,
                    );
                    try {
                        if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                        const insertCall = () => backend.insertVectorItems(collectionId, batch, settings, abortSignal);
                        if (hedgeEnabled) {
                            await callWithHedge(insertCall, hedgeAfterMs, HEDGE_MAX_COUNT, {
                                debugOn,
                                batchIdx,
                                totalBatches: batches.length,
                                provider: settings.embedding_provider,
                            });
                        } else {
                            await insertCall();
                        }
                        if (attemptCount > 1) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            log.verbose(
                                `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount} succeeded after ${elapsed}s`,
                            );
                        }
                    } catch (err) {
                        // Per-attempt failure log with elapsed time + provider + batch size.
                        // Without elapsed, "TimeoutError: signal timed out" tells you
                        // nothing — was it a fast connection refusal or a 120s upstream
                        // stall? Knowing the duration distinguishes "vLLM is down" (fails
                        // in <1s) from "OpenRouter routing storm" (fails at exactly
                        // ST's ~120s HTTP timeout). The provider/items context narrows
                        // where in the call chain it died: ST request → embedding
                        // provider call → Qdrant upsert.
                        if (debugOn) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            log.warn(
                                `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} FAILED after ${elapsed}s — ${err?.name || 'Error'}: ${err?.message || err} (provider=${settings.embedding_provider}, items=${batchItemCount})`,
                            );
                        }
                        throw err;
                    }
                }, RETRY_CONFIG);
            };

            if (shouldParallelSplit) {
                // Parallel waves of up to MAX_PARALLEL concurrent inserts. Each batch is 1
                // item with its own RETRY_CONFIG budget. Promise.allSettled lets all in-flight
                // finish even if one fails — successful ones are durable in Qdrant. If any
                // failed after retries, throw composite so the coordinator marks the WHOLE
                // batch failed (windows stay unmarked; resume re-extracts and hash-deterministic
                // upsert idempotently re-inserts the already-durable items).
                const MAX_PARALLEL = 16;
                for (let wave = 0; wave < batches.length; wave += MAX_PARALLEL) {
                    const slice = batches.slice(wave, wave + MAX_PARALLEL);
                    const results = await Promise.allSettled(
                        slice.map((batch, idx) => {
                            const processBatch = makeProcessBatch(batch, wave + idx + 1, batch.length);
                            return processBatch();
                        }),
                    );
                    const failed = results.filter(r => r.status === 'rejected');
                    if (failed.length > 0) {
                        const sample = failed[0].reason;
                        // Hedge-fatal propagation: if ANY of the wave's failures hit hedge-fatal
                        // (4 fresh-connection attempts in 60s with no success), the upstream is
                        // genuinely broken for our payload. Propagating isHedgeFatal lets the
                        // OUTER _insertWithRetry short-circuit and avoid burning 12+ minutes
                        // per retry × N retries on a wave that's certain to fail again the
                        // same way. Without this, the composite Error would hide the flag and
                        // the outer retry would re-run the whole 12-batch hedged wave 3 times
                        // (~36 minutes). Observed 2026-05-30 with similharity plugin 2.1MB
                        // truncated-JSON 500s under parallel-split + hedge concurrent load.
                        const anyHedgeFatal = failed.some(f => f.reason?.isHedgeFatal === true);
                        const composite = new Error(
                            `VectFox: ${failed.length}/${slice.length} parallel inserts in wave failed — first failure: ${sample?.name || 'Error'}: ${sample?.message || sample}`,
                        );
                        if (anyHedgeFatal) {
                            composite.name = 'HedgeFatalError';
                            composite.isHedgeFatal = true;
                        }
                        throw composite;
                    }
                    if (onProgress) {
                        onProgress(Math.min(wave + slice.length, items.length), items.length);
                    }
                }
            } else {
                // Existing serial path — preserves rate-limited and local-GPU semantics.
                for (let i = 0; i < batches.length; i++) {
                    const processBatch = makeProcessBatch(batches[i], i + 1, batches[i].length);
                    if (hasRateLimit) {
                        await dynamicRateLimiter.execute(processBatch, settings);
                    } else {
                        await processBatch();
                    }
                    if (onProgress) {
                        const embeddedCount = (i + 1) * BATCH_SIZE;
                        const actualEmbedded = Math.min(embeddedCount, items.length);
                        onProgress(actualEmbedded, items.length);
                    }
                }
            }
        }

        // VEC-18: Record successful insert operation
        recordInsert(settings?.vector_backend || 'standard', items.length);
        // Stale-stats fix: chunks just changed → next BM25 corpus-IDF query
        // must rebuild instead of returning pre-write df values. Fire-and-forget.
        _invalidateCorpusStats(collectionId, `insert ${items.length} item(s)`);
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Stream embeddings and write to database as batches complete
 * @param {object} backend - The backend instance
 * @param {string} collectionId - Collection ID
 * @param {Array} items - Original items
 * @param {string[]} textStrings - Text strings extracted from items
 * @param {object} settings - Settings object
 * @param {Function} onProgress - Progress callback
 */
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal = null) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    log.lifecycle(`VectFox: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

        log.verbose(`VectFox: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);

        // VEC-6: Retry logic per batch instead of per chunk
        let additionalArgs;
        try {
            additionalArgs = await AsyncUtils.retry(async () => {
                return await getAdditionalArgs(batchTextStrings, settings);
            }, RETRY_CONFIG);
        } catch (error) {
            // A wrong/unreachable embedding URL surfaces here, NOT at the DB-write
            // step below — so a connection failure must be reported as an embedder
            // problem, not a storage one (the #4/#5 conflation). Resolve the
            // configured embedding URL (URL-based providers only) for the toast.
            if (isConnectionError(error?.message)) {
                let embedUrl = null;
                try { embedUrl = resolveProviderApiUrl(settings, settings.embedding_provider) || null; } catch (_) { /* not a URL provider */ }
                notifyConnectionError('Embedding', embedUrl, error.message);
            }
            throw Object.assign(
                new Error(`VectFox: Failed to generate embeddings for batch ${batchNum} after retries: ${error.message}`),
                { code: 'embedding_generation_failed' },
            );
        }

        if (!additionalArgs.embeddings) {
            throw new Error(`VectFox: No embeddings returned from ${settings.embedding_provider} for batch ${batchNum}`);
        }

        // Attach embeddings to items and validate
        let missingEmbeddings = 0;
        const itemsToWrite = [];

        for (let j = 0; j < batchItems.length; j++) {
            const text = batchTextStrings[j];
            const embedding = additionalArgs.embeddings[text];

            if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                // Validate embedding values
                const isValidEmbedding = embedding.every(val => typeof val === 'number' && !isNaN(val));
                if (!isValidEmbedding) {
                    log.error(`VectFox: Invalid embedding values for item ${i + j}:`, embedding.slice(0, 5));
                    missingEmbeddings++;
                    continue;
                }
                batchItems[j].vector = embedding;
                itemsToWrite.push(batchItems[j]);
            } else {
                missingEmbeddings++;
                log.warn(`VectFox: No embedding found for item ${i + j}, text: "${text.substring(0, 50)}..."`);
            }
        }

        if (missingEmbeddings > 0) {
            throw new Error(`VectFox: Failed to generate embeddings for ${settings.embedding_provider} - ${missingEmbeddings} items missing in batch`);
        }

        // VEC-6: Write batch to database with retry logic
        log.verbose(`VectFox: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        try {
            await AsyncUtils.retry(async () => {
                if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                await backend.insertVectorItems(collectionId, itemsToWrite, settings, abortSignal);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectFox: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;

        // Update progress
        if (onProgress) {
            log.verbose(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length);
        }
    }

    log.lifecycle(`VectFox: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function deleteVectorItems(collectionId, hashes, settings) {
    const backend = await getBackend(settings);
    try {
        // VEC-33: Wrap with health invalidation
        const result = await withHealthInvalidation(
            () => backend.deleteVectorItems(collectionId, hashes, settings),
            settings
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        // Stale-stats fix: corpus shrank.
        _invalidateCorpusStats(collectionId, `delete ${hashes?.length || 0} hash(es)`);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * For client-side embedding sources (webllm, koboldcpp), generates query embedding first.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectFox settings object
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) {
    // Canonical routing (Doc/collection_helper.md): resolveBackendForCollection accepts either form
    //   (registry-key "backend:id" or bare ID) and returns the backend label
    //   plus the BARE collectionId for downstream calls. Falls back to
    //   getBackend(settings) only when BOTH resolution paths fail, which
    //   should never happen for a well-formed VectFox collection ID.
    const resolved = resolveBackendForCollection(collectionId);
    const bareCollectionId = resolved.collectionId;
    const backend = resolved.backend
        ? await getBackendForCollection(resolved.backend, settings)
        : await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp'];
    let queryVector = null;

    // If source requires client-side embeddings, generate query vector
    if (clientSideEmbeddingSources.includes(settings.embedding_provider)) {
        const queryItem = [searchText];
        try {
            const additionalArgs = await getAdditionalArgs(queryItem, settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
                log.verbose(`[EventBase] Embedding model (${settings.embedding_provider}) returned vector: dim=${queryVector.length}, first5=[${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}], last5=[${queryVector.slice(-5).map(v => v.toFixed(4)).join(', ')}], model=${additionalArgs.model || 'n/a'}`);
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                log.warn(`[VectFox] Client-side embedding generation returned empty result for ${settings.embedding_provider}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            log.warn(`[VectFox] Client-side embedding failed for ${settings.embedding_provider}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Append concepts_any terms to the query text so BM25 naturally boosts events containing
    // those theme words — without hard-filtering anything out. Dense vector stays clean for
    // client-side embedding paths because queryVector is already captured above.
    let effectiveQuery = searchText;
    if (Array.isArray(filters.concepts_any) && filters.concepts_any.length > 0) {
        effectiveQuery = `${searchText} ${filters.concepts_any.join(' ')}`;
        if (log.enabled('lifecycle')) {
            log.verbose(`[VectFox] concepts_any appended to query text: [${filters.concepts_any.join(', ')}]`);
        }
    }

    // Three-case routing:
    //   A3 — server-side hybrid (Qdrant with prefer_native ON) — dense vector search +
    //         full-corpus payload/text keyword matching via Qdrant scroll, fused in plugin code
    //         (NOT Qdrant native dense+sparse-vector hybrid; no sparse vectors stored)
    //   A2 — client-side hybrid over ANN candidates (standard backend, method = 'hybrid')
    //   A1 — BM25 re-rank of ANN top-K (standard backend default, method = 'bm25')
    const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
    const preferNative = settings.hybrid_native_prefer !== false;
    const useHybridPath = (nativeHybridAvailable && preferNative) || settings.keyword_scoring_method === 'hybrid';

    if (useHybridPath) {
        if (log.enabled('lifecycle')) {
            const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
            log.verbose(`[VectFox] Hybrid search (${reason}), dispatching to hybrid search module`);
        }
        const queryStart = Date.now();
        try {
            const result = await hybridSearch(bareCollectionId, effectiveQuery, topK, settings, { queryVector, filters });
            const queryLatency = Date.now() - queryStart;
            recordQuery(resolved.backend || settings?.vector_backend || 'standard', queryLatency);
            if (log.enabled('lifecycle')) {
                const scores = (result.metadata || []).map(m => (m.score ?? 0).toFixed(4));
                const fusionMethod = (settings.hybrid_fusion_method || 'rrf').toUpperCase();
                log.verbose(`[VectFox] Hybrid search (${fusionMethod}) response: ${result.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
            }
            return result;
        } catch (error) {
            recordError(resolved.backend || settings?.vector_backend || 'standard', error);
            throw error;
        }
    }

    // Standard vector search flow (A1/A2). Filters are not supported here.
    if (Object.keys(filters).length > 0 && log.enabled('lifecycle')) {
        log.warn('[VectFox] queryCollection: filters ignored on A1/A2 Standard backend path');
    }
    // Overfetch to allow keyword-boosted chunks to surface
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    // Backend name for metrics — resolved backend wins, fall back to settings.
    const actualBackendName = resolved.backend || settings?.vector_backend || 'standard';
    try {
        rawResults = await backend.queryCollection(bareCollectionId, effectiveQuery, overfetchAmount, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(actualBackendName, queryLatency);
        if (log.enabled('lifecycle')) {
            const scores = (rawResults.metadata || []).map(m => (m.score ?? 0).toFixed(4));
            log.verbose(`[EventBase] Embedding search response: ${rawResults.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
        }
    } catch (error) {
        // VEC-18: Record query error
        recordError(actualBackendName, error);
        throw error;
    }

    // Convert to format expected by keyword boost
    const resultsForBoost = rawResults.metadata.map((meta, idx) => ({
        hash: rawResults.hashes[idx],
        score: meta.score || 0,
        metadata: meta,
        text: meta.text || ''
    }));

    let finalResults = await scoreResults(resultsForBoost, effectiveQuery, topK, settings, bareCollectionId);

    if (log.enabled('trace')) {
        const idfMode = settings.bm25_use_corpus_idf ? 'corpus-IDF' : 'local-IDF';
        finalResults.forEach((r, i) => {
            log.trace(`[VectFox] #${i + 1} final=${r.score?.toFixed(4)} vector=${r.vectorScore?.toFixed(4) ?? 'n/a'} bm25=${r.bm25Score?.toFixed(4) ?? 'n/a'} (A1 BM25 re-rank, ${idfMode})`);
        });
    }

    // Convert back to expected format
    return {
        hashes: finalResults.map(r => r.hash),
        metadata: finalResults.map(r => ({
            ...r.metadata,
            score: r.score,
            originalScore: r.originalScore || r.vectorScore,
            keywordBoost: r.keywordBoost,
            bm25Score: r.bm25Score,
            normalizedBM25: r.normalizedBM25,
            vectorScore: r.vectorScore,
            matchedKeywords: r.matchedKeywords,
            matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
            keywordBoosted: r.keywordBoosted
        }))
    };
}

async function scoreResults(resultsForBoost, searchText, topK, settings, collectionId = null) {
    // Short-circuit: nothing to re-rank means no need to extract keywords or run BM25.
    if (!resultsForBoost || resultsForBoost.length === 0) {
        return [];
    }

    // A1 — BM25 re-rank over ANN top-K candidates only (no full corpus scan)
    const level = settings?.hybrid_keyword_level || 'balance';
    const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[level]?.maxKeywords ?? 50;
    const rawKeywords = extractQueryKeywords(searchText, maxKeywords, settings?.cjk_tokenizer_mode);
    const queryTokens = rawKeywords.map(token => isCJKToken(token) ? token : porterStemmer(token));

    // Optional: full-corpus IDF (A/B toggle in Core → Hybrid Search & BM25).
    // Fetches and tokenizes every chunk of the collection on first use, then
    // caches in-memory for the session.
    //
    // Hardening: this is an *enhancement* on top of valid vector results. Any
    // failure — module load error, network blip, plugin 5xx, tokenizer crash —
    // must NOT discard the ANN results. We catch every failure mode, log it
    // clearly, and continue with corpusStats=null (= local-IDF BM25, the
    // pre-toggle default). Without this, a single ./corpus-stats.js import
    // error bubbles up through scoreResults → queryCollection →
    // eventbase-retrieval.js:400 catch, which discards every match.
    let corpusStats = null;
    if (settings?.bm25_use_corpus_idf === true && collectionId) {
        try {
            const mod = await import('./corpus-stats.js');
            corpusStats = await mod.getCorpusStats(collectionId, settings);
            if (!corpusStats && log.enabled('lifecycle')) {
                log.warn(`[VectFox] Corpus-IDF disabled for ${collectionId}: getCorpusStats returned null (plugin unavailable or /chunks/list failed). Falling back to local-IDF BM25.`);
            }
        } catch (err) {
            log.warn(`[VectFox] Corpus-IDF unavailable for ${collectionId}, falling back to local-IDF BM25. Reason: ${err?.message || err}`);
            corpusStats = null;
        }
    }

    const bm25Results = applyBM25Scoring(resultsForBoost, searchText, {
        k1: settings.bm25_k1 || 1.5,
        b: settings.bm25_b || 0.75,
        alpha: 0.5,
        beta: 0.5,
        queryTokens,
        corpusStats,
    });
    return bm25Results.slice(0, topK);
}

/**
 * Queries multiple collections for a given text.
 * For client-side embedding sources, generates query embedding once and reuses for all collections.
 * @param {string[]} collectionIds - Collection IDs to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings VectFox settings object
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp'];
    let queryVector = null;

    // Generate query vector once for all collections (efficiency)
    if (clientSideEmbeddingSources.includes(settings.embedding_provider)) {
        try {
            // getAdditionalArgs expects string[], not objects
            const additionalArgs = await getAdditionalArgs([searchText], settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                log.warn(`[VectFox] Client-side embedding generation returned empty result for ${settings.embedding_provider}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            log.warn(`[VectFox] Client-side embedding failed for ${settings.embedding_provider}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Three-case routing (mirrors queryCollection):
    //   A3/A2 — native or client-side hybrid per collection
    //   A1    — BM25 re-rank after bulk ANN (below)
    const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
    const preferNative = settings.hybrid_native_prefer !== false;
    const useHybridPath = (nativeHybridAvailable && preferNative) || settings.keyword_scoring_method === 'hybrid';

    if (useHybridPath) {
        if (log.enabled('lifecycle')) {
            const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
            log.verbose(`[VectFox] Hybrid search (${reason}) for multi-collection query`);
        }
        const processedResults = {};
        for (const collectionId of collectionIds) {
            try {
                const queryStart = Date.now();
                processedResults[collectionId] = await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
                const queryLatency = Date.now() - queryStart;
                recordQuery(settings?.vector_backend || 'standard', queryLatency);
            } catch (error) {
                log.warn(`[VectFox] Hybrid search failed for ${collectionId}:`, error.message);
                recordError(settings?.vector_backend || 'standard', error);
                processedResults[collectionId] = { hashes: [], metadata: [] };
            }
        }
        return processedResults;
    }

    // Standard vector search flow
    // Get raw results from backend (with overfetch for each collection)
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryMultipleCollections(collectionIds, searchText, overfetchAmount, threshold, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(settings?.vector_backend || 'standard', queryLatency);
    } catch (error) {
        // VEC-18: Record query error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }

    // Apply scoring to each collection's results
    const processedResults = {};

    for (const [collectionId, collectionResults] of Object.entries(rawResults)) {
        if (!collectionResults || !collectionResults.metadata) {
            processedResults[collectionId] = collectionResults;
            continue;
        }

        // Convert to format expected by scoring functions
        const resultsForBoost = collectionResults.metadata.map((meta, idx) => ({
            hash: collectionResults.hashes[idx],
            score: meta.score || 0,
            metadata: meta,
            text: meta.text || ''
        }));

        let finalResults = await scoreResults(resultsForBoost, searchText, topK, settings, collectionId);

        // Convert back to expected format
        processedResults[collectionId] = {
            hashes: finalResults.map(r => r.hash),
            metadata: finalResults.map(r => ({
                ...r.metadata,
                score: r.score,
                originalScore: r.originalScore || r.vectorScore,
                keywordBoost: r.keywordBoost,
                bm25Score: r.bm25Score,
                normalizedBM25: r.normalizedBM25,
                vectorScore: r.vectorScore,
                matchedKeywords: r.matchedKeywords,
                matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
                keywordBoosted: r.keywordBoosted
            }))
        };
    }

    return processedResults;
}

/**
 * Queries multiple collections with conditional activation filtering.
 * Collections that don't meet their activation conditions are skipped.
 *
 * @param {string[]} collectionIds - Collection IDs to potentially query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings - VectFox settings object
 * @param {object} context - Search context (from buildSearchContext)
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) {
    // Lazy import to avoid circular dependency
    const { filterActiveCollections } = await import('./collection-metadata.js');

    // Filter collections based on their activation conditions
    const activeCollectionIds = await filterActiveCollections(collectionIds, context);

    if (activeCollectionIds.length === 0) {
        log.lifecycle('VectFox: No collections passed activation conditions');
        return {};
    }

    // Query only the active collections
    const backend = await getBackend(settings);
    return await backend.queryMultipleCollections(activeCollectionIds, searchText, topK, threshold, settings);
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
export async function purgeVectorIndex(collectionId, settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeVectorIndex(collectionId, settings);
        log.lifecycle(`VectFox: Purged vector index for collection ${collectionId}`);
        // Stale-stats fix: entire collection is gone.
        _invalidateCorpusStats(collectionId, 'purge');
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge', error);
        return false;
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeFileVectorIndex(collectionId, settings) {
    try {
        log.lifecycle(`VectFox: Purging file vector index for collection ${collectionId}`);
        const backend = await getBackend(settings);
        await backend.purgeFileVectorIndex(collectionId, settings);
        log.lifecycle(`VectFox: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge file', error);
    }
}

/**
 * Purges all vector indexes.
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeAllVectorIndexes(settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeAllVectorIndexes(settings);
        log.lifecycle('VectFox: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

/**
 * List chunks in a collection
 * Routes through the active backend so model is resolved via getModelFromSettings,
 * not from a stale collection.model field.
 * @param {string} collectionId - Collection ID
 * @param {object} settings - VectFox settings (must include vector_backend + source)
 * @param {object} options - {offset, limit, includeVectors}
 * @returns {Promise<{items: Array<{hash, text, metadata}>, total: number}>}
 */
export async function listChunks(collectionId, settings, options = {}) {
    const backend = await getBackend(settings);
    return await backend.listChunks(collectionId, settings, options);
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectFox settings
 */
export async function updateChunkText(collectionId, hash, newText, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkText(collectionId, hash, newText, settings);
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectFox settings
 */
export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkMetadata(collectionId, hash, metadata, settings);
}
