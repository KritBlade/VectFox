/**
 * ============================================================================
 * VectFox DIAGNOSTICS - VISUALIZER TESTS
 * ============================================================================
 * Unit tests for chunk visualizer operations across all backends
 * Tests: delete, edit/re-vectorize, summary vectors, metadata operations
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { log } from '../src/sillytavern/log.js';
import {
    deleteVectorItems,
    insertVectorItems,
    getSavedHashes,
    purgeVectorIndex,
} from '../core/core-vector-api.js';
import {
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
} from '../core/collection-metadata.js';
import { unregisterCollection } from '../core/collection-loader.js';
import { getStringHash } from '../src/sillytavern/identifiers.js';

// Test collection prefix using VectFox vf_ format
// Format: vf_test_{type}_{sourceId}
const TEST_COLLECTION_PREFIX = 'vf_test_visualizer_';

/**
 * Full cleanup for test collections - purges vectors AND unregisters from registry
 * @param {string} collectionId - The test collection to clean up
 * @param {object} settings - VectFox settings
 */
async function cleanupTestCollection(collectionId, settings) {
    try {
        // Purge all vectors from the backend
        await purgeVectorIndex(collectionId, settings);
    } catch (e) {
        log.warn(`VectFox diagnostics: cleanup purge of ${collectionId} failed:`, e);
    }
    // Always unregister from registry to prevent ghost entries
    const registryKey = `${settings.embedding_provider}:${collectionId}`;
    unregisterCollection(registryKey);
    unregisterCollection(collectionId); // Also try without source prefix
}

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
 * Check: Metadata read/write operations
 */
export function checkMetadataOperations() {
    const testHash = `test_meta_${Date.now()}`;

    try {
        // Test save (uses new keyword format with multiplier weights)
        const testData = {
            enabled: true,
            importance: 150,
            keywords: [
                { text: 'test', weight: 1.0 },
                { text: 'visualizer', weight: 1.5 }
            ],
            testTimestamp: Date.now()
        };

        saveChunkMetadata(testHash, testData);

        // Test read
        const retrieved = getChunkMetadata(testHash);

        if (!retrieved) {
            // Cleanup attempt
            deleteChunkMetadata(testHash);
            return {
                name: 'Metadata Operations',
                status: 'fail',
                message: 'Failed to retrieve saved metadata',
                category: 'visualizer'
            };
        }

        if (retrieved.importance !== 150) {
            deleteChunkMetadata(testHash);
            return {
                name: 'Metadata Operations',
                status: 'fail',
                message: 'Retrieved metadata does not match saved data',
                category: 'visualizer'
            };
        }

        // Test delete
        deleteChunkMetadata(testHash);
        const afterDelete = getChunkMetadata(testHash);

        if (afterDelete && Object.keys(afterDelete).length > 0) {
            return {
                name: 'Metadata Operations',
                status: 'warning',
                message: 'Metadata delete may not have fully cleaned up',
                category: 'visualizer'
            };
        }

        return {
            name: 'Metadata Operations',
            status: 'pass',
            message: 'Save, read, and delete all working',
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup attempt
        try { deleteChunkMetadata(testHash); } catch (cleanupError) { log.warn('VectFox diagnostics: test metadata cleanup failed:', cleanupError); }
        return {
            name: 'Metadata Operations',
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
 * Tests: delete old → insert new → migrate metadata
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
        // Step 1: Insert original vector with metadata
        await insertVectorItems(testCollectionId, [{
            hash: originalHash,
            text: originalText
        }], settings);

        saveChunkMetadata(String(originalHash), {
            importance: 175,
            keywords: [
                { text: 'test', weight: 1.0 },
                { text: 'original', weight: 1.5 }
            ],
            testMarker: 'revec_test'
        });

        // Step 2: Simulate re-vectorization (delete old, insert new, migrate meta)
        await deleteVectorItems(testCollectionId, [originalHash], settings);
        await insertVectorItems(testCollectionId, [{
            hash: editedHash,
            text: editedText
        }], settings);

        // Migrate metadata
        const oldMeta = getChunkMetadata(String(originalHash)) || {};
        if (Object.keys(oldMeta).length > 0) {
            saveChunkMetadata(String(editedHash), oldMeta);
        }
        deleteChunkMetadata(String(originalHash));

        // Verify results
        const hashes = await getSavedHashes(testCollectionId, settings);
        // Convert to strings for comparison (hashes may be numbers or strings)
        const hashStrings = hashes.map(h => String(h));
        const hasOriginal = hashStrings.includes(String(originalHash));
        const hasEdited = hashStrings.includes(String(editedHash));

        // Check metadata migration BEFORE cleanup
        const migratedMeta = getChunkMetadata(String(editedHash));
        const metadataOk = migratedMeta && migratedMeta.importance === 175;

        // Cleanup - full collection cleanup
        deleteChunkMetadata(String(editedHash));
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

        if (!metadataOk) {
            return {
                name: 'Re-Vectorization',
                status: 'warning',
                message: 'Vectors updated but metadata migration may have issues',
                category: 'visualizer'
            };
        }

        return {
            name: 'Re-Vectorization',
            status: 'pass',
            message: 'Full workflow working: delete → insert → migrate metadata',
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup attempts
        deleteChunkMetadata(String(originalHash));
        deleteChunkMetadata(String(editedHash));
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
 * Check: Summary vector creation (dual-vector)
 */
export async function checkSummaryVectorCreate(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Summary Vector Create',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const parentText = `Parent chunk for summary test ${Date.now()}`;
    const summaryText = `Summary of the parent chunk ${Date.now()}`;
    const parentHash = getStringHash(parentText);
    const summaryHash = getStringHash(summaryText);

    try {
        // Insert parent chunk
        await insertVectorItems(testCollectionId, [{
            hash: parentHash,
            text: parentText
        }], settings);

        // Insert summary vector with parent link
        await insertVectorItems(testCollectionId, [{
            hash: summaryHash,
            text: summaryText
        }], settings);

        saveChunkMetadata(String(summaryHash), {
            isSummaryVector: true,
            parentHash: String(parentHash),
            summaryText: summaryText
        });

        // Verify both exist
        const hashes = await getSavedHashes(testCollectionId, settings);
        const hashStrings = hashes.map(h => String(h));
        const hasParent = hashStrings.includes(String(parentHash));
        const hasSummary = hashStrings.includes(String(summaryHash));

        // Check metadata BEFORE cleanup
        const summaryMeta = getChunkMetadata(String(summaryHash));
        const metadataOk = summaryMeta && summaryMeta.isSummaryVector && String(summaryMeta.parentHash) === String(parentHash);

        // Cleanup - full collection cleanup
        deleteChunkMetadata(String(summaryHash));
        await cleanupTestCollection(testCollectionId, settings);

        if (!hasParent || !hasSummary) {
            return {
                name: 'Summary Vector Create',
                status: 'fail',
                message: `Missing vectors - parent: ${hasParent}, summary: ${hasSummary}`,
                category: 'visualizer'
            };
        }

        if (!metadataOk) {
            return {
                name: 'Summary Vector Create',
                status: 'warning',
                message: 'Vectors created but metadata linkage may be incorrect',
                category: 'visualizer'
            };
        }

        return {
            name: 'Summary Vector Create',
            status: 'pass',
            message: 'Dual-vector summary created with proper parent linkage',
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup
        deleteChunkMetadata(String(summaryHash));
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }

        return {
            name: 'Summary Vector Create',
            status: 'fail',
            message: `Failed: ${error.message}`,
            category: 'visualizer'
        };
    }
}

/**
 * Check: Summary vector deletion
 */
export async function checkSummaryVectorDelete(settings) {
    if (!settings || !settings.embedding_provider) {
        return {
            name: 'Summary Vector Delete',
            status: 'skipped',
            message: 'No settings/source configured',
            category: 'visualizer'
        };
    }

    const testCollectionId = getTestCollectionId();
    const parentText = `Parent for summary delete test ${Date.now()}`;
    const summaryText = `Summary to delete ${Date.now()}`;
    const parentHash = getStringHash(parentText);
    const summaryHash = getStringHash(summaryText);

    try {
        // Setup: insert parent and summary
        await insertVectorItems(testCollectionId, [
            { hash: parentHash, text: parentText },
            { hash: summaryHash, text: summaryText }
        ], settings);

        saveChunkMetadata(String(summaryHash), {
            isSummaryVector: true,
            parentHash: String(parentHash)
        });

        // Delete only the summary
        await deleteVectorItems(testCollectionId, [summaryHash], settings);
        deleteChunkMetadata(String(summaryHash));

        // Verify parent still exists, summary is gone
        const hashes = await getSavedHashes(testCollectionId, settings);
        // Convert to strings for comparison (hashes may be numbers or strings)
        const hashStrings = hashes.map(h => String(h));
        const hasParent = hashStrings.includes(String(parentHash));
        const hasSummary = hashStrings.includes(String(summaryHash));

        // Cleanup - full collection cleanup
        await cleanupTestCollection(testCollectionId, settings);

        if (!hasParent) {
            return {
                name: 'Summary Vector Delete',
                status: 'fail',
                message: 'Parent chunk was accidentally deleted',
                category: 'visualizer'
            };
        }

        if (hasSummary) {
            return {
                name: 'Summary Vector Delete',
                status: 'fail',
                message: 'Summary vector still exists after delete',
                category: 'visualizer'
            };
        }

        return {
            name: 'Summary Vector Delete',
            status: 'pass',
            message: 'Summary deleted while parent preserved',
            category: 'visualizer'
        };
    } catch (error) {
        // Cleanup
        deleteChunkMetadata(String(summaryHash));
        try { await cleanupTestCollection(testCollectionId, settings); } catch (cleanupError) { log.warn('VectFox diagnostics: test collection cleanup failed:', cleanupError); }

        return {
            name: 'Summary Vector Delete',
            status: 'fail',
            message: `Failed: ${error.message}`,
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
    results.push(checkMetadataOperations());

    // Slow checks (make API calls to backend)
    if (includeSlowTests) {
        results.push(await checkVectorInsert(settings));
        results.push(await checkVectorDelete(settings));
        results.push(await checkReVectorization(settings));
        results.push(await checkSummaryVectorCreate(settings));
        results.push(await checkSummaryVectorDelete(settings));
        results.push(await checkBackendResponsiveness(settings));
    }

    return results;
}
