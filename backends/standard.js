/**
 * ============================================================================
 * STANDARD BACKEND (Vectra - ST Native)
 * ============================================================================
 * Uses ST's native /api/vector/* endpoints as the primary path.
 * This is the default backend — no setup required.
 *
 * ## Plugin dependency rule
 *
 * The Similharity plugin (/api/plugins/similharity/*) is an OPTIONAL
 * enhancement here, NOT a requirement. Every method that calls the plugin
 * MUST check `this.pluginAvailable` first and fall back to a native-API path
 * when the plugin is absent. The standard backend must be fully functional
 * without the plugin installed.
 *
 * Plugin-enhanced features (metadata, chunk listing, chunk editing) degrade
 * gracefully to reduced functionality — never to a hard error.
 *
 * See Doc/dev_helper.md §15 for the full plugin dependency policy.
 *
 * !! DO NOT add any unconditional plugin calls here !!
 *
 * @author VectFox
 * @version 3.1.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelFromSettings, resolveProviderApiUrl } from '../core/providers.js';
import { throwIfModelConfigError } from '../core/model-http-errors.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { INTERNAL_COLLECTION_IDS } from '../core/collection-ids.js';
import { extension_settings } from '../../../../extensions.js';
import { oai_settings } from '../../../../openai.js';
import { log } from '../core/log.js';
import { warnIfEmbeddingSlow } from '../core/embedding-latency-warning.js';


/**
 * Build provider-specific parameters for API requests.
 * @param {object} settings - VectFox settings
 * @param {boolean} isQuery - Whether this is a query operation
 * @returns {object} Provider-specific parameters
 */
function getProviderSpecificParams(settings, isQuery = false) {
    const params = {};
    const source = settings.embedding_provider;

    switch (source) {
        case 'extras':
            params.extrasUrl = extension_settings.apiUrl;
            params.extrasKey = extension_settings.apiKey;
            break;

        case 'cohere':
            params.input_type = isQuery ? 'search_query' : 'search_document';
            break;

        case 'ollama':
            params.apiUrl = resolveProviderApiUrl(settings, 'ollama');
            params.keep = !!settings.ollama_keep;
            break;

        case 'llamacpp':
            params.apiUrl = resolveProviderApiUrl(settings, 'llamacpp');
            log.verbose(`VectFox DEBUG llamacpp: final apiUrl="${params.apiUrl}"`);
            break;

        case 'vllm':
            params.apiUrl = resolveProviderApiUrl(settings, 'vllm');
            // No apiKey passed: ST's vLLM embedding handler
            // (src/vectors/vllm-vectors.js) reads SECRET_KEYS.VLLM server-side
            // via setAdditionalHeadersByType — anything we set on params.apiKey
            // is silently ignored. User configures the embedding key via ST's
            // Text Completion → vLLM UI; chat key (separate slot) lives in
            // SECRET_KEYS.CUSTOM after the 2026-05-26 migration.
            break;

        case 'palm':
            params.api = 'makersuite';
            break;

        case 'vertexai':
            params.api = 'vertexai';
            params.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            params.vertexai_region = oai_settings.vertexai_region;
            params.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;

        default:
            break;
    }

    return params;
}

// ----------------------------------------------------------------------------
// Per-collection coalesce + queue for plugin safety
// ----------------------------------------------------------------------------
// The similharity plugin's standard/Vectra path does NOT synchronize concurrent
// writes to the same collection. Multiple in-flight POSTs to /chunks/insert each
// load → mutate → write the same JSON-backed index file, and they race. The
// outcome under load (observed 2026-05-30) is variable-position truncated-JSON
// 500s back to the client (`Unexpected non-whitespace character after JSON at
// position X` where X varies because it depends on file size at corruption time)
// and a corrupted Vectra index on disk.
//
// VectFox's parallel-split insert (default since 2026-05-30) fires N concurrent
// single-item POSTs per batch — great for failure containment on Qdrant, fatal
// for Vectra.
//
// Fix has two layers working together:
//
//   1. COALESCE — single-item calls arriving for the same collection within a
//      tiny window (COALESCE_DELAY_MS) get merged back into one batched POST.
//      This restores the production-like "1 POST per concurrency window" wire
//      shape on this backend without the user having to enable
//      `vector_group_embedding_call` manually. Faster healthy-case throughput
//      than queue (~5s vs ~27s/wave), zero log noise from hedge fires that
//      can't help anyway. Matches Qdrant's wire shape so we have one mental
//      model for both backends.
//
//   2. QUEUE — serializes the resulting batched POSTs per collection. Needed
//      to handle:
//        - Hedge duplicates (15s later they'd fire a 2nd coalesced POST that
//          would race the primary if not serialized)
//        - Multi-item calls (group_embedding_call=true) that bypass coalesce
//        - Any future code path that calls insertVectorItems concurrently
//      Plugin only ever sees 1 in-flight write per collection.
//
// Different collections still run in parallel — both maps are keyed by
// collectionId so unrelated work doesn't bottleneck.
//
// Public API (insertVectorItems) is unchanged; coalesce + queue are transparent
// to callers. Existing standard backend users see zero behavioral difference on
// the wire from this dev branch — coalesce reproduces the production POST
// shape exactly.
const _pendingCoalesce = new Map();   // collectionId → { items, resolvers, settings, abortSignal, timer }
const _vectraWriteQueues = new Map(); // collectionId → Promise (latest tail)
const COALESCE_DELAY_MS = 5;          // Wave debounce. Parallel-split fires N
                                      // callers within microseconds; 5ms is
                                      // enough to catch the whole wave without
                                      // perceptibly delaying solo calls.

export class StandardBackend extends VectorBackend {
    constructor() {
        super();
        this.pluginAvailable = false;
    }

    async initialize(settings) {
        // Check if plugin is available via the canonical, session-cached probe
        // in core/collection-loader.js. Dynamic import breaks the otherwise
        // circular static dependency (collection-loader → core-vector-api →
        // (dynamic import) → standard.js), the same pattern corpus-stats.js
        // uses. Routing through the shared cache means a no-plugin install
        // issues exactly ONE /health request total (and thus at most one 404 in
        // the browser console) instead of one per backend/UI consumer.
        log.lifecycle('VectFox DEBUG: Checking plugin availability...');
        try {
            const { checkPluginAvailable } = await import('../core/collection-loader.js');
            this.pluginAvailable = await checkPluginAvailable();
            log.lifecycle('VectFox DEBUG: Plugin available:', this.pluginAvailable);

            if (this.pluginAvailable) {
                await fetch('/api/plugins/similharity/backend/init/vectra', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });
                log.lifecycle('VectFox: Standard backend initialized (plugin available)');
            } else {
                log.lifecycle('VectFox: Standard backend initialized (native ST API only - health check failed)');
            }
        } catch (e) {
            log.lifecycle('VectFox: Standard backend initialized (native ST API only - error:', e.message, ')');
            this.pluginAvailable = false;
        }
        
    }

    async healthCheck() {
        // Native ST API is always available if ST is running
        try {
            // Quick test: try to list a non-existent collection (should return empty array or error)
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    collectionId: INTERNAL_COLLECTION_IDS[0],
                    source: 'transformers'
                }),
            });
            // 200 = works (empty collection), 500 = syntax error (no collection), both are "working"
            return response.status === 200 || response.status === 500;
        } catch (error) {
            log.error('[Standard] Health check failed:', error);
            return false;
        }
    }

    /**
     * Get saved hashes for a collection
     * Uses native ST API
     */
    async getSavedHashes(collectionId, settings) {
        const providerParams = getProviderSpecificParams(settings, false);
        const model = getModelFromSettings(settings);

        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
                source: settings.embedding_provider || 'transformers',
                model: model,
                ...providerParams,
            }),
        });

        if (!response.ok) {
            // Collection doesn't exist or error
            if (response.status === 500) {
                // Likely collection doesn't exist
                return [];
            }
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to get saved hashes: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        // Native API returns array of hashes directly
        return Array.isArray(data) ? data : [];
    }

    /**
     * Insert vector items into a collection
     * Uses plugin API if available (for metadata support), falls back to native ST API
     */
    /**
     * Public insert entry point. Two-layer safety mechanism for the
     * similharity-plugin Vectra path — see top-of-file comment on
     * `_pendingCoalesce` for the full rationale.
     *
     * Single-item calls (from parallel-split's per-event POSTs) coalesce in
     * a 5ms window into one batched call. Multi-item calls
     * (from group_embedding_call mode) skip coalesce and go straight to the
     * queue. Both paths converge at `_queuedInsert` which serializes per
     * collection.
     *
     * Result on the wire: at most one POST per collection at a time,
     * containing the entire wave's items. Matches production behavior.
     *
     * What this DOES change vs. naive parallel-split:
     *   - Plugin sees 1 batched POST per wave instead of N concurrent ones
     *   - Healthy-case throughput is much faster (~5s vs ~27s/wave)
     *   - One stuck item in the batched embedding affects all callers of
     *     that wave (same as production / group_embedding_call mode)
     *
     * What this does NOT change:
     *   - Public API (signature unchanged)
     *   - Different-collection inserts run in parallel (per-collection keys)
     *   - Abort handling (checked at queue entry, propagates normally)
     *   - Error propagation (each caller gets its own resolved Promise)
     */
    async insertVectorItems(collectionId, items, settings, abortSignal = null) {
        if (items.length === 0) return;

        if (items.length > 1) {
            // Multi-item call (e.g. user has vector_group_embedding_call=true).
            // No coalescing needed; the wave already arrived pre-batched. Skip
            // to the queue so it still serializes against any other in-flight
            // writes for the same collection.
            return this._queuedInsert(collectionId, items, settings, abortSignal);
        }

        // Single-item call — coalesce with any siblings arriving within
        // COALESCE_DELAY_MS. Parallel-split's Promise.allSettled wave fires N
        // callers within microseconds, so the 5ms window catches the entire
        // burst.
        return new Promise((resolve, reject) => {
            let pending = _pendingCoalesce.get(collectionId);
            if (!pending) {
                pending = {
                    items: [],
                    resolvers: [],
                    settings,         // First caller's settings. All siblings
                    abortSignal,      // in a parallel-split wave come from the
                                      // same outer call → identical objects.
                    timer: null,
                };
                _pendingCoalesce.set(collectionId, pending);
                pending.timer = setTimeout(() => {
                    _pendingCoalesce.delete(collectionId);
                    // Hand the merged batch off to the queue. Resolution
                    // fan-out happens here: all coalesced callers see the
                    // same success/failure from the single underlying call.
                    this._queuedInsert(collectionId, pending.items, pending.settings, pending.abortSignal).then(
                        () => pending.resolvers.forEach(r => r.resolve()),
                        (err) => pending.resolvers.forEach(r => r.reject(err)),
                    );
                }, COALESCE_DELAY_MS);
            }
            pending.items.push(items[0]);
            pending.resolvers.push({ resolve, reject });
        });
    }

    /**
     * Per-collection queue. Chains the next insert onto a promise tail so
     * concurrent callers serialize at this layer — the plugin only ever sees
     * one in-flight write per collection. Different collections proceed in
     * parallel because the map is keyed by collectionId.
     *
     * The queue is what keeps hedge-duplicates safe: a hedge fires 15s after
     * the primary, but if the primary is still in flight the hedge's batched
     * POST waits behind it rather than racing into a concurrent-write bug.
     */
    async _queuedInsert(collectionId, items, settings, abortSignal) {
        const prev = _vectraWriteQueues.get(collectionId) || Promise.resolve();
        // .catch(() => {}) absorbs any prior failure so it doesn't propagate
        // to OUR caller — they only see their own result.
        const myTurn = prev.catch(() => {}).then(async () => {
            // Re-check abort after the wait. The user might have hit Stop
            // while we were queued behind other inserts.
            if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
            return this._insertVectorItemsImpl(collectionId, items, settings, abortSignal);
        });
        _vectraWriteQueues.set(collectionId, myTurn);

        try {
            return await myTurn;
        } finally {
            // Cleanup ONLY if we're still the tail. If a later caller already
            // replaced us as the tail they're using `myTurn` as their `prev`
            // — deleting would break the chain.
            if (_vectraWriteQueues.get(collectionId) === myTurn) {
                _vectraWriteQueues.delete(collectionId);
            }
        }
    }

    /**
     * Internal — does the actual HTTP POST + response handling. Always called
     * via `_queuedInsert` so per-collection serialization holds.
     */
    async _insertVectorItemsImpl(collectionId, items, settings, abortSignal = null) {
        if (items.length === 0) return;

        const providerParams = getProviderSpecificParams(settings, false);
        const model = getModelFromSettings(settings);

        // Log chunk statistics for debugging OOM issues
        const textLengths = items.map(item => (item.text || '').length);
        const maxLen = Math.max(...textLengths);
        const avgLen = Math.round(textLengths.reduce((a, b) => a + b, 0) / textLengths.length);
        const longestChunkIndex = textLengths.indexOf(maxLen);

        // Count how many chunks have keywords
        const chunksWithKeywords = items.filter(item => item.keywords && item.keywords.length > 0).length;

        log.verbose(`VectFox: Embedding ${items.length} chunks (avg: ${avgLen} chars, max: ${maxLen} chars at index ${longestChunkIndex}) - ${chunksWithKeywords} chunks have keywords`);

        // Debug: Log first chunk's keywords if any
        if (chunksWithKeywords > 0) {
            const firstChunkWithKeywords = items.find(item => item.keywords && item.keywords.length > 0);
            log.verbose(`VectFox DEBUG: First chunk keywords:`, firstChunkWithKeywords.keywords);
        }

        // Warn if chunks are unusually large (potential OOM risk)
        if (maxLen > 2000) {
            log.warn(`VectFox: Large chunk detected (${maxLen} chars). If you see OOM errors, try reducing chunk size.`);
            log.warn(`VectFox: Problematic chunk preview: "${(items[longestChunkIndex]?.text || '').substring(0, 100)}..."`);
        }

        try {
            // Try plugin API first (supports metadata) - fallback to native API if unavailable
            log.verbose('VectFox DEBUG: this.pluginAvailable =', this.pluginAvailable);
            let usePluginApi = this.pluginAvailable;
            let endpoint = usePluginApi ? '/api/plugins/similharity/chunks/insert' : '/api/vector/insert';

            log.verbose(`VectFox DEBUG: Using ${usePluginApi ? 'PLUGIN' : 'NATIVE'} API for insertion (${endpoint})`);
            
            // Warn if keywords will be lost
            if (!usePluginApi && chunksWithKeywords > 0) {
                log.warn(`⚠️ VectFox: ${chunksWithKeywords} chunks have keywords, but native ST API doesn't support metadata!`);
                log.warn(`⚠️ VectFox: Install the Similharity plugin to save keywords: https://github.com/SillyTavern/SillyTavern-Extras-Similharity-plugin`);
            }

            const payload = usePluginApi ? {
                backend: 'vectra',
                collectionId: collectionId,
                items: items.map(item => {
                    const mappedItem = {
                        hash: item.hash,
                        text: item.text || '',
                        index: item.index ?? 0,
                        vector: item.vector,
                        metadata: {
                            ...item.metadata,
                            keywords: item.keywords || [],
                            importance: item.importance,
                            conditions: item.conditions,
                            isSummaryChunk: item.isSummaryChunk,
                            parentHash: item.parentHash,
                        },
                    };
                    // Debug: Log first item's metadata
                    if (item === items[0] && item.keywords?.length > 0) {
                        log.verbose(`VectFox DEBUG: First item metadata being sent:`, mappedItem.metadata);
                    }
                    return mappedItem;
                }),
                source: settings.embedding_provider || 'transformers',
                model: model,
                ...providerParams,
            } : {
                collectionId: collectionId,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text || '',
                    index: item.index ?? 0,
                })),
                source: settings.embedding_provider || 'transformers',
                model: model,
                // Pass embeddings if pre-computed (for webllm, koboldcpp)
                embeddings: items[0]?.vector ? Object.fromEntries(items.map(i => [
                    i.text || '',
                    i.vector
                ])) : undefined,
                ...providerParams,
            };

            // DEBUG: capture body size and per-field breakdown so we can pin
            // down where a runaway-large insert body is coming from.
            const bodyJson = JSON.stringify(payload);
            const sizeKB = (bodyJson.length / 1024).toFixed(1);
            const sizeMB = (bodyJson.length / (1024 * 1024)).toFixed(2);
            const firstItem = payload.items?.[0];
            const fieldSizes = firstItem
                ? Object.fromEntries(
                    Object.entries(firstItem).map(([k, v]) => [
                        k,
                        JSON.stringify(v ?? null).length,
                    ])
                )
                : {};
            const metadataFieldSizes = firstItem?.metadata
                ? Object.fromEntries(
                    Object.entries(firstItem.metadata).map(([k, v]) => [
                        k,
                        JSON.stringify(v ?? null).length,
                    ])
                )
                : {};
            log.verbose(
                `VectFox DEBUG: insert body = ${sizeKB} KB (${sizeMB} MB), ` +
                `source="${payload.source}", model="${payload.model}", ` +
                `backend="${payload.backend}", ` +
                `items=${payload.items?.length || 0}, ` +
                `first item field sizes:`, fieldSizes,
                `metadata field sizes:`, metadataFieldSizes
            );
            if (bodyJson.length > 500 * 1024) {
                log.warn(`VectFox DEBUG: ⚠️ insert body exceeds 500 KB — dumping first 1000 chars: ${bodyJson.slice(0, 1000)}`);
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: abortSignal
                    ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)])
                    : AbortSignal.timeout(120000),
                body: bodyJson,
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                // The plugin embeds server-side, so a retired/unknown embedding model
                // surfaces here in the forwarded body — often wrapped as 500, hence
                // enforceStatusGate:false. Surface it instead of silently failing ingestion.
                throwIfModelConfigError({
                    contextLabel: 'Embedding',
                    provider: settings.embedding_provider,
                    model,
                    status: response.status,
                    responseText: errorBody,
                    enforceStatusGate: false,
                });
                throw new Error(`Failed to insert vectors: ${response.status} - ${errorBody} (sent body size: ${sizeKB} KB)`);
            }

            log.verbose(`VectFox Standard: Inserted ${items.length} vectors into ${collectionId}`);
        } catch (error) {
            // Enhanced error logging for OOM debugging
            const isOOM = error.message?.includes('OrtRun') || error.message?.includes('error code = 6');
            if (isOOM) {
                log.error(`VectFox: ONNX OOM Error while embedding. Diagnostics:`);
                log.error(`  - Provider: ${settings.embedding_provider}`);
                log.error(`  - Model: ${model || '(default)'}`);
                log.error(`  - Batch size: ${items.length} chunks`);
                log.error(`  - Largest chunk: ${maxLen} chars (index ${longestChunkIndex})`);
                log.error(`  - Average chunk: ${avgLen} chars`);
                log.error(`  - Tip: Try reducing chunk size in settings, or use a smaller embedding model`);
            }
            throw error;
        }
    }

    /**
     * Delete vector items from a collection
     * Uses native ST API
     */
    async deleteVectorItems(collectionId, hashes, settings) {
        const model = getModelFromSettings(settings);
        const source = settings.embedding_provider || 'transformers';

        // Strip backend prefix from registry keys (same as queryCollection)
        const knownBackends = ['standard', 'vectra', 'qdrant'];
        const parts = collectionId.split(':');
        let bareCollectionId = collectionId;
        if (parts.length >= 2 && knownBackends.includes(parts[0])) {
            bareCollectionId = parts.slice(1).join(':');
        }

        // Storage path is vectors/{source}/{collectionId}/{model}/. Both the plugin
        // and ST's native /api/vector/delete honor `model` when it's in the body —
        // mirror the insertVectorItems/getSavedHashes payload shape so delete lands
        // in the same partition the insert wrote to.
        // This fix exists on `main` (commit bcc4302) but was lost in Dev during
        // merge `e9ed4c5`. TEST 009 catches the regression — re-applied 2026-05-23.
        if (this.pluginAvailable) {
            const response = await fetch('/api/plugins/similharity/chunks/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    backend: 'vectra',
                    collectionId: bareCollectionId,
                    hashes,
                    source,
                    model,
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                throw new Error(`Failed to delete vectors (plugin): ${response.status} ${response.statusText} - ${errorBody}`);
            }
            return;
        }

        // Fallback: native ST API
        const providerParams = getProviderSpecificParams(settings, false);
        const response = await fetch('/api/vector/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: bareCollectionId,
                hashes: hashes,
                source,
                model,
                ...providerParams,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to delete vectors: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    /**
     * Query a collection for similar vectors
     * Uses native ST API
     */
    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        const model = getModelFromSettings(settings);
        const source = settings.embedding_provider || 'transformers';
        const threshold = settings.score_threshold || 0.0;

        // Registry keys arrive as "backend:collectionId". Strip the backend prefix
        // to get the bare ID the Similharity plugin expects.
        const knownBackends = ['standard', 'vectra', 'qdrant'];
        const parts = collectionId.split(':');
        let bareCollectionId = collectionId;
        if (parts.length >= 2 && knownBackends.includes(parts[0])) {
            bareCollectionId = parts.slice(1).join(':');
        }

        // When the Similharity plugin is available, data was inserted via the plugin's
        // path: vectors/{source}/{collectionId}/{model}/
        // The native ST /api/vector/query does NOT include the model subfolder, so it
        // looks at the wrong path and always returns 0 results.
        // Route queries through the plugin so they use the same storage path.
        if (this.pluginAvailable) {
            const pluginBody = {
                backend: 'vectra',
                collectionId: bareCollectionId,
                topK,
                threshold,
                source,
                model,
                // Pass provider params (apiUrl for url-based sources like vllm/
                // ollama/llamacpp) so the plugin embeds the searchText against the
                // user's configured endpoint instead of falling back to localhost.
                // Without this the plugin defaulted to http://localhost:8000, which
                // hit SillyTavern itself and failed CSRF (GitHub issue #7). Matches
                // the insert path and the qdrant backend's query body.
                ...getProviderSpecificParams(settings, true),
            };
            // Pass pre-computed vector when available; otherwise let the plugin generate it
            if (queryVector) {
                pluginBody.queryVector = queryVector;
            } else {
                pluginBody.searchText = searchText;
            }

            log.verbose(`[VectFox] queryCollection via plugin: collectionId=${bareCollectionId}, source=${source}, model=${model}, topK=${topK}, threshold=${threshold}, hasQueryVector=${!!queryVector}`);

            const response = await fetch('/api/plugins/similharity/chunks/query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(pluginBody),
            });

            log.verbose(`[VectFox] plugin query response: status=${response.status} ok=${response.ok}`);

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                log.error(`[VectFox] plugin query failed: ${errorBody}`);
                throwIfModelConfigError({
                    contextLabel: 'Embedding',
                    provider: settings.embedding_provider,
                    model,
                    status: response.status,
                    responseText: errorBody,
                    enforceStatusGate: false,
                });
                throw new Error(`Failed to query collection (plugin): ${response.status} ${response.statusText} - ${errorBody}`);
            }

            const data = await response.json();
            log.verbose(`[VectFox] plugin query result: count=${data.count}, results.length=${data.results?.length}, embed=${data.timings?.embedMs ?? 'n/a'}ms, query=${data.timings?.queryMs ?? 'n/a'}ms, error=${data.error || 'none'}`);
            warnIfEmbeddingSlow(data.timings?.embedMs, settings, 'query');

            // Plugin returns { success, results: [{ hash, score, text, metadata }] }
            const results = data.results || [];
            return {
                hashes: results.map(r => r.hash),
                metadata: results.map(r => ({
                    ...r.metadata,
                    hash: r.hash,
                    text: r.text ?? r.metadata?.text,
                    score: r.score || 0,
                })),
            };
        }

        // Fallback: native ST API (used when plugin is not available)
        // Note: does NOT include model subfolder — only works for collections
        // vectorized via the native API.
        const providerParams = getProviderSpecificParams(settings, true);
        const requestBody = {
            collectionId: bareCollectionId,
            searchText,
            topK,
            threshold,
            source,
            model,
            ...providerParams,
        };

        if (queryVector) {
            requestBody.embeddings = { [searchText]: queryVector };
        }

        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throwIfModelConfigError({
                contextLabel: 'Embedding',
                provider: settings.embedding_provider,
                model,
                status: response.status,
                responseText: errorBody,
                enforceStatusGate: false,
            });
            throw new Error(`Failed to query collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Native API returns { hashes: [], metadata: [] }
        return {
            hashes: data.hashes || [],
            metadata: (data.metadata || []).map((m, idx) => ({
                hash: data.hashes?.[idx],
                text: m.text,
                score: m.score || 0,
                ...m,
            })),
        };
    }

    /**
     * Query multiple collections
     * Uses native ST API
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        const providerParams = getProviderSpecificParams(settings, true);
        const model = getModelFromSettings(settings);

        const requestBody = {
            collectionIds: collectionIds,
            searchText: searchText,
            topK: topK,
            threshold: threshold,
            source: settings.embedding_provider || 'transformers',
            model: model,
            ...providerParams,
        };

        if (queryVector) {
            requestBody.embeddings = { [searchText]: queryVector };
        }

        const response = await fetch('/api/vector/query-multi', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            // Fallback: query each collection individually
            log.warn('VectFox: query-multi failed, falling back to individual queries');
            const results = {};
            const errors = [];
            for (const collectionId of collectionIds) {
                try {
                    results[collectionId] = await this.queryCollection(collectionId, searchText, topK, settings, queryVector);
                } catch (e) {
                    log.error(`VectFox: Query failed for collection ${collectionId}:`, e.message);
                    errors.push(`${collectionId}: ${e.message}`);
                    results[collectionId] = { hashes: [], metadata: [], error: e.message };
                }
            }
            if (errors.length > 0) {
                log.error(`VectFox: ${errors.length} collection(s) failed to query:`, errors);
            }
            return results;
        }

        return await response.json();
    }

    /**
     * Purge (delete) a collection
     * Uses native ST API
     */
    /**
     * ╔══════════════════════════════════════════════════════════════════╗
     * ║  TEST-ONLY helper — do NOT call from production code paths       ║
     * ╚══════════════════════════════════════════════════════════════════╝
     *
     * Aggressively remove a collection's entire on-disk folder under
     * `/data/{handle}/vectors/{source}/{collectionId}/`.
     *
     * Why this exists separately from purgeVectorIndex:
     *   - The Similharity plugin's purge handler at index.js calls
     *     `store.deleteIndex()` which only removes the index files inside
     *     `{collectionId}/{model}/`. The parent `{collectionId}/` folder
     *     remains empty on disk after a normal purge.
     *   - Production doesn't care (queries skip empty folders), but the
     *     Playwright suite leaves 30+ orphan folders per session that ST's
     *     plugin scan then rediscovers as zero-chunk collections, polluting
     *     the registry and slowing down subsequent runs.
     *   - Tests need a way to leave NO trace. Production must NOT change
     *     behavior (the only-models-subdir purge is the agreed contract).
     *
     * What this helper does:
     *   1. Runs the normal plugin purge to drop the model subdir.
     *   2. Calls ST's native /api/vector/purge as a finisher. Depending on
     *      ST version this may or may not drop the parent folder — we call
     *      it best-effort and don't fail the helper if it 404s.
     *
     * Only `tests/Eventbase-test.spec.js` should call this. Marked with a
     * leading underscore + explicit `forTestCleanup` suffix so the intent is
     * unambiguous in any code review.
     *
     * @param {string} collectionId - bare collection ID (no `backend:` prefix)
     * @param {object} settings - VectFox settings (source + model)
     * @returns {Promise<{pluginOk: boolean, nativeOk: boolean}>}
     */
    async _purgeCollectionFolderForTestCleanup(collectionId, settings) {
        const result = { pluginOk: false, nativeOk: false };

        // Step 1: standard plugin-side purge (removes the model subdir).
        try {
            await this.purgeVectorIndex(collectionId, settings);
            result.pluginOk = true;
        } catch (e) {
            log.warn(`[test cleanup] plugin purgeVectorIndex failed for ${collectionId}: ${e.message}`);
        }

        // Step 2: ST native /api/vector/purge as a finisher. Best-effort —
        // some ST versions drop the parent folder, some don't. Either way
        // it's the highest leverage we have without adding a new plugin
        // endpoint or filesystem permissions.
        try {
            const response = await fetch('/api/vector/purge', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ collectionId }),
            });
            result.nativeOk = response.ok;
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                log.warn(`[test cleanup] native /api/vector/purge ${response.status} for ${collectionId}: ${body.slice(0, 120)}`);
            }
        } catch (e) {
            log.warn(`[test cleanup] native purge fetch failed for ${collectionId}: ${e.message}`);
        }

        return result;
    }

    async purgeVectorIndex(collectionId, settings) {
        // Prefer the Similharity plugin's purge endpoint when available — it knows
        // about the `{source}/{collectionId}/{model}/` path layout that ST's
        // native /api/vector/purge does not. When the DB Browser passes
        // `_discoveredModels` (from the plugin's collection discovery), iterate
        // every model subdir so the on-disk dirs are actually deleted; otherwise
        // the collection re-appears on the next discovery scan.
        if (this.pluginAvailable) {
            const source = settings.embedding_provider || 'transformers';
            const discoveredModels = Array.isArray(settings._discoveredModels) && settings._discoveredModels.length > 0
                ? settings._discoveredModels.map(m => m?.path ?? m ?? '')
                : [getModelFromSettings(settings)];

            const errors = [];
            for (const model of discoveredModels) {
                try {
                    const response = await fetch('/api/plugins/similharity/chunks/purge', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({
                            backend: 'vectra',
                            collectionId,
                            source,
                            model,
                        }),
                    });
                    if (!response.ok) {
                        const errBody = await response.text().catch(() => 'No response body');
                        errors.push(`model="${model}": ${response.status} ${errBody}`);
                    }
                } catch (e) {
                    errors.push(`model="${model}": ${e.message}`);
                }
            }
            if (errors.length === discoveredModels.length) {
                // All purge attempts failed — surface the error
                throw new Error(`Failed to purge collection via plugin: ${errors.join('; ')}`);
            }
            if (errors.length > 0) {
                log.warn(`VectFox Standard: partial purge of ${collectionId}:`, errors);
            }
            return;
        }

        // Fallback (no plugin): ST's native purge endpoint. Note this does NOT
        // understand the model subdirectory layout, so it may leave orphan files
        // when the collection was created by the plugin path.
        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to purge collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    /**
     * Purge all vector indexes
     * Uses native ST API
     */
    async purgeAllVectorIndexes(settings) {
        const response = await fetch('/api/vector/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to purge all: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    // ========================================================================
    // EXTENDED API METHODS (plugin-only, graceful fallback)
    // ========================================================================

    /**
     * List chunks with pagination (plugin-only feature)
     * Falls back to basic hash list if plugin unavailable
     */
    async listChunks(collectionId, settings, options = {}) {
        if (this.pluginAvailable) {
            try {
                const response = await fetch('/api/plugins/similharity/chunks/list', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: 'vectra',
                        collectionId: collectionId,
                        source: settings.embedding_provider || 'transformers',
                        model: getModelFromSettings(settings),
                        offset: options.offset || 0,
                        limit: options.limit || 100,
                        includeVectors: options.includeVectors || false,
                    }),
                });

                if (response.ok) {
                    return await response.json();
                }
                // Split the !ok path: 4xx is misconfiguration (wrong route,
                // bad params, plugin version skew) — fail loud so the DB
                // Browser shows a real error instead of silently rendering
                // empty rows for collections that actually have data. 5xx
                // is treated as a transient plugin outage — warn and fall
                // back to native list (hashes only) so the UI stays usable.
                const errBody = await response.text().catch(() => '<no body>');
                if (response.status >= 400 && response.status < 500) {
                    // Log BEFORE throwing so the failure leaves a console trace
                    // even if the throw is caught silently upstream. This branch
                    // hasn't been triggered in regression testing yet — keep the
                    // log loud so a real 4xx in the wild is unmissable.
                    log.error(`VectFox: Plugin listChunks ${response.status} ${response.statusText} for ${collectionId} — failing loud (misconfiguration / version skew suspected). Body: ${errBody.slice(0, 500)}`);
                    throw new Error(`Plugin listChunks ${response.status} ${response.statusText} for ${collectionId}: ${errBody.slice(0, 200)}`);
                }
                log.warn(`VectFox: Plugin listChunks returned ${response.status} ${response.statusText} — falling back to native (hashes only). Body: ${errBody.slice(0, 200)}`);
            } catch (e) {
                // Re-throw the 4xx error we raised above; only swallow real
                // network/transport failures (fetch reject, timeout, etc.)
                // which match the "transient outage" graceful-degrade case.
                if (e?.message?.startsWith('Plugin listChunks 4')) throw e;
                log.warn('VectFox: Plugin listChunks threw, using native fallback:', e.message);
            }
        }

        // Fallback: use native list (hashes only)
        const hashes = await this.getSavedHashes(collectionId, settings);
        return {
            items: hashes.map(hash => ({ hash, text: '', metadata: {} })),
            total: hashes.length,
        };
    }

    /**
     * Get a single chunk by hash (plugin-only feature)
     * Returns null if plugin unavailable
     */
    async getChunk(collectionId, hash, settings) {
        if (!this.pluginAvailable) return null;

        try {
            const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
                backend: 'vectra',
                collectionId: collectionId,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }), {
                headers: getRequestHeaders(),
            });

            if (response.ok) {
                const data = await response.json();
                return data.chunk;
            }
        } catch (e) {
            log.warn('VectFox: Plugin getChunk failed');
        }

        return null;
    }

    /**
     * Update chunk text (plugin-only feature)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        if (!this.pluginAvailable) {
            throw new Error('Chunk text editing requires the Similharity plugin');
        }

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId: collectionId,
                text: newText,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to update chunk text: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (plugin-only feature)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        if (!this.pluginAvailable) {
            throw new Error('Chunk metadata editing requires the Similharity plugin');
        }

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId: collectionId,
                metadata: metadata,
                source: settings.embedding_provider || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to update chunk metadata: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics (plugin-only feature)
     * Falls back to basic count if plugin unavailable
     */
    async getStats(collectionId, settings) {
        if (this.pluginAvailable) {
            try {
                const response = await fetch('/api/plugins/similharity/chunks/stats', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: 'vectra',
                        collectionId: collectionId,
                        source: settings.embedding_provider || 'transformers',
                        model: getModelFromSettings(settings),
                    }),
                });

                if (response.ok) {
                    const data = await response.json();
                    return data.stats;
                }
            } catch (e) {
                log.warn('VectFox: Plugin getStats failed, using native fallback');
            }
        }

        // Fallback: just return count from hash list
        const hashes = await this.getSavedHashes(collectionId, settings);
        return {
            count: hashes.length,
            source: 'native',
        };
    }

}
