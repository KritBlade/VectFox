/**
 * ============================================================================
 * VectFox DIAGNOSTICS - PRODUCTION TESTS
 * ============================================================================
 * Integration tests for embedding, storage, and retrieval
 *
 * @author Kritblade
 * ============================================================================
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
import { checkPluginAvailable } from '../../shared/similharity-plugin.js';
import { log } from '../../sillytavern/log.js';
import {
    purgeVectorIndex,
    reciprocalRankFusion,
    weightedCombination,
} from '../vector-backend/index.js';
import { embeddingProfileRequestFields, getModelFromSettings, resolveProviderApiUrl } from '../embedding/index.js';
import { deleteCollection, unregisterCollection } from '../collections/index.js';
import { buildRegistryKey, getRegistryBackend } from '../../shared/collection-ids.js';
import { readErrorBody } from '../../shared/server-error-text.js';

/**
 * Clean up a diagnostic test collection, as the production and visualizer tests do after each test: purge its vectors,
 * and unregister it under the "backend:collectionId" key the registry holds it by, even when the purge fails, so no
 * ghost entry stays in the registry.
 * @param {string} collectionId - The test collection to clean up
 * @param {object} settings - VectFox settings
 */
export async function cleanupTestCollection(collectionId, settings) {
    try {
        await purgeVectorIndex(collectionId, settings);
    } catch (e) {
        log.warn(`VectFox diagnostics: cleanup purge of ${collectionId} failed:`, e);
    }
    unregisterCollection(buildRegistryKey(collectionId, settings));
}

// The collections diagnostics make, under names reserved for them: the production tests' temporary collections, and
// the probe collection the endpoint checks make, which SillyTavern's Standard storage creates on first reference.
const DIAGNOSTIC_COLLECTION_PATTERNS = [/^vf_test_/, /^VectFox_diag(_|$)/];

/** Whether a bare collection ID is one diagnostics make, under the names reserved for them. */
export const isDiagnosticCollection = (id) => DIAGNOSTIC_COLLECTION_PATTERNS.some(pattern => pattern.test(id ?? ''));

/**
 * Delete the diagnostic collections still left after a run: a production test collection a run could not clean up,
 * and a probe collection whose removal failed. Each goes from the backend and the source folders that hold it, as the
 * Database Browser deletes, since a probe in Standard storage is not on the backend VectFox uses.
 *
 * @param {object} settings
 * @returns {Promise<{name: string, status: string, message: string, category: string}>}
 */
export async function sweepLeftoverTestCollections(settings) {
    const result = (status, message) => ({ name: 'Diagnostic Collection Sweep', status, message, category: 'infrastructure' });
    try {
        const response = await fetch('/api/plugins/similharity/collections', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (!response.ok) return result('pass', 'Could not list collections (skipping sweep)');
        const data = await response.json();
        const leftovers = (data.collections || []).filter(collection => isDiagnosticCollection(collection.id));

        const removed = [];
        const failed = [];
        for (const collection of leftovers) {
            const collectionSettings = {
                ...settings,
                vector_backend: collection.backend,
                _discoveredSources: [{ source: collection.source, models: collection.models || [] }],
            };
            const registryKey = buildRegistryKey(collection.id, getRegistryBackend(collection.backend));
            const outcome = await deleteCollection(collection.id, collectionSettings, registryKey);
            (outcome.success ? removed : failed).push(`${collection.id} (${collection.backend})`);
        }

        if (failed.length) return result('warning', `Could not remove: ${failed.join(', ')}`);
        return result('pass', removed.length === 0
            ? 'No leftover diagnostic collections found'
            : `Removed ${removed.length} leftover diagnostic collection(s): ${removed.join(', ')}`);
    } catch (error) {
        log.warn('VectFox diagnostics: the collection sweep failed:', error);
        return result('warning', `Sweep error: ${error.message}`);
    }
}

/**
 * Helper: Get provider-specific body parameters for Similharity plugin requests: a URL-based provider's server URL,
 * Ollama's Keep model in memory, and on a llama.cpp, KoboldCPP or Custom profile its key's ID.
 * @param {object} settings - VectFox settings
 * @returns {Promise<object>} Additional body parameters for the request
 * @throws {Error} With `code: 'invalid_model_config'`, when embedding runs on a profile that cannot be used
 */
async function getPluginProviderParams(settings) {
    const params = {};
    const source = settings.embedding_provider;

    // Ollama needs apiUrl and keep param
    if (source === 'ollama') {
        params.apiUrl = resolveProviderApiUrl(settings, 'ollama');
        params.keep = !!settings.ollama_keep;
    }

    // vllm needs apiUrl
    if (source === 'vllm') {
        params.apiUrl = resolveProviderApiUrl(settings, 'vllm');
    }

    return { ...params, ...(await embeddingProfileRequestFields(settings)) };
}

/**
 * Test: Can we generate an embedding?
 * Uses Similharity plugin's dedicated embedding endpoint to test the provider.
 * This does NOT insert anything into the database - it only tests embedding generation.
 */
export async function testEmbeddingGeneration(settings) {
    // Plugin-only: with no plugin, SillyTavern answers the plugin's routes with its 404 page, which would read as the
    // embedding provider failing.
    if (!(await checkPluginAvailable())) {
        return {
            name: '[PROD] Embedding Generation',
            status: 'skipped',
            message: 'Plugin not installed — skipping (test relies on plugin embedding endpoint)',
            category: 'production'
        };
    }
    try {
        const testText = 'This is a test message for embedding generation.';

        // Use the dedicated get-embedding endpoint which doesn't store anything
        const response = await fetch('/api/plugins/similharity/get-embedding', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: testText,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, keep, etc.)
                ...(await getPluginProviderParams(settings)),
            })
        });

        if (!response.ok) {
            const errorText = await readErrorBody(response);
            return {
                name: '[PROD] Embedding Generation',
                status: 'fail',
                message: `Failed to generate embedding: ${response.status} ${response.statusText} - ${errorText}`,
                category: 'production'
            };
        }

        const data = await response.json();

        // Verify we actually got an embedding back
        if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
            return {
                name: '[PROD] Embedding Generation',
                status: 'fail',
                message: 'Embedding endpoint returned invalid or empty embedding',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Embedding Generation',
            status: 'pass',
            message: `Successfully generated test embedding (${data.embedding.length} dimensions)`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Embedding Generation',
            status: 'fail',
            message: `Embedding generation error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Can we store and retrieve a vector?
 * Uses Similharity plugin to test the actual configured provider.
 * Creates a temporary test collection that is cleaned up after the test.
 */
export async function testVectorStorage(settings) {
    if (!(await checkPluginAvailable())) {
        return {
            name: '[PROD] Vector Storage',
            status: 'skipped',
            message: 'Plugin not installed — skipping (test relies on plugin chunks/insert endpoint)',
            category: 'production'
        };
    }
    const testCollectionId = `vf_test_storage_${Date.now()}`;
    try {
        const testHash = String(Math.floor(Math.random() * 1000000));
        const testText = 'VectFox storage test message';
        const backend = settings.vector_backend || 'standard';
        const backendType = backend === 'standard' ? 'vectra' : backend;

        const insertResponse = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendType,
                collectionId: testCollectionId,
                items: [{
                    hash: testHash,
                    text: testText,
                    index: 0
                }],
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, keep, etc.)
                ...(await getPluginProviderParams(settings)),
            })
        });

        if (!insertResponse.ok) {
            const errorText = await readErrorBody(insertResponse);
            return {
                name: '[PROD] Vector Storage',
                status: 'fail',
                message: `Failed to store vector: ${insertResponse.status} - ${errorText}`,
                category: 'production'
            };
        }

        return {
            name: '[PROD] Vector Storage',
            status: 'pass',
            message: 'Successfully stored and cleaned up test vector',
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Vector Storage',
            status: 'fail',
            message: `Storage test error: ${error.message}`,
            category: 'production'
        };
    } finally {
        // Always clean up the test collection, even if the test bailed early.
        await cleanupTestCollection(testCollectionId, settings);
    }
}

/**
 * Test: Does the plugin backend correctly generate embeddings during insert?
 * This specifically tests the Similharity plugin's Qdrant handlers.
 * These handlers MUST generate embeddings - they cannot rely on pre-provided vectors.
 * Creates a temporary test collection that is cleaned up after the test.
 */
export async function testPluginEmbeddingGeneration(settings) {
    const backend = settings.vector_backend || 'standard';

    // Only test for backends that go through the plugin
    if (backend === 'standard') {
        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'skipped',
            message: 'Standard backend uses native ST vectors',
            category: 'production'
        };
    }

    const testCollectionId = `vf_test_embed_${Date.now()}`;
    try {
        const testHash = String(Math.floor(Math.random() * 1000000));
        const testText = 'Plugin embedding generation test';

        // Try to insert WITHOUT providing a vector - the plugin must generate it
        const insertResponse = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backend,
                collectionId: testCollectionId,
                items: [{
                    hash: testHash,
                    text: testText,
                    index: 0
                    // NOTE: No vector provided - plugin must generate it
                }],
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, keep, etc.)
                ...(await getPluginProviderParams(settings)),
            }),
        });

        if (!insertResponse.ok) {
            const errorText = await readErrorBody(insertResponse);
            return {
                name: '[PROD] Plugin Embedding Gen',
                status: 'fail',
                message: `Plugin failed to generate embedding: ${insertResponse.status} - ${errorText}`,
                category: 'production'
            };
        }

        // Verify the vector was stored by querying
        const queryResponse = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backend,
                collectionId: testCollectionId,
                searchText: testText,
                topK: 1,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, keep, etc.)
                ...(await getPluginProviderParams(settings)),
            }),
        });

        let querySuccess = false;
        if (queryResponse.ok) {
            const results = await queryResponse.json();
            querySuccess = results.results?.length > 0 || results.hashes?.length > 0;
        }

        if (!querySuccess) {
            return {
                name: '[PROD] Plugin Embedding Gen',
                status: 'warning',
                message: 'Insert succeeded but could not verify vector retrieval',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'pass',
            message: `${backend} backend correctly generates embeddings`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'fail',
            message: `Test error: ${error.message}`,
            category: 'production'
        };
    } finally {
        // Always clean up the test collection, even if the test bailed early.
        await cleanupTestCollection(testCollectionId, settings);
    }
}

/**
 * Test: Reciprocal Rank Fusion (RRF) algorithm
 * Tests the core RRF fusion algorithm with known inputs
 */
export async function testReciprocalRankFusion() {
    try {
        // Mock vector results (high semantic similarity for "dragon")
        const vectorResults = [
            { hash: 'doc1', score: 0.95, text: 'The ancient dragon guarded the treasure' },
            { hash: 'doc2', score: 0.85, text: 'Dragons are mythical creatures' },
            { hash: 'doc3', score: 0.75, text: 'The warrior fought a dragon' },
        ];

        // Mock text/BM25 results (high keyword match for "treasure")
        const textResults = [
            { hash: 'doc1', bm25Score: 8.5, text: 'The ancient dragon guarded the treasure' },
            { hash: 'doc4', bm25Score: 7.2, text: 'Treasure hunters searched for gold' },
            { hash: 'doc5', bm25Score: 5.8, text: 'The treasure map was ancient' },
        ];

        // Apply RRF with k=60
        const fusedResults = reciprocalRankFusion([vectorResults, textResults], 60);

        // Validate results
        if (!Array.isArray(fusedResults) || fusedResults.length === 0) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'RRF returned no results',
                category: 'production'
            };
        }

        // doc1 should rank highest (appears in both lists at high ranks)
        if (fusedResults[0].result.hash !== 'doc1') {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: `Expected doc1 to rank first, got ${fusedResults[0].result.hash}`,
                category: 'production'
            };
        }

        // Verify all results have RRF scores
        const hasScores = fusedResults.every(r =>
            typeof r.rrfScore === 'number' &&
            r.rrfScore > 0 &&
            r.rrfScore <= 1.0
        );

        if (!hasScores) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'Not all results have valid RRF scores (0-1 range)',
                category: 'production'
            };
        }

        // Verify rank information is preserved
        const hasRanks = fusedResults[0].ranks &&
            (fusedResults[0].ranks.vector !== undefined || fusedResults[0].ranks.text !== undefined);

        if (!hasRanks) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'Rank information not preserved',
                category: 'production'
            };
        }

        return {
            name: '[PROD] RRF Fusion Algorithm',
            status: 'pass',
            message: `Fused ${fusedResults.length} results, top score: ${fusedResults[0].rrfScore.toFixed(3)}`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] RRF Fusion Algorithm',
            status: 'fail',
            message: `RRF test error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Weighted Linear Combination algorithm
 * Tests the weighted fusion algorithm with known inputs
 */
export async function testWeightedCombination() {
    try {
        // Mock vector results
        const vectorResults = [
            { hash: 'doc1', score: 0.95, text: 'The ancient dragon' },
            { hash: 'doc2', score: 0.85, text: 'Dragons are mythical' },
            { hash: 'doc3', score: 0.75, text: 'Warrior fought dragon' },
        ];

        // Mock text/BM25 results
        const textResults = [
            { hash: 'doc1', bm25Score: 8.5, text: 'The ancient dragon' },
            { hash: 'doc4', bm25Score: 7.2, text: 'Treasure hunters' },
            { hash: 'doc3', bm25Score: 6.0, text: 'Warrior fought dragon' },
        ];

        // Test with equal weights (0.5, 0.5)
        const fusedResults = weightedCombination(vectorResults, textResults, 0.5, 0.5);

        // Validate results
        if (!Array.isArray(fusedResults) || fusedResults.length === 0) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Weighted combination returned no results',
                category: 'production'
            };
        }

        // All results should have combined scores
        const hasScores = fusedResults.every(r =>
            typeof r.combinedScore === 'number' &&
            r.combinedScore >= 0 &&
            r.combinedScore <= 1.0
        );

        if (!hasScores) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Not all results have valid combined scores',
                category: 'production'
            };
        }

        // Results should be sorted by combined score
        const isSorted = fusedResults.every((r, i) =>
            i === 0 || fusedResults[i-1].combinedScore >= r.combinedScore
        );

        if (!isSorted) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Results not properly sorted by combined score',
                category: 'production'
            };
        }

        // Verify vector and text scores are preserved
        const hasComponentScores = fusedResults.every(r =>
            typeof r.vectorScore === 'number' && typeof r.textScore === 'number'
        );

        if (!hasComponentScores) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Component scores not preserved',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Weighted Combination',
            status: 'pass',
            message: `Combined ${fusedResults.length} results, top score: ${fusedResults[0].combinedScore.toFixed(3)}`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Weighted Combination',
            status: 'fail',
            message: `Weighted combination test error: ${error.message}`,
            category: 'production'
        };
    }
}
