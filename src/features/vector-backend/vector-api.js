/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API (Standard) or Qdrant.
 *
 * Functions:
 * - getAdditionalArgs() - Client-side embedding arguments (no provider produces any)
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 *
 * @author Base: Cohee#1207 | VectFox: Backend abstraction
 * ============================================================================
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
// Embedding-side: no key helpers needed here. vLLM, Ollama, and other
// "local-or-self-hosted" providers either resolve keys server-side via ST
// (vLLM → SECRET_KEYS.VLLM) or send no auth at all (Ollama — ST has no
// auth path for it). Cloud providers like OpenRouter route through ST's
// chat-completions proxy from elsewhere, not through this file.
import { getBackend, getBackendForCollection, invalidateBackendHealth, recordQuery, recordInsert, recordDelete, recordError } from './backend-registry.js';
import { resolveBackendForCollection } from '../../shared/collection-ids.js';
import {
    getModelFromSettings,
    resolveProviderApiUrl
} from '../embedding/index.js';
import { isConnectionError, notifyConnectionError } from '../../shared/model-config-notifier.js';
import {
    getOverfetchAmount,
    applyBM25Scoring,
    porterStemmer,
    extractQueryKeywords,
    RETRIEVAL_KEYWORD_LEVELS,
    isCJKToken,
} from '../keyword-search/index.js';
import { hybridSearch } from './hybrid-search.js';
import { log } from '../../sillytavern/log.js';

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
        log.warn(`[CorpusStats] Cache invalidation failed for ${collectionId}:`, err);
    }
}
import { retry } from '../../shared/retry.js';
import {
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER
} from '../../shared/constants.js';

// Get shared WebLLM provider singleton (lazy-initialized)

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
                await new Promise(resolve => setTimeout(resolve, waitTime + 100)); // Add small buffer
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
 * lands on a healthy upstream: an attempt that hung for 120s has succeeded in 1.1s when
 * the identical payload was resent.
 *
 * Safety: same input → deterministic embedding → same hash → Qdrant upsert idempotent on
 * point ID. Whichever attempt wins, the data is correct. Late-arriving losers harmlessly
 * upsert the same point with identical data.
 *
 * Two triggers, one ordered sequence of hedges:
 *   - the fixed schedule (t = i × thresholdMs) covers an attempt that hangs rather than
 *     returning;
 *   - an attempt that FAILS brings the next hedge forward immediately, because the
 *     schedule measures slowness and a failure is not slowness. Without this a fast
 *     failure just idles until its slot (a 0.7s insert failure would wait 14.3s for
 *     t=15s).
 * Attempts still cap at maxHedges + 1 either way.
 *
 * Hedge-fatal: if all (maxHedges + 1) attempts fail, throw an error with
 * `name === 'HedgeFatalError'` and `isHedgeFatal === true` — immediately once the last
 * one fails, or at the hard cutoff at (maxHedges + 1) × thresholdMs if attempts are
 * still in flight. The shouldRetry filter in RETRY_CONFIG checks this flag and skips
 * retrying — the user can resume manually via Continue button. See
 * InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.
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

        // Why the winning hedge was needed, for its always-on WON line. Each failed
        // attempt's reason is otherwise logged only with verbose logging on, which
        // left a bare "500 (Internal Server Error)" as the only clue in the console.
        // With no failure, the winner fired on the clock because the attempt before
        // it was still running.
        const describeHedgeCause = (winnerIdx) => (errors.length > 0
            ? errors.map(({ attemptIdx, error, elapsed }) =>
                `${label(attemptIdx)} FAILED after ${elapsed}s — ${error?.name || 'Error'}: ${error?.message || error}`).join('; ')
            : `previous attempt still running at t=${(winnerIdx * thresholdMs) / 1000}s`);

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
                        log.warn(`VectFox: hedge — ${label(attemptIdx)} WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s (${describeHedgeCause(attemptIdx)})`);
                    } else {
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.lifecycle(`VectFox: hedge — primary WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s`);
                    }
                    settle('ok', r);
                },
                (e) => {
                    attemptsInFlight--;
                    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                    errors.push({ attemptIdx, error: e, elapsed });
                    if (debugOn && !settled) {
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
                    if (e?.name === 'AbortError') {
                        settle('err', e);
                        return;
                    }
                    // Don't settle on other individual failures — later hedges may still
                    // succeed. But don't idle either: the schedule below measures "this
                    // attempt is slow", and a failure is not slowness. Waiting for the
                    // next slot would leave an insert that failed at 0.7s idle until
                    // t=15s, so a failure starts the next hedge at once.
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

// Retry configuration for transient failures: the options of retry() (src/shared/retry.js)
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
        // InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.5.
        if (error?.isHedgeFatal === true) return false;
        // Catch AbortSignal.timeout()'s DOMException ("TimeoutError" / message
        // "signal timed out") before the keyword fallback: "timed out" does not
        // contain "timeout", so the keyword list alone would not retry a request
        // that hit its timeout.
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
 * Gets additional arguments for embeddings: the client-side embeddings of a provider that
 * embeds in the browser. No provider does, so this returns {} and every caller takes the
 * server-side path.
 * @returns {Promise<object>} Additional arguments
 */
export async function getAdditionalArgs() {
    return {};
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
            // Server-side embeddings - backend handles everything.
            // Local GPU sources (transformers/ollama/llamacpp) always send 1 item per request.
            // The server embeds one request's items one after another, so N items cost N×T
            // inside a single request and a long batch runs past the 120s request timeout.
            // One item per request also stops an item that fails to embed (e.g. Transformers
            // running out of WASM memory on an over-long chunk) from failing the items
            // batched with it. The embedding API rate limit does not apply to them: it guards
            // a provider's request quota, and a local server has none.
            // API-based sources send up to insert_batch_size items per request; how the
            // server embeds a batch per provider is in Doc/dev_helper.md §6.
            const localGpuSources = new Set(['transformers', 'ollama', 'llamacpp', 'koboldcpp']);
            const isLocalGpuSource = localGpuSources.has(settings.embedding_provider);
            const configuredBatchSize = settings.insert_batch_size || 50;
            const hasRateLimit = !isLocalGpuSource && settings.rate_limit_calls > 0;

            // Parallel-split insert — see InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §5.
            // Runs only when `vector_group_embedding_call` (default checked) is unchecked, the
            // provider is not local, and the embedding API rate limit is off — the rate limit
            // needs serial execution through dynamicRateLimiter. Each item then becomes its own
            // embedding+insert POST, fired in parallel waves: when ONE upstream worker is stuck
            // (SiliconFlow, vLLM-the-software) or ONE routing decision is bad (OpenRouter), the
            // stuck item retries in isolation while the rest finish normally. Checked, each
            // batch of up to insert_batch_size items is ONE POST — fewer HTTP calls, but ONE
            // stuck item hangs the WHOLE batch. The setting applies to every caller of
            // insertVectorItems: EventBase ingestion and content/document vectorization alike.
            const groupEmbeddingCall = settings?.vector_group_embedding_call === true;
            const shouldParallelSplit = (
                !groupEmbeddingCall
                && !isLocalGpuSource
                && !hasRateLimit
                && items.length > 1
            );

            const BATCH_SIZE = (isLocalGpuSource || shouldParallelSplit) ? 1 : configuredBatchSize;
            const batches = chunkArray(items, BATCH_SIZE);

            log.verbose(`VectFox: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}${shouldParallelSplit ? ` [parallel-split: ${batches.length} concurrent POSTs in waves of up to 16]` : ''}`);

            if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });

            // Hedge gating — `vector_hedge_after_ms` (default 15000; 0 = off).
            // Skipped for local providers where opening a new HTTP connection wouldn't
            // change routing (Ollama / transformers / llama.cpp / KoboldCpp all land on
            // the same single endpoint regardless of connection identity).
            // See InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.
            const rawHedgeAfterMs = Number(settings?.vector_hedge_after_ms) || 0;
            const HEDGE_MAX_COUNT = 3;
            const hedgeEnabled = (
                rawHedgeAfterMs > 0
                && !isLocalGpuSource
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
                await retry(async () => {
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
                        // outer _insertWithRetry (eventbase-workflow.js) stop instead of re-running
                        // a wave that is certain to fail the same way: without it, the composite
                        // Error would hide the flag and the outer retry would run the whole
                        // hedged wave 3 times, ~36 minutes in all.
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
            additionalArgs = await retry(async () => {
                return await getAdditionalArgs();
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
            await retry(async () => {
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
 * Embeds a query text ONCE, so every route and fallback of the query reuses the
 * vector. Each fallback used to re-send the text and re-embed it server-side, so a
 * provider outage cost up to four embedding calls per query before it gave up —
 * retries by accident, stacked on one another.
 *
 * Retries once on failure, after QUERY_EMBEDDING_RETRY_PAUSE_MS: a provider 500 or
 * 429 ("The engine is currently overloaded") tends to clear within a second, and an
 * immediate retry usually meets the same failure. A second failure throws, because
 * every route needs the vector and no fallback could succeed without it. An
 * invalid-model error is not retried: it fails the same way every time and must
 * reach the sticky model-config popup.
 *
 * @param {object} backend - VectorBackend instance (see embedQuery)
 * @param {string} searchText - Text to embed
 * @param {object} settings - VectFox settings
 * @returns {Promise<number[]|null>} The vector, or null when the backend can only
 *   embed per request (Standard without the Similharity plugin)
 */
export async function getQueryVector(backend, searchText, settings) {
    try {
        return await backend.embedQuery(searchText, settings);
    } catch (error) {
        if (error?.code === 'invalid_model_config') throw error;
        log.warn(`VectFox: query embedding failed, retrying once in ${QUERY_EMBEDDING_RETRY_PAUSE_MS} ms — ${error?.message || error}`);
        await new Promise(resolve => setTimeout(resolve, QUERY_EMBEDDING_RETRY_PAUSE_MS));
        return await backend.embedQuery(searchText, settings);
    }
}

/** How long a failed query embedding waits before its one retry. */
export const QUERY_EMBEDDING_RETRY_PAUSE_MS = 1000;

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * Embeds the query once (getQueryVector) unless the caller passes the vector.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectFox settings object
 * @param {number[]|null} [queryVector] - The query's embedding when the caller already has
 *   it (e.g. one vector shared by several collections); otherwise embedded here
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
export async function queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
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

    // If source requires client-side embeddings, generate query vector
    if (!queryVector && clientSideEmbeddingSources.includes(settings.embedding_provider)) {
        try {
            const additionalArgs = await getAdditionalArgs();
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

    // Backend name for metrics — resolved backend wins, fall back to settings.
    const actualBackendName = resolved.backend || settings?.vector_backend || 'standard';

    // Embed the query ONCE (getQueryVector). Every path below — native hybrid, its
    // client-side fallback, and the plain vector query — reuses this vector instead
    // of re-embedding the text.
    if (!queryVector) {
        try {
            queryVector = await getQueryVector(backend, searchText, settings);
        } catch (error) {
            recordError(actualBackendName, error);
            throw error;
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
            const result = await hybridSearch(bareCollectionId, searchText, topK, settings, { queryVector });
            const queryLatency = Date.now() - queryStart;
            recordQuery(actualBackendName, queryLatency);
            if (log.enabled('lifecycle')) {
                const scores = (result.metadata || []).map(m => (m.score ?? 0).toFixed(4));
                const fusionMethod = (settings.hybrid_fusion_method || 'rrf').toUpperCase();
                log.verbose(`[VectFox] Hybrid search (${fusionMethod}) response: ${result.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
            }
            return result;
        } catch (error) {
            recordError(actualBackendName, error);
            throw error;
        }
    }

    // Standard vector search flow (A1/A2).
    // Overfetch to allow keyword-boosted chunks to surface
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryCollection(bareCollectionId, searchText, overfetchAmount, settings, queryVector);
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

    let finalResults = await scoreResults(resultsForBoost, searchText, topK, settings, bareCollectionId);

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
    // clearly, and continue with corpusStats=null (= local-IDF BM25). Without
    // this, a single ./corpus-stats.js import error bubbles up through
    // scoreResults → queryCollection → the per-query catch in retrieveEvents
    // (eventbase-retrieval.js), which discards every match.
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
            const additionalArgs = await getAdditionalArgs();
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
