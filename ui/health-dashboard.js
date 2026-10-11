/**
 * ============================================================================
 * VEC-18: BACKEND HEALTH DASHBOARD
 * ============================================================================
 * Real-time monitoring dashboard for vector backend health and metrics.
 *
 * Features:
 * - Health status indicator
 * - Query latency statistics
 * - Operation counts (queries, inserts, deletes)
 * - Error tracking and display
 * - Auto-refresh with configurable interval
 *
 * @author VectFox
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getBackendMetrics, probeBackendHealth } from '../backends/backend-manager.js';
import { extension_settings } from '../../../../extensions.js';
import { isVectFoxEnabled } from '../core/feature-gate.js';

let refreshInterval = null;
let isModalOpen = false;

/**
 * Get the current backend name from settings
 * @returns {string} Current backend name
 */
function getCurrentBackend() {
    return extension_settings.vectfox?.vector_backend || 'standard';
}

/**
 * Format a timestamp as a relative time string
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Relative time string
 */
function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

/**
 * Get health status class for styling
 * @param {boolean} healthy - Health status
 * @param {number} errors - Error count
 * @returns {string} CSS class name
 */
function getHealthClass(healthy, errors = 0) {
    if (!healthy) return 'vectfox-health-error';
    if (errors > 0) return 'vectfox-health-warning';
    return 'vectfox-health-ok';
}

/**
 * Get health status icon
 * @param {boolean} healthy - Health status
 * @param {number} errors - Error count
 * @returns {string} Status icon
 */
function getHealthIcon(healthy, errors = 0) {
    if (!healthy) return '&#x2716;'; // X mark
    if (errors > 0) return '&#x26A0;'; // Warning
    return '&#x2714;'; // Check mark
}

/**
 * Render the health dashboard content
 * @returns {string} HTML content
 */
function renderDashboard() {
    const metrics = getBackendMetrics();
    const currentBackend = getCurrentBackend();

    // Find current backend metrics
    const currentMetrics = metrics.backends.find(b => b.name === currentBackend) || {
        name: currentBackend,
        healthy: false,
        queries: 0,
        inserts: 0,
        deletes: 0,
        errors: 0,
        avgLatency: 0,
        minLatency: null,
        maxLatency: null,
    };

    const healthClass = getHealthClass(currentMetrics.healthy, currentMetrics.errors);
    const healthIcon = getHealthIcon(currentMetrics.healthy, currentMetrics.errors);

    return `
        <div class="vectfox-health-dashboard">
            <!-- Summary Section -->
            <div class="vectfox-health-summary">
                <div class="vectfox-health-status ${healthClass}">
                    <span class="vectfox-health-icon">${healthIcon}</span>
                    <span class="vectfox-health-label">${currentMetrics.healthy ? 'Healthy' : 'Unhealthy'}</span>
                </div>
                <div class="vectfox-health-uptime">
                    <small>Uptime: ${metrics.uptimeFormatted}</small>
                </div>
            </div>

            <!-- Current Backend Section -->
            <div class="vectfox-health-section">
                <h4>Current Backend: ${currentBackend}</h4>
                <div class="vectfox-health-grid">
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.queries}</span>
                        <span class="vectfox-stat-label">Queries</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.inserts}</span>
                        <span class="vectfox-stat-label">Inserts</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.deletes}</span>
                        <span class="vectfox-stat-label">Deletes</span>
                    </div>
                    <div class="vectfox-health-stat ${currentMetrics.errors > 0 ? 'vectfox-stat-error' : ''}">
                        <span class="vectfox-stat-value">${currentMetrics.errors}</span>
                        <span class="vectfox-stat-label">Errors</span>
                    </div>
                </div>
            </div>

            <!-- Latency Section -->
            <div class="vectfox-health-section">
                <h4>Query Latency</h4>
                <div class="vectfox-health-grid">
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.avgLatency || 0}ms</span>
                        <span class="vectfox-stat-label">Average</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.minLatency !== null ? currentMetrics.minLatency + 'ms' : '-'}</span>
                        <span class="vectfox-stat-label">Min</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.maxLatency !== null ? currentMetrics.maxLatency + 'ms' : '-'}</span>
                        <span class="vectfox-stat-label">Max</span>
                    </div>
                </div>
            </div>

            <!-- Health Checks Section -->
            <div class="vectfox-health-section">
                <h4>Health Checks</h4>
                <div class="vectfox-health-grid">
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${currentMetrics.healthChecksPassed || 0}</span>
                        <span class="vectfox-stat-label">Passed</span>
                    </div>
                    <div class="vectfox-health-stat ${currentMetrics.healthChecksFailed > 0 ? 'vectfox-stat-error' : ''}">
                        <span class="vectfox-stat-value">${currentMetrics.healthChecksFailed || 0}</span>
                        <span class="vectfox-stat-label">Failed</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${formatRelativeTime(currentMetrics.lastHealthCheck)}</span>
                        <span class="vectfox-stat-label">Last Check</span>
                    </div>
                </div>
            </div>

            <!-- Last Error Section -->
            ${currentMetrics.lastError ? `
            <div class="vectfox-health-section vectfox-health-error-section">
                <h4>Last Error</h4>
                <div class="vectfox-health-error-box">
                    <span class="vectfox-error-time">${formatRelativeTime(currentMetrics.lastError.timestamp)}</span>
                    <span class="vectfox-error-message">${currentMetrics.lastError.message}</span>
                </div>
            </div>
            ` : ''}

            <!-- Global Stats Section -->
            <div class="vectfox-health-section">
                <h4>Global Statistics</h4>
                <div class="vectfox-health-grid">
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${metrics.totalQueries}</span>
                        <span class="vectfox-stat-label">Total Queries</span>
                    </div>
                    <div class="vectfox-health-stat">
                        <span class="vectfox-stat-value">${metrics.totalInserts}</span>
                        <span class="vectfox-stat-label">Total Inserts</span>
                    </div>
                    <div class="vectfox-health-stat ${metrics.totalErrors > 0 ? 'vectfox-stat-error' : ''}">
                        <span class="vectfox-stat-value">${metrics.totalErrors}</span>
                        <span class="vectfox-stat-label">Total Errors</span>
                    </div>
                </div>
            </div>

            <!-- Active Backends -->
            ${metrics.activeBackends.length > 0 ? `
            <div class="vectfox-health-section">
                <h4>Active Backends</h4>
                <div class="vectfox-active-backends">
                    ${metrics.activeBackends.map(name => `<span class="vectfox-backend-badge">${name}</span>`).join('')}
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

/**
 * Update the dashboard content — probes backend health first for a live reading
 */
async function updateDashboard() {
    const currentBackend = getCurrentBackend();
    const settings = extension_settings.vectfox;
    await probeBackendHealth(currentBackend, settings);
    const content = document.getElementById('VectFox_health_content');
    if (content && isModalOpen) {
        content.innerHTML = renderDashboard();
    }
}

/**
 * Start auto-refresh
 * @param {number} intervalMs - Refresh interval in milliseconds
 */
function startAutoRefresh(intervalMs = 5000) {
    stopAutoRefresh();
    refreshInterval = setInterval(updateDashboard, intervalMs);
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

/**
 * Open the health dashboard modal
 */
export function openHealthDashboard() {
    isModalOpen = true;
    const modal = document.getElementById('VectFox_health_modal');
    if (modal) {
        modal.style.display = 'flex';
        updateDashboard();
        startAutoRefresh(5000);
    }
}

/**
 * Close the health dashboard modal
 */
export function closeHealthDashboard() {
    isModalOpen = false;
    stopAutoRefresh();
    const modal = document.getElementById('VectFox_health_modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Get the health indicator HTML for the main UI
 * @returns {string} HTML for health indicator
 */
export function getHealthIndicatorHtml() {
    const metrics = getBackendMetrics();
    const currentBackend = getCurrentBackend();
    const currentMetrics = metrics.backends.find(b => b.name === currentBackend);

    const healthy = currentMetrics?.healthy ?? false;
    const errors = currentMetrics?.errors ?? 0;
    const healthClass = getHealthClass(healthy, errors);

    return `
        <button id="VectFox_health_indicator" class="vectfox-health-indicator ${healthClass}" title="Backend Health">
            <span class="vectfox-health-dot"></span>
        </button>
    `;
}

/**
 * Get the health modal HTML
 * @returns {string} HTML for health modal
 */
export function getHealthModalHtml() {
    return `
        <div id="VectFox_health_modal" class="vectfox-modal" style="display: none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-health-modal">
                <div class="vectfox-modal-header">
                    <h3>Backend Health Dashboard</h3>
                    <button class="vectfox-modal-close" id="VectFox_health_close">
                        <span>&times;</span>
                    </button>
                </div>
                <div class="vectfox-modal-body">
                    <div id="VectFox_health_content">
                        ${renderDashboard()}
                    </div>
                </div>
                <div class="vectfox-modal-footer">
                    <small>Auto-refreshes every 5 seconds</small>
                    <button id="VectFox_health_refresh" class="vectfox-btn-secondary">Refresh Now</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Run a health probe and refresh the indicator dot.
 */
export async function refreshIndicator() {
    const indicator = document.getElementById('VectFox_health_indicator');
    if (!indicator) return;
    const currentBackend = getCurrentBackend();
    await probeBackendHealth(currentBackend, extension_settings.vectfox);
    const metrics = getBackendMetrics();
    const currentMetrics = metrics.backends.find(b => b.name === currentBackend);
    const healthy = currentMetrics?.healthy ?? false;
    const errors = currentMetrics?.errors ?? 0;
    indicator.className = `vectfox-health-indicator ${getHealthClass(healthy, errors)}`;
}

/**
 * Initialize health dashboard event handlers
 */
export function initializeHealthDashboard() {
    // Health indicator click
    $(document).on('click', '#VectFox_health_indicator', openHealthDashboard);

    // Close button
    $(document).on('click', '#VectFox_health_close', closeHealthDashboard);

    // Overlay click
    $(document).on('click', '#VectFox_health_modal .vectfox-modal-overlay', closeHealthDashboard);

    // Refresh button
    $(document).on('click', '#VectFox_health_refresh', updateDashboard);

    // Probe when the VectFox panel drawer is expanded
    $(document).on('click', '#VectFox_settings .inline-drawer-toggle', function() {
        const isOpening = $(this).closest('.inline-drawer').find('.inline-drawer-content').is(':hidden')
            || $(this).find('.inline-drawer-icon').hasClass('down');
        if (isOpening) refreshIndicator();
    });

    // Probe immediately on init (Action tab is the default tab on load). Skipped while
    // VectFox is disabled: opening the panel probes on demand, and switching VectFox
    // back on refreshes the indicator.
    if (isVectFoxEnabled()) {
        refreshIndicator();
    }
}

/**
 * Get CSS styles for the health dashboard
 * @returns {string} CSS styles
 */
export function getHealthDashboardStyles() {
    return `
        /* Health Indicator */
        .vectfox-health-indicator {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            background: transparent;
            padding: 0;
        }

        .vectfox-health-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            transition: background-color 0.3s;
        }

        .vectfox-health-ok .vectfox-health-dot {
            background-color: #4caf50;
            box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
        }

        .vectfox-health-warning .vectfox-health-dot {
            background-color: #ff9800;
            box-shadow: 0 0 6px rgba(255, 152, 0, 0.5);
        }

        .vectfox-health-error .vectfox-health-dot {
            background-color: #f44336;
            box-shadow: 0 0 6px rgba(244, 67, 54, 0.5);
        }

        /* Health Dashboard Modal */
        .vectfox-health-modal {
            max-width: 500px;
        }

        .vectfox-health-dashboard {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .vectfox-health-summary {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
        }

        .vectfox-health-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 1.1em;
            font-weight: 600;
        }

        .vectfox-health-status.vectfox-health-ok {
            color: #4caf50;
        }

        .vectfox-health-status.vectfox-health-warning {
            color: #ff9800;
        }

        .vectfox-health-status.vectfox-health-error {
            color: #f44336;
        }

        .vectfox-health-icon {
            font-size: 1.2em;
        }

        .vectfox-health-section {
            padding: 12px;
            background: rgba(0,0,0,0.1);
            border-radius: 8px;
        }

        .vectfox-health-section h4 {
            margin: 0 0 12px 0;
            font-size: 0.9em;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .vectfox-health-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
            gap: 12px;
        }

        .vectfox-health-stat {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 8px;
            background: rgba(0,0,0,0.15);
            border-radius: 6px;
        }

        .vectfox-stat-value {
            font-size: 1.4em;
            font-weight: 600;
        }

        .vectfox-stat-label {
            font-size: 0.75em;
            opacity: 0.7;
            text-transform: uppercase;
        }

        .vectfox-stat-error .vectfox-stat-value {
            color: #f44336;
        }

        .vectfox-health-error-section {
            border-left: 3px solid #f44336;
        }

        .vectfox-health-error-box {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            background: rgba(244, 67, 54, 0.1);
            border-radius: 4px;
        }

        .vectfox-error-time {
            font-size: 0.8em;
            opacity: 0.7;
        }

        .vectfox-error-message {
            font-size: 0.9em;
            color: #f44336;
            word-break: break-word;
        }

        .vectfox-active-backends {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .vectfox-backend-badge {
            padding: 4px 10px;
            background: rgba(255,255,255,0.1);
            border-radius: 12px;
            font-size: 0.85em;
        }

        .vectfox-modal-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }

        .vectfox-modal-footer small {
            opacity: 0.6;
        }
    `;
}
