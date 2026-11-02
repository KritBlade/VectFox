/**
 * ============================================================================
 * BACKEND MANAGER
 * ============================================================================
 * Tiny dispatcher that routes vector operations to the selected backend.
 * Keeps the abstraction layer clean and focused.
 *
 * @author VectFox
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { extension_settings } from '../src/sillytavern/settings.js';
import { StandardBackend } from './standard.js';
import { QdrantBackend } from './qdrant.js';
import { log } from '../src/sillytavern/log.js';

// Backend registry - add new backends here
const BACKENDS = {
    standard: StandardBackend,
    qdrant: QdrantBackend,
};

// Backend name aliases (server uses 'vectra', we use 'standard')
const BACKEND_ALIASES = {
    vectra: 'standard',
};

/**
 * Normalize backend name (handles aliases like vectra -> standard)
 * @param {string} backendName - Backend name (may be an alias)
 * @returns {string} Normalized backend name
 */
function normalizeBackendName(backendName) {
    if (!backendName) return 'standard';
    const normalized = BACKEND_ALIASES[backendName] || backendName;
    return normalized;
}

// VEC-25: Multi-backend instance cache with memory leak prevention
const backendInstances = {};
const backendHealthStatus = {};
const backendAccessTimestamps = {}; // Track last access time for LRU eviction
const backendHealthTimestamps = {}; // VEC-33: Track when health was last verified
const MAX_CACHED_BACKENDS = 5; // Limit cache size to prevent unbounded growth
const HEALTH_CACHE_TTL_MS = 60000; // VEC-33: Health cache TTL (60 seconds)

// VEC-18: Backend metrics tracking for health dashboard
const backendMetrics = {
    // Per-backend metrics
    backends: {},
    // Global metrics
    totalQueries: 0,
    totalInserts: 0,
    totalErrors: 0,
    lastError: null,
    startTime: Date.now(),
};

/**
 * VEC-18: Initialize metrics for a backend
 * @param {string} backendName - Normalized backend name
 */
function initBackendMetrics(backendName) {
    if (!backendMetrics.backends[backendName]) {
        backendMetrics.backends[backendName] = {
            queries: 0,
            inserts: 0,
            deletes: 0,
            errors: 0,
            lastError: null,
            lastQueryTime: null,
            queryLatencies: [], // Rolling window of last 100 latencies
            avgLatency: 0,
            minLatency: null,
            maxLatency: null,
            lastHealthCheck: null,
            healthChecksPassed: 0,
            healthChecksFailed: 0,
        };
    }
}

/**
 * VEC-18: Record a query operation
 * @param {string} backendName - Backend name
 * @param {number} latencyMs - Query latency in milliseconds
 */
export function recordQuery(backendName, latencyMs) {
    const normalized = normalizeBackendName(backendName);
    initBackendMetrics(normalized);
    const metrics = backendMetrics.backends[normalized];

    metrics.queries++;
    backendMetrics.totalQueries++;
    metrics.lastQueryTime = Date.now();

    // Update latency stats (rolling window of 100)
    metrics.queryLatencies.push(latencyMs);
    if (metrics.queryLatencies.length > 100) {
        metrics.queryLatencies.shift();
    }

    // Calculate stats
    const latencies = metrics.queryLatencies;
    metrics.avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    metrics.minLatency = Math.min(...latencies);
    metrics.maxLatency = Math.max(...latencies);
}

/**
 * VEC-18: Record an insert operation
 * @param {string} backendName - Backend name
 * @param {number} itemCount - Number of items inserted
 */
export function recordInsert(backendName, itemCount = 1) {
    const normalized = normalizeBackendName(backendName);
    initBackendMetrics(normalized);
    backendMetrics.backends[normalized].inserts += itemCount;
    backendMetrics.totalInserts += itemCount;
}

/**
 * VEC-18: Record a delete operation
 * @param {string} backendName - Backend name
 * @param {number} itemCount - Number of items deleted
 */
export function recordDelete(backendName, itemCount = 1) {
    const normalized = normalizeBackendName(backendName);
    initBackendMetrics(normalized);
    backendMetrics.backends[normalized].deletes += itemCount;
}

/**
 * VEC-18: Record an error
 * @param {string} backendName - Backend name
 * @param {Error|string} error - Error that occurred
 */
export function recordError(backendName, error) {
    const normalized = normalizeBackendName(backendName);
    initBackendMetrics(normalized);
    const metrics = backendMetrics.backends[normalized];

    metrics.errors++;
    metrics.lastError = {
        message: error?.message || String(error),
        timestamp: Date.now(),
    };

    backendMetrics.totalErrors++;
    backendMetrics.lastError = metrics.lastError;
}

/**
 * VEC-18: Record health check result
 * @param {string} backendName - Backend name
 * @param {boolean} passed - Whether health check passed
 */
export function recordHealthCheck(backendName, passed) {
    const normalized = normalizeBackendName(backendName);
    initBackendMetrics(normalized);
    const metrics = backendMetrics.backends[normalized];

    metrics.lastHealthCheck = Date.now();
    if (passed) {
        metrics.healthChecksPassed++;
    } else {
        metrics.healthChecksFailed++;
    }
}

/**
 * VEC-18: Get all backend metrics for health dashboard
 * @returns {object} Complete metrics object
 */
export function getBackendMetrics() {
    const uptime = Date.now() - backendMetrics.startTime;

    return {
        uptime,
        uptimeFormatted: formatUptime(uptime),
        totalQueries: backendMetrics.totalQueries,
        totalInserts: backendMetrics.totalInserts,
        totalErrors: backendMetrics.totalErrors,
        lastError: backendMetrics.lastError,
        backends: Object.entries(backendMetrics.backends).map(([name, metrics]) => ({
            name,
            healthy: backendHealthStatus[name] === true,
            lastHealthCheck: metrics.lastHealthCheck,
            queries: metrics.queries,
            inserts: metrics.inserts,
            deletes: metrics.deletes,
            errors: metrics.errors,
            lastError: metrics.lastError,
            avgLatency: metrics.avgLatency,
            minLatency: metrics.minLatency,
            maxLatency: metrics.maxLatency,
            healthChecksPassed: metrics.healthChecksPassed,
            healthChecksFailed: metrics.healthChecksFailed,
        })),
        activeBackends: Object.keys(backendInstances),
    };
}

/**
 * VEC-18: Format uptime as human-readable string
 * @param {number} ms - Uptime in milliseconds
 * @returns {string} Formatted uptime
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * VEC-33: Check if health cache is stale (expired TTL)
 * @param {string} backendName - Normalized backend name
 * @returns {boolean} True if cache is stale or doesn't exist
 */
function isHealthCacheStale(backendName) {
    const healthTimestamp = backendHealthTimestamps[backendName];
    if (!healthTimestamp) return true;
    return (Date.now() - healthTimestamp) > HEALTH_CACHE_TTL_MS;
}

/**
 * Evict least recently used backend if cache is full
 */
function evictLRUBackendIfNeeded() {
    const cachedCount = Object.keys(backendInstances).length;
    if (cachedCount >= MAX_CACHED_BACKENDS) {
        // Find least recently used backend
        let oldestBackend = null;
        let oldestTime = Infinity;
        for (const [name, timestamp] of Object.entries(backendAccessTimestamps)) {
            if (timestamp < oldestTime) {
                oldestTime = timestamp;
                oldestBackend = name;
            }
        }
        if (oldestBackend) {
            log.lifecycle(`VectFox: Evicting LRU backend from cache: ${oldestBackend}`);
            delete backendInstances[oldestBackend];
            delete backendHealthStatus[oldestBackend];
            delete backendAccessTimestamps[oldestBackend];
            delete backendHealthTimestamps[oldestBackend]; // VEC-33
        }
    }
}

/**
 * Initialize a specific backend (caches instances for reuse)
 * @param {string} backendName - 'standard' or 'qdrant'
 * @param {object} settings - VectFox settings
 * @param {boolean} throwOnFail - Whether to throw on health check failure (default: true)
 * @returns {Promise<VectorBackend|null>} The backend instance or null if failed and throwOnFail=false
 */
export async function initializeBackend(backendName, settings, throwOnFail = true) {
    // Normalize backend name (vectra -> standard, etc.)
    const normalizedName = normalizeBackendName(backendName);

    // VEC-33: If already have a healthy instance, check if health cache is stale
    if (backendInstances[normalizedName] && backendHealthStatus[normalizedName]) {
        // If health cache is stale, re-verify health before returning
        if (isHealthCacheStale(normalizedName)) {
            log.lifecycle(`VectFox: Health cache stale for ${normalizedName}, re-verifying...`);
            try {
                const healthy = await backendInstances[normalizedName].healthCheck();
                recordHealthCheck(normalizedName, healthy); // VEC-18: Record health check
                if (healthy) {
                    backendHealthTimestamps[normalizedName] = Date.now();
                    backendAccessTimestamps[normalizedName] = Date.now();
                    return backendInstances[normalizedName];
                } else {
                    // Health check failed, invalidate cache
                    log.warn(`VectFox: Backend ${normalizedName} health re-check failed, invalidating cache`);
                    delete backendInstances[normalizedName];
                    backendHealthStatus[normalizedName] = false;
                    delete backendHealthTimestamps[normalizedName];
                }
            } catch (error) {
                log.warn(`VectFox: Backend ${normalizedName} health re-check error:`, error.message);
                recordHealthCheck(normalizedName, false); // VEC-18: Record failed health check
                recordError(normalizedName, error); // VEC-18: Record error
                delete backendInstances[normalizedName];
                backendHealthStatus[normalizedName] = false;
                delete backendHealthTimestamps[normalizedName];
            }
        } else {
            backendAccessTimestamps[normalizedName] = Date.now(); // Update access time
            return backendInstances[normalizedName];
        }
    }

    // VEC-25: Evict LRU backend if cache is full
    evictLRUBackendIfNeeded();

    // Get backend class
    const BackendClass = BACKENDS[normalizedName];
    if (!BackendClass) {
        if (throwOnFail) {
            throw new Error(`Unknown backend: ${backendName} (normalized: ${normalizedName}). Available: ${Object.keys(BACKENDS).join(', ')}`);
        }
        log.warn(`VectFox: Unknown backend: ${backendName}`);
        return null;
    }

    log.lifecycle(`VectFox: Initializing ${normalizedName} backend${backendName !== normalizedName ? ` (from alias: ${backendName})` : ''}...`);

    try {
        // Create and initialize new backend
        const backend = new BackendClass();
        await backend.initialize(settings);

        // Health check
        const healthy = await backend.healthCheck();
        recordHealthCheck(normalizedName, healthy); // VEC-18: Record health check result
        if (!healthy) {
            backendHealthStatus[normalizedName] = false;
            if (throwOnFail) {
                throw new Error(`Backend ${normalizedName} failed health check`);
            }
            log.warn(`VectFox: Backend ${normalizedName} failed health check, marking as unavailable`);
            return null;
        }

        // Cache the healthy instance
        backendInstances[normalizedName] = backend;
        backendHealthStatus[normalizedName] = true;
        backendAccessTimestamps[normalizedName] = Date.now(); // VEC-25: Track access time
        backendHealthTimestamps[normalizedName] = Date.now(); // VEC-33: Track health verification time

        log.lifecycle(`VectFox: Successfully initialized ${normalizedName} backend`);
        return backend;
    } catch (error) {
        backendHealthStatus[normalizedName] = false;
        recordHealthCheck(normalizedName, false); // VEC-18: Record failed health check
        recordError(normalizedName, error); // VEC-18: Record error
        if (throwOnFail) {
            throw error;
        }
        log.warn(`VectFox: Failed to initialize ${normalizedName} backend:`, error.message);
        return null;
    }
}

/**
 * Get a backend instance for operations
 * Uses the backend specified in settings
 * @param {object} settings - VectFox settings (may include .vector_backend override)
 * @param {string} [preferredBackend] - Optional specific backend to use (overrides settings)
 * @returns {Promise<VectorBackend>}
 */
export async function getBackend(settings, preferredBackend = null) {
    // Priority: explicit parameter > settings.vector_backend > global setting > 'standard'
    const backendName = preferredBackend
        || settings?.vector_backend
        || extension_settings.vectfox?.vector_backend
        || 'standard';

    // Try to get/initialize the requested backend - throw on failure
    const backend = await initializeBackend(backendName, settings, true);

    return backend;
}

/**
 * Get a backend for a specific collection (uses collection's stored backend)
 * @param {string} collectionBackend - The backend the collection was created with
 * @param {object} settings - VectFox settings
 * @returns {Promise<VectorBackend>}
 */
export async function getBackendForCollection(collectionBackend, settings) {
    if (!collectionBackend) {
        throw new Error('Collection backend not specified - this is a bug');
    }
    return getBackend(settings, collectionBackend);
}

/**
 * Check if a specific backend is available/healthy
 * @param {string} backendName - Backend to check
 * @param {object} settings - VectFox settings
 * @returns {Promise<boolean>}
 */
export async function isBackendAvailable(backendName, settings) {
    const normalizedName = normalizeBackendName(backendName);

    // If we already know it's unhealthy, return false without retrying
    if (backendHealthStatus[normalizedName] === false) {
        return false;
    }

    // If we have a healthy instance, return true
    if (backendInstances[normalizedName] && backendHealthStatus[normalizedName]) {
        return true;
    }

    // Try to initialize (don't throw on failure)
    const backend = await initializeBackend(backendName, settings, false);
    return backend !== null;
}

/**
 * Reset backend health status (allows retry after configuration changes)
 * @param {string} [backendName] - Specific backend to reset, or all if omitted
 */
export function resetBackendHealth(backendName = null) {
    if (backendName) {
        const normalizedName = normalizeBackendName(backendName);
        delete backendHealthStatus[normalizedName];
        delete backendInstances[normalizedName];
        delete backendHealthTimestamps[normalizedName]; // VEC-33
        log.lifecycle(`VectFox: Reset backend health status for ${normalizedName}${backendName !== normalizedName ? ` (alias: ${backendName})` : ''}`);
    } else {
        // Reset all
        for (const name of Object.keys(backendHealthStatus)) {
            delete backendHealthStatus[name];
            delete backendInstances[name];
            delete backendHealthTimestamps[name]; // VEC-33
        }
        log.lifecycle('VectFox: Reset backend health status for all backends');
    }
}

/**
 * VEC-33: Invalidate backend health on operation error
 * Called when a backend operation fails to ensure stale health status is cleared
 * @param {string} backendName - Backend that experienced an error
 * @param {Error|string} [error] - Optional error for logging
 */
export function invalidateBackendHealth(backendName, error = null) {
    const normalizedName = normalizeBackendName(backendName);

    // Only invalidate if we have a cached healthy status
    if (backendHealthStatus[normalizedName]) {
        backendHealthStatus[normalizedName] = false;
        delete backendHealthTimestamps[normalizedName];
        // Keep the instance but mark as unhealthy - next getBackend call will re-check
        log.warn(`VectFox: Invalidated health cache for ${normalizedName} due to operation error${error ? `: ${error.message || error}` : ''}`);
    }
}

/**
 * Actively probe the backend health and update backendHealthStatus.
 * Used by the health dashboard to get a real-time reading instead of relying on
 * cached operational state (which can be stale after invalidateBackendHealth calls).
 * @param {string} backendName - Backend to probe
 * @param {object} settings - VectFox settings
 * @returns {Promise<boolean>} true if healthy
 */
export async function probeBackendHealth(backendName, settings) {
    const normalizedName = normalizeBackendName(backendName);
    initBackendMetrics(normalizedName);

    if (backendInstances[normalizedName]) {
        try {
            const healthy = await backendInstances[normalizedName].healthCheck();
            recordHealthCheck(normalizedName, healthy);
            backendHealthStatus[normalizedName] = healthy;
            if (healthy) backendHealthTimestamps[normalizedName] = Date.now();
            return healthy;
        } catch (error) {
            recordHealthCheck(normalizedName, false);
            recordError(normalizedName, error);
            backendHealthStatus[normalizedName] = false;
            return false;
        }
    }

    // No cached instance — try to initialize (don't throw on failure)
    const backend = await initializeBackend(backendName, settings, false);
    return backend !== null;
}

