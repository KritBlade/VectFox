/**
 * ============================================================================
 * EVENTBASE EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to extract structured EventRecord objects
 * from a window of chat messages.
 *
 * Returns an array of validated EventRecord objects (may be empty).
 * Throws EventBaseFatalError for config/auth failures.
 * Throws EventBaseExtractionError for parse/validation failures (non-fatal per-window).
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { postChatCompletion, parseJsonArrayFromLlm, resolveModelParameterStyle, LlmCallError } from './llm-provider-call.js';
import {
    EVENT_TYPES,
    EventBaseExtractionError,
    EventBaseFatalError,
    validateEvent,
    buildEmbedText,
    buildExtractionPrompt,
    EVENTBASE_SCHEMA_VERSION,
    packTimelineSortKey,
} from './eventbase-schema.js';
import { cleanText } from './text-cleaning.js';
import StringUtils from '../utils/string-utils.js';
import { log } from './log.js';

// Cap each message's reasoning (chain-of-thought) fed to the extractor as a
// date/time/location fallback. Tunable — raise if a game places the scene recap
// deeper in the reasoning. 100 was too small for the observed format, which
// leads with an "INPUT" section and only states Time/Location in section 2
// ("STORY") around char ~95-165 (see Doc/log.txt diagnosis 2026-06-20); 600
// clears that with margin while still bounding pathologically long reasoning.
// Cost is a few hundred input tokens per reasoning-bearing message.
// See plans/eventbase-scene-context-from-reasoning.md.
const REASONING_FEED_CHAR_CAP = 600;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Key resolution (mirrors summarizer.js pattern)
// ---------------------------------------------------------------------------

/**
 * Get the OpenRouter API key from Core summarization settings or ST secrets.
 * @param {object} settings
 * @returns {string}
 */
// _getOpenRouterApiKey lived inline here pre-H-1; now an alias for the
// canonical single-key helper. ONE OpenRouter key shared across
// embedding/summarize/agentic — see core/api-keys.js docstring.
const _getOpenRouterApiKey = getOpenRouterApiKey;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a neutral LlmCallError from the shared provider-call module onto
 * EventBase's own error taxonomy, preserving the prior fatal-vs-per-window
 * policy exactly (auth / model-config / connection are fatal; http / empty are
 * per-window skips). Non-LlmCallError values pass through unchanged.
 * @param {unknown} e
 * @param {number} windowIndex
 * @returns {Error}
 */
function _mapEventBaseError(e, windowIndex) {
    if (!(e instanceof LlmCallError)) return /** @type {Error} */ (e);
    switch (e.kind) {
        case 'auth': return new EventBaseFatalError(e.message, 'invalid_api_key');
        case 'model_config': return new EventBaseFatalError(e.message, 'invalid_model_config');
        case 'connection': return new EventBaseFatalError(e.message, 'connection_failed');
        default: return new EventBaseExtractionError(e.message, windowIndex); // 'http' | 'empty'
    }
}

// EventBase prompts require a top-level JSON array, so the shared call must NOT
// force response_format=json_object (providers would coerce output to an object
// and suppress valid array responses) — we simply omit responseFormat below.

// (Reply extraction, empty-reply classification, and JSON-array parsing now
// live in core/llm-provider-call.js — postChatCompletion + parseJsonArrayFromLlm.)

// ---------------------------------------------------------------------------
// Script detection (lightweight)
// ---------------------------------------------------------------------------

/**
 * Returns the dominant script class of a string.
 * Used as a post-parse sanity check to catch language-rule violations.
 * @param {string} text
 * @returns {'cjk'|'latin'|'mixed'|'empty'}
 */
function _detectScript(text) {
    if (!text) return 'empty';
    const cjk = (text.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const total = cjk + latin;
    if (total === 0) return 'empty';
    const cjkRatio = cjk / total;
    if (cjkRatio > 0.6) return 'cjk';
    if (cjkRatio < 0.2) return 'latin';
    return 'mixed';
}

/**
 * Infers the human language for the LLM hint, even for mixed-script excerpts.
 * Returns null when the excerpt is clearly Latin-only.
 */
function _inferLanguageHint(text) {
    if (!text) return null;
    const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
    const hiragana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const cjk = (text.match(/[\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length + hangul + hiragana;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const total = cjk + latin;
    if (total === 0 || cjk / total < 0.15) return null; // too little CJK to guess
    if (hangul > hiragana && hangul > cjk * 0.3) return '\uD55C\uAD6D\uC5B4 (Korean)';
    if (hiragana > 5) return '\u65E5\u672C\u8A9E (Japanese)';
    return '\u4E2D\u6587 (Chinese)';
}

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

async function _callOpenRouter(prompt, settings, windowIndex) {
    // Presence-only check: getOpenRouterApiKey() returns ST's MASKED value; the
    // real key is read server-side by the proxy (see llm-provider-call.js).
    const apiKey = _getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new EventBaseFatalError(
            'EventBase: OpenRouter API key not found. Add it in EventBase settings (or Summarize Before Store settings uses the same key).',
            'missing_api_key',
        );
    }

    const model = (settings.chat_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set the Summarization Model in Core → LLM Summarization settings.',
            'missing_model',
        );
    }

    try {
        const { content } = await postChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            model,
            provider: 'openrouter',
            maxTokens: settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS,
            temperature: settings.eventbase_temperature ?? DEFAULT_TEMPERATURE,
            timeoutMs: settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS,
            contextLabel: 'EventBase',
            ...resolveModelParameterStyle(settings),
        });
        return content;
    } catch (e) {
        throw _mapEventBaseError(e, windowIndex);
    }
}

async function _callVLLM(prompt, settings, windowIndex) {
    const baseUrl = (settings.chat_vllm_url || '').trim();
    if (!baseUrl) {
        throw new EventBaseFatalError(
            'EventBase: vLLM URL not configured. Set the vLLM URL in Core → LLM Summarization settings.',
            'missing_url',
        );
    }

    const model = (settings.chat_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set the Summarization Model in Core → LLM Summarization settings.',
            'missing_model',
        );
    }

    const apiKey = getCustomApiKey(settings);
    if (!apiKey) {
        throw new EventBaseFatalError(
            'EventBase: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → LLM Summarization settings.',
            'missing_api_key',
        );
    }

    try {
        const { content } = await postChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            model,
            provider: 'vllm',
            vllmUrl: baseUrl,
            maxTokens: settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS,
            temperature: settings.eventbase_temperature ?? DEFAULT_TEMPERATURE,
            timeoutMs: settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS,
            contextLabel: 'EventBase',
            ...resolveModelParameterStyle(settings),
        });
        return content;
    } catch (e) {
        throw _mapEventBaseError(e, windowIndex);
    }
}

/**
 * Resolve a real-world timestamp for an extraction window from the messages'
 * `send_date` (SillyTavern stamps every message with one; the upload path
 * preserves it). This is the FINAL date fallback: every event gets an absolute
 * real-world anchor even when no in-story DateTime/scene_time can be mined from
 * the narrative or reasoning.
 *
 * Deterministic metadata — NOT an LLM field, and deliberately kept OUT of the
 * extraction excerpt so the model never mistakes the out-of-character send time
 * (e.g. 2026) for the in-story DateTime (e.g. the year 1577). That separation is
 * exactly why this lives here and needs no prompt change, unlike `reasoning`.
 *
 * Walks from the most recent message backward — the event's real-world time is
 * best represented by the latest contributing message. Normalizes to ISO-8601
 * when parseable; otherwise keeps the raw string so an unusual ST timestamp
 * format is still captured. Returns null when no message carries a send_date.
 *
 * @param {object[]} messages
 * @returns {string|null}
 */
function _resolveWindowRealWorldDate(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const raw = messages[i]?.send_date;
        if (raw == null) continue;
        const s = String(raw).trim();
        if (!s) continue;
        const ms = Date.parse(s);
        return Number.isNaN(ms) ? s : new Date(ms).toISOString();
    }
    return null;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract structured event records from a window of chat messages.
 *
 * @param {object} params
 * @param {object[]} params.messages  - Array of chat message objects with .mes and .name
 * @param {number} params.windowStart - 0-based start index in the full chat
 * @param {number} params.windowEnd   - 0-based end index (inclusive)
 * @param {object} params.settings    - VectFox settings
 * @param {number} [params.windowIndex] - Window index for error reporting
 * @returns {Promise<object[]>} Array of full EventRecord objects (ingestion fields attached)
 */
export async function extractEvents({ messages, windowStart, windowEnd, settings, windowIndex = 0 }) {
    // Logging routes through core/log.js. Per-window flow → Verbose; per-item
    // parse detail → Trace; raw LLM/parser dumps → 'raw_llm' domain deep-dive.

    // Compact message-range tag appended to every log line so chunks in the DB browser
    // (which display "from Message #<windowEnd>") are searchable directly from the log.
    const msgRange = `msgs=${windowStart}-${windowEnd}`;

    // Build excerpt text from messages
    let _reasoningMsgs = 0; // diagnostic: how many messages contributed a reasoning block
    const excerptLines = messages.map((m, mi) => {
        const speaker = m.name || (m.is_user ? 'User' : 'Assistant');
        const text = cleanText(String(m.mes || '')).trim();
        // Date/time/location fallback for chats whose narrative has no inline date:
        // append a capped, fenced reasoning block. The prompt's Rule 4 instructs the
        // model to read it ONLY for DateTime/scene_time/locations, never as a source
        // of events. Both shapes: live-chat ST objects (m.extra.reasoning) and
        // upload-path normalized objects (m.reasoning).
        const reasoning = String(m.extra?.reasoning ?? m.reasoning ?? '').trim();
        // scene_time diagnostic: per-message reasoning presence + which field it came from.
        const rsrc = m.extra?.reasoning ? 'extra.reasoning' : (m.reasoning ? 'reasoning' : 'none');
        log.trace(`[EventBase][scene_time] win=${windowIndex} msg#${mi} "${speaker}": mes=${text.length}c reasoning=${reasoning.length}c src=${rsrc}`);
        if (!reasoning) return `${speaker}: ${text}`;
        _reasoningMsgs++;
        const capped = StringUtils.truncateCodePoints(reasoning, REASONING_FEED_CHAR_CAP);
        // Log the EXACT reasoning substring sent to the model (cap = REASONING_FEED_CHAR_CAP
        // code points). Lets you confirm the date/time/location line survived the cut.
        log.trace(`[EventBase][scene_time] win=${windowIndex} msg#${mi} REASONING SENT (${Array.from(capped).length}cp of ${Array.from(reasoning).length}cp original, cap=${REASONING_FEED_CHAR_CAP}):\n>>>${capped}<<<`);
        return `${speaker}: ${text}\n[REASONING — CONTEXT ONLY, for date/time/location; NOT a source of events]\n${capped}`;
    });
    const excerptText = excerptLines.join('\n\n');
    log.trace(`[EventBase][scene_time] win=${windowIndex} ${msgRange}: ${_reasoningMsgs}/${messages.length} msgs had reasoning; excerpt contains REASONING block=${excerptText.includes('[REASONING')}`);

    if (!excerptText.trim()) {
        log.verbose('[EventBase] Skipping empty window');
        return [];
    }

    const maxCount = settings.eventbase_max_events_per_window || 5;

    // Detect dominant script BEFORE building prompt so we can inject an explicit language hint
    const excerptScript = _detectScript(excerptText);
    const languageHint = _inferLanguageHint(excerptText);
    let basePrompt = buildExtractionPrompt(
        excerptText,
        maxCount,
        settings.eventbase_custom_prompt || '',
        settings.cjk_tokenizer_mode || 'intl',
    );
    if (languageHint) {
        basePrompt = `DETECTED EXCERPT LANGUAGE: ${languageHint}. You MUST write ALL string fields in that language — no exceptions.\n\n${basePrompt}`;
    }
    const prompt = basePrompt;
    const provider = (settings.chat_provider || 'openrouter').toLowerCase();

    // scene_time diagnostic: confirm the ACTIVE prompt actually carries the new
    // Rule 4 + scene_time field. If usingCustom=true and hasRule4=false, a saved
    // custom prompt is overriding the built-in (the model is never told to mine
    // date/time from the reasoning block, nor that scene_time exists).
    const usingCustomPrompt = !!(settings.eventbase_custom_prompt && settings.eventbase_custom_prompt.trim());
    log.trace(`[EventBase][scene_time] win=${windowIndex} prompt: usingCustom=${usingCustomPrompt}, hasRule4(REASONING BLOCKS)=${prompt.includes('REASONING BLOCKS')}, hasSceneTimeField=${prompt.includes('scene_time:')}, promptLen=${prompt.length}`);
    // Full excerpt (the variable part actually sent) for deep inspection.
    log.domain('raw_llm', 'trace', `[EventBase][scene_time] Full excerpt sent (window=${windowIndex} ${msgRange}):\n${excerptText}`);

    log.verbose(`[EventBase] Extracting events — window=${windowIndex} ${msgRange}, provider=${provider}, messages=${messages.length}`);

    // Call provider
    let rawReply;
    if (provider === 'vllm') {
        rawReply = await _callVLLM(prompt, settings, windowIndex);
    } else {
        rawReply = await _callOpenRouter(prompt, settings, windowIndex);
    }

    log.domain('raw_llm', 'trace', `[EventBase] Raw LLM reply (window=${windowIndex} ${msgRange}):`, rawReply.slice(0, 500));

    // Parse JSON
    let rawArray;
    try {
        rawArray = parseJsonArrayFromLlm(rawReply, {
            label: 'EventBase',
            index: windowIndex,
            range: msgRange,
            identKeys: ['event_type', 'summary', 'importance'],
        });
    } catch (parseErr) {
        // Always log full raw reply on parse failure — this is a real failure.
        log.warn(`[EventBase] Window ${windowIndex} ${msgRange}: parse failed. Full raw reply:\n${rawReply}`);
        throw new EventBaseExtractionError(
            `EventBase: JSON parse failed for window ${windowIndex} (${msgRange}): ${parseErr.message}`,
            windowIndex,
        );
    }

    log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: parsed ${rawArray.length} event candidate(s)`);

    // Empty array is valid (no events extracted)
    if (rawArray.length === 0) {
        log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: LLM returned no events (valid skip)`);
        return [];
    }

    if (log.enabled('trace')) {
        log.trace(`[EventBase] Parsed array (window=${windowIndex} ${msgRange}): ${rawArray.length} items, types: [${rawArray.map(item => typeof item).join(', ')}]`);
        if (rawArray.length > 0 && typeof rawArray[0] !== 'object') {
            log.trace(`[EventBase] First item (non-object): ${JSON.stringify(rawArray[0]).slice(0, 100)}`);
        }
    }

    // Enforce hard cap — sort by importance desc, then truncate
    if (rawArray.length > maxCount) {
        log.warn(`[EventBase] Window ${windowIndex} ${msgRange}: LLM returned ${rawArray.length} events (> cap ${maxCount}), truncating by importance`);
        rawArray = rawArray
            .slice()
            .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
            .slice(0, maxCount);
    }

    // Validate + coerce each event
    const validatedEvents = [];
    const now = Date.now();
    // Real-world send-time anchor stamped onto every event in this window — the
    // final date fallback when no in-story DateTime/scene_time is available.
    const realWorldDate = _resolveWindowRealWorldDate(messages);
    log.trace(`[EventBase][scene_time] win=${windowIndex} real_world_date=${JSON.stringify(realWorldDate)} (from ${messages.length} msg send_date(s))`);
    for (let i = 0; i < rawArray.length; i++) {
        const { ok, errors, event } = validateEvent(rawArray[i]);
        if (!ok) {
            log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: validation failed — ${errors.join('; ')} — skipped`);
            continue;
        }
        if (errors.length > 0) {
            log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: coercion warnings — ${errors.join('; ')}`);
        }

        // scene_time diagnostic: what the model returned for the date/time/location
        // fields, AND what the raw LLM object had for them before validation (so we
        // can tell "model omitted it" from "validator dropped it").
        log.trace(`[EventBase][scene_time] win=${windowIndex} item ${i}: raw.DateTime=${JSON.stringify(rawArray[i]?.DateTime)} raw.scene_time=${JSON.stringify(rawArray[i]?.scene_time)} | validated DateTime=${JSON.stringify(event.DateTime)} scene_time=${JSON.stringify(event.scene_time)} locations=${JSON.stringify(event.locations)}`);

        // Post-parse language sanity check (warn only — retained for visibility,
        // does not drop the event; retrieval quality may suffer if the summary
        // language doesn't match the collection's tokenizer mode)
        const summaryScript = _detectScript(event.summary);
        if (excerptScript !== 'empty' && excerptScript !== 'mixed' && summaryScript !== 'empty' && summaryScript !== 'mixed') {
            if (excerptScript !== summaryScript) {
                log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: language mismatch (excerpt=${excerptScript}, summary=${summaryScript}) — kept`);
            }
        }

        // Attach ingestion metadata (event_id, source info, timestamps)
        const eventId = `eb_${Date.now()}_${windowStart}_${i}_${Math.random().toString(36).slice(2, 7)}`;
        const sourceHashes = messages.map(m => {
            // Use the message's hash if stored, otherwise hash the text
            const text = (m.mes || '').trim();
            return m.hash ?? _simpleHash(`${m.name || ''}:${text}`);
        });

        validatedEvents.push({
            ...event,
            event_id: eventId,
            source_message_ids: messages.map((_, idx) => windowStart + idx),
            source_message_hashes: sourceHashes,
            source_window_start: windowStart,
            source_window_end: windowEnd,
            // Intra-window event order (0-based, resets each window) plus the
            // packed whole-timeline sort key. `i` is the event's position in the
            // window's raw extraction array, so events keep chat-history order
            // even when a big window holds several events and windows are
            // processed out of order by the parallel concurrency pool.
            window_event_order: i,
            timeline_sort_key: packTimelineSortKey(windowStart, i),
            created_at: now,
            real_world_date: realWorldDate, // ISO send_date anchor; null if none
            schema_version: EVENTBASE_SCHEMA_VERSION,
        });
    }

    log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: extracted ${validatedEvents.length} valid events`);

    return validatedEvents;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Minimal djb2-style hash for message dedup (used when m.hash is not present).
 * @param {string} str
 * @returns {number}
 */
function _simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}
