// features/diagnostics — health checks: the diagnostics runner with its infrastructure, configuration,
// visualizer and production checks, and the backend health pill and dashboard the settings panel shows.
//
// runDiagnostics loads the runner and its checks on its first call, so they stay out of startup: a broken check
// cannot stop VectFox from loading. Everything else here is a re-export. Code outside this folder imports the
// feature here, never its files (.dependency-cruiser.cjs).
export {
    getHealthModalHtml,
    getHealthPillHtml,
    initializeHealthDashboard,
    openHealthDashboard,
    refreshHealthPill,
} from './health-dashboard.js';

/**
 * Runs every diagnostic check (see diagnostics-runner.js), loading the runner on the first call.
 * @param {object} settings VectFox settings
 * @param {boolean} [includeProductionTests] Include integration/production tests
 * @returns {Promise<object>} Diagnostics results
 */
export async function runDiagnostics(settings, includeProductionTests) {
    const runner = await import('./diagnostics-runner.js');
    return runner.runDiagnostics(settings, includeProductionTests);
}
