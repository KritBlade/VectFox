/**
 * ============================================================================
 * VECTFOX COLLECTION EXPORT/IMPORT
 * ============================================================================
 * Handles exporting collections to portable JSON files and importing them back.
 *
 * Exports include:
 * - Full chunk text and metadata
 * - Vector embeddings (for direct import without re-embedding)
 * - Embedding source/model info (so user knows what settings to use)
 *
 * On import, if user's settings match the export's source/model, vectors are
 * imported directly. Otherwise, user is warned to switch settings.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, insertVectorItems, purgeVectorIndex } from './core-vector-api.js';
import {
    getCollectionMeta,
    setCollectionMeta,
    getChunkMetadata,
    saveChunkMetadata,
    getAllChunkMetadata,
    clearCollectionLock,
    getEffectiveScope,
} from './collection-metadata.js';
import {
    registerCollection,
    getCollectionRegistry,
} from './collection-loader.js';
import { COLLECTION_PREFIXES, buildRegistryKey, parseCollectionId, normalizeBackendForId, remapCollectionIdToBackend, remapCollectionIdToHandle, sanitizeHandleId } from './collection-ids.js';
import { getModelFromSettings } from './providers.js';
import { encodeSparseVector } from './sparse-vector-encoder.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { getStringHash } from '../../../../utils.js';
import { log } from './log.js';

// ============================================================================
// HELPERS
// ============================================================================

// Scope resolution lives in core/collection-metadata.js as `getEffectiveScope`
// (formerly duplicated here as a private `_inferScope`). Single source of truth
// — see Doc/collection_helper.md (scope handling).

// ============================================================================
// CONSTANTS
// ============================================================================

/** Current export format version */
const EXPORT_VERSION = '1.0.0';

/** File extension for VectFox exports */
export const EXPORT_FILE_EXTENSION = '.vectfox.json';

/** Maximum chunks to export at once (for progress updates) */
const EXPORT_BATCH_SIZE = 100;

// Backend-name helpers (normalize / remap) used to live here as private copies;
// they're now canonicalized in core/collection-ids.js (`normalizeBackendForId`,
// `remapCollectionIdToBackend`). Importing from there keeps a single source of
// truth — see Doc/collection_helper.md (single-source-of-truth rule).

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Fetches chunks with vectors from the backend
 * @param {string} collectionId - Collection to fetch from
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array>} Chunks with vectors
 */
async function fetchChunksWithVectors(collectionId, settings) {
    const backendName = settings.vector_backend || 'standard';
    const response = await fetch('/api/plugins/similharity/chunks/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: backendName === 'standard' ? 'vectra' : backendName,
            collectionId: collectionId,
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            limit: 50000, // High limit to get all chunks
            includeVectors: true, // Include the actual embedding vectors
            // Qdrant scroll batch — pure read, no indexing overhead, so push past the
            // default 100 to amortize round-trip latency. 500 keeps each scroll well
            // under Qdrant's 16-32 MB/request target even for 4096-dim + long text.
            scrollLimit: 500,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch chunks: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success || !data.items) {
        throw new Error('Invalid response from chunks API');
    }

    return data.items;
}

/**
 * Fetches every chunk of a collection in the portable shape that export files
 * store and the import path inserts: `{ hash, text, index, vector, metadata }`.
 *
 * Qdrant returns `vector` as a plain array for unnamed-vector collections, but as
 * `{ '': [dense], text_sparse: {indices, values} }` for named-vector collections
 * (nativeSparse). The dense array is unwrapped so the import side
 * (`Array.isArray`) accepts it and inserts without re-embedding; the sparse
 * vector is recomputed from the text on insert. `vector` is null when the
 * backend returned none.
 *
 * @param {string} collectionId - Collection to fetch from
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array<{ hash: number|string, text: string, index: number, vector: number[]|null, metadata: object }>>}
 */
export async function fetchPortableChunks(collectionId, settings) {
    const rawChunks = await fetchChunksWithVectors(collectionId, settings);
    return rawChunks.map(item => {
        const meta = item.metadata || item;
        let rawVector = item.vector || meta.vector || null;
        if (rawVector && typeof rawVector === 'object' && !Array.isArray(rawVector)) {
            rawVector = rawVector[''] ?? null;
        }
        return {
            hash: meta.hash || item.hash,
            text: meta.text || item.text || '',
            index: meta.index ?? item.index,
            vector: rawVector,
            metadata: {
                ...meta,
                keywords: meta.keywords || [],
            },
        };
    });
}

/**
 * Exports a single collection to a portable JSON format (includes vectors)
 * @param {string} collectionId - The collection to export
 * @param {object} settings - VectFox settings
 * @param {object} collectionInfo - Optional collection info (backend, source, model)
 * @returns {Promise<object>} Export data object
 */
export async function exportCollection(collectionId, settings, collectionInfo = {}) {
    progressTracker.show('Exporting Collection', 3, 'Steps');
    progressTracker.updateCurrentItem(collectionId);

    // Use collection-specific settings if provided (for multi-backend support).
    // Note: model is NOT set here as a flat key — it's looked up via
    // getModelFromSettings(exportSettings) wherever needed, since the real value
    // lives under the provider-specific field (embedding_openrouter_model, embedding_ollama_model, …).
    const exportSettings = {
        ...settings,
        vector_backend: collectionInfo.backend || settings.vector_backend,
        source: collectionInfo.source || settings.embedding_provider,
    };

    try {
        // Step 1: Get collection metadata
        progressTracker.updateProgress(1, 'Loading metadata...');
        // Metadata (display name, triggers, conditions, …) lives under the
        // registry-key form; callers pass the bare ID.
        const collectionMeta = getCollectionMeta(buildRegistryKey(collectionId, exportSettings));

        // Step 2: Get all chunks WITH vectors
        progressTracker.updateProgress(2, 'Loading chunks and vectors...');
        const chunks = (await fetchPortableChunks(collectionId, exportSettings)).map(chunk => {
            // Get per-chunk metadata from VectFox settings
            const chunkMeta = getChunkMetadata(chunk.hash);
            return chunkMeta ? { ...chunk, chunkMeta } : chunk;
        });

        progressTracker.updateChunks(chunks.length);

        // Step 3: Build export object
        progressTracker.updateProgress(3, 'Building export...');

        // Get vector dimension from first chunk that has a vector
        const sampleVector = chunks.find(c => c.vector)?.vector;
        const vectorDimension = sampleVector ? sampleVector.length : null;
        const chunksWithVectors = chunks.filter(c => c.vector).length;

        const exportData = {
            // Header
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            generator: 'VectFox',

            // Embedding info - CRITICAL for import compatibility
            // NOTE: source + model must match for vectors to be compatible
            // backend is just storage location - vectors work across backends
            embedding: {
                source: exportSettings.embedding_provider || 'transformers',
                model: getModelFromSettings(exportSettings),
                backend: exportSettings.vector_backend || 'standard', // For reference only
                dimension: vectorDimension,
                hasVectors: chunksWithVectors > 0,
            },

            // Collection info
            collection: {
                id: collectionId,
                name: collectionMeta.displayName || collectionId,
                description: collectionMeta.description || '',
                contentType: collectionMeta.contentType || detectContentType(collectionId),
                // collectionMeta.scope is auto-resolved by getCollectionMeta
                // — see Doc/collection_helper.md (scope handling).
                scope: collectionMeta.scope,
                tags: collectionMeta.tags || [],
                color: collectionMeta.color,
                createdAt: collectionMeta.createdAt,
            },

            // Settings that affect behavior
            settings: {
                // Activation
                alwaysActive: collectionMeta.alwaysActive || false,
                triggers: collectionMeta.triggers || [],
                triggerMatchMode: collectionMeta.triggerMatchMode || 'any',
                triggerCaseSensitive: collectionMeta.triggerCaseSensitive || false,
                triggerScanDepth: collectionMeta.triggerScanDepth || 5,
                conditions: collectionMeta.conditions || { enabled: false, logic: 'AND', rules: [] },

                // Temporal decay
                temporalDecay: collectionMeta.temporalDecay || {
                    enabled: false,
                    mode: 'exponential',
                    halfLife: 50,
                    linearRate: 0.01,
                    minRelevance: 0.3,
                },

                // Prompt context
                context: collectionMeta.context || '',
                xmlTag: collectionMeta.xmlTag || '',
            },

            // Chunks (text + metadata + vectors)
            chunks: chunks,

            // Stats
            stats: {
                chunkCount: chunks.length,
                chunksWithVectors,
                hasText: chunks.filter(c => c.text).length,
                hasKeywords: chunks.filter(c => c.metadata?.keywords?.length > 0).length,
            },
        };

        progressTracker.complete(true, `Exported ${chunks.length} chunks`);
        return exportData;

    } catch (error) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Export failed');
        throw error;
    }
}

/**
 * Exports multiple collections to a single file
 * @param {string[]} collectionIds - Collections to export
 * @param {object} settings - VectFox settings
 * @returns {Promise<object>} Export data with multiple collections
 */
export async function exportMultipleCollections(collectionIds, settings) {
    progressTracker.show('Exporting Collections', collectionIds.length, 'Collections');

    const exports = [];
    const errors = [];

    for (let i = 0; i < collectionIds.length; i++) {
        const collectionId = collectionIds[i];
        progressTracker.updateProgress(i + 1, `Exporting: ${collectionId}`);
        progressTracker.updateCurrentItem(collectionId);

        try {
            // Export without showing nested progress
            const collectionMeta = getCollectionMeta(collectionId) || {};
            const chunksResult = await getSavedHashes(collectionId, settings, true);

            let chunks = [];
            if (chunksResult && chunksResult.metadata) {
                chunks = chunksResult.metadata.map(meta => ({
                    hash: meta.hash,
                    text: meta.text || '',
                    index: meta.index,
                    metadata: {
                        contentType: meta.contentType,
                        sourceName: meta.sourceName,
                        entryName: meta.entryName,
                        entryUid: meta.entryUid,
                        keywords: meta.keywords || [],
                        keywordLevel: meta.keywordLevel,
                        keywordBaseWeight: meta.keywordBaseWeight,
                        importance: meta.importance,
                        conditions: meta.conditions,
                        isSummaryChunk: meta.isSummaryChunk,
                        parentHash: meta.parentHash,
                        speaker: meta.speaker,
                        isUser: meta.isUser,
                        messageId: meta.messageId,
                        // Per-chunk user overrides — backend is the source of truth, so these
                        // must roundtrip via the payload (not just ext_settings/chunkMeta).
                        name: meta.name,
                        context: meta.context,
                        xmlTag: meta.xmlTag,
                        position: meta.position,
                        depth: meta.depth,
                        enabled: meta.enabled,
                        chunkLinks: meta.chunkLinks,
                    },
                }));

                for (const chunk of chunks) {
                    const chunkMeta = getChunkMetadata(chunk.hash);
                    if (chunkMeta) {
                        chunk.chunkMeta = chunkMeta;
                    }
                }
            }

            exports.push({
                collection: {
                    id: collectionId,
                    name: collectionMeta.displayName || collectionId,
                    description: collectionMeta.description || '',
                    contentType: collectionMeta.contentType || detectContentType(collectionId),
                    // Auto-resolved by getCollectionMeta — see Doc/collection_helper.md.
                    scope: collectionMeta.scope,
                    tags: collectionMeta.tags || [],
                    color: collectionMeta.color,
                    createdAt: collectionMeta.createdAt,
                },
                settings: {
                    alwaysActive: collectionMeta.alwaysActive || false,
                    triggers: collectionMeta.triggers || [],
                    triggerMatchMode: collectionMeta.triggerMatchMode || 'any',
                    triggerCaseSensitive: collectionMeta.triggerCaseSensitive || false,
                    triggerScanDepth: collectionMeta.triggerScanDepth || 5,
                    conditions: collectionMeta.conditions || { enabled: false, logic: 'AND', rules: [] },
                    temporalDecay: collectionMeta.temporalDecay || {
                        enabled: false,
                        mode: 'exponential',
                        halfLife: 50,
                        linearRate: 0.01,
                        minRelevance: 0.3,
                    },
                    context: collectionMeta.context || '',
                    xmlTag: collectionMeta.xmlTag || '',
                },
                chunks: chunks,
                stats: {
                    chunkCount: chunks.length,
                    hasText: chunks.filter(c => c.text).length,
                    hasKeywords: chunks.filter(c => c.metadata?.keywords?.length > 0).length,
                },
            });
        } catch (error) {
            log.error(`VectFox Export: Failed to export ${collectionId}:`, error);
            errors.push({ collectionId, error: error.message });
        }
    }

    progressTracker.complete(errors.length === 0, `Exported ${exports.length}/${collectionIds.length} collections`);

    return {
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
        generator: 'VectFox',
        type: 'multi',
        collections: exports,
        errors: errors,
        stats: {
            totalCollections: exports.length,
            totalChunks: exports.reduce((sum, e) => sum + e.chunks.length, 0),
            failedCollections: errors.length,
        },
    };
}

/**
 * Downloads export data as a JSON file
 * @param {object} exportData - The export data object
 * @param {string} filename - Optional filename (without extension)
 */
export function downloadExport(exportData, filename = null) {
    const defaultName = exportData.type === 'multi'
        ? `vectfox-export-${exportData.stats.totalCollections}-collections`
        : `vectfox-${exportData.collection?.id || 'collection'}`;

    const rawName = filename || defaultName;
    // Strip emojis, colons, and other characters that are invalid or ugly in filenames.
    // Preserves letters (including CJK), digits, hyphens, dots, and underscores.
    const sanitized = String(rawName)
        .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 120)
        || defaultName;

    const finalFilename = sanitized + EXPORT_FILE_EXTENSION;

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log.lifecycle(`VectFox Export: Downloaded ${finalFilename}`);
}

// ============================================================================
// IMPORT FUNCTIONS
// ============================================================================

/**
 * Validates an import file structure and checks embedding compatibility
 * @param {object} data - Parsed JSON data
 * @param {object} currentSettings - Current VectFox settings (to check compatibility)
 * @returns {{ valid: boolean, errors: string[], warnings: string[], compatible: boolean, embeddingInfo: object }}
 */
export function validateImportData(data, currentSettings = {}) {
    const errors = [];
    const warnings = [];

    // Check version
    if (!data.version) {
        errors.push('Missing version field');
    } else if (!data.version.startsWith('1.')) {
        warnings.push(`Export version ${data.version} may not be fully compatible`);
    }

    // Check for collections
    const isMulti = data.type === 'multi';
    const collections = isMulti ? data.collections : [data];

    if (!collections || collections.length === 0) {
        errors.push('No collections found in export file');
    }

    // Check embedding compatibility
    let embeddingInfo = null;
    let compatible = true;

    for (const col of collections) {
        if (!col.collection?.id) {
            errors.push('Collection missing ID');
        }
        if (!col.chunks || !Array.isArray(col.chunks)) {
            errors.push(`Collection ${col.collection?.id || 'unknown'} has no chunks array`);
        } else {
            const chunksWithoutText = col.chunks.filter(c => !c.text);
            if (chunksWithoutText.length > 0) {
                warnings.push(`${col.collection?.id}: ${chunksWithoutText.length} chunks have no text (will be skipped)`);
            }
        }

        // Check embedding info
        if (col.embedding) {
            embeddingInfo = col.embedding;
            const hasVectors = col.chunks?.some(c => c.vector);

            if (hasVectors && currentSettings.embedding_provider) {
                // Check if current settings match export
                const currentModel = getModelFromSettings(currentSettings);
                const sourceMatch = col.embedding.source === currentSettings.embedding_provider;
                const modelMatch = !col.embedding.model || !currentModel ||
                    col.embedding.model === currentModel;

                if (!sourceMatch || !modelMatch) {
                    compatible = false;
                    warnings.push(
                        `Embedding mismatch: Export used ${col.embedding.source}/${col.embedding.model || 'default'}, ` +
                        `but you're using ${currentSettings.embedding_provider}/${currentModel || 'default'}. ` +
                        `Switch your settings to match, or vectors will be re-embedded.`
                    );
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        compatible,
        embeddingInfo,
        stats: {
            collectionCount: collections.length,
            totalChunks: collections.reduce((sum, c) => sum + (c.chunks?.length || 0), 0),
            chunksWithVectors: collections.reduce((sum, c) =>
                sum + (c.chunks?.filter(ch => ch.vector)?.length || 0), 0),
        },
    };
}

/**
 * Inserts chunks directly with pre-computed vectors (bypasses embedding).
 * Takes the portable chunk shape returned by {@link fetchPortableChunks}.
 * @param {string} collectionId - Collection to insert into
 * @param {Array} chunks - Chunks with vectors
 * @param {object} settings - VectFox settings
 * @param {Function} [onBatchProgress] - Called after each batch: (insertedSoFar, total)
 * @param {AbortSignal} [abortSignal] - Cancel between batches
 */
export async function insertChunksWithVectors(collectionId, chunks, settings, onBatchProgress, abortSignal = null) {
    const backendName = settings.vector_backend || 'standard';
    const model = getModelFromSettings(settings);

    // Batch to avoid 413. Qdrant accepts up to 32 MB per request; live ingestion uses 100
    // (backends/qdrant.js). Per-batch overhead (collection metadata GETs + wait=true index)
    // dominates total time, so larger batches roughly amortize that cost. 100 chunks ≈ 5 MB
    // for 4096-dim vectors — well under the limit.
    const BATCH_SIZE = 100;
    const items = chunks.map(c => {
        const item = {
            hash: c.hash,
            text: c.text,
            index: c.index,
            vector: c.vector,
            metadata: c.metadata || {},
        };
        // Qdrant's A3 hybrid path needs a sparse vector per point (text_sparse named slot).
        // Mirror backends/qdrant.js:insertVectorItems: tokenize text + the keyword suffix
        // so BM25 hits match what live ingestion would produce. Live Qdrant ingestion
        // stores `text` WITH that suffix already, so text read back from a Qdrant
        // collection is tokenized as-is; the suffix is appended only when missing. The
        // stored `text` is never changed here.
        if (backendName === 'qdrant') {
            const kws = item.metadata.keywords || [];
            let sparseSource = item.text || '';
            if (kws.length > 0) {
                const kwText = kws.map(kw => (typeof kw === 'string' ? kw : kw?.text || '')).filter(Boolean).join(' ');
                const keywordSuffix = ` [KEYWORDS: ${kwText}]`;
                if (kwText && !sparseSource.endsWith(keywordSuffix)) sparseSource += keywordSuffix;
            }
            item.sparseVector = encodeSparseVector(sparseSource);
        }
        return item;
    });

    let inserted = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        if (abortSignal?.aborted) {
            throw Object.assign(new Error('Import stopped by user'), { name: 'AbortError' });
        }
        const batch = items.slice(i, i + BATCH_SIZE);

        let response;
        if (backendName === 'standard') {
            // Standard backend always uses native ST API — plugin is Qdrant-only
            response = await fetch('/api/vector/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    collectionId,
                    source: settings.embedding_provider || 'transformers',
                    model,
                    items: batch.map(item => ({
                        hash: item.hash,
                        text: item.text || '',
                        index: item.index ?? 0,
                    })),
                    embeddings: Object.fromEntries(batch.map(item => [item.text || '', item.vector])),
                }),
            });
        } else {
            response = await fetch('/api/plugins/similharity/chunks/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    backend: backendName === 'standard' ? 'vectra' : backendName,
                    collectionId,
                    source: settings.embedding_provider || 'transformers',
                    model,
                    items: batch,
                    // qdrant requires nativeSparse=true so the collection is created with text_sparse
                    // index (BM25 hybrid search). Without it, hybrid queries fail with "Not existing
                    // vector name error: text_sparse".
                    ...(backendName === 'qdrant' && {
                        nativeSparse: true,
                        cjkTokenizerMode: settings.cjk_tokenizer_mode || null,
                    }),
                }),
            });
        }

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to insert chunks: ${error}`);
        }

        inserted += batch.length;
        if (typeof onBatchProgress === 'function') {
            onBatchProgress(inserted, items.length);
        }
    }

    // Stale-stats fix: this writer bypasses core-vector-api.js's insertVectorItems
    // (it hits /chunks/insert directly with pre-computed vectors), so the cache
    // invalidation in that path doesn't fire here. Clear corpus-IDF cache so the
    // next BM25 query rebuilds with the just-inserted chunks counted in df.
    // Best-effort + dynamic import — failure must not break the import flow.
    if (chunks.length > 0) {
        try {
            const mod = await import('./corpus-stats.js');
            mod.clearCorpusStatsCache(collectionId);
        } catch (err) {
            log.warn(`VectFox Import: corpus-stats cache clear failed for ${collectionId} (BM25 stats stay stale until the next rebuild):`, err);
        }
    }
}

/**
 * Imports a collection from export data
 * Uses pre-computed vectors if available and settings match, otherwise re-embeds
 *
 * @param {object} exportData - Single collection export data (or one item from multi-export)
 * @param {object} settings - VectFox settings
 * @param {object} options - Import options
 * @param {string} options.collectionId - Override collection ID (for rename/duplicate)
 * @param {boolean} options.overwrite - If true, purge existing collection first
 * @param {boolean} options.forceReembed - If true, re-embed even if vectors exist
 * @returns {Promise<{ success: boolean, collectionId: string, chunkCount: number, usedVectors: boolean, errors: string[] }>}
 */
export async function importCollection(exportData, settings, options = {}) {
    const sourceCollection = exportData.collection || {};
    const sourceId = options.collectionId || sourceCollection.id;

    if (!sourceId) {
        throw new Error('No collection ID specified');
    }

    // Re-home the imported collection onto the current setup by rewriting both
    // identity segments of the ID to match local state:
    //   backend — e.g. vf_eventbase_qdrant_critblade_... → vf_eventbase_standard_critblade_...
    //   handle  — e.g. vf_eventbase_standard_critblade_... → vf_eventbase_standard_rabbit_...
    // Without the handle rewrite the collection keeps the exporter's persona and the
    // DB-browser persona filter hides it from the importing user (creatorHandle never
    // matches). See remapCollectionIdToHandle + the creatorHandle stamp below.
    const targetBackendLabel = normalizeBackendForId(settings.vector_backend);
    const targetHandle = sanitizeHandleId(getContext()?.name1);
    const backendRemapped = remapCollectionIdToBackend(sourceId, targetBackendLabel);
    const collectionId = remapCollectionIdToHandle(backendRemapped, targetHandle);
    const wasRemapped = collectionId !== sourceId;
    if (wasRemapped) {
        const srcLabel = normalizeBackendForId(exportData.embedding?.backend || '?');
        log.lifecycle(`VectFox Import: remapped collection ID (backend ${srcLabel} → ${targetBackendLabel}, handle → ${targetHandle}): "${sourceId}" → "${collectionId}"`);
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import (all chunks missing text)');
    }

    // ─── H-3 mitigations ──────────────────────────────────────────────────
    // Reject imports that carry payloads which would cause passive harm
    // post-import (regex ReDoS at every chat scan; NaN/Infinity vectors that
    // produce NaN similarity scores and silently break retrieval).
    //
    // Length cap on triggers: catastrophic-backtracking patterns can be
    // shorter than typical legitimate triggers — capping at 300 chars draws
    // a generous line without restricting normal use. Shape heuristics
    // intentionally NOT applied (e.g. `(.+)+` is a valid regex when the
    // user actually means it).
    const MAX_TRIGGER_LEN = 300;
    const importedTriggers = exportData?.settings?.triggers;
    if (Array.isArray(importedTriggers)) {
        for (const t of importedTriggers) {
            if (typeof t === 'string' && t.length > MAX_TRIGGER_LEN) {
                throw new Error(`Trigger exceeds ${MAX_TRIGGER_LEN} char limit (got ${t.length}): "${t.slice(0, 80)}…"`);
            }
        }
    }

    // Vector validation: any non-finite component (NaN, ±Infinity) would
    // pollute similarity calculations downstream. Reject the whole import
    // if any vector contains one — better than silently storing broken
    // vectors and watching retrieval scores come back as NaN. No magnitude
    // bound — providers vary, normalization is provider-specific.
    //
    // Also enforce vector-dimension consistency across all chunks: Qdrant
    // rejects dim-mismatch at insert time (reactive), but Standard/Vectra
    // accepts whatever it's given, so a mixed-dim import would silently
    // corrupt every subsequent cosine query with no clear error pointing
    // at the cause. Catch it here once, with an actionable message.
    let importDim = null;
    for (let i = 0; i < validChunks.length; i++) {
        const v = validChunks[i].vector;
        if (!v || !Array.isArray(v)) continue; // skip — will be re-embedded
        for (let j = 0; j < v.length; j++) {
            if (!Number.isFinite(v[j])) {
                throw new Error(`Chunk ${i} vector has non-finite component at index ${j} (value: ${v[j]}). Refusing to import.`);
            }
        }
        if (importDim === null) {
            importDim = v.length;
        } else if (v.length !== importDim) {
            throw new Error(
                `Vector dimension mismatch: chunk 0 has dim=${importDim}, ` +
                `chunk ${i} has dim=${v.length}. All vectors in an import must share one dimension. ` +
                `Refusing to import.`
            );
        }
    }
    // ─── end H-3 mitigations ──────────────────────────────────────────────

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.embedding_provider &&
        (!embeddingInfo.model || !getModelFromSettings(settings) || embeddingInfo.model === getModelFromSettings(settings));

    const totalSteps = 4;
    progressTracker.show('Importing Collection', totalSteps, 'Steps');
    progressTracker.updateCurrentItem(collectionId);
    progressTracker.updateChunks(validChunks.length);

    const abortController = new AbortController();
    progressTracker.setCancelHandler(() => abortController.abort('user-stop'));

    const errors = [];

    try {
        // Step 1: Handle existing collection
        progressTracker.updateProgress(1, 'Preparing collection...');

        if (options.overwrite) {
            try {
                await purgeVectorIndex(collectionId, settings);
                log.lifecycle(`VectFox Import: Purged existing collection ${collectionId}`);
            } catch (e) {
                // Collection might not exist, that's fine - log at debug level
                log.trace(`VectFox Import: Could not purge ${collectionId} (may not exist):`, e.message);
            }
        }

        if (abortController.signal.aborted) {
            throw Object.assign(new Error('Import stopped by user'), { name: 'AbortError' });
        }

        // Step 2: Prepare chunks
        progressTracker.updateProgress(2, 'Preparing chunks...');

        const preparedChunks = validChunks.map((chunk, index) => ({
            text: chunk.text,
            index: chunk.index ?? index,
            hash: getStringHash(chunk.text),
            vector: canUseVectors ? chunk.vector : undefined,
            metadata: chunk.metadata || {},
        }));

        // Step 3: Insert chunks
        if (canUseVectors) {
            // Direct insert with pre-computed vectors (fast!)
            progressTracker.updateEmbeddingProgress(0, preparedChunks.length);
            progressTracker.updateProgress(3, `Inserting ${preparedChunks.length} chunks (using existing vectors)...`);
            try {
                await insertChunksWithVectors(collectionId, preparedChunks, settings, (done, total) => {
                    progressTracker.updateEmbeddingProgress(done, total);
                }, abortController.signal);
                log.lifecycle(`VectFox Import: Inserted ${preparedChunks.length} chunks with pre-computed vectors`);
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                throw new Error(`Failed to insert chunks: ${error.message}`);
            }
        } else {
            // Need to embed (slow)
            progressTracker.updateProgress(3, `Embedding ${preparedChunks.length} chunks...`);
            try {
                await insertVectorItems(collectionId, preparedChunks, settings, null, abortController.signal);
                log.lifecycle(`VectFox Import: Embedded and inserted ${preparedChunks.length} chunks`);
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                throw new Error(`Failed to embed chunks: ${error.message}`);
            }
        }

        // Step 4: Save metadata
        progressTracker.updateProgress(4, 'Saving metadata...');

        // Metadata is keyed by the registry-key form ("backend:id") — same key
        // used by setCollectionLock, cleanupOrphanedMeta, and the loader's
        // ensureCollectionMeta. Writing at the bare ID would land in a different
        // bucket that the orphan-cleanup pass would immediately remove.
        const registryKey = buildRegistryKey(collectionId, settings);

        // Import is treated as a conversion → activation state must start fresh.
        // Clear any chat locks from a prior collection with the same ID first so the
        // chat_lock_index reverse map stays consistent; lockedToCharacterIds + autoSync
        // are zeroed via importedMeta below (no reverse map to maintain).
        clearCollectionLock(registryKey);

        // Collection-level metadata
        const importedMeta = {
            enabled: true,
            // If the ID was remapped and the export's display name was just the old ID
            // (auto-generated, not user-set), clear it so the loader computes a fresh
            // name from the new collection ID. Keep explicit user-set names as-is.
            displayName: (wasRemapped && sourceCollection.name === sourceId)
                ? undefined
                : (sourceCollection.name || collectionId),
            description: sourceCollection.description || '',
            // Import side: sourceCollection comes from the export file payload
            // (not getCollectionMeta), so its scope is untrusted. Use the
            // canonical resolver explicitly. See Doc/collection_helper.md.
            scope: getEffectiveScope(collectionId, sourceCollection),
            tags: sourceCollection.tags || [],
            color: sourceCollection.color,
            contentType: sourceCollection.contentType,
            createdAt: new Date().toISOString(),
            importedFrom: exportData.exportDate,
            importedAt: new Date().toISOString(),
            // Re-home under the importing persona: the ID handle was rewritten above,
            // but stamp creatorHandle explicitly too so ownership is authoritative and
            // doesn't depend on registerCollection's name-parse heuristic.
            creatorHandle: targetHandle,
            // Convert = unchecked: no character lock, auto-sync off.
            lockedToCharacterIds: [],
            autoSync: false,
        };

        // Merge with exported settings
        if (exportData.settings) {
            Object.assign(importedMeta, {
                alwaysActive: exportData.settings.alwaysActive,
                triggers: exportData.settings.triggers,
                triggerMatchMode: exportData.settings.triggerMatchMode,
                triggerCaseSensitive: exportData.settings.triggerCaseSensitive,
                triggerScanDepth: exportData.settings.triggerScanDepth,
                conditions: exportData.settings.conditions,
                temporalDecay: exportData.settings.temporalDecay,
                context: exportData.settings.context || '',
                xmlTag: exportData.settings.xmlTag || '',
            });
        }

        setCollectionMeta(registryKey, importedMeta);

        // Per-chunk metadata
        for (const chunk of validChunks) {
            if (chunk.chunkMeta) {
                const newHash = getStringHash(chunk.text);
                saveChunkMetadata(newHash, chunk.chunkMeta);
            }
        }

        // Register collection with backend prefix so parseRegistryKey resolves the right backend
        registerCollection(registryKey);
        saveSettingsDebounced();

        const statusMsg = canUseVectors
            ? `Imported ${preparedChunks.length} chunks (used existing vectors)`
            : `Imported ${preparedChunks.length} chunks (re-embedded)`;
        progressTracker.complete(true, statusMsg);

        return {
            success: true,
            collectionId,
            chunkCount: preparedChunks.length,
            usedVectors: canUseVectors,
            errors,
        };

    } catch (error) {
        const isStopped = error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            // Best-effort cleanup: the collection was purged in step 1 but a partial
            // batch may have been written. Purge again so the user doesn't end up with
            // a half-imported collection.
            try {
                await purgeVectorIndex(collectionId, settings);
            } catch (cleanupErr) {
                log.trace(`VectFox Import: cleanup purge after stop failed:`, cleanupErr?.message);
            }
            progressTracker.complete(false, 'Import stopped');
        } else {
            progressTracker.addError(error.message);
            progressTracker.complete(false, 'Import failed');
        }
        throw error;
    } finally {
        progressTracker.clearCancelHandler();
    }
}

/**
 * Imports multiple collections from a multi-export file
 * @param {object} multiExportData - Multi-collection export data
 * @param {object} settings - VectFox settings
 * @param {object} options - Import options
 * @returns {Promise<{ success: boolean, imported: number, failed: number, results: object[] }>}
 */
export async function importMultipleCollections(multiExportData, settings, options = {}) {
    const collections = multiExportData.collections || [];

    if (collections.length === 0) {
        throw new Error('No collections in export file');
    }

    progressTracker.show('Importing Collections', collections.length, 'Collections');

    const results = [];
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < collections.length; i++) {
        const exportItem = collections[i];
        const collectionId = exportItem.collection?.id;

        progressTracker.updateProgress(i + 1, `Importing: ${collectionId || 'unknown'}`);
        progressTracker.updateCurrentItem(collectionId || `Collection ${i + 1}`);

        try {
            // Don't show nested progress tracker
            const result = await importCollectionSilent(exportItem, settings, options);
            results.push(result);
            imported++;
        } catch (error) {
            log.error(`VectFox Import: Failed to import ${collectionId}:`, error);
            results.push({
                success: false,
                collectionId,
                error: error.message,
            });
            failed++;
        }
    }

    progressTracker.complete(failed === 0, `Imported ${imported}/${collections.length} collections`);

    return {
        success: failed === 0,
        imported,
        failed,
        results,
    };
}

/**
 * Silent import (no progress tracker) for batch operations
 */
async function importCollectionSilent(exportData, settings, options = {}) {
    const sourceCollection = exportData.collection || {};
    const sourceId = options.collectionId || sourceCollection.id;

    if (!sourceId) {
        throw new Error('No collection ID specified');
    }

    // Remap collection ID when the export's backend differs from the current
    // backend — same logic as importCollection. Missing this previously caused
    // bulk-imports of qdrant exports into standard to keep the `_qdrant_`
    // segment in the on-disk vectra folder name, breaking every other code
    // path that parses the backend out of the ID. Surfaced 2026-05-23.
    const targetBackendLabel = normalizeBackendForId(settings.vector_backend);
    const targetHandle = sanitizeHandleId(getContext()?.name1);
    const backendRemapped = remapCollectionIdToBackend(sourceId, targetBackendLabel);
    const collectionId = remapCollectionIdToHandle(backendRemapped, targetHandle);
    if (collectionId !== sourceId) {
        const srcLabel = normalizeBackendForId(exportData.embedding?.backend || '?');
        log.lifecycle(`VectFox Import (silent): remapped (backend ${srcLabel} → ${targetBackendLabel}, handle → ${targetHandle}): "${sourceId}" → "${collectionId}"`);
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import');
    }

    // Mirror importCollection's vector validation: NaN/Infinity guard +
    // dimension consistency check. Standard/Vectra silently accepts bad
    // dims; Qdrant catches it reactively. Catching it here once per import
    // gives a clear actionable error regardless of target backend.
    let importDim = null;
    for (let i = 0; i < validChunks.length; i++) {
        const v = validChunks[i].vector;
        if (!v || !Array.isArray(v)) continue;
        for (let j = 0; j < v.length; j++) {
            if (!Number.isFinite(v[j])) {
                throw new Error(`Chunk ${i} vector has non-finite component at index ${j} (value: ${v[j]}). Refusing to import.`);
            }
        }
        if (importDim === null) {
            importDim = v.length;
        } else if (v.length !== importDim) {
            throw new Error(
                `Vector dimension mismatch: chunk 0 has dim=${importDim}, ` +
                `chunk ${i} has dim=${v.length}. All vectors in an import must share one dimension. ` +
                `Refusing to import.`
            );
        }
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.embedding_provider &&
        (!embeddingInfo.model || !getModelFromSettings(settings) || embeddingInfo.model === getModelFromSettings(settings));

    // Handle existing collection
    if (options.overwrite) {
        try {
            await purgeVectorIndex(collectionId, settings);
        } catch (e) {
            // Collection might not exist - log at debug level
            log.trace(`VectFox Import: Could not purge ${collectionId} (may not exist):`, e.message);
        }
    }

    // Prepare chunks
    const preparedChunks = validChunks.map((chunk, index) => ({
        text: chunk.text,
        index: chunk.index ?? index,
        hash: getStringHash(chunk.text),
        vector: canUseVectors ? chunk.vector : undefined,
        metadata: chunk.metadata || {},
    }));

    // Insert
    if (canUseVectors) {
        await insertChunksWithVectors(collectionId, preparedChunks, settings);
    } else {
        await insertVectorItems(collectionId, preparedChunks, settings);
    }

    // Metadata is keyed by the registry-key form ("backend:id"). See importCollection
    // for the rationale; same logic applies here.
    const registryKey = buildRegistryKey(collectionId, settings);

    // Convert = unchecked: clear prior chat locks (with reverse-map cleanup)
    // before merging metadata; lockedToCharacterIds + autoSync are zeroed via importedMeta.
    clearCollectionLock(registryKey);

    // Save metadata
    const importedMeta = {
        enabled: true,
        displayName: sourceCollection.name || collectionId,
        description: sourceCollection.description || '',
        // Import side: sourceCollection is from the export file payload
        // (not getCollectionMeta), so use the canonical resolver explicitly.
        scope: getEffectiveScope(collectionId, sourceCollection),
        tags: sourceCollection.tags || [],
        color: sourceCollection.color,
        contentType: sourceCollection.contentType,
        createdAt: new Date().toISOString(),
        importedFrom: exportData.exportDate,
        importedAt: new Date().toISOString(),
        // Re-home under the importing persona (matches importCollection).
        creatorHandle: targetHandle,
        lockedToCharacterIds: [],
        autoSync: false,
    };

    if (exportData.settings) {
        Object.assign(importedMeta, {
            alwaysActive: exportData.settings.alwaysActive,
            triggers: exportData.settings.triggers,
            triggerMatchMode: exportData.settings.triggerMatchMode,
            triggerCaseSensitive: exportData.settings.triggerCaseSensitive,
            triggerScanDepth: exportData.settings.triggerScanDepth,
            conditions: exportData.settings.conditions,
            temporalDecay: exportData.settings.temporalDecay,
            context: exportData.settings.context || '',
            xmlTag: exportData.settings.xmlTag || '',
        });
    }

    setCollectionMeta(registryKey, importedMeta);

    for (const chunk of validChunks) {
        if (chunk.chunkMeta) {
            const newHash = getStringHash(chunk.text);
            saveChunkMetadata(newHash, chunk.chunkMeta);
        }
    }

    registerCollection(registryKey);
    saveSettingsDebounced();

    return {
        success: true,
        collectionId,
        chunkCount: preparedChunks.length,
        usedVectors: canUseVectors,
    };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Detects content type from collection ID pattern
 * @param {string} collectionId
 * @returns {string}
 */
function detectContentType(collectionId) {
    if (collectionId.includes('_chat_') || collectionId.includes('_eventbase_')) {
        return 'chat';
    }
    if (collectionId.includes('_lorebook_')) {
        return 'lorebook';
    }
    if (collectionId.includes('_document_')) {
        return 'document';
    }
    if (collectionId.includes('_character_')) {
        return 'character';
    }
    return 'unknown';
}

/** Upload size cap — generous enough for typical chat-history exports
 * (the largest collections we've seen in production are well under 100 MB
 * with vectors included). Caps the FileReader.readAsText() memory cost +
 * the subsequent JSON.parse() main-thread block. */
export const MAX_IMPORT_FILE_BYTES = 400 * 1024 * 1024; // 400 MB

/**
 * Reads and parses an import file
 * @param {File} file - File object from input
 * @returns {Promise<object>} Parsed JSON data
 */
export async function readImportFile(file) {
    if (file?.size > MAX_IMPORT_FILE_BYTES) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        const capMB = MAX_IMPORT_FILE_BYTES / 1024 / 1024;
        throw new Error(
            `Import file too large: ${sizeMB} MB exceeds ${capMB} MB limit. ` +
            `Split the export into smaller batches.`
        );
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                resolve(data);
            } catch (error) {
                reject(new Error('Invalid JSON file'));
            }
        };

        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

/**
 * Gets info about an export file without full import
 * @param {object} data - Parsed export data
 * @returns {object} Summary info
 */
export function getExportInfo(data) {
    const isMulti = data.type === 'multi';
    const collections = isMulti ? data.collections : [data];

    // Get embedding info from first collection
    const firstCollection = collections[0] || {};
    const embeddingInfo = firstCollection.embedding || data.embedding || null;

    return {
        version: data.version,
        exportDate: data.exportDate,
        generator: data.generator,
        isMulti,
        collectionCount: collections.length,
        // Embedding info for compatibility check
        embedding: embeddingInfo,
        collections: collections.map(c => ({
            id: c.collection?.id,
            name: c.collection?.name || c.collection?.id,
            contentType: c.collection?.contentType,
            scope: c.collection?.scope,
            chunkCount: c.chunks?.length || 0,
            chunksWithVectors: c.chunks?.filter(ch => ch.vector)?.length || 0,
            hasSettings: !!c.settings,
            embedding: c.embedding,
        })),
        totalChunks: collections.reduce((sum, c) => sum + (c.chunks?.length || 0), 0),
        totalChunksWithVectors: collections.reduce((sum, c) =>
            sum + (c.chunks?.filter(ch => ch.vector)?.length || 0), 0),
    };
}
