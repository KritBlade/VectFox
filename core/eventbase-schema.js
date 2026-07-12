/**
 * ============================================================================
 * EVENTBASE SCHEMA
 * ============================================================================
 * Canonical schema constants, validator, and embed-text builder for EventBase.
 * All extraction, storage, and retrieval depend on this single module.
 *
 * The LLM extraction prompt itself lives in core/prompts-i18n.js
 * (`getEventBaseExtractionPrompt(mode)`), which has per-language variants
 * driven by the CJK Tokenizer Mode setting. buildExtractionPrompt() below
 * just selects the right variant and substitutes {{text}} / {{maxCount}}.
 * ============================================================================
 */
import { getEventBaseExtractionPrompt } from './prompts-i18n.js';
import StringUtils from '../utils/string-utils.js';

/**
 * Controlled vocabulary for event_type field.
 * LLM is instructed to map any event to one of these; 'other' is the fallback.
 * @type {readonly string[]}
 */
export const EVENT_TYPES = Object.freeze([
    'main_quest_update',
    'side_quest_update',
    'combat',
    'travel',
    'discovery',
    'dialogue_significant',
    'relationship_change',
    'character_introduction',
    'character_state_change',
    'item_acquired',
    'item_lost',
    'faction_change',
    'location_change',
    'revelation',
    'promise_or_oath',
    'betrayal',
    'death',
    'other',
]);

// 1.2 (2026-06-20): added optional `scene_time` (verbatim in-story date/time).
// 1.3 (2026-06-21): added `real_world_date` — the message's send_date stamped
// as a deterministic real-world anchor (final date fallback). Ingestion-side
// metadata, not an LLM field; older events simply lack it.
// Float is safe — this constant is only stamped onto events + stored, never
// compared or ordered. No re-extraction of older (v1) events is forced.
export const EVENTBASE_SCHEMA_VERSION = 1.3;

/**
 * Non-fatal extraction parse error (per-window; caller should log + skip).
 */
export class EventBaseExtractionError extends Error {
    /**
     * @param {string} message
     * @param {number} [windowIndex]
     */
    constructor(message, windowIndex = -1) {
        super(message);
        this.name = 'EventBaseExtractionError';
        this.windowIndex = windowIndex;
    }
}

/**
 * Fatal configuration/auth error (aborts entire ingestion run).
 */
export class EventBaseFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'fatal') {
        super(message);
        this.name = 'EventBaseFatalError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Dedupe + trim an array of strings; drop empties. Single implementation lives
// in StringUtils (shared with reformat-schema.js) — aliased here so the call
// sites below stay terse.
const ensureArray = StringUtils.ensureArray;

/**
 * Normalize optional DateTime field (ISO 8601 string) from LLM output.
 * Accepts DateTime/dateTime/datetime/date_time keys; invalid values become null.
 * @param {unknown} raw
 * @param {string[]} errors
 * @returns {string|null}
 */
function ensureDateTime(raw, errors) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = (/** @type {any} */ (raw)).DateTime
        ?? (/** @type {any} */ (raw)).dateTime
        ?? (/** @type {any} */ (raw)).datetime
        ?? (/** @type {any} */ (raw)).date_time
        ?? null;

    if (v == null || v === '') return null;
    const s = String(v).trim();
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();

    errors.push(`DateTime "${s}" is not valid ISO-8601 — dropped`);
    return null;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates and coerces a raw LLM-produced event object.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], event?: import('./eventbase-schema.js').EventRecord }}
 */
export function validateEvent(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const debugInfo = typeof raw === 'string' ? `string "${raw.slice(0, 50)}"` : typeof raw;
        return { ok: false, errors: [`Event is not an object (got ${debugInfo})`] };
    }

    // event_type — coerce unknown to 'other'
    let event_type = String((/** @type {any} */ (raw)).event_type ?? '').trim();
    if (!EVENT_TYPES.includes(event_type)) {
        errors.push(`event_type "${event_type}" not in vocabulary — coerced to "other"`);
        event_type = 'other';
    }

    // importance — number 1-10 integer
    let importance = Number((/** @type {any} */ (raw)).importance);
    if (!Number.isFinite(importance)) {
        errors.push(`importance "${(/** @type {any} */ (raw)).importance}" is not a number — defaulted to 5`);
        importance = 5;
    } else {
        const clamped = Math.round(Math.max(1, Math.min(10, importance)));
        if (clamped !== Math.round(importance)) {
            errors.push(`importance clamped from ${importance} to ${clamped}`);
        }
        importance = clamped;
    }

    // summary — required non-empty string
    const summary = typeof (/** @type {any} */ (raw)).summary === 'string' ? (/** @type {any} */ (raw)).summary.trim() : '';
    if (!summary) {
        return { ok: false, errors: ['summary is empty or missing'] };
    }

    const concepts = ensureArray((/** @type {any} */ (raw)).concepts);
    const rawKeywords = ensureArray((/** @type {any} */ (raw)).keywords);

    // Merge concepts into keywords (case-insensitive dedup) so concept terms are
    // always searchable via the keyword index even if the LLM forgot to copy them
    // over. Characters/locations/items are NOT merged — they appear in the embed
    // text already and would dominate keyword recall with generic name matches.
    const seen = new Set(rawKeywords.map(k => k.toLowerCase()));
    const mergedKeywords = [...rawKeywords];
    for (const c of concepts) {
        const key = c.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            mergedKeywords.push(c);
        }
    }

    const event = {
        event_type,
        importance,
        summary,
        DateTime: ensureDateTime(raw, errors),
        // Verbatim in-story date/time, preserved exactly as written (any calendar/
        // format/language). Companion to the ISO DateTime above — NOT parsed. Single
        // line + capped to 100 code points so parseEmbedText round-trips it cleanly.
        scene_time: typeof (/** @type {any} */ (raw)).scene_time === 'string'
            ? StringUtils.truncateCodePoints((/** @type {any} */ (raw)).scene_time.replace(/\s+/g, ' ').trim(), 100)
            : '',
        cause: typeof (/** @type {any} */ (raw)).cause === 'string' ? (/** @type {any} */ (raw)).cause.trim() : '',
        result: typeof (/** @type {any} */ (raw)).result === 'string' ? (/** @type {any} */ (raw)).result.trim() : '',
        characters: ensureArray((/** @type {any} */ (raw)).characters),
        locations: ensureArray((/** @type {any} */ (raw)).locations),
        factions: ensureArray((/** @type {any} */ (raw)).factions),
        items: ensureArray((/** @type {any} */ (raw)).items),
        concepts,
        keywords: mergedKeywords,
        open_threads: ensureArray((/** @type {any} */ (raw)).open_threads),
        should_persist: (/** @type {any} */ (raw)).should_persist === true,
    };

    return { ok: true, errors, event };
}

// ---------------------------------------------------------------------------
// Embed-text builder
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic text string used for embedding an event.
 * Empty fields are skipped so they don't dilute the semantic signal.
 * @param {object} event
 * @returns {string}
 */
export function buildEmbedText(event) {
    const parts = [`[${event.event_type}] ${event.summary}`];
    if (event.DateTime) parts.push(`TIME: ${event.DateTime}`);
    if (event.scene_time) parts.push(`SCENE_TIME: ${event.scene_time}`);
    if (event.cause) parts.push(`CAUSE: ${event.cause}`);
    if (event.result) parts.push(`RESULT: ${event.result}`);
    if (event.characters?.length) parts.push(`CHARS: ${event.characters.join(', ')}`);
    if (event.locations?.length) parts.push(`LOCS: ${event.locations.join(', ')}`);
    if (event.items?.length) parts.push(`ITEMS: ${event.items.join(', ')}`);
    if (event.keywords?.length) parts.push(`KEYS: ${event.keywords.join(', ')}`);
    if (event.open_threads?.length) parts.push(`THREADS: ${event.open_threads.join(', ')}`);
    // Note: `factions` is INTENTIONALLY excluded from embed text — faction
    // names tend to be generic strings ("Empire", "Council", "Rebels") that
    // would dominate keyword recall and pollute vector similarity with
    // matches that don't reflect actual narrative relevance. Factions are
    // still collected by the validator + stored in payload, and AgentMode
    // can filter by them via the `factions_any` planner field. Treat
    // factions as a STRUCTURED filter signal, not a text-retrieval signal.
    return parts.join('\n');
}

const _ARRAY_KEYS = new Set(['CHARS', 'LOCS', 'ITEMS', 'KEYS', 'THREADS']);
const _KEY_MAP = { TIME: 'DateTime', SCENE_TIME: 'scene_time', CAUSE: 'cause', RESULT: 'result', CHARS: 'characters', LOCS: 'locations', ITEMS: 'items', KEYS: 'keywords', THREADS: 'open_threads' };

/**
 * Reverses buildEmbedText — parses a stored embed text string back into
 * EventBase content fields. Used by the native ST backend path where Vectra
 * only stores {hash, text, index} and structured metadata is unavailable.
 *
 * Recovers: event_type, summary, DateTime, scene_time, cause, result,
 *           characters, locations, items, keywords, open_threads.
 * Does NOT recover: importance, message_order, event_id, should_persist
 *                   (those were never written into the embed text).
 * @param {string} text
 * @returns {object}
 */
export function parseEmbedText(text) {
    if (!text) return {};
    const lines = text.split('\n');
    const result = {};

    const firstLine = lines[0] || '';
    const typeMatch = firstLine.match(/^\[([^\]]+)\]\s*(.*)/s);
    if (typeMatch) {
        result.event_type = typeMatch[1].trim();
        result.summary = typeMatch[2].trim();
    }

    for (let i = 1; i < lines.length; i++) {
        const colonIdx = lines[i].indexOf(':');
        if (colonIdx < 0) continue;
        const key = lines[i].slice(0, colonIdx).trim();
        const val = lines[i].slice(colonIdx + 1).trim();
        const field = _KEY_MAP[key];
        if (!field) continue;
        result[field] = _ARRAY_KEYS.has(key) ? val.split(', ').filter(Boolean) : val;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

/**
 * Deprecated direct export — points at the English (intl) variant for any
 * importers that haven't migrated. New callers should pass the user's
 * cjk_tokenizer_mode through buildExtractionPrompt() or call
 * getEventBaseExtractionPrompt(mode) from prompts-i18n.js directly.
 */
export const DEFAULT_EXTRACTION_PROMPT = getEventBaseExtractionPrompt('intl');


/**
 * Builds the LLM extraction prompt for a given excerpt.
 *
 * Template selection (first non-empty wins):
 *   1. `customPrompt` — user-edited override from settings.eventbase_custom_prompt
 *   2. `getEventBaseExtractionPrompt(mode)` — built-in default localized to the
 *      user's CJK Tokenizer Mode (defaults to 'intl' / English when mode is
 *      unset or unrecognized)
 *
 * Then `{{text}}` and `{{maxCount}}` are substituted before returning.
 *
 * @param {string} text  - The chat excerpt (already joined messages)
 * @param {number} maxCount - Max events to return (eventbase_max_events_per_window)
 * @param {string} [customPrompt] - Optional custom prompt template from settings
 * @param {string} [mode] - CJK Tokenizer Mode (intl / jieba / jieba_tw /
 *                          tiny_segmenter / korean / others). Ignored when
 *                          customPrompt is provided.
 * @returns {string}
 */
export function buildExtractionPrompt(text, maxCount, customPrompt = '', mode = 'intl') {
    const template = (customPrompt && customPrompt.trim())
        ? customPrompt
        : getEventBaseExtractionPrompt(mode);
    return template
        .replace(/\{\{maxCount\}\}/g, String(maxCount))
        .replace(/\{\{text\}\}/g, text);
}
