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
    insertVectorItems,
    getSavedHashes,
} from '../vector-backend/index.js';
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

        // Cleanup - delete the test vector AND unregister collection
        await cleanupTestCollection(testCollectionId, settings);

        return {
            name: 'Vector Insert',
            status: 'pass',
            message: `Successfully inserted and verified (backend: ${settings.vector_backend || 'standard'})`,
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup even on failure
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }
        return {
            name: 'Vector Insert',
            status: 'fail',
            message: `Insert failed: ${error.message}`,
            category: 'visualizer'
        };
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

        // Cleanup collection from registry
        await cleanupTestCollection(testCollectionId, settings);

        return {
            name: 'Vector Delete',
            status: 'pass',
            message: `Successfully deleted and verified (backend: ${settings.vector_backend || 'standard'})`,
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup even on failure
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }
        return {
            name: 'Vector Delete',
            status: 'fail',
            message: `Delete failed: ${error.message}`,
            category: 'visualizer'
        };
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

        // Cleanup - full collection cleanup
        await cleanupTestCollection(testCollectionId, settings);

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
        // Cleanup attempt
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }

        return {
            name: 'Re-Vectorization',
            status: 'fail',
            message: `Workflow failed: ${error.message}`,
            category: 'visualizer'
        };
    }
}

/**
 * Check: Backend API responsiveness
 * Tests how quickly the backend responds to basic operations
 */
export async function checkBackendResponsiveness(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Backend Responsiveness',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const testText = `Responsiveness test ${Date.now()}`;
    const testHash = getStringHash(testText);

    try {
        const startInsert = performance.now();
        await insertVectorItems(testCollectionId, [{
            hash: testHash,
            text: testText
        }], settings);
        const insertTime = performance.now() - startInsert;

        const startQuery = performance.now();
        await getSavedHashes(testCollectionId, settings);
        const queryTime = performance.now() - startQuery;

        const startDelete = performance.now();
        await deleteVectorItems(testCollectionId, [testHash], settings);
        const deleteTime = performance.now() - startDelete;

        const totalTime = insertTime + queryTime + deleteTime;
        const backend = settings.vector_backend || 'standard';

        // Thresholds (in ms)
        const WARNING_THRESHOLD = 5000;  // 5 seconds
        const FAIL_THRESHOLD = 15000;    // 15 seconds

        if (totalTime > FAIL_THRESHOLD) {
            return {
                name: 'Backend Responsiveness',
                status: 'fail',
                message: `Very slow (${(totalTime/1000).toFixed(1)}s) - check ${backend} backend`,
                category: 'visualizer'
            };
        }

        if (totalTime > WARNING_THRESHOLD) {
            return {
                name: 'Backend Responsiveness',
                status: 'warning',
                message: `Slow response (${(totalTime/1000).toFixed(1)}s) on ${backend}`,
                category: 'visualizer'
            };
        }

        // Cleanup collection from registry
        await cleanupTestCollection(testCollectionId, settings);

        return {
            name: 'Backend Responsiveness',
            status: 'pass',
            message: `${backend}: insert ${insertTime.toFixed(0)}ms, query ${queryTime.toFixed(0)}ms, delete ${deleteTime.toFixed(0)}ms`,
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup attempt
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }

        return {
            name: 'Backend Responsiveness',
            status: 'fail',
            message: `Backend error: ${error.message}`,
            category: 'visualizer'
        };
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
