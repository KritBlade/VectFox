/**
 * ============================================================================
 * LLM PROVIDER CALL (shared)
 * ============================================================================
 * Single home for the OpenAI-compatible chat-completions plumbing that four
 * VectFox features previously each re-implemented (summarizer.js,
 * eventbase-extractor.js, agentic-retrieval.js, and reformat-extractor.js):
 * build request body → POST through ST's proxy → classify the response
 * (auth / model-config / connection / generic) → extract the reply → classify
 * an empty reply. Plus the LLM-output JSON-array parser both extraction
 * features shared verbatim, and the string-array coercion the two schemas
 * copied.
 *
 * DESIGN — neutral core, feature policy at the edge.
 * This module throws ONE neutral error type (LlmCallError, carrying a `kind`).
 * Each caller keeps its own config resolution + pre-fetch presence checks
 * (whose messages legitimately differ — "set the key in EventBase settings"
 * vs "…in Summarize Before Store settings") and maps LlmCallError.kind onto
 * its own feature error class in a tiny catch. That preserves every feature's
 * existing error TYPES (SummarizationFatalError / EventBaseFatalError / …) and
 * fatal-vs-retryable policy, while the ~70 lines of identical HTTP mechanics
 * live here once.
 *
 * The wire path (fetch to /api/backends/chat-completions/generate) had NO
 * wire-level test coverage across any of the four copies; consolidating it
 * here means it can finally be tested once — see tests/llm-provider-call.test.js.
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import { isConnectionError, notifyConnectionError } from './model-config-notifier.js';
import { log } from './log.js';

/**
 * Neutral error from a shared LLM call. Callers switch on `kind` to map this
 * onto their own error class and fatal-vs-retryable policy.
 *
 * kinds:
 *  - 'auth'          401/403 (only when authBranch=true)
 *  - 'model_config'  getModelConfigErrorMessage matched (bad/retired model, etc.)
 *  - 'connection'    isConnectionError matched (endpoint unreachable)
 *  - 'http'          any other non-2xx
 *  - 'empty'         2xx but no assistant content
 *  - 'parse'         parseJsonArrayFromLlm could not find a usable array
 */
export class LlmCallError extends Error {
    /**
     * @param {string} message
     * @param {{kind: string, status?: number|null, provider?: string|null}} meta
     */
    constructor(message, { kind, status = null, provider = null } = {}) {
        super(message);
        this.name = 'LlmCallError';
        this.kind = kind;
        this.status = status;
        this.provider = provider;
    }
}

/** Human label for error messages. */
function _providerLabel(provider) {
    return (provider === 'vllm' || provider === 'custom') ? 'vLLM' : 'OpenRouter';
}

/**
 * POST a chat-completion through SillyTavern's proxy and return the assistant
 * content. Handles both providers (OpenRouter and vLLM/custom route through the
 * same `/api/backends/chat-completions/generate` proxy — the real key is read
 * server-side; the client only holds a masked presence indicator).
 *
 * Presence checks for api-key / url / model are the CALLER's job (they own the
 * feature-specific "where to set it" message) and must run before this.
 *
 * @param {object}   opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string}   opts.model
 * @param {string}   opts.provider           'openrouter' | 'vllm'
 * @param {string}   [opts.vllmUrl]          raw base URL for custom/vLLM (sent as custom_url)
 * @param {number}   opts.maxTokens
 * @param {number}   opts.temperature
 * @param {number}   opts.timeoutMs
 * @param {object}   [opts.responseFormat]   e.g. { type: 'json_object' }
 * @param {string}   opts.contextLabel       feature label for error text ('EventBase', …)
 * @param {boolean}  [opts.authBranch=true]  give 401/403 a dedicated 'auth' error
 * @param {boolean}  [opts.connectionNotify=true] show the connection toast on unreachable
 * @returns {Promise<{content: string, finishReason: string|null, usage: object|null, data: any}>}
 * @throws {LlmCallError}
 */
export async function postChatCompletion({
    messages,
    model,
    provider,
    vllmUrl = '',
    maxTokens,
    temperature,
    timeoutMs,
    responseFormat = null,
    contextLabel,
    authBranch = true,
    connectionNotify = true,
}) {
    const label = _providerLabel(provider);

    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (responseFormat) body.response_format = responseFormat;

    const requestBody = (provider === 'vllm' || provider === 'custom')
        ? { chat_completion_source: 'custom', custom_url: vllmUrl, ...body }
        : { chat_completion_source: 'openrouter', ...body };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);

        if (authBranch && (response.status === 401 || response.status === 403)) {
            throw new LlmCallError(
                `${contextLabel}: ${label} authentication failed (${response.status}). Check your API key.`,
                { kind: 'auth', status: response.status, provider },
            );
        }

        const modelConfigError = getModelConfigErrorMessage({
            contextLabel, provider: label, model, status: response.status, responseText: errText,
        });
        if (modelConfigError) {
            throw new LlmCallError(modelConfigError, { kind: 'model_config', status: response.status, provider });
        }

        if (isConnectionError(errText)) {
            if (connectionNotify) notifyConnectionError(contextLabel, vllmUrl || null, errText);
            throw new LlmCallError(
                `${contextLabel}: couldn't reach ${vllmUrl || label} — ${errText}`,
                { kind: 'connection', status: response.status, provider },
            );
        }

        throw new LlmCallError(
            `${contextLabel}: ${label} HTTP ${response.status}: ${String(errText).slice(0, 300)}`,
            { kind: 'http', status: response.status, provider },
        );
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || null;

    if (!content) {
        // OpenRouter (and ST's proxy) sometimes return HTTP 200 with the error in
        // the BODY (e.g. a retired model → {"error":{...}} with no choices). Re-run
        // the model-config classifier on the body so that surfaces as model_config
        // rather than a bland "empty" skip.
        const bodyText = data?.error ? JSON.stringify(data.error) : JSON.stringify(data || {});
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel, provider: label, model, status: response.status, responseText: bodyText, enforceStatusGate: false,
        });
        if (modelConfigError) {
            throw new LlmCallError(modelConfigError, { kind: 'model_config', status: response.status, provider });
        }
        log.warn(`[${contextLabel}] ${label} returned empty reply (HTTP ${response.status}) — raw body: ${bodyText.slice(0, 500)}`);
        throw new LlmCallError(
            `${contextLabel}: ${label} returned empty response`,
            { kind: 'empty', status: response.status, provider },
        );
    }

    const usage = data?.usage ? {
        prompt_tokens: data.usage.prompt_tokens ?? null,
        completion_tokens: data.usage.completion_tokens ?? null,
        total_tokens: data.usage.total_tokens ?? null,
    } : null;

    return {
        content,
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
        usage,
        data,
    };
}

// ---------------------------------------------------------------------------
// LLM JSON-array parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON array of records out of raw LLM output, tolerating the usual
 * mess: code fences, NDJSON object-per-line, prose around the array, and
 * top-level object streams. Prefers the first candidate array whose first item
 * carries one of `identKeys` (so property arrays like "items":[] aren't mistaken
 * for the top-level record array); falls back to an empty array for a legit
 * "nothing found" response.
 *
 * Previously duplicated as eventbase-extractor `_parseJsonArray` and
 * reformat-extractor `_extractJsonArray` — identical except which keys mark a
 * real record. Throws LlmCallError{kind:'parse'} on unrecoverable output; the
 * caller maps it to its own extraction error.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {string}   [opts.label='LLM']     label for trace logs / error text
 * @param {number}   [opts.index=-1]        batch/window index for logs
 * @param {string}   [opts.range='']        extra locator (e.g. message range)
 * @param {string[]} [opts.identKeys=['name']] keys that identify a real record
 * @returns {unknown[]}
 * @throws {LlmCallError}
 */
export function parseJsonArrayFromLlm(raw, { label = 'LLM', index = -1, range = '', identKeys = ['name'] } = {}) {
    let text = (raw || '').trim();
    const rangeStr = range ? ` ${range}` : '';

    log.domain('raw_llm', 'trace', `[${label}] Parser window=${index}${rangeStr}: raw length=${text.length}, preview:`, text.slice(0, 150));

    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new LlmCallError('Empty LLM response', { kind: 'parse' });
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse.
    try {
        const direct = JSON.parse(text);
        if (Array.isArray(direct)) candidates.push(direct);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            if (Object.keys(direct).length === 0) candidates.push([]);
            const wrappedArr = Object.values(direct).find(v => Array.isArray(v));
            if (Array.isArray(wrappedArr)) candidates.push(wrappedArr);
        }
    } catch {
        // Continue with extraction-based parsing.
    }

    // 2) NDJSON / object-per-line.
    if (text.includes('\n')) {
        const lines = text.split('\n').map(l => l.trim())
            .filter(l => l.length > 0 && l.startsWith('{') && l.endsWith('}'));
        if (lines.length > 0) {
            try {
                candidates.push(lines.map(line => JSON.parse(line)));
            } catch {
                // Ignore and continue.
            }
        }
    }

    // 3) Every balanced [ ... ] slice.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '[') depth++;
            else if (text[j] === ']') {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }
        if (end === -1) continue;
        try {
            const parsed = JSON.parse(text.slice(i, end + 1));
            if (Array.isArray(parsed)) candidates.push(parsed);
        } catch {
            // Keep scanning.
        }
    }

    // 4) Top-level object stream (first '{' … last '}').
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const objectRegion = text.slice(firstBrace, lastBrace + 1);
        const stream = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < objectRegion.length; i++) {
            if (objectRegion[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (objectRegion[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    try {
                        const obj = JSON.parse(objectRegion.slice(start, i + 1));
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) stream.push(obj);
                    } catch {
                        // Skip malformed object parts.
                    }
                    start = -1;
                }
            }
        }
        if (stream.length > 0) candidates.push(stream);
    }

    const isRecordArray = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const first = arr[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
        return identKeys.some(k => Object.prototype.hasOwnProperty.call(first, k));
    };
    const chosen = candidates.find(isRecordArray)
        ?? candidates.find(arr => Array.isArray(arr) && arr.length === 0);

    if (!chosen) {
        const sample = candidates[0];
        const sampleType = Array.isArray(sample) && sample.length > 0 ? typeof sample[0] : 'none';
        throw new LlmCallError(
            `Unable to find record array in ${label} response. candidateCount=${candidates.length}, `
            + `firstCandidateItemType=${sampleType}, rawPreview=${text.slice(0, 200)}`,
            { kind: 'parse' },
        );
    }

    if (chosen.length > 0 && (typeof chosen[0] !== 'object' || Array.isArray(chosen[0]))) {
        throw new LlmCallError(
            `Parsed array contains non-object items (first type: ${typeof chosen[0]}). `
            + `Raw: ${JSON.stringify(chosen).slice(0, 120)}`,
            { kind: 'parse' },
        );
    }

    return chosen;
}
