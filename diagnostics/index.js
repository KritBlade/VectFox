/**
 * ============================================================================
 * VectFox DIAGNOSTICS - INDEX
 * ============================================================================
 * Main entry point for diagnostics system
 * Every potential failure point needs a check and fix here
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { log } from '../src/sillytavern/log.js';
import {
    checkVectorsExtension,
    checkBackendEndpoints,
    checkServerPlugin,
    checkPluginEndpoints,
    checkQdrantBackend,
    checkQdrantDimensionMatch,
    checkEmbeddingProvider,
    checkTransformersMemoryLimits,
    checkApiKeys,
    checkApiUrls,
    checkProviderConnectivity,
    checkWebLlmExtension
} from './infrastructure.js';

import {
    checkChatEnabled,
    checkChunkSize,
    checkScoreThreshold,
    checkInsertQueryCounts,
    checkChatVectors,
    checkConditionalActivationModule,
    checkCollectionIdFormat,
    checkHashCollisionRate,
    checkChatMetadataIntegrity,
    checkConditionRuleValidity,
    checkCollectionRegistryStatus,
    checkPromptContextConfig,
    checkPNGExportCapability
} from './configuration.js';

import {
    testEmbeddingGeneration,
    testVectorStorage,
    testVectorRetrieval,
    testVectorDimensions,
    testChunkServerSync,
    testDuplicateHashes,
    testPluginEmbeddingGeneration,
    testReciprocalRankFusion,
    testWeightedCombination,
    testKeywordExtraction,
    testKeywordBoosting,
    testLorebookKeywordExtraction,
    sweepLeftoverTestCollections
} from './production-tests.js';

import { testConditionalActivation } from './activation-tests.js';

import { runVisualizerTests } from './visualizer-tests.js';
import { cleanupTestCollections } from '../core/collection-loader.js';

/**
 * Runs all diagnostic checks
 * @param {object} settings VectFox settings
 * @param {boolean} includeProductionTests Include integration/production tests
 * @returns {Promise<object>} Diagnostics results
 */
export async function runDiagnostics(settings, includeProductionTests = false) {
    console.log('VectFox Diagnostics: Running health checks...');

    // Get version information
    let extensionVersion = 'Unknown';
    let pluginVersion = 'Not installed';

    // Try to get extension version from manifest.json
    try {
        // Derive manifest URL from this module's location so it works regardless of
        // the folder name the user installs the extension under (e.g. VectFox vs VectFox).
        const manifestUrl = new URL('../manifest.json', import.meta.url).href + `?_=${Date.now()}`;
        console.log('VectFox Diagnostics: Fetching manifest from:', manifestUrl);
        const manifestResponse = await fetch(manifestUrl);
        console.log('VectFox Diagnostics: Manifest response status:', manifestResponse.status);
        if (manifestResponse.ok) {
            const manifest = await manifestResponse.json();
            console.log('VectFox Diagnostics: Manifest data:', manifest);
            extensionVersion = manifest.version || 'Unknown';
            console.log('VectFox Diagnostics: Extension version:', extensionVersion);
        } else {
            console.warn('VectFox Diagnostics: Manifest fetch failed with status:', manifestResponse.status);
        }
    } catch (error) {
        console.error('VectFox Diagnostics: Could not fetch manifest.json', error);
    }

    // Try to get plugin version from health endpoint
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
            const data = await response.json();
            pluginVersion = data.version || 'Unknown';
        }
    } catch (error) {
        log.warn('VectFox: plugin version check failed:', error);
    }

    // Auto-clean any ghost test collections from the registry
    const testCollectionsCleaned = cleanupTestCollections();
    if (testCollectionsCleaned > 0) {
        console.log(`VectFox Diagnostics: Cleaned ${testCollectionsCleaned} ghost test collections from registry`);
    }

    const categories = {
        infrastructure: [],
        configuration: [],
        visualizer: [],
        production: []
    };

    // ========== INFRASTRUCTURE CHECKS ==========
    categories.infrastructure.push(await checkVectorsExtension());
    categories.infrastructure.push(await checkBackendEndpoints(settings));
    categories.infrastructure.push(await checkServerPlugin());
    categories.infrastructure.push(await checkPluginEndpoints());
    categories.infrastructure.push(await checkQdrantBackend(settings));
    categories.infrastructure.push(await checkQdrantDimensionMatch(settings));
    categories.infrastructure.push(await checkEmbeddingProvider(settings));

    // WASM memory warning for Transformers users
    const wasmCheck = checkTransformersMemoryLimits(settings);
    if (wasmCheck.status !== 'skipped') {
        categories.infrastructure.push(wasmCheck);
    }

    const apiKeyCheck = checkApiKeys(settings);
    if (apiKeyCheck.status !== 'skipped') {
        categories.infrastructure.push(apiKeyCheck);
    }

    const apiUrlCheck = checkApiUrls(settings);
    if (apiUrlCheck.status !== 'skipped') {
        categories.infrastructure.push(apiUrlCheck);
    }

    categories.infrastructure.push(await checkProviderConnectivity(settings));

    // WebLLM-specific check (only if WebLLM is selected)
    const webllmCheck = checkWebLlmExtension(settings);
    if (webllmCheck.status !== 'skipped') {
        categories.infrastructure.push(webllmCheck);
    }

    // ========== CONFIGURATION CHECKS ==========
    categories.configuration.push(checkChatEnabled(settings));
    categories.configuration.push(checkChunkSize(settings));
    categories.configuration.push(checkScoreThreshold(settings));
    categories.configuration.push(checkInsertQueryCounts(settings));
    categories.configuration.push(await checkChatVectors(settings));

    // Conditional activation checks
    categories.configuration.push(checkConditionalActivationModule());

    // Collection ID format check (UUID-based multitenancy)
    categories.configuration.push(checkCollectionIdFormat());

    // Hash collision rate (informational - collisions are intentional deduplication)
    categories.configuration.push(await checkHashCollisionRate(settings));

    // Chat metadata integrity (UUID-based collection tracking)
    categories.configuration.push(checkChatMetadataIntegrity());

    // Condition rule validity (validates chunk condition rules)
    categories.configuration.push(await checkConditionRuleValidity(settings));

    // Collection registry status (verifies collections are discoverable)
    categories.configuration.push(await checkCollectionRegistryStatus(settings));

    // Prompt context configuration
    categories.configuration.push(await checkPromptContextConfig(settings));

    // PNG export capability
    categories.configuration.push(checkPNGExportCapability());

    // ========== VISUALIZER CHECKS ==========
    // Fast checks always run, slow (API) checks only with production tests
    const visualizerResults = await runVisualizerTests(settings, includeProductionTests);
    categories.visualizer.push(...visualizerResults);

    // ========== PRODUCTION TESTS (Optional) ==========
    if (includeProductionTests) {
        categories.production.push(await testEmbeddingGeneration(settings));
        categories.production.push(await testVectorStorage(settings));
        categories.production.push(await testVectorRetrieval(settings));
        categories.production.push(await testVectorDimensions(settings));
        categories.production.push(await testChunkServerSync(settings));
        categories.production.push(await testDuplicateHashes(settings));
        // Plugin-specific embedding generation test (Qdrant)
        categories.production.push(await testPluginEmbeddingGeneration(settings));
        
        // Hybrid search tests
        categories.production.push(await testReciprocalRankFusion(settings));
        categories.production.push(await testWeightedCombination(settings));
        
        // Keyword system tests
        categories.production.push(await testKeywordExtraction(settings));
        categories.production.push(await testKeywordBoosting(settings));
        categories.production.push(await testLorebookKeywordExtraction(settings));
        
        // Conditional activation returns an array of individual test results
        const activationResults = await testConditionalActivation();
        categories.production.push(...activationResults);
    }

    // Always run last: drop any diagnostic probe collections (`vf_test_*`,
    // `VectFox_diag*`, `test`) created during this run by the infrastructure
    // checks or by tests that bailed without cleanup. Listed under infrastructure
    // so users see it whether or not production tests were enabled.
    categories.infrastructure.push(await sweepLeftoverTestCollections(settings));

    // Flatten all checks
    const allChecks = [
        ...categories.infrastructure,
        ...categories.configuration,
        ...categories.visualizer,
        ...categories.production
    ];

    // Determine overall status
    const failCount = allChecks.filter(c => c.status === 'fail').length;
    const warnCount = allChecks.filter(c => c.status === 'warning').length;

    const overall = failCount > 0 ? 'issues' : warnCount > 0 ? 'warnings' : 'healthy';

    const results = {
        version: {
            extension: extensionVersion,
            plugin: pluginVersion
        },
        categories,
        checks: allChecks,
        overall,
        timestamp: new Date().toISOString()
    };

    console.log('VectFox Diagnostics: Complete', results);
    console.log('VectFox Diagnostics: Version object:', results.version);
    console.log('VectFox Diagnostics: Extension version in results:', results.version.extension);
    console.log('VectFox Diagnostics: Plugin version in results:', results.version.plugin);

    return results;
}

