/**
 * ============================================================================
 * VectFox WORLD INFO INTEGRATION
 * ============================================================================
 * Enhanced integration between vectorized lorebooks and ST's world info system
 * Provides semantic activation of WI entries based on vector similarity
 *
 * @author VectFox Team
 * @version 1.0.0
 * ============================================================================
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { queryCollection } from './core-vector-api.js';
import { resolveBackendForCollection, sanitizeNameSegment } from './collection-ids.js';
import { getCollectionListing, getCollectionRegistry } from './collection-loader.js';
import { getCollectionMeta, isCollectionEnabled, shouldCollectionActivate } from './collection-metadata.js';
import { LOREBOOK_PROMPT_TAG, RETRIEVAL_TIMEOUT_MS } from './constants.js';
import AsyncUtils from '../utils/async-utils.js';
import { detectLorebookRenames, showLorebookRenameModal, openDatabaseBrowserForRename } from './lorebook-rename-detector.js';
// Lorebook collection ID lookup uses registry scan (see _findLorebookRegistryEntry below);
// the builder is intentionally not imported here because lookups can't reconstruct the
// exact ID (backend + handle + timestamp segments are not known at lookup time).
import { eventSource, event_types, setExtensionPrompt, substituteParams, getCurrentChatId } from '../../../../../script.js';
import { log } from './log.js';
import { isVectFoxEnabled } from './feature-gate.js';

// ============================================================================
// WORLD INFO ACTIVATION HOOKS
// ============================================================================

/**
 * Resolve a display title for a semantic-activated lorebook entry.
 * Prefers stored entryName; falls back to entry.key. `key` may carry either
 * lorebook trigger strings (legacy ST shape) or VectFox keyword objects
 * (`{text, weight}` from the extractor) — handle both rather than letting
 * `[object Object], [object Object]` leak into the injected prompt.
 */
function _resolveEntryTitle(entry) {
    if (entry.metadata?.entryName) return entry.metadata.entryName;
    if (!Array.isArray(entry.key)) return String(entry.key || '');
    return entry.key
        .slice(0, 3)
        .map(k => (typeof k === 'object' ? (k?.text || k?.keyword || '') : k))
        .filter(Boolean)
        .join(', ');
}

/**
 * Get vectorized lorebook entries that should be activated based on semantic similarity
 * This function is called by ST's world info system to get additional entries to activate
 *
 * @param {string[]} recentMessages - Recent chat messages to use as query
 * @param {object[]} activeEntries - Currently active WI entries (from keyword matching)
 * @param {object} settings - VectFox settings
 * @returns {Promise<object[]>} Array of WI entries to activate { uid, key, content, score }
 */
export async function getSemanticWorldInfoEntries(recentMessages, activeEntries, settings, keywordQuery = null, preloadedCollections = null) {
    if (!settings.enabled_world_info) {
        return [];
    }

    // Build search query from recent messages (broad narrative context)
    const query = recentMessages.slice(-settings.world_info_query_depth || -3).join('\n');
    if (!query.trim()) {
        return [];
    }

    // Dual-query mode: user's last message (precision) + full context (breadth).
    // Same approach as EventBase retrieveEvents — the short message pins intent
    // while the full context activates entries referenced in prior AI turns.
    // Falls back to single query when keywordQuery is absent or identical to query.
    const kq = keywordQuery?.trim();
    const dualQuery = kq && kq !== query;
    const queryTexts = dualQuery ? [kq, query] : [query];

    log.verbose(`VectFox: Querying vectorized lorebooks for semantic WI activation${dualQuery ? ' (dual query)' : ''}...`);

    const semanticEntries = [];
    // Lower threshold for hybrid retrieval since RRF/weighted fusion produces lower absolute scores
    const baseThreshold = settings.world_info_threshold || 0.3;
    const supportsNativeHybrid = settings.vector_backend === 'qdrant';
    const preferNative = settings.hybrid_native_prefer !== false;
    const hybridActive = (supportsNativeHybrid && preferNative) || settings.keyword_scoring_method === 'hybrid';
    const threshold = hybridActive ? baseThreshold * 0.8 : baseThreshold;
    const topK = settings.world_info_top_k || 3;

    // Use pre-fetched collections if provided (avoids double call from handleGenerationStarted)
    const lorebookCollections = preloadedCollections ?? await getEnabledLorebookCollections(settings);

    for (const collection of lorebookCollections) {
        try {
            // Canonical routing (Doc/collection_helper.md): pass the
            // registry-key form ("backend:id") to queryCollection. Its
            // resolveBackendForCollection helper picks the right backend
            // per-collection. Previously we extracted the bare ID here and
            // passed that down, which silently routed all lorebook queries
            // through settings.vector_backend — broken for any user with
            // mixed-backend lorebooks (e.g. a qdrant lorebook locked
            // alongside a vectra lorebook).
            //
            // We also keep the bare collectionId on hand because downstream
            // ST WI consumers expect entry.collectionId in bare form (the
            // ID-only field on the semanticEntry object below).
            const lookupKey = collection.id || collection.registryKey;
            const { collectionId: rawCollectionId } = resolveBackendForCollection(lookupKey);

            // Run all query texts in parallel, merge by uid keeping the highest score.
            // In dual-query mode the user's last message runs alongside the full context —
            // a chunk that ranks outside topK for the context query can still be surfaced
            // if it ranks within topK for the focused user-message query.
            const queryResults = await Promise.all(
                queryTexts.map(qt => queryCollection(lookupKey, qt, topK, settings).catch(() => null))
            );

            const bestByUid = new Map();
            for (const result of queryResults) {
                if (!result?.metadata) continue;
                for (const meta of result.metadata) {
                    const uid = meta.uid || meta.hash;
                    if (!uid) continue;
                    const prev = bestByUid.get(uid);
                    if (!prev || (meta.score || 0) > (prev.score || 0)) {
                        bestByUid.set(uid, meta);
                    }
                }
            }

            for (const meta of bestByUid.values()) {
                const score = meta.score || 0;
                if (score >= threshold) {
                    const entry = {
                        uid: meta.uid || meta.hash,
                        key: meta.keywords || meta.entryName || [],
                        content: meta.text || '',
                        score,
                        lorebookName: collection.name,
                        collectionId: rawCollectionId,
                        registryKey: collection.id, // preserve registry key for metadata lookups
                        vectorActivated: true,
                        metadata: meta
                    };
                    semanticEntries.push(entry);
                    const keyDisplay = Array.isArray(entry.key)
                        ? entry.key.map(k => typeof k === 'object' ? (k.text || k.keyword || JSON.stringify(k)) : k).join(', ')
                        : (entry.key || 'unknown');
                    log.trace(`VectFox: Semantic WI activation: "${keyDisplay}" (score: ${score.toFixed(3)})`);
                }
            }
        } catch (error) {
            log.warn(`VectFox: Failed to query lorebook collection ${collection.id}:`, error);
        }
    }

    // Sort by score descending
    semanticEntries.sort((a, b) => b.score - a.score);

    // Deduplicate by (sourceName, entryUid) — multiple collections from the same lorebook
    // (different vectorization runs) can return the same entry. Keep the highest-scoring hit.
    const seenEntryKeys = new Set();
    const uniqueEntries = semanticEntries.filter(e => {
        const k = `${e.metadata?.sourceName ?? ''}\x00${e.metadata?.entryUid ?? e.uid}`;
        if (seenEntryKeys.has(k)) return false;
        seenEntryKeys.add(k);
        return true;
    });

    // Deduplicate with already active entries (avoid duplicates from keyword matching)
    const deduplicatedEntries = deduplicateWithActiveEntries(uniqueEntries, activeEntries);

    log.verbose(`VectFox: Found ${deduplicatedEntries.length} semantic WI entries to activate`);

    if (settings.world_info_retrieval_popup && deduplicatedEntries.length > 0) {
        try { toastr.info(`Semantic WI: retrieved ${deduplicatedEntries.length} lorebook entry/entries`, 'VectFox'); } catch (_) {}
    }

    return deduplicatedEntries;
}

/**
 * Get all enabled lorebook collections for semantic WI search.
 * No keyword-trigger or lock gate — vector similarity is the activation mechanism.
 * shouldCollectionActivate() returns false for collections with no triggers/conditions/locks,
 * which is the default state for a semantic-WI lorebook. Gating on it silently blocks all results.
 * @param {object} settings - VectFox settings
 * @returns {Promise<Array<{id: string, name: string, sourceName: string|null}>>}
 */
async function getEnabledLorebookCollections(settings) {
    const listing = getCollectionListing(settings);
    const collections = [];

    const currentChatId = getCurrentChatId() ? String(getCurrentChatId()) : null;
    const currentCharacterId = getContext().characterId != null ? String(getContext().characterId) : null;
    const context = { currentChatId, currentCharacterId };

    for (const entry of listing) {
        if (!entry.collectionId.startsWith('vf_lorebook_')) continue;
        if (entry.meta.enabled === false) continue;
        // Respect persona ownership before checking activation. The activation
        // chain (Doc/collection_helper.md) lets trigger keywords activate a
        // collection regardless of who owns it — which leaks another persona's
        // lorebooks into the current persona's chat when keywords coincide.
        // `isOwn` (from getCollectionListing) is true when the current persona
        // owns the collection OR superadmin mode is on, so single-persona and
        // superadmin users see no behavior change; only multi-persona users
        // stop seeing cross-persona content. Surfaced by prod symptom on
        // 2026-05-23 (rabbit's Your Wives lorebook leaking into critblade's
        // ArtificRealm chat) — TEST 011 covers this gate.
        if (!entry.isOwn) continue;
        if (!(await shouldCollectionActivate(entry.registryKey, context))) continue;

        const sourceName = entry.meta?.sourceName || null;
        const name = sourceName || entry.collectionId;
        collections.push({ id: entry.registryKey, name, sourceName });
    }

    log.verbose(`VectFox WI: ${collections.length} lorebook collection(s) available for semantic search`);
    return collections;
}

/**
 * Resolves semantic hits against the LIVE lorebook before injection.
 *
 * The vector store snapshots entry text at vectorization time; injecting that
 * snapshot serves stale content once the lorebook changes (append-only
 * chronicles that grow every few turns). This pass:
 *   1. replaces each hit's content with the entry's current lorebook content,
 *   2. drops hits whose entry no longer exists (deleted),
 *   3. drops hits whose entry is disabled (setting-gated, default on).
 *
 * Entries without sourceName/entryUid metadata (pre-per_entry vectorizations)
 * and books that fail to load fall back to the vector-stored text, so this is
 * strictly additive — it can correct or drop, never error out a generation.
 *
 * One loadWorldInfo per distinct book per call (the per-generation cache):
 * semantic hits cluster in 1–3 books, so latency stays negligible.
 *
 * @param {object[]} semanticEntries - Hits from getSemanticWorldInfoEntries
 * @param {object} settings - VectFox settings
 * @returns {Promise<object[]>}
 */
export async function resolveLiveEntries(semanticEntries, settings) {
    if (!semanticEntries?.length) return semanticEntries || [];
    const respectDisable = settings?.world_info_respect_entry_disable !== false;

    let loadWorldInfo = null;
    try {
        ({ loadWorldInfo } = await import('../../../../world-info.js'));
    } catch (_) { /* host module unavailable (tests/headless) — fall through */ }
    if (typeof loadWorldInfo !== 'function') return semanticEntries;

    /** @type {Map<string, object|null>} sourceName → live entries object (null = load failed) */
    const bookCache = new Map();
    const resolved = [];

    for (const e of semanticEntries) {
        const sourceName = e.metadata?.sourceName;
        const entryUid = e.metadata?.entryUid;
        if (!sourceName || entryUid === null || entryUid === undefined) {
            resolved.push(e); // no identity metadata — keep vector text
            continue;
        }

        if (!bookCache.has(sourceName)) {
            try {
                const book = await loadWorldInfo(sourceName);
                // ST's loadWorldInfo returns a dummy { entries: {} } for a book that
                // isn't on disk (readWorldInfoFile allowDummy=true) — NOT null. An empty
                // entries object therefore means "book absent", indistinguishable from a
                // load failure, so normalize it to null: otherwise every hit falls through
                // to `liveEntries[entryUid] === undefined` and gets dropped as "deleted",
                // silently zeroing semantic WI for any book whose name isn't a live .json
                // (character-embedded, imported/renamed/deleted, or name != filename).
                const entries = book?.entries;
                bookCache.set(sourceName, entries && Object.keys(entries).length ? entries : null);
            } catch (_) {
                bookCache.set(sourceName, null);
            }
        }
        const liveEntries = bookCache.get(sourceName);
        if (!liveEntries) {
            resolved.push(e); // book failed to load / absent — keep vector text (offline-safe)
            continue;
        }

        const live = liveEntries[entryUid];
        if (!live) {
            log.trace(`VectFox WI: dropping semantic hit for deleted entry ${sourceName}::${entryUid}`);
            continue;
        }

        if (respectDisable && live.disable === true) {
            log.trace(`VectFox WI: dropping semantic hit for disabled entry ${sourceName}::${entryUid}`);
            continue;
        }

        const liveContent = typeof live.content === 'string' ? live.content : '';
        resolved.push(liveContent.trim() ? { ...e, content: liveContent } : e);
    }

    return resolved;
}

/**
 * Deduplicate semantic entries with already active entries
 * @param {object[]} semanticEntries - Entries from vector search
 * @param {object[]} activeEntries - Already active entries from keyword matching
 * @returns {object[]} Deduplicated entries
 */
function deduplicateWithActiveEntries(semanticEntries, activeEntries) {
    const activeUids = new Set(activeEntries.map(e => e.uid));
    const activeContents = new Set(activeEntries.map(e => e.content?.trim().toLowerCase()));

    return semanticEntries.filter(entry => {
        // Skip if UID already active
        if (activeUids.has(entry.uid)) {
            return false;
        }

        // Skip if content already active (fuzzy match)
        const content = entry.content?.trim().toLowerCase();
        if (content && activeContents.has(content)) {
            return false;
        }

        return true;
    });
}

// ============================================================================
// LOREBOOK VECTORIZATION HELPERS
// ============================================================================

/**
 * Find the registry key for a lorebook by name. Scans the registry instead of trying to
 * rebuild the exact ID — collection IDs include backend + handle + timestamp segments,
 * none of which can be known ahead of time during a lookup. We match on the lorebook
 * prefix + sanitized name segment.
 *
 * @param {string} lorebookName
 * @param {object} settings
 * @returns {string|null} Full registry key (may include "backend:" prefix), or null if not found.
 */
function _findLorebookRegistryEntry(lorebookName, settings) {
    const sanitizedName = sanitizeNameSegment(lorebookName, 50);
    if (!sanitizedName) return null;
    const lorebookPrefix = 'vf_lorebook_';
    const nameNeedle = `_${sanitizedName}_`;

    // Honor caller-supplied registry (used by tests / synthetic snapshots);
    // otherwise read the module-global via getCollectionRegistry() like production.
    const registry = settings?.vectfox_collection_registry || getCollectionRegistry();
    for (const key of registry) {
        // Registry keys can be "backend:collectionId" or bare "collectionId".
        const id = String(key).includes(':') ? String(key).split(':').slice(1).join(':') : String(key);
        const idLower = id.toLowerCase();
        if (idLower.startsWith(lorebookPrefix) && idLower.includes(nameNeedle)) {
            return key;
        }
    }
    return null;
}

/**
 * Check if a lorebook is already vectorized
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectFox settings
 * @returns {boolean}
 */
export function isLorebookVectorized(lorebookName, settings) {
    return _findLorebookRegistryEntry(lorebookName, settings) !== null;
}

/**
 * Get vectorization status for all lorebooks
 * @param {string[]} lorebookNames - Array of lorebook names
 * @param {object} settings - VectFox settings
 * @returns {Map<string, boolean>} Map of lorebook name -> is vectorized
 */
export function getLorebooksVectorizationStatus(lorebookNames, settings) {
    const statusMap = new Map();

    for (const name of lorebookNames) {
        statusMap.set(name, isLorebookVectorized(name, settings));
    }

    return statusMap;
}

/**
 * Get statistics for vectorized lorebook
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectFox settings
 * @returns {Promise<object|null>} Stats object or null if not vectorized
 */
export async function getLorebookVectorStats(lorebookName, settings) {
    const registryKey = _findLorebookRegistryEntry(lorebookName, settings);
    if (!registryKey) return null;

    // Try metadata on the registry key first (preferred), fall back to bare id.
    const collectionId = String(registryKey).includes(':')
        ? String(registryKey).split(':').slice(1).join(':')
        : String(registryKey);
    const meta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
    if (!meta) return null;

    return {
        collectionId,
        sourceName: meta.sourceName,
        chunkCount: meta.chunkCount || 0,
        createdAt: meta.createdAt,
        enabled: isCollectionEnabled(collectionId, settings),
        strategy: meta.settings?.strategy || 'per_entry',
        scope: meta.scope || 'character',
    };
}

// ============================================================================
// WORLD INFO UI INTEGRATION
// ============================================================================

/**
 * Add vector status indicators to world info entries in the UI
 * This function can be called to enhance the WI editor UI
 *
 * @param {string} lorebookName - Name of the current lorebook
 * @param {object[]} entries - World info entries
 * @param {object} settings - VectFox settings
 * @returns {object[]} Enhanced entries with vector status
 */
export function enhanceWorldInfoEntriesUI(lorebookName, entries, settings) {
    const isVectorized = isLorebookVectorized(lorebookName, settings);

    if (!isVectorized) {
        return entries;
    }

    // Add vector status to each entry
    return entries.map(entry => ({
        ...entry,
        vectorized: true,
        vectorStatus: {
            isVectorized: true,
            canUseSemanticActivation: true,
            lorebookVectorized: isVectorized
        }
    }));
}

// ============================================================================
// EXPORT FOR ST INTEGRATION
// ============================================================================

/**
 * GENERATION_STARTED handler — runs the semantic lorebook query before ST's WI scan
 * and force-activates matching entries via WORLDINFO_FORCE_ACTIVATE. This lets ST
 * process them through its normal pipeline (budget, position, recursion, formatters)
 * with no dependency on handler registration order.
 *
 * Entries are identified by { world: sourceName, uid: entryUid } stored at vectorization
 * time. ST looks up the actual current lorebook entry content, so this path always
 * reflects the live lorebook rather than potentially stale vector-stored text.
 *
 * Known edge case: if a lorebook is renamed after vectorization, sourceName will not
 * match and the entry silently misses activation. Re-vectorizing fixes it.
 */
async function handleGenerationStarted(type, options, dryRun) {
    if (dryRun) return;
    const settings = extension_settings.vectfox;
    if (!settings?.enabled_world_info) return;

    // Always clear the previous lorebook injection first
    setExtensionPrompt(LOREBOOK_PROMPT_TAG, '', settings.position, settings.depth, false);

    // Master switch: skip lorebook WI injection when VectFox is disabled (the
    // stale injection was just cleared above).
    if (!isVectFoxEnabled(settings)) return;

    try {
        const context = getContext();
        const chat = context.chat || [];

        const recentMessages = [...chat]
            .filter(m => !m.is_system)
            .reverse()
            .slice(0, settings.world_info_query_depth || settings.query || 3)
            .map(m => substituteParams((m.mes || '').toString()));

        if (!recentMessages.length) return;

        // Dual query: focused user-message query for precision, full context for breadth
        const lastUserMessage = [...chat].reverse().find(m => !m.is_system && m.is_user);
        const keywordQuery = lastUserMessage?.mes?.trim() || null;

        // Fetch collections once — used for rename detection and passed to the query.
        const lorebookCollections = await getEnabledLorebookCollections(settings);

        // Rename detection: if a lorebook was renamed after vectorization, its
        // sourceName won't match any entry in world_names. Show a blocking popup.
        const mismatches = await detectLorebookRenames(lorebookCollections);
        if (mismatches.length) {
            log.warn(`VectFox: Lorebook rename detected — ${mismatches.map(m => m.sourceName).join(', ')}`);
            const choice = await showLorebookRenameModal(mismatches);
            if (choice === 'open_browser') {
                try {
                    const { stopGeneration } = await import('../../../../../script.js');
                    stopGeneration();
                } catch (e) {
                    log.warn('[LorebookRename] stopGeneration() failed:', e?.message);
                }
                openDatabaseBrowserForRename(); // async fade-wait + open; don't await here
                return;
            }
            // 'continue' — user acknowledged stale content, proceed
        }

        // Bound the vector query the same way as the sibling ChunkBase/EventBase
        // pipelines (core/chat-vectorization.js) — a hung embedding provider must
        // not freeze generation. Soft timeout: on expiry we proceed with no
        // semantic WI injection this turn; the orphaned fetch is reaped
        // server-side. See core/constants.js::RETRIEVAL_TIMEOUT_MS.
        let semanticEntries;
        try {
            semanticEntries = await AsyncUtils.timeout(
                getSemanticWorldInfoEntries(recentMessages, [], settings, keywordQuery, lorebookCollections),
                RETRIEVAL_TIMEOUT_MS,
                'Lorebook WI retrieval timed out',
            );
        } catch (error) {
            log.error('VectFox: Lorebook WI retrieval error (non-fatal, message sends without lorebook memory):', error.message || error);
            return;
        }
        if (!semanticEntries.length) return;

        // Swap vector-snapshot text for live lorebook content; drop deleted/disabled entries.
        const liveEntries = await resolveLiveEntries(semanticEntries, settings);
        if (!liveEntries.length) return;

        // Format entries into direct prompt injection under <VectFoxLorebook>
        const entryTexts = liveEntries
            .filter(e => e.content?.trim())
            .map(e => {
                const title = _resolveEntryTitle(e);
                const content = e.content.trim();
                return title ? `# ${title}\n${content}` : content;
            });

        if (!entryTexts.length) return;

        const xmlTag = settings.lorebook_xml_tag || 'VectFoxLorebook';
        const injectionContent = entryTexts.join('\n\n');
        const injectionText = `<${xmlTag}>\n${injectionContent}\n</${xmlTag}>`;

        setExtensionPrompt(LOREBOOK_PROMPT_TAG, injectionText, settings.position, settings.depth, false);
        log.verbose(`VectFox: Injected ${entryTexts.length} lorebook entries to <${xmlTag}>`);
    } catch (err) {
        log.warn('VectFox: Lorebook WI injection failed', err.message || err);
    }
}

/**
 * Dry-run the Lorebook WI pipeline for the query tester.
 * Reuses getEnabledLorebookCollections + getSemanticWorldInfoEntries — same path as
 * handleGenerationStarted, but skips rename detection and setExtensionPrompt.
 *
 * @param {{ chat: object[], testMessage: string|null, settings: object }} opts
 * @returns {Promise<{ injectionText: string|null, entryCount: number, disabled?: boolean, noCollections?: boolean }>}
 */
export async function runLorebookWIDryRun({ chat, testMessage, settings }) {
    if (!settings?.enabled_world_info) return { injectionText: null, entryCount: 0, disabled: true };

    const recentMessages = [...chat]
        .filter(m => !m.is_system)
        .reverse()
        .slice(0, settings.world_info_query_depth || settings.query || 3)
        .map(m => substituteParams((m.mes || '').toString()));

    if (!recentMessages.length) return { injectionText: null, entryCount: 0 };

    const lorebookCollections = await getEnabledLorebookCollections(settings);
    if (!lorebookCollections.length) return { injectionText: null, entryCount: 0, noCollections: true };

    let semanticEntries;
    try {
        semanticEntries = await AsyncUtils.timeout(
            getSemanticWorldInfoEntries(recentMessages, [], settings, testMessage || null, lorebookCollections),
            RETRIEVAL_TIMEOUT_MS,
            'Lorebook WI retrieval timed out',
        );
    } catch (error) {
        log.error('VectFox: Lorebook WI dry-run retrieval error:', error.message || error);
        return { injectionText: null, entryCount: 0 };
    }
    if (!semanticEntries.length) return { injectionText: null, entryCount: 0 };

    // Same live-resolution as the real injection path, so the tester shows real behavior.
    const liveEntries = await resolveLiveEntries(semanticEntries, settings);
    if (!liveEntries.length) return { injectionText: null, entryCount: 0 };

    const entryTexts = liveEntries.filter(e => e.content?.trim()).map(e => {
        const title = _resolveEntryTitle(e);
        const content = e.content.trim();
        return title ? `# ${title}\n${content}` : content;
    });
    if (!entryTexts.length) return { injectionText: null, entryCount: 0 };

    const xmlTag = settings.lorebook_xml_tag || 'VectFoxLorebook';
    return {
        injectionText: `<${xmlTag}>\n${entryTexts.join('\n\n')}\n</${xmlTag}>`,
        entryCount: entryTexts.length,
    };
}

/**
 * Initialize world info integration hooks
 * This should be called when VectFox loads
 */
export function initializeWorldInfoIntegration() {
    // Make functions available globally for ST to call
    window.VectFox_WorldInfo = {
        getSemanticEntries: getSemanticWorldInfoEntries,
        isLorebookVectorized: isLorebookVectorized,
        getVectorizationStatus: getLorebooksVectorizationStatus,
        getVectorStats: getLorebookVectorStats,
        enhanceEntriesUI: enhanceWorldInfoEntriesUI
    };

    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    log.lifecycle('VectFox: World Info integration hooks initialized');
}
