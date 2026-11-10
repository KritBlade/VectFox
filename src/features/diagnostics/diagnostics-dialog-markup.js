/**
 * Diagnostics' dialog markup on GUI-DNA (diagnostics-dialog.js wires it): a top bar of three pages. Checks runs the
 * diagnostics and lists the results by category; Backend health shows the backend's live numbers; Query Tester shows
 * what each retrieval would inject for a test message.
 *
 * Hooks: data-diag-action on buttons, data-diag-part on what the wiring paints.
 */

import {
    button,
    codeChip,
    emptyState,
    field,
    fieldLabel,
    grid,
    iconButton,
    notice,
    resultList,
    select,
    selectOption,
    stack,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, navItem, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { CHECK_CATEGORIES, CHECK_FILTERS, checksShown, statusCounts, storyArcNote } from './diagnostics-dialog-core.js';
import { HEALTH_LEVELS } from './backend-health.js';
import { escapeHtml } from '../../shared/html-escape.js';

export const DIAGNOSTICS_ROOT_ID = 'vectfox_diagnostics';

/** The dialog's pages, in the top bar's order. */
export const DIAGNOSTICS_PAGES = Object.freeze([
    { name: 'checks', icon: 'fa-stethoscope', title: 'Checks', subtitle: 'Checks every part of the setup and lists what passes, warns or fails.' },
    { name: 'health', icon: 'fa-heart-pulse', title: 'Backend health', subtitle: 'The vector backend\'s live counts, latency and errors since VectFox loaded.' },
    { name: 'query', icon: 'fa-magnifying-glass', title: 'Query Tester', subtitle: 'What each retrieval would inject for a message. Nothing is sent.' },
]);

export const DIAGNOSTICS_IDS = Object.freeze({
    production: 'vectfox_diag_production',
    filter: 'vectfox_diag_filter',
    queryMessage: 'vectfox_diag_query_message',
});

export const diagnosticsTabId = name => `vectfox_diag_tab_${name}`;
export const diagnosticsPageId = name => `vectfox_diag_page_${name}`;

const HIDDEN = ' style="display:none;"';
const action = name => ({ 'diag-action': name });
const part = name => `data-diag-part="${name}"`;
const STATUS_OF_CHECK = { pass: 'success', warning: 'warning', fail: 'danger' };
const warningsText = count => `${count} ${count === 1 ? 'warning' : 'warnings'}`;

function card({ icon, title, description, actions = '', body, isCollapsible = false }) {
    return `<section class="vfx-card">${cardHeader({ icon, title, description, actions, isCollapsible })}<div class="vfx-card-body">${body}</div></section>`;
}

function diagnosticsPage(name, content, status = '') {
    const page = DIAGNOSTICS_PAGES.find(each => each.name === name);
    return `<div id="${diagnosticsPageId(name)}" class="vfx-page" data-diag-page="${name}"${HIDDEN}>`
        + pageHeader({ icon: page.icon, eyebrow: `Diagnostics / ${page.title}`, title: page.title, subtitle: page.subtitle, status })
        + content
        + '</div>';
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────

function checksPage() {
    const run = card({
        icon: 'fa-play',
        title: 'Run checks',
        description: 'Infrastructure, Configuration and Visualizer run every time.',
        body: stack([
            switchRow({ id: DIAGNOSTICS_IDS.production, title: 'Production tests', description: 'Live embedding, storage and retrieval in throwaway test collections.' }),
            `<div class="vfx-control-row">${button({ text: 'Run checks', icon: 'fa-play', kind: 'primary', data: action('run') })}`
                + `${button({ text: 'Copy report', icon: 'fa-copy', isDisabled: true, data: action('copy') })}</div>`,
            `<p class="vfx-hint" ${part('run-state')}></p>`,
        ]),
    });
    return diagnosticsPage('checks', run + `<div ${part('results')}></div>`, `<span ${part('versions')}></span>`);
}

/** The versions a run found, as the Checks page's pills. */
export function versionPillsMarkup(version) {
    return statusPill({ name: `VectFox ${version?.extension || 'unknown'}` })
        + statusPill({ name: version?.plugin && version.plugin !== 'Not installed' ? `Similharity ${version.plugin}` : 'No Similharity', status: version?.plugin && version.plugin !== 'Not installed' ? 'neutral' : 'warning' });
}

function checkLine(check) {
    const line = { name: `${check.name}: ${check.message}` };
    if (STATUS_OF_CHECK[check.status]) line.status = STATUS_OF_CHECK[check.status];
    else line.icon = 'fa-circle-minus';
    return line;
}

/**
 * A run's results: the counts and the filter, then each category's checks the filter shows.
 *
 * @param {{categories: Record<string, object[]>, checks: object[], overall: string}} results
 * @param {string} filter - all, pass, warning or fail
 * @returns {string}
 */
export function checkResultsMarkup(results, filter) {
    const counts = statusCounts(results.checks);
    const verdict = { healthy: ['All checks passed', 'success'], warnings: ['Finished with warnings', 'warning'], issues: ['Issues found', 'danger'] }[results.overall];
    const filterSelect = select({
        id: DIAGNOSTICS_IDS.filter,
        title: 'Show',
        options: CHECK_FILTERS.map(each => selectOption({ value: each.id, text: each.text, isSelected: each.id === filter })),
    });
    const summary = `<section class="vfx-card">${cardHeader({ icon: 'fa-list-check', title: 'Results', description: verdict[0], actions: filterSelect, isCollapsible: false })}`
        + `<div class="vfx-card-body"><div class="vfx-control-row">${statusPill({ name: `${counts.pass} passed`, status: 'success' })}`
        + `${statusPill({ name: warningsText(counts.warning), status: counts.warning ? 'warning' : 'neutral' })}`
        + `${statusPill({ name: `${counts.fail} failed`, status: counts.fail ? 'danger' : 'neutral' })}</div></div></section>`;
    const categories = CHECK_CATEGORIES.map(({ id, title, icon }) => {
        const checks = results.categories[id];
        if (!checks) return '';
        const shown = checksShown(checks, filter);
        if (!shown.length) return '';
        const categoryCounts = statusCounts(checks);
        return card({
            icon,
            title,
            description: `${categoryCounts.pass} passed, ${warningsText(categoryCounts.warning)}, ${categoryCounts.fail} failed`,
            isCollapsible: true,
            body: resultList({ lines: shown.map(checkLine) }),
        });
    }).join('');
    return summary + (categories || emptyState({ icon: 'fa-filter', text: 'No check matches this filter.' }));
}

// ── Backend health ──────────────────────────────────────────────────────────────────────────────────

function healthPage() {
    const status = `<span ${part('health-level')}></span><span ${part('uptime')}></span>`;
    return diagnosticsPage('health', `<div ${part('health')}></div>`, status);
}

const milliseconds = value => (value === null || value === undefined ? '—' : `${value} ms`);

/** The Backend health page's pills: its level, and how long VectFox has run. */
export function healthPillsMarkup(view) {
    const { text, status } = HEALTH_LEVELS[view.level];
    return [statusPill({ text, status }), statusPill({ name: `Up ${view.uptime}` })];
}

/**
 * The Backend health page: the current backend's counts, latency and health checks, its last error, and the totals
 * over every backend.
 *
 * @param {object} view - backendHealthView()
 * @returns {string}
 */
export function healthMarkup(view) {
    const backend = card({
        icon: 'fa-database',
        title: `Backend: ${view.name}`,
        description: 'Counts since VectFox loaded; refreshes every 5 seconds.',
        actions: iconButton({ icon: 'fa-arrows-rotate', title: 'Refresh now', data: action('refresh-health') }),
        body: stack([
            grid([field([resultList({ heading: { text: 'Operations' }, lines: [
                { icon: 'fa-magnifying-glass', text: 'Queries', name: String(view.queries) },
                { icon: 'fa-plus', text: 'Inserts', name: String(view.inserts) },
                { icon: 'fa-trash', text: 'Deletes', name: String(view.deletes) },
                { ...(view.errors > 0 ? { status: 'danger' } : { icon: 'fa-circle-exclamation' }), text: 'Errors', name: String(view.errors) },
            ] })]),
            field([resultList({ heading: { text: 'Query latency' }, lines: [
                { icon: 'fa-gauge', text: 'Average', name: milliseconds(view.averageLatency) },
                { icon: 'fa-gauge-high', text: 'Fastest', name: milliseconds(view.fastestLatency) },
                { icon: 'fa-gauge-simple', text: 'Slowest', name: milliseconds(view.slowestLatency) },
            ] })]),
            field([resultList({ heading: { text: 'Health checks' }, lines: [
                { status: 'success', text: 'Passed', name: String(view.checksPassed) },
                { ...(view.checksFailed > 0 ? { status: 'danger' } : { icon: 'fa-circle-xmark' }), text: 'Failed', name: String(view.checksFailed) },
                { icon: 'fa-clock', text: 'Last check', name: view.lastCheck },
            ] })])]),
            view.lastError ? notice({ status: 'danger', text: `Last error, ${view.lastError.when}`, name: view.lastError.message }) : '',
        ]),
    });
    const everyBackend = card({
        icon: 'fa-layer-group',
        title: 'Every backend',
        description: 'Totals over every backend VectFox has used since it loaded.',
        body: stack([
            resultList({ lines: [
                { icon: 'fa-magnifying-glass', text: 'Queries', name: String(view.totalQueries) },
                { icon: 'fa-plus', text: 'Inserts', name: String(view.totalInserts) },
                { ...(view.totalErrors > 0 ? { status: 'danger' } : { icon: 'fa-circle-exclamation' }), text: 'Errors', name: String(view.totalErrors) },
            ] }),
            view.activeBackends.length ? `<div class="vfx-control-row">${view.activeBackends.map(name => codeChip({ name })).join('')}</div>` : '',
        ]),
    });
    return backend + everyBackend;
}

// ── Query Tester ────────────────────────────────────────────────────────────────────────────────────

/** The three retrievals the Query Tester runs, in the order it shows them. */
export const QUERY_RETRIEVALS = Object.freeze([
    { kind: 'eventbase', title: 'EventBase', icon: 'fa-timeline' },
    { kind: 'chunkbase', title: 'ChunkBase', icon: 'fa-cubes' },
    { kind: 'lorebook', title: 'Lorebook WI', icon: 'fa-book-open' },
]);

const queryOutputId = kind => `vectfox_diag_query_output_${kind}`;

function queryPage() {
    const message = card({
        icon: 'fa-keyboard',
        title: 'Test message',
        description: 'Uses your settings and locked collections; the chat is untouched.',
        body: stack([
            field([fieldLabel({ text: 'Message', forId: DIAGNOSTICS_IDS.queryMessage }), textarea({ id: DIAGNOSTICS_IDS.queryMessage, rows: 3 })]),
            `<div class="vfx-control-row">${button({ text: 'Run retrievals', icon: 'fa-play', kind: 'primary', data: action('query') })}</div>`,
            `<p class="vfx-hint" ${part('query-state')}></p>`,
        ]),
    });
    return diagnosticsPage('query', message + `<div ${part('query-results')}></div>`);
}

/**
 * What each retrieval would inject, or why it has nothing.
 *
 * @param {Record<string, {count: string, text: string, reason: string}>} outcomes - by kind (queryOutcome)
 * @param {{storyArc?: object}} eventBase - The EventBase result, for its StoryArc rule
 * @returns {string}
 */
export function queryResultsMarkup(outcomes, eventBase) {
    return QUERY_RETRIEVALS.map(({ kind, title, icon }) => {
        const outcome = outcomes[kind];
        const pill = statusPill({ name: outcome.count || 'Nothing found', status: outcome.count ? 'success' : 'neutral' });
        const note = kind === 'eventbase' ? storyArcNote(eventBase?.storyArc) : '';
        const body = outcome.text
            ? stack([
                note ? `<p class="vfx-hint">${escapeHtml(note)}</p>` : '',
                textarea({ id: queryOutputId(kind), value: outcome.text, rows: 8, isCode: true, title: `${title} injection` }),
            ])
            : emptyState({ icon: 'fa-circle-info', text: outcome.reason });
        return `<section class="vfx-card">${cardHeader({ icon, title, actions: pill, isCollapsible: false })}<div class="vfx-card-body">${body}</div></section>`;
    }).join('');
}

/**
 * The dialog, open on one page.
 *
 * @param {string} pageName
 * @returns {string}
 */
export function diagnosticsMarkup(pageName) {
    const items = DIAGNOSTICS_PAGES.map(page => navItem({ id: diagnosticsTabId(page.name), icon: page.icon, title: page.title, isActive: page.name === pageName }));
    return `<div id="${DIAGNOSTICS_ROOT_ID}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Diagnostics')}${items.join('')}</div></nav>`
        + `<main class="vfx-main">${checksPage()}${healthPage()}${queryPage()}</main>`
        + '</div>';
}
