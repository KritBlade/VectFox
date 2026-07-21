/**
 * Similharity Server Plugin
 *
 * Unified vector database backend for VectFox extension.
 * Supports multiple backends: Vectra (file-based), Qdrant
 *
 * All chunk operations go through unified /chunks/* endpoints.
 * Backend is specified via `backend` parameter in request body.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEPLOYMENT SCOPE — INTENDED FOR LOCAL / LAN USE ONLY
 * ─────────────────────────────────────────────────────────────────────────
 * This plugin is designed for a single-user SillyTavern installation on
 * the user's own machine (or a private LAN). It is NOT designed for:
 *   - Public-internet exposure
 *   - Multi-tenant deployments (shared by untrusted users)
 *   - Hostile-input environments where the user does not control the
 *     embedding-server URLs configured in VectFox settings
 *
 * Several routes accept user-configured URLs (`apiUrl`, `qdrant_host`,
 * `ollama_url`, `vllm_url`) and `fetch()` them
 * server-side without host allowlisting or private-IP rejection. This is
 * INTENTIONAL — those URLs are user-configured for a reason (Ollama on
 * `127.0.0.1`, vLLM on `10.0.1.50`, etc.).
 *
 * Plugin-level SSRF defense would be security theater here. The real
 * trust boundary is the network: anyone on the same LAN who can reach
 * the qdrant port directly can send arbitrary commands whether or not
 * the plugin allowlists URLs. The bigger picture is that this whole
 * project — VectFox + Similharity — is designed for PERSONAL USE, not
 * multi-user. Even Qdrant's open-source build ships without per-user
 * auth by default; the multi-user story requires Role-Based Access
 * Control (RBAC), which is way overkill for someone just trying to
 * run a SillyTavern RAG on their own PC or closed LAN. Requiring it
 * would defeat the "runs out of the box" point of this project. Both
 * decisions (plugin URL openness + no required Qdrant RBAC) are
 * intentional and aligned with the personal/LAN scope. If you deploy
 * in an environment where the network boundary doesn't hold, you need
 * BOTH layers (RBAC + plugin allowlisting) — and you'll need to bolt
 * them on yourself.
 *
 * Documented 2026-05-24 in response to external code review (H-4) —
 * see VectFox/plans/review-fix.md §H-4 for the threat-model reasoning.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * @version 3.3.3
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import sanitize from 'sanitize-filename';
import vectra from 'vectra';
import qdrantBackend from './qdrant-backend.js';

const pluginName = 'similharity';
const pluginVersion = '3.3.3';

// ─── ST secret_state bridge (server-side API key resolution) ─────────────────
// The qdrant_api_key migration (2026-05-26) moved the key out of VectFox's
// plaintext settings.json and into ST's secret_state under slot name
// 'api_key_qdrant' (a custom slot — not in ST's SECRET_KEYS enum, but
// writeSecret/readSecret accept any string key and getSecretState's enum
// filter is only on the read-to-client path, not the file-based readSecret).
//
// Client-side `secret_state.api_key_qdrant` is undefined because
// ST's getSecretState only surfaces enum-known slots. So:
//   - VectFox UI presence indicator → GET /qdrant/key-status (defined below)
//   - VectFox qdrant.js sends `apiKey: null` in /backend/init/qdrant → plugin
//     resolves the real key here via readSecret(req.user.directories, ...)
//
// Import is wrapped in try/catch because the relative path to ST's secrets
// module is fragile across ST versions / install layouts. If the import
// fails, the plugin gracefully falls back to whatever apiKey the client
// passes — meaning pre-migration clients still work, post-migration clients
// would fail with an auth error pointing them to update VectFox.
let _stReadSecret = null;
try {
    const secretsMod = await import('../../src/endpoints/secrets.js');
    _stReadSecret = secretsMod.readSecret;
    console.log(`[${pluginName}] ST secrets bridge: readSecret imported, api_key_qdrant lookup enabled`);
} catch (err) {
    console.warn(`[${pluginName}] ST secrets bridge: import failed — server-side api_key_qdrant lookup disabled. Clients still pass apiKey directly. Reason:`, err?.message || err);
}

/**
 * Read the migrated Qdrant API key from ST's secret_state.
 * Returns '' if not set or if the ST secrets bridge couldn't be imported.
 */
function _readQdrantApiKey(req) {
    if (!_stReadSecret) return '';
    try {
        return _stReadSecret(req.user.directories, 'api_key_qdrant', null) || '';
    } catch (err) {
        console.warn(`[${pluginName}] readSecret(api_key_qdrant) failed:`, err?.message || err);
        return '';
    }
}

/**
 * Mask an API key for safe client-side display. Mirrors the masking pattern
 * ST uses for non-EXPORTABLE secrets — last 4 chars visible, rest stars.
 */
function _maskApiKey(key) {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 4) return '*'.repeat(key.length);
    return '*'.repeat(Math.min(key.length - 4, 8)) + key.slice(-4);
}

/**
 * Flatten an error to a client-safe message that preserves the underlying cause.
 *
 * Node's fetch (undici) throws a terse `TypeError: fetch failed` and hides the real
 * reason on `error.cause` — ECONNREFUSED, ENOTFOUND, a `localhost`→`::1` IPv6 miss
 * against an IPv4-only server, TLS, etc. Bubbling only `error.message` up to the
 * client left users staring at "fetch failed" with nothing to act on. Append the
 * cause message + syscall code so the toast is self-diagnosing.
 */
function formatError(error) {
    if (!error) return 'Unknown error';
    let msg = error.message || String(error);
    const cause = error.cause;
    if (cause) {
        const causeMsg = cause.message || String(cause);
        if (causeMsg && !msg.includes(causeMsg)) msg += ` (cause: ${causeMsg})`;
        if (cause.code && !msg.includes(cause.code)) msg += ` [${cause.code}]`;
    }
    return msg;
}

/**
 * Build a readable debug preview of submitted search text.
 * Uses ~100 whitespace-delimited words when available; otherwise falls back
 * to a character slice so CJK-heavy text without spaces is still visible.
 *
 * @param {string} searchText
 * @param {number} [maxWords=100]
 * @param {number} [maxChars=500]
 * @returns {string}
 */
function getSearchTextDebugSnippet(searchText, maxWords = 200, maxChars = 1000) {
    const normalized = String(searchText || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const words = normalized.split(' ');
    if (words.length >= 20) {
        return words.slice(0, maxWords).join(' ');
    }

    return normalized.slice(0, maxChars);
}

/**
 * Initialize the plugin
 * @param {import('express').Router} router - Express router for plugin endpoints
 */
export async function init(router) {
    console.log(`[${pluginName}] Initializing v${pluginVersion}...`);

    // ========================================================================
    // BACKEND HANDLER - Routes requests to appropriate backend
    // ========================================================================

    /**
     * Backend handler factory
     * @param {object} directories - User directories containing vectors path
     */
    function getBackendHandler(backend) {
        switch (backend) {
            case 'vectra':
            case 'standard':
                return {
                    type: 'vectra',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        // Apply pagination (limit=0 means no limit)
                        const offset = options.offset || 0;
                        const limit = options.limit > 0 ? options.limit : items.length;
                        const paginatedItems = items.slice(offset, offset + limit);

                        return {
                            items: paginatedItems.map(item => ({
                                hash: item.metadata.hash,
                                text: item.metadata.text,
                                index: item.metadata.index,
                                vector: options.includeVectors ? item.vector : undefined,
                                metadata: item.metadata
                            })),
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) return null;
                        return {
                            hash: item.metadata.hash,
                            text: item.metadata.text,
                            index: item.metadata.index,
                            vector: item.vector,
                            metadata: item.metadata
                        };
                    },

                    insert: async (collectionId, items, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);

                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    return { ...item, vector: vectors[vIndex++] };
                                }
                                return item;
                            });
                        }

                        await store.beginUpdate();
                        for (const item of itemsWithVectors) {
                            await store.upsertItem({
                                vector: item.vector,
                                metadata: {
                                    hash: item.hash,
                                    text: item.text,
                                    index: item.index,
                                    ...item.metadata
                                }
                            });
                        }
                        await store.endUpdate();
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Generate new embedding for the new text
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);

                        // Delete old item
                        await store.deleteItem(item.id);

                        // Insert updated item
                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: newVector,
                            metadata: {
                                ...item.metadata,
                                hash: newHash,
                                text: newText
                            }
                        });
                        await store.endUpdate();

                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Delete and re-insert with same vector but updated metadata
                        await store.deleteItem(item.id);

                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: item.vector,
                            metadata: {
                                ...item.metadata,
                                ...metadata,
                                hash: item.metadata.hash, // Preserve hash
                                text: item.metadata.text   // Preserve text
                            }
                        });
                        await store.endUpdate();

                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let deleted = 0;
                        for (const hash of hashes) {
                            const item = items.find(i => i.metadata.hash == hash);
                            if (item) {
                                await store.deleteItem(item.id);
                                deleted++;
                            }
                        }
                        return deleted;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const results = await store.queryItems(queryVector, topK);
                        return results
                            .filter(r => r.score >= threshold)
                            .map(r => ({
                                hash: r.item.metadata.hash,
                                score: r.score,
                                text: r.item.metadata.text,
                                vector: options.includeVectors ? r.item.vector : undefined,
                                metadata: r.item.metadata
                            }));
                    },

                    purge: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        if (await store.isIndexCreated()) {
                            await store.deleteIndex();
                        }
                    },

                    stats: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let totalCharacters = 0;
                        let totalTokens = 0;
                        const sources = {};
                        const messageHashes = new Set();
                        let embeddingDimensions = 0;

                        for (const item of items) {
                            const text = item.metadata.text || '';
                            totalCharacters += text.length;
                            totalTokens += Math.ceil(text.length / 4); // Rough estimate

                            const src = item.metadata.source || 'unknown';
                            sources[src] = (sources[src] || 0) + 1;

                            if (item.metadata.originalMessageHash) {
                                messageHashes.add(item.metadata.originalMessageHash);
                            }

                            if (item.vector && item.vector.length > 0) {
                                embeddingDimensions = item.vector.length;
                            }
                        }

                        // Get file size
                        const indexPath = model
                            ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model), 'index.json')
                            : path.join(directories.vectors, sanitize(source), sanitize(collectionId), 'index.json');

                        let storageSize = 0;
                        try {
                            const stat = await fs.stat(indexPath);
                            storageSize = stat.size;
                        } catch (e) {
                            // File may not exist yet, which is fine
                            console.debug(`[${pluginName}] Could not stat index file (may not exist): ${indexPath}`);
                        }

                        return {
                            chunkCount: items.length,
                            totalCharacters,
                            totalTokens,
                            storageSize,
                            embeddingDimensions,
                            avgChunkSize: items.length > 0 ? Math.round(totalCharacters / items.length) : 0,
                            messageCount: messageHashes.size,
                            sources,
                            backend: 'vectra',
                            model: model || '(default)'
                        };
                    }
                };

            case 'qdrant':
                return {
                    type: 'qdrant',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await qdrantBackend.listItems(collectionId, options.filters || {}, options);
                        // Return same format as Vectra handler for consistency.
                        // Surface a normalized `index` so the database-browser's "Sort: Message Order"
                        // works. Newly inserted items have metadata.messageIndex; older data falls back
                        // to source_window_start (EventBase) or startIndex/messageId (legacy chunks).
                        const offset = options.offset || 0;
                        const limit = options.limit > 0 ? options.limit : items.length; // limit=0 means no limit
                        const paginatedItems = items.slice(offset, offset + limit).map(item => ({
                            ...item,
                            index: item.metadata?.messageIndex
                                ?? item.metadata?.source_window_end
                                ?? item.metadata?.source_window_start
                                ?? item.metadata?.startIndex
                                ?? item.metadata?.messageId
                                ?? null,
                        }));
                        return {
                            items: paginatedItems,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getItem(collectionId, hash, filters);
                    },

                    insert: async (collectionId, items, source, model, directories, req, filters = {}) => {
                        // Extract sparse-vector flag + tokenizer-mode lock from filters before
                        // they pollute tenantMetadata.
                        const { nativeSparse = false, cjkTokenizerMode = null, ...tenantFilters } = filters;

                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[Qdrant] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    const vector = vectors[vIndex++];
                                    if (!vector || !Array.isArray(vector) || vector.length === 0) {
                                        console.error(`[Qdrant] Failed to generate valid vector for item hash=${item.hash}, source=${source}, model=${model}`);
                                        throw new Error(`Failed to generate embedding for item. Source: ${source}, Model: ${model}`);
                                    }
                                    return { ...item, vector };
                                }
                                return item;
                            });
                        }

                        // Pass source and model for embedding tracking
                        await qdrantBackend.insertVectors(collectionId, itemsWithVectors, {
                            ...tenantFilters,
                            embeddingSource: source,
                            embeddingModel: model,
                        }, { nativeSparse, cjkTokenizerMode });
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req, filters = {}) => {
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await qdrantBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, filters);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories, filters = {}) => {
                        await qdrantBackend.updateItemMetadata(collectionId, hash, metadata, filters);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories, filters = {}) => {
                        await qdrantBackend.deleteVectors(collectionId, hashes);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await qdrantBackend.queryVectors(collectionId, queryVector, topK, threshold, options.filters || {});
                        return results;
                    },

                    purge: async (collectionId, source, model, directories, filters = {}) => {
                        if (filters && Object.keys(filters).length > 0) {
                            // Multitenancy mode: delete specific points by filter (e.g. sourceId)
                            await qdrantBackend.purgeCollection(collectionId, filters);
                        } else {
                            // Separate-collection mode: delete the entire qdrant collection container
                            await qdrantBackend.purgeAll(collectionId);
                        }
                    },

                    stats: async (collectionId, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getCollectionStats(collectionId, filters);
                    }
                };

            default:
                throw new Error(`Unknown backend: ${backend}`);
        }
    }

    // ========================================================================
    // UTILITY ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/health
     * Overall plugin health check
     */
    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            plugin: pluginName,
            version: pluginVersion,
            backends: ['vectra', 'qdrant']
        });
    });

    /**
     * GET /api/plugins/similharity/version
     * Return plugin version for cross-repo version checking
     */
    router.get('/version', (req, res) => {
        res.json({ pluginVersion });
    });

    /**
     * GET /api/plugins/similharity/collections
     * Lists ALL collections across ALL backends
     */
    router.get('/collections', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const { collections: allCollections, qdrantScanned } = await scanAllSourcesForCollections(vectorsPath);

            res.json({
                success: true,
                count: allCollections.length,
                collections: allCollections,
                qdrantScanned,
            });
        } catch (error) {
            console.error(`[${pluginName}] collections error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * GET /api/plugins/similharity/sources
     * Lists available embedding sources
     */
    router.get('/sources', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const entries = await fs.readdir(vectorsPath, { withFileTypes: true });
            const sources = entries.filter(e => e.isDirectory()).map(e => e.name);

            res.json({ success: true, sources });
        } catch (error) {
            console.error(`[${pluginName}] sources error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/get-embedding
     * Get embedding for single text
     */
    router.post('/get-embedding', async (req, res) => {
        try {
            const { text, source, model = '' } = req.body;

            if (!text || !source) {
                return res.status(400).json({ error: 'text and source are required' });
            }

            const embedding = await getEmbeddingForSource(source, text, model, req.user.directories, req);
            res.json({ success: true, embedding });

        } catch (error) {
            console.error(`[${pluginName}] get-embedding error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/batch-embeddings
     * Get embeddings for multiple texts
     */
    router.post('/batch-embeddings', async (req, res) => {
        try {
            const { texts, source, model = '' } = req.body;

            if (!texts || !Array.isArray(texts) || !source) {
                return res.status(400).json({ error: 'texts array and source are required' });
            }

            const embeddings = await getVectorsForSource(source, texts, model, req.user.directories, req);
            res.json({ success: true, embeddings });

        } catch (error) {
            console.error(`[${pluginName}] batch-embeddings error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    // ========================================================================
    // BACKEND MANAGEMENT ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/backend/health/:backend
     * Health check for specific backend
     */
    router.get('/backend/health/:backend', async (req, res) => {
        try {
            const { backend } = req.params;
            let healthy = false;
            let message = '';

            switch (backend) {
                case 'vectra':
                case 'standard':
                    healthy = true;
                    message = 'Vectra is always available (file-based)';
                    break;

                case 'qdrant':
                    healthy = await qdrantBackend.healthCheck();
                    message = healthy ? 'Qdrant connected' : 'Qdrant not available';
                    break;

                default:
                    return res.status(400).json({ error: `Unknown backend: ${backend}` });
            }

            res.json({ backend, healthy, message });

        } catch (error) {
            console.error(`[${pluginName}] backend/health error:`, error);
            res.status(500).json({ backend: req.params.backend, healthy: false, error: formatError(error) });
        }
    });

    /**
     * GET /api/plugins/similharity/qdrant/key-status
     *
     * Presence indicator for the Qdrant API key in ST's secret_state slot
     * `api_key_qdrant`. The slot name is custom (not in ST's SECRET_KEYS
     * enum), so client-side `secret_state.api_key_qdrant` is always
     * undefined — VectFox's UI calls this endpoint to render the
     * "Key saved: *****xyz" placeholder. Real key value never leaves the
     * server; only the masked last-4 suffix is returned.
     *
     * Response: { set: boolean, masked: string }
     */
    router.get('/qdrant/key-status', async (req, res) => {
        try {
            const apiKey = _readQdrantApiKey(req);
            if (!apiKey) {
                return res.json({ set: false, masked: '' });
            }
            return res.json({ set: true, masked: _maskApiKey(apiKey) });
        } catch (error) {
            console.error(`[${pluginName}] /qdrant/key-status error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/backend/init/:backend
     * Initialize specific backend
     */
    router.post('/backend/init/:backend', async (req, res) => {
        try {
            const { backend } = req.params;
            let config = req.body;

            switch (backend) {
                case 'vectra':
                case 'standard':
                    res.json({ success: true, message: 'Vectra requires no initialization' });
                    break;

                case 'qdrant':
                    // Post-2026-05-26 migration: VectFox client sends apiKey:null
                    // for cloud mode and relies on the plugin to resolve the
                    // real key from ST's secret_state slot api_key_qdrant.
                    // Pre-migration clients still pass apiKey directly — that
                    // takes precedence, no behavior change for them.
                    if (config && config.apiKey == null && config.url) {
                        const serverKey = _readQdrantApiKey(req);
                        if (serverKey) {
                            config = { ...config, apiKey: serverKey };
                        }
                    }
                    await qdrantBackend.initialize(config);
                    res.json({ success: true, message: 'Qdrant initialized' });
                    break;

                default:
                    return res.status(400).json({ error: `Unknown backend: ${backend}` });
            }

        } catch (error) {
            console.error(`[${pluginName}] backend/init error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

/**
 * Get multiple embeddings for texts from specified source
 */
async function getVectorsForSource(source, texts, model, directories, req) {
    // API-based sources fall into two groups:
    //
    // 1. OpenAI-compatible (openai/openrouter/togetherai/mistral/electronhub):
    //    the /embeddings endpoint accepts `input` as an array of strings and
    //    returns N vectors in ONE request. ST's getOpenAIBatchVector already
    //    wraps this. Use it — one batched request is dramatically faster than
    //    N parallel single-input requests because providers rate-limit per
    //    request (not per input), and the embedding model runs once on a
    //    padded batch internally (~free for moderate sizes). Empirical: 8
    //    embeddings via parallel single-input ≈ 22s wall; same 8 via one
    //    batched call ≈ 3-5s. Benefits both vectra and qdrant backends.
    //
    // 2. Other API providers (nomicai, cohere): no shared batch-endpoint
    //    wrapper available, so fall through to parallel single-input via
    //    Promise.all. Wall-time savings vs. fully serial, but no rate-limit
    //    consolidation.
    //
    // Local GPU sources (transformers, ollama, llamacpp, koboldcpp) serialize
    // on the model, so parallel JS calls just queue. Default branch below
    // keeps them sequential to avoid OOM.
    const openaiCompatible = new Set(['openai', 'openrouter', 'togetherai', 'mistral', 'electronhub']);
    if (openaiCompatible.has(source)) {
        const { getOpenAIBatchVector } = await import('../../src/vectors/openai-vectors.js');
        // ElectronHub requires a model name; mirror the _getLegacySingleEmbedding default
        const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
        // Conservative cap — OpenAI's /embeddings allows arrays up to 2048
        // entries, but staying at 100 keeps any single request small enough
        // that timeouts/retries don't waste much work.
        const BATCH_SIZE = 100;
        const results = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const slice = texts.slice(i, i + BATCH_SIZE);
            const vectors = await getOpenAIBatchVector(slice, source, directories, effectiveModel);
            results.push(...vectors);
        }
        return results;
    }

    const parallelSources = new Set(['nomicai', 'cohere']);
    if (parallelSources.has(source)) {
        return await Promise.all(texts.map(text => _getLegacySingleEmbedding(source, text, model, directories, req)));
    }

    // Default fallback: sequential processing for local/GPU sources
    const results = [];
    for (const text of texts) {
        results.push(await _getLegacySingleEmbedding(source, text, model, directories, req));
    }
    return results;
}

/**
 * Helper function for KoboldCpp embedding generation
 * @param {string} text - Text to embed
 * @param {string} model - Model name
 * @param {object} req - Request object containing apiUrl
 * @returns {Promise<number[]>} Embedding vector
 */
async function _getKoboldCppEmbedding(text, model, req) {
    const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:5001';

    let url;
    try {
        url = new URL(apiUrl);
        // Ensure we're hitting the embeddings endpoint
        if (!url.pathname.includes('/embeddings')) {
            url.pathname = url.pathname.replace(/\/?$/, '/v1/embeddings').replace(/\/+/g, '/');
        }
    } catch (e) {
        throw new Error(`KoboldCpp: Invalid URL format "${apiUrl}" - ${e.message}`);
    }

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            input: text,
            model: model || 'koboldcpp',
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KoboldCpp: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    // OpenAI format: { data: [{ embedding: [...] }] }
    if (data?.data?.[0]?.embedding) {
        return data.data[0].embedding;
    }
    // Fallback: direct embedding array
    if (Array.isArray(data?.embedding)) {
        return data.embedding;
    }
    throw new Error('KoboldCpp: Invalid response format - no embedding found');
}

/**
 * vLLM embedding that respects an explicit apiKey from the request body.
 * Falls back to ST additional-headers auth when no apiKey is provided.
 */
async function _getVllmEmbedding(text, apiUrl, model, apiKey, directories) {
    if (!apiKey) {
        const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
        return await getVllmVector(text, apiUrl, model, directories);
    }
    const { trimV1 } = await import('../../src/util.js');
    const urlJoinModule = await import('url-join');
    const urlJoin = urlJoinModule.default;
    const url = new URL(urlJoin(trimV1(apiUrl), '/v1/embeddings'));
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: [text], model }),
    });
    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`VLLM: Failed to get vector for text: ${response.statusText} ${responseText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) {
        throw new Error('VLLM: API response was not an array');
    }
    data.data.sort((a, b) => a.index - b.index);
    return data.data[0].embedding;
}

/**
 * Legacy single embedding function (renamed)
 */
async function _getLegacySingleEmbedding(source, text, model, directories, req) {
    switch (source) {
        case 'transformers': {
            const { getTransformersVector } = await import('../../src/vectors/embedding.js');
            return await getTransformersVector(text);
        }
        case 'openai':
        case 'togetherai':
        case 'mistral':
        case 'electronhub':
        case 'openrouter': {
            const { getOpenAIVector } = await import('../../src/vectors/openai-vectors.js');
            // ElectronHub requires a model name, provide default if empty
            const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
            return await getOpenAIVector(text, source, directories, effectiveModel);
        }
        case 'nomicai': {
            const { getNomicAIVector } = await import('../../src/vectors/nomicai-vectors.js');
            return await getNomicAIVector(text, source, directories);
        }
        case 'cohere': {
            const { getCohereVector } = await import('../../src/vectors/cohere-vectors.js');
            return await getCohereVector(text, true, directories, model);
        }
        case 'koboldcpp': {
            return await _getKoboldCppEmbedding(text, model, req);
        }
        case 'ollama': {
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:11434';
            const apiKey = req.body?.apiKey || '';
            const keep = req.body?.keep || false;
            if (!apiKey) {
                const { getOllamaVector } = await import('../../src/vectors/ollama-vectors.js');
                return await getOllamaVector(text, apiUrl, model, keep, directories);
            }
            const ollamaUrl = new URL('/api/embeddings', apiUrl.replace(/\/$/, ''));
            const ollamaResp = await fetch(ollamaUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model, prompt: text, keep_alive: keep ? -1 : undefined }),
            });
            if (!ollamaResp.ok) {
                const errText = await ollamaResp.text();
                throw new Error(`Ollama: Failed to get vector: ${ollamaResp.statusText} ${errText}`);
            }
            const ollamaData = await ollamaResp.json();
            if (!Array.isArray(ollamaData?.embedding)) throw new Error('Ollama: API response missing embedding array');
            return ollamaData.embedding;
        }
        case 'llamacpp': {
            const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:8080';
            return await getLlamaCppVector(text, apiUrl, directories);
        }
        case 'vllm': {
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:8000';
            const apiKey = req.body?.apiKey || '';
            if (req.body?.hybridOptions?.eventbaseDebug || req.body?.options?.eventbaseDebug) console.log(`[similharity] DEBUG vllm embed: apiUrl="${apiUrl}", model="${model}", hasKey=${!!apiKey}`);
            if (!apiKey) {
                const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
                return await getVllmVector(text, apiUrl, model, directories);
            }
            const { trimV1 } = await import('../../src/util.js');
            const urlJoinMod = await import('url-join');
            const urlJoin2 = urlJoinMod.default;
            const vllmUrl = new URL(urlJoin2(trimV1(apiUrl), '/v1/embeddings'));
            const vllmResp = await fetch(vllmUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ input: [text], model }),
            });
            if (!vllmResp.ok) {
                const errText = await vllmResp.text();
                throw new Error(`VLLM: Failed to get vector for text: ${vllmResp.statusText} ${errText}`);
            }
            const vllmData = await vllmResp.json();
            if (!Array.isArray(vllmData?.data)) throw new Error('VLLM: API response was not an array');
            vllmData.data.sort((a, b) => a.index - b.index);
            return vllmData.data[0].embedding;
        }
        case 'palm':
        case 'vertexai': {
            const googleVectors = await import('../../src/vectors/google-vectors.js');
            if (source === 'palm') {
                return await googleVectors.getMakerSuiteVector(text, model, req);
            } else {
                return await googleVectors.getVertexVector(text, model, req);
            }
        }
        case 'extras': {
            const { getExtrasVector } = await import('../../src/vectors/extras-vectors.js');
            const extrasUrl = req.body?.extrasUrl || 'http://127.0.0.1:5100';
            const extrasKey = req.body?.extrasKey || '';
            return await getExtrasVector(text, extrasUrl, extrasKey);
        }
        default:
            throw new Error(`Unknown vector source: ${source}`);
    }
}

    // ========================================================================
    // UNIFIED CHUNK ENDPOINTS
    // ========================================================================

    /**
     * POST /api/plugins/similharity/chunks/list
     * List all chunks in a collection with pagination
     * Body: { backend, collectionId, source?, model?, offset?, limit?, includeVectors?, filters? }
     */
    router.post('/chunks/list', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                offset = 0,
                limit = 0,
                includeVectors = false,
                scrollLimit,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            const handler = getBackendHandler(backend);
            const result = await handler.list(collectionId, source, model, req.user.directories, {
                offset,
                limit,
                includeVectors,
                scrollLimit,
                filters
            });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/list error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * GET /api/plugins/similharity/chunks/:hash
     * Get single chunk by hash
     * Query: backend, collectionId, source?, model?
     */
    router.get('/chunks/:hash', async (req, res) => {
        try {
            const { hash } = req.params;
            const { backend = 'vectra', collectionId, source = 'transformers', model = '' } = req.query;
            // Parse filters from query string (JSON encoded)
            let filters = {};
            if (req.query.filters) {
                try {
                    filters = JSON.parse(req.query.filters);
                } catch (e) {
                    console.warn(`[${pluginName}] Invalid filters JSON:`, req.query.filters);
                }
            }

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            const handler = getBackendHandler(backend);
            const chunk = await handler.get(collectionId, hash, source, model, req.user.directories, filters);

            if (!chunk) {
                return res.status(404).json({ error: 'Chunk not found' });
            }

            res.json({ success: true, chunk });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/insert
     * Insert new chunks
     * Body: { backend, collectionId, items: [{hash, text, index, metadata?, vector?}], source?, model? }
     */
    /**
     * POST /api/plugins/similharity/chunks/collection-metadata
     * Read the sentinel metadata point for a Qdrant collection. Returns null payload
     * when the collection or sentinel does not exist. Qdrant-only.
     *
     * Body: { backend: 'qdrant', collectionId }
     */
    router.post('/chunks/collection-metadata', async (req, res) => {
        try {
            const { backend = 'qdrant', collectionId } = req.body;
            if (backend !== 'qdrant') {
                return res.json({ payload: null, supported: false });
            }
            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            const payload = await qdrantBackend.getCollectionMetadata(collectionId);
            res.json({ payload, supported: true });
        } catch (error) {
            console.error(`[${pluginName}] chunks/collection-metadata error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    router.post('/chunks/insert', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                items,
                source = 'transformers',
                model = '',
                filters = {},
                nativeSparse = false,
                cjkTokenizerMode = null,
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!items || !Array.isArray(items)) {
                return res.status(400).json({ error: 'items array is required' });
            }

            const handler = getBackendHandler(backend);
            await handler.insert(collectionId, items, source, model, req.user.directories, req, { ...filters, nativeSparse, cjkTokenizerMode });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                inserted: items.length
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/insert error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/text
     * Update chunk text (triggers re-embedding)
     * Body: { backend, collectionId, text, source?, model? }
     */
    router.patch('/chunks/:hash/text', async (req, res) => {
        try {
            const { hash } = req.params;
            const {
                backend = 'vectra',
                collectionId,
                text,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId || !text) {
                return res.status(400).json({ error: 'collectionId and text are required' });
            }

            const handler = getBackendHandler(backend);
            const result = await handler.updateText(collectionId, hash, text, source, model, req.user.directories, req, filters);

            res.json({
                success: true,
                backend: handler.type,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash/text error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/metadata
     * Update chunk metadata (no re-embedding)
     * Body: { backend, collectionId, metadata, source?, model? }
     */
    router.patch('/chunks/:hash/metadata', async (req, res) => {
        try {
            const { hash } = req.params;
            const {
                backend = 'vectra',
                collectionId,
                metadata,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId || !metadata) {
                return res.status(400).json({ error: 'collectionId and metadata are required' });
            }

            const handler = getBackendHandler(backend);
            const result = await handler.updateMetadata(collectionId, hash, metadata, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash/metadata error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/delete
     * Delete chunks by hash
     * Body: { backend, collectionId, hashes, source?, model? }
     */
    router.post('/chunks/delete', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                hashes,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!hashes || !Array.isArray(hashes)) {
                return res.status(400).json({ error: 'hashes array is required' });
            }

            const handler = getBackendHandler(backend);
            const deleted = await handler.delete(collectionId, hashes, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                deleted
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/delete error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/query
     * Query chunks by semantic similarity
     * Body: { backend, collectionId, queryVector OR searchText, topK?, threshold?, source?, model?, includeVectors? }
     */
    router.post('/chunks/query', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                queryVector,
                searchText,
                topK = 10,
                threshold = 0.0,
                source = 'transformers',
                model = '',
                includeVectors = false,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }

            const debug = !!(req.body?.eventbaseDebug || req.body?.options?.eventbaseDebug || req.body?.hybridOptions?.eventbaseDebug);

            // Get query vector if not provided
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSourceTimed(source, searchText, model, req.user.directories, req, { debug, label: 'chunks/query' });
            }

            const handler = getBackendHandler(backend);
            const tQuery = Date.now();
            const results = await handler.query(collectionId, vector, topK, threshold, source, model, req.user.directories, {
                includeVectors,
                filters
            });
            if (debug) console.log(`[similharity query] chunks/query: ${backend} query took ${Date.now() - tQuery}ms, results=${results.length}`);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                count: results.length,
                results
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/query error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/hybrid-query
     * Hybrid search combining vector similarity and keyword matching
     * Body: { backend, collectionId, searchText OR queryVector, keywords?, topK?, options?, filters?, source?, model? }
     */
    router.post('/chunks/hybrid-query', async (req, res) => {
        try {
            const {
                backend = 'qdrant',
                collectionId,
                queryVector,
                searchText,
                topK = 10,
                options = {},
                filters = {},
                source = 'transformers',
                model = '',
                hybridOptions = {},
                sparseQueryVector = null,
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }
            if (backend !== 'qdrant') {
                return res.status(400).json({ error: `Backend ${backend} does not support native hybrid query` });
            }
            if (!sparseQueryVector) {
                return res.status(400).json({ error: 'sparseQueryVector is required (collection must be sparse-enabled; run the migration tool first)' });
            }

            const mergedOptions = { ...hybridOptions, ...options };
            const debug = !!mergedOptions.eventbaseDebug;

            // Generate embedding if searchText provided.
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSourceTimed(source, searchText, model, req.user.directories, req, { debug, label: 'chunks/hybrid-query' });
            }

            const tQuery = Date.now();
            const results = await qdrantBackend.hybridQueryNative(
                collectionId,
                vector,
                sparseQueryVector,
                topK,
                {
                    fusion: 'rrf',
                    prefetchLimit: mergedOptions.prefetchLimit,
                    eventbaseDebug: debug,
                    debugQuery: debug ? searchText : undefined,
                },
                filters,
            );
            if (debug) console.log(`[similharity query] chunks/hybrid-query: qdrant query took ${Date.now() - tQuery}ms, results=${results.length}`);

            return res.json({
                success: true,
                backend: 'qdrant',
                collectionId,
                count: results.length,
                results: results.map(r => ({
                    hash: r.hash,
                    text: r.text,
                    score: r.score,
                    metadata: r.metadata,
                    nativeSparse: true,
                    fusionMethod: r.fusionMethod,
                })),
            });
        } catch (error) {
            console.error(`[${pluginName}] chunks/hybrid-query error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/hybrid-query-rerank
     *
     * Hybrid search + EventBase re-rank in one Qdrant /query call. Adds an outer
     * formula query over the existing dense + sparse + RRF prefetch that computes
     * the EventBase weighted score (cosine × $score + importance + persist + recency
     * decay) server-side, plus min-importance + dedup-depth range filters.
     *
     * Requires Qdrant 1.13+ (formula query). The qdrantBackend probes server version
     * at initialize(); if formula is not supported, the route returns 400 and the
     * VectFox-side flag falls back to the JS re-rank pipeline.
     *
     * Body: { backend, collectionId, searchText|queryVector, sparseQueryVector,
     *         rerankParams, topK?, options?, filters?, source?, model? }
     */
    router.post('/chunks/hybrid-query-rerank', async (req, res) => {
        try {
            const {
                backend = 'qdrant',
                collectionId,
                queryVector,
                searchText,
                topK = 16,
                options = {},
                filters = {},
                source = 'transformers',
                model = '',
                hybridOptions = {},
                sparseQueryVector = null,
                rerankParams = null,
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }
            if (backend !== 'qdrant') {
                return res.status(400).json({ error: `Backend ${backend} does not support native hybrid + rerank` });
            }
            if (!sparseQueryVector) {
                return res.status(400).json({ error: 'sparseQueryVector is required (collection must be sparse-enabled)' });
            }
            if (!rerankParams || typeof rerankParams !== 'object') {
                return res.status(400).json({ error: 'rerankParams object is required' });
            }
            if (!qdrantBackend.supportsFormulaQuery()) {
                return res.status(400).json({
                    error: `Qdrant ${qdrantBackend.serverVersion || '(unknown)'} does not support formula queries; requires 1.13+. Disable eventbase_native_rerank to fall back to client-side re-rank.`,
                });
            }

            const mergedOptions = { ...hybridOptions, ...options };
            const debug = !!mergedOptions.eventbaseDebug;

            // Generate dense embedding if searchText provided.
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSourceTimed(source, searchText, model, req.user.directories, req, { debug, label: 'chunks/hybrid-query-rerank' });
            }

            const tQuery = Date.now();
            const results = await qdrantBackend.hybridQueryNativeWithRerank(
                collectionId,
                vector,
                sparseQueryVector,
                topK,
                rerankParams,
                {
                    prefetchLimit: mergedOptions.prefetchLimit,
                    eventbaseDebug: debug,
                    debugQuery: debug ? searchText : undefined,
                },
                filters,
            );
            if (debug) console.log(`[similharity query] chunks/hybrid-query-rerank: qdrant query took ${Date.now() - tQuery}ms, results=${results.length}`);

            return res.json({
                success: true,
                backend: 'qdrant',
                collectionId,
                count: results.length,
                rerankApplied: true,
                results: results.map(r => ({
                    hash: r.hash,
                    text: r.text,
                    score: r.score,
                    formulaScore: r.formulaScore,
                    metadata: r.metadata,
                    nativeSparse: true,
                    rerankApplied: true,
                    fusionMethod: r.fusionMethod,
                })),
            });
        } catch (error) {
            console.error(`[${pluginName}] chunks/hybrid-query-rerank error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/ensure-eventbase-indexes
     *
     * One-time backfill: create the 6 Phase-1.5 EventBase payload indexes
     * (characters, locations, factions, concepts, items, event_type) on an
     * existing collection that was created before Phase 1.5 shipped.
     *
     * Body: { collectionId } — required.
     * Response: { ensured: true, collectionId }
     * Idempotent — createPayloadIndexes() swallows 409 Already Exists errors.
     */
    router.post('/chunks/ensure-eventbase-indexes', async (req, res) => {
        try {
            const { collectionId } = req.body;
            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            await qdrantBackend.createPayloadIndexes(collectionId);
            return res.json({ ensured: true, collectionId });
        } catch (error) {
            console.error(`[${pluginName}] chunks/ensure-eventbase-indexes error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/purge
     * Purge all chunks in a collection
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/purge', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            const handler = getBackendHandler(backend);
            await handler.purge(collectionId, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                message: `Collection ${collectionId} purged`
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/purge error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/purge-all
     * Deletes the entire vectors folder
     */
    router.post('/purge-all', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            await fs.rm(vectorsPath, { recursive: true, force: true });
            await fs.mkdir(vectorsPath, { recursive: true });
            res.json({ success: true, message: 'All vectors purged' });
        } catch (error) {
            console.error(`[${pluginName}] purge-all error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/stats
     * Get collection statistics
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/stats', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            const handler = getBackendHandler(backend);
            const stats = await handler.stats(collectionId, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                stats
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/stats error:`, error);
            res.status(500).json({ error: formatError(error) });
        }
    });

    console.log(`[${pluginName}] Plugin initialized successfully`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get vectra index for a collection
 */
async function getIndex(directories, collectionId, source, model) {
    const pathToFile = model
        ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model))
        : path.join(directories.vectors, sanitize(source), sanitize(collectionId));

    const store = new vectra.LocalIndex(pathToFile);

    if (!await store.isIndexCreated()) {
        await store.createIndex();
    }

    return store;
}

/**
 * Times getEmbeddingForSource so the embedding step is attributable separately
 * from the Qdrant query. A query request does embed-then-query in sequence; when
 * the whole request stalls (e.g. a gateway 504), this lets the server log reveal
 * whether the embedding provider — not Qdrant — was the bottleneck.
 *
 * On a gateway timeout the Node process keeps running this call, so the
 * success/failure line still lands in the server log once the provider resolves
 * or rejects. Success timing is gated by `debug` (the "Debug Qdrant backend"
 * checkbox → eventbaseDebug); failures are always logged since they are the
 * smoking gun and are not noisy.
 *
 * @param {boolean} debug - gate for the success-timing line
 * @param {string} label - endpoint label included in the log line
 */
async function getEmbeddingForSourceTimed(source, text, model, directories, req, { debug = false, label = 'query' } = {}) {
    const t0 = Date.now();
    try {
        const vector = await getEmbeddingForSource(source, text, model, directories, req);
        if (debug) {
            const ms = Date.now() - t0;
            const dim = Array.isArray(vector) ? vector.length : '?';
            console.log(`[similharity embed] ${label}: source=${source}, model=${model || '(default)'}, chars=${(text || '').length} → dim=${dim} in ${ms}ms`);
        }
        return vector;
    } catch (err) {
        const ms = Date.now() - t0;
        console.error(`[similharity embed] ${label}: source=${source}, model=${model || '(default)'} FAILED after ${ms}ms — embedding provider error (NOT Qdrant): ${err.message}`);
        throw err;
    }
}

/**
 * Get embedding for text from specified source
 */
async function getEmbeddingForSource(source, text, model, directories, req) {
    switch (source) {
        case 'transformers': {
            const { getTransformersVector } = await import('../../src/vectors/embedding.js');
            return await getTransformersVector(text);
        }
        case 'openai':
        case 'togetherai':
        case 'mistral':
        case 'electronhub':
        case 'openrouter': {
            const { getOpenAIVector } = await import('../../src/vectors/openai-vectors.js');
            // ElectronHub requires a model name, provide default if empty
            const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
            return await getOpenAIVector(text, source, directories, effectiveModel);
        }
        case 'koboldcpp': {
            return await _getKoboldCppEmbedding(text, model, req);
        }
        case 'nomicai': {
            const { getNomicAIVector } = await import('../../src/vectors/nomicai-vectors.js');
            return await getNomicAIVector(text, source, directories);
        }
        case 'cohere': {
            const { getCohereVector } = await import('../../src/vectors/cohere-vectors.js');
            return await getCohereVector(text, true, directories, model);
        }
        case 'ollama': {
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:11434';
            const apiKey = req.body?.apiKey || '';
            const keep = req.body?.keep || false;
            if (!apiKey) {
                const { getOllamaVector } = await import('../../src/vectors/ollama-vectors.js');
                return await getOllamaVector(text, apiUrl, model, keep, directories);
            }
            const ollamaUrl = new URL('/api/embeddings', apiUrl.replace(/\/$/, ''));
            const ollamaResp = await fetch(ollamaUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model, prompt: text, keep_alive: keep ? -1 : undefined }),
            });
            if (!ollamaResp.ok) {
                const errText = await ollamaResp.text();
                throw new Error(`Ollama: Failed to get vector: ${ollamaResp.statusText} ${errText}`);
            }
            const ollamaData = await ollamaResp.json();
            if (!Array.isArray(ollamaData?.embedding)) throw new Error('Ollama: API response missing embedding array');
            return ollamaData.embedding;
        }
        case 'llamacpp': {
            const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:8080';
            return await getLlamaCppVector(text, apiUrl, directories);
        }
        case 'vllm': {
            const apiUrl = req.body?.apiUrl || 'http://127.0.0.1:8000';
            const apiKey = req.body?.apiKey || '';
            if (req.body?.hybridOptions?.eventbaseDebug || req.body?.options?.eventbaseDebug) console.log(`[similharity] DEBUG vllm embed: apiUrl="${apiUrl}", model="${model}", hasKey=${!!apiKey}`);
            if (!apiKey) {
                const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
                return await getVllmVector(text, apiUrl, model, directories);
            }
            const { trimV1 } = await import('../../src/util.js');
            const urlJoinMod = await import('url-join');
            const urlJoin2 = urlJoinMod.default;
            const vllmUrl = new URL(urlJoin2(trimV1(apiUrl), '/v1/embeddings'));
            const vllmResp = await fetch(vllmUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ input: [text], model }),
            });
            if (!vllmResp.ok) {
                const errText = await vllmResp.text();
                throw new Error(`VLLM: Failed to get vector for text: ${vllmResp.statusText} ${errText}`);
            }
            const vllmData = await vllmResp.json();
            if (!Array.isArray(vllmData?.data)) throw new Error('VLLM: API response was not an array');
            vllmData.data.sort((a, b) => a.index - b.index);
            return vllmData.data[0].embedding;
        }
        case 'palm':
        case 'vertexai': {
            const googleVectors = await import('../../src/vectors/google-vectors.js');
            if (source === 'palm') {
                return await googleVectors.getMakerSuiteVector(text, model, req);
            } else {
                return await googleVectors.getVertexVector(text, model, req);
            }
        }
        case 'extras': {
            const { getExtrasVector } = await import('../../src/vectors/extras-vectors.js');
            const extrasUrl = req.body?.extrasUrl || 'http://127.0.0.1:5100';
            const extrasKey = req.body?.extrasKey || '';
            return await getExtrasVector(text, extrasUrl, extrasKey);
        }
        default:
            throw new Error(`Unknown vector source: ${source}`);
    }
}

/**
 * Simple string hash function
 */
function getStringHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Scan all sources for collections
 */
async function scanAllSourcesForCollections(vectorsPath) {
    const allCollections = [];
    let qdrantScanned = false;

    try {
        // Scan vectra indexes
        const vectraIndexes = await findAllIndexes(vectorsPath);

        const vectraCollectionMap = new Map();
        for (const index of vectraIndexes) {
            const key = `${index.source}:${index.collectionId}`;

            if (!vectraCollectionMap.has(key)) {
                vectraCollectionMap.set(key, {
                    id: index.collectionId,
                    source: index.source,
                    backend: 'vectra',
                    indexes: [],
                    totalChunks: 0
                });
            }

            const chunkCount = await getChunkCountFromIndex(index.indexPath);
            vectraCollectionMap.get(key).indexes.push({
                modelPath: index.modelPath,
                chunkCount: chunkCount
            });
            vectraCollectionMap.get(key).totalChunks += chunkCount;
        }

        for (const [key, collection] of vectraCollectionMap) {
            if (!collection.id) continue;

            const primaryIndex = collection.indexes.reduce((best, curr) =>
                curr.chunkCount > best.chunkCount ? curr : best
            , collection.indexes[0]);

            const models = collection.indexes.map(idx => ({
                name: idx.modelPath || '(default)',
                path: idx.modelPath,
                chunkCount: idx.chunkCount
            }));

            allCollections.push({
                id: collection.id,
                source: collection.source,
                backend: 'vectra',
                chunkCount: collection.totalChunks,
                modelCount: collection.indexes.length,
                model: primaryIndex?.modelPath || '',
                models: models
            });
        }

        // Scan Qdrant (uses REST API, so check if initialized via baseUrl)
        try {
            if (qdrantBackend.baseUrl) {
                const healthy = await qdrantBackend.healthCheck();
                if (healthy) {
                    qdrantScanned = true; // qdrant was reachable and scanned
                    const collections = await qdrantBackend.getCollections();

                    for (const collectionName of collections) {
                        const items = await qdrantBackend.listItems(collectionName, {});
                        console.log('Discovered Qdrant Collection:', collectionName + " " + items.length + " items");

                        // Extract source from collection name (format: "source:id" or "backend:source:id")
                        let source = 'unknown';
                        const parts = collectionName.split(':');
                        if (parts.length === 2) {
                            // Format: "source:id"
                            source = parts[0];
                        } else if (parts.length === 3) {
                            // Format: "backend:source:id"
                            source = parts[1];
                        } else if (items.length > 0 && items[0].metadata?.embeddingSource) {
                            // Fallback: get from item metadata
                            source = items[0].metadata.embeddingSource;
                        }

                         allCollections.push({
                            id: collectionName,
                            source: source,
                            backend: 'qdrant',
                            chunkCount: items.length,
                            modelCount: 1
                        });
                    }
                }
            }
        } catch (e) {
            console.warn(`[${pluginName}] Qdrant: Failed to scan collections:`, e.message);
        }

    } catch (error) {
        console.error(`[${pluginName}] Error scanning collections:`, error);
    }

    return { collections: allCollections, qdrantScanned };
}

/**
 * Find all vectra index.json files
 */
async function findAllIndexes(dir, relativePath = '') {
    const results = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const newRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                const subResults = await findAllIndexes(fullPath, newRelativePath);
                results.push(...subResults);
            } else if (entry.name === 'index.json') {
                const pathParts = newRelativePath.split(path.sep);
                if (pathParts.length >= 3) {
                    results.push({
                        indexPath: fullPath,
                        collectionId: pathParts[1],
                        source: pathParts[0],
                        modelPath: pathParts.slice(2, -1).join(path.sep),
                        relativePath: newRelativePath
                    });
                }
            }
        }
    } catch (e) {
        // Directory may not exist or not be readable - log at debug level since this is recursive
        if (relativePath === '') {
            console.warn(`[${pluginName}] Vectra: Failed to scan vectors directory:`, e.message);
        }
    }

    return results;
}

/**
 * Get chunk count from vectra index
 */
async function getChunkCountFromIndex(indexPath) {
    try {
        const modelDir = path.dirname(indexPath);
        const store = new vectra.LocalIndex(modelDir);

        if (!await store.isIndexCreated()) {
            return 0;
        }

        const items = await store.listItems();
        return items.length;
    } catch (e) {
        console.warn(`[${pluginName}] Vectra: Failed to get chunk count from ${indexPath}:`, e.message);
        return 0;
    }
}

export async function exit() {
    console.log(`[${pluginName}] Plugin shutting down...`);
}

export const info = {
    id: pluginName,
    name: 'Similharity',
    description: 'Unified vector database backend for VectFox - supports Vectra and Qdrant',
    version: pluginVersion
};
