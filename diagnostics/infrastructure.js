/**
 * ============================================================================
 * VectFox DIAGNOSTICS - INFRASTRUCTURE
 * ============================================================================
 * Backend, provider, and plugin availability checks
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { secret_state } from '../../../../secrets.js';
import {
    EMBEDDING_PROVIDERS,
    getValidProviderIds,
    isValidProvider,
    getProviderConfig,
    getModelField,
    getModelFromSettings,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    getUrlProviders,
    resolveProviderApiUrl
} from '../core/providers.js';

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
 * Check: ST Vectra backend (standard file-based vector storage)
 * This is the default backend - always available if ST is running
 */
export async function checkVectorsExtension() {
    try {
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: 'test',
                source: 'transformers'
            })
        });

        if (response.status === 404) {
            return {
                name: 'ST Vectra (Standard)',
                status: 'fail',
                message: 'ST vector API not available - check SillyTavern installation',
                fixable: false,
                category: 'infrastructure'
            };
        }

        return {
            name: 'ST Vectra (Standard)',
            status: 'pass',
            message: 'Standard file-based vector storage ready',
            category: 'infrastructure'
        };
    } catch (error) {
        return {
            name: 'ST Vectra (Standard)',
            status: 'fail',
            message: 'Cannot reach ST vector API',
            fixable: false,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: ST Vector API endpoints
 * Tests all /api/vector/* endpoints comprehensively
 * NOTE: Always uses 'transformers' source for this check because native ST
 * endpoints don't recognize VectFox's plugin-routed sources. VectFox uses
 * the Similharity plugin endpoints for actual operations, not these.
 */
export async function checkBackendEndpoints(settings) {
    const results = [];
    // Always use 'transformers' - native ST endpoints don't know custom sources
    // This check tests "do endpoints respond?" not "does my provider work?"
    const source = 'transformers';

    const endpoints = [
        { name: 'list', method: 'POST', url: '/api/vector/list', body: { collectionId: 'VectFox_diag', source } },
        { name: 'query', method: 'POST', url: '/api/vector/query', body: { collectionId: 'VectFox_diag', searchText: 'test', topK: 1, source } },
        { name: 'insert', method: 'POST', url: '/api/vector/insert', body: { collectionId: 'VectFox_diag', items: [], source } },
        { name: 'delete', method: 'POST', url: '/api/vector/delete', body: { collectionId: 'VectFox_diag', hashes: [], source } },
        { name: 'purge', method: 'POST', url: '/api/vector/purge', body: { collectionId: 'VectFox_diag_nonexistent' } },
    ];

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint.url, {
                method: endpoint.method,
                headers: getRequestHeaders(),
                body: JSON.stringify(endpoint.body),
            });

            if (response.status === 404) {
                results.push({ name: endpoint.name, ok: false, status: 404 });
            } else {
                results.push({ name: endpoint.name, ok: true, status: response.status });
            }
        } catch (error) {
            results.push({ name: endpoint.name, ok: false, error: error.message });
        }
    }

    const passed = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    const formatResults = results.map(r =>
        `${r.name} ${r.ok ? '✓' : `✗(${r.status || r.error})`}`
    ).join(', ');

    if (failed.length === 0) {
        return {
            name: 'ST Vector Endpoints',
            status: 'pass',
            message: `All ${passed.length} endpoints: ${formatResults}`,
            category: 'infrastructure',
        };
    } else if (passed.length > 0) {
        return {
            name: 'ST Vector Endpoints',
            status: 'warning',
            message: `${passed.length}/${results.length} working: ${formatResults}`,
            category: 'infrastructure',
        };
    } else {
        return {
            name: 'ST Vector Endpoints',
            status: 'fail',
            message: 'No ST vector endpoints available',
            category: 'infrastructure',
        };
    }
}

/**
 * Check: VectFox Server Plugin (similharity)
 * Provides advanced features: Qdrant, collection browser, full metadata
 */
export async function checkServerPlugin() {
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            return {
                name: 'VectFox Plugin',
                status: 'warning',
                message: 'Plugin not installed (optional - enables Qdrant, advanced features)',
                fixable: false,
                category: 'infrastructure'
            };
        }

        const data = await response.json();

        if (data.status !== 'ok') {
            return {
                name: 'VectFox Plugin',
                status: 'warning',
                message: `Plugin unhealthy: ${data.status}`,
                category: 'infrastructure'
            };
        }

        const features = data.features?.join(', ') || 'core';
        return {
            name: 'VectFox Plugin',
            status: 'pass',
            message: `v${data.version} - Features: ${features}`,
            category: 'infrastructure'
        };
    } catch (error) {
        return {
            name: 'VectFox Plugin',
            status: 'warning',
            message: 'Plugin not available (standard mode only)',
            category: 'infrastructure'
        };
    }
}

/**
 * Check: VectFox Plugin API Endpoints
 * Tests all plugin-provided endpoints for advanced functionality
 */
export async function checkPluginEndpoints() {
    const results = [];
    const testSource = 'transformers';

    // First check if plugin is available
    try {
        const healthResponse = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!healthResponse.ok) {
            return {
                name: 'Plugin API Endpoints',
                status: 'skipped',
                message: 'Plugin not installed - endpoints not available',
                category: 'infrastructure'
            };
        }
        results.push({ name: 'health', ok: true });
    } catch (error) {
        return {
            name: 'Plugin API Endpoints',
            status: 'skipped',
            message: 'Plugin not available',
            category: 'infrastructure'
        };
    }

    // Test each plugin endpoint (unified API)
    const pluginEndpoints = [
        { name: 'collections', method: 'GET', url: `/api/plugins/similharity/collections` },
        { name: 'sources', method: 'GET', url: '/api/plugins/similharity/sources' },
        { name: 'chunks/list', method: 'POST', url: '/api/plugins/similharity/chunks/list',
          body: { backend: 'vectra', collectionId: 'VectFox_diag', source: testSource, limit: 1 } },
        { name: 'chunks/query', method: 'POST', url: '/api/plugins/similharity/chunks/query',
          body: { backend: 'vectra', collectionId: 'VectFox_diag', searchText: 'test', topK: 1, source: testSource } },
        { name: 'backend/health', method: 'GET', url: '/api/plugins/similharity/backend/health/vectra' },
    ];

    for (const ep of pluginEndpoints) {
        try {
            const opts = {
                method: ep.method,
                headers: getRequestHeaders(),
            };
            if (ep.body) opts.body = JSON.stringify(ep.body);

            const response = await fetch(ep.url, opts);
            results.push({ name: ep.name, ok: response.status !== 404, status: response.status });
        } catch (error) {
            results.push({ name: ep.name, ok: false, error: error.message });
        }
    }

    const passed = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const summary = results.map(r => `${r.name}${r.ok ? '✓' : '✗'}`).join(', ');

    if (failed.length === 0) {
        return {
            name: 'Plugin API Endpoints',
            status: 'pass',
            message: `${passed.length} endpoints: ${summary}`,
            category: 'infrastructure'
        };
    } else if (passed.length > 0) {
        return {
            name: 'Plugin API Endpoints',
            status: 'warning',
            message: `${passed.length}/${results.length}: ${summary}`,
            category: 'infrastructure'
        };
    } else {
        return {
            name: 'Plugin API Endpoints',
            status: 'fail',
            message: `All failed: ${summary}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: Qdrant Backend (production-grade vector search)
 * Supports local Docker or Qdrant Cloud
 * Note: Qdrant Cloud may have CORS issues - use local instance for best results
 */
export async function checkQdrantBackend(settings) {
    const isCloud = settings.qdrant_use_cloud;
    const backendName = isCloud ? 'Qdrant (Cloud)' : 'Qdrant (Local)';

    if (settings.vector_backend !== 'qdrant') {
        return {
            name: 'Qdrant (Production)',
            status: 'skipped',
            message: `Not selected (using: ${settings.vector_backend || 'standard'})`,
            category: 'infrastructure'
        };
    }

    // Check configuration
    if (isCloud) {
        if (!settings.qdrant_url) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant Cloud URL not configured',
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
        // Post-2026-05-26: the Qdrant API key lives in ST's secret_state slot
        // 'api_key_qdrant' (custom slot, not surfaced in client-side
        // secret_state). We can't presence-check it from JS — let the plugin's
        // /backend/init/qdrant handler surface "auth failed" or similar if
        // the key is genuinely missing. Skipping the explicit check here.
    } else {
        if (!settings.qdrant_host || !settings.qdrant_port) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant local host/port not configured (default: 127.0.0.1:6333)',
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    }

    // First, try to initialize Qdrant with current settings
    try {
        const initConfig = {
            host: settings.qdrant_host || '127.0.0.1',
            port: settings.qdrant_port || 6333,
            url: isCloud ? settings.qdrant_url : null,
            // Plugin resolves the key server-side from secret_state slot
            // 'api_key_qdrant' (post-2026-05-26 migration). The transition-
            // fallback for users still on plaintext is handled in
            // backends/qdrant.js's normal init path, not here — diagnostics
            // run independently and shouldn't drag the legacy reader along.
            apiKey: null,
        };

        const initResponse = await fetch('/api/plugins/similharity/backend/init/qdrant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(initConfig)
        });

        if (!initResponse.ok) {
            const errorText = await initResponse.text();
            return {
                name: backendName,
                status: 'fail',
                message: `Qdrant init failed: ${errorText}`,
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `Qdrant init error: ${error.message}`,
            fixable: true,
            fixAction: 'configure_qdrant',
            category: 'infrastructure'
        };
    }

    // Then check health
    try {
        const healthResponse = await fetch('/api/plugins/similharity/backend/health/qdrant', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!healthResponse.ok) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant plugin health check failed',
                category: 'infrastructure',
                fixable: true,
                fixAction: 'configure_qdrant'
            };
        }

        const healthData = await healthResponse.json();

        if (healthData.healthy) {
            const target = isCloud ? settings.qdrant_url : `${settings.qdrant_host}:${settings.qdrant_port}`;
            return {
                name: backendName,
                status: 'pass',
                message: `Connected to ${target}`,
                category: 'infrastructure'
            };
        } else {
            const error = healthData.message || 'Connection failed';
            // Provide more helpful error messages
            let suggestion = '';
            if (error.includes('ECONNREFUSED')) {
                suggestion = isCloud
                    ? ' - Check URL and API key'
                    : ' - Is Qdrant running? Try: docker run -p 6333:6333 qdrant/qdrant';
            } else if (error.includes('401') || error.includes('403')) {
                suggestion = ' - Invalid API key';
            } else if (error.includes('CORS')) {
                suggestion = ' - CORS blocked (use local Qdrant instead of Cloud)';
            }
            return {
                name: backendName,
                status: 'fail',
                message: `Qdrant error: ${error}${suggestion}`,
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `Qdrant unavailable: ${error.message}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: Qdrant vector dimension matches current embedding model
 * This catches the common "Internal Server Error" when switching embedding models
 */
export async function checkQdrantDimensionMatch(settings) {
    if (settings.vector_backend !== 'qdrant') {
        return {
            name: 'Qdrant Dimensions',
            status: 'skipped',
            message: 'Not using Qdrant backend',
            category: 'infrastructure'
        };
    }

    try {
        // Get collection info from Qdrant
        const infoResponse = await fetch('/api/plugins/similharity/backend/qdrant/collection-info', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!infoResponse.ok) {
            // Qdrant not initialized - that's checked elsewhere
            return {
                name: 'Qdrant Dimensions',
                status: 'skipped',
                message: 'Qdrant not initialized',
                category: 'infrastructure'
            };
        }

        const info = await infoResponse.json();

        if (!info.exists) {
            return {
                name: 'Qdrant Dimensions',
                status: 'pass',
                message: 'No collection yet - will be created on first vectorization',
                category: 'infrastructure'
            };
        }

        // Get current embedding dimension by generating a test embedding
        const testResponse = await fetch('/api/plugins/similharity/get-embedding', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: 'test',
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
                // Include provider-specific params (apiUrl, keep, etc.)
                ...getPluginProviderParams(settings),
            })
        });

        if (!testResponse.ok) {
            return {
                name: 'Qdrant Dimensions',
                status: 'warning',
                message: 'Could not test embedding dimension - check embedding provider',
                category: 'infrastructure'
            };
        }

        const testData = await testResponse.json();
        const currentDimension = testData.embedding?.length || 0;

        if (currentDimension === 0) {
            return {
                name: 'Qdrant Dimensions',
                status: 'warning',
                message: 'Could not determine current embedding dimension',
                category: 'infrastructure'
            };
        }

        // Compare dimensions
        if (info.dimension !== currentDimension) {
            const sourceInfo = info.embeddingSources?.length > 0
                ? info.embeddingSources.join(', ')
                : 'unknown';
            const modelInfo = info.embeddingModels?.length > 0
                ? info.embeddingModels.join(', ')
                : '(not recorded)';

            return {
                name: 'Qdrant Dimensions',
                status: 'fail',
                message: `Dimension mismatch! Collection: ${info.dimension}-dim (source: ${sourceInfo}, model: ${modelInfo}). Current model: ${currentDimension}-dim.`,
                fixable: true,
                fixAction: 'fix_qdrant_dimension',
                category: 'infrastructure',
                data: {
                    collectionDimension: info.dimension,
                    currentDimension: currentDimension,
                    collectionSources: info.embeddingSources,
                    collectionModels: info.embeddingModels,
                    pointsCount: info.pointsCount,
                }
            };
        }

        return {
            name: 'Qdrant Dimensions',
            status: 'pass',
            message: `Dimensions match (${info.dimension}-dim, ${info.pointsCount} vectors)`,
            category: 'infrastructure'
        };

    } catch (error) {
        return {
            name: 'Qdrant Dimensions',
            status: 'warning',
            message: `Could not check dimensions: ${error.message}`,
            category: 'infrastructure'
        };
    }
}


/**
 * Check: Embedding provider is configured properly
 */
export async function checkEmbeddingProvider(settings) {
    const source = settings.embedding_provider;

    if (!source) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: 'No embedding provider selected',
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const config = getProviderConfig(source);
    if (!config) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `Unknown provider: ${source}`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const modelField = getModelField(source);
    if (config.requiresModel && modelField && !settings[modelField]) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `${config.name} selected but no model configured`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const modelInfo = modelField && settings[modelField] ? ` (${settings[modelField]})` : '';
    return {
        name: 'Embedding Provider',
        status: 'pass',
        message: `Using ${config.name}${modelInfo}`
    };
}

/**
 * Check: Transformers WASM memory limitations
 * WASM has a 4GB memory cap regardless of system RAM.
 * Large content vectorization can hit this limit and cause OOM errors.
 */
export function checkTransformersMemoryLimits(settings) {
    // Only relevant for transformers provider
    if (settings.embedding_provider !== 'transformers') {
        return {
            name: 'WASM Memory',
            status: 'skipped',
            message: 'Not using local Transformers'
        };
    }

    // Check if user has Data Bank content or large collections
    // This is informational - we can't know exact memory usage
    return {
        name: 'WASM Memory',
        status: 'info',
        message: 'Transformers uses WASM with 4GB memory limit. For large documents, consider using Ollama or an API provider instead.'
    };
}

/**
 * Check: API keys are present for cloud providers
 */
export function checkApiKeys(settings) {
    const source = settings.embedding_provider;

    if (!requiresApiKey(source)) {
        return {
            name: 'API Key',
            status: 'skipped',
            message: 'No API key required for this provider'
        };
    }

    const secretKey = getSecretKey(source);
    const keyPresent = secretKey && secret_state[secretKey];

    if (!keyPresent) {
        const config = getProviderConfig(source);
        return {
            name: 'API Key',
            status: 'fail',
            message: `${config?.name || source} requires an API key`,
            fixable: true,
            fixAction: 'configure_api_key'
        };
    }

    return {
        name: 'API Key',
        status: 'pass',
        message: 'API key configured'
    };
}

/**
 * Check: API URLs are configured for local providers
 */
export function checkApiUrls(settings) {
    const source = settings.embedding_provider;

    if (!requiresUrl(source)) {
        return {
            name: 'API URL',
            status: 'skipped',
            message: 'No custom URL required'
        };
    }

    // resolveProviderApiUrl() reads the canonical per-provider alt-endpoint keys
    // (ollama_*, vllm_*) and falls back to ST's native server URL — the same
    // resolution the live embedding path uses. Anything empty means unconfigured.
    const config = getProviderConfig(source);
    const url = resolveProviderApiUrl(settings, source);

    if (!url) {
        return {
            name: 'API URL',
            status: 'fail',
            message: `${config?.name || source} requires a server URL`,
            fixable: true,
            fixAction: 'configure_url'
        };
    }

    return {
        name: 'API URL',
        status: 'pass',
        message: `${url}`
    };
}

/**
 * Check: Provider connectivity test
 */
export async function checkProviderConnectivity(settings) {
    if (!isValidProvider(settings.embedding_provider)) {
        return {
            name: 'Provider Connectivity',
            status: 'fail',
            message: `Unknown provider: ${settings.embedding_provider}`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const config = getProviderConfig(settings.embedding_provider);
    return {
        name: 'Provider Connectivity',
        status: 'pass',
        message: `Provider ${config.name} is recognized`
    };
}

/**
 * Check: WebLLM extension availability
 * Only runs if WebLLM is the selected provider
 */
export function checkWebLlmExtension(settings) {
    // Only relevant if WebLLM is selected
    if (settings.embedding_provider !== 'webllm') {
        return {
            name: 'WebLLM Extension',
            status: 'skipped',
            message: 'WebLLM not selected as provider',
            category: 'infrastructure'
        };
    }

    // Check browser WebGPU support
    if (!('gpu' in navigator)) {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'Browser does not support WebGPU. Use Chrome 113+, Edge 113+, or another WebGPU-compatible browser.',
            fixable: false,
            category: 'infrastructure'
        };
    }

    // Check if WebLLM extension is installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'WebLLM extension is not installed. Install from: github.com/SillyTavern/Extension-WebLLM',
            fixable: true,
            fixAction: 'install_webllm',
            category: 'infrastructure'
        };
    }

    // Check if WebLLM extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'WebLLM extension is outdated and does not support embeddings. Please update the extension.',
            fixable: true,
            fixAction: 'update_webllm',
            category: 'infrastructure'
        };
    }

    // Check if model is selected
    if (!settings.webllm_model) {
        return {
            name: 'WebLLM Extension',
            status: 'warning',
            message: 'WebLLM extension is installed but no model is selected. Select a model in VectFox settings.',
            fixable: false,
            category: 'infrastructure'
        };
    }

    return {
        name: 'WebLLM Extension',
        status: 'pass',
        message: `WebLLM ready with model: ${settings.webllm_model}`,
        category: 'infrastructure'
    };
}
