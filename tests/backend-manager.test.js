/**
 * Backend Manager Unit Tests
 * Tests for metrics tracking and utility functions
 *
 * Note: Tests that require mocking backend classes are limited due to ESM module
 * constraints. The focus here is on the metrics tracking functionality which
 * doesn't require mocking backend implementations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock script.js to avoid browser-specific imports
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({
        'Content-Type': 'application/json',
    })),
}));

// Mock extension_settings
vi.mock('../../../../extensions.js', () => ({
    extension_settings: {
        VectFox: {
            vector_backend: 'standard',
        },
    },
}));

// Mock textgen-settings.js
vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: {},
    textgenerationwebui_settings: {
        server_urls: {},
    },
}));

// Mock openai.js
vi.mock('../../../../openai.js', () => ({
    oai_settings: {},
}));

// Mock secrets.js
vi.mock('../../../../secrets.js', () => ({
    secret_state: {},
}));

// Mock providers.js
vi.mock('../core/providers.js', () => ({
    getModelField: vi.fn(() => null),
}));

// Mock constants.js
vi.mock('../core/constants.js', () => ({
    VECTOR_LIST_LIMIT: 10000,
    // Reached via backends -> embedding-latency-warning -> retrieval-budget,
    // which derives its slow-embed log threshold from the retrieval budget.
    // All seven are required: retrieval-budget.js imports them by name, and a
    // mock factory that omits one makes the import throw.
    RETRIEVAL_TIMEOUT_DEFAULT_MS: 15000,
    RETRIEVAL_TIMEOUT_MIN_MS: 3000,
    RETRIEVAL_TIMEOUT_MAX_MS: 120000,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS: 30000,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS: 10000,
    AGENTIC_TIMEOUT_MIN_MS: 1000,
    AGENTIC_TIMEOUT_MAX_MS: 60000,
}));

// Import the module under test - only the functions we can test without backend mocks
import {
    resetBackendHealth,
    invalidateBackendHealth,
    getAvailableBackends,
    recordQuery,
    recordInsert,
    recordDelete,
    recordError,
    recordHealthCheck,
    getBackendMetrics,
} from '../backends/backend-manager.js';

// =============================================================================
// BACKEND MANAGER TESTS
// =============================================================================

describe('Backend Manager', () => {
    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();
        // Reset backend health between tests
        resetBackendHealth();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getAvailableBackends', () => {
        it('should return all registered backends', () => {
            const backends = getAvailableBackends();

            expect(backends).toContain('standard');
            expect(backends).toContain('qdrant');
            expect(backends).toHaveLength(2);
        });
    });

    describe('resetBackendHealth', () => {
        it('should reset specific backend without error', () => {
            // Should not throw
            expect(() => resetBackendHealth('standard')).not.toThrow();
        });

        it('should reset all backends without error', () => {
            // Should not throw
            expect(() => resetBackendHealth()).not.toThrow();
        });

        it('should normalize vectra alias to standard', () => {
            // Should not throw
            expect(() => resetBackendHealth('vectra')).not.toThrow();
        });
    });

    describe('invalidateBackendHealth', () => {
        it('should invalidate without error', () => {
            expect(() => invalidateBackendHealth('standard')).not.toThrow();
        });

        it('should accept error parameter', () => {
            expect(() => invalidateBackendHealth('standard', new Error('Test error'))).not.toThrow();
        });

        it('should accept string error', () => {
            expect(() => invalidateBackendHealth('standard', 'String error')).not.toThrow();
        });
    });
});

// =============================================================================
// METRICS TRACKING TESTS
// =============================================================================

describe('Backend Metrics Tracking', () => {
    // Note: Metrics state persists across tests in the same run,
    // so we test incremental changes rather than absolute values

    beforeEach(() => {
        // Reset backend health between tests
        resetBackendHealth();
    });

    describe('recordQuery', () => {
        it('should increment query count', () => {
            const beforeMetrics = getBackendMetrics();
            const beforeQueries = beforeMetrics.totalQueries;

            recordQuery('standard', 50);
            recordQuery('standard', 100);
            recordQuery('standard', 75);

            const afterMetrics = getBackendMetrics();
            expect(afterMetrics.totalQueries).toBe(beforeQueries + 3);
        });

        it('should track latency statistics', () => {
            // Use a unique backend name to get fresh metrics
            recordQuery('qdrant', 50);
            recordQuery('qdrant', 100);

            const metrics = getBackendMetrics();
            const qdrantMetrics = metrics.backends.find(b => b.name === 'qdrant');

            expect(qdrantMetrics).toBeDefined();
            expect(qdrantMetrics.avgLatency).toBeGreaterThan(0);
            expect(qdrantMetrics.minLatency).toBeLessThanOrEqual(50);
            expect(qdrantMetrics.maxLatency).toBeGreaterThanOrEqual(100);
        });

        it('should normalize vectra to standard', () => {
            const beforeMetrics = getBackendMetrics();
            const standardBefore = beforeMetrics.backends.find(b => b.name === 'standard');
            const queriesBefore = standardBefore?.queries || 0;

            recordQuery('vectra', 50);

            const afterMetrics = getBackendMetrics();
            const standardAfter = afterMetrics.backends.find(b => b.name === 'standard');

            expect(standardAfter.queries).toBe(queriesBefore + 1);
        });
    });

    describe('recordInsert', () => {
        it('should increment insert count', () => {
            const beforeMetrics = getBackendMetrics();
            const beforeInserts = beforeMetrics.totalInserts;

            recordInsert('standard', 10);
            recordInsert('standard', 5);

            const afterMetrics = getBackendMetrics();
            expect(afterMetrics.totalInserts).toBe(beforeInserts + 15);
        });

        it('should default to count of 1', () => {
            const beforeMetrics = getBackendMetrics();
            const beforeInserts = beforeMetrics.totalInserts;

            recordInsert('standard');

            const afterMetrics = getBackendMetrics();
            expect(afterMetrics.totalInserts).toBe(beforeInserts + 1);
        });
    });

    describe('recordDelete', () => {
        it('should increment delete count', () => {
            recordDelete('qdrant', 5);
            recordDelete('qdrant', 3);

            const metrics = getBackendMetrics();
            const qdrantMetrics = metrics.backends.find(b => b.name === 'qdrant');

            expect(qdrantMetrics).toBeDefined();
            expect(qdrantMetrics.deletes).toBeGreaterThanOrEqual(8);
        });
    });

    describe('recordError', () => {
        it('should record error with message', () => {
            const error = new Error('Connection failed');
            recordError('qdrant', error);

            const metrics = getBackendMetrics();
            const qdrantMetrics = metrics.backends.find(b => b.name === 'qdrant');

            expect(qdrantMetrics).toBeDefined();
            expect(qdrantMetrics.errors).toBeGreaterThanOrEqual(1);
            expect(qdrantMetrics.lastError.message).toBe('Connection failed');
            expect(qdrantMetrics.lastError.timestamp).toBeDefined();
        });

        it('should record string errors', () => {
            recordError('qdrant', 'Something went wrong');

            const metrics = getBackendMetrics();
            const qdrantMetrics = metrics.backends.find(b => b.name === 'qdrant');

            expect(qdrantMetrics.lastError.message).toBe('Something went wrong');
        });

        it('should track global last error', () => {
            recordError('standard', 'First error');
            recordError('qdrant', 'Second error');

            const metrics = getBackendMetrics();
            expect(metrics.lastError.message).toBe('Second error');
        });
    });

    describe('recordHealthCheck', () => {
        it('should record health check results', () => {
            const beforeMetrics = getBackendMetrics();
            const qdrantBefore = beforeMetrics.backends.find(b => b.name === 'qdrant');
            const passedBefore = qdrantBefore?.healthChecksPassed || 0;
            const failedBefore = qdrantBefore?.healthChecksFailed || 0;

            recordHealthCheck('qdrant', true);
            recordHealthCheck('qdrant', true);
            recordHealthCheck('qdrant', false);

            const afterMetrics = getBackendMetrics();
            const qdrantAfter = afterMetrics.backends.find(b => b.name === 'qdrant');

            expect(qdrantAfter.healthChecksPassed).toBe(passedBefore + 2);
            expect(qdrantAfter.healthChecksFailed).toBe(failedBefore + 1);
            expect(qdrantAfter.lastHealthCheck).toBeDefined();
        });
    });

    describe('getBackendMetrics', () => {
        it('should return complete metrics object', () => {
            const metrics = getBackendMetrics();

            expect(metrics).toHaveProperty('uptime');
            expect(metrics).toHaveProperty('uptimeFormatted');
            expect(metrics).toHaveProperty('totalQueries');
            expect(metrics).toHaveProperty('totalInserts');
            expect(metrics).toHaveProperty('totalErrors');
            expect(metrics).toHaveProperty('lastError');
            expect(metrics).toHaveProperty('backends');
            expect(metrics).toHaveProperty('activeBackends');
        });

        it('should format uptime correctly', () => {
            const metrics = getBackendMetrics();
            expect(metrics.uptimeFormatted).toMatch(/^\d+[hms]/);
        });

        it('should list active backends as array', () => {
            const metrics = getBackendMetrics();
            expect(Array.isArray(metrics.activeBackends)).toBe(true);
        });

        it('should return backends array with metrics data', () => {
            // Record some activity to ensure there's data
            recordQuery('standard', 100);

            const metrics = getBackendMetrics();
            expect(Array.isArray(metrics.backends)).toBe(true);

            const standardMetrics = metrics.backends.find(b => b.name === 'standard');
            if (standardMetrics) {
                expect(standardMetrics).toHaveProperty('queries');
                expect(standardMetrics).toHaveProperty('inserts');
                expect(standardMetrics).toHaveProperty('deletes');
                expect(standardMetrics).toHaveProperty('errors');
                expect(standardMetrics).toHaveProperty('avgLatency');
            }
        });
    });
});

