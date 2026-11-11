/**
 * ============================================================================
 * VectFox DIAGNOSTICS DIALOG
 * ============================================================================
 * Diagnostics' dialog (diagnostics-dialog-markup.js draws it): Checks, Backend health and Query Tester, each opened
 * from its own button on the panel's Action page. Checks runs the diagnostics, Production tests only when switched on,
 * catching what the console says meanwhile, and copies a report; Backend health probes the backend every 5 seconds
 * while it shows; Query Tester dry-runs the three retrievals. Its handlers are delegated on its root.
 *
 * @author Kritblade
 * ============================================================================
 */

import { extension_settings } from '../../sillytavern/settings.js';
import { openPanelPopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import { bindGeneBehaviours, scrollPageToTop, setShown } from '../../shared/gui-dna/gene-behaviours.js';
import { getModelField, getModelFromSettings, resolveEmbeddingProfile, resolveProviderApiUrl } from '../embedding/index.js';
import { backendHealthView, probeCurrentBackend } from './backend-health.js';
import { runQueryTest } from './query-tester.js';
import { dialogResults, diagnosticsReportText, queryOutcome, storedValue } from './diagnostics-dialog-core.js';
import {
    DIAGNOSTICS_IDS,
    DIAGNOSTICS_PAGES,
    QUERY_RETRIEVALS,
    checkResultsMarkup,
    diagnosticsMarkup,
    diagnosticsPageId,
    diagnosticsTabId,
    healthMarkup,
    healthPillsMarkup,
    queryResultsMarkup,
    versionPillsMarkup,
} from './diagnostics-dialog-markup.js';

const HEALTH_REFRESH_MS = 5000;

/** The open dialog: its root, the page shown, the last run's results and filter, and the health refresh's timer. */
let dialog = null;

const partOf = name => dialog?.root.querySelector(`[data-diag-part="${name}"]`) ?? null;
const actionButtons = name => [...(dialog?.root.querySelectorAll(`[data-diag-action="${name}"]`) ?? [])];

function setText(name, text) {
    const element = partOf(name);
    if (element) element.textContent = text;
}

/**
 * Open Diagnostics on a page; while it is open, show that page.
 *
 * @param {'checks'|'health'|'query'} [pageName]
 * @returns {Promise<void>} Resolves when the dialog closes
 */
export async function openDiagnostics(pageName = 'checks') {
    const page = DIAGNOSTICS_PAGES.some(each => each.name === pageName) ? pageName : 'checks';
    if (dialog) {
        showPage(page);
        return;
    }
    const template = document.createElement('template');
    template.innerHTML = diagnosticsMarkup(page);
    const root = template.content.firstElementChild;
    dialog = { root, page: null, results: null, filter: 'all', healthTimer: null, isRunning: false, isQuerying: false };
    bindGeneBehaviours(root);
    bindDialog(root);
    showPage(page);
    try {
        await openPanelPopup(root);
    } finally {
        stopHealthRefresh();
        dialog = null;
    }
}

function showPage(name) {
    const { root } = dialog;
    for (const page of DIAGNOSTICS_PAGES) {
        const isShown = page.name === name;
        setShown(root.querySelector(`#${diagnosticsPageId(page.name)}`), isShown);
        const tab = root.querySelector(`#${diagnosticsTabId(page.name)}`);
        tab.classList.toggle('is-active', isShown);
        if (isShown) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    if (dialog.page !== name) scrollPageToTop(root.querySelector(`#${diagnosticsPageId(name)}`));
    dialog.page = name;
    // The probe runs only while its numbers show.
    if (name === 'health') startHealthRefresh();
    else stopHealthRefresh();
}

function bindDialog(root) {
    for (const page of DIAGNOSTICS_PAGES) {
        root.querySelector(`#${diagnosticsTabId(page.name)}`).addEventListener('click', () => showPage(page.name));
    }
    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-diag-action]');
        if (!button || button.disabled) return;
        switch (button.dataset.diagAction) {
            case 'run': return void runChecks();
            case 'copy': return void copyReport();
            case 'refresh-health': return void refreshHealth();
            case 'query': return void runQuery();
            default: return undefined;
        }
    });
    root.addEventListener('change', (event) => {
        if (event.target.id !== DIAGNOSTICS_IDS.filter || !dialog.results) return;
        dialog.filter = event.target.value;
        partOf('results').innerHTML = checkResultsMarkup(dialog.results, dialog.filter);
    });
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────

let capturedConsoleLogs = [];
let originalConsoleError = null;
let originalConsoleWarn = null;

const consoleText = args => args.map(each => (typeof each === 'object' ? JSON.stringify(each) : String(each))).join(' ');

/** Catch what the console says while the checks run, so the results list it. */
function startConsoleCapture() {
    capturedConsoleLogs = [];
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.error = function (...args) {
        capturedConsoleLogs.push({ type: 'error', message: consoleText(args), timestamp: new Date().toISOString(), stack: new Error().stack });
        originalConsoleError.apply(console, args);
    };
    console.warn = function (...args) {
        capturedConsoleLogs.push({ type: 'warning', message: consoleText(args), timestamp: new Date().toISOString() });
        originalConsoleWarn.apply(console, args);
    };
}

/** Give the console back, with what it said meanwhile. */
function stopConsoleCapture() {
    if (originalConsoleError) console.error = originalConsoleError;
    if (originalConsoleWarn) console.warn = originalConsoleWarn;
    originalConsoleError = null;
    originalConsoleWarn = null;
    return capturedConsoleLogs;
}

async function runChecks() {
    if (dialog.isRunning) return;
    const includesProduction = dialog.root.querySelector(`#${DIAGNOSTICS_IDS.production}`).checked;
    dialog.isRunning = true;
    for (const button of [...actionButtons('run'), ...actionButtons('copy')]) button.disabled = true;
    setText('run-state', includesProduction ? 'Running checks and Production tests…' : 'Running checks…');
    let runnerResults = null;
    let consoleLogs = [];
    startConsoleCapture();
    try {
        // The runner and its checks load on the first run, so they stay out of startup.
        const { runDiagnostics } = await import('./diagnostics-runner.js');
        runnerResults = await runDiagnostics(extension_settings.vectfox, includesProduction);
    } catch (error) {
        log.error('VectFox Diagnostics: the run failed:', error);
        toastr.error(`Diagnostics failed: ${error.message}`, 'VectFox');
    } finally {
        consoleLogs = stopConsoleCapture();
    }
    if (!dialog) return;
    dialog.isRunning = false;
    for (const button of actionButtons('run')) button.disabled = false;
    if (!runnerResults) {
        setText('run-state', 'The run failed; the console has more.');
        for (const button of actionButtons('copy')) button.disabled = !dialog.results;
        return;
    }
    dialog.results = dialogResults(runnerResults, { includesProduction, consoleLogs });
    dialog.filter = 'all';
    partOf('results').innerHTML = checkResultsMarkup(dialog.results, dialog.filter);
    partOf('versions').innerHTML = versionPillsMarkup(dialog.results.version);
    for (const button of actionButtons('copy')) button.disabled = false;
    setText('run-state', '');
    log.lifecycle(`VectFox Diagnostics: ${dialog.results.checks.length} checks, ${dialog.results.overall}`);
}

/** The settings the report prints, each under its page's name, stored values as they are. */
function reportSettingLines(settings) {
    const provider = settings.embedding_provider;
    const onProfile = resolveEmbeddingProfile(settings);
    const lines = [
        ['Backend', `${storedValue(settings.vector_backend)}${settings.vector_backend === 'qdrant' ? ` (${settings.qdrant_mode || 'local'})` : ''}`],
        ['Embedding provider', storedValue(provider)],
    ];
    if (onProfile) lines.push(['Embedding profile', onProfile.problem || storedValue(onProfile.profileName)]);
    lines.push(['Model', getModelField(provider) ? storedValue(getModelFromSettings(settings)) : 'chosen by the provider']);
    if (provider === 'ollama' || provider === 'vllm') {
        lines.push(['Provider URL', storedValue(onProfile ? onProfile.url : resolveProviderApiUrl(settings, provider))]);
    }
    if (settings.vector_backend === 'qdrant') lines.push(['Qdrant URL', storedValue(settings.qdrant_mode === 'cloud' ? settings.qdrant_cloud_url : settings.qdrant_url)]);
    lines.push(
        ['Query depth', storedValue(settings.query)],
        ['ChunkBase similarity threshold', storedValue(settings.score_threshold)],
        ['EventBase similarity threshold', storedValue(settings.eventbase_score_threshold)],
    );
    return lines;
}

async function copyReport() {
    const { results, filter } = dialog;
    if (!results) return;
    const report = diagnosticsReportText({
        results,
        filter,
        settingLines: reportSettingLines(extension_settings.vectfox),
        generatedAt: new Date(results.timestamp).toLocaleString(),
    });
    try {
        await navigator.clipboard.writeText(report);
        setText('run-state', filter === 'all' ? 'Report copied.' : 'Report copied, with the checks this filter shows.');
    } catch (error) {
        log.warn('VectFox Diagnostics: the clipboard refused the report:', error);
        setText('run-state', `The clipboard refused the report: ${error.message}`);
    }
}

// ── Backend health ──────────────────────────────────────────────────────────────────────────────────

async function refreshHealth() {
    try {
        await probeCurrentBackend();
    } catch (error) {
        log.warn('VectFox Diagnostics: the health probe failed:', error);
    }
    if (dialog?.page !== 'health') return;
    const view = backendHealthView();
    partOf('health').innerHTML = healthMarkup(view);
    const [level, uptime] = healthPillsMarkup(view);
    partOf('health-level').innerHTML = level;
    partOf('uptime').innerHTML = uptime;
}

function startHealthRefresh() {
    if (dialog.healthTimer) return;
    void refreshHealth();
    dialog.healthTimer = setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);
}

function stopHealthRefresh() {
    if (!dialog?.healthTimer) return;
    clearInterval(dialog.healthTimer);
    dialog.healthTimer = null;
}

// ── Query Tester ────────────────────────────────────────────────────────────────────────────────────

async function runQuery() {
    if (dialog.isQuerying) return;
    const message = dialog.root.querySelector(`#${DIAGNOSTICS_IDS.queryMessage}`).value.trim();
    if (!message) {
        setText('query-state', 'Type a message first.');
        return;
    }
    dialog.isQuerying = true;
    for (const button of actionButtons('query')) button.disabled = true;
    setText('query-state', 'Running the three retrievals…');
    try {
        const run = await runQueryTest(message);
        if (!dialog) return;
        const results = { eventbase: run.eventBase, chunkbase: run.chunkBase, lorebook: run.lorebook };
        const outcomes = Object.fromEntries(QUERY_RETRIEVALS.map(({ kind }) => [kind, queryOutcome(kind, results[kind], run)]));
        partOf('query-results').innerHTML = queryResultsMarkup(outcomes, run.eventBase);
        for (const output of partOf('query-results').querySelectorAll('textarea')) output.readOnly = true;
        setText('query-state', '');
    } catch (error) {
        log.error('VectFox Query Tester: retrieval failed:', error);
        toastr.error(`Retrieval failed: ${error.message}`, 'VectFox');
        setText('query-state', 'The retrievals failed; the console has more.');
    } finally {
        if (dialog) {
            dialog.isQuerying = false;
            for (const button of actionButtons('query')) button.disabled = false;
        }
    }
}
