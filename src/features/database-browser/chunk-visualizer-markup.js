/**
 * ============================================================================
 * CHUNK VISUALIZER, MARKUP
 * ============================================================================
 * The Chunk Visualizer on GUI-DNA (mvu-helper/devdoc/gui-dna.md): a top-bar shell
 * holding one workbench page, its list controls in a compact card above a split.
 * The list pane holds the chunks, each with a tick box, and the bar that deletes
 * the ticked ones; the chunk pane holds the open chunk's form, which one Save
 * writes. chunk-visualizer.js finds each control by its id in VISUALIZER_IDS and
 * each action by `data-chunk-action`; a row and its tick box carry
 * `data-chunk-key`. Every value is escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
    button,
    controlRow,
    emptyState,
    field,
    fieldLabel,
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
import { cardHeader, navBrand, pageHeader } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import { CHUNK_FILTERS, CHUNK_SORTS } from './chunk-visualizer-core.js';
import { collectionTypeIcon } from './database-browser-markup.js';
import { counted } from '../../shared/counted.js';

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

function bulkBar() {
    return controlRow([
        `<label class="vfx-check-item"><input type="checkbox" id="${ids.selectAll}" class="vfx-check"><span>Select all matching</span></label>`,
        statusPill({ name: '0 selected', data: { 'chunk-bulk-count': '' } }),
        button({ text: 'Delete', icon: 'fa-trash-can', kind: 'danger', isDisabled: true, data: action('bulk-delete') }),
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

function listPane(fetchLimit) {
    return `<section class="vfx-card is-pane">
        ${cardHeader({ icon: 'fa-layer-group', title: 'Chunks', description: 'Tick chunks to delete several at once.', isCollapsible: false })}
        <div class="vfx-card-body vfx-stack">
            ${bulkBar()}
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
 * @param {{collectionName: string, collectionType: string, fetchLimit: number}} view
 * @returns {string}
 */
export function chunkVisualizerMarkup({ collectionName, collectionType, fetchLimit }) {
    const status = statusPill({ name: '', data: { 'chunk-count': '' } });
    return `<div id="${ids.root}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Chunk Visualizer')}</div></nav>`
        + '<main class="vfx-main"><div class="vfx-page is-workbench">'
        + pageHeader({ icon: collectionTypeIcon(collectionType), eyebrow: 'Database Browser / Chunks', title: collectionName, subtitle: 'Every chunk this collection holds. Open one to read or edit it.', status })
        + controlsCard()
        + `<div id="${ids.split}" class="vfx-split">`
        + listPane(fetchLimit)
        + SPLIT_DIVIDER
        + `<section id="${ids.pane}" class="vfx-card is-pane">${noChunkOpenMarkup()}</section>`
        + '</div></div></main></div>';
}

// ── List ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One chunk in the list: its tick box, then its row (name or the start of its text, where it came from, its size, and
 * its keyword pill), marked while it is the open one.
 *
 * @param {{key: string, title: string, message: {text: string, name: string}, characterCount: number,
 *   keywordCount: number, isOpen: boolean, isTicked: boolean}} view
 * @returns {string}
 */
export function chunkRowMarkup(view) {
    const row = listRow({
        icon: 'fa-file-lines',
        name: view.title,
        sub: [view.message],
        pills: [
            statusPill({ name: `${formatCount(view.characterCount)} ${view.characterCount === 1 ? 'character' : 'characters'}` }),
            view.keywordCount ? statusPill({ name: counted(view.keywordCount, 'keyword'), status: 'accent', icon: 'fa-tag' }) : '',
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
 * The warning over a chunk of a collection made with another CJK tokenizer than VectFox is set to, which takes no new
 * vector: the two tokenizers by the names the setting shows, and what cannot be saved.
 *
 * @param {{madeWith: string, setTo: string}} labels
 * @returns {string}
 */
export function tokenizerLockMarkup({ madeWith, setTo }) {
    return notice({ status: 'warning', parts: [
        { text: 'This collection was made with the CJK tokenizer' },
        { name: ` ${madeWith}, ` },
        { text: 'and VectFox is set to' },
        { name: ` ${setTo}. ` },
        { text: 'A changed text can\'t be saved here; the name can.' },
    ] });
}

/**
 * The open chunk's form: the place of tokenizerLockMarkup; where it came from, its name and text, and its event; then
 * Delete and Save. The form shows what is saved; chunk-visualizer.js keeps the edits on it until Save.
 *
 * @param {{number: number, hash: string|number, message: {text: string, name: string},
 *   fields: ReturnType<import('./chunk-visualizer-core.js').savedChunkFields>,
 *   event: ReturnType<import('./chunk-visualizer-core.js').eventFields>}} view
 * @returns {string}
 */
export function chunkFormMarkup(view) {
    const { fields, event } = view;
    const origin = controlRow([
        linePill(view.message),
        event.sentAt ? linePill({ text: 'Sent', name: event.sentAt }, { icon: 'fa-clock' }) : '',
        linePill({ text: 'ID', name: String(view.hash) }),
    ].filter(Boolean));
    const parts = [
        // tokenizerLockMarkup's place, filled once the collection's record says it takes no new vector.
        '<div data-chunk-tokenizer-notice hidden></div>',
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
        ...eventFieldsMarkup(event),
        controlRow([
            dynamicHint('No changes.', 'chunk-save-state'),
            button({ text: 'Delete', icon: 'fa-trash-can', kind: 'danger', data: action('delete') }),
            button({ text: 'Save', icon: 'fa-floppy-disk', kind: 'primary', isDisabled: true, data: action('save') }),
        ]),
    ];
    return cardHeader({ icon: 'fa-file-lines', title: fields.name || `Chunk ${view.number}`, isCollapsible: false })
        + `<div class="vfx-card-body">${stack(parts)}</div>`;
}
