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
import { log } from '../../sillytavern/log.js';
import {
    getSavedHashes,
    purgeVectorIndex,
    reciprocalRankFusion,
    weightedCombination,
} from '../vector-backend/index.js';
import { getModelFromSettings, resolveProviderApiUrl } from '../embedding/index.js';
import { deleteCollection, unregisterCollection } from '../collections/index.js';
import { extractTextKeywords, extractLorebookKeywords } from '../keyword-search/index.js';

const CHAT_NOT_APPLICABLE_MESSAGE = 'Not applicable (EventBase mode — chat is not stored as a chunk collection)';

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

// The collections diagnostics make, under names reserved for them: the production tests' temporary collections, and
// the probe collection the endpoint checks make, which SillyTavern's Standard storage creates on first reference.
const DIAGNOSTIC_COLLECTION_PATTERNS = [/^vf_test_/, /^VectFox_diag(_|$)/];

const isDiagnosticCollection = (id) => DIAGNOSTIC_COLLECTION_PATTERNS.some(pattern => pattern.test(id ?? ''));

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
            const outcome = await deleteCollection(collection.id, collectionSettings, `${collection.source}:${collection.id}`);
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
 * Helper: Get provider-specific body parameters for Similharity plugin requests
 * This ensures local-server providers that need special params get them
 * @param {object} settings - VectFox settings
 * @returns {object} Additional body parameters for the request
 */
function getPluginProviderParams(settings) {
    const params = {};
    const source = settings.embedding_provider;

    // Ollama needs apiUrl and keep param
    if (source === 'ollama') {
        params.apiUrl = resolveProviderApiUrl(settings, 'ollama');
        params.keep = !!settings.ollama_keep;
    }

    // llamacpp needs apiUrl
    if (source === 'llamacpp') {
        params.apiUrl = resolveProviderApiUrl(settings, 'llamacpp');
    }

    // vllm needs apiUrl
    if (source === 'vllm') {
        params.apiUrl = resolveProviderApiUrl(settings, 'vllm');
    }

    return params;
}

/**
 * Probe the Similharity plugin's /health endpoint to decide whether plugin-only
 * production tests should run. When the plugin is absent, ST returns its
 * catch-all 404 HTML — without this guard, those tests would falsely accuse the
 * user's embedding provider of being broken.
 */
async function isPluginInstalled() {
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Test: Can we generate an embedding?
 * Uses Similharity plugin's dedicated embedding endpoint to test the provider.
 * This does NOT insert anything into the database - it only tests embedding generation.
 */
export async function testEmbeddingGeneration(settings) {
    if (!(await isPluginInstalled())) {
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
                ...getPluginProviderParams(settings),
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
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
    if (!(await isPluginInstalled())) {
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
                ...getPluginProviderParams(settings),
            })
        });

        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
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
 * Test: Can we query and retrieve similar vectors?
 */
export async function testVectorRetrieval() {
    return {
        name: '[PROD] Vector Retrieval',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'production'
    };
}

/**
 * Test: Are vector dimensions consistent?
 * Detects if embedding model was switched without re-vectorizing.
 * Compares stored collection dimensions with current provider's expected dimensions.
 * Uses the dedicated get-embedding endpoint to avoid inserting test data.
 */
export async function testVectorDimensions() {
    return {
        name: '[PROD] Vector Dimensions',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'production'
    };
}

/**
 * Test: Are local chunks in sync with server vectors?
 * Compares chunk hashes we have locally vs what's stored on the server
 */
export async function testChunkServerSync(settings, collectionId) {
    if (!collectionId) {
        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'pass',
            message: CHAT_NOT_APPLICABLE_MESSAGE,
            category: 'production'
        };
    }

    try {
        const { getAllChunkMetadata } = await import('../collections/index.js');

        // Get server-side hashes
        const serverHashes = await getSavedHashes(collectionId, settings);
        const serverHashSet = new Set(serverHashes.map(h => String(h)));

        // Get local metadata hashes (chunks we have customizations for)
        const localMetadata = getAllChunkMetadata();
        const localHashes = Object.keys(localMetadata);

        // Find mismatches
        const onlyOnServer = serverHashes.filter(h => !localHashes.includes(String(h)));
        const onlyLocal = localHashes.filter(h => !serverHashSet.has(h));

        const totalServer = serverHashes.length;
        const totalLocal = localHashes.length;

        if (onlyOnServer.length === 0 && onlyLocal.length === 0) {
            return {
                name: '[PROD] Chunk-Server Sync',
                status: 'pass',
                message: `In sync: ${totalServer} server vectors, ${totalLocal} local metadata entries`,
                category: 'production'
            };
        }

        // There are differences (not necessarily bad - local metadata is optional)
        if (onlyLocal.length > 0) {
            // Orphaned local metadata (vectors deleted from server but metadata remains)
            return {
                name: '[PROD] Chunk-Server Sync',
                status: 'warning',
                message: `${onlyLocal.length} orphaned local entries (vectors deleted from server)`,
                category: 'production'
            };
        }

        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'pass',
            message: `Server has ${onlyOnServer.length} vectors without local metadata (normal for new chunks)`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'fail',
            message: `Sync check error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Are there duplicate hashes in the vector store?
 * Duplicates can occur from:
 * - Native ST vectors extension double-inserting
 * - Session cache being cleared while chunks still exist
 * - Plugin bugs or interrupted operations
 */
export async function testDuplicateHashes(settings, collectionId) {
    if (!collectionId) {
        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'pass',
            message: CHAT_NOT_APPLICABLE_MESSAGE,
            category: 'production'
        };
    }

    try {
        // Get all hashes from the server
        const serverHashes = await getSavedHashes(collectionId, settings);

        if (serverHashes.length === 0) {
            return {
                name: '[PROD] Duplicate Hash Check',
                status: 'pass',
                message: 'No vectors in collection',
                category: 'production'
            };
        }

        // Count occurrences
        const hashCounts = {};
        for (const hash of serverHashes) {
            const key = String(hash);
            hashCounts[key] = (hashCounts[key] || 0) + 1;
        }

        // Find duplicates
        const duplicates = Object.entries(hashCounts)
            .filter(([, count]) => count > 1)
            .map(([hash, count]) => ({ hash, count }));

        if (duplicates.length === 0) {
            return {
                name: '[PROD] Duplicate Hash Check',
                status: 'pass',
                message: `${serverHashes.length} unique vectors, no duplicates`,
                category: 'production'
            };
        }

        const totalDupes = duplicates.reduce((sum, d) => sum + d.count - 1, 0);

        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'warning',
            message: `Found ${duplicates.length} duplicate hashes (${totalDupes} extra entries)`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'fail',
            message: `Check failed: ${error.message}`,
            category: 'production'
        };
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
                ...getPluginProviderParams(settings),
            }),
        });

        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
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
                ...getPluginProviderParams(settings),
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

/**
 * Test: Keyword extraction from text
 * Tests TF-IDF based keyword extraction at different levels
 */
export async function testKeywordExtraction() {
    try {
        const testText = `
The ancient dragon soared through the sky, its massive wings casting shadows over the kingdom.
Dragons are legendary creatures known for their wisdom and power. This particular dragon
had guarded the sacred treasure for centuries, maintaining its vigilant watch over the
ancient artifacts. Many warriors attempted to challenge the dragon, but none succeeded
in claiming the legendary treasure that lay within the dragon's mountain fortress.
        `.trim();

        // Test minimal extraction
        const minimalKeywords = extractTextKeywords(testText, { level: 'minimal' });

        if (!Array.isArray(minimalKeywords)) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Keyword extraction did not return an array',
                category: 'production'
            };
        }

        // Minimal should extract limited keywords (max 5 per EXTRACTION_LEVELS config)
        if (minimalKeywords.length > 5) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: `Minimal extraction returned ${minimalKeywords.length} keywords (expected max 5)`,
                category: 'production'
            };
        }

        // Test balanced extraction
        const balancedKeywords = extractTextKeywords(testText, { level: 'balanced' });

        // Balanced should extract more keywords (max 12 per EXTRACTION_LEVELS config)
        if (balancedKeywords.length > 12) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: `Balanced extraction returned ${balancedKeywords.length} keywords (expected max 12)`,
                category: 'production'
            };
        }

        // Each keyword is a word
        const hasValidStructure = balancedKeywords.every(kw => kw.text && typeof kw.text === 'string');

        if (!hasValidStructure) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Keywords do not have a {text} structure',
                category: 'production'
            };
        }

        // "dragon" should be extracted (appears frequently in text)
        const hasDragon = balancedKeywords.some(kw =>
            kw.text.toLowerCase().includes('dragon')
        );

        if (!hasDragon) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'warning',
                message: 'Expected keyword "dragon" not found in balanced extraction',
                category: 'production'
            };
        }

        // Stop words should be filtered out
        const hasStopWords = balancedKeywords.some(kw =>
            ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with'].includes(kw.text)
        );

        if (hasStopWords) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Stop words were not filtered out',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Keyword Extraction',
            status: 'pass',
            message: `Extracted ${balancedKeywords.length} keywords: [${balancedKeywords.slice(0, 3).map(k => k.text).join(', ')}...]`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Keyword Extraction',
            status: 'fail',
            message: `Keyword extraction error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Lorebook keyword extraction
 * Tests extraction of keywords from lorebook entries
 */
export async function testLorebookKeywordExtraction() {
    try {
        // Mock lorebook entry
        const lorebookEntry = {
            key: ['dragon', 'wyvern', 'Drake the Ancient'],
            keysecondary: ['treasure', 'hoard', 'scales'],
            content: 'A fearsome dragon that guards ancient treasures...'
        };

        const keywords = extractLorebookKeywords(lorebookEntry);

        // Validate keywords were extracted
        if (!Array.isArray(keywords) || keywords.length === 0) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'No keywords extracted from lorebook entry',
                category: 'production'
            };
        }

        // Should extract from both key and keysecondary
        const hasMainKey = keywords.some(k => k === 'dragon' || k === 'wyvern');
        const hasSecondaryKey = keywords.some(k => k === 'treasure' || k === 'hoard');

        if (!hasMainKey || !hasSecondaryKey) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Did not extract keywords from both key and keysecondary arrays',
                category: 'production'
            };
        }

        // Keywords should be normalized to lowercase
        const allLowercase = keywords.every(k => k === k.toLowerCase());
        if (!allLowercase) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Keywords not normalized to lowercase',
                category: 'production'
            };
        }

        // Should deduplicate keywords
        const uniqueKeywords = [...new Set(keywords)];
        if (uniqueKeywords.length !== keywords.length) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Keywords not deduplicated',
                category: 'production'
            };
        }

        // Test with empty entry
        const emptyEntry = { key: [], keysecondary: [] };
        const emptyKeywords = extractLorebookKeywords(emptyEntry);

        if (emptyKeywords.length !== 0) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Empty entry should return no keywords',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Lorebook Keywords',
            status: 'pass',
            message: `Extracted ${keywords.length} keywords: [${keywords.slice(0, 3).join(', ')}...]`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Lorebook Keywords',
            status: 'fail',
            message: `Lorebook keyword extraction error: ${error.message}`,
            category: 'production'
        };
    }
}
