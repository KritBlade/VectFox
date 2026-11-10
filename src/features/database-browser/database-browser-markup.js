/**
 * ============================================================================
 * DATABASE BROWSER, MARKUP
 * ============================================================================
 * The Database Browser on GUI-DNA (mvu-helper/devdoc/gui-dna.md): a top-bar shell
 * with three pages, Collections, Search and Size Inspector. A nav item is
 * `vectfox_browser_tab_<name>` and its page `vectfox_browser_page_<name>`, which
 * database-browser.js finds by id, as it finds each control. Rows and buttons
 * carry data-* hooks: `data-browser-action` for a page's buttons,
 * `data-collection-action` with `data-collection-key` for a collection's,
 * `data-collection-select` for its selection box, and `data-size-action` and
 * `data-size-page` for the Size Inspector's (size-inspector.js). A collection's row is drawn from
 * a view (database-browser.js collectionRowView) holding only plain values. Every
 * value is escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
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
    pager,
    select,
    selectOption,
    statusPill,
    button,
} from '../../shared/gui-dna/gui-dna-core.js';
import { buttonWithId, cardHeader, dangerZone, navBrand, navItem, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import { formatBytes } from '../../shared/byte-size.js';

export const BROWSER_ROOT_ID = 'vectfox_database_browser';

/** The browser's pages, in nav order. */
export const BROWSER_PAGES = Object.freeze([
    { name: 'collections', icon: 'fa-folder-open', title: 'Collections', subtitle: 'Your collections: what each holds, where it is stored and when it is used.' },
    { name: 'search', icon: 'fa-magnifying-glass', title: 'Search', subtitle: 'Searches every collection by meaning, the way retrieval does.' },
    { name: 'size', icon: 'fa-weight-hanging', title: 'Size Inspector', subtitle: 'Finds entries large enough to bloat the prompt.' },
]);

/** The page the browser opens on. */
export const FIRST_BROWSER_PAGE = BROWSER_PAGES[0].name;

export const browserTabId = name => `vectfox_browser_tab_${name}`;
export const browserPageId = name => `vectfox_browser_page_${name}`;

/** How many keywords the keyword filter offers, the most common first. */
const KEYWORD_TAG_LIMIT = 30;

/** How many entries one page of the Size page's entry list shows. */
const SIZE_ENTRIES_PER_PAGE = 50;

const HIDDEN = ' style="display:none;"';
const SIMILHARITY_INSTALL_URL = 'https://github.com/KritBlade/VectFox/tree/Similharity-Plugin#step-2-install-plugin-via-git-recommended';

// The icon for each collection type; a type not listed gets a cube.
const TYPE_ICONS = Object.freeze({
    chat: 'fa-message',
    file: 'fa-file-lines',
    doc: 'fa-file-lines',
    paste: 'fa-file-lines',
    select: 'fa-file-lines',
    current: 'fa-file-lines',
    lorebook: 'fa-book-open',
    character: 'fa-user',
    persona: 'fa-user',
    url: 'fa-globe',
    wiki: 'fa-globe',
    youtube: 'fa-globe',
});

const SCOPE_PILL_TEXT = Object.freeze({ character: 'Character', chat: 'Chat' });

// "1 result", "2 results"; `plural` for a word that does not take an s.
const counted = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
const ACTIVATION_PILLS = Object.freeze({
    triggers: { text: 'Triggers', icon: 'fa-key' },
    conditions: { text: 'Conditions', icon: 'fa-filter' },
});

function browserPage(name, content) {
    const page = BROWSER_PAGES.find(each => each.name === name);
    const status = name === 'collections'
        ? statusPill({ name: '', data: { 'browser-count': 'collections' } }) + statusPill({ name: '', data: { 'browser-count': 'chunks' } })
        : '';
    return `<div id="${browserPageId(name)}" class="vfx-page"${name === FIRST_BROWSER_PAGE ? '' : HIDDEN}>`
        + pageHeader({ icon: page.icon, eyebrow: `Database Browser / ${page.title}`, title: page.title, subtitle: page.subtitle, status })
        + content
        + '</div>';
}

// ── Collections page ──────────────────────────────────────────────────────────────────────────────────

function pluginNotice() {
    const installGuide = `<a class="vfx-btn" href="${SIMILHARITY_INSTALL_URL}" target="_blank" rel="noopener"><i class="fa-solid fa-book-open"></i><span>Read the guide</span></a>`;
    return `<div id="vectfox_plugin_warning_banner"${HIDDEN}>`
        + notice({ status: 'warning', text: 'Similharity is not installed, so only registered collections and this chat show here.', action: installGuide })
        + '</div>';
}

function filtersCard() {
    return `<section class="vfx-card" id="vectfox_browser_filters">
        ${cardHeader({ icon: 'fa-filter', title: 'Filters', description: 'Choose which collections the list shows.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Type', forId: 'vectfox_browser_type' }),
                select({ id: 'vectfox_browser_type', options: [
                    selectOption({ value: 'all', text: 'All types', isSelected: true }),
                    selectOption({ value: 'chat', text: 'Chats' }),
                    selectOption({ value: 'lorebook', text: 'Lorebooks' }),
                    selectOption({ value: 'character', text: 'Characters' }),
                    selectOption({ value: 'document', text: 'Documents' }),
                    selectOption({ value: 'web', text: 'Web pages' }),
                ] }),
            ])}
            ${field([
                fieldLabel({ text: 'Status', forId: 'vectfox_browser_status' }),
                select({ id: 'vectfox_browser_status', options: [
                    selectOption({ value: 'all', text: 'Any', isSelected: true }),
                    selectOption({ value: 'enabled', text: 'Not paused' }),
                    selectOption({ value: 'disabled', text: 'Paused' }),
                ] }),
            ])}
            ${field([
                fieldLabel({ text: 'Locked to', forId: 'vectfox_browser_scope' }),
                select({ id: 'vectfox_browser_scope', options: [
                    selectOption({ value: 'all', text: 'Anything or nothing', isSelected: true }),
                    selectOption({ value: 'character', text: 'A character' }),
                    selectOption({ value: 'chat', text: 'A chat' }),
                ] }),
                hint({ text: 'Keeps the collections locked to at least one character or chat.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Name or ID', forId: 'vectfox_collection_search' }),
                input({ id: 'vectfox_collection_search', placeholder: 'Part of a name or ID' }),
            ])}
            ${switchRow({ id: 'vectfox_only_active_toggle', title: 'Active here only', description: 'Only the collections locked to this chat or to its character.', isSpan: true })}
        </div>
    </section>`;
}

function bulkBar() {
    const bulkButton = (action, text, icon, kind = 'secondary') => button({ text, icon, kind, isDisabled: true, data: { 'browser-action': action } });
    return controlRow([
        '<label class="vfx-check-item"><input type="checkbox" id="vectfox_bulk_select_all" class="vfx-check"><span>Select all shown</span></label>',
        statusPill({ name: '0 selected', data: { 'bulk-count': '' } }),
        bulkButton('bulk-enable', 'Resume', 'fa-play'),
        bulkButton('bulk-disable', 'Pause', 'fa-pause'),
        bulkButton('bulk-export', 'Export', 'fa-file-export'),
        bulkButton('bulk-delete', 'Delete', 'fa-trash-can', 'danger'),
    ]);
}

function collectionsCard() {
    const actions = iconButton({ icon: 'fa-rotate', title: 'Refresh scan', data: { 'browser-action': 'refresh-scan' } })
        + iconButton({ icon: 'fa-file-import', title: 'Import a collection', data: { 'browser-action': 'import' } });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-database', title: 'Collections', description: 'Tick collections to act on several at once.', actions })}
        <div class="vfx-card-body vfx-stack">
            ${bulkBar()}
            <div id="vectfox_collections_list" class="vfx-list">${emptyState({ icon: 'fa-spinner', text: 'Loading collections…' })}</div>
        </div>
    </section>`;
}

function collectionsPage() {
    return browserPage('collections', pluginNotice()
        + filtersCard()
        + collectionsCard()
        + dangerZone({
            title: 'Registry and Auto-Reformat originals',
            buttons: [
                { id: 'vectfox_reset_registry', icon: 'fa-arrows-rotate', text: 'Resync registry', tooltip: 'Clears the list of collections VectFox keeps, then scans the backends again.' },
                { id: 'vectfox_browser_clear_reformat_originals', icon: 'fa-broom', text: 'Clear originals', tooltip: 'Deletes the source text Auto-Reformat kept for review. The chunks stay.' },
            ],
        }));
}

/**
 * The StoryArc links row under an EventBase collection's row: how many of its events are linked, and the actions on
 * its links.
 *
 * @param {string} key - The collection's key
 * @param {string} [description] - The links' count in words; while it is being read, nothing
 * @returns {string}
 */
export function storyLinksRowMarkup(key, description = '') {
    const data = action => ({ 'collection-action': action, 'collection-key': key });
    return listRow({
        icon: 'fa-link',
        text: 'StoryArc links',
        sub: description ? { name: description } : { text: 'Reading…' },
        actions: [
            iconButton({ icon: 'fa-file-export', title: 'Export links', data: data('export-links') }),
            iconButton({ icon: 'fa-file-import', title: 'Import links', data: data('import-links') }),
            iconButton({ icon: 'fa-link-slash', title: 'Delete links', isDanger: true, data: data('delete-links') }),
        ],
        data: { 'story-links-row': key },
    });
}

/**
 * One collection in the list: its selection box, then its row (type icon, name, counts, pills and actions) and, for
 * an EventBase collection StoryArc links, its links row.
 *
 * @param {{key: string, name: string, id: string, type: string, chunkCount: number, isEnabled: boolean,
 *   isSelected: boolean, scope: string, backend: string, source: string, model: string, hasMultipleModels: boolean,
 *   activeHereLine: string, activationMode: string, hasStoryLinks: boolean, storyLinksDescription?: string}} view
 * @returns {string}
 */
export function collectionEntryMarkup(view) {
    const data = action => ({ 'collection-action': action, 'collection-key': view.key });
    const activation = ACTIVATION_PILLS[view.activationMode];
    const pills = [
        SCOPE_PILL_TEXT[view.scope] ? statusPill({ text: SCOPE_PILL_TEXT[view.scope] }) : '',
        view.hasMultipleModels ? statusPill({ name: view.model, status: 'accent', icon: 'fa-code-branch' }) : '',
        activation ? statusPill({ text: activation.text, status: 'accent', icon: activation.icon }) : '',
        view.activeHereLine ? statusPill({ text: 'Active here', status: 'success', icon: 'fa-lock' }) : '',
        view.isEnabled ? '' : statusPill({ text: 'Paused', status: 'warning', icon: 'fa-pause' }),
    ].filter(Boolean);
    const actions = [
        iconButton({ icon: view.isEnabled ? 'fa-pause' : 'fa-play', title: view.isEnabled ? 'Pause' : 'Resume', data: data('toggle') }),
        iconButton({ icon: 'fa-pen', title: 'Rename', data: data('rename') }),
        iconButton({ icon: 'fa-sliders', title: 'Edit collection settings', data: data('settings') }),
        view.hasMultipleModels ? iconButton({ icon: 'fa-code-branch', title: 'Switch model', data: data('switch-model') }) : '',
        iconButton({ icon: 'fa-eye', title: 'View chunks', data: data('view-chunks') }),
        iconButton({ icon: 'fa-file-export', title: 'Export as JSON', data: data('export-json') }),
        iconButton({ icon: 'fa-image', title: 'Export as PNG card', data: data('export-png') }),
        iconButton({ icon: 'fa-trash-can', title: 'Delete', isDanger: true, data: data('delete') }),
    ].filter(Boolean);
    const row = listRow({
        icon: TYPE_ICONS[view.type] || 'fa-cube',
        name: view.name,
        sub: [
            { text: 'Chunks', name: view.chunkCount },
            view.backend ? { text: 'Stored in', name: view.source ? `${view.backend}, embedded by ${view.source}` : view.backend } : null,
            { text: 'ID', name: view.id },
            view.activeHereLine ? { name: view.activeHereLine } : null,
        ],
        pills,
        actions,
    });
    const linksRow = view.hasStoryLinks ? storyLinksRowMarkup(view.key, view.storyLinksDescription) : '';
    return `<div class="vfx-pick-row" data-collection-entry="${escape(view.key)}">`
        + '<label class="vfx-pick-check" title="Select">'
        + `<input type="checkbox" class="vfx-check" aria-label="Select ${escape(view.name)}"${view.isSelected ? ' checked' : ''} data-collection-select="${escape(view.key)}">`
        + '</label>'
        + `<div class="vfx-pick-body">${row}${linksRow}</div>`
        + '</div>';
}

/** The list when no collection passes the filters. */
export function noCollectionsMarkup() {
    return emptyState({ icon: 'fa-database', text: 'No collections match these filters.' });
}

/** The list when the collections could not be read. */
export function collectionsFailedMarkup() {
    return notice({ status: 'danger', text: 'The collections could not be read. The console has the reason.' });
}

// ── Search page ───────────────────────────────────────────────────────────────────────────────────────

function queryCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-magnifying-glass', title: 'Query', description: 'Runs the query against every collection the list can show.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Query', forId: 'vectfox_semantic_search' }),
                controlRow([
                    input({ id: 'vectfox_semantic_search', placeholder: 'What to look for' }),
                    buttonWithId({ id: 'vectfox_search_btn', text: 'Search', icon: 'fa-magnifying-glass', isPrimary: true }),
                ]),
            ], { isSpan: true })}
            ${field([
                fieldLabel({ text: 'Results per collection', forId: 'vectfox_search_topk' }),
                input({ id: 'vectfox_search_topk', type: 'number', value: 5, min: 1, max: 50, step: 1 }),
            ])}
            ${field([
                fieldLabel({ text: 'Lowest score', forId: 'vectfox_search_threshold' }),
                input({ id: 'vectfox_search_threshold', type: 'number', value: 0.3, min: 0, max: 1, step: 0.05 }),
                hint({ text: 'Results less similar than this are left out.' }),
            ])}
            ${switchRow({ id: 'vectfox_search_enabled_only', title: 'Skip paused collections', description: 'Paused collections stay out of the search and the keyword scan.', isSpan: true })}
        </div>
    </section>`;
}

function keywordCard() {
    const scan = iconButton({ icon: 'fa-rotate', title: 'Scan for keywords', data: { 'browser-action': 'scan-keywords' } });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-tags', title: 'Keyword filter', description: 'Keeps only results whose chunks carry one of these keywords.', actions: scan })}
        <div class="vfx-card-body vfx-stack">
            ${field([
                fieldLabel({ text: 'Keywords', forId: 'vectfox_keyword_filter' }),
                controlRow([
                    input({ id: 'vectfox_keyword_filter', placeholder: 'Separated by commas' }),
                    iconButton({ icon: 'fa-xmark', title: 'Clear the keywords', data: { 'browser-action': 'clear-keywords' } }),
                ]),
                hint({ text: 'Scan lists the keywords your collections hold. Click one to add or drop it.' }),
            ])}
            <div id="vectfox_keyword_tags" class="vfx-control-row"></div>
        </div>
    </section>`;
}

function resultsCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-list', title: 'Results', description: 'The closest chunks first, grouped by collection.' })}
        <div class="vfx-card-body">
            <div id="vectfox_search_results" class="vfx-list">${searchPromptMarkup()}</div>
        </div>
    </section>`;
}

function searchPage() {
    return browserPage('search', queryCard() + keywordCard() + resultsCard());
}

/** The results area before any search. */
export function searchPromptMarkup() {
    return emptyState({ icon: 'fa-magnifying-glass', text: 'Type a query and press Search.' });
}

/** The results area while a search runs. */
export function searchRunningMarkup() {
    return emptyState({ icon: 'fa-spinner', text: 'Searching…' });
}

/** The results area when no collection is left to search. */
export function nothingToSearchMarkup() {
    return emptyState({ icon: 'fa-folder-open', text: 'No collection is left to search.' });
}

/**
 * The results area when a search failed.
 *
 * @param {string} reason - The error's message
 * @returns {string}
 */
export function searchFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'The search failed', name: reason });
}

/**
 * A notice over the results naming the collections a search could not reach, and the first one's reason. The
 * console has every reason. '' when every collection was searched.
 *
 * @param {{name: string, reason: string}[]} failures
 * @returns {string}
 */
export function searchFailuresMarkup(failures) {
    if (failures.length === 0) return '';
    return notice({ status: 'warning', parts: [
        { text: 'Not searched' },
        { name: `: ${failures.map(failure => failure.name).join(', ')}. ` },
        { text: 'Why' },
        { name: `: ${failures[0].reason}` },
    ] });
}

/**
 * The keywords the scan found, as buttons that add or drop one from the filter, the most common first.
 *
 * @param {{text: string, count: number}[]} keywords
 * @param {string[]} activeKeywords - The keywords in the filter, lower case
 * @returns {string}
 */
export function keywordTagsMarkup(keywords, activeKeywords) {
    if (keywords.length === 0) return emptyState({ icon: 'fa-tags', text: 'The scan found no keywords.' });
    const tags = keywords.slice(0, KEYWORD_TAG_LIMIT).map(({ text, count }) => {
        const isOn = activeKeywords.includes(text);
        return `<button type="button" class="vfx-btn${isOn ? ' vfx-btn-primary' : ''}" aria-pressed="${isOn}" data-keyword="${escape(text)}">${escape(`${text} (${count})`)}</button>`;
    });
    const more = keywords.length > KEYWORD_TAG_LIMIT ? statusPill({ name: `${keywords.length - KEYWORD_TAG_LIMIT} more` }) : '';
    return tags.join('') + more;
}

/** The keyword area while the scan runs. */
export function keywordScanRunningMarkup() {
    return emptyState({ icon: 'fa-spinner', text: 'Scanning the collections…' });
}

/** The keyword area when the scan failed. */
export function keywordScanFailedMarkup() {
    return notice({ status: 'danger', text: 'The keyword scan failed. The console has the reason.' });
}

/**
 * The search's results, grouped by collection.
 *
 * @param {{groups: {key: string, name: string, results: {score: string, vectorScore: string|null,
 *   textScore: string|null, isHybrid: boolean, preview: string, keywords: string[], moreKeywordCount: number}[]}[],
 *   totalCount: number, countBeforeKeywords: number|null}} view - countBeforeKeywords: the count before the keyword
 *   filter, when it is on
 * @returns {string}
 */
export function searchResultsMarkup({ groups, totalCount, countBeforeKeywords = null }) {
    if (totalCount === 0) {
        if (countBeforeKeywords !== null) {
            return emptyState({ icon: 'fa-tags', text: 'No result carries those keywords.' })
                + `<p class="vfx-hint">${escape(`${counted(countBeforeKeywords, 'result')} before the keyword filter.`)}</p>`;
        }
        return emptyState({ icon: 'fa-magnifying-glass', text: 'Nothing scored at or above the lowest score.' });
    }
    const summary = `${counted(totalCount, 'result')} in ${counted(groups.length, 'collection')}`
        + (countBeforeKeywords !== null ? `, ${countBeforeKeywords} before the keyword filter` : '');
    const sections = groups.map(group => groupTitle({ icon: 'fa-folder', name: `${group.name} (${group.results.length})` })
        + group.results.map(result => listRow({
            icon: 'fa-quote-left',
            name: `${result.score}% match`,
            sub: [
                { name: result.preview },
                result.keywords.length
                    ? { text: 'Keywords', name: result.keywords.join(', ') + (result.moreKeywordCount ? `, ${result.moreKeywordCount} more` : '') }
                    : null,
            ],
            pills: result.isHybrid
                ? [statusPill({ name: `Meaning ${result.vectorScore ?? '?'}%` }), statusPill({ name: `Words ${result.textScore ?? '0'}%` })]
                : [],
            actions: [iconButton({ icon: 'fa-eye', title: 'View chunks', data: { 'collection-action': 'view-chunks', 'collection-key': group.key } })],
        })).join(''));
    return `<p class="vfx-hint">${escape(summary)}</p>${sections.join('')}`;
}

// ── Size page ─────────────────────────────────────────────────────────────────────────────────────────

function sizePage() {
    const back = button({ text: 'Show ranking', icon: 'fa-arrow-left', data: { 'size-action': 'back' } });
    return browserPage('size', `<section class="vfx-card">
            ${cardHeader({ icon: 'fa-weight-hanging', title: 'Scan', description: 'Reads every collection and ranks them by their largest entry.' })}
            <div class="vfx-card-body vfx-stack">
                ${controlRow([buttonWithId({ id: 'vectfox_size_scan_btn', text: 'Scan all collections', icon: 'fa-magnifying-glass-chart', isPrimary: true })])}
                <div id="vectfox_size_status"></div>
            </div>
        </section>
        <section id="vectfox_size_summary_wrap" class="vfx-card"${HIDDEN}>
            ${cardHeader({ icon: 'fa-ranking-star', title: 'Collections by size', description: 'Largest entry first. Show entries lists one collection\'s entries.' })}
            <div class="vfx-card-body"><div id="vectfox_size_summary_list" class="vfx-list"></div></div>
        </section>
        <section id="vectfox_size_detail_wrap" class="vfx-card"${HIDDEN}>
            ${cardHeader({ icon: 'fa-list-ol', title: 'Largest entries', description: 'One collection\'s entries, the largest first.', actions: back })}
            <div class="vfx-card-body vfx-stack">
                <p id="vectfox_size_detail_title" class="vfx-hint"></p>
                <div id="vectfox_size_detail_list" class="vfx-list"></div>
                <div id="vectfox_size_detail_pager"></div>
            </div>
        </section>`);
}

/**
 * The Size page's status line: a hint while the scan runs or after it, or a notice when it failed.
 *
 * @param {{text: string, isFailed?: boolean}} status
 * @returns {string}
 */
export function sizeStatusMarkup({ text, isFailed = false }) {
    if (isFailed) return notice({ status: 'danger', text: 'The scan failed', name: text });
    return `<p class="vfx-hint">${escape(text)}</p>`;
}

/**
 * One collection's row in the size ranking.
 *
 * @param {{key: string, collectionId: string, backend: string, count: number, maxChars: number, avgChars: number,
 *   totalBytes: number, worstPreview: string, error?: boolean}} row - totalBytes is the entries' metadata as UTF-8
 * @returns {string}
 */
export function sizeSummaryRowMarkup(row) {
    const sizes = `${counted(row.count, 'entry', 'entries')}, ${formatBytes(row.totalBytes)} in all`;
    const characters = `largest ${row.maxChars}, average ${row.avgChars}`;
    const canShow = !row.error && row.count > 0;
    return listRow({
        icon: row.error ? 'fa-circle-exclamation' : 'fa-database',
        name: row.collectionId,
        sub: row.error ? [{ name: row.worstPreview }] : [
            { name: sizes },
            row.count > 0 ? { text: 'Characters per entry', name: characters } : null,
            row.count > 0 ? { text: 'Largest entry', name: row.worstPreview } : null,
        ],
        pills: [statusPill({ name: row.backend }), row.error ? statusPill({ text: 'Failed', status: 'danger' }) : ''].filter(Boolean),
        actions: canShow ? [iconButton({ icon: 'fa-list-ol', title: 'Show entries', data: { 'size-action': 'show', 'size-key': row.key } })] : [],
    });
}

/**
 * One page of a collection's entries, largest first, and the pager under them.
 *
 * @param {{rank: number, chars: number, hash: string, preview: string}[]} entries - Every entry, largest first
 * @param {number} page - Counts from 0
 * @returns {{list: string, pager: string}}
 */
export function sizeEntriesMarkup(entries, page) {
    const pageCount = Math.max(1, Math.ceil(entries.length / SIZE_ENTRIES_PER_PAGE));
    const shown = entries.slice(page * SIZE_ENTRIES_PER_PAGE, (page + 1) * SIZE_ENTRIES_PER_PAGE);
    const list = shown.map(entry => listRow({
        icon: 'fa-file-lines',
        name: `#${entry.rank}: ${entry.chars} characters`,
        sub: [{ text: 'Hash', name: entry.hash }, { name: entry.preview }],
    })).join('');
    const pagerMarkup = pageCount > 1
        ? pager({ page, pageCount, previousData: { 'size-page': page - 1 }, nextData: { 'size-page': page + 1 } })
        : '';
    return { list, pager: pagerMarkup };
}

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The whole browser: the top bar, then the three pages, the first one shown.
 *
 * @returns {string}
 */
export function databaseBrowserMarkup() {
    const items = BROWSER_PAGES.map(page => navItem({ id: browserTabId(page.name), icon: page.icon, title: page.title, isActive: page.name === FIRST_BROWSER_PAGE }));
    return `<div id="${BROWSER_ROOT_ID}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Database Browser')}${items.join('')}</div></nav>`
        + `<main class="vfx-main">${collectionsPage()}${searchPage()}${sizePage()}</main>`
        + '</div>';
}
