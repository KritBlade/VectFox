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
import { isConnectionError, notifyConnectionError, notifyUpstreamRejection } from './model-config-notifier.js';
import { log } from './log.js';

/**
 * Neutral error from a shared LLM call. Callers switch on `kind` to map this
 * onto their own error class and fatal-vs-retryable policy.
 *
 * kinds:
 *  - 'auth'          401/403 (only when authBranch=true)
 *  - 'model_config'  getModelConfigErrorMessage matched (bad/retired model, etc.),
 *                    or the model returned reasoning with an empty answer
 *                    (see _reasoningOnlyReplyDetail) — both fail on every call
 *                    until the user changes a setting, so both must be fatal
 *  - 'connection'    isConnectionError matched (endpoint unreachable)
 *  - 'http'          any other non-2xx
 *  - 'upstream_error' 2xx whose body is really an upstream rejection ST downgraded
 *                    (see notifyUpstreamRejection) — NOT an empty completion
 *  - 'empty'         2xx but genuinely no assistant content and no error in the body
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
 * Pull the upstream rejection text out of a 2xx response body, or null when the
 * body carries no error at all (a genuinely empty completion).
 *
 * Shapes seen in the wild, all HTTP 200:
 *   ST proxy → { error: { message: 'Bad Request' }, quota_error: false }
 *   OpenRouter → { error: { message: '…', code: … } }
 *   some gateways → { message: 'Bad Request' }
 *
 * @param {any} data - parsed response body
 * @returns {string|null}
 */
function _upstreamRejectionDetail(data) {
    const raw = data?.error?.message ?? data?.error ?? (data?.choices ? null : data?.message);
    if (!raw) return null;
    const text = (typeof raw === 'string' ? raw : JSON.stringify(raw)).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 300) : null;
}

/**
 * Detect a reply where the model spent its whole token budget without producing
 * an answer — `content` is empty, but the choice is otherwise well-formed and
 * carries positive evidence that generation happened and ran out of room.
 *
 * MEASURED against deepseek/deepseek-v4-flash-0731 via OpenRouter, because the
 * shape reported in issue #14 ("everything in reasoning_content, content empty")
 * is NOT what this model actually sends. Its message object is exactly
 * {role, content, refusal} — no reasoning field at any setting. The thinking is
 * still generated and still billed; it is simply invisible:
 *
 *   max_tokens 2048, trivial 2-line excerpt → finish_reason "stop",
 *                                             completion 426, reasoning 322
 *   max_tokens 100,  same excerpt           → finish_reason "length",
 *                                             content "", reasoning 113
 *
 * So the reliable signal is finish_reason "length" with empty content, NOT the
 * presence of a reasoning field. Both are accepted here: providers that do expose
 * chain-of-thought (DeepSeek's direct API uses `reasoning_content`, OpenRouter
 * normalises to `reasoning`) hit the second branch.
 *
 * VectFox must NOT substitute thinking for the answer where it is visible.
 * Chain-of-thought is the model's scratch work, not output it committed to:
 * parsing it would mint events, chunks, or summaries the model never asserted.
 * This is a failure to report, never a source to fall back on.
 *
 * @param {any} data - parsed response body
 * @returns {{ finishReason: string|null, reasoningChars: number, reasoningTokens: number|null }|null}
 */
function _budgetSpentWithoutAnswerDetail(data) {
    const choice = data?.choices?.[0];
    if (!choice) return null;

    const finishReason = choice.finish_reason ?? null;
    const reasoning = String(choice.message?.reasoning_content ?? choice.message?.reasoning ?? '').trim();
    // Either the provider told us it hit the cap, or it handed us thinking in
    // place of a reply. Anything else is a genuinely empty completion.
    if (finishReason !== 'length' && !reasoning) return null;

    return {
        finishReason,
        reasoningChars: Array.from(reasoning).length,
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
}

/**
 * Resolve the two request-shape switches every chat-completion call needs, from
 * the VectFox settings object the caller already holds.
 *
 * WHY THIS EXISTS — reasoning models (OpenAI's gpt-5 family, o1/o3/o4, and the
 * hosted variants built on them) reject the classic sampling parameters:
 *   - `temperature` other than the default 1 → HTTP 400 "Unsupported value:
 *     'temperature' does not support 0.2 with this model."
 *   - `max_tokens` at all → HTTP 400 "Unsupported parameter: 'max_tokens' is not
 *     supported with this model. Use 'max_completion_tokens' instead."
 * NOTHING ELSE IN THE STACK WILL FIX THIS FOR US — verified against SillyTavern
 * 1.18.0:
 *   - The server's /api/backends/chat-completions/generate handler is a raw
 *     passthrough for both sources VectFox uses: it copies `temperature`,
 *     `max_tokens` and `max_completion_tokens` verbatim out of the request body
 *     (src/endpoints/backends/chat-completions.js, the generic requestBody block).
 *   - ST's OWN client does perform exactly this rewrite —
 *     `generate_data.max_completion_tokens = generate_data.max_tokens; delete
 *     generate_data.max_tokens; … delete generate_data.temperature;` for /gpt-5/
 *     and /^(o1|o3|o4)/ (public/scripts/openai.js) — but only for its `gptSources`
 *     list: OPENAI, AZURE_OPENAI, OPENROUTER. `custom` is NOT in that list, and
 *     VectFox never goes through that client path anyway.
 * So VectFox reaching a reasoning model has to shape the body itself. This helper
 * mirrors what ST's client does for its own requests.
 *
 * These are deliberately USER-SET switches, not model-name sniffing: the model-id
 * list rots every time a vendor ships a name (ST's own regexes already carry
 * special cases for gpt-5-chat-latest and gpt-5.1–5.4), and VectFox sees arbitrary
 * ids from proxies and custom gateways where a name tells you nothing about the
 * API shape.
 *
 * Install-global on purpose. A single ST install talks to one chat endpoint family
 * across all four LLM features, so per-feature copies would be four ways to get the
 * same answer wrong.
 *
 * @param {object} [settings] - VectFox settings object
 * @returns {{sendTemperature: boolean, tokenLimitParameter: string}} spread straight
 *          into the postChatCompletion argument object
 */
export function resolveModelParameterStyle(settings = {}) {
    return {
        sendTemperature: settings?.should_send_temperature !== false,
        tokenLimitParameter: settings?.should_use_max_completion_tokens
            ? 'max_completion_tokens'
            : 'max_tokens',
        // ON unless the user turns it off — thinking earns nothing on the
        // schema-filling work every one of these features does, while costing
        // latency, tokens, and (measured) whole runs that return nothing.
        //
        // Only ever 'none', never a weaker effort level: 'minimal' and 'low'
        // still think, just less, so a switch labelled "turn off thinking"
        // would over-promise.
        reasoningEffort: settings?.should_disable_thinking !== false ? 'none' : null,
    };
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
 * @param {number}   opts.temperature        omitted from the request when sendTemperature is false
 * @param {number}   opts.timeoutMs
 * @param {object}   [opts.responseFormat]   e.g. { type: 'json_object' }
 * @param {string}   opts.contextLabel       feature label for error text ('EventBase', …)
 * @param {boolean}  [opts.authBranch=true]  give 401/403 a dedicated 'auth' error
 * @param {boolean}  [opts.shouldNotifyProviderFailure=true] let this shared call raise the
 *        de-duped toast for provider failures (unreachable endpoint, upstream rejection).
 *        Pass false when the CALLER owns its own error surfacing, as Auto-Reformat does.
 * @param {boolean}  [opts.sendTemperature=true] false = don't send `temperature` at all
 *        (reasoning models accept only their own default). From resolveModelParameterStyle.
 * @param {string}   [opts.tokenLimitParameter='max_tokens'] body key for the output-token
 *        cap — 'max_completion_tokens' for reasoning models. From resolveModelParameterStyle.
 * @param {string|null} [opts.reasoningEffort=null] sent as `reasoning_effort` when set;
 *        'none' turns a reasoning model's thinking off entirely. From
 *        resolveModelParameterStyle.
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
    shouldNotifyProviderFailure = true,
    sendTemperature = true,
    tokenLimitParameter = 'max_tokens',
    reasoningEffort = null,
}) {
    const label = _providerLabel(provider);

    const body = { model, messages, [tokenLimitParameter]: maxTokens };
    if (sendTemperature) body.temperature = temperature;
    if (responseFormat) body.response_format = responseFormat;
    // Top-level OpenAI-standard field, NOT OpenRouter's `reasoning` object —
    // SillyTavern's proxy forwards this one and strips that one. Measured on the
    // real EventBase prompt: deepseek-v4-flash went 153.5s / 1632 reasoning
    // tokens → 6.7s / 0, and gpt-5.6-luna 29.5s / 1034 → 3.0s / 0, both still
    // extracting correctly. Harmless on models that never think (gpt-4o-mini
    // accepted it without error), so it needs no per-model gate.
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

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
            if (shouldNotifyProviderFailure) notifyConnectionError(contextLabel, vllmUrl || null, errText);
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
        // Checked FIRST, ahead of the text classifiers below: this is a precise
        // structural test on the choice itself, whereas those match substrings
        // over a body that — when a model does expose its thinking — carries the
        // model's own prose and could trip them by coincidence.
        //
        // Classified as 'model_config' rather than 'empty' so every caller treats
        // it the way it already treats a bad model: abort the run and show the
        // invalid-model popup. A token cap too small for the model's thinking
        // fails identically on every window, so the per-window skip that 'empty'
        // buys just burns the whole chat in silence and then reports success
        // (issue #14).
        const noAnswer = _budgetSpentWithoutAnswerDetail(data);
        if (noAnswer) {
            // Spell out where the budget went, since with a model that hides its
            // thinking the token counts are the ONLY evidence the user can see.
            const spent = noAnswer.reasoningTokens != null
                ? `${noAnswer.reasoningTokens} of them on reasoning the provider did not return`
                : (noAnswer.reasoningChars
                    ? `${noAnswer.reasoningChars} characters of it on chain-of-thought`
                    : 'all of them before the answer began');
            log.warn(
                `[${contextLabel}] ${label} model "${model}" produced no answer: finish_reason `
                + `"${noAnswer.finishReason}", empty content, ${tokenLimitParameter}=${maxTokens}, `
                + `reasoning_tokens=${noAnswer.reasoningTokens ?? 'n/a'}, reasoning_chars=${noAnswer.reasoningChars}.`,
            );
            throw new LlmCallError(
                `${contextLabel}: model "${model}" used its entire ${maxTokens}-token limit without answering `
                + `(finish_reason "${noAnswer.finishReason}") — spending ${spent}. Raise the ${contextLabel} token `
                + `limit, or pick a model that does not think before replying. VectFox cannot use chain-of-thought `
                + `as output — it is the model's scratch work, not an answer it stands behind.`,
                { kind: 'model_config', status: response.status, provider },
            );
        }

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

        // A 200 carrying `error.message` is NOT an empty reply — it is an upstream
        // rejection that ST's proxy downgraded to 200 while keeping only the status
        // text (see notifyUpstreamRejection for the exact upstream code path). The
        // classifier above can't catch it because "Bad Request" names no cause.
        // Treating it as 'empty' is what made a wrong key, an unsupported parameter,
        // and a refused prompt all look like "the model said nothing".
        const upstreamDetail = _upstreamRejectionDetail(data);
        if (upstreamDetail) {
            if (shouldNotifyProviderFailure) {
                notifyUpstreamRejection(contextLabel, model, upstreamDetail, Boolean(data?.quota_error));
            }
            log.warn(
                `[${contextLabel}] ${label} rejected the request (HTTP ${response.status} from ST, upstream status text `
                + `"${upstreamDetail}"). The provider's full error is in the SillyTavern server console. Raw body: ${bodyText.slice(0, 500)}`,
            );
            throw new LlmCallError(
                `${contextLabel}: ${label} rejected the request for model "${model}" — ${upstreamDetail}`,
                { kind: 'upstream_error', status: response.status, provider },
            );
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
