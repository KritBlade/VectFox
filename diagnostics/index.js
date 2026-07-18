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
    fixOrphanedMetadata,
    fixDuplicateHashes,
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
        // Plugin not available
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

/**
 * Gets a user-friendly fix suggestion for a failed check
 * @param {object} check Diagnostic check result
 * @returns {string} Fix suggestion
 */
export function getFixSuggestion(check) {
    switch (check.name) {
        case 'Embedding Provider':
            return 'Go to VectFox settings and select an embedding provider. For local setup, choose "Transformers" or "Ollama".';

        case 'API Key':
            return 'Go to SillyTavern Settings > API Connections and add your API key for the selected provider.';

        case 'API URL':
            return 'Go to SillyTavern Settings > API Connections and configure the server URL for your local embedding provider.';

        case 'Chat Vectors':
            return 'Click the "Vectorize All" button in VectFox settings to vectorize this chat.';

        case 'Settings Validation':
            return 'Review your VectFox settings and adjust the values within recommended ranges.';

        case 'Qdrant Backend':
            return 'Configure Qdrant settings in VectFox panel. For local: set host/port (default 127.0.0.1:6333). Start Qdrant: docker run -p 6333:6333 qdrant/qdrant. Note: Qdrant Cloud may have connectivity issues - local instance recommended.';

        case '[PROD] Chunk-Server Sync':
            return 'Click "Fix Now" to clean orphaned local metadata entries that no longer have corresponding vectors on the server.';

        case '[PROD] Duplicate Hash Check':
            return 'Click "Fix Now" to remove duplicate entries. Then re-vectorize the chat to restore clean data. Duplicates usually happen from the native ST vectors extension.';

        case 'Chat Metadata Integrity':
            return 'Start a new chat or send a message to generate a valid chat UUID. If this persists, the chat file may be corrupted.';

        case 'Condition Rule Validity':
            return 'Open the Chunk Editor and review the condition rules on affected chunks. Remove invalid operators or fix malformed values.';

        case 'WebLLM Extension':
            return 'Install the WebLLM extension from Extensions > Download Extensions, then paste: https://github.com/SillyTavern/Extension-WebLLM. Requires Chrome 113+ or Edge 113+ for WebGPU support.';

        default:
            return 'Check the console for more details.';
    }
}

/**
 * Execute a fix action for a diagnostic check
 * @param {object} check Diagnostic check result with fixAction
 * @returns {Promise<object>} Fix result
 */
export async function executeFixAction(check) {
    if (!check.fixable || !check.fixAction) {
        return { success: false, message: 'No fix available for this check' };
    }

    switch (check.fixAction) {
        case 'cleanOrphanedMetadata':
            if (check.data?.orphanedHashes) {
                return await fixOrphanedMetadata(check.data.orphanedHashes);
            }
            return { success: false, message: 'No orphaned hashes found in check data' };

        case 'removeDuplicateHashes':
            if (check.data?.duplicates && check.data?.collectionId) {
                // Need settings for the fix function - get from VectFox
                const { getVectFoxSettings } = await import('../ui/ui-settings.js');
                const settings = getVectFoxSettings();
                return await fixDuplicateHashes(check.data.duplicates, check.data.collectionId, settings);
            }
            return { success: false, message: 'No duplicate data found in check' };

        case 'install_webllm':
        case 'update_webllm': {
            // Open the third-party extension menu with WebLLM URL
            const { openThirdPartyExtensionMenu } = await import('../../../../extensions.js');
            openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
            return { success: true, message: 'Opening extension installer...' };
        }

        default:
            return { success: false, message: `Unknown fix action: ${check.fixAction}` };
    }
}
