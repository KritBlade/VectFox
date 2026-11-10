/**
 * ============================================================================
 * CHUNK VISUALIZER, MARKUP
 * ============================================================================
 * The Chunk Visualizer on GUI-DNA (mvu-helper/devdoc/gui-dna.md): a top-bar shell
 * holding one workbench page, its list controls in a compact card above a split.
 * The list pane holds the chunks, each with a tick box, and the bar that acts on
 * the ticked ones; the chunk pane holds the open chunk's form, which one Save
 * writes. chunk-visualizer.js finds each control by its id in VISUALIZER_IDS and
 * each action by `data-chunk-action`; a row and its tick box carry
 * `data-chunk-key`, and a keyword, link or summary row its index. Every value is
 * escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
    button,
    controlRow,
    emptyState,
    field,
    fieldLabel,
    grid,
    groupTitle,
    hint,
    iconButton,
    input,
    listRow,
    notice,
    resultList,
    select,
    selectOption,
    stack,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import { CHUNK_FILTERS, CHUNK_SORTS, LINK_MODES } from './chunk-visualizer-core.js';
import { INJECTION_POSITIONS, IN_CHAT_POSITION } from './collection-settings-core.js';
import { collectionTypeIcon } from './database-browser-markup.js';
import { counted } from './counted.js';

/** The ids chunk-visualizer.js finds the visualizer's controls by. */
export const VISUALIZER_IDS = Object.freeze({
    root: 'vectfox_chunk_visualizer',
    split: 'vectfox_chunk_split',
    search: 'vectfox_chunk_search',
    sort: 'vectfox_chunk_sort',
    filter: 'vectfox_chunk_filter',
    selectAll: 'vectfox_chunk_select_all',
    list: 'vectfox_chunk_list',
    listFooter: 'vectfox_chunk_list_footer',
    fetchLimit: 'vectfox_chunk_fetch_limit',
    record: 'vectfox_chunk_record',
    pane: 'vectfox_chunk_pane',
    name: 'vectfox_chunk_name',
    text: 'vectfox_chunk_text',
    enabled: 'vectfox_chunk_enabled',
    context: 'vectfox_chunk_context',
    xmlTag: 'vectfox_chunk_xml_tag',
    position: 'vectfox_chunk_position',
    depthField: 'vectfox_chunk_depth_field',
    depth: 'vectfox_chunk_depth',
    keywordNew: 'vectfox_chunk_keyword_new',
    linkTarget: 'vectfox_chunk_link_target',
    linkMode: 'vectfox_chunk_link_mode',
    summaryNew: 'vectfox_chunk_summary_new',
});

const ids = VISUALIZER_IDS;
const action = (name, extra = {}) => ({ 'chunk-action': name, ...extra });
const dynamicHint = (text, hook) => `<p class="vfx-hint"${hook ? ` data-${hook}` : ''}>${escape(text)}</p>`;
const formatCount = count => Number(count).toLocaleString('en-US');
// A pill holding a LINE, "Message: 245": the DNA's pill shows a fixed word or a value, never both.
const linePill = ({ text, name }, options = {}) => statusPill({ name: `${text}: ${name}`, ...options });

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────────────

function controlsCard() {
    return `<section class="vfx-card">
        <div class="vfx-card-body">
            ${controlRow([
                input({ id: ids.search, placeholder: 'Search text, names and keywords', title: 'Search the chunks' }),
                select({ id: ids.sort, title: 'Order', options: CHUNK_SORTS.map(({ value, label }) => selectOption({ value, text: label })) }),
                select({ id: ids.filter, title: 'Show', options: CHUNK_FILTERS.map(({ value, label }) => selectOption({ value, text: label })) }),
            ])}
        </div>
    </section>`;
}

function bulkBar(isEventBase) {
    const bulkButton = (name, text, icon, kind = 'secondary') => button({ text, icon, kind, isDisabled: true, data: action(name) });
    return controlRow([
        `<label class="vfx-check-item"><input type="checkbox" id="${ids.selectAll}" class="vfx-check"><span>Select all matching</span></label>`,
        statusPill({ name: '0 selected', data: { 'chunk-bulk-count': '' } }),
        isEventBase ? '' : bulkButton('bulk-enable', 'Enable', 'fa-toggle-on'),
        isEventBase ? '' : bulkButton('bulk-disable', 'Disable', 'fa-toggle-off'),
        bulkButton('bulk-delete', 'Delete', 'fa-trash-can', 'danger'),
    ]);
}

function loadField(fetchLimit) {
    return field([
        fieldLabel({ text: 'Load at most', forId: ids.fetchLimit }),
        controlRow([
            input({ id: ids.fetchLimit, type: 'number', value: fetchLimit, min: 0, max: 99999, step: 100 }),
            button({ text: 'Reload', icon: 'fa-rotate', data: action('reload') }),
        ]),
        hint({ text: '0 loads every chunk. Reload reads them from the server again.' }),
    ]);
}

function listPane(isEventBase, fetchLimit) {
    return `<section class="vfx-card is-pane">
        ${cardHeader({ icon: 'fa-layer-group', title: 'Chunks', description: 'Tick chunks to act on several at once.', isCollapsible: false })}
        <div class="vfx-card-body vfx-stack">
            ${bulkBar(isEventBase)}
            <div id="${ids.list}" class="vfx-list">${emptyState({ icon: 'fa-spinner', text: 'Loading chunks…' })}</div>
            <div id="${ids.listFooter}"></div>
            ${loadField(fetchLimit)}
            <div id="${ids.record}" class="vfx-control-row" hidden></div>
        </div>
    </section>`;
}

/**
 * The chunk pane with no chunk open.
 *
 * @returns {string}
 */
export function noChunkOpenMarkup() {
    return cardHeader({ icon: 'fa-file-lines', title: 'Chunk', isCollapsible: false })
        + `<div class="vfx-card-body">${emptyState({ icon: 'fa-hand-pointer', text: 'Pick a chunk in the list to read or edit it.' })}</div>`;
}

const SPLIT_DIVIDER = '<div class="vfx-split-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize the panes"></div>';

/**
 * The whole visualizer: the top bar, the page header, the list controls, then the split of the list and the chunk.
 *
 * @param {{collectionName: string, collectionType: string, isEventBase: boolean, fetchLimit: number}} view
 * @returns {string}
 */
export function chunkVisualizerMarkup({ collectionName, collectionType, isEventBase, fetchLimit }) {
    const status = statusPill({ name: '', data: { 'chunk-count': '' } });
    return `<div id="${ids.root}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Chunk Visualizer')}</div></nav>`
        + '<main class="vfx-main"><div class="vfx-page is-workbench">'
        + pageHeader({ icon: collectionTypeIcon(collectionType), eyebrow: 'Database Browser / Chunks', title: collectionName, subtitle: 'Every chunk this collection holds. Open one to read or edit it.', status })
        + controlsCard()
        + `<div id="${ids.split}" class="vfx-split">`
        + listPane(isEventBase, fetchLimit)
        + SPLIT_DIVIDER
        + `<section id="${ids.pane}" class="vfx-card is-pane">${noChunkOpenMarkup()}</section>`
        + '</div></div></main></div>';
}

// ── List ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One chunk in the list: its tick box, then its row (name or the start of its text, where it came from, its size, and
 * its keyword and Disabled pills), marked while it is the open one.
 *
 * @param {{key: string, title: string, message: {text: string, name: string}, part: string, characterCount: number,
 *   keywordCount: number, isEnabled: boolean, isOpen: boolean, isTicked: boolean}} view
 * @returns {string}
 */
export function chunkRowMarkup(view) {
    const row = listRow({
        icon: 'fa-file-lines',
        name: view.title,
        sub: [view.message, view.part ? { text: 'Part', name: view.part } : null],
        pills: [
            statusPill({ name: `${formatCount(view.characterCount)} ${view.characterCount === 1 ? 'character' : 'characters'}` }),
            view.keywordCount ? statusPill({ name: counted(view.keywordCount, 'keyword'), status: 'accent', icon: 'fa-tag' }) : '',
            view.isEnabled ? '' : statusPill({ text: 'Disabled', status: 'warning', icon: 'fa-power-off' }),
        ].filter(Boolean),
        actions: [iconButton({ icon: 'fa-pen-to-square', title: 'Open', data: action('open', { 'chunk-key': view.key }) })],
        data: { 'chunk-key': view.key },
    });
    return `<div class="vfx-pick-row${view.isOpen ? ' is-open' : ''}" data-chunk-entry="${escape(view.key)}"${view.isOpen ? ' aria-current="true"' : ''}>`
        + '<label class="vfx-pick-check" title="Select">'
        + `<input type="checkbox" class="vfx-check" aria-label="Select ${escape(view.title)}"${view.isTicked ? ' checked' : ''} data-chunk-tick="${escape(view.key)}">`
        + '</label>'
        + `<div class="vfx-pick-body">${row}</div>`
        + '</div>';
}

/**
 * Under the list: how many rows it shows of those that match, and the button that shows more.
 *
 * @param {{shownCount: number, matchCount: number, hasMore: boolean}} view
 * @returns {string}
 */
export function listFooterMarkup({ shownCount, matchCount, hasMore }) {
    if (matchCount === 0) return '';
    return controlRow([
        dynamicHint(`Showing ${formatCount(shownCount)} of ${counted(matchCount, 'chunk')}.`),
        hasMore ? button({ text: 'Show more', icon: 'fa-angles-down', data: action('show-more') }) : '',
    ]);
}

/** The list while the chunks load. */
export function chunksLoadingMarkup() {
    return emptyState({ icon: 'fa-spinner', text: 'Loading chunks…' });
}

/**
 * The list when the chunks could not be read, with the reason.
 *
 * @param {string} reason
 * @returns {string}
 */
export function chunksFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'The chunks could not be loaded', name: reason });
}

/** The list of a collection that holds no chunk. */
export function noChunksMarkup() {
    return emptyState({ icon: 'fa-box-open', text: 'This collection holds no chunks.' });
}

/** The list when no chunk passes the search and filter. */
export function noMatchingChunksMarkup() {
    return emptyState({ icon: 'fa-magnifying-glass', text: 'No chunk matches the search and filter.' });
}

/**
 * The collection's own record in Qdrant, under the list: the LINEs collectionRecordLines gives.
 *
 * @param {{text: string, name: string}[]} lines
 * @returns {string}
 */
export function collectionRecordMarkup(lines) {
    return lines.map(line => linePill(line, { icon: line.text === 'Keyword tokenizer' ? 'fa-language' : 'fa-clock' })).join('');
}

// ── Chunk form ────────────────────────────────────────────────────────────────────────────────────────

function positionOptions(position) {
    const selected = position === null ? '' : String(position);
    return INJECTION_POSITIONS.map(({ value, label }) => selectOption({
        value,
        text: value === '' ? 'Collection default' : label,
        isSelected: value === selected,
    }));
}

function promptFields(fields) {
    const isInChat = fields.position === IN_CHAT_POSITION;
    return [
        groupTitle({ icon: 'fa-quote-left', text: 'Prompt' }),
        grid([
            field([
                fieldLabel({ text: 'Context', forId: ids.context }),
                textarea({ id: ids.context, value: fields.context, rows: 2 }),
                hint({ text: 'Shown before this chunk. {{user}} and {{char}} work here.' }),
            ], { isSpan: true }),
            field([
                fieldLabel({ text: 'XML tag', forId: ids.xmlTag }),
                input({ id: ids.xmlTag, value: fields.xmlTag, placeholder: 'memories' }),
                hint({ text: 'Wraps this chunk alone. Letters, digits, _ and - only.' }),
            ]),
            field([
                fieldLabel({ text: 'Position', forId: ids.position }),
                select({ id: ids.position, options: positionOptions(fields.position) }),
                hint({ text: 'Where this chunk goes in the prompt.' }),
            ]),
            `<div id="${ids.depthField}"${isInChat ? '' : ' hidden'}>${field([
                fieldLabel({ text: 'Depth', forId: ids.depth }),
                input({ id: ids.depth, type: 'number', value: fields.depth ?? 2, min: 0, max: 50, step: 1 }),
                hint({ text: 'How many messages from the end of the chat.' }),
            ])}</div>`,
        ]),
    ];
}

/**
 * A chunk's keywords: each one's word, its boost in a box and its remove button.
 *
 * @param {{text: string, weight: number}[]} keywords
 * @returns {string}
 */
export function keywordRowsMarkup(keywords) {
    if (!keywords.length) return emptyState({ icon: 'fa-tag', text: 'No keywords yet.' });
    return keywords.map((keyword, index) => listRow({
        icon: 'fa-tag',
        name: keyword.text,
        actions: [
            `<input type="number" class="vfx-input vfx-boost-box" value="${escape(String(keyword.weight))}" min="0.1" step="0.1"`
                + ` title="Boost for ${escape(keyword.text)}" data-keyword-weight="${index}">`,
            iconButton({ icon: 'fa-xmark', title: `Remove ${keyword.text}`, data: action('remove-keyword', { 'keyword-index': index }) }),
        ],
    })).join('');
}

function keywordFields(keywords) {
    return [
        groupTitle({ icon: 'fa-tags', text: 'Keywords' }),
        hint({ text: 'A query holding one boosts this chunk by its number: 1.5 adds half.' }),
        `<div class="vfx-list" data-chunk-keywords>${keywordRowsMarkup(keywords)}</div>`,
        controlRow([
            input({ id: ids.keywordNew, placeholder: 'New keyword', title: 'New keyword' }),
            button({ text: 'Add', icon: 'fa-plus', data: action('add-keyword') }),
        ]),
    ];
}

/**
 * A chunk's links: each target, how it comes along, and its remove button.
 *
 * @param {{label: string, isLoaded: boolean, mode: string}[]} links
 * @returns {string}
 */
export function linkRowsMarkup(links) {
    if (!links.length) return emptyState({ icon: 'fa-link', text: 'No links yet.' });
    return links.map((link, index) => listRow({
        icon: 'fa-link',
        name: link.label,
        sub: link.isLoaded ? null : { text: 'Not among the loaded chunks' },
        pills: [statusPill({ text: LINK_MODES.find(mode => mode.value === link.mode)?.label ?? 'Force', status: link.mode === 'soft' ? 'neutral' : 'accent' })],
        actions: [iconButton({ icon: 'fa-xmark', title: 'Remove this link', data: action('remove-link', { 'link-index': index }) })],
    })).join('');
}

function linkFields(links, linkTargets) {
    const addRow = linkTargets.length
        ? controlRow([
            select({ id: ids.linkTarget, title: 'Chunk to link', options: linkTargets.map(({ value, label }) => selectOption({ value, name: label })) }),
            select({ id: ids.linkMode, title: 'How it comes along', options: LINK_MODES.map(({ value, label, description }) => selectOption({ value, text: `${label}: ${description}` })) }),
            button({ text: 'Add', icon: 'fa-plus', data: action('add-link') }),
        ])
        : hint({ text: 'No other chunk is loaded to link to.' });
    return [
        groupTitle({ icon: 'fa-link', text: 'Linked chunks' }),
        hint({ text: 'When this chunk is found, Force brings the linked one along; Soft scores it higher.' }),
        `<div class="vfx-list" data-chunk-links>${linkRowsMarkup(links)}</div>`,
        addRow,
    ];
}

/**
 * A chunk's summaries: each one's words and its remove button.
 *
 * @param {string[]} summaries
 * @returns {string}
 */
export function summaryRowsMarkup(summaries) {
    if (!summaries.length) return emptyState({ icon: 'fa-align-left', text: 'No summaries yet.' });
    return summaries.map((summary, index) => listRow({
        icon: 'fa-align-left',
        name: summary,
        actions: [iconButton({ icon: 'fa-xmark', title: 'Remove this summary', data: action('remove-summary', { 'summary-index': index }) })],
    })).join('');
}

function summaryFields(summaries) {
    return [
        groupTitle({ icon: 'fa-align-left', text: 'Summaries' }),
        hint({ text: 'Extra texts a search can find this chunk by, each embedded on its own.' }),
        `<div class="vfx-list" data-chunk-summaries>${summaryRowsMarkup(summaries)}</div>`,
        field([
            textarea({ id: ids.summaryNew, rows: 2, title: 'New summary' }),
            controlRow([button({ text: 'Add', icon: 'fa-plus', data: action('add-summary') })]),
        ]),
    ];
}

function eventFieldsMarkup(event) {
    return [
        groupTitle({ icon: 'fa-bolt', text: 'Event' }),
        resultList({
            lines: [
                event.type ? { text: 'Type', name: event.type, icon: 'fa-shapes' } : null,
                event.importance !== null ? { text: 'Importance', name: `${event.importance} of 10`, icon: 'fa-star' } : null,
                event.concepts.length ? { text: 'Concepts', name: event.concepts.join(', '), icon: 'fa-lightbulb' } : null,
                event.items.length ? { text: 'Items', name: event.items.join(', '), icon: 'fa-box' } : null,
                ...event.openThreads.map(thread => ({ text: 'Open thread', name: thread, icon: 'fa-circle-dot' })),
            ].filter(Boolean),
        }),
        hint({ text: 'Written by EventBase when it read the chat.' }),
    ];
}

/**
 * The open chunk's form: where it came from, its name and text, for an EventBase chunk its event, else its switch;
 * where it goes in the prompt; for any but an EventBase chunk its keywords and links; its summaries; then Delete and
 * Save. The form shows what is saved; chunk-visualizer.js keeps the edits on it until Save.
 *
 * @param {{number: number, hash: string|number, isEventBase: boolean, message: {text: string, name: string},
 *   part: string, fields: ReturnType<import('./chunk-visualizer-core.js').savedChunkFields>,
 *   event: ReturnType<import('./chunk-visualizer-core.js').eventFields>,
 *   links: {label: string, isLoaded: boolean, mode: string}[], linkTargets: {value: string, label: string}[]}} view
 * @returns {string}
 */
export function chunkFormMarkup(view) {
    const { fields, event } = view;
    const origin = controlRow([
        linePill(view.message),
        view.part ? linePill({ text: 'Part', name: view.part }) : '',
        event.sentAt ? linePill({ text: 'Sent', name: event.sentAt }, { icon: 'fa-clock' }) : '',
        linePill({ text: 'ID', name: String(view.hash) }),
    ].filter(Boolean));
    const parts = [
        origin,
        field([
            fieldLabel({ text: 'Name', forId: ids.name }),
            input({ id: ids.name, value: fields.name, placeholder: 'Shown in the list in place of the text' }),
        ]),
        field([
            fieldLabel({ text: 'Text', forId: ids.text }),
            textarea({ id: ids.text, value: fields.text, rows: 8 }),
            dynamicHint('', 'chunk-text-count'),
            hint({ text: 'Saving a changed text embeds it again.' }),
        ]),
        ...(view.isEventBase ? eventFieldsMarkup(event) : [switchRow({ id: ids.enabled, title: 'Enabled', description: 'Off: retrieval skips this chunk.' })]),
        ...promptFields(fields),
        ...(view.isEventBase ? [] : keywordFields(fields.keywords)),
        ...(view.isEventBase ? [] : linkFields(view.links, view.linkTargets)),
        ...summaryFields(fields.summaries),
        controlRow([
            dynamicHint('No changes.', 'chunk-save-state'),
            button({ text: 'Delete', icon: 'fa-trash-can', kind: 'danger', data: action('delete') }),
            button({ text: 'Save', icon: 'fa-floppy-disk', kind: 'primary', isDisabled: true, data: action('save') }),
        ]),
    ];
    return cardHeader({ icon: 'fa-file-lines', title: fields.name || `Chunk ${view.number}`, isCollapsible: false })
        + `<div class="vfx-card-body">${stack(parts)}</div>`;
}
