/**
 * ============================================================================
 * VectFox DIAGNOSTICS - VISUALIZER TESTS
 * ============================================================================
 * Unit tests for chunk visualizer operations across all backends
 * Tests: insert, delete, edit/re-vectorize, backend responsiveness
 *
 * @author Kritblade
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';
import {
    deleteVectorItems,
    getBackend,
    insertVectorItems,
    getSavedHashes,
} from '../vector-backend/index.js';
import { embeddingProviderLabel, slowEmbeddingWarnMs } from '../embedding/index.js';
import { resolveRetrievalTimeoutMs } from '../../shared/retrieval-budget.js';
import { getStringHash } from '../../sillytavern/identifiers.js';
import { cleanupTestCollection } from './production-tests.js';

// Test collection prefix using VectFox vf_ format
// Format: vf_test_{type}_{sourceId}
const TEST_COLLECTION_PREFIX = 'vf_test_visualizer_';

/**
 * Generates a unique test collection ID
 * Uses vf_test_visualizer_{timestamp} format for proper identification
 * as a diagnostic test collection that should be cleaned up.
 */
function getTestCollectionId() {
    return `${TEST_COLLECTION_PREFIX}${Date.now()}`;
}

/**
 * Clean up a check's test collection (cleanupTestCollection) in the check's finally, so every outcome leaves none,
 * with a failure logged rather than thrown over the check's result.
 * @param {string} collectionId
 * @param {object} settings - VectFox settings
 */
async function cleanUpAfterCheck(collectionId, settings) {
    try {
        await cleanupTestCollection(collectionId, settings);
    } catch (error) {
        log.warn('VectFox diagnostics: test collection cleanup failed:', error);
    }
}

/**
 * Check: Visualizer settings validity
 */
export function checkVisualizerSettings(settings) {
    if (!settings) {
        return {
            name: 'Visualizer Settings',
            status: 'fail',
            message: 'No settings object available',
            category: 'visualizer'
        };
    }

    if (!settings.embedding_provider) {
        return {
            name: 'Visualizer Settings',
            status: 'fail',
            message: 'No embedding source configured - vector operations will fail',
            category: 'visualizer'
        };
    }

    const backend = settings.vector_backend || 'standard';
    const source = settings.embedding_provider;

    return {
        name: 'Visualizer Settings',
        status: 'pass',
        message: `Backend: ${backend}, Source: ${source}`,
        category: 'visualizer'
    };
}

/**
 * Check: Hash generation function
 */
export function checkHashGeneration() {
    try {
        const testText = 'VectFox visualizer test string';
        const hash1 = getStringHash(testText);
        const hash2 = getStringHash(testText);

        if (typeof hash1 !== 'number') {
            return {
                name: 'Hash Generation',
                status: 'fail',
                message: `getStringHash returned ${typeof hash1}, expected number`,
                category: 'visualizer'
            };
        }

        if (hash1 !== hash2) {
            return {
                name: 'Hash Generation',
                status: 'fail',
                message: 'Hash function not deterministic - same input produced different hashes',
                category: 'visualizer'
            };
        }

        // Test different inputs produce different hashes
        const hash3 = getStringHash('Different text');
        if (hash1 === hash3) {
            return {
                name: 'Hash Generation',
                status: 'warning',
                message: 'Hash collision detected on different inputs',
                category: 'visualizer'
            };
        }

        return {
            name: 'Hash Generation',
            status: 'pass',
            message: `Working correctly (test hash: ${hash1})`,
            category: 'visualizer'
        };
    } catch (error) {
        return {
            name: 'Hash Generation',
            status: 'fail',
            message: `Error: ${error.message}`,
            category: 'visualizer'
        };
    }
}

/**
 * Check: Vector insert capability
 */
export async function checkVectorInsert(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Vector Insert',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const testText = `VectFox visualizer insert test ${Date.now()}`;
    const testHash = getStringHash(testText);

    try {
        await insertVectorItems(testCollectionId, [{
            hash: testHash,
            text: testText
        }], settings);

        // Verify it was inserted
        const hashes = await getSavedHashes(testCollectionId, settings);
        // Convert to strings for comparison (hashes may be numbers or strings)
        const hashStrings = hashes.map(h => String(h));

        if (!hashStrings.includes(String(testHash))) {
            return {
                name: 'Vector Insert',
                status: 'fail',
                message: 'Insert succeeded but hash not found in collection',
                category: 'visualizer'
            };
        }

        return {
            name: 'Vector Insert',
            status: 'pass',
            message: `Successfully inserted and verified (backend: ${settings.vector_backend || 'standard'})`,
            category: 'visualizer'
        };
    } catch (error) {
        return {
            name: 'Vector Insert',
            status: 'fail',
            message: `Insert failed: ${error.message}`,
            category: 'visualizer'
        };
    } finally {
        await cleanUpAfterCheck(testCollectionId, settings);
    }
}

/**
 * Check: Vector delete capability
 */
export async function checkVectorDelete(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Vector Delete',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const testText = `VectFox visualizer delete test ${Date.now()}`;
    const testHash = getStringHash(testText);

    try {
        // First insert a test vector
        await insertVectorItems(testCollectionId, [{
            hash: testHash,
            text: testText
        }], settings);

        // Verify it exists
        let hashes = await getSavedHashes(testCollectionId, settings);
        // Convert to strings for comparison (hashes may be numbers or strings)
        let hashStrings = hashes.map(h => String(h));
        if (!hashStrings.includes(String(testHash))) {
            return {
                name: 'Vector Delete',
                status: 'fail',
                message: 'Could not set up test - insert did not work',
                category: 'visualizer'
            };
        }

        // Now delete it
        await deleteVectorItems(testCollectionId, [testHash], settings);

        // Verify it's gone
        hashes = await getSavedHashes(testCollectionId, settings);
        hashStrings = hashes.map(h => String(h));

        if (hashStrings.includes(String(testHash))) {
            return {
                name: 'Vector Delete',
                status: 'fail',
                message: 'Delete called but hash still exists in collection',
                category: 'visualizer'
            };
        }

        return {
            name: 'Vector Delete',
            status: 'pass',
            message: `Successfully deleted and verified (backend: ${settings.vector_backend || 'standard'})`,
            category: 'visualizer'
        };
    } catch (error) {
        return {
            name: 'Vector Delete',
            status: 'fail',
            message: `Delete failed: ${error.message}`,
            category: 'visualizer'
        };
    } finally {
        await cleanUpAfterCheck(testCollectionId, settings);
    }
}

/**
 * Check: Re-vectorization workflow (edit text)
 * Tests: delete old → insert new
 */
export async function checkReVectorization(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Re-Vectorization',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const originalText = `Original text for revectorization test ${Date.now()}`;
    const editedText = `Edited text for revectorization test ${Date.now()}`;
    const originalHash = getStringHash(originalText);
    const editedHash = getStringHash(editedText);

    try {
        // Step 1: Insert the original vector
        await insertVectorItems(testCollectionId, [{
            hash: originalHash,
            text: originalText
        }], settings);

        // Step 2: Re-vectorize: delete the old, insert the new
        await deleteVectorItems(testCollectionId, [originalHash], settings);
        await insertVectorItems(testCollectionId, [{
            hash: editedHash,
            text: editedText
        }], settings);

        // Verify results
        const hashes = await getSavedHashes(testCollectionId, settings);
        // Convert to strings for comparison (hashes may be numbers or strings)
        const hashStrings = hashes.map(h => String(h));
        const hasOriginal = hashStrings.includes(String(originalHash));
        const hasEdited = hashStrings.includes(String(editedHash));

        if (hasOriginal) {
            return {
                name: 'Re-Vectorization',
                status: 'fail',
                message: 'Original hash still exists after delete',
                category: 'visualizer'
            };
        }

        if (!hasEdited) {
            return {
                name: 'Re-Vectorization',
                status: 'fail',
                message: 'New hash not found after insert',
                category: 'visualizer'
            };
        }

        return {
            name: 'Re-Vectorization',
            status: 'pass',
            message: 'Full workflow working: delete → insert',
            category: 'visualizer'
        };
    } catch (error) {
        return {
            name: 'Re-Vectorization',
            status: 'fail',
            message: `Workflow failed: ${error.message}`,
            category: 'visualizer'
        };
    } finally {
        await cleanUpAfterCheck(testCollectionId, settings);
    }
}

/** Backend Responsiveness' database steps after the collection's setup, together slower than this, make a warning. */
const DATABASE_SLOW_MS = 5000;
/** Backend Responsiveness' database steps after the collection's setup, together slower than this, make a failure. */
const DATABASE_VERY_SLOW_MS = 15000;
/**
 * Backend Responsiveness' collection setup slower than this makes a warning, and never a failure: each collection
 * pays it once, before its first write. Qdrant makes a new collection's payload indexes one after another, 2.6 s in
 * all on Qdrant Cloud (GitHub issue #26) and about 13 s on a local Qdrant on Windows, at 0.4 s an index.
 */
const COLLECTION_SETUP_SLOW_MS = 15000;

/** Check statuses ranked, so the worse of two findings sets a check's status. */
const STATUS_RANK = { pass: 0, warning: 1, fail: 2 };

/** A duration as a check's message gives it: milliseconds under a second, seconds to one decimal from a second. */
function formatDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Backend Responsiveness' status and message from its timings. The embedding is judged as a query's embedding is
 * (warnIfEmbeddingSlow): a warning from slowEmbeddingWarnMs, two thirds of the retrieval timeout, and a failure over
 * the timeout, past which a retrieval goes without it. The collection's setup is judged against
 * COLLECTION_SETUP_SLOW_MS, and the database steps after it together against DATABASE_SLOW_MS and
 * DATABASE_VERY_SLOW_MS. Each slow part leads the message, named, and every step's time follows.
 *
 * @param {{embeddingMs: number, setupMs: number, laterSteps: {label: string, ms: number}[]}} timings - The database
 *   steps after the setup in the order they ran
 * @param {object} settings - VectFox settings
 * @returns {{status: string, message: string}}
 */
function judgeResponsiveness({ embeddingMs, setupMs, laterSteps }, settings) {
    const backendName = settings.vector_backend || 'standard';
    const retrievalTimeoutMs = resolveRetrievalTimeoutMs(settings);
    const laterStepsMs = laterSteps.reduce((sum, step) => sum + step.ms, 0);
    const slowestStep = laterSteps.reduce((slowest, step) => (step.ms > slowest.ms ? step : slowest));

    const findings = [];
    if (embeddingMs > retrievalTimeoutMs) {
        findings.push({ status: 'fail', text: `Embedding very slow, over the ${formatDuration(retrievalTimeoutMs)} retrieval timeout - check the embedding provider.` });
    } else if (embeddingMs >= slowEmbeddingWarnMs(settings)) {
        findings.push({ status: 'warning', text: `Embedding slow, near the ${formatDuration(retrievalTimeoutMs)} retrieval timeout.` });
    }
    if (setupMs > COLLECTION_SETUP_SLOW_MS) {
        findings.push({ status: 'warning', text: `${backendName} collection setup slow: a new collection's first write waits ${formatDuration(setupMs)}.` });
    }
    if (laterStepsMs > DATABASE_VERY_SLOW_MS) {
        findings.push({ status: 'fail', text: `${backendName} very slow (${formatDuration(laterStepsMs)} after its setup; slowest step: ${slowestStep.label}) - check the ${backendName} backend.` });
    } else if (laterStepsMs > DATABASE_SLOW_MS) {
        findings.push({ status: 'warning', text: `${backendName} slow (${formatDuration(laterStepsMs)} after its setup; slowest step: ${slowestStep.label}).` });
    }

    const status = findings.reduce((worst, finding) => (STATUS_RANK[finding.status] > STATUS_RANK[worst] ? finding.status : worst), 'pass');
    const stepTimes = [{ label: 'collection setup', ms: setupMs }, ...laterSteps].map(step => `${step.label} ${formatDuration(step.ms)}`).join(', ');
    const timings = `Embedding ${formatDuration(embeddingMs)} on ${embeddingProviderLabel(settings)}; ${backendName}: ${stepTimes}`;
    return { status, message: [...findings.map(finding => finding.text), timings].join(' ') };
}

/**
 * Check: how long the embedding provider and the vector database each take, timed apart, so a slow provider is not
 * reported as a slow database (GitHub issue #26). The test text is embedded once, and every write carries that
 * vector, so the database steps embed nothing: the test collection's setup with its first write, a write into it, the
 * hash listing and the delete. judgeResponsiveness judges the times, and a failure names the step it happened in. The
 * test collection is cleaned up on every outcome once a write has started. Skipped on Standard without the
 * Similharity plugin, where SillyTavern embeds the text inside its insert, so the embedding cannot be timed apart.
 */
export async function checkBackendResponsiveness(settings) {
    const result = (status, message) => ({ name: 'Backend Responsiveness', status, message, category: 'visualizer' });
    if (!settings || !settings.embedding_provider) {
        return result('skipped', 'No settings/source configured');
    }

    const backendName = settings.vector_backend || 'standard';
    const testCollectionId = getTestCollectionId();
    const firstText = `Responsiveness test ${Date.now()}`;
    const secondText = `${firstText}, second write`;
    const hashes = [getStringHash(firstText), getStringHash(secondText)];
    let currentStep = `${backendName} connection`;
    let hasStartedWriting = false;

    try {
        const backend = await getBackend(settings);

        currentStep = `Embedding on ${embeddingProviderLabel(settings)}`;
        const embeddingStarted = performance.now();
        const vector = await backend.embedQuery(firstText, settings);
        const embeddingMs = performance.now() - embeddingStarted;
        if (!vector) {
            return result('skipped', 'Needs the Similharity plugin: without it SillyTavern embeds the text inside its insert, so the embedding cannot be timed apart from the database');
        }

        const timeStep = async (label, step) => {
            currentStep = `${backendName} ${label}`;
            const stepStarted = performance.now();
            await step();
            return { label, ms: performance.now() - stepStarted };
        };
        hasStartedWriting = true;
        const setup = await timeStep('collection setup', () => insertVectorItems(testCollectionId, [{ hash: hashes[0], text: firstText, vector }], settings));
        const laterSteps = [
            await timeStep('write', () => insertVectorItems(testCollectionId, [{ hash: hashes[1], text: secondText, vector }], settings)),
            await timeStep('list', () => getSavedHashes(testCollectionId, settings)),
            await timeStep('delete', () => deleteVectorItems(testCollectionId, hashes, settings)),
        ];

        const { status, message } = judgeResponsiveness({ embeddingMs, setupMs: setup.ms, laterSteps }, settings);
        return result(status, message);
    } catch (error) {
        return result('fail', `${currentStep} failed: ${error.message}`);
    } finally {
        if (hasStartedWriting) await cleanUpAfterCheck(testCollectionId, settings);
    }
}

/**
 * Runs all visualizer diagnostic tests
 * @param {object} settings VectFox settings
 * @param {boolean} includeSlowTests Include tests that make API calls
 * @returns {Promise<object[]>} Array of test results
 */
export async function runVisualizerTests(settings, includeSlowTests = false) {
    const results = [];

    // Fast checks (no API calls)
    results.push(checkVisualizerSettings(settings));
    results.push(checkHashGeneration());

    // Slow checks (make API calls to backend)
    if (includeSlowTests) {
        results.push(await checkVectorInsert(settings));
        results.push(await checkVectorDelete(settings));
        results.push(await checkReVectorization(settings));
        results.push(await checkBackendResponsiveness(settings));
    }

    return results;
}
