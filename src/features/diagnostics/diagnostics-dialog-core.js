/**
 * Diagnostics' rules for its dialog (diagnostics-dialog.js), with no host imports: the checks a run shows and how
 * they count, the report Copy report writes, and what each of the Query Tester's three retrievals says.
 */

/** The check categories in the order they show, with their icons. */
export const CHECK_CATEGORIES = Object.freeze([
    { id: 'infrastructure', title: 'Infrastructure', icon: 'fa-server' },
    { id: 'configuration', title: 'Configuration', icon: 'fa-sliders' },
    { id: 'visualizer', title: 'Visualizer', icon: 'fa-eye' },
    { id: 'production', title: 'Production tests', icon: 'fa-vial' },
    { id: 'console', title: 'Console', icon: 'fa-terminal' },
]);

/** The filters the results offer: all of them, or one status. */
export const CHECK_FILTERS = Object.freeze([
    { id: 'all', text: 'All' },
    { id: 'pass', text: 'Passed' },
    { id: 'warning', text: 'Warnings' },
    { id: 'fail', text: 'Failed' },
]);

/** How many checks passed, warned and failed. */
export function statusCounts(checks) {
    const count = status => checks.filter(check => check.status === status).length;
    return { pass: count('pass'), warning: count('warning'), fail: count('fail') };
}

/** A run's verdict: issues when a check failed, warnings when one warned, else healthy. */
export function overallOf(checks) {
    const counts = statusCounts(checks);
    if (counts.fail > 0) return 'issues';
    return counts.warning > 0 ? 'warnings' : 'healthy';
}

/** The checks a filter shows. */
export function checksShown(checks, filter) {
    return filter === 'all' ? checks : checks.filter(check => check.status === filter);
}

/** The console errors and warnings a run caught, as checks of their own: an error fails, a warning warns. */
export function consoleChecks(consoleLogs) {
    return consoleLogs.map(entry => ({
        name: `Console ${entry.type}`,
        status: entry.type === 'error' ? 'fail' : 'warning',
        message: entry.message.length > 200 ? `${entry.message.slice(0, 200)}...` : entry.message,
        category: 'console',
    }));
}

/**
 * The run as the dialog shows it: the runner's categories, Production tests only when they ran, and the console
 * messages caught during it.
 *
 * @param {object} runnerResults - runDiagnostics' result
 * @param {{includesProduction: boolean, consoleLogs: object[]}} run
 * @returns {{version: object, categories: Record<string, object[]>, checks: object[], overall: string, timestamp: string, consoleErrors: object[]}}
 */
export function dialogResults(runnerResults, { includesProduction, consoleLogs }) {
    const categories = {};
    for (const { id } of CHECK_CATEGORIES) {
        if (id === 'console' || (id === 'production' && !includesProduction)) continue;
        const checks = runnerResults.categories?.[id] ?? [];
        if (checks.length) categories[id] = checks;
    }
    if (consoleLogs.length) categories.console = consoleChecks(consoleLogs);
    const checks = Object.values(categories).flat();
    return { version: runnerResults.version, categories, checks, overall: overallOf(checks), timestamp: runnerResults.timestamp, consoleErrors: consoleLogs };
}

const RULE = '━'.repeat(64);
const STATUS_SYMBOLS = { pass: '✓', warning: '⚠', fail: '✗', skipped: '○' };
const FILTER_NAMES = { pass: 'PASSED ONLY', warning: 'WARNINGS ONLY', fail: 'FAILURES ONLY' };

function section(title) {
    return `${RULE}\n${title}\n${RULE}\n\n`;
}

/**
 * The report Copy report writes: the versions, the settings that matter, the counts, then each category's checks under
 * the filter shown.
 *
 * @param {{results: object, filter: string, settingLines: [string, string][], generatedAt: string}} report
 * @returns {string}
 */
export function diagnosticsReportText({ results, filter, settingLines, generatedAt }) {
    const isFiltered = filter !== 'all';
    const counts = statusCounts(results.checks);
    const total = counts.pass + counts.warning + counts.fail;
    const shownCount = checksShown(results.checks, filter).length;
    const marker = status => (filter === status ? ' ◀ showing' : '');
    const widest = Math.max(...settingLines.map(([label]) => label.length));

    let report = 'VectFox DIAGNOSTICS REPORT\n\n'
        + `Generated: ${generatedAt}\n`
        + `VectFox: ${results.version?.extension || 'Unknown'}\n`
        + `Similharity: ${results.version?.plugin || 'Not installed'}\n`
        + (isFiltered ? `Filter: ${FILTER_NAMES[filter]} (${shownCount} of ${total} checks)\n` : '')
        + '\n'
        + section('SETTINGS')
        + settingLines.map(([label, value]) => `  ${`${label}:`.padEnd(widest + 2)} ${value}`).join('\n') + '\n\n'
        + section('SUMMARY')
        + `  ✓ Passed:   ${String(counts.pass).padStart(3)}${marker('pass')}\n`
        + `  ⚠ Warnings: ${String(counts.warning).padStart(3)}${marker('warning')}\n`
        + `  ✗ Failed:   ${String(counts.fail).padStart(3)}${marker('fail')}\n`
        + `  Total:      ${String(total).padStart(3)}\n\n`;

    for (const { id, title } of CHECK_CATEGORIES) {
        const checks = results.categories[id];
        if (!checks) continue;
        const shown = checksShown(checks, filter);
        if (!shown.length) continue;
        const categoryCounts = statusCounts(checks);
        const stats = isFiltered ? `(${shown.length} of ${checks.length})` : `(✓${categoryCounts.pass} ⚠${categoryCounts.warning} ✗${categoryCounts.fail})`;
        report += section(`${title.toUpperCase()}  ${stats}`);
        report += shown.map(check => `  ${STATUS_SYMBOLS[check.status] || '?'} ${String(check.name).padEnd(28)} ${check.message}`).join('\n') + '\n\n';
    }

    if (results.consoleErrors?.length && (!isFiltered || filter === 'fail')) {
        report += section('CONSOLE ERRORS CAUGHT');
        for (const entry of results.consoleErrors) {
            report += `  [${entry.type.toUpperCase()}] ${entry.message}\n`;
            if (entry.stack) report += `           ${entry.stack.split('\n')[0]}\n`;
        }
        report += '\n';
    }
    return `${report}${RULE}\nEND OF REPORT\n`;
}

/**
 * A setting as the report prints it: the stored value, "not set" when there is none.
 * @param {unknown} value
 * @returns {string}
 */
export const storedValue = value => (value === undefined || value === null || value === '' ? 'not set' : String(value));

/**
 * What one of the Query Tester's retrievals shows: the text it would inject with a count, or why it has none.
 *
 * @param {'eventbase'|'chunkbase'|'lorebook'} kind
 * @param {object|null} result - The retrieval's dry run
 * @param {{eventBaseThreshold: number}} settings
 * @returns {{count: string, text: string, reason: string}} count and text when it found something, else reason
 */
export function queryOutcome(kind, result, { eventBaseThreshold }) {
    if (result?.injectionText) {
        const counted = {
            eventbase: `${result.eventCount ?? '?'} events`,
            chunkbase: `${result.chunkCount ?? '?'} chunks`,
            lorebook: `${result.entryCount ?? '?'} entries`,
        }[kind];
        return { count: counted, text: result.injectionText, reason: '' };
    }
    return { count: '', text: '', reason: noResultReason(kind, result, eventBaseThreshold) };
}

function noResultReason(kind, result, eventBaseThreshold) {
    if (kind === 'eventbase') {
        const searched = (result?.lockedCollectionsCount ?? 0) + (result?.archiveCollectionsCount ?? 0);
        if (searched === 0) return 'No EventBase collection is locked to this chat.';
        const lower = eventBaseThreshold > 0 ? ', or lower the Similarity threshold on the EventBase page' : '';
        return `Searched ${searched} collection(s) and no event matched. Try a more specific message${lower}.`;
    }
    if (kind === 'chunkbase') {
        if (result?.noCollections) return 'No ChunkBase collection is enabled.';
        if (result?.noActive) return 'No collection passed its activation filters.';
        if (result?.allDuplicates) return 'Every chunk found is already in the chat.';
        return 'No chunk matched the message.';
    }
    if (result?.disabled) return 'Lorebook retrieval is off on the WorldInfo page.';
    if (result?.noCollections) return 'No vectorized lorebook was found.';
    return 'No entry matched the message.';
}

/** StoryArc's rule for an EventBase result, as the Query Tester notes it; '' when StoryArc did not route it. */
export function storyArcNote(storyArc) {
    if (!storyArc) return '';
    const cut = storyArc.cutRuleName ? `, ${storyArc.cutRuleName}` : '';
    const shape = storyArc.shape ? ` (${storyArc.shape}${storyArc.subject ? `, subject ${storyArc.subject}` : ''})` : '';
    return `StoryArc rule ${storyArc.ruleName}${cut}${shape}`;
}
