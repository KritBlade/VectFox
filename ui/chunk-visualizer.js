/**
 * ============================================================================
 * VectFox CHUNK VISUALIZER
 * ============================================================================
 * Split-panel master/detail layout for browsing and editing chunks
 * Left panel: scrollable chunk list with search/filter/sort
 * Right panel: full details of selected chunk
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import {
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
} from '../core/collection-metadata.js';
import {
    deleteVectorItems,
    insertVectorItems,
    updateChunkText,
    updateChunkMetadata,
} from '../core/core-vector-api.js';
import { getStringHash } from '../../../../utils.js';
import { getContext } from '../../../../extensions.js';
import { eventSource, getRequestHeaders } from '../../../../../script.js';
import StringUtils from '../utils/string-utils.js';
import { packTimelineSortKey } from '../core/eventbase-schema.js';

// ============================================================================
// STATE
// ============================================================================

let currentResults = null;
let currentCollectionId = null;
let currentSettings = null;
let allChunks = [];
let filteredChunks = [];
// PERF: Lookup maps for O(1) chunk access instead of O(n) find() operations
let allChunksMap = new Map(); // uniqueId -> chunk
let filteredChunksMap = new Map(); // uniqueId -> index in filteredChunks
let selectedChunkId = null; // Use uniqueId, not hash (hashes can be duplicated)
let displayLimit = 50;
let chunkFetchLimit = 0; // 0 = no limit (fetch all)
let onReloadCallback = null;
let sortBy = 'index'; // 'index', 'length-desc', 'length-asc', 'keywords', 'modified'
let filterBy = 'all'; // 'all', 'enabled', 'disabled', 'conditions', 'blind'
let searchQuery = '';
let bulkSelectMode = false;
let selectedChunksSet = new Set(); // uniqueIds checked in bulk mode
let selectedHashes = new Set();
let hasUnsavedChanges = false;
let pendingChanges = new Map(); // hash -> {keywords, enabled, conditions, etc.}
let plaintextKeywordMode = false; // Toggle for plaintext keyword editing

// ============================================================================
// COLLECTION TYPE HELPERS
// ============================================================================

/**
 * Gets the appropriate icon for the collection type
 */
function getCollectionIcon() {
    const icons = {
        chat: '💬',
        file: '📄',
        lorebook: '📚',
        document: '📝',
    };
    return icons[currentResults?.collectionType] || '📦';
}

/**
 * EventBase collections store ingested events from chat history. They use a
 * dedicated retrieval pipeline (importance/persist/recency re-rank) that
 * ignores per-chunk metadata like enabled/keywords/conditions/links.
 * Catches both the new `vf_eventbase_*` prefix and legacy `vecthare_eventbase_*`.
 */
function isEventBaseCollection() {
    const id = String(currentCollectionId || '').toLowerCase();
    return id.startsWith('vf_eventbase_') || id.includes('_eventbase_');
}

// ============================================================================
// CHUNK DATA HELPERS
// ============================================================================

// Phase B (read-source refactor): the vector backend payload is the source of truth for
// per-chunk fields. These are the ONLY fields still persisted to extension_settings on save
// — genuinely client-only state with no backend payload representation. Everything else goes
// to the backend via updateChunkMetadata. See plans/chunk-metadata-read-source-fix.md.
const CLIENT_ONLY_CHUNK_FIELDS = ['summaries'];

/**
 * Normalize keywords to the new format: { text: string, weight: number }
 * Handles migration from old string[] format
 * Weight is a MULTIPLIER: 1.0 = no boost, 1.5 = 50% boost, 2.0 = double
 */
function normalizeKeywords(keywords) {
    if (!keywords || !Array.isArray(keywords)) return [];
    return keywords.map(k => {
        // Old format: just a string
        if (typeof k === 'string') {
            return { text: k, weight: 1.5 }; // Default boost for legacy keywords
        }
        // New format: { text, weight }
        if (k && typeof k === 'object' && k.text) {
            return { text: k.text, weight: k.weight ?? 1.0 };
        }
        return null;
    }).filter(Boolean);
}

function getChunkData(chunk) {
    const stored = getChunkMetadata(chunk.hash) || {};
    const dbMeta = chunk.metadata || {};

    // Backend (Vectra/Qdrant payload) is the source of truth; extension_settings is a legacy
    // fallback for entries the backend lacks (e.g. pre-fix text-edited chunks — see
    // plans/chunk-metadata-read-source-fix.md). pick: first non-null wins. pickStr: also
    // treats '' as absent so an empty string means "use fallback", not "explicitly blank".
    const pick = (a, b) => (a !== undefined && a !== null ? a : b);
    const pickStr = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);

    // keywords: prefer non-empty backend array, then ext_settings override, then raw chunk keywords
    const keywords = (Array.isArray(dbMeta.keywords) && dbMeta.keywords.length > 0)
        ? dbMeta.keywords
        : (stored.keywords !== undefined ? stored.keywords : (chunk.keywords || []));

    return {
        hash: chunk.hash,
        index: chunk.index,
        text: chunk.text,
        score: chunk.score || 1,
        similarity: chunk.similarity || 1,
        messageAge: chunk.messageAge,
        // enabled defaults true; an explicit false (from either store) must survive
        enabled: pick(dbMeta.enabled, stored.enabled) !== false,
        keywords: normalizeKeywords(keywords),
        conditions: dbMeta.conditions || stored.conditions || { enabled: false, logic: 'AND', rules: [] },
        chunkLinks: dbMeta.chunkLinks || stored.chunkLinks || [],
        summaries: stored.summaries || [], // client-only (dual-vector summaries), unchanged
        name: pickStr(dbMeta.name, stored.name) ?? null,
        // Prompt context (existing)
        context: pickStr(dbMeta.context, stored.context) ?? '',
        xmlTag: pickStr(dbMeta.xmlTag, stored.xmlTag) ?? '',
        // Injection position/depth (null = use collection/global default; 0 is a valid value)
        position: pick(dbMeta.position, stored.position) ?? null,
        depth: pick(dbMeta.depth, stored.depth) ?? null,
        // EventBase-specific fields (read-only, from DB payload)
        eventType: chunk.metadata?.event_type || null,
        importance: chunk.metadata?.importance ?? null,
        concepts: chunk.metadata?.concepts || [],
        openThreads: chunk.metadata?.open_threads || [],
        eventItems: chunk.metadata?.items || [],
        // Real-world send-time anchor (message send_date). Deterministic metadata,
        // NOT part of the editable embed text — surfaced read-only in the info bar.
        realWorldDate: chunk.metadata?.real_world_date || null,
    };
}

function updateChunkData(hash, updates) {
    const existing = pendingChanges.get(hash) || {};
    pendingChanges.set(hash, { ...existing, ...updates });
    hasUnsavedChanges = true;
        // refresh the chunk data
        allChunks.forEach(chunk => {
            if (chunk.hash === hash) {
                // merge pending changes into the chunk for fresh data if chunks end up with same hash somehow.
                const stored = getChunkMetadata(hash) || {};
                const pending = pendingChanges.get(hash) || {};
                chunk.data = { ...chunk.data, ...pending };
            }
        });
}

async function saveAllChanges() {
    const count = pendingChanges.size;
    if (count === 0) {
        toastr.info('No changes to save', 'VectFox');
        return;
    }

    try {
        for (const [hash, updates] of pendingChanges) {
            // Check what kind of update is needed
            if (updates.text) {
                // Text changed - requires re-embedding
                await updateChunkText(currentCollectionId, hash, updates.text, currentSettings);
            }

            // Handle new summaries - vectorize them
            if (updates._newSummaries?.length > 0) {
                for (const summaryText of updates._newSummaries) {
                    const summaryHash = getStringHash(summaryText);
                    const summaryItem = {
                        text: summaryText,
                        hash: summaryHash,
                        index: 0,
                        keywords: [],
                        metadata: {
                            isSummary: true,
                            parentHash: hash,
                            contentType: 'summary',
                        },
                    };
                    await insertVectorItems(currentCollectionId, [summaryItem], currentSettings);
                }
            }

            // Handle deleted summaries - remove vectors
            if (updates._deletedSummaries?.length > 0) {
                const hashesToDelete = updates._deletedSummaries.map(text => getStringHash(text));
                await deleteVectorItems(currentCollectionId, hashesToDelete, currentSettings);
            }

            // Phase B (no dual write): the vector backend is the source of truth for
            // per-chunk fields (name/context/xmlTag/position/depth/keywords/conditions/
            // enabled/chunkLinks). Only genuinely client-only state — dual-vector
            // `summaries`, which has no backend payload field — is persisted to
            // extension_settings. See plans/chunk-metadata-read-source-fix.md (W1).
            const clientOnly = {};
            for (const k of CLIENT_ONLY_CHUNK_FIELDS) {
                if (k in updates) clientOnly[k] = updates[k];
            }
            if (Object.keys(clientOnly).length > 0) {
                const existing = getChunkMetadata(hash) || {};
                saveChunkMetadata(hash, { ...existing, ...clientOnly });
            }

            // Send per-chunk metadata to the backend (the only durable store now).
            const metadataUpdates = { ...updates };
            delete metadataUpdates.text;
            delete metadataUpdates._newSummaries;
            delete metadataUpdates._deletedSummaries;

            if (Object.keys(metadataUpdates).length > 0 ) {
                // Send metadata updates (keywords, conditions, etc.) to backend
                try {
                    await updateChunkMetadata(currentCollectionId, hash, metadataUpdates, currentSettings);
                    // Keep the in-memory backend payload fresh so backend-first reads
                    // (getChunkData) reflect the save without a full reload from the backend.
                    allChunks.forEach(c => {
                        if (c.hash === hash) {
                            c.metadata = { ...(c.metadata || {}), ...metadataUpdates };
                        }
                    });
                } catch (e) {
                    // Backend is now the only store for these fields, so a failure means the
                    // change did NOT persist — surface it instead of swallowing it.
                    console.error('VectFox: Failed to save chunk metadata to backend:', e);
                    toastr.error(`Failed to save chunk metadata to the backend — change not persisted: ${e.message}`, 'VectFox');
                    throw e;
                }
            }
        }

        pendingChanges.clear();
        hasUnsavedChanges = false;
        toastr.success(`Saved changes to ${count} chunk(s)`, 'VectFox');
    } catch (error) {
        console.error('VectFox: Failed to save changes', error);
        toastr.error(`Failed to save changes: ${error.message}`, 'VectFox');
    }
}

function discardAllChanges() {
    pendingChanges.clear();
    hasUnsavedChanges = false;
    // Reload chunk data from stored metadata
    allChunks = allChunks.map(chunk => ({
        ...chunk,
        data: getChunkData(chunk)
    }));
    // PERF: Rebuild lookup map after allChunks modification
    allChunksMap = new Map(allChunks.map(c => [c.uniqueId, c]));
    renderChunkList();
    renderDetailPanel();
}

// ============================================================================
// MAIN API
// ============================================================================

export function openVisualizer(results, collectionId, settings, onReload = null) {
    currentResults = results;
    currentCollectionId = collectionId;
    currentSettings = settings;
    onReloadCallback = onReload;
    selectedChunkId = null;
    displayLimit = 50;
    searchQuery = '';
    bulkSelectMode = false;
    selectedChunksSet.clear();
    selectedHashes.clear();
    pendingChanges.clear();
    hasUnsavedChanges = false;

    // Process chunks - add unique identifier for each chunk
    allChunks = (results?.chunks || []).map((chunk, idx) => ({
        ...chunk,
        uniqueId: `chunk_${idx}_${chunk.hash}`, // Create truly unique ID
        data: getChunkData(chunk)
    }));
    // PERF: Build lookup map for O(1) chunk access
    allChunksMap = new Map(allChunks.map(c => [c.uniqueId, c]));

    applyFilters();
    createModal();
    // Sync persisted UI state into the freshly-rendered dropdowns. createModal()
    // rebuilds the HTML, so without this the dropdowns silently revert to their
    // first option on reload while sortBy/filterBy retain the user's choice.
    $('#VectFox_chunk_sort').val(sortBy);
    $('#VectFox_chunk_filter').val(filterBy);
    renderChunkList();
    renderDetailPanel();
    bindEvents();

    $('#VectFox_visualizer_modal').fadeIn(200);

    // Async fetch collection-level metadata (sentinel point) and render in footer.
    // Read-only — surfaces internal lock state without making it look editable.
    _loadAndRenderCollectionMetaFooter(collectionId, settings).catch(err => {
        console.debug('[VectFox] Collection metadata footer load skipped:', err?.message);
    });
}

async function _loadAndRenderCollectionMetaFooter(collectionId, settings) {
    // Only Qdrant collections carry the sentinel today.
    if ((settings?.vector_backend || 'standard') !== 'qdrant') return;
    const backend = 'qdrant';

    // Strip any registry prefix (e.g. "qdrant:foo:bar" → "foo:bar") and resolve actual collection name.
    const stripped = String(collectionId).startsWith('qdrant:')
        ? String(collectionId).substring(7)
        : String(collectionId);
    const actualCollectionId = stripped.includes(':') ? stripped.split(':')[1] : stripped;

    let resp;
    try {
        resp = await fetch('/api/plugins/similharity/chunks/collection-metadata', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backend, collectionId: actualCollectionId }),
        });
    } catch {
        return;
    }
    if (!resp.ok) return;
    const data = await resp.json().catch(() => null);
    const payload = data?.payload;
    if (!payload || typeof payload !== 'object') return;

    // Surface only the keys that matter for diagnostics. Skip vector/zero junk.
    const interesting = {};
    if (payload.cjk_tokenizer_mode) interesting.cjk_tokenizer_mode = payload.cjk_tokenizer_mode;
    if (payload.migrated_at)        interesting.migrated_at        = new Date(payload.migrated_at).toISOString();
    if (payload.updated_at)         interesting.updated_at         = new Date(payload.updated_at).toISOString();
    if (payload.migrated_from)      interesting.migrated_from      = payload.migrated_from;

    if (Object.keys(interesting).length === 0) return;

    const lines = Object.entries(interesting)
        .map(([k, v]) => `<span style="margin-right:1.2em;"><b>${StringUtils.escapeHtml(k)}</b>: ${StringUtils.escapeHtml(v)}</span>`)
        .join('');

    $('#VectFox_collection_meta_footer')
        .html(`<span style="margin-right:0.8em;">🔒 Collection metadata (read-only, internal — do not delete the sentinel point in Qdrant):</span>${lines}`)
        .show();
}

export function closeVisualizer() {
    if (hasUnsavedChanges) {
        if (!confirm('You have unsaved text changes. Are you sure you want to close?')) {
            return;
        }
    }
    hasUnsavedChanges = false;
    $('#VectFox_visualizer_modal').fadeOut(200);
    currentResults = null;
    currentCollectionId = null;
    selectedChunkId = null;
}

// ============================================================================
// FILTERING & SORTING
// ============================================================================

/**
 * Whole-timeline sort value for a chunk, in true chat-history order.
 *
 * Newer EventBase chunks carry `timeline_sort_key` (window_start * STRIDE +
 * event_order) — several events from one big window keep their real order, and
 * windows processed out of order by the parallel pool still land correctly.
 *
 * Older chunks (pre-timeline_sort_key EventBase, legacy chunk/document/lorebook
 * data) lack that field. They fall back to their message number packed onto the
 * SAME scale (msg * STRIDE), so a database holding a mix of old and new chunks
 * sorts as one coherent sequence instead of splitting into two blocks. Chunks
 * with no order signal at all coalesce to 0.
 * @param {object} chunk
 * @returns {number}
 */
function chunkTimelineSortValue(chunk) {
    const meta = chunk.metadata || {};
    if (typeof meta.timeline_sort_key === 'number') return meta.timeline_sort_key;
    const messageNumber = meta.source_window_start ?? meta.source_window_end ?? chunk.index ?? 0;
    return packTimelineSortKey(messageNumber, 0);
}

function applyFilters() {
    let chunks = [...allChunks];

    // Search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        chunks = chunks.filter(c =>
            c.text.toLowerCase().includes(q) ||
            c.data.name?.toLowerCase().includes(q) ||
            c.data.keywords.some(k => k.text.toLowerCase().includes(q))
        );
    }

    // Filter
    switch (filterBy) {
        case 'enabled':
            chunks = chunks.filter(c => c.data.enabled);
            break;
        case 'disabled':
            chunks = chunks.filter(c => !c.data.enabled);
            break;
        case 'conditions':
            chunks = chunks.filter(c => c.data.conditions?.enabled && c.data.conditions?.rules?.length > 0);
            break;
        case 'keywords':
            chunks = chunks.filter(c => c.data.keywords?.length > 0);
            break;
    }

    // Sort
    switch (sortBy) {
        case 'length-desc':
            chunks.sort((a, b) => (b.data.text?.length || 0) - (a.data.text?.length || 0));
            break;
        case 'length-asc':
            chunks.sort((a, b) => (a.data.text?.length || 0) - (b.data.text?.length || 0));
            break;
        case 'keywords':
            chunks.sort((a, b) => (b.data.keywords?.length || 0) - (a.data.keywords?.length || 0));
            break;
        case 'modified':
            // Sort by whether chunk has customizations (keywords, conditions, name)
            chunks.sort((a, b) => {
                const aModified = (a.data.keywords?.length || 0) + (a.data.conditions?.rules?.length || 0) + (a.data.name ? 1 : 0);
                const bModified = (b.data.keywords?.length || 0) + (b.data.conditions?.rules?.length || 0) + (b.data.name ? 1 : 0);
                return bModified - aModified;
            });
            break;
        case 'index-r':
            chunks.sort((a, b) => chunkTimelineSortValue(b) - chunkTimelineSortValue(a));
            break;
        default: // 'index'
            chunks.sort((a, b) => chunkTimelineSortValue(a) - chunkTimelineSortValue(b));
    }

    filteredChunks = chunks;
    // PERF: Build lookup map for O(1) position lookup
    filteredChunksMap = new Map(filteredChunks.map((c, idx) => [c.uniqueId, idx]));
}

// ============================================================================
// MODAL CREATION
// ============================================================================

function createModal() {
    // Remove existing
    $('#VectFox_visualizer_modal').remove();

    const collectionName = currentCollectionId || 'Collection';
    const icon = getCollectionIcon();
    const dbChunkCount = Number(currentResults?.dbChunkCount);
    const dbChunkText = Number.isFinite(dbChunkCount) && dbChunkCount >= 0
        ? dbChunkCount.toLocaleString()
        : 'Unknown';

    const html = `
        <div id="VectFox_visualizer_modal" class="vectfox-visualizer-modal">
            <div class="vectfox-visualizer-container">
                <!-- Header -->
                <div class="vectfox-visualizer-header">
                    <div class="vectfox-visualizer-title">
                        <span class="vectfox-visualizer-title-icon">${icon}</span>
                        <span>${StringUtils.escapeHtml(collectionName)}</span>
                    </div>
                    <div class="vectfox-visualizer-header-actions">
                        <button class="vectfox-visualizer-save" id="VectFox_visualizer_save" title="Save changes">
                            <i class="fa-solid fa-floppy-disk"></i> Save
                        </button>
                        <button class="vectfox-visualizer-close" id="VectFox_visualizer_close">✕</button>
                    </div>
                </div>

                <!-- Body: Chunk Split Panel -->
                <div class="vectfox-visualizer-body">
                    <!-- Left: Chunk List -->
                    <div class="vectfox-chunk-list-panel">
                        <div class="vectfox-list-toolbar">
                            <input type="text" class="vectfox-list-search" id="VectFox_chunk_search" placeholder="🔍 Search...">
                            <div class="vectfox-list-controls">
                                <select class="vectfox-list-sort" id="VectFox_chunk_sort">
                                    <option value="index">Sort: Message Order</option>
                                    <option value="length-desc">Sort: Longest First</option>
                                    <option value="length-asc">Sort: Shortest First</option>
                                    <option value="keywords">Sort: Most Keywords</option>
                                    <option value="modified">Sort: Recently Modified</option>
                                    <option value="index-r">Sort: Message order Reversed</option>

                                </select>
                                <select class="vectfox-list-filter" id="VectFox_chunk_filter">
                                    <option value="all">Filter: All</option>
                                    <option value="enabled">Enabled</option>
                                    <option value="disabled">Disabled</option>
                                    <option value="keywords">Has Keywords</option>
                                    <option value="conditions">Has Conditions</option>
                                </select>
                            </div>
                                <div class="vectfox-fetch-limit-control">
                                    <label>Fetch limit:</label>
                                    <input type="number" id="VectFox_fetch_limit" min="0" max="99999" step="100" value="${chunkFetchLimit}" title="Max chunks loaded from server (0 = all)">
                                    <button id="VectFox_reload_chunks" title="Reload chunks from server with new limit">↺ Reload</button>
                                </div>
                                <div class="vectfox-db-total" id="VectFox_db_chunk_total">DB max chunks: ${dbChunkText}</div>
                        </div>
                        <div class="vectfox-chunk-list" id="VectFox_chunk_list"></div>
                        <div class="vectfox-bulk-actions">
                            <label class="vectfox-bulk-toggle">
                                <input type="checkbox" id="VectFox_bulk_mode">
                                <span>Bulk Select Mode</span>
                            </label>
                            <div class="vectfox-bulk-buttons" id="VectFox_bulk_buttons" style="display: none;">
                                <button class="vectfox-bulk-btn" id="VectFox_bulk_enable">Enable All</button>
                                <button class="vectfox-bulk-btn" id="VectFox_bulk_disable">Disable All</button>
                                <button class="vectfox-bulk-btn vectfox-bulk-btn-danger" id="VectFox_bulk_delete">Delete Selected</button>
                            </div>
                        </div>
                        <div class="vectfox-list-status" id="VectFox_list_status"></div>
                    </div>

                    <!-- Right: Detail Panel -->
                    <div class="vectfox-chunk-detail-panel" id="VectFox_detail_panel">
                        <div class="vectfox-detail-empty">Select a chunk to view details</div>
                    </div>
                </div>

                <!-- Read-only collection metadata footer (sentinel point). Populated async after modal opens. -->
                <div class="vectfox-visualizer-meta-footer" id="VectFox_collection_meta_footer" style="display:none; padding: 8px 16px; border-top: 1px solid var(--grey30); font-size: 0.78em; color: var(--SmartThemeBodyColor); opacity: 0.7; font-family: monospace;"></div>
            </div>
        </div>
    `;

    $('body').append(html);
}

// ============================================================================
// CHUNK LIST RENDERING
// ============================================================================

function renderChunkList() {
    const container = $('#VectFox_chunk_list');
    const displayChunks = filteredChunks.slice(0, displayLimit);

    let html = displayChunks.map((chunk, idx) => renderChunkItem(chunk, idx)).join('');

    if (filteredChunks.length > displayLimit) {
        html += `<div class="vectfox-load-more" id="VectFox_load_more">[Load ${Math.min(50, filteredChunks.length - displayLimit)} more...]</div>`;
    }

    container.html(html);
    updateStatusBar();
}

function renderChunkItem(chunk, listIndex) {
    const data = chunk.data;
    const isSelected = chunk.uniqueId === selectedChunkId;
    const hasConditions = data.conditions?.enabled && data.conditions?.rules?.length > 0;
    const hasKeywords = data.keywords?.length > 0;

    // Use the display position in the filtered/sorted list (1-based)
    const displayNumber = listIndex + 1;

    // Create a text preview (first ~60 chars, clean it up)
    const textPreview = data.text
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 60) + (data.text.length > 60 ? '...' : '');

    // Use custom name if set, otherwise show text preview
    const displayName = data.name || textPreview;

    // Calculate text length for display
    const textLength = data.text?.length || 0;
    const textLengthDisplay = textLength > 1000 ? `${(textLength / 1000).toFixed(1)}k` : textLength;

    // Message info from metadata. For windowed EventBase chunks, show the source
    // window's message range plus the event's order within that window (decoded
    // from the same fields that drive the timeline sort) — e.g. "Msg 2527–2531 ·
    // #3" — so multiple events extracted from one big window are told apart.
    // Legacy chunks (no window fields) keep the plain "Msg <n>" form.
    const msgId = chunk.metadata?.messageId ?? chunk.index ?? '?';
    const windowStart = chunk.metadata?.source_window_start;
    const windowEnd = chunk.metadata?.source_window_end;
    const eventOrder = chunk.metadata?.window_event_order;
    let msgLabel = `Msg ${msgId}`;
    if (windowStart != null && windowEnd != null && windowEnd !== windowStart) {
        msgLabel = `Msg ${windowStart}–${windowEnd}`;
    }
    if (typeof eventOrder === 'number') {
        msgLabel += ` · #${eventOrder + 1}`;
    }
    const chunkIdx = chunk.metadata?.chunkIndex ?? 0;
    const totalChunks = chunk.metadata?.totalChunks ?? 1;

    // Build info badges
    const infoBadges = [];
    infoBadges.push(`<span class="vectfox-chunk-item-badge msg">${msgLabel}</span>`);
    if (totalChunks > 1) {
        infoBadges.push(`<span class="vectfox-chunk-item-badge chunk-part">${chunkIdx + 1}/${totalChunks}</span>`);
    }
    infoBadges.push(`<span class="vectfox-chunk-item-badge chars">${textLengthDisplay} chars</span>`);

    // Build feature badges
    const featureBadges = [];
    if (hasConditions) featureBadges.push(`<span class="vectfox-chunk-item-badge conditions" title="Has ${data.conditions.rules.length} condition(s)">⚡${data.conditions.rules.length}</span>`);
    if (hasKeywords) featureBadges.push(`<span class="vectfox-chunk-item-badge keywords" title="Has ${data.keywords.length} keyword(s)">🏷️${data.keywords.length}</span>`);

    const bulkCheckbox = bulkSelectMode
        ? `<input type="checkbox" class="vectfox-bulk-checkbox" data-uid="${chunk.uniqueId}" ${selectedChunksSet.has(chunk.uniqueId) ? 'checked' : ''} title="Select for bulk action">`
        : '';

    return `
        <div class="vectfox-chunk-item ${isSelected ? 'selected' : ''} ${!data.enabled ? 'disabled' : ''} ${bulkSelectMode && selectedChunksSet.has(chunk.uniqueId) ? 'bulk-checked' : ''}"
             data-uid="${chunk.uniqueId}" data-list-index="${listIndex}">
            ${bulkCheckbox}
            <div class="vectfox-chunk-item-content">
                <div class="vectfox-chunk-item-header">
                    <span class="vectfox-chunk-item-index">${displayNumber}.</span>
                    <span class="vectfox-chunk-item-name">${StringUtils.escapeHtml(displayName)}</span>
                </div>
                <div class="vectfox-chunk-item-stats">
                    <div class="vectfox-chunk-item-badges info-badges">${infoBadges.join('')}</div>
                    ${featureBadges.length > 0 ? `<div class="vectfox-chunk-item-badges feature-badges">${featureBadges.join('')}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function updateStatusBar() {
    const shown = filteredChunks.length;
    let withConditions = 0;
    let withKeywords = 0;
    for (const c of allChunks) {
        if (c.data.conditions?.enabled && c.data.conditions?.rules?.length > 0) withConditions++;
        if (c.data.keywords?.length > 0) withKeywords++;
    }

    $('#VectFox_list_status').html(`
        <span>${shown} chunks</span>
        ${withKeywords > 0 ? `<span>• 🏷️${withKeywords}</span>` : ''}
        ${withConditions > 0 ? `<span>• ⚡${withConditions}</span>` : ''}
    `);
}

// ============================================================================
// DETAIL PANEL RENDERING
// ============================================================================

function renderDetailPanel() {
    const panel = $('#VectFox_detail_panel');

    if (!selectedChunkId) {
        panel.html('<div class="vectfox-detail-empty">Select a chunk to view details</div>');
        return;
    }

    // PERF: Use Map for O(1) lookup instead of O(n) find()
    const chunk = allChunksMap.get(selectedChunkId);
    if (!chunk) {
        console.error('VectFox: Chunk not found for uniqueId:', selectedChunkId);
        panel.html('<div class="vectfox-detail-empty">Chunk not found</div>');
        return;
    }

    const data = chunk.data;
    const wordCount = data.text.split(/\s+/).filter(Boolean).length;
    const tokenEstimate = Math.round(wordCount * 1.3);

    // PERF: Use Map for O(1) lookup instead of O(n) findIndex()
    const listPosition = filteredChunksMap.get(selectedChunkId);
    const displayNumber = listPosition !== undefined ? listPosition + 1 : '?';

    const hasConditions = data.conditions?.enabled && data.conditions?.rules?.length > 0;
    const hasSummaries = data.summaries?.length > 0;

    // Feature gating — EventBase chat ignores per-chunk enabled/keywords/conditions/links
    // (its retrieval re-ranks by importance/persist/recency). XML tag and injection
    // position still apply because they're consumed at the post-retrieval injection stage.
    const isEventBase = isEventBaseCollection();
    const showEnabledToggle = !isEventBase;
    const showKeywords = !isEventBase;
    const showConditions = !isEventBase;
    const showChunkLinks = !isEventBase;

    panel.html(`
        <!-- Header -->
        <div class="vectfox-detail-header">
            <!-- Chunk Name - Primary/Biggest -->
            <div class="vectfox-detail-name-section">
                <input type="text" class="vectfox-chunk-name-input" id="VectFox_chunk_name"
                       placeholder="Name this chunk..."
                       value="${StringUtils.escapeHtml(data.name || '')}">
            </div>
            <button class="vectfox-detail-delete${bulkSelectMode ? ' vectfox-btn-dimmed' : ''}" id="VectFox_delete_chunk" ${bulkSelectMode ? 'disabled' : ''}>
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        </div>

        <!-- Chunk Info Bar - Secondary -->
        <div class="vectfox-detail-info-bar">
            <span class="vectfox-info-item">
                <span class="vectfox-info-label">Chunk</span>
                <span class="vectfox-info-value">#${displayNumber}</span>
            </span>
            <span class="vectfox-info-divider">•</span>
            <span class="vectfox-info-item">
                <span class="vectfox-info-label">from Message</span>
                <span class="vectfox-info-value">#${chunk.index}</span>
            </span>
            ${data.realWorldDate ? `
            <span class="vectfox-info-divider">•</span>
            <span class="vectfox-info-item" title="Real-world send time of the source message (fallback date anchor — NOT the in-story TIME)">
                <span class="vectfox-info-label">Real-world</span>
                <span class="vectfox-info-value">${StringUtils.escapeHtml(String(data.realWorldDate))}</span>
            </span>` : ''}
            <span class="vectfox-info-divider">•</span>
            <span class="vectfox-info-item vectfox-info-hash" title="Click to copy hash" id="VectFox_copy_hash">
                <span class="vectfox-info-value">${chunk.hash}</span>
            </span>
        </div>

        <!-- Content -->
        <div class="vectfox-detail-content">
            <!-- Text Block - Inline Editable -->
            <div class="vectfox-detail-text-block">
                <div class="vectfox-detail-text" id="VectFox_chunk_text" contenteditable="true">${StringUtils.escapeHtml(data.text)}</div>
                <div class="vectfox-detail-text-meta">
                    <span>${wordCount} words • ~${tokenEstimate} tokens</span>
                    <button class="vectfox-detail-save-btn vectfox-hidden" id="VectFox_save_text">
                        <i class="fa-solid fa-save"></i> Save & Re-embed
                    </button>
                </div>
            </div>

            <!-- EventBase Metadata Section (read-only) -->
            ${isEventBase ? `
            <div class="vectfox-detail-section vectfox-eventbase-meta">
                <div class="vectfox-detail-section-title">
                    <i class="fa-solid fa-database"></i> Event Metadata
                    <span class="vectfox-section-hint">(extracted by EventBase)</span>
                </div>
                <div class="vectfox-eventbase-meta-grid">
                    <div class="vectfox-meta-row">
                        <span class="vectfox-meta-label">Type</span>
                        <span class="vectfox-meta-value">${data.eventType
                            ? `<span class="vectfox-event-type-badge">${StringUtils.escapeHtml(data.eventType)}</span>`
                            : '<span class="vectfox-meta-empty">—</span>'}</span>
                    </div>
                    <div class="vectfox-meta-row">
                        <span class="vectfox-meta-label">Importance</span>
                        <span class="vectfox-meta-value">${data.importance != null
                            ? `<span class="vectfox-importance-badge vectfox-imp-${Math.min(10, Math.max(1, Math.round(data.importance)))}">${data.importance}<span class="vectfox-imp-scale">/10</span></span>`
                            : '<span class="vectfox-meta-empty">—</span>'}</span>
                    </div>
                    <div class="vectfox-meta-row">
                        <span class="vectfox-meta-label">Concepts</span>
                        <span class="vectfox-meta-value">${data.concepts.length
                            ? data.concepts.map(c => `<span class="vectfox-concept-tag">${StringUtils.escapeHtml(c)}</span>`).join('')
                            : '<span class="vectfox-meta-empty">—</span>'}</span>
                    </div>
                    <div class="vectfox-meta-row">
                        <span class="vectfox-meta-label">Items</span>
                        <span class="vectfox-meta-value">${data.eventItems.length
                            ? data.eventItems.map(it => `<span class="vectfox-concept-tag">${StringUtils.escapeHtml(it)}</span>`).join('')
                            : '<span class="vectfox-meta-empty">—</span>'}</span>
                    </div>
                    ${data.openThreads.length ? `
                    <div class="vectfox-meta-row vectfox-meta-row-full">
                        <span class="vectfox-meta-label">Open Threads</span>
                        <ul class="vectfox-open-threads-list">
                            ${data.openThreads.map(t => `<li>${StringUtils.escapeHtml(t)}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                </div>
            </div>
            ` : ''}

            <!-- Status Section -->
            ${showEnabledToggle ? `
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-title">Status</div>
                <div class="vectfox-detail-status-row">
                    ${showEnabledToggle ? `
                    <div class="vectfox-detail-toggle-item">
                        <span class="vectfox-toggle-label">Enabled</span>
                        <label class="vectfox-toggle-switch">
                            <input type="checkbox" id="VectFox_detail_enabled" ${data.enabled ? 'checked' : ''}>
                            <span class="vectfox-toggle-slider"></span>
                        </label>
                    </div>
                    ` : ''}
                </div>
            </div>
            ` : ''}

            <!-- Prompt Context Section -->
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-title">
                    <i class="fa-solid fa-quote-left"></i> Prompt Context
                    <span class="vectfox-section-hint">(help AI understand this chunk)</span>
                </div>
                <div class="vectfox-detail-context">
                    <textarea class="vectfox-chunk-context-input" id="VectFox_chunk_context"
                              placeholder="e.g., A secret {{char}} keeps hidden from {{user}}"
                              rows="2">${StringUtils.escapeHtml(data.context || '')}</textarea>
                    <div class="vectfox-context-xmltag-row">
                        <label>XML tag:</label>
                        <input type="text" class="vectfox-chunk-xmltag-input" id="VectFox_chunk_xmltag"
                               placeholder="e.g., secret" value="${StringUtils.escapeHtml(data.xmlTag || '')}">
                    </div>
                    <div class="vectfox-context-injection-row">
                        <label>Injection position:</label>
                        <select id="VectFox_chunk_position" class="vectfox-chunk-position-select">
                            <option value="" ${data.position == null ? 'selected' : ''}>Use default</option>
                            <option value="2" ${data.position === 2 ? 'selected' : ''}>Before Main Prompt</option>
                            <option value="0" ${data.position === 0 ? 'selected' : ''}>After Main Prompt</option>
                            <option value="1" ${data.position === 1 ? 'selected' : ''}>In-Chat @ Depth</option>
                        </select>
                    </div>
                    <div class="vectfox-context-depth-row" id="VectFox_chunk_depth_row" style="display: ${data.position === 1 ? 'flex' : 'none'};">
                        <label>Depth: <span id="VectFox_chunk_depth_value">${data.depth ?? 2}</span></label>
                        <input type="range" id="VectFox_chunk_depth" class="vectfox-chunk-depth-slider"
                               min="0" max="50" step="1" value="${data.depth ?? 2}">
                    </div>
                    <div class="vectfox-context-hint">Supports {{user}} and {{char}}. XML tag wraps just this chunk.</div>
                </div>
            </div>

            <!-- Keywords Section -->
            ${showKeywords ? `
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-header">
                    <span class="vectfox-detail-section-title">Keywords <span class="vectfox-section-hint">(boost when query matches)</span></span>
                    <button class="vectfox-keyword-mode-toggle" id="VectFox_keyword_mode" title="Toggle plaintext mode">
                        <i class="fa-solid ${plaintextKeywordMode ? 'fa-tag' : 'fa-code'}"></i>
                    </button>
                </div>
                <div class="vectfox-detail-keywords" id="VectFox_keywords_container">
                    ${plaintextKeywordMode ? `
                        <textarea class="vectfox-keyword-plaintext" id="VectFox_keywords_plaintext" placeholder="keyword:1.5x, another:2x, plain">${data.keywords.map(k => k.weight !== 1.0 ? `${k.text}:${k.weight}x` : k.text).join(', ')}</textarea>
                        <div class="vectfox-keyword-plaintext-hint">Format: keyword:2x for boost, or just keyword (defaults to 1.5x)</div>
                    ` : `
                        <div class="vectfox-keywords-list">
                            ${data.keywords.map((k, idx) => `
                                <span class="vectfox-keyword-tag" data-index="${idx}">
                                    <span class="vectfox-keyword-tag-text">${StringUtils.escapeHtml(k.text || 'unnamed')}</span>
                                    <span class="vectfox-keyword-tag-weight">${k.weight}x</span>
                                    <i class="fa-solid fa-xmark vectfox-keyword-remove" data-index="${idx}"></i>
                                </span>
                            `).join('')}
                        </div>
                        <button class="vectfox-keyword-add" id="VectFox_add_keyword">+ Add keyword...</button>
                    `}
                </div>
            </div>
            ` : ''}

            <!-- Conditions Section -->
            ${showConditions ? `
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-title">Conditions</div>
                <div class="vectfox-detail-conditions">
                    <div class="vectfox-conditions-header">
                        <label class="vectfox-conditions-toggle">
                            <input type="checkbox" id="VectFox_conditions_enabled" ${data.conditions?.enabled ? 'checked' : ''}>
                            <span>Enable conditional activation</span>
                        </label>
                        <div class="vectfox-conditions-logic">
                            <button class="vectfox-logic-btn ${data.conditions?.logic === 'AND' ? 'active' : ''}" data-logic="AND">AND</button>
                            <button class="vectfox-logic-btn ${data.conditions?.logic === 'OR' ? 'active' : ''}" data-logic="OR">OR</button>
                        </div>
                    </div>
                    <div class="vectfox-conditions-list" id="VectFox_conditions_list">
                        ${(data.conditions?.rules || []).map((rule, i) => `
                            <div class="vectfox-condition-item" data-index="${i}">
                                <span class="vectfox-condition-item-num">${i + 1}.</span>
                                <span class="vectfox-condition-item-text">${StringUtils.escapeHtml(formatConditionRule(rule))}</span>
                                <i class="fa-solid fa-xmark vectfox-condition-item-remove"></i>
                            </div>
                        `).join('')}
                    </div>
                    <button class="vectfox-add-condition-btn" id="VectFox_add_condition">+ Add Condition Rule</button>
                </div>
            </div>
            ` : ''}

            <!-- Chunk Links Section -->
            ${showChunkLinks ? `
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-title">
                    <i class="fa-solid fa-link"></i> Chunk Links
                    <span class="vectfox-section-hint">(pull related chunks into results)</span>
                </div>
                <div class="vectfox-detail-links">
                    <div class="vectfox-links-list" id="VectFox_links_list">
                        ${(data.chunkLinks || []).map((link, i) => `
                            <div class="vectfox-link-item ${link.mode}" data-index="${i}">
                                <span class="vectfox-link-mode-badge ${link.mode}">${link.mode === 'force' ? '🔗 Force' : '〰️ Soft'}</span>
                                <span class="vectfox-link-target" title="Target hash: ${link.targetHash}">${link.targetHash.toString().substring(0, 12)}...</span>
                                <i class="fa-solid fa-xmark vectfox-link-item-remove"></i>
                            </div>
                        `).join('')}
                    </div>
                    <div class="vectfox-links-help">
                        <span class="vectfox-help-badge force">Force</span> = Target chunk MUST appear if this chunk appears<br>
                        <span class="vectfox-help-badge soft">Soft</span> = Target chunk gets score boost if this chunk appears
                    </div>
                    <button class="vectfox-add-link-btn" id="VectFox_add_link">+ Add Link</button>
                </div>
            </div>
            ` : ''}

            <!-- Summaries Section -->
            <div class="vectfox-detail-section">
                <div class="vectfox-detail-section-title">Dual-Vector Summaries</div>
                <div class="vectfox-detail-summaries">
                    <div class="vectfox-summaries-header">
                        <span>Alternative search vectors for this chunk</span>
                    </div>
                    <div class="vectfox-summaries-list" id="VectFox_summaries_list">
                        ${(data.summaries || []).map((summary, i) => {
                            const summaryHash = getStringHash(summary);
                            return `
                            <div class="vectfox-summary-item" data-index="${i}">
                                <div class="vectfox-summary-item-content">
                                    <span class="vectfox-summary-item-text">${StringUtils.escapeHtml(summary)}</span>
                                    <span class="vectfox-summary-item-hash" title="Summary vector hash">#${summaryHash}</span>
                                </div>
                                <i class="fa-solid fa-xmark vectfox-summary-item-remove"></i>
                            </div>
                        `}).join('')}
                    </div>
                    <button class="vectfox-add-summary-btn" id="VectFox_add_summary">+ Add Summary</button>
                </div>
            </div>
        </div>
    `);

    bindDetailEvents();
}

function formatConditionRule(rule) {
    if (!rule || !rule.type) return 'Unknown condition';

    const negation = rule.negated ? 'NOT ' : '';
    const value = rule.settings?.value || rule.value || '';  // Support both formats

    switch (rule.type) {
        case 'pattern':
            return `${negation}Pattern: "${value}"`;
        case 'speaker':
            return `${negation}Speaker: ${value || 'undefined'}`;
        case 'messageCount':
            // Extract operator and number if value is like ">=100" or just "100"
            const match = value.match(/^([><=!]+)?(\d+)$/);
            if (match) {
                const operator = match[1] || '>=';
                const count = match[2];
                return `${negation}Message Count ${operator} ${count}`;
            }
            return `${negation}Message Count: ${value}`;
        case 'isGroupChat':
            return `${negation}Is Group Chat`;
        case 'timeOfDay':
            // Handle different time formats
            if (!value) return `${negation}Time of Day: (no time set)`;
            return `${negation}Time of Day: ${value}`;
        case 'randomChance':
            // Value should be a percentage
            const percent = value || rule.settings?.percent || '50';
            return `${negation}Random Chance: ${percent}%`;
        default:
            return `${negation}${rule.type}: ${value || '(empty)'}`;
    }
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // Save
    $('#VectFox_visualizer_save').on('click', saveAllChanges);

    // Close
    $('#VectFox_visualizer_close').on('click', closeVisualizer);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#VectFox_visualizer_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });
    // Close on background click
    $('#VectFox_visualizer_modal').on('click', function(e) {
        if (e.target === this) closeVisualizer();
    });

    // Search
    $('#VectFox_chunk_search').on('input', debounce(function() {
        searchQuery = $(this).val();
        applyFilters();
        renderChunkList();
    }, 200));

    // Sort
    $('#VectFox_chunk_sort').on('change', function() {
        sortBy = $(this).val();
        applyFilters();
        renderChunkList();
    });

    // Filter
    $('#VectFox_chunk_filter').on('change', function() {
        filterBy = $(this).val();
        applyFilters();
        renderChunkList();
    });

    // Fetch limit (0 = no limit)
    $('#VectFox_fetch_limit').on('change', function() {
        const val = parseInt($(this).val());
        chunkFetchLimit = isNaN(val) || val < 0 ? 0 : val;
        $(this).val(chunkFetchLimit);
    });

    // Reload button
    $('#VectFox_reload_chunks').off('click').on('click', function() {
        if (onReloadCallback) onReloadCallback(chunkFetchLimit);
    });

    // Chunk selection - bind to container, not document (because modal stops propagation)
    $('#VectFox_visualizer_modal').on('click', '.vectfox-chunk-item', function(e) {
        // Let the checkbox handle its own click/change — e.preventDefault() below would cancel the toggle
        if ($(e.target).hasClass('vectfox-bulk-checkbox')) return;
        e.preventDefault();
        e.stopPropagation();
        const uid = $(this).attr('data-uid');
        if (currentSettings?.eventbase_debug_logging) console.log('VectFox: Clicked chunk with uniqueId:', uid);
        if (!uid) {
            console.error('VectFox: No uniqueId found on clicked element');
            return;
        }
        // Warn if switching chunks with unsaved changes
        if (hasUnsavedChanges && uid !== selectedChunkId) {
            if (!confirm('You have unsaved text changes. Switch chunks anyway?')) {
                return;
            }
            hasUnsavedChanges = false;
        }
        selectedChunkId = uid;
        renderChunkList();
        renderDetailPanel();
    });

    // Load more
    $('#VectFox_visualizer_modal').on('click', '#VectFox_load_more', function() {
        displayLimit += 50;
        renderChunkList();
    });

    // Bulk mode
    $('#VectFox_bulk_mode').on('change', function() {
        bulkSelectMode = $(this).is(':checked');
        if (!bulkSelectMode) {
            selectedChunksSet.clear();
            $('#VectFox_bulk_delete').text('Delete Selected');
        }
        $('#VectFox_bulk_buttons').toggle(bulkSelectMode);
        $('#VectFox_delete_chunk').prop('disabled', bulkSelectMode).toggleClass('vectfox-btn-dimmed', bulkSelectMode);
        renderChunkList();
    });

    // Per-chunk bulk checkboxes (delegated — list is re-rendered frequently)
    $('#VectFox_chunk_list').on('change', '.vectfox-bulk-checkbox', function(e) {
        e.stopPropagation();
        const uid = $(this).data('uid');
        if ($(this).is(':checked')) {
            selectedChunksSet.add(uid);
        } else {
            selectedChunksSet.delete(uid);
        }
        // Update the row highlight without a full re-render
        $(this).closest('.vectfox-chunk-item').toggleClass('bulk-checked', $(this).is(':checked'));
        // Update button labels to show selection count
        const count = selectedChunksSet.size;
        const label = count > 0 ? ` (${count})` : '';
        $('#VectFox_bulk_enable').text(`Enable All${label}`);
        $('#VectFox_bulk_disable').text(`Disable All${label}`);
        $('#VectFox_bulk_delete').text(count > 0 ? `Delete Selected (${count})` : 'Delete Selected');
    });

    $('#VectFox_bulk_enable').on('click', () => bulkSetEnabled(true));
    $('#VectFox_bulk_disable').on('click', () => bulkSetEnabled(false));
    $('#VectFox_bulk_delete').on('click', () => bulkDelete());
}

function bindDetailEvents() {
    // PERF: Use Map for O(1) lookup instead of O(n) find()
    const chunk = allChunksMap.get(selectedChunkId);
    if (!chunk) return;

    const originalText = chunk.data.text;

    // Chunk name input
    $('#VectFox_chunk_name').on('input', debounce(function() {
        const name = $(this).val().trim();
        chunk.data.name = name || null;
        updateChunkData(chunk.hash, { name: chunk.data.name });
        renderChunkList();
    }, 300));

    // Inline text editing - track changes
    $('#VectFox_chunk_text').on('input', function() {
        const newText = $(this).text().trim();
        if (newText !== originalText) {
            hasUnsavedChanges = true;
            $('#VectFox_save_text').removeClass('vectfox-hidden');
        } else {
            hasUnsavedChanges = false;
            $('#VectFox_save_text').addClass('vectfox-hidden');
        }
    });

    // Save text changes
    $('#VectFox_save_text').on('click', async function() {
        const newText = $('#VectFox_chunk_text').text().trim();
        if (!newText) return;

        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

        try {
            // Delete old
            await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);

            // Insert new with new hash (keep as number for Qdrant compatibility)
            const newHash = getStringHash(newText);
            // Carry existing metadata onto the NEW backend point. Re-embedding creates a
            // fresh point with a new hash; the backend is the source of truth, so the
            // payload must be carried over — merge the backend payload over any legacy
            // ext_settings entry. Without this, text-editing wipes name/context/keywords
            // etc. See plans/chunk-metadata-read-source-fix.md (R8).
            const oldStored = getChunkMetadata(String(chunk.hash)) || {};
            const carriedMeta = { ...oldStored, ...(chunk.metadata || {}) };
            delete carriedMeta.hash;
            delete carriedMeta.text;
            await insertVectorItems(currentCollectionId, [{
                hash: newHash,
                text: newText,
                index: chunk.index,
                metadata: carriedMeta,
            }], currentSettings);

            // Backend fields were carried onto the new point above (Phase B: backend is the
            // source of truth). In ext_settings, only migrate client-only state (summaries)
            // to the new hash and drop the old entry.
            deleteChunkMetadata(String(chunk.hash));
            const carriedClientOnly = {};
            for (const k of CLIENT_ONLY_CHUNK_FIELDS) {
                if (k in oldStored) carriedClientOnly[k] = oldStored[k];
            }
            if (Object.keys(carriedClientOnly).length > 0) {
                saveChunkMetadata(String(newHash), carriedClientOnly);
            }

            // Update local state
            chunk.hash = newHash;
            chunk.text = newText;
            chunk.data.text = newText;
            hasUnsavedChanges = false;

            renderChunkList();
            renderDetailPanel();
            toastr.success('Chunk updated successfully', 'VectFox');
        } catch (error) {
            console.error('Failed to update chunk:', error);
            toastr.error('Failed to update chunk', 'VectFox');
            $(this).prop('disabled', false).html('<i class="fa-solid fa-save"></i> Save & Re-embed');
        }
    });

    // Enabled toggle
    $('#VectFox_detail_enabled').on('change', function() {
        const enabled = $(this).is(':checked');
        updateChunkData(chunk.hash, { enabled });
        chunk.data.enabled = enabled;
        renderChunkList();
    });

    // Prompt context input
    $('#VectFox_chunk_context').on('input', debounce(function() {
        const context = $(this).val();
        chunk.data.context = context || '';
        updateChunkData(chunk.hash, { context: chunk.data.context });
    }, 300));

    // XML tag input (sanitize to alphanumeric + underscore/hyphen)
    $('#VectFox_chunk_xmltag').on('input', debounce(function() {
        const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
        $(this).val(sanitized);
        chunk.data.xmlTag = sanitized || '';
        updateChunkData(chunk.hash, { xmlTag: chunk.data.xmlTag });
    }, 300));

    // Injection position select
    $('#VectFox_chunk_position').on('change', function() {
        const val = $(this).val();
        const position = val === '' ? null : parseInt(val);
        chunk.data.position = position;
        updateChunkData(chunk.hash, { position: chunk.data.position });
        // Show/hide depth row
        $('#VectFox_chunk_depth_row').toggle(position === 1);
    });

    // Injection depth slider
    $('#VectFox_chunk_depth').on('input', function() {
        const depth = parseInt($(this).val()) || 2;
        $('#VectFox_chunk_depth_value').text(depth);
        chunk.data.depth = depth;
        updateChunkData(chunk.hash, { depth: chunk.data.depth });
    });

    // Delete chunk
    $('#VectFox_delete_chunk').on('click', () => deleteChunk(chunk));

    // Keyword mode toggle (plaintext vs badge)
    $('#VectFox_keyword_mode').on('click', function() {
        // If in plaintext mode, parse and save before switching
        if (plaintextKeywordMode) {
            const plaintext = $('#VectFox_keywords_plaintext').val();
            chunk.data.keywords = parsePlaintextKeywords(plaintext);
            updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
        }
        plaintextKeywordMode = !plaintextKeywordMode;
        renderDetailPanel();
    });

    // Plaintext keywords - save on blur
    $('#VectFox_keywords_plaintext').on('blur', function() {
        const plaintext = $(this).val();
        chunk.data.keywords = parsePlaintextKeywords(plaintext);
        updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
    });

    // Keywords - add new
    $('#VectFox_add_keyword').on('click', function() {
        $(this).replaceWith('<input type="text" class="vectfox-keyword-input" id="VectFox_keyword_input" placeholder="Enter keyword...">');
        $('#VectFox_keyword_input').focus().on('keydown', function(e) {
            if (e.key === 'Enter') {
                const keyword = $(this).val().trim();
                if (keyword && !chunk.data.keywords.some(k => k.text === keyword)) {
                    chunk.data.keywords.push({ text: keyword, weight: 1.5 }); // Default 1.5x boost
                    updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
                }
                renderDetailPanel();
            } else if (e.key === 'Escape') {
                renderDetailPanel();
            }
        }).on('blur', function() {
            renderDetailPanel();
        });
    });

    // Keyword remove button
    $('.vectfox-keyword-remove').on('click', function() {
        const index = $(this).data('index');
        chunk.data.keywords.splice(index, 1);
        updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
        renderDetailPanel();
    });

    // Conditions
    $('#VectFox_conditions_enabled').on('change', function() {
        chunk.data.conditions.enabled = $(this).is(':checked');
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
    });

    $('.vectfox-logic-btn').on('click', function() {
        const logic = $(this).data('logic');
        chunk.data.conditions.logic = logic;
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
        $('.vectfox-logic-btn').removeClass('active');
        $(this).addClass('active');
    });

    $('.vectfox-condition-item-remove').on('click', function() {
        const index = $(this).closest('.vectfox-condition-item').data('index');
        chunk.data.conditions.rules.splice(index, 1);
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
        renderDetailPanel();
        renderChunkList();
    });

    // Add condition rule
    $('#VectFox_add_condition').on('click', function() {
        openConditionEditor(chunk);
    });

    // Chunk links
    $('#VectFox_add_link').on('click', function() {
        openLinkEditor(chunk);
    });

    $('.vectfox-link-item-remove').on('click', function() {
        const index = $(this).closest('.vectfox-link-item').data('index');
        chunk.data.chunkLinks.splice(index, 1);
        updateChunkData(chunk.hash, { chunkLinks: chunk.data.chunkLinks });
        renderDetailPanel();
    });

    // Summaries
    $('.vectfox-summary-item-remove').on('click', function() {
        const index = $(this).closest('.vectfox-summary-item').data('index');
        const summaryText = chunk.data.summaries[index];

        // Track for deletion on save
        if (!chunk.data._deletedSummaries) chunk.data._deletedSummaries = [];
        chunk.data._deletedSummaries.push(summaryText);

        // Remove from local data
        chunk.data.summaries.splice(index, 1);
        updateChunkData(chunk.hash, { summaries: chunk.data.summaries, _deletedSummaries: chunk.data._deletedSummaries });
        renderDetailPanel();
    });

    $('#VectFox_add_summary').on('click', function() {
        const summary = prompt('Enter summary text:');
        if (summary && summary.trim()) {
            const summaryText = summary.trim();

            // Track for vectorization on save
            if (!chunk.data._newSummaries) chunk.data._newSummaries = [];
            chunk.data._newSummaries.push(summaryText);

            // Add to local data
            chunk.data.summaries.push(summaryText);
            updateChunkData(chunk.hash, { summaries: chunk.data.summaries, _newSummaries: chunk.data._newSummaries });
            renderDetailPanel();
        }
    });
}

/**
 * Parse plaintext keywords format: "keyword:2x, another:1.5x, plain"
 */
function parsePlaintextKeywords(text) {
    if (!text || !text.trim()) return [];

    return text.split(',').map(item => {
        const trimmed = item.trim();
        if (!trimmed) return null;

        // Check for weight suffix like :2x or :1.5x
        const match = trimmed.match(/^(.+?):(\d+\.?\d*)x?$/i);
        if (match) {
            return { text: match[1].trim(), weight: parseFloat(match[2]) };
        }
        // No weight specified, default to 1.5x
        return { text: trimmed, weight: 1.5 };
    }).filter(Boolean);
}

// ============================================================================
// TEXT EDITOR
// ============================================================================

function openTextEditor(chunk) {
    const overlay = $(`
        <div class="vectfox-text-editor-overlay" id="VectFox_text_editor_overlay">
            <div class="vectfox-text-editor-modal">
                <div class="vectfox-text-editor-header">
                    <h4>Edit Chunk Text</h4>
                </div>
                <div class="vectfox-text-editor-body">
                    <textarea class="vectfox-text-editor-textarea" id="VectFox_text_editor_textarea">${StringUtils.escapeHtml(chunk.data.text)}</textarea>
                </div>
                <div class="vectfox-text-editor-footer">
                    <button class="vectfox-text-editor-btn vectfox-text-editor-cancel" id="VectFox_text_cancel">Cancel</button>
                    <button class="vectfox-text-editor-btn vectfox-text-editor-save" id="VectFox_text_save">Save & Re-embed</button>
                </div>
            </div>
        </div>
    `);

    $('.vectfox-visualizer-container').append(overlay);

    $('#VectFox_text_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#VectFox_text_save').on('click', async function() {
        const newText = $('#VectFox_text_editor_textarea').val().trim();
        if (!newText) return;

        $(this).prop('disabled', true).text('Saving...');

        try {
            // Delete old
            await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);

            // Insert new with new hash (keep as number for Qdrant compatibility)
            const newHash = getStringHash(newText);
            // Carry existing metadata onto the NEW backend point. Re-embedding creates a
            // fresh point with a new hash; the backend is the source of truth, so the
            // payload must be carried over — merge the backend payload over any legacy
            // ext_settings entry. Without this, text-editing wipes name/context/keywords
            // etc. See plans/chunk-metadata-read-source-fix.md (R8).
            const oldStored = getChunkMetadata(String(chunk.hash)) || {};
            const carriedMeta = { ...oldStored, ...(chunk.metadata || {}) };
            delete carriedMeta.hash;
            delete carriedMeta.text;
            await insertVectorItems(currentCollectionId, [{
                hash: newHash,
                text: newText,
                index: chunk.index,
                metadata: carriedMeta,
            }], currentSettings);

            // Backend fields were carried onto the new point above (Phase B: backend is the
            // source of truth). In ext_settings, only migrate client-only state (summaries)
            // to the new hash and drop the old entry.
            deleteChunkMetadata(String(chunk.hash));
            const carriedClientOnly = {};
            for (const k of CLIENT_ONLY_CHUNK_FIELDS) {
                if (k in oldStored) carriedClientOnly[k] = oldStored[k];
            }
            if (Object.keys(carriedClientOnly).length > 0) {
                saveChunkMetadata(String(newHash), carriedClientOnly);
            }

            // Update local state - update hash but keep same uniqueId for selection
            chunk.hash = newHash;
            chunk.text = newText;
            chunk.data.text = newText;
            // selectedChunkId stays the same since uniqueId doesn't change

            overlay.remove();
            renderChunkList();
            renderDetailPanel();
            toastr.success('Chunk updated successfully', 'VectFox');
        } catch (error) {
            console.error('Failed to update chunk:', error);
            toastr.error('Failed to update chunk', 'VectFox');
            $(this).prop('disabled', false).text('Save & Re-embed');
        }
    });
}

// ============================================================================
// CONDITION EDITOR
// ============================================================================

const CONDITION_TYPES = [
    { value: 'pattern', label: 'Pattern Match', icon: '🔍' },
    { value: 'speaker', label: 'Speaker', icon: '💬' },
    { value: 'messageCount', label: 'Message Count', icon: '📊' },
    { value: 'isGroupChat', label: 'Group Chat', icon: '👥' },
    { value: 'timeOfDay', label: 'Time of Day', icon: '🕐' },
    { value: 'randomChance', label: 'Random Chance', icon: '🎲' },
];

function openConditionEditor(chunk) {
    const overlay = $(`
        <div class="vectfox-editor-overlay" id="VectFox_condition_editor">
            <div class="vectfox-editor-modal">
                <div class="vectfox-editor-header">
                    <h4><i class="fa-solid fa-bolt"></i> Add Condition Rule</h4>
                    <button class="vectfox-editor-close" id="VectFox_condition_close">×</button>
                </div>
                <div class="vectfox-editor-body">
                    <div class="vectfox-editor-field">
                        <label>Condition Type</label>
                        <select id="VectFox_condition_type" class="vectfox-editor-select">
                            ${CONDITION_TYPES.map(t => `<option value="${t.value}">${t.icon} ${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="vectfox-editor-field" id="VectFox_condition_settings">
                        <label>Pattern</label>
                        <input type="text" id="VectFox_condition_value" class="vectfox-editor-input" placeholder="Enter pattern or value...">
                    </div>
                    <div class="vectfox-editor-field">
                        <label class="vectfox-editor-checkbox">
                            <input type="checkbox" id="VectFox_condition_negate">
                            <span>Negate (NOT)</span>
                        </label>
                    </div>
                </div>
                <div class="vectfox-editor-footer">
                    <button class="vectfox-editor-btn cancel" id="VectFox_condition_cancel">Cancel</button>
                    <button class="vectfox-editor-btn primary" id="VectFox_condition_add">Add Condition</button>
                </div>
            </div>
        </div>
    `);

    $('.vectfox-visualizer-container').append(overlay);

    $('#VectFox_condition_close, #VectFox_condition_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#VectFox_condition_add').on('click', function() {
        const type = $('#VectFox_condition_type').val();
        const value = $('#VectFox_condition_value').val().trim();
        const negated = $('#VectFox_condition_negate').is(':checked');

        if (!value && type !== 'isGroupChat' && type !== 'randomChance') {
            toastr.warning('Please enter a value', 'VectFox');
            return;
        }

        const rule = {
            type,
            negated,
            settings: { value }
        };

        if (!chunk.data.conditions.rules) {
            chunk.data.conditions.rules = [];
        }
        chunk.data.conditions.rules.push(rule);
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });

        overlay.remove();
        renderDetailPanel();
        renderChunkList();
        toastr.success('Condition added', 'VectFox');
    });
}

// ============================================================================
// LINK EDITOR
// ============================================================================

function openLinkEditor(chunk) {
    // Get available chunks to link to (excluding self)
    const availableChunks = allChunks.filter(c => c.hash !== chunk.hash);

    const overlay = $(`
        <div class="vectfox-editor-overlay" id="VectFox_link_editor">
            <div class="vectfox-editor-modal">
                <div class="vectfox-editor-header">
                    <h4><i class="fa-solid fa-link"></i> Add Chunk Link</h4>
                    <button class="vectfox-editor-close" id="VectFox_link_close">×</button>
                </div>
                <div class="vectfox-editor-body">
                    <div class="vectfox-editor-field">
                        <label>Link Mode</label>
                        <div class="vectfox-link-mode-selector">
                            <label class="vectfox-link-mode-option">
                                <input type="radio" name="link_mode" value="force" checked>
                                <span class="vectfox-link-mode-card force">
                                    <span class="icon">🔗</span>
                                    <span class="title">Force Link</span>
                                    <span class="desc">Target MUST appear when this chunk appears</span>
                                </span>
                            </label>
                            <label class="vectfox-link-mode-option">
                                <input type="radio" name="link_mode" value="soft">
                                <span class="vectfox-link-mode-card soft">
                                    <span class="icon">〰️</span>
                                    <span class="title">Soft Link</span>
                                    <span class="desc">Target gets score boost when this chunk appears</span>
                                </span>
                            </label>
                        </div>
                    </div>
                    <div class="vectfox-editor-field">
                        <label>Target Chunk</label>
                        <select id="VectFox_link_target" class="vectfox-editor-select">
                            ${availableChunks.map(c => {
                                const preview = c.data.text.substring(0, 40).replace(/\s+/g, ' ') + '...';
                                const name = c.data.name || preview;
                                return `<option value="${c.hash}">[Msg #${c.index}] ${StringUtils.escapeHtml(name)}</option>`;
                            }).join('')}
                        </select>
                    </div>
                </div>
                <div class="vectfox-editor-footer">
                    <button class="vectfox-editor-btn cancel" id="VectFox_link_cancel">Cancel</button>
                    <button class="vectfox-editor-btn primary" id="VectFox_link_add">Add Link</button>
                </div>
            </div>
        </div>
    `);

    $('.vectfox-visualizer-container').append(overlay);

    $('#VectFox_link_close, #VectFox_link_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#VectFox_link_add').on('click', function() {
        const mode = $('input[name="link_mode"]:checked').val();
        const targetHash = $('#VectFox_link_target').val();

        if (!targetHash) {
            toastr.warning('Please select a target chunk', 'VectFox');
            return;
        }

        // Check for duplicate
        if (chunk.data.chunkLinks.some(l => l.targetHash === targetHash)) {
            toastr.warning('Link to this chunk already exists', 'VectFox');
            return;
        }

        chunk.data.chunkLinks.push({ targetHash, mode });
        updateChunkData(chunk.hash, { chunkLinks: chunk.data.chunkLinks });

        overlay.remove();
        renderDetailPanel();
        toastr.success('Link added', 'VectFox');
    });
}

// ============================================================================
// DELETE CHUNK
// ============================================================================

async function deleteChunk(chunk) {
    if (!confirm(`Delete chunk #${chunk.index}?`)) return;

    try {
        await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);
        deleteChunkMetadata(chunk.hash);

        // Remove from local state by uniqueId
        const idx = allChunks.findIndex(c => c.uniqueId === chunk.uniqueId);
        if (idx !== -1) allChunks.splice(idx, 1);

        selectedChunkId = null;
        applyFilters();
        renderChunkList();
        renderDetailPanel();
        toastr.success('Chunk deleted', 'VectFox');
    } catch (error) {
        console.error('Failed to delete chunk:', error);
        toastr.error('Failed to delete chunk', 'VectFox');
    }
}

// ============================================================================
// BULK OPERATIONS
// ============================================================================

async function bulkDelete() {
    const targets = selectedChunksSet.size > 0
        ? filteredChunks.filter(c => selectedChunksSet.has(c.uniqueId))
        : [];
    if (targets.length === 0) {
        toastr.warning('No chunks selected', 'VectFox');
        return;
    }
    if (!confirm(`Delete ${targets.length} selected chunk${targets.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;

    try {
        const hashes = targets.map(c => c.hash);
        await deleteVectorItems(currentCollectionId, hashes, currentSettings);
        for (const chunk of targets) {
            deleteChunkMetadata(chunk.hash);
            const idx = allChunks.findIndex(c => c.uniqueId === chunk.uniqueId);
            if (idx !== -1) allChunks.splice(idx, 1);
        }
        selectedChunksSet.clear();
        if (targets.some(c => c.uniqueId === selectedChunkId)) selectedChunkId = null;
        $('#VectFox_bulk_delete').text('Delete Selected');
        applyFilters();
        renderChunkList();
        renderDetailPanel();
        toastr.success(`Deleted ${targets.length} chunk${targets.length !== 1 ? 's' : ''}`, 'VectFox');
    } catch (error) {
        console.error('Failed to bulk delete chunks:', error);
        toastr.error('Failed to delete chunks', 'VectFox');
    }
}

function bulkSetEnabled(enabled) {
    // Operate on checked items when any are selected; otherwise on all filtered chunks.
    const targets = selectedChunksSet.size > 0
        ? filteredChunks.filter(c => selectedChunksSet.has(c.uniqueId))
        : filteredChunks;
    for (const chunk of targets) {
        chunk.data.enabled = enabled;
        updateChunkData(chunk.hash, { enabled });
    }
    renderChunkList();
    if (selectedChunkId) renderDetailPanel();
    // Reset button labels after action
    $('#VectFox_bulk_enable').text('Enable All');
    $('#VectFox_bulk_disable').text('Disable All');
    $('#VectFox_bulk_delete').text('Delete Selected');
    selectedChunksSet.clear();
    toastr.success(`${enabled ? 'Enabled' : 'Disabled'} ${targets.length} chunk${targets.length !== 1 ? 's' : ''}`, 'VectFox');
}


function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the chunk visualizer module
 * Called from index.js on extension load
 */
export function initializeVisualizer() {
    console.log('VectFox: Chunk visualizer initialized');
    // No DOM setup needed - modal is created dynamically when opened
}

// ============================================================================
// EXPORTS
// ============================================================================

export { openVisualizer as default };
