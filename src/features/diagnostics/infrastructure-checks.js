/**
 * ============================================================================
 * VectFox DIAGNOSTICS - INFRASTRUCTURE
 * ============================================================================
 * Backend, provider, and plugin availability checks
 *
 * @author Kritblade
 * ============================================================================
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
import { log } from '../../sillytavern/log.js';
import { secret_state } from '../../sillytavern/secrets.js';
import {
    checkPluginAvailable,
    getPluginProbe,
    isPluginDetected,
    PLUGIN_UPDATE_INSTRUCTIONS,
    similharityStanding,
} from '../../shared/similharity-plugin.js';
import {
    embeddingProfileKind,
    isValidProvider,
    getProviderConfig,
    getModelFromSettings,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    resolveEmbeddingProfile,
    resolveProviderApiUrl
} from '../embedding/index.js';

/**
 * The collection the endpoint probes list, query and write to. SillyTavern's Standard storage creates it on first
 * reference, so removeProbeCollection deletes it once the last probe is done.
 */
const PROBE_COLLECTION_ID = 'VectFox_diag';

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
                collectionId: PROBE_COLLECTION_ID,
                source: 'transformers'
            })
        });

        if (response.status === 404) {
            return {
                name: 'ST Vectra (Standard)',
                status: 'fail',
                message: 'ST vector API not available - check SillyTavern installation',
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
            message: `Cannot reach ST vector API: ${error.message}`,
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
export async function checkBackendEndpoints() {
    const results = [];
    // Always use 'transformers' - native ST endpoints don't know custom sources
    // This check tests "do endpoints respond?" not "does my provider work?"
    const source = 'transformers';

    const endpoints = [
        { name: 'list', method: 'POST', url: '/api/vector/list', body: { collectionId: PROBE_COLLECTION_ID, source } },
        { name: 'query', method: 'POST', url: '/api/vector/query', body: { collectionId: PROBE_COLLECTION_ID, searchText: 'test', topK: 1, source } },
        { name: 'insert', method: 'POST', url: '/api/vector/insert', body: { collectionId: PROBE_COLLECTION_ID, items: [], source } },
        { name: 'delete', method: 'POST', url: '/api/vector/delete', body: { collectionId: PROBE_COLLECTION_ID, hashes: [], source } },
        { name: 'purge', method: 'POST', url: '/api/vector/purge', body: { collectionId: `${PROBE_COLLECTION_ID}_nonexistent` } },
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
 * Check: VectFox Server Plugin (similharity), as the shared /health probe found it, against the oldest version VectFox
 * works with (similharity_minimum_version in manifest.json). It provides Qdrant, the collection browser, full
 * metadata, and embedding on a llama.cpp, KoboldCPP or Custom profile.
 */
export async function checkServerPlugin() {
    await checkPluginAvailable();
    const probe = getPluginProbe();
    const result = (status, message) => ({ name: 'VectFox Plugin', status, message, category: 'infrastructure' });

    if (probe.status === null) {
        return result('warning', `Plugin not found (${probe.failure}). It is optional, but Qdrant, full metadata and llama.cpp, KoboldCPP or Custom profiles need it`);
    }
    if (!probe.isFound) return result('warning', `Plugin unhealthy: ${probe.status}`);

    const { version, requiredVersion, isCurrent } = similharityStanding();
    if (!requiredVersion) return result('warning', 'VectFox could not read the Similharity version it needs from its manifest.json; the console says why');
    if (!version) return result('warning', `The plugin reports no version, so VectFox cannot confirm it is v${requiredVersion} or later. ${PLUGIN_UPDATE_INSTRUCTIONS}`);
    if (!isCurrent) return result('warning', `v${version} is older than v${requiredVersion}, the oldest VectFox works with. ${PLUGIN_UPDATE_INSTRUCTIONS}`);
    return result('pass', probe.backends.length ? `v${version} - Backends: ${probe.backends.join(', ')}` : `v${version}`);
}

/**
 * Check: VectFox Plugin API Endpoints
 * Tests all plugin-provided endpoints for advanced functionality
 */
export async function checkPluginEndpoints() {
    const results = [];
    const testSource = 'transformers';

    // Only a plugin the shared /health probe found has endpoints to test.
    await checkPluginAvailable();
    if (!isPluginDetected()) {
        return {
            name: 'Plugin API Endpoints',
            status: 'skipped',
            message: `Plugin not available (${getPluginProbe().failure}) - endpoints not tested`,
            category: 'infrastructure'
        };
    }
    results.push({ name: 'health', ok: true });

    // Test each plugin endpoint (unified API)
    const pluginEndpoints = [
        { name: 'collections', method: 'GET', url: `/api/plugins/similharity/collections` },
        { name: 'sources', method: 'GET', url: '/api/plugins/similharity/sources' },
        { name: 'chunks/list', method: 'POST', url: '/api/plugins/similharity/chunks/list',
          body: { backend: 'vectra', collectionId: PROBE_COLLECTION_ID, source: testSource, limit: 1 } },
        { name: 'chunks/query', method: 'POST', url: '/api/plugins/similharity/chunks/query',
          body: { backend: 'vectra', collectionId: PROBE_COLLECTION_ID, searchText: 'test', topK: 1, source: testSource } },
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
 * Delete the probe collection through SillyTavern's own purge, which removes its folder under every source
 * SillyTavern lists, the model folders inside included, and needs no plugin. Run after the last probe.
 *
 * @returns {Promise<{name: string, status: string, message: string, category: string}>}
 */
export async function removeProbeCollection() {
    const result = (status, message) => ({ name: 'Probe Collection Removal', status, message, category: 'infrastructure' });
    const what = `${PROBE_COLLECTION_ID}, the collection the endpoint checks make`;
    try {
        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ collectionId: PROBE_COLLECTION_ID }),
        });
        if (response.ok) return result('pass', `Removed ${what}`);
        log.warn(`VectFox diagnostics: removing the probe collection ${PROBE_COLLECTION_ID} answered HTTP ${response.status}`);
        return result('warning', `Could not remove ${what}: HTTP ${response.status}`);
    } catch (error) {
        log.warn(`VectFox diagnostics: removing the probe collection ${PROBE_COLLECTION_ID} failed:`, error);
        return result('warning', `Could not remove ${what}: ${error.message}`);
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
                category: 'infrastructure'
            };
        }
        // The Qdrant API key lives in ST's secret slot 'api_key_qdrant', a custom
        // slot that client-side secret_state does not surface, so it cannot be
        // presence-checked here; a missing key surfaces as an auth failure from
        // the plugin's /backend/init/qdrant handler.
    } else {
        if (!settings.qdrant_host || !settings.qdrant_port) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant local host/port not configured (default: 127.0.0.1:6333)',
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
            // The plugin reads the key server-side from the secret_state slot 'api_key_qdrant'.
            // A plaintext key not yet moved there is handled by QdrantBackend's normal init, not
            // here — diagnostics run on their own and do not read the plaintext key.
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
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `Qdrant init error: ${error.message}`,
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
                category: 'infrastructure'
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
 * Check: Embedding provider is configured properly
 */
export async function checkEmbeddingProvider(settings) {
    const source = settings.embedding_provider;

    if (!source) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: 'No embedding provider selected'
        };
    }

    const config = getProviderConfig(source);
    if (!config) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `Unknown provider: ${source}`
        };
    }

    // A llama.cpp, KoboldCPP or Custom profile needs Similharity, which the profile check reads from the settled probe.
    await checkPluginAvailable();
    const onProfile = resolveEmbeddingProfile(settings);
    if (onProfile?.problem) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: onProfile.problem
        };
    }

    const model = getModelFromSettings(settings);
    if (config.requiresModel && !model) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `${config.name} selected but no model configured`
        };
    }

    const modelInfo = model ? ` (${model})` : '';
    const profileInfo = onProfile ? ` on profile "${onProfile.profileName}"` : '';
    return {
        name: 'Embedding Provider',
        status: 'pass',
        message: `Using ${config.name}${modelInfo}${profileInfo}`
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

    // On a profile that sends its key ID, the key is the one the profile stores, which stays on SillyTavern's server.
    const onProfile = embeddingProfileKind(source)?.sendsKeyId ? resolveEmbeddingProfile(settings) : null;
    if (onProfile?.profileName) {
        return {
            name: 'API Key',
            status: 'info',
            message: onProfile.storesKey
                ? `Sends the key profile "${onProfile.profileName}" stores`
                : `Profile "${onProfile.profileName}" stores no key, so none is sent`
        };
    }

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
            message: `${config?.name || source} requires an API key`
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

    // The URL the embedding requests use: the profile's on a connection profile, else the provider's own field or
    // SillyTavern's server URL. A profile that cannot be used says why, as those requests would.
    const config = getProviderConfig(source);
    let url;
    try {
        url = resolveProviderApiUrl(settings, source);
    } catch (error) {
        if (error?.code !== 'invalid_model_config') throw error;
        return {
            name: 'API URL',
            status: 'fail',
            message: error.message
        };
    }

    if (!url) {
        return {
            name: 'API URL',
            status: 'fail',
            message: `${config?.name || source} requires a server URL`
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
            message: `Unknown provider: ${settings.embedding_provider}`
        };
    }

    const config = getProviderConfig(settings.embedding_provider);
    return {
        name: 'Provider Connectivity',
        status: 'pass',
        message: `Provider ${config.name} is recognized`
    };
}
