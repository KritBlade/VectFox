/**
 * ============================================================================
 * QDRANT BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: Qdrant (external vector database server)
 *
 * COLLECTION STRATEGY (configurable via settings.qdrant_multitenancy):
 *
 * MULTITENANCY MODE (qdrant_multitenancy = true):
 * - Uses a single shared collection: "vectfox_main"
 * - Adds content_type metadata field to distinguish different sources
 * - Uses Qdrant filtering to query only the relevant content_type
 * - More efficient for resource usage, suitable for smaller deployments
 *
 * SEPARATE COLLECTIONS MODE (qdrant_multitenancy = false, DEFAULT):
 * - Creates separate collections per content type/source
 * - Each chat vectorization gets its own collection
 * - Each character gets its own collection
 * - Each lorebook gets its own collection
 * - Better organization and isolation of data
 * - Recommended for production use
 *
 * Requires either a local Qdrant instance or Qdrant Cloud account.
 *
 * @author VectFox
 * @version 3.2.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelFromSettings, resolveProviderApiUrl } from '../core/providers.js';
import { throwIfModelConfigError } from '../core/model-http-errors.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { getQdrantApiKey } from '../core/api-keys.js';
import { log } from '../core/log.js';
import { warnIfEmbeddingSlow } from '../core/embedding-latency-warning.js';

const BACKEND_TYPE = 'qdrant';

function _isDimensionMismatch(errorBody) {
    return typeof errorBody === 'string' && errorBody.includes('Vector dimension error');
}

function _warnDimensionMismatch(errorBody) {
    const match = errorBody.match(/expected dim[: ]+(\d+)[^0-9]+(\d+)/i);
    const detail = match ? `Collection needs ${match[1]}-dim vectors; current provider generates ${match[2]}-dim.` : 'Vector dimension mismatch.';
    const msg = `${detail} Re-index the collection or switch back to the original embedding provider.`;
    log.error('[VectFox] Dimension mismatch — aborting fallback chain:', msg);
    // toastr is global in the ST browser context
    if (typeof toastr !== 'undefined') {
        toastr.error(msg, 'Embedding Dimension Mismatch', { timeOut: 10000 });
    }
}

// A query request embeds the search text server-side BEFORE touching Qdrant.
// Qdrant on LAN answers in <50ms, so a slow/504 response almost always means the
// embedding provider is the bottleneck — not Qdrant. This note is appended to
// query-failure logs so the embedding step is never misattributed to Qdrant.
function _embedTimeoutHint(settings) {
    const source = settings?.embedding_provider || 'transformers';
    return `NOTE: this request embeds server-side via '${source}' before querying Qdrant. Qdrant on LAN answers in <50ms, so a timeout/504 here points to the embedding provider ('${source}'), NOT Qdrant.`;
}

// NOTE: `vectfox_main` is kept verbatim for on-disk compatibility
// with existing user Qdrant data. Do not rebrand. See plans/vectfox-rename-plan.md §1.5.
const MULTITENANCY_COLLECTION = 'vectfox_main';


function getPluginProviderParams(settings) {
    const params = {};

    switch (settings.embedding_provider) {
        case 'ollama':
            params.apiUrl = resolveProviderApiUrl(settings, 'ollama');
            params.keep = !!settings.ollama_keep;
            // No apiKey: ST has no ollama auth path. The setAdditionalHeadersByType
            // call in ST's ollama-vectors.js is a no-op for ollama. The previous
            // params.apiKey = getOllamaApiKey(...) line was dead code on both sides.
            break;
        case 'vllm':
            params.apiUrl = resolveProviderApiUrl(settings, 'vllm')
                ?.replace(/\/$/, '')
                .replace(/\/v1\/embeddings$/, '')
                .replace(/\/embeddings$/, '');
            // No apiKey passed: ST's vLLM embedding handler reads
            // SECRET_KEYS.VLLM server-side via setAdditionalHeadersByType.
            // Same rationale as backends/standard.js — see comment there.
            break;
        // case 'llamacpp': params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]; break;
        // case 'koboldcpp': params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP]; break;
        default:
            break;
    }

    return params;
}

/**
 * Determines the actual collection name to use based on multitenancy setting
 * @param {string} collectionId - Original collection ID
 * @param {object} settings - VectFox settings
 * @returns {string} - Actual collection name to use
 */
function getActualCollectionId(collectionId, settings) {
    if (settings.qdrant_multitenancy) {
        return MULTITENANCY_COLLECTION;
    }
    return collectionId;
}

export class QdrantBackend extends VectorBackend {
    async initialize(settings) {
        // Get Qdrant config from settings
        // Only send relevant config based on cloud vs local mode
        let config;

        if (settings.qdrant_use_cloud) {
            // Cloud mode: use URL. The API key is resolved server-side by the
            // Similharity plugin from ST's secret_state slot 'api_key_qdrant'
            // (post-2026-05-26 migration). Client sends apiKey:null and the
            // plugin's /backend/init/qdrant handler reads the real key via
            // readSecret() before passing config to qdrantBackend.initialize.
            // For pre-migration users still on plaintext, getQdrantApiKey()
            // returns the transition-fallback value — keep checking it so
            // that flow doesn't break during the upgrade window.
            const legacyPlaintext = getQdrantApiKey(settings);
            config = {
                url: settings.qdrant_url || null,
                apiKey: legacyPlaintext || null,
                // Explicitly clear local settings to prevent conflicts
                host: null,
                port: null,
            };
            log.lifecycle('VectFox: Initializing Qdrant Cloud:', config.url, legacyPlaintext ? '(using legacy plaintext key — will migrate)' : '(plugin resolves key from secret_state)');
        } else {
            // Local mode: use host and port
            config = {
                host: settings.qdrant_host || '127.0.0.1',
                port: settings.qdrant_port || 6333,
                // Explicitly clear cloud settings to prevent conflicts
                url: null,
                apiKey: null,
            };
            log.lifecycle('VectFox: Initializing local Qdrant:', `${config.host}:${config.port}`);
        }

        log.lifecycle('VectFox: Sending Qdrant config to Similharity plugin:', JSON.stringify({ ...config, apiKey: config.apiKey ? '***redacted***' : undefined }));

        const response = await fetch('/api/plugins/similharity/backend/init/qdrant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(config),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to initialize Qdrant: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const responseData = await response.json().catch(() => ({}));
        log.lifecycle('VectFox: Qdrant initialization response:', responseData);
        log.lifecycle('VectFox: Using Qdrant backend (production-grade vector search)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/qdrant', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            log.error('[Qdrant] Health check failed:', error);
            return false;
        }
    }

    /**
     * Strip registry key prefix (backend:source:collectionId) to get just the collection ID
     * @param {string} collectionId - May be plain ID or prefixed registry key
     * @returns {string} - Just the collection ID part
     */
    _stripRegistryPrefix(collectionId) {
        if (!collectionId || typeof collectionId !== 'string') {
            return collectionId;
        }

        const knownBackends = ['standard', 'vectra', 'qdrant'];
        const knownSources = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp',
            'vllm', 'koboldcpp', 'webllm', 'openrouter'];

        const parts = collectionId.split(':');

        // New format: backend:collectionId (2-part, part[0] is a known backend)
        if (parts.length >= 2 && knownBackends.includes(parts[0]) && !knownSources.includes(parts[1])) {
            return parts.slice(1).join(':');
        }
        // Old 3-part format: backend:source:collectionId
        if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
            return parts.slice(2).join(':');
        }
        // Legacy source-only prefix: source:collectionId
        if (parts.length >= 2 && knownSources.includes(parts[0])) {
            return parts.slice(1).join(':');
        }

        // Already plain collection ID
        return collectionId;
    }

    /**
     * Parse collection ID to extract type and sourceId for multitenancy
     * Handles registry key format: backend:source:collectionId
     * Extracts just the collectionId part and parses it
     *
     * Supported formats:
     *   vf_{type}_{sourceId} (VectFox)
     */
    _parseCollectionId(collectionId) {
        // First strip any registry prefix
        collectionId = this._stripRegistryPrefix(collectionId);
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown' };
        }

        // Parse the actual collection ID
        const parts = collectionId.split('_');

        // VectFox format: vf_{type}_{sourceId}
        if (parts.length >= 3 && parts[0] === 'vf') {
            return {
                type: parts[1],
                sourceId: parts.slice(2).join('_')
            };
        }

        // Fallback: assume it's a chat with raw ID
        log.warn('VectFox: Unknown collection ID format:', collectionId);
        return {
            type: 'chat',
            sourceId: collectionId
        };
    }

    async getSavedHashes(collectionId, settings) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            limit: VECTOR_LIST_LIMIT,
        };

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get saved hashes for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.items ? data.items.map(item => item.hash) : [];
    }

    async insertVectorItems(collectionId, items, settings, abortSignal = null) {
        if (items.length === 0) return;

        // Strip registry key prefix to get the actual collection ID for Qdrant
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        // Compute sparse vectors per item. The browser owns tokenization (CJK pipeline lives
        // here), so we encode each item's text into Qdrant's {indices, values} format and
        // ship it as opaque payload to the plugin. Single path for Qdrant.
        const { encodeSparseVector } = await import('../core/sparse-vector-encoder.js');

        // Batch items to avoid exceeding Qdrant's 32MB payload limit
        // Qdrant's default limit is 33554432 bytes (32MB)
        const BATCH_SIZE = 100; // Conservative batch size to stay well under limit
        const batches = [];
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE));
        }

        log.verbose(`VectFox Qdrant: Inserting ${items.length} vectors in ${batches.length} batch(es) of up to ${BATCH_SIZE} items`);

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchNum = batchIndex + 1;

            const response = await fetch('/api/plugins/similharity/chunks/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: abortSignal
                    ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)])
                    : AbortSignal.timeout(120000),
                body: JSON.stringify({
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    items: batch.map(item => {
                        // Include keywords in the text for embedding/indexing
                        let textWithKeywords = item.text || '';
                        if (item.keywords && item.keywords.length > 0) {
                            const keywordTexts = item.keywords.map(kw => kw.text || kw).join(' ');
                            textWithKeywords += ` [KEYWORDS: ${keywordTexts}]`;
                        }

                        const metadata = {
                            ...item.metadata,
                            // Pass through VectFox-specific fields
                            importance: item.importance,
                            keywords: item.keywords,
                            conditions: item.conditions,
                            isSummaryChunk: item.isSummaryChunk,
                            parentHash: item.parentHash,
                        };

                        // Add content_type for multitenancy mode
                        if (settings.qdrant_multitenancy) {
                            metadata.content_type = strippedCollectionId;
                        }

                        // Tokenize the same text we use for the dense embed (textWithKeywords)
                        // so BM25 hits include the [KEYWORDS: ...] suffix terms.
                        return {
                            hash: item.hash,
                            text: textWithKeywords,
                            index: item.index,
                            vector: item.vector,
                            metadata,
                            sparseVector: encodeSparseVector(textWithKeywords),
                        };
                    }),
                    source: settings.embedding_provider || 'transformers',
                    model: getModelFromSettings(settings),
                    nativeSparse: true,
                    cjkTokenizerMode: settings.cjk_tokenizer_mode,
                    ...getPluginProviderParams(settings),
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');

                // Check for dimension mismatch error
                if (errorBody.includes('Vector dimension error') || errorBody.includes('dimension')) {
                    const dimensionMatch = errorBody.match(/expected dim: (\d+), got (\d+)/);
                    if (dimensionMatch) {
                        const expectedDim = dimensionMatch[1];
                        const gotDim = dimensionMatch[2];
                        throw new Error(
                            `[Qdrant] Vector dimension mismatch: Collection "${actualCollectionId}" expects ${expectedDim}-dimensional vectors, but received ${gotDim}-dimensional vectors. ` +
                            `This happens when switching embedding models. Solution: Delete the collection in Database Browser or use Qdrant API to drop it, then re-vectorize.`
                        );
                    }
                    throw new Error(
                        `[Qdrant] Vector dimension mismatch in collection "${actualCollectionId}". ` +
                        `This typically means you switched embedding models. Solution: Delete the collection and re-vectorize. Error: ${errorBody}`
                    );
                }

                throwIfModelConfigError({
                    contextLabel: 'Embedding',
                    provider: settings.embedding_provider,
                    model: getModelFromSettings(settings),
                    status: response.status,
                    responseText: errorBody,
                    enforceStatusGate: false,
                });
                throw new Error(`[Qdrant] Failed to insert ${items.length} vectors into ${actualCollectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
            }

            log.verbose(`VectFox Qdrant: Batch ${batchNum}/${batches.length} completed (${batch.length} vectors)`);
        }
        try {
            // Dynamic import to avoid circular dependency
            const { registerCollection } = await import('../core/collection-loader.js');
            const { buildRegistryKey } = await import('../core/collection-ids.js');
            // Use the canonical registry-key form ("backend:id") — see
            // Doc/collection_helper.md (storage-key convention). Passing the
            // bare collectionId here previously left a
            // duplicate registry entry (B4) that the DB Browser then displayed as
            // a phantom "VECTRA"-badged 0-chunk orphan, because no prefix defaults
            // to the standard backend in the badge logic.
            registerCollection(buildRegistryKey(collectionId, settings));
        } catch (e) {
            log.warn('VectFox: Failed to register collection after Qdrant insert:', e);
        }

        const mode = settings.qdrant_multitenancy ? 'multitenancy' : 'separate';
        log.lifecycle(`VectFox Qdrant: Inserted ${items.length} vectors into ${actualCollectionId} (${mode} mode, content_type: ${strippedCollectionId})`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            hashes: hashes,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
        };

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to delete vectors from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            eventbaseDebug: !!settings.eventbase_debug_qdrant_backend,
            ...getPluginProviderParams(settings),
        };

    //Use queryVector if provided, otherwise searchText
        if (queryVector) {
            body.queryVector = queryVector;
        } else if (searchText?.trim()) {
            body.searchText = searchText;
        } else {
            log.warn('[Qdrant] No queryVector or searchText provided');
            return { hashes: [], metadata: [] };
        }

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const tNetStart = performance.now();
        let response;
        try {
            response = await fetch('/api/plugins/similharity/chunks/query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
        } catch (error) {
            const failMs = (performance.now() - tNetStart).toFixed(1);
            log.warn(`[Qdrant timing] queryCollection FAILED after ${failMs}ms (exception): ${error.message}. ${_embedTimeoutHint(settings)}`);
            throw error;
        }

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            const failMs = (performance.now() - tNetStart).toFixed(1);
            log.warn(`[Qdrant timing] queryCollection FAILED after ${failMs}ms (HTTP ${response.status}). ${_embedTimeoutHint(settings)} Server said: ${errorBody.slice(0, 300)}`);
            throwIfModelConfigError({
                contextLabel: 'Embedding',
                provider: settings.embedding_provider,
                model: getModelFromSettings(settings),
                status: response.status,
                responseText: errorBody,
                enforceStatusGate: false,
            });
            throw new Error(`[Qdrant] Failed to query collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        if (log.enabled('verbose')) {
            const totalMs = (performance.now() - tNetStart).toFixed(1);
            log.verbose(`[Qdrant timing] queryCollection total=${totalMs}ms (incl. server-side embed via '${settings.embedding_provider || 'transformers'}'), embed=${data.timings?.embedMs ?? 'n/a'}ms, qdrant=${data.timings?.queryMs ?? 'n/a'}ms, results=${data.results?.length || 0}`);
        }
        warnIfEmbeddingSlow(data.timings?.embedMs, settings, 'query');

        // Format results to match expected output
        const hashes = data.results.map(r => r.hash);
        const metadata = data.results.map(r => ({
            hash: r.hash,
            text: r.text,
            score: r.score,
            ...r.metadata,
        }));

        return { hashes, metadata };
    }

    /**
     * Multi-collection query.
     *
     * `queryVector = null` matches StandardBackend.queryMultipleCollections's
     * signature. Without this parameter, the `if (queryVector)` reference
     * below threw a ReferenceError (caught by the per-collection try/catch
     * and silently swallowed as empty results) — see plans/review-fix.md C-1
     * for the 2026-05 audit that surfaced this. The bug was qdrant-only;
     * standard backend always had the param.
     *
     * Caller at core/core-vector-api.js:1071 passes queryVector as the 6th
     * positional arg when the upstream path generated an embedding —
     * without the parameter, the embedding was effectively ignored and
     * every collection returned 0 results.
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        const results = {};

        for (const collectionId of collectionIds) {
            try {
                const strippedCollectionId = this._stripRegistryPrefix(collectionId);
                const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

                const body = {
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    searchText: searchText,
                    topK: topK,
                    threshold: threshold,
                    source: settings.embedding_provider || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getPluginProviderParams(settings),
                };


                // Use queryVector if provided, otherwise searchText
                if (queryVector) {
                    body.queryVector = queryVector;
                } else if (searchText?.trim()) {
                    body.searchText = searchText;
                } else {
                    log.warn(`[Qdrant] No queryVector or searchText for ${collectionId}`);
                    results[collectionId] = { hashes: [], metadata: [] };
                    continue;
                }

                // Add content_type filter for multitenancy mode
                if (settings.qdrant_multitenancy) {
                    body.filter = {
                        must: [
                            { key: 'content_type', match: { value: strippedCollectionId } }
                        ]
                    };
                }

                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(body),
                });

                if (response.ok) {
                    const data = await response.json();
                    const resultArray = data.results || data.chunks || [];

                    results[collectionId] = {
                        hashes: resultArray.map(r => r.hash),
                        metadata: resultArray.map(r => ({
                            hash: r.hash,
                            text: r.text,
                            score: r.score,
                            ...r.metadata,
                        })),
                    };
                } else {
                    const errorBody = await response.text().catch(() => 'No response body');
                    const errorMsg = `${response.status} ${response.statusText} - ${errorBody}`;
                    log.error(`VectFox: Query failed for ${collectionId}: ${errorMsg}`);
                    results[collectionId] = { hashes: [], metadata: [], error: errorMsg };
                }
            } catch (error) {
                log.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        const strippedId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
        };

        // Multitenancy: send sourceId filter so the plugin deletes only the logical
        // collection's points from vectfox_main (instead of the entire shared collection).
        if (settings?.qdrant_multitenancy) {
            body.filters = { sourceId: strippedId };
        }

        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to purge collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        log.lifecycle(`VectFox Qdrant: Purged ${actualCollectionId}`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(settings) {
        // Note: With separate collections per content type, we need to purge each collection individually
        log.warn('VectFox: purgeAllVectorIndexes now requires calling purgeVectorIndex for each collection');
        throw new Error('purgeAllVectorIndexes requires collection IDs - call purgeVectorIndex for each collection instead');
    }

    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId, // Use separate collection per content type
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.chunk;
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to list chunks in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                text: newText,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk text in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                metadata: metadata,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk metadata in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics
     */
    async getStats(collectionId, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/stats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get stats for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }

    // ========================================================================
    // HYBRID SEARCH METHODS
    // ========================================================================

    /**
     * Check if this backend supports the Similharity server-side hybrid path.
     *
     * Current implementation uses backend-side dense vector search plus plugin-
     * side keyword/text matching and fusion. It is native/server-side within this
     * architecture, but not necessarily Qdrant named sparse-vector hybrid.
     *
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return true;
    }

    /**
     * Perform hybrid search using Qdrant's sparse + dense vector capabilities.
     *
     * Throws on failure — it does NOT degrade to vector-only itself. Fallback for
     * the hybrid path is owned solely by core/hybrid-search.js::hybridSearch.
     * The one exception is a vector-dimension mismatch, which returns an empty
     * result because no other path could succeed either.
     *
     * @param {string} collectionId - Collection to query
     * @param {string} searchText - Query text
     * @param {number} topK - Number of results to return
     * @param {object} settings - VectFox settings
     * @param {object} hybridOptions - Hybrid search options
     * @returns {Promise<{hashes: number[], metadata: object[]}>}
     */
    async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}, filters = {}) {
        const {
            vectorWeight = 0.5,
            textWeight = 0.5,
            fusionMethod = 'rrf',
            rrfK = 60
        } = hybridOptions;

        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        // Native sparse vectors + Qdrant-server-side RRF. Single path for Qdrant.
        // (See plans/qdrant-native-sparse-hybrid-rrf.md — winner of the A/B/C, others removed.)
        //
        // Tokenizer-mode lock: indexed sparse vectors carry the CJK tokenizer mode that was
        // active at upsert. A mode change between upsert and query silently breaks BM25
        // matching, so we read the collection's sentinel and prompt the user to revert if
        // they differ.
        let sparseQueryVector;
        try {
            const { detectTokenizerMismatch, showTokenizerMismatchModal, applyTokenizerRevert, openCjkTokenizerSetting } = await import('../core/tokenizer-lock.js');
            const mismatch = await detectTokenizerMismatch(settings, actualCollectionId);
            if (mismatch) {
                const debugLog = log.enabled('lifecycle');
                if (debugLog) log.lifecycle(`[TokenizerLock] Mismatch: collection=${mismatch.saved}, current=${mismatch.current} — prompting user`);
                const choice = await showTokenizerMismatchModal(mismatch, actualCollectionId);
                if (choice === 'revert') {
                    if (debugLog) log.lifecycle(`[TokenizerLock] User chose: Revert to ${mismatch.saved}`);
                    await applyTokenizerRevert(mismatch.saved, settings);
                } else if (choice === 'settings' || choice === 'cancel') {
                    if (debugLog) log.lifecycle(`[TokenizerLock] User chose: ${choice === 'settings' ? 'Open Settings' : 'Cancel'} — aborting query`);
                    // Abort the in-flight ST generation so it doesn't continue with
                    // a broken query. Without this the user has to hit ST's Stop
                    // button manually after dismissing the modal.
                    try {
                        const { stopGeneration } = await import('../../../../../script.js');
                        stopGeneration();
                    } catch (e) {
                        log.warn('[Qdrant] stopGeneration() failed:', e?.message);
                    }
                    if (choice === 'settings') openCjkTokenizerSetting();
                    return { hashes: [], metadata: [] };
                }
            }
            const { encodeSparseQuery } = await import('../core/sparse-vector-encoder.js');
            sparseQueryVector = encodeSparseQuery(searchText);
        } catch (error) {
            // Throw rather than falling back here. Fallback for the whole hybrid
            // path is owned by core/hybrid-search.js — see the "single fallback
            // owner" note on the catch at the end of this method.
            log.warn('[Qdrant] sparse query setup failed:', error?.message);
            throw new Error(`[Qdrant] Sparse query setup failed for ${collectionId}: ${error?.message || error}`, { cause: error });
        }

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            hybrid: true,
            hybridOptions: {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK,
                eventbaseDebug: !!settings.eventbase_debug_qdrant_backend,
                prefetchLimit: topK * 4,
            },
            sparseQueryVector,
            ...getPluginProviderParams(settings),
        };

        // Merge multitenancy content_type into the filters object so the
        // plugin's _buildHybridFilter handles it via the unified filters path.
        const mergedFilters = settings.qdrant_multitenancy
            ? { ...filters, content_type: strippedCollectionId }
            : { ...filters };
        if (Object.keys(mergedFilters).length > 0) {
            body.filters = mergedFilters;
        }

        if (log.enabled('verbose')) {
            const preview = String(searchText || '').replace(/\s+/g, ' ').slice(0, 280);
            try {
                const { tokenize } = await import('../core/bm25-scorer.js');
                const terms = [...new Set(tokenize(searchText, { dedupe: false }))];
                log.verbose(`[EventBase] Hybrid request: collection=${body.collectionId}, topK=${topK}, sparse=${sparseQueryVector.indices.length} tokens, terms=[${terms.join(', ')}], preview="${preview}"`);
            } catch {
                log.verbose(`[EventBase] Hybrid request: collection=${body.collectionId}, topK=${topK}, sparse=${sparseQueryVector.indices.length} tokens, preview="${preview}"`);
            }
        }

        const tNetStart = performance.now();

        // Single fallback owner: this method no longer degrades to vector-only on
        // its own. core/hybrid-search.js::hybridSearch catches whatever we throw and
        // runs the client-side fusion path, which issues ONE vector query and adds
        // BM25 re-ranking on top — strictly better than the raw vector-only retry
        // this used to do, and one HTTP round-trip cheaper. Two independent fallback
        // layers previously fired in sequence, so a single failing query cost three
        // requests (hybrid-query, our retry, then hybrid-search's) and the caller
        // still received an empty result it could not distinguish from "no match".
        let response;
        try {
            response = await fetch('/api/plugins/similharity/chunks/hybrid-query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
        } catch (error) {
            const failMs = (performance.now() - tNetStart).toFixed(1);
            log.warn(`[Qdrant timing] hybridQuery FAILED after ${failMs}ms (exception): ${error.message}. ${_embedTimeoutHint(settings)}`);
            throw error;
        }

        if (response.ok) {
            const data = await response.json();
            const totalMs = (performance.now() - tNetStart).toFixed(1);
            log.verbose(`[Qdrant timing] total=${totalMs}ms, embed=${data.timings?.embedMs ?? 'n/a'}ms, qdrant=${data.timings?.queryMs ?? 'n/a'}ms, results=${data.results?.length || 0}`);
            warnIfEmbeddingSlow(data.timings?.embedMs, settings, 'hybrid-query');

            return {
                hashes: data.results.map(r => r.hash),
                metadata: data.results.map(r => ({
                    hash: r.hash,
                    text: r.text,
                    score: r.score,
                    vectorScore: r.vectorScore,
                    textScore: r.textScore,
                    fusionMethod: r.fusionMethod || 'rrf',
                    hybridSearch: true,
                    nativeSparse: true,
                    ...r.metadata,
                }))
            };
        }

        const errorBody = await response.text().catch(() => '(no body)');
        const failMs = (performance.now() - tNetStart).toFixed(1);
        if (_isDimensionMismatch(errorBody)) {
            // Deliberate dead end, NOT a fallback: a dimension mismatch fails
            // identically on every path, so retrying vector-only would just burn
            // another round-trip. _warnDimensionMismatch already told the user.
            _warnDimensionMismatch(errorBody);
            return { hashes: [], metadata: [] };
        }
        log.warn(`[Qdrant timing] hybridQuery FAILED after ${failMs}ms (HTTP ${response.status}). ${_embedTimeoutHint(settings)} Server said: ${errorBody.slice(0, 500)}`);
        throw new Error(`[Qdrant] Hybrid query failed for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody.slice(0, 500)}`);
    }

    /**
     * Hybrid query + server-side EventBase re-rank in one call.
     *
     * Posts to `/api/plugins/similharity/chunks/hybrid-query-rerank`, which wraps
     * the dense + sparse + RRF hybrid in an outer Qdrant `formula` query that
     * computes the EventBase weighted score (cosine × $score + importance + persist
     * + recency decay) server-side, plus min-importance + dedup-depth filters.
     *
     * Returns the same envelope shape as `hybridQuery()` but `score` is the
     * post-formula re-ranked score. Anchor boost, pairwise dedup, and cross-
     * collection merge still run client-side in eventbase-retrieval.js.
     *
     * Falls back to `hybridQuery()` on any error (plugin returns 400 when Qdrant
     * version is < 1.13). Caller can also pre-check by issuing a hybrid query and
     * observing the response, but the route's own version check is authoritative.
     *
     * @param {string} collectionId
     * @param {string} searchText
     * @param {number} topK - Outer formula limit (typically finalTopK × 2 for dedup overfetch)
     * @param {object} settings - VectFox settings
     * @param {object} rerankParams - { weights, chatLength, halfLife, minImportance, visibleThreshold, applyContextDedupFilter, rrfScoreScale? }
     * @param {object} hybridOptions - { prefetchLimit }
     * @returns {Promise<{hashes:number[], metadata:object[]}>}
     */
    async hybridQueryWithRerank(collectionId, searchText, topK, settings, rerankParams, hybridOptions = {}, filters = {}) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        // Same sparse-query encoding path as hybridQuery() — including the
        // tokenizer-mode lock. If sparse setup fails, fall back to vector-only
        // (matches the legacy behavior).
        let sparseQueryVector;
        try {
            const { detectTokenizerMismatch, showTokenizerMismatchModal, applyTokenizerRevert, openCjkTokenizerSetting } = await import('../core/tokenizer-lock.js');
            const mismatch = await detectTokenizerMismatch(settings, actualCollectionId);
            if (mismatch) {
                const debugLog = log.enabled('lifecycle');
                if (debugLog) log.lifecycle(`[TokenizerLock] Mismatch: collection=${mismatch.saved}, current=${mismatch.current} — prompting user`);
                const choice = await showTokenizerMismatchModal(mismatch, actualCollectionId);
                if (choice === 'revert') {
                    if (debugLog) log.lifecycle(`[TokenizerLock] User chose: Revert to ${mismatch.saved}`);
                    await applyTokenizerRevert(mismatch.saved, settings);
                } else if (choice === 'settings' || choice === 'cancel') {
                    if (debugLog) log.lifecycle(`[TokenizerLock] User chose: ${choice === 'settings' ? 'Open Settings' : 'Cancel'} — aborting query`);
                    // Abort the in-flight ST generation so it doesn't continue with
                    // a broken query. Without this the user has to hit ST's Stop
                    // button manually after dismissing the modal.
                    try {
                        const { stopGeneration } = await import('../../../../../script.js');
                        stopGeneration();
                    } catch (e) {
                        log.warn('[Qdrant] stopGeneration() failed:', e?.message);
                    }
                    if (choice === 'settings') openCjkTokenizerSetting();
                    return { hashes: [], metadata: [] };
                }
            }
            const { encodeSparseQuery } = await import('../core/sparse-vector-encoder.js');
            sparseQueryVector = encodeSparseQuery(searchText);
        } catch (error) {
            log.warn('[Qdrant] sparse query setup failed (rerank path):', error?.message);
            return this.queryCollection(collectionId, searchText, topK, settings);
        }

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText,
            topK,
            threshold: 0.0,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            hybrid: true,
            hybridOptions: {
                eventbaseDebug: !!settings.eventbase_debug_qdrant_backend,
                prefetchLimit: hybridOptions.prefetchLimit || topK * 4,
            },
            sparseQueryVector,
            rerankParams,
            ...getPluginProviderParams(settings),
        };

        const mergedFilters = settings.qdrant_multitenancy
            ? { ...filters, content_type: strippedCollectionId }
            : { ...filters };
        if (Object.keys(mergedFilters).length > 0) {
            body.filters = mergedFilters;
        }

        if (log.enabled('verbose')) {
            const preview = String(searchText || '').replace(/\s+/g, ' ').slice(0, 280);
            log.verbose(`[EventBase] Hybrid+rerank request: collection=${body.collectionId}, topK=${topK}, sparse=${sparseQueryVector.indices.length} tokens, preview="${preview}"`);
        }

        const tNetStart = performance.now();

        try {
            const response = await fetch('/api/plugins/similharity/chunks/hybrid-query-rerank', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.ok) {
                const data = await response.json();
                const totalMs = (performance.now() - tNetStart).toFixed(1);
                log.verbose(`[Qdrant timing] hybrid+rerank total=${totalMs}ms, embed=${data.timings?.embedMs ?? 'n/a'}ms, qdrant=${data.timings?.queryMs ?? 'n/a'}ms, results=${data.results?.length || 0}`);
                warnIfEmbeddingSlow(data.timings?.embedMs, settings, 'hybrid-query-rerank');

                return {
                    hashes: data.results.map(r => r.hash),
                    metadata: data.results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,                  // = formula score
                        formulaScore: r.formulaScore,
                        fusionMethod: r.fusionMethod || 'rrf',
                        hybridSearch: true,
                        nativeSparse: true,
                        rerankApplied: true,
                        ...r.metadata,
                    }))
                };
            }

            const errorBody = await response.text().catch(() => '(no body)');
            const failMs = (performance.now() - tNetStart).toFixed(1);
            if (_isDimensionMismatch(errorBody)) {
                _warnDimensionMismatch(errorBody);
                return { hashes: [], metadata: [] };
            }
            log.warn(`[Qdrant timing] hybrid+rerank FAILED after ${failMs}ms (HTTP ${response.status}), falling back to hybridQuery. ${_embedTimeoutHint(settings)} Server said: ${errorBody.slice(0, 500)}`);
        } catch (error) {
            const failMs = (performance.now() - tNetStart).toFixed(1);
            log.warn(`[Qdrant timing] hybrid+rerank FAILED after ${failMs}ms (exception): ${error.message}. ${_embedTimeoutHint(settings)}`);
        }

        // Fallback: regular hybridQuery (no server-side rerank). The caller
        // (eventbase-retrieval) will then need to apply JS re-rank itself; the
        // result lacks `rerankApplied: true` so the caller can detect and branch.
        return this.hybridQuery(collectionId, searchText, topK, settings, hybridOptions, filters);
    }
}
