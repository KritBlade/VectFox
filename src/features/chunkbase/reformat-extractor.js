/**
 * ============================================================================
 * AUTO-REFORMAT EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to restructure Document/URL/Wiki source
 * text into structured, entity-tagged reformatted chunks (see
 * src/features/chunkbase/reformat-schema.js for the record shape).
 *
 * Provider calls and LLM-output JSON parsing come from src/features/llm-provider/llm-provider-call.js
 * (postChatCompletion + parseJsonArrayFromLlm), shared with VectFox's other LLM
 * features; nothing here imports EventBase. The reformat-specific policy stays
 * here: config resolution, per-batch retry (retry() from src/shared/retry.js —
 * a transient failure on a large single-shot batch costs more than one small
 * EventBase chat window), batching into chains that run a few at a time,
 * validation, and the review-facing warnings.
 *
 * Returns { chunks, warnings, batchesProcessed, batchesFailed, totalBatches }.
 * Throws ReformatFatalError for config/auth failures (aborts the whole run).
 * Individual batch parse/validation failures are non-fatal — logged as
 * warnings, the rest of the document still gets processed.
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from '../../shared/api-keys.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { postChatCompletion, parseJsonArrayFromLlm, resolveInheritedConnection, resolveModelParameterStyle, LlmCallError } from '../llm-provider/index.js';
import { chunkText } from './chunking.js';
import { retry } from '../../shared/retry.js';
import {
    ReformatExtractionError,
    ReformatFatalError,
    validateReformattedChunk,
    buildReformatPrompt,
    computeNameVerification,
} from './reformat-schema.js';
import { log } from '../../sillytavern/log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_BATCH_CHARS = 6000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_NAME_FUZZY_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Config resolution: the ChunkBase page's Auto-Reformat boxes, with Same as
// EventBase model and each blank box taken from the EventBase model, the rule
// Agent Mode follows too (resolveInheritedConnection).
// ---------------------------------------------------------------------------

function _resolveConnection(settings) {
    return resolveInheritedConnection({
        provider: settings.reformat_provider,
        model: settings.reformat_model,
        vllmUrl: settings.reformat_vllm_url,
        connectionProfileId: settings.reformat_connection_profile_id,
    }, settings);
}

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

/**
 * Map a neutral LlmCallError from the shared provider-call module onto
 * Auto-Reformat's error taxonomy. Preserves prior policy: auth / model-config
 * are fatal (abort the run); everything else — including connection — is a
 * ReformatExtractionError, i.e. retryable by _callProviderWithRetry (the old
 * callers had no connection branch, so connection errors were already generic
 * retryables). Non-LlmCallError values pass through.
 * @param {unknown} e
 * @param {number} batchIndex
 * @returns {Error}
 */
function _mapReformatError(e, batchIndex) {
    if (!(e instanceof LlmCallError)) return /** @type {Error} */ (e);
    switch (e.kind) {
        case 'auth': return new ReformatFatalError(e.message, 'invalid_api_key');
        case 'model_config': return new ReformatFatalError(e.message, 'invalid_model_config');
        default: return new ReformatExtractionError(e.message, batchIndex); // connection | http | upstream_error | empty
    }
}

/**
 * Send one batch on a route: the provider and what it needs, a model and URL on the manual paths or a profile.
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @param {object} route - Spread into postChatCompletion
 * @returns {Promise<{reply: string, finishReason: string|null, cutReason: string|null}>}
 */
async function _requestReformat(prompt, settings, batchIndex, route) {
    try {
        const { content, finishReason, cutReason } = await postChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            ...route,
            maxTokens: settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS,
            temperature: settings.reformat_temperature ?? DEFAULT_TEMPERATURE,
            timeoutMs: settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS,
            contextLabel: 'Auto-Reformat',
            shouldNotifyProviderFailure: false,
            ...resolveModelParameterStyle(settings),
        });
        return { reply: content, finishReason, cutReason };
    } catch (e) {
        throw _mapReformatError(e, batchIndex);
    }
}

async function _callOpenRouter(prompt, settings, batchIndex) {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: OpenRouter API key not found. Add it in Core → EventBase model.',
            'missing_api_key',
        );
    }

    const { model } = _resolveConnection(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to use the model in Core → EventBase model.',
            'missing_model',
        );
    }

    return _requestReformat(prompt, settings, batchIndex, { model, provider: 'openrouter' });
}

async function _callVLLM(prompt, settings, batchIndex) {
    const { vllmUrl: baseUrl, model } = _resolveConnection(settings);
    if (!baseUrl) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM URL not configured. Set Base URL in ChunkBase → Auto-Reformat, or in Core → EventBase model.',
            'missing_url',
        );
    }

    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to use the model in Core → EventBase model.',
            'missing_model',
        );
    }

    const apiKey = getCustomApiKey();
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → EventBase model.',
            'missing_api_key',
        );
    }

    return _requestReformat(prompt, settings, batchIndex, { model, provider: 'vllm', vllmUrl: baseUrl });
}

/** On a SillyTavern connection profile: its own, or the EventBase model's under Same as EventBase model. */
async function _callConnectionProfile(prompt, settings, batchIndex) {
    const { connectionProfileId } = _resolveConnection(settings);
    return _requestReformat(prompt, settings, batchIndex, {
        provider: CONNECTION_PROFILE_PROVIDER,
        connectionProfileId,
        connectionProfilePage: String(settings.reformat_provider ?? '').trim() ? 'ChunkBase' : 'Core',
    });
}

const CALL_OF_PROVIDER = { openrouter: _callOpenRouter, vllm: _callVLLM, [CONNECTION_PROFILE_PROVIDER]: _callConnectionProfile };

/**
 * Calls the configured provider, retrying transient failures (network hiccups,
 * 5xx, timeouts) but never retrying ReformatFatalError (auth/config problems
 * a retry can't fix).
 */
async function _callProviderWithRetry(prompt, settings, batchIndex) {
    const { provider } = _resolveConnection(settings);
    const callFn = CALL_OF_PROVIDER[provider];
    if (!callFn) {
        throw new ReformatFatalError(
            `Auto-Reformat: provider "${provider}" is not one VectFox knows. Choose one in ChunkBase → Auto-Reformat.`,
            'invalid_model_config',
        );
    }
    return retry(() => callFn(prompt, settings, batchIndex), {
        maxAttempts: 3,
        delay: 1500,
        maxDelay: 10000,
        backoffFactor: 2,
        shouldRetry: (err) => !(err instanceof ReformatFatalError),
        onRetry: (attempt, err) => log.warn(`[Auto-Reformat] Batch ${batchIndex}: attempt ${attempt} failed (${err?.message || err}), retrying...`),
    });
}

// ---------------------------------------------------------------------------
// Batching packer
// ---------------------------------------------------------------------------

/** First non-empty line of a section, used as its title for continuation notes. */
function _firstLine(text) {
    return (text || '').split('\n').map(l => l.trim()).find(Boolean) || 'section';
}

/**
 * Splits source text into LLM-call-sized batches, respecting header
 * boundaries via the existing `section` chunking strategy wherever possible.
 * NOT a final chunk boundary — purely an internal batching mechanism so a
 * long document doesn't blow one call's output budget. If a single section
 * itself exceeds the budget (e.g. one header covering seven character
 * profiles — the exact reported bug), that section alone gets sub-split via
 * `paragraph` strategy into ordered continuation batches.
 *
 * @param {string} text
 * @param {number} targetChars
 * @returns {Promise<Array<{text: string, continuation: {sectionTitle: string}|null}>>}
 */
async function _buildBatches(text, targetChars) {
    const sectionChunks = await chunkText(text, { strategy: 'section' });
    const sections = sectionChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

    const batches = [];
    let current = '';

    const flush = () => {
        if (current.trim()) batches.push({ text: current.trim(), continuation: null });
        current = '';
    };

    for (const section of sections) {
        if (section.length > targetChars) {
            flush();
            const title = _firstLine(section);
            const paraChunks = await chunkText(section, { strategy: 'paragraph' });
            const paragraphs = paraChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

            let sub = '';
            let isFirstSubBatch = true;
            const flushSub = () => {
                if (!sub.trim()) return;
                batches.push({ text: sub.trim(), continuation: isFirstSubBatch ? null : { sectionTitle: title } });
                isFirstSubBatch = false;
                sub = '';
            };
            for (const p of paragraphs) {
                if (sub && (sub.length + p.length + 2) > targetChars) {
                    flushSub();
                    sub = p;
                } else {
                    sub += (sub ? '\n\n' : '') + p;
                }
            }
            flushSub();
        } else if (current && (current.length + section.length + 2) > targetChars) {
            flush();
            current = section;
        } else {
            current += (current ? '\n\n' : '') + section;
        }
    }
    flush();

    return batches;
}

/**
 * Groups packed batches into ordered "chains" — a continuation batch must be
 * processed after the batch it continues (so it can be told which names were
 * already extracted), but independent chains can run concurrently.
 * @param {Array<{text: string, continuation: object|null}>} batches
 * @returns {Array<Array<object>>}
 */
function _groupIntoChains(batches) {
    const chains = [];
    let current = null;
    for (const b of batches) {
        if (b.continuation && current) {
            current.push(b);
        } else {
            current = [b];
            chains.push(current);
        }
    }
    return chains;
}

// ---------------------------------------------------------------------------
// Chain processing
// ---------------------------------------------------------------------------

/**
 * Processes one chain (a normal batch, or an ordered run of continuation
 * batches for one oversized section) sequentially, threading the running
 * "already extracted" name list into each continuation's prompt.
 */
async function _processChain(chain, settings, chainIndex, warnings) {
    const results = [];
    let failedCount = 0;
    const alreadyExtractedNames = [];
    const threshold = settings.reformat_name_fuzzy_threshold ?? DEFAULT_NAME_FUZZY_THRESHOLD;

    for (let i = 0; i < chain.length; i++) {
        const batch = chain[i];
        const batchLabel = chain.length > 1 ? `chain ${chainIndex} part ${i + 1}/${chain.length}` : `batch ${chainIndex}`;
        const batchContext = batch.continuation
            ? { sectionTitle: batch.continuation.sectionTitle, alreadyExtractedNames: [...alreadyExtractedNames] }
            : null;
        const prompt = buildReformatPrompt(batch.text, { customPrompt: settings.reformat_custom_prompt, batchContext });

        try {
            const { reply, finishReason, cutReason } = await _callProviderWithRetry(prompt, settings, chainIndex);
            if (cutReason) {
                warnings.push(finishReason === 'length'
                    ? `${batchLabel}: response was truncated by the model's output limit — some entries from this section may be missing. Consider lowering "Batch size (chars)" in ChunkBase → Auto-Reformat.`
                    : `${batchLabel}: the provider cut the reply short, with finish reason ${cutReason}, so some entries from this section may be missing.`);
            }

            const rawArray = parseJsonArrayFromLlm(reply, {
                label: 'Auto-Reformat',
                index: chainIndex,
                identKeys: ['entry_type', 'name', 'body'],
            });
            const validatedForBatch = [];
            for (let j = 0; j < rawArray.length; j++) {
                const { ok, errors, chunk } = validateReformattedChunk(rawArray[j]);
                if (!ok) {
                    log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: validation failed — ${errors.join('; ')} — skipped`);
                    continue;
                }
                if (errors.length > 0) {
                    log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: coercion warnings — ${errors.join('; ')}`);
                }
                validatedForBatch.push(chunk);
            }

            const verification = computeNameVerification(validatedForBatch, batch.text, threshold);
            validatedForBatch.forEach((chunk, j) => {
                results.push({
                    ...chunk,
                    _nameGrounded: verification[j]?.nameGrounded ?? true,
                    _ungroundedAliases: verification[j]?.ungroundedAliases ?? [],
                });
                alreadyExtractedNames.push(chunk.name);
            });
        } catch (err) {
            if (err instanceof ReformatFatalError) throw err;
            failedCount++;
            warnings.push(`${batchLabel} failed: ${err?.message || err} — skipped, other batches continue.`);
            log.warn(`[Auto-Reformat] ${batchLabel} failed:`, err?.message || err);
        }
    }

    return { results, failedCount };
}

/**
 * Runs the async `tasks` with at most `limit` of them in flight, starting the
 * next one whenever one finishes, and resolves to their results in task order.
 * A task that throws rejects the whole run at once; tasks already started keep
 * running.
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function _runWithConcurrencyLimit(tasks, limit) {
    const results = [];
    const inFlight = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const promise = Promise.resolve().then(() => task());
        results[i] = promise;

        if (limit <= tasks.length) {
            const slot = promise.then(() => inFlight.splice(inFlight.indexOf(slot), 1));
            inFlight.push(slot);

            if (inFlight.length >= limit) {
                await Promise.race(inFlight);
            }
        }
    }

    return Promise.all(results);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Restructures source text into structured reformatted chunks.
 *
 * @param {object} params
 * @param {string} params.text - Full prepared source text (document/url, or
 *        wiki text with per_page strategy overridden away — see caller)
 * @param {string} params.contentType - 'document' | 'url' | 'wiki'
 * @param {object} params.settings - VectFox settings
 * @param {(processed: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{chunks: object[], warnings: string[], batchesProcessed: number, batchesFailed: number, totalBatches: number}>}
 */
export async function reformatDocument({ text, contentType, settings, onProgress = null, abortSignal = null } = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { chunks: [], warnings: ['No text to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const targetChars = settings.reformat_batch_chars || DEFAULT_BATCH_CHARS;
    const batches = await _buildBatches(text, targetChars);
    if (batches.length === 0) {
        return { chunks: [], warnings: ['No content found to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const chains = _groupIntoChains(batches);
    const totalBatches = batches.length;
    const warnings = [];
    let batchesProcessed = 0;
    let batchesFailed = 0;

    const concurrency = Math.max(1, Math.min(8, settings.reformat_concurrency || DEFAULT_CONCURRENCY));

    log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, ${totalBatches} batch(es) in ${chains.length} chain(s), concurrency=${concurrency}`);

    const chainTasks = chains.map((chain, chainIndex) => async () => {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        const { results, failedCount } = await _processChain(chain, settings, chainIndex, warnings);
        batchesProcessed += chain.length;
        batchesFailed += failedCount;
        onProgress?.(batchesProcessed, totalBatches);
        return results;
    });

    const chainResultsArrays = await _runWithConcurrencyLimit(chainTasks, concurrency);
    const chunks = chainResultsArrays.flat();

    log.lifecycle(`[Auto-Reformat] Complete: ${chunks.length} entries extracted from ${totalBatches} batch(es), ${batchesFailed} batch failure(s), ${warnings.length} warning(s)`);

    return { chunks, warnings, batchesProcessed, batchesFailed, totalBatches };
}

// ---------------------------------------------------------------------------
// Oversized-entity fallback (used at Accept time by src/features/chunkbase/reformat-review.js)
// ---------------------------------------------------------------------------

/**
 * If an accepted record's body exceeds maxBodyChars, sub-chunks it with the
 * EXISTING adaptive splitter (no new splitting logic) into N physical chunks
 * that all carry the parent record's metadata plus subChunkIndex/subChunkTotal.
 * Returns [chunk] unchanged when no expansion is needed.
 *
 * @param {object} chunk - A validated reformatted chunk (post-review, accepted)
 * @param {number} maxBodyChars
 * @returns {Promise<object[]>}
 */
export async function expandOversizedChunk(chunk, maxBodyChars) {
    if (!chunk?.body || chunk.body.length <= maxBodyChars) {
        return [chunk];
    }
    const subChunks = await chunkText(chunk.body, { strategy: 'adaptive', chunkSize: maxBodyChars });
    const total = subChunks.length;
    return subChunks.map((sc, i) => ({
        ...chunk,
        body: typeof sc === 'string' ? sc : sc.text,
        subChunkIndex: i,
        subChunkTotal: total,
    }));
}
