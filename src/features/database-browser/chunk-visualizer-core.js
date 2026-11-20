/**
 * ============================================================================
 * CHUNK VISUALIZER, CORE
 * ============================================================================
 * The Chunk Visualizer's rules as plain values, for chunk-visualizer.js to wire
 * and chunk-visualizer-markup.js to draw: what an event holds, which events the
 * list shows and in what order, how a row reads, and what the form changes
 * against what is saved. A lorebook's LoreBase parts, which it only reads, are
 * named and ordered by their entry and part. Pure: no host, no page.
 * ============================================================================
 */

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
    { value: 'customized', label: 'Named first' },
]);

/** The filters the list offers. */
export const CHUNK_FILTERS = Object.freeze([
    { value: 'all', label: 'All chunks' },
    { value: 'keywords', label: 'With keywords' },
]);

/** The orders the list offers for a lorebook's LoreBase parts, which have no message, name or keywords. */
export const LOREBASE_PART_SORTS = Object.freeze([
    { value: 'index', label: 'Entry order' },
    { value: 'length-desc', label: 'Longest first' },
    { value: 'length-asc', label: 'Shortest first' },
]);

// Parts per entry the LoreBase order leaves room for: far more than the splitter cuts one entry into.
const PART_PLACES_PER_ENTRY = 10_000;

const asList = value => (Array.isArray(value) ? value.map(String) : []);

/**
 * Keywords as `{text}`, from a bare word, as EventBase stores them, or an object with a `text` field.
 *
 * @param {unknown} keywords
 * @returns {{text: string}[]}
 */
export function normalizeKeywords(keywords) {
    if (!Array.isArray(keywords)) return [];
    return keywords.map((keyword) => {
        if (typeof keyword === 'string') return keyword ? { text: keyword } : null;
        if (keyword && typeof keyword === 'object' && keyword.text) return { text: String(keyword.text) };
        return null;
    }).filter(Boolean);
}

/**
 * What a chunk holds, as its form and its row show it, from the backend payload.
 *
 * @param {{text?: string, keywords?: unknown, metadata?: object}} chunk
 * @returns {{text: string, name: string, keywords: {text: string}[]}}
 */
export function savedChunkFields(chunk) {
    const payload = chunk.metadata || {};
    const keywords = Array.isArray(payload.keywords) && payload.keywords.length > 0 ? payload.keywords : chunk.keywords;
    return {
        text: String(chunk.text ?? ''),
        name: String(payload.name ?? '').trim(),
        keywords: normalizeKeywords(keywords),
    };
}

/** A moment as "2026-11-05 09:30 UTC"; a value that is not one, as written. */
function minuteText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
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
        sentAt: payload.real_world_date ? minuteText(payload.real_world_date) : '',
    };
}

/**
 * Whether a chunk is a part of a LoreBase entry: LoreBase stores each with its entry's number.
 *
 * @param {{metadata?: object}} chunk
 * @returns {boolean}
 */
export function isLoreBasePart(chunk) {
    const uid = chunk.metadata?.entryUid;
    return uid !== undefined && uid !== null && uid !== '';
}

/**
 * A LoreBase part's place in its lorebook: by its entry's number, then its part's.
 *
 * @param {{metadata?: object}} chunk
 * @returns {number}
 */
export function loreBasePartPlace(chunk) {
    const payload = chunk.metadata || {};
    return (Number(payload.entryUid) || 0) * PART_PLACES_PER_ENTRY + (Number(payload.partNumber) || 0);
}

/**
 * Where a chunk came from: a LoreBase part's entry and part; one message; or for an event drawn from a window of
 * messages the window and the event's place in it.
 *
 * @param {{index?: number, metadata?: object}} chunk
 * @returns {{text: string, name: string}} A LINE: "Entry: 12, part 2", "Message: 245" or "Messages: 2527 to 2531, event 3"
 */
export function originLine(chunk) {
    const payload = chunk.metadata || {};
    if (isLoreBasePart(chunk)) return { text: 'Entry', name: `${payload.entryUid}, part ${payload.partNumber ?? '?'}` };
    const start = payload.source_window_start;
    const end = payload.source_window_end;
    const isWindow = start !== undefined && start !== null && end !== undefined && end !== null && end !== start;
    const eventPart = typeof payload.window_event_order === 'number' ? `, event ${payload.window_event_order + 1}` : '';
    if (isWindow) return { text: 'Messages', name: `${start} to ${end}${eventPart}` };
    return { text: 'Message', name: `${payload.messageId ?? chunk.index ?? '?'}${eventPart}` };
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

/**
 * A chunk's title in the list: its name; for a LoreBase part, its entry's title, the first line LoreBase writes it
 * with; else the start of its text.
 *
 * @param {{fields: {name: string, text: string}, metadata?: object}} chunk
 * @returns {string}
 */
export function chunkTitle(chunk) {
    const { name, text } = chunk.fields;
    if (name) return name;
    const entryTitle = isLoreBasePart(chunk) ? text.split('\n', 1)[0].trim() : '';
    return entryTitle || textPreview(text) || 'No text';
}

const lengthOf = chunk => chunk.fields.text.length;
const keywordCountOf = chunk => chunk.fields.keywords.length;
const isNamed = chunk => Boolean(chunk.fields.name);
const byPlace = (first, second) => first.placeValue - second.placeValue;
const SORTERS = {
    index: byPlace,
    'index-reversed': (first, second) => second.placeValue - first.placeValue,
    'length-desc': (first, second) => lengthOf(second) - lengthOf(first),
    'length-asc': (first, second) => lengthOf(first) - lengthOf(second),
    keywords: (first, second) => keywordCountOf(second) - keywordCountOf(first),
    // A chunk given a name first, each group in message order.
    customized: (first, second) => (Number(isNamed(second)) - Number(isNamed(first))) || byPlace(first, second),
};

const FILTER_TESTS = {
    keywords: chunk => chunk.fields.keywords.length > 0,
};

/**
 * The chunks the list shows, in its order: those whose text, name or a keyword holds the search, that pass the filter.
 * Each chunk carries its saved `fields` and its `placeValue`: its place in the chat's history, or a LoreBase part's in
 * its lorebook.
 *
 * @template {{fields: {text: string, name: string, keywords: {text: string}[]}, placeValue: number}} T
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

/**
 * The chunk to open again once the list is read again: the one with the open chunk's ID; for a LoreBase part, which
 * takes a new ID when its entry's edit changes its text, the same entry's part of the same number, else its first.
 *
 * @template {{hash?: unknown, placeValue: number, metadata?: object}} T
 * @param {T[]} chunks - The list as read again
 * @param {T|null} previous - The chunk open before
 * @returns {T|null}
 */
export function reopenedChunk(chunks, previous) {
    if (!previous) return null;
    const sameId = chunks.find(chunk => String(chunk.hash) === String(previous.hash));
    if (sameId || !isLoreBasePart(previous)) return sameId ?? null;
    const sameEntry = chunks
        .filter(chunk => isLoreBasePart(chunk) && String(chunk.metadata.entryUid) === String(previous.metadata.entryUid))
        .sort(byPlace);
    return sameEntry.find(chunk => Number(chunk.metadata.partNumber) === Number(previous.metadata.partNumber)) ?? sameEntry[0] ?? null;
}

/**
 * What the form changes against what is saved. `payload` holds the backend fields that differ, as Save writes them;
 * `text` is the new text when it differs past spaces at its ends, which Save embeds again. Empty text is no change, and
 * says so in `textProblem`.
 *
 * @param {ReturnType<typeof savedChunkFields>} saved
 * @param {{name?: string, text?: string}} form
 * @returns {{payload: object, text: string|null, textProblem: string, hasChanges: boolean}}
 */
export function formChanges(saved, form) {
    const payload = {};
    if (form.name !== undefined && form.name.trim() !== saved.name) payload.name = form.name.trim() || null;
    const typedText = form.text !== undefined ? form.text.trim() : saved.text.trim();
    const textProblem = typedText ? '' : 'A chunk needs text.';
    const text = typedText && typedText !== saved.text.trim() ? typedText : null;
    return { payload, text, textProblem, hasChanges: Object.keys(payload).length > 0 || text !== null };
}

/**
 * A chunk named for a reader: where it came from, then its name or the start of its text.
 *
 * @param {{fields: {name: string, text: string}, index?: number, metadata?: object}} chunk
 * @returns {string}
 */
export function chunkLabel(chunk) {
    const origin = originLine(chunk);
    return `${origin.text} ${origin.name}: ${chunk.fields.name || textPreview(chunk.fields.text, 40)}`;
}

/**
 * The collection's own record in Qdrant, as LINEs: the CJK tokenizer its points were made with, and when it was
 * migrated and last updated. Nothing for a collection without one.
 *
 * @param {object|null} record
 * @param {(mode: string) => string} tokenizerLabel - The name the CJK tokenizer setting shows for a mode
 * @returns {{text: string, name: string}[]}
 */
export function collectionRecordLines(record, tokenizerLabel) {
    if (!record || typeof record !== 'object') return [];
    return [
        record.cjk_tokenizer_mode ? { text: 'CJK tokenizer', name: tokenizerLabel(String(record.cjk_tokenizer_mode)) } : null,
        record.migrated_from ? { text: 'Migrated from', name: String(record.migrated_from) } : null,
        record.migrated_at ? { text: 'Migrated', name: minuteText(record.migrated_at) } : null,
        record.updated_at ? { text: 'Updated', name: minuteText(record.updated_at) } : null,
    ].filter(Boolean);
}

/**
 * Whether Similharity refuses new vectors in the collection: it does when the collection was made with another CJK
 * tokenizer than VectFox is set to, and checks nothing for a collection without the record or a setting without one.
 *
 * @param {object|null} record - The collection's own Qdrant record
 * @param {string|undefined} currentMode - VectFox's CJK tokenizer setting
 * @returns {{madeWith: string, setTo: string}|null} The two modes, or null when nothing is locked
 */
export function tokenizerLockOf(record, currentMode) {
    const madeWith = record?.cjk_tokenizer_mode;
    if (!madeWith || !currentMode || madeWith === currentMode) return null;
    return { madeWith: String(madeWith), setTo: String(currentMode) };
}

/**
 * Why the form cannot be saved, or null when it can: a chunk needs text, and a locked collection takes no new vector,
 * so no changed text.
 *
 * @param {{textProblem: string|null, text: string|null}} changes - From formChanges
 * @param {object|null} tokenizerLock - From tokenizerLockOf
 * @returns {string|null}
 */
export function saveProblem(changes, tokenizerLock) {
    if (changes.textProblem) return changes.textProblem;
    if (tokenizerLock && changes.text !== null) return 'A changed text can\'t be saved here: see above.';
    return null;
}
