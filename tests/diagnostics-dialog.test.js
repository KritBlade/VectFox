/**
 * @vitest-environment jsdom
 *
 * Diagnostics' dialog on GUI-DNA (src/features/diagnostics/diagnostics-dialog.js): one dialog of three pages, Checks,
 * Backend health and Query Tester, each opened from its own Action-page button. Checks has one Run and a Production
 * tests switch, as the old four boxes only hid results the runner always made; it lists the results by category,
 * filters them, and catches what the console said meanwhile. Copy report prints each threshold as stored under its
 * page's name, where the old report printed `score_threshold || 0.5`, so a threshold of 0 read 0.5. Backend health
 * probes while it shows and stops when it hides. Query Tester shows what each retrieval would inject, or why not.
 * Every check name, message and error is text, never markup.
 */
/* global document -- this file runs under the jsdom environment */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    root: { vectfox: {} },
    dialogs: [],
    runner: null,
    query: null,
    metrics: null,
}));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.root }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    openPanelPopup: vi.fn(root => {
        document.body.append(root);
        return new Promise((resolve) => { host.dialogs.push({ root, resolve }); });
    }),
}));
vi.mock('../src/features/embedding/index.js', () => ({
    getModelField: provider => (provider === 'openrouter' ? 'openrouter_model' : null),
    resolveProviderApiUrl: () => 'http://localhost:11434',
}));
vi.mock('../src/features/vector-backend/index.js', () => ({
    getBackendMetrics: () => host.metrics,
    probeBackendHealth: vi.fn(async () => {}),
}));
vi.mock('../src/features/diagnostics/diagnostics-runner.js', () => ({
    runDiagnostics: vi.fn(async () => {
        console.error('a check broke <b>loudly</b>');
        return host.runner;
    }),
}));
vi.mock('../src/features/diagnostics/query-tester.js', () => ({ runQueryTest: vi.fn(async () => host.query) }));

const { openDiagnostics } = await import('../src/features/diagnostics/diagnostics-dialog.js');
const { diagnosticsReportText, dialogResults, storedValue } = await import('../src/features/diagnostics/diagnostics-dialog-core.js');
const { runDiagnostics } = await import('../src/features/diagnostics/diagnostics-runner.js');
const { probeBackendHealth } = await import('../src/features/vector-backend/index.js');

const $id = id => document.getElementById(id);
const part = name => document.querySelector(`[data-diag-part="${name}"]`);
const click = action => document.querySelector(`[data-diag-action="${action}"]`).click();
const shownPage = () => [...document.querySelectorAll('[data-diag-page]')].filter(page => page.style.display !== 'none').map(page => page.dataset.diagPage);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const RUNNER_RESULTS = {
    version: { extension: '3.6.101', plugin: '3.3.5' },
    timestamp: '2026-11-10T12:00:00.000Z',
    categories: {
        infrastructure: [{ name: 'Qdrant', status: 'pass', message: 'Connected' }, { name: 'Plugin <img src=x>', status: 'warning', message: 'Old <script>' }],
        configuration: [{ name: 'Threshold', status: 'pass', message: 'Set' }],
        visualizer: [],
        production: [{ name: 'Embedding', status: 'pass', message: 'Ran' }],
    },
};

async function closeDialog() {
    for (const dialog of host.dialogs.splice(0)) {
        dialog.root.remove();
        dialog.resolve();
    }
    await settle();
}

beforeEach(async () => {
    await closeDialog();
    vi.stubGlobal('$', $);
    vi.clearAllMocks();
    host.root.vectfox = { vector_backend: 'qdrant', qdrant_mode: 'local', qdrant_url: 'http://qdrant:6333', embedding_provider: 'openrouter', openrouter_model: 'baai/bge-m3', query: 2, score_threshold: 0, eventbase_score_threshold: 0 };
    host.runner = structuredClone(RUNNER_RESULTS);
    host.metrics = {
        uptimeFormatted: '2h 3m',
        totalQueries: 40, totalInserts: 12, totalErrors: 1,
        activeBackends: ['qdrant'],
        backends: [{ name: 'qdrant', healthy: true, queries: 30, inserts: 10, deletes: 2, errors: 1, avgLatency: 120, minLatency: 40, maxLatency: 900, healthChecksPassed: 5, healthChecksFailed: 0, lastHealthCheck: Date.now(), lastError: { timestamp: Date.now(), message: '<i>timeout</i>' } }],
    };
    document.body.innerHTML = '';
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the Diagnostics dialog', () => {
    it('opens on the page asked, switches pages from its top bar, and a second open shows that page', async () => {
        void openDiagnostics('query');
        expect(shownPage()).toEqual(['query']);
        $id('vectfox_diag_tab_checks').click();
        expect(shownPage()).toEqual(['checks']);
        expect($id('vectfox_diag_tab_checks').getAttribute('aria-current')).toBe('page');
        void openDiagnostics('health');
        expect(shownPage()).toEqual(['health']);
        expect(document.querySelectorAll('#vectfox_diagnostics')).toHaveLength(1);
    });

    it('runs the checks with Production tests only when switched on, and lists them by category with the console\'s errors', async () => {
        void openDiagnostics('checks');
        click('run');
        await vi.waitFor(() => expect(part('results').textContent).toContain('Results'));
        expect(runDiagnostics).toHaveBeenCalledWith(host.root.vectfox, false);
        const results = part('results').textContent;
        expect(results).toContain('Infrastructure');
        expect(results).toContain('Configuration');
        expect(results).not.toContain('Production tests');
        expect(results).toContain('Console');
        expect(results).toContain('a check broke <b>loudly</b>');
        expect(part('results').querySelector('img, script, b')).toBeNull();
        expect(part('versions').textContent).toContain('VectFox 3.6.101');
        expect(part('versions').textContent).toContain('Similharity 3.3.5');

        $id('vectfox_diag_production').checked = true;
        click('run');
        await vi.waitFor(() => expect(runDiagnostics).toHaveBeenCalledTimes(2));
        expect(runDiagnostics).toHaveBeenLastCalledWith(host.root.vectfox, true);
        await vi.waitFor(() => expect(part('results').textContent).toContain('Production tests'));
    });

    it('filters the results by status', async () => {
        void openDiagnostics('checks');
        click('run');
        await vi.waitFor(() => expect($id('vectfox_diag_filter')).not.toBeNull());
        const filter = $id('vectfox_diag_filter');
        filter.value = 'warning';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        const results = part('results').textContent;
        expect(results).toContain('Old <script>');
        expect(results).not.toContain('Connected');
    });

    it('copies a report that prints each threshold as stored, under its page\'s name', async () => {
        void openDiagnostics('checks');
        click('run');
        await vi.waitFor(() => expect(document.querySelector('[data-diag-action="copy"]').disabled).toBe(false));
        click('copy');
        await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
        const report = navigator.clipboard.writeText.mock.calls[0][0];
        expect(report).toMatch(/ChunkBase similarity threshold:\s+0\n/);
        expect(report).toMatch(/EventBase similarity threshold:\s+0\n/);
        expect(report).toMatch(/Model:\s+baai\/bge-m3/);
        expect(report).not.toContain('Score Threshold');
        expect(part('run-state').textContent).toBe('Report copied.');
    });

    it('probes the backend every 5 seconds while Backend health shows, and stops when it hides', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        void openDiagnostics('health');
        await vi.waitFor(() => expect(part('health').textContent).toContain('Backend: qdrant'));
        const health = part('health').textContent;
        expect(health).toContain('Queries: 30');
        expect(health).toContain('Slowest: 900 ms');
        expect(health).toContain('<i>timeout</i>');
        expect(part('health').querySelector('i:not(.fa-solid)')).toBeNull();
        expect(part('health-level').textContent).toBe('Backend errors');
        expect(part('uptime').textContent).toBe('Up 2h 3m');

        const probes = probeBackendHealth.mock.calls.length;
        vi.advanceTimersByTime(5000);
        expect(probeBackendHealth.mock.calls.length).toBe(probes + 1);
        $id('vectfox_diag_tab_checks').click();
        vi.advanceTimersByTime(15000);
        expect(probeBackendHealth.mock.calls.length).toBe(probes + 1);
    });

    it('shows what each retrieval would inject for a message, or why it has nothing', async () => {
        host.query = {
            eventBase: { injectionText: 'The harbor master keeps the ledger.', eventCount: 2, storyArc: { ruleName: 'last_time' } },
            chunkBase: { noCollections: true },
            lorebook: { disabled: true },
            eventBaseThreshold: 0,
        };
        void openDiagnostics('query');
        click('query');
        expect(part('query-state').textContent).toBe('Type a message first.');

        $id('vectfox_diag_query_message').value = 'Who keeps the ledger?';
        click('query');
        await vi.waitFor(() => expect(part('query-results').textContent).toContain('2 events'));
        const results = part('query-results');
        expect(results.textContent).toContain('StoryArc rule last_time');
        expect(results.querySelector('textarea').value).toBe('The harbor master keeps the ledger.');
        expect(results.querySelector('textarea').readOnly).toBe(true);
        expect(results.textContent).toContain('No ChunkBase collection is enabled.');
        expect(results.textContent).toContain('Lorebook retrieval is off on the WorldInfo page.');
    });
});

describe('the report and the results', () => {
    it('keep Production tests only when they ran, and print a missing setting as not set', () => {
        const results = dialogResults(structuredClone(RUNNER_RESULTS), { includesProduction: false, consoleLogs: [] });
        expect(Object.keys(results.categories)).toEqual(['infrastructure', 'configuration']);
        expect(results.overall).toBe('warnings');
        expect(storedValue(undefined)).toBe('not set');
        expect(storedValue(0)).toBe('0');

        const report = diagnosticsReportText({ results, filter: 'warning', settingLines: [['Query depth', '2']], generatedAt: 'now' });
        expect(report).toContain('Filter: WARNINGS ONLY (1 of 3 checks)');
        expect(report).toContain('INFRASTRUCTURE  (1 of 2)');
        expect(report).not.toContain('CONFIGURATION');
    });
});
