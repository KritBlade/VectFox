/**
 * ============================================================================
 * CHUNK VISUALIZER, CORE
 * ============================================================================
 * The Chunk Visualizer's rules as plain values, for chunk-visualizer.js to wire
 * and chunk-visualizer-markup.js to draw: what a chunk holds, which chunks the
 * list shows and in what order, how a row reads, and what the chunk's form
 * changes against what is saved. Pure: no host, no page.
 * ============================================================================
 */

import { parseInjection, sanitizeXmlTag } from './collection-settings-core.js';

/** The boost a keyword gets when none is given. */
export const DEFAULT_KEYWORD_WEIGHT = 1.5;

/** How many rows the list shows at first, and how many more each "Show more" adds. */
export const LIST_PAGE_SIZE = 50;

/** How many characters of a chunk's text stand in for a name it does not have. */
const PREVIEW_LENGTH = 60;

/** The orders the list offers. */
export const CHUNK_SORTS = Object.freeze([
    { value: 'index', label: 'Message order' },
    { value: 'index-reversed', label: 'Latest message first' },
    { value: 'length-desc', label: 'Longest first' },
    { value: 'length-asc', label: 'Shortest first' },
    { value: 'keywords', label: 'Most keywords' },
    { value: 'customized', label: 'Named or tagged first' },
]);

/** The filters the list offers. */
export const CHUNK_FILTERS = Object.freeze([
    { value: 'all', label: 'All chunks' },
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
    { value: 'keywords', label: 'With keywords' },
]);

/** How a link pulls its target in. */
export const LINK_MODES = Object.freeze([
    { value: 'force', label: 'Force', description: 'Always comes along' },
    { value: 'soft', label: 'Soft', description: 'Scores higher' },
]);

const asList = value => (Array.isArray(value) ? value.map(String) : []);

/**
 * EventBase stores extracted events, and its retrieval ranks them by importance and recency: it reads no chunk's
 * on/off switch, keywords or links.
 *
 * @param {string} collectionId
 * @returns {boolean}
 */
export function isEventBaseCollection(collectionId) {
    const id = String(collectionId || '').toLowerCase();
    return id.startsWith('vf_eventbase_') || id.includes('_eventbase_');
}

/**
 * Keywords as `{text, weight}`: a bare word gets the default boost, an object without a weight none (1).
 *
 * @param {unknown} keywords
 * @returns {{text: string, weight: number}[]}
 */
export function normalizeKeywords(keywords) {
    if (!Array.isArray(keywords)) return [];
    return keywords.map((keyword) => {
        if (typeof keyword === 'string') return keyword ? { text: keyword, weight: DEFAULT_KEYWORD_WEIGHT } : null;
        if (keyword && typeof keyword === 'object' && keyword.text) {
            const weight = Number(keyword.weight ?? 1);
            return { text: String(keyword.text), weight: Number.isFinite(weight) ? weight : 1 };
        }
        return null;
    }).filter(Boolean);
}

/**
 * A keyword's boost from its box: a positive number, or the default for anything else.
 *
 * @param {string} text
 * @returns {number}
 */
export function parseKeywordWeight(text) {
    const weight = Number.parseFloat(text);
    return Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_KEYWORD_WEIGHT;
}

function normalizeLinks(links) {
    if (!Array.isArray(links)) return [];
    return links
        .filter(link => link && link.targetHash !== undefined && link.targetHash !== null && link.targetHash !== '')
        .map(link => ({ targetHash: link.targetHash, mode: link.mode === 'soft' ? 'soft' : 'force' }));
}

/** A saved position and depth as the form reads them back: a depth only for the in-chat position. */
function savedInjection(position, depth) {
    const asText = value => (value === undefined || value === null ? '' : String(value));
    return parseInjection(asText(position), asText(depth));
}

/**
 * What a chunk holds, as its form shows it. The backend payload comes first; a chunk saved before the payload carried
 * these fields has them in VectFox's settings (`stored`, its getChunkMetadata), and an empty text field there counts as
 * none. Summaries live only in the settings.
 *
 * @param {{text?: string, keywords?: unknown, metadata?: object}} chunk
 * @param {object} [stored]
 * @returns {{text: string, name: string, enabled: boolean, context: string, xmlTag: string, position: number|null,
 *   depth: number|null, keywords: {text: string, weight: number}[], chunkLinks: {targetHash: string|number, mode: string}[],
 *   summaries: string[]}}
 */
export function savedChunkFields(chunk, stored = {}) {
    const payload = chunk.metadata || {};
    const pick = (first, second) => (first !== undefined && first !== null ? first : second);
    const pickText = (first, second) => (first !== undefined && first !== null && first !== '' ? first : second);
    const keywords = Array.isArray(payload.keywords) && payload.keywords.length > 0
        ? payload.keywords
        : (stored.keywords !== undefined ? stored.keywords : chunk.keywords);
    const injection = savedInjection(pick(payload.position, stored.position), pick(payload.depth, stored.depth));
    return {
        text: String(chunk.text ?? ''),
        name: String(pickText(payload.name, stored.name) ?? '').trim(),
        enabled: pick(payload.enabled, stored.enabled) !== false,
        context: String(pickText(payload.context, stored.context) ?? ''),
        xmlTag: String(pickText(payload.xmlTag, stored.xmlTag) ?? ''),
        position: injection.position,
        depth: injection.depth,
        keywords: normalizeKeywords(keywords),
        chunkLinks: normalizeLinks(payload.chunkLinks || stored.chunkLinks),
        summaries: asList(stored.summaries),
    };
}

/**
 * An EventBase event's own fields, which the form shows and never edits.
 *
 * @param {{metadata?: object}} chunk
 * @returns {{type: string, importance: number|null, concepts: string[], items: string[], openThreads: string[], sentAt: string}}
 */
export function eventFields(chunk) {
    const payload = chunk.metadata || {};
    const importance = Number(payload.importance);
    return {
        type: String(payload.event_type || ''),
        importance: payload.importance !== undefined && payload.importance !== null && Number.isFinite(importance) ? importance : null,
        concepts: asList(payload.concepts),
        items: asList(payload.items),
        openThreads: asList(payload.open_threads),
        sentAt: String(payload.real_world_date || ''),
    };
}

/**
 * Where a chunk came from: one message, or for an event drawn from a window of messages the window and the event's
 * place in it.
 *
 * @param {{index?: number, metadata?: object}} chunk
 * @returns {{text: string, name: string}} A LINE: "Message: 245" or "Messages: 2527 to 2531, event 3"
 */
export function messageLine(chunk) {
    const payload = chunk.metadata || {};
    const start = payload.source_window_start;
    const end = payload.source_window_end;
    const isWindow = start !== undefined && start !== null && end !== undefined && end !== null && end !== start;
    const eventPart = typeof payload.window_event_order === 'number' ? `, event ${payload.window_event_order + 1}` : '';
    if (isWindow) return { text: 'Messages', name: `${start} to ${end}${eventPart}` };
    return { text: 'Message', name: `${payload.messageId ?? chunk.index ?? '?'}${eventPart}` };
}

/**
 * Which part of a split message a chunk is, or '' for a whole one.
 *
 * @param {{metadata?: object}} chunk
 * @returns {string} "2 of 3"
 */
export function partLabel(chunk) {
    const payload = chunk.metadata || {};
    const total = Number(payload.totalChunks ?? 1);
    if (!(total > 1)) return '';
    return `${Number(payload.chunkIndex ?? 0) + 1} of ${total}`;
}

/**
 * The start of a text on one line, for a chunk with no name.
 *
 * @param {string} text
 * @param {number} [length]
 * @returns {string}
 */
export function textPreview(text, length = PREVIEW_LENGTH) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    return line.length > length ? `${line.slice(0, length)}…` : line;
}

const lengthOf = chunk => chunk.fields.text.length;
const keywordCountOf = chunk => chunk.fields.keywords.length;
const SORTERS = {
    index: (first, second) => first.timelineValue - second.timelineValue,
    'index-reversed': (first, second) => second.timelineValue - first.timelineValue,
    'length-desc': (first, second) => lengthOf(second) - lengthOf(first),
    'length-asc': (first, second) => lengthOf(first) - lengthOf(second),
    keywords: (first, second) => keywordCountOf(second) - keywordCountOf(first),
    customized: (first, second) => (keywordCountOf(second) + (second.fields.name ? 1 : 0)) - (keywordCountOf(first) + (first.fields.name ? 1 : 0)),
};

const FILTER_TESTS = {
    enabled: chunk => chunk.fields.enabled,
    disabled: chunk => !chunk.fields.enabled,
    keywords: chunk => chunk.fields.keywords.length > 0,
};

/**
 * The chunks the list shows, in its order: those whose text, name or a keyword holds the search, that pass the filter.
 * Each chunk carries its saved `fields` and its `timelineValue`, its place in the chat's history.
 *
 * @template {{fields: {text: string, name: string, enabled: boolean, keywords: {text: string}[]}, timelineValue: number}} T
 * @param {T[]} chunks
 * @param {{query?: string, filter?: string, sort?: string}} [view]
 * @returns {T[]}
 */
export function visibleChunks(chunks, { query = '', filter = 'all', sort = 'index' } = {}) {
    const needle = query.trim().toLowerCase();
    const holdsNeedle = chunk => !needle
        || chunk.fields.text.toLowerCase().includes(needle)
        || chunk.fields.name.toLowerCase().includes(needle)
        || chunk.fields.keywords.some(keyword => keyword.text.toLowerCase().includes(needle));
    const passes = FILTER_TESTS[filter] ?? (() => true);
    return chunks.filter(chunk => holdsNeedle(chunk) && passes(chunk)).sort(SORTERS[sort] ?? SORTERS.index);
}

const sameKeywords = (first, second) => first.length === second.length
    && first.every((keyword, index) => keyword.text === second[index].text && keyword.weight === second[index].weight);
const sameLinks = (first, second) => first.length === second.length
    && first.every((link, index) => String(link.targetHash) === String(second[index].targetHash) && link.mode === second[index].mode);

/**
 * What the chunk's form changes against what is saved. `payload` holds the backend fields that differ, as Save writes
 * them; `text` is the new text when it differs past spaces at its ends, which Save embeds again; the summaries added
 * and removed are compared by their words. A field the form leaves out (`undefined`, such as an EventBase chunk's
 * switch) is unchanged. Empty text is no change, and says so in `textProblem`.
 *
 * @param {ReturnType<typeof savedChunkFields>} saved
 * @param {{name?: string, text?: string, enabled?: boolean, context?: string, xmlTag?: string, positionText?: string,
 *   depthText?: string, keywords?: {text: string, weightText: string}[], chunkLinks?: {targetHash: string|number, mode: string}[],
 *   summaries?: string[]}} form
 * @returns {{payload: object, text: string|null, textProblem: string, summaries: string[], addedSummaries: string[],
 *   removedSummaries: string[], hasChanges: boolean}}
 */
export function formChanges(saved, form) {
    const payload = {};
    const isGiven = value => value !== undefined;
    if (isGiven(form.name) && form.name.trim() !== saved.name) payload.name = form.name.trim() || null;
    if (isGiven(form.enabled) && form.enabled !== saved.enabled) payload.enabled = form.enabled;
    if (isGiven(form.context) && form.context !== saved.context) payload.context = form.context;
    if (isGiven(form.xmlTag) && sanitizeXmlTag(form.xmlTag) !== saved.xmlTag) payload.xmlTag = sanitizeXmlTag(form.xmlTag);
    if (isGiven(form.positionText)) {
        const injection = parseInjection(form.positionText, form.depthText ?? '');
        if (injection.position !== saved.position || injection.depth !== saved.depth) Object.assign(payload, injection);
    }
    if (isGiven(form.keywords)) {
        const keywords = form.keywords.map(keyword => ({ text: keyword.text, weight: parseKeywordWeight(keyword.weightText) }));
        if (!sameKeywords(keywords, saved.keywords)) payload.keywords = keywords;
    }
    if (isGiven(form.chunkLinks) && !sameLinks(form.chunkLinks, saved.chunkLinks)) payload.chunkLinks = form.chunkLinks;

    const typedText = isGiven(form.text) ? form.text.trim() : saved.text.trim();
    const textProblem = typedText ? '' : 'A chunk needs text.';
    const text = typedText && typedText !== saved.text.trim() ? typedText : null;

    const summaries = isGiven(form.summaries) ? form.summaries : saved.summaries;
    const addedSummaries = summaries.filter(summary => !saved.summaries.includes(summary));
    const removedSummaries = saved.summaries.filter(summary => !summaries.includes(summary));

    return {
        payload,
        text,
        textProblem,
        summaries,
        addedSummaries,
        removedSummaries,
        hasChanges: Object.keys(payload).length > 0 || text !== null || addedSummaries.length > 0 || removedSummaries.length > 0,
    };
}

/**
 * The chunks a link can point at: every other loaded chunk, by its message and name.
 *
 * @param {{hash: string|number, fields: {name: string, text: string}, index?: number, metadata?: object}[]} chunks
 * @param {string|number} ownHash
 * @returns {{value: string, label: string}[]}
 */
export function linkTargetOptions(chunks, ownHash) {
    return chunks
        .filter(chunk => String(chunk.hash) !== String(ownHash))
        .map(chunk => ({ value: String(chunk.hash), label: chunkLabel(chunk) }));
}

/**
 * A chunk named for a reader: its message, then its name or the start of its text.
 *
 * @param {{fields: {name: string, text: string}, index?: number, metadata?: object}} chunk
 * @returns {string}
 */
export function chunkLabel(chunk) {
    const message = messageLine(chunk);
    return `${message.text} ${message.name}: ${chunk.fields.name || textPreview(chunk.fields.text, 40)}`;
}

/**
 * A link's target for its row: the loaded chunk it points at, or its ID when that chunk is not loaded.
 *
 * @param {{hash: string|number}[]} chunks
 * @param {string|number} targetHash
 * @returns {{label: string, isLoaded: boolean}}
 */
export function linkTargetLabel(chunks, targetHash) {
    const target = chunks.find(chunk => String(chunk.hash) === String(targetHash));
    return target ? { label: chunkLabel(target), isLoaded: true } : { label: `ID ${targetHash}`, isLoaded: false };
}

/**
 * The collection's own record in Qdrant, as LINEs: the keyword tokenizer its points were made with, and when it was
 * migrated and last updated. Nothing for a collection without one.
 *
 * @param {object|null} record
 * @returns {{text: string, name: string}[]}
 */
export function collectionRecordLines(record) {
    if (!record || typeof record !== 'object') return [];
    const when = (value) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    };
    return [
        record.cjk_tokenizer_mode ? { text: 'Keyword tokenizer', name: String(record.cjk_tokenizer_mode) } : null,
        record.migrated_from ? { text: 'Migrated from', name: String(record.migrated_from) } : null,
        record.migrated_at ? { text: 'Migrated', name: when(record.migrated_at) } : null,
        record.updated_at ? { text: 'Updated', name: when(record.updated_at) } : null,
    ].filter(Boolean);
}
