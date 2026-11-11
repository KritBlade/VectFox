/**
 * ============================================================================
 * VectFox DIAGNOSTICS RUNNER
 * ============================================================================
 * Runs the infrastructure, configuration and visualizer checks, plus the
 * production tests when asked, and returns the results with the extension
 * and plugin versions
 *
 * @author Kritblade
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';
import { loadExtensionManifest } from '../../shared/extension-manifest.js';
import { getPluginProbe, refreshPluginProbe } from '../../shared/similharity-plugin.js';
import {
    checkVectorsExtension,
    checkBackendEndpoints,
    checkServerPlugin,
    checkPluginEndpoints,
    removeProbeCollection,
    checkQdrantBackend,
    checkEmbeddingProvider,
    checkTransformersMemoryLimits,
    checkApiKeys,
    checkApiUrls,
    checkProviderConnectivity
} from './infrastructure-checks.js';

import {
    checkChunkBaseSimilarityThreshold,
    checkInsertQueryCounts,
    checkChatVectors,
    checkConditionalActivationModule,
    checkCollectionIdFormat,
    checkHashCollisionRate,
    checkChatMetadataIntegrity,
    checkCollectionRegistryStatus,
    checkPromptContextConfig,
    checkPNGExportCapability
} from './configuration-checks.js';

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
    testLorebookKeywordExtraction,
    sweepLeftoverTestCollections,
    isDiagnosticCollection
} from './production-tests.js';

import { testConditionalActivation } from './activation-tests.js';

import { runVisualizerTests } from './visualizer-tests.js';
import { cleanupTestCollections } from '../collections/index.js';

/**
 * Runs all diagnostic checks
 * @param {object} settings VectFox settings
 * @param {boolean} includeProductionTests Include integration/production tests
 * @returns {Promise<object>} Diagnostics results
 */
export async function runDiagnostics(settings, includeProductionTests = false) {
    log.lifecycle('VectFox Diagnostics: Running health checks...');

    // The running VectFox's version, from its manifest.json.
    let extensionVersion = 'Unknown';
    try {
        extensionVersion = (await loadExtensionManifest()).version || 'Unknown';
    } catch (error) {
        log.error('VectFox Diagnostics: Could not read manifest.json', error);
    }

    // One fresh /health probe for the whole run: the plugin checks below and every other feature read it, so the run
    // sees the plugin as it is now, not as it was at startup.
    await refreshPluginProbe();
    const probe = getPluginProbe();
    const pluginVersion = probe.version ?? (probe.isFound ? 'Unknown' : 'Not installed');

    // Clear the registry and lock-index entries a diagnostic collection left behind
    const testCollectionsCleaned = cleanupTestCollections(isDiagnosticCollection);
    if (testCollectionsCleaned > 0) {
        log.lifecycle(`VectFox Diagnostics: Cleaned ${testCollectionsCleaned} ghost test collections from registry`);
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
    // The probes above are the only checks that touch the probe collection.
    categories.infrastructure.push(await removeProbeCollection());
    categories.infrastructure.push(await checkQdrantBackend(settings));
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


    // ========== CONFIGURATION CHECKS ==========
    categories.configuration.push(checkChunkBaseSimilarityThreshold(settings));
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
        categories.production.push(await testLorebookKeywordExtraction(settings));
        
        // Conditional activation returns an array of individual test results
        const activationResults = await testConditionalActivation();
        categories.production.push(...activationResults);
    }

    // Always run last: delete any diagnostic collection still left (`vf_test_*`,
    // `VectFox_diag*`): one a production test made and could not clean up, or a
    // probe collection whose removal failed, in this run or an earlier one. Listed
    // under infrastructure so users see it whether or not production tests ran.
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

    log.lifecycle('VectFox Diagnostics: Complete', results);
    log.trace('VectFox Diagnostics: Version object:', results.version);
    log.trace('VectFox Diagnostics: Extension version in results:', results.version.extension);
    log.trace('VectFox Diagnostics: Plugin version in results:', results.version.plugin);

    return results;
}

