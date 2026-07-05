/**
 * ============================================================================
 * EVENTBASE INJECTION
 * ============================================================================
 * Formats retrieved EventRecord objects into a prompt block for injection.
 * No hard character budget is enforced — Top-K and retrieval filters control
 * payload size.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Extract the summary line from an event's stored embed text.
 * The text is built by buildEmbedText() and starts with "[event_type] summary"
 * on its first line. Strips the bracketed event_type prefix.
 * @param {string} text
 * @returns {string}
 */
function _summaryFromText(text) {
    if (!text) return '';
    const firstLine = String(text).split('\n')[0];
    const match = firstLine.match(/^\[[^\]]+\]\s*(.*)$/);
    return match ? match[1] : firstLine;
}

/**
 * Strip internal scoring/ingestion fields that should not be injected.
 * Returns only the canonical EventRecord fields.
 * @param {object} event
 * @returns {object}
 */
function _cleanEventForInjection(event) {
    return {
        event_type: event.event_type,
        importance: event.importance,
        message_order: event.source_window_end ?? null,
        summary: _summaryFromText(event.text),
        DateTime: event.DateTime || null,
        scene_time: event.scene_time || '',
        cause: event.cause || '',
        result: event.result || '',
        characters: event.characters || [],
        locations: event.locations || [],
        factions: event.factions || [],
        items: event.items || [],
        concepts: event.concepts || [],
        keywords: event.keywords || [],
        open_threads: event.open_threads || [],
        should_persist: event.should_persist === true,
    };
}

/**
 * Format events as a JSON array string (canonical format).
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsJson(events) {
    return JSON.stringify(events.map(_cleanEventForInjection), null, 2);
}

// ---------------------------------------------------------------------------
// Dense text format
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function _stringifyList(value) {
    if (!Array.isArray(value) || value.length === 0) return '-';
    return value.map(v => String(v)).join(', ');
}

/**
 * Format events as compact dense text blocks.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsDenseText(events) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `event_type: ${event.event_type || '-'}`,
            `importance: ${event.importance ?? '-'}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `DateTime: ${event.DateTime || '-'}`,
            `scene_time: ${event.scene_time || '-'}`,
            `cause: ${event.cause || '-'}`,
            `result: ${event.result || '-'}`,
            `characters: ${_stringifyList(event.characters)}`,
            `locations: ${_stringifyList(event.locations)}`,
            `factions: ${_stringifyList(event.factions)}`,
            `items: ${_stringifyList(event.items)}`,
            `concepts: ${_stringifyList(event.concepts)}`,
            `keywords: ${_stringifyList(event.keywords)}`,
            `open_threads: ${_stringifyList(event.open_threads)}`,
            `should_persist: ${event.should_persist ? 'true' : 'false'}`,
        ].join('\n');
    }).join('\n\n');
}

/**
 * Format events as summary + DateTime only — minimal prompt footprint.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsSummaryOnly(events) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `DateTime: ${event.DateTime || '-'}`,
            `scene_time: ${event.scene_time || '-'}`,
        ].join('\n');
    }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Presentation order
// ---------------------------------------------------------------------------

/**
 * One-line instruction prepended to every injected block so the model knows the
 * events are in chronological order and which field encodes it. A silent
 * re-order only half-helps; naming the ordering makes it usable.
 */
const INJECTION_HEADER =
    'Past events, ordered oldest → newest by message_order (position in the conversation). '
    + "Use each event's DateTime/scene_time to place it on the story timeline.";

/**
 * Re-order retrieved events for presentation: chronological, oldest → newest.
 * Relevance (retrieval score) decides WHICH events are included upstream; this
 * only decides DISPLAY order — no events are added or dropped.
 *
 * Sort key is `source_window_end` (message_order): ingestion-stamped,
 * deterministic, monotonic within a conversation. NOT the LLM-extracted
 * `DateTime`, which is nullable and can mis-parse — a bad parse would teleport
 * an event across the timeline. DateTime/scene_time still print per event as
 * labels the model can read.
 *
 * Cross-frame safety: `source_window_end` is a message index within ONE
 * conversation, so it is meaningless across collections (archive chats,
 * cross-chat locks). Events are grouped by their source frame (`_sortFrame`,
 * stamped at query time) and only sorted within a frame. Frames are then ordered
 * by their most-recent `real_world_date` (wall-clock send time, comparable
 * across conversations) so the actively-played chat lands last and older
 * archives first. Frames with no real-world anchor sort first.
 *
 * Array#sort is stable, so ties (same window, or a frame with no anchor) retain
 * the incoming relevance order as a sensible tie-break.
 *
 * @param {object[]} events
 * @returns {object[]} new array, same members, presentation order
 */
function _orderEventsForPresentation(events) {
    const byWindow = (a, b) => {
        const av = typeof a.source_window_end === 'number' ? a.source_window_end : Infinity;
        const bv = typeof b.source_window_end === 'number' ? b.source_window_end : Infinity;
        return av - bv;
    };

    // Fast path: a single (or absent) frame — no cross-conversation risk.
    const frames = new Set(events.map(e => e._sortFrame ?? '__default__'));
    if (frames.size <= 1) {
        return [...events].sort(byWindow);
    }

    const groups = new Map();
    for (const e of events) {
        const key = e._sortFrame ?? '__default__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    // A frame's timeline position = the newest real-world send time it contains.
    // No anchor anywhere in the frame → -Infinity → sorts first (unknown/oldest).
    const frameAnchor = (list) => {
        let max = -Infinity;
        for (const e of list) {
            const t = e.real_world_date ? Date.parse(e.real_world_date) : NaN;
            if (!Number.isNaN(t) && t > max) max = t;
        }
        return max;
    };

    return [...groups.values()]
        .map(list => ({ list: [...list].sort(byWindow), anchor: frameAnchor(list) }))
        .sort((a, b) => a.anchor - b.anchor)
        .flatMap(g => g.list);
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format retrieved events into a prompt injection string.
 * No hard cap is applied here; Top-K and retrieval filters control payload size.
 * Events are re-ordered chronologically for presentation before formatting.
 *
 * @param {object[]} events   - Re-ranked EventRecord objects (highest score first)
 * @param {object}   settings - VectFox settings
 * @returns {string}          - Formatted string ready for injection (empty string if nothing fits)
 */
export function formatEventsForInjectionDetailed(events, _settings) {
    if (!events?.length) {
        return { text: '', includedCount: 0, requestedCount: 0 };
    }

    const ordered = _orderEventsForPresentation(events);

    const format = String(_settings?.eventbase_injection_format || 'densetext').toLowerCase();
    const body = format === 'densetext'
        ? _formatAsDenseText(ordered)
        : format === 'summaryonly'
            ? _formatAsSummaryOnly(ordered)
            : _formatAsJson(ordered);

    return {
        text: `${INJECTION_HEADER}\n${body}`,
        includedCount: ordered.length,
        requestedCount: events.length,
    };
}

