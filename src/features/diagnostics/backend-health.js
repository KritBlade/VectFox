/**
 * ============================================================================
 * VectFox BACKEND HEALTH
 * ============================================================================
 * The vector backend's health as Diagnostics' Backend health page and the Action page's pill show it: a live probe,
 * then the backend's counts since VectFox loaded (queries, inserts, deletes, errors), its query latency, its health
 * checks and its last error, beside the totals over every backend.
 *
 * @author VectFox
 * ============================================================================
 */

import { getBackendMetrics, probeBackendHealth } from '../vector-backend/index.js';
import { extension_settings } from '../../sillytavern/settings.js';

/** The backend VectFox stores in now. */
function currentBackendName() {
    return extension_settings.vectfox?.vector_backend || 'standard';
}

/**
 * How long ago a time was, in the largest whole unit: "40s ago", "3m ago", "2h ago"; "Never" for no time.
 * @param {number|null|undefined} timestamp - In milliseconds
 * @param {number} [now]
 * @returns {string}
 */
export function timeAgo(timestamp, now = Date.now()) {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((now - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The backend's health: down when its last probe failed, errors once any of its calls failed, else healthy.
 * @returns {'healthy'|'errors'|'down'}
 */
function healthLevelOf(metrics) {
    if (!metrics?.healthy) return 'down';
    return metrics.errors > 0 ? 'errors' : 'healthy';
}

/** Each health level's words and status colour, on the pill and on the page. */
export const HEALTH_LEVELS = Object.freeze({
    healthy: { text: 'Backend healthy', status: 'success' },
    errors: { text: 'Backend errors', status: 'warning' },
    down: { text: 'Backend down', status: 'danger' },
});

const HEALTH_PILL_ID = 'VectFox_health_pill';

/** Probe the backend VectFox stores in now, so the numbers after it are live. */
export async function probeCurrentBackend() {
    await probeBackendHealth(currentBackendName(), extension_settings.vectfox);
}

/**
 * The current backend's numbers and the totals over every backend, as the Backend health page shows them.
 * @returns {object}
 */
export function backendHealthView() {
    const metrics = getBackendMetrics();
    const name = currentBackendName();
    const backend = metrics.backends.find(each => each.name === name) ?? {
        name, healthy: false, queries: 0, inserts: 0, deletes: 0, errors: 0, avgLatency: 0, minLatency: null, maxLatency: null,
    };
    return {
        name,
        level: healthLevelOf(backend),
        uptime: metrics.uptimeFormatted,
        queries: backend.queries,
        inserts: backend.inserts,
        deletes: backend.deletes,
        errors: backend.errors,
        averageLatency: backend.avgLatency || 0,
        fastestLatency: backend.minLatency,
        slowestLatency: backend.maxLatency,
        checksPassed: backend.healthChecksPassed || 0,
        checksFailed: backend.healthChecksFailed || 0,
        lastCheck: timeAgo(backend.lastHealthCheck),
        lastError: backend.lastError ? { when: timeAgo(backend.lastError.timestamp), message: String(backend.lastError.message) } : null,
        totalQueries: metrics.totalQueries,
        totalInserts: metrics.totalInserts,
        totalErrors: metrics.totalErrors,
        activeBackends: metrics.activeBackends,
    };
}

/**
 * The Action page header's health pill, hidden until the first probe answers (refreshHealthPill).
 * @returns {string} HTML for the pill
 */
export function getHealthPillHtml() {
    return `<span id="${HEALTH_PILL_ID}" class="vfx-pill is-neutral" style="display:none;"></span>`;
}

/**
 * Run a health probe and paint the health pill with its answer.
 */
export async function refreshHealthPill() {
    const pill = document.getElementById(HEALTH_PILL_ID);
    if (!pill) return;
    await probeCurrentBackend();
    const { text, status } = HEALTH_LEVELS[backendHealthView().level];
    pill.className = `vfx-pill is-${status}`;
    pill.textContent = text;
    pill.style.removeProperty('display');
}
