/**
 * ============================================================================
 * VECTFOX COLLECTION LOADER
 * ============================================================================
 * Data access layer for managing vector collections and chunks
 *
 * @author Kritblade
 * ============================================================================
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { getContext, characters, getCurrentChatId } from '../../sillytavern/chat.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { getSavedHashes, purgeVectorIndex } from '../vector-backend/index.js';
import {
    isCollectionEnabled,
    deleteCollectionMeta,
    ensureCollectionMeta,
    getCollectionMeta,
    setCollectionMeta,
    isCollectionActiveForContext,
} from './collection-metadata.js';
import { log } from '../../sillytavern/log.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    parseCollectionId,
    parseRegistryKey,
    COLLECTION_PREFIXES,
    buildRegistryKey,
    sanitizeHandleId,
    sanitizeNameSegment,
} from '../../shared/collection-ids.js';
import { checkPluginAvailable, isPluginDetected, resetPluginAvailableCache } from '../../shared/similharity-plugin.js';
import { readErrorBody } from '../../shared/server-error-text.js';

/**
 * Detect collection IDs that VECTFOX should NOT register or query.
 * Two categories:
 *   1. Prefix-stacked corruption — IDs that start with a known backend name without
 *      a colon separator (e.g. "vectraopenrouterfile_xxx"). These come from a prior
 *      bug where the registry key was used as the on-disk collection name. The
 *      filesystem stripped colons, leaving folders that get re-discovered each load.
 *   2. ST-native file attachments — IDs starting with "file_<digits>". Created by
 *      SillyTavern's built-in Vector Storage extension when files are attached to
 *      chat. VECTFOX can't usefully retrieve from them (different embedding model
 *      and lifecycle) and they pollute the query path.
 *
 * @param {string} collectionId - Plain collection ID (no backend:source: prefix)
 * @returns {string|null} Reason string when filtered, null when ID is OK
 */
export function getCollectionFilterReason(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') return null;

    // (1) Internal VECTFOX system collections (health checks, test indexes).
    if (collectionId.startsWith('__vectfox_')) {
        return 'internal-system';
    }

    // (2) Stacked-prefix corruption. Real collection IDs never start with a backend
    // name; backend is only used in the registry key with colon separators.
    if (/^(vectra|qdrant|standard)(?![:_])/i.test(collectionId)) {
        return 'corrupted-prefix-stacked';
    }

    // (3) ST-native file attachments — `file_` followed by digits.
    if (/^file_\d+$/.test(collectionId)) {
        return 'st-native-file';
    }

    return null;
}

/**
 * Gets or initializes the collection registry
 * @returns {string[]} Array of collection IDs
 */
export function getCollectionRegistry() {
    if (!extension_settings.vectfox.vectfox_collection_registry) {
        extension_settings.vectfox.vectfox_collection_registry = [];
    }
    return extension_settings.vectfox.vectfox_collection_registry;
}

/**
 * Registers a collection in the registry (idempotent)
 * @param {string} collectionId Collection identifier
 */
// sanitizeHandleId is canonicalized in collection-ids.js (single source of truth for
// the persona-handle form shared by the ID builders, the creatorHandle stamp below,
// and remapCollectionIdToHandle). Re-exported here so existing importers
// (src/features/database-browser/database-browser.js) keep resolving it from collection-loader.
export { sanitizeHandleId };

function _sanitizeHandleId(name) { return sanitizeHandleId(name); }

export function registerCollection(collectionId) {
    if (!collectionId) {
        log.warn('VectFox: Attempted to register null/undefined collectionId, skipping');
        return;
    }
    const registry = getCollectionRegistry();
    const isNew = !registry.includes(collectionId);
    if (isNew) {
        registry.push(collectionId);
        log.verbose(`VectFox: Registered collection: ${collectionId}`);
    }

    // Stamp the creator's persona handle on the collection metadata so the DB Browser can
    // filter by current persona without parsing the collection name (which is ambiguous when
    // handle / charName contain underscores).
    //
    // Two safety conditions:
    //   (a) Don't overwrite an existing creatorHandle — first stamper wins, so a later
    //       discovery on a different persona's machine can't claim someone else's collection.
    //   (b) Only stamp when the collection name actually contains the current persona's
    //       handle. Auto-discovery registers ALL collections on the server, including ones
    //       belonging to other personas; those names won't contain our handle, so we skip
    //       them. This means foreign collections stay unstamped → DB browser falls back to
    //       name-parse filter for them (which correctly hides them from the current persona).
    try {
        const meta = getCollectionMeta(collectionId);
        if (!meta?.creatorHandle) {
            const ctx = getContext();
            const handle = _sanitizeHandleId(ctx?.name1);
            const idLower = String(collectionId).toLowerCase();
            if (idLower.includes(`_${handle}_`)) {
                setCollectionMeta(collectionId, { creatorHandle: handle });
                log.trace(`VectFox: Stamped creatorHandle="${handle}" on ${collectionId}`);
            }
        }
    } catch (e) {
        log.warn('VectFox: failed to stamp creatorHandle:', e?.message);
    }

    if (isNew) {
        saveSettingsDebounced(); // Persist to disk!
    }
}

/**
 * Return every registry entry plus its metadata, annotated with `isOwn` (does
 * the current persona own this collection?) and `isActive` (is it locked to
 * the current chat / character context?).
 *
 * Single source of truth for persona/superadmin filtering AND lock-state
 * derivation when iterating the registry. Callers narrow the result by
 * collection-id prefix and/or these flags as their UX requires — they should
 * NOT re-derive ownership themselves and should NOT call
 * isCollectionActiveForContext when iterating the listing.
 *
 * Calls registerCollection(key) for every entry (idempotent) to guarantee the
 * `creatorHandle` stamp exists before the ownership check, even when callers
 * bypass loadAllCollections().
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Array<{
 *   registryKey: string,
 *   collectionId: string,
 *   backend: string,
 *   meta: object,
 *   isOwn: boolean,
 *   isActive: boolean
 * }>}
 */
export function getCollectionListing(settings) {
    const registry = getCollectionRegistry();
    if (!Array.isArray(registry)) return [];

    const isSuperadmin = settings?.superadmin === true;
    const ownHandle = isSuperadmin
        ? null
        : sanitizeHandleId(getContext()?.name1 || '').toLowerCase();

    // Snapshot active context once per listing call.
    const chatId = getCurrentChatId();
    const characterId = getContext()?.characterId;

    return registry.map(registryKey => {
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId || '';
        const backend = parsed.backend || '';

        // Idempotent: stamps creatorHandle on legacy entries.
        try { registerCollection(registryKey); } catch (error) { log.warn(`VectFox: registerCollection failed for ${registryKey}:`, error); }

        const meta = getCollectionMeta(registryKey);

        let isOwn;
        if (isSuperadmin) {
            isOwn = true;
        } else if (meta.creatorHandle) {
            isOwn = String(meta.creatorHandle).toLowerCase() === ownHandle;
        } else {
            // No stamp yet — fall back to ID substring (handles registered
            // before the creatorHandle stamp logic existed).
            isOwn = collectionId.toLowerCase().includes(`_${ownHandle}_`);
        }

        // Lock state lives at the registry-key form — match the writer side.
        const isActive = isCollectionActiveForContext(registryKey, { chatId, characterId });

        return { registryKey, collectionId, backend, meta, isOwn, isActive };
    });
}

/**
 * Unregisters a collection from the registry
 * @param {string} collectionId Collection identifier (can be plain id or source:id format)
 */
export function unregisterCollection(collectionId) {
    const registry = getCollectionRegistry();
    const index = registry.indexOf(collectionId);
    if (index !== -1) {
        registry.splice(index, 1);
        log.verbose(`VectFox: Unregistered collection: ${collectionId}`);
        saveSettingsDebounced(); // Persist to disk!
    } else {
        log.verbose(`VectFox: Collection not found in registry: ${collectionId}`);
    }
}

// What deleteCollection() and importCollection() run last, to clear the per-chat state a feature
// above this one keeps for a collection whose events are gone or replaced. index.js sets it at startup.
let deletedOrImportedCollectionCleanup = null;

/**
 * Sets the cleanup run with the ID of a collection that was deleted or imported.
 * @param {(collectionId: string) => void} cleanup
 */
export function setDeletedOrImportedCollectionCleanup(cleanup) {
    deletedOrImportedCollectionCleanup = cleanup;
}

/**
 * Clears the per-chat state kept for a collection that was deleted or imported (EventBase's
 * extraction caches). A failure is logged and goes no further: a cache clear never fails a delete
 * or an import.
 * @param {string} collectionId - the collection's bare ID
 */
export function clearStateOfDeletedOrImportedCollection(collectionId) {
    try {
        if (!deletedOrImportedCollectionCleanup) throw new Error('no cleanup set: index.js calls setDeletedOrImportedCollectionCleanup() at startup');
        deletedOrImportedCollectionCleanup(collectionId);
    } catch (error) {
        log.warn(`VectFox: Failed to clear per-chat state for ${collectionId}:`, error);
    }
}

/**
 * COMPLETE collection deletion - removes from ALL THREE stores:
 * 1. Vector backend (actual embeddings)
 * 2. Registry (collection tracking)
 * 3. Metadata (display names, settings, chunk info)
 * and then runs clearStateOfDeletedOrImportedCollection().
 *
 * This is the ONE function that should be called to fully delete a collection.
 * All other delete functions are partial and will leave ghosts.
 *
 * @param {string} collectionId - Collection ID to delete
 * @param {object} settings - VECTFOX settings (for backend routing)
 * @param {string} [registryKey] - Optional registry key (source:id format) if different from collectionId
 * @returns {Promise<{success: boolean, errors: string[], vectorsDeleted: boolean, registryDeleted: boolean, metadataDeleted: boolean}>}
 */
export async function deleteCollection(collectionId, settings, registryKey = null) {
    const errors = [];
    let vectorsDeleted = false;
    let registryDeleted = false;
    let metadataDeleted = false;

    log.verbose(`VectFox: Deleting collection ${collectionId} (registry key: ${registryKey || collectionId})`);

    // Step 1: Delete vectors from backend (most important - actual data).
    // purgeVectorIndex logs its own error and returns false instead of throwing.
    // Registry/metadata cleanup continues either way.
    if (await purgeVectorIndex(collectionId, settings)) {
        vectorsDeleted = true;
        log.verbose(`VectFox: ✓ Deleted vectors for ${collectionId}`);
    } else {
        errors.push('Vectors: purge failed (see console)');
        log.warn(`VectFox: ✗ Failed to delete vectors for ${collectionId}`);
    }

    // Step 2: Unregister from registry (try both formats)
    try {
        const keyToUnregister = registryKey || collectionId;
        unregisterCollection(keyToUnregister);

        // Also try the other format if they differ
        if (registryKey && registryKey !== collectionId) {
            unregisterCollection(collectionId);
        }

        registryDeleted = true;
        log.verbose(`VectFox: ✓ Unregistered ${collectionId}`);
    } catch (error) {
        errors.push(`Registry: ${error.message}`);
        log.warn(`VectFox: ✗ Failed to unregister ${collectionId}:`, error.message);
    }

    // Step 3: Delete metadata — stored under the registry-key form, with bare-ID
    // entries possible from older versions (same two forms as Step 2).
    try {
        if (registryKey && registryKey !== collectionId) {
            deleteCollectionMeta(registryKey);
        }
        deleteCollectionMeta(collectionId);
        metadataDeleted = true;
        log.verbose(`VectFox: ✓ Deleted metadata for ${collectionId}`);
    } catch (error) {
        errors.push(`Metadata: ${error.message}`);
        log.warn(`VectFox: ✗ Failed to delete metadata for ${collectionId}:`, error.message);
    }

    // Step 4: Clear the per-chat state kept for this collection.
    clearStateOfDeletedOrImportedCollection(collectionId);

    const success = vectorsDeleted && registryDeleted && metadataDeleted;

    if (success) {
        log.verbose(`VectFox: ✓ Fully deleted collection ${collectionId}`);
    } else {
        // VEC-28: Warn about partial deletion to prevent zombie collections
        const warningMsg = `VectFox: ⚠️ PARTIAL DELETION of ${collectionId} - may create zombie collection. Errors: ${errors.join(', ')}`;
        log.error(warningMsg);
        // Only treat as critical failure if ALL steps failed
        if (!vectorsDeleted && !registryDeleted && !metadataDeleted) {
            throw new Error(`Complete deletion failure for ${collectionId}: ${errors.join(', ')}`);
        }
    }

    return {
        success,
        errors,
        vectorsDeleted,
        registryDeleted,
        metadataDeleted,
    };
}

/**
 * Clears the entire registry (useful for debugging/reset)
 */
export function clearCollectionRegistry() {
    extension_settings.vectfox.vectfox_collection_registry = [];
    log.lifecycle('VectFox: Cleared collection registry');
    saveSettingsDebounced(); // Persist to disk!
}

/**
 * Cleans up registry by removing null entries and duplicates
 */
export function cleanupCollectionRegistry() {
    const registry = getCollectionRegistry();
    const cleaned = [...new Set(registry.filter(id => id != null && id !== ''))];
    extension_settings.vectfox.vectfox_collection_registry = cleaned;
    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        log.lifecycle(`VectFox: Cleaned registry - removed ${removed} invalid/duplicate entries`);
        saveSettingsDebounced(); // Persist to disk!
    }
    return removed;
}

/**
 * Removes the registry entries of test collections that were not cleaned up, the caller naming which bare collection
 * IDs are tests (Diagnostics passes its reserved names).
 *
 * Also sweeps the reverse lock-index `chat_lock_index` for orphan entries
 * of the same collections. The registry filter alone misses
 * orphans because `setCollectionLock` writes to BOTH the forward
 * `meta.lockedToChatIds` AND the reverse `chat_lock_index[chatId] = […]`,
 * but unregister/cleanup paths historically only touch the forward side.
 * Result: ghost test collections accumulate dead reverse-index entries
 * across runs that `getChatLockedCollections(chatId)` then reports back.
 *
 * @param {(collectionId: string) => boolean} isTestCollection - Whether a bare collection ID is a test collection
 * @returns {number} Number of registry entries removed (does NOT include
 *                   reverse-index orphans — those are logged separately).
 */
export function cleanupTestCollections(isTestCollection) {
    const registry = getCollectionRegistry();

    // Entries are "backend:collectionId" keys, or a bare ID in older ones.
    const isTestEntry = (id) => Boolean(id) && isTestCollection(parseRegistryKey(id).collectionId);

    const cleaned = registry.filter(id => {
        if (isTestEntry(id)) {
            log.verbose(`VectFox: Removing test collection from registry: ${id}`);
            return false;
        }
        return id != null;
    });

    const removed = registry.length - cleaned.length;
    let didMutate = false;
    if (removed > 0) {
        extension_settings.vectfox.vectfox_collection_registry = cleaned;
        log.lifecycle(`VectFox: Cleaned ${removed} test collection entries from registry`);
        didMutate = true;
    }

    // Reverse-index orphan sweep — same patterns, applied to chat_lock_index.
    // `setCollectionLock` writes the registryKey-form here (e.g.
    // `vectra:vf_test_…`); isTestEntry reads either form.
    let indexOrphans = 0;
    let indexChatsScanned = 0;
    const idx = extension_settings?.vectfox?.chat_lock_index;
    if (idx && typeof idx === 'object') {
        for (const chatId of Object.keys(idx)) {
            const arr = idx[chatId];
            if (!Array.isArray(arr) || arr.length === 0) continue;
            indexChatsScanned++;
            const kept = arr.filter(rk => !isTestEntry(rk));
            if (kept.length !== arr.length) {
                indexOrphans += (arr.length - kept.length);
                if (kept.length === 0) {
                    delete idx[chatId];
                } else {
                    idx[chatId] = kept;
                }
            }
        }
        if (indexOrphans > 0) {
            log.lifecycle(`VectFox: Pruned ${indexOrphans} stale test entries from chat_lock_index across ${indexChatsScanned} chat(s)`);
            didMutate = true;
        }
    }

    if (didMutate) saveSettingsDebounced(); // Persist to disk!
    return removed;
}

// parseCollectionId is now imported from collection-ids.js

/**
 * Gets display name for a collection
 * @param {string} collectionId Bare collection identifier
 * @param {string} registryKey "backend:id" form — the key collection metadata
 *   (including a user-set displayName from Rename) is stored under
 * @param {object} metadata Parsed collection metadata
 * @returns {string} Human-readable name
 */
function getCollectionDisplayName(collectionId, registryKey, metadata) {
    // Check for custom display name first
    const collectionMeta = getCollectionMeta(registryKey);
    if (collectionMeta.displayName) {
        return collectionMeta.displayName;
    }

    // Generate name based on type
    const context = getContext();

    switch (metadata.type) {
        case 'chat': {
            // Try to get chat name from ST
            const chatId = metadata.rawId;

            // Check if it's the current chat
            if (context.chatId === chatId && context.name2) {
                return `💬 Chat: ${context.name2}`;
            }

            // Try to find in characters list
            const character = characters.find(c => c.chat === chatId);
            if (character) {
                return `💬 Chat: ${character.name}`;
            }

              // Fallback: extract character name from rawId if it follows pattern: charName_uuid
            // Format: assistant_503c1099-b769-41e7-8e15-0d652cd6d1b4
            const underscoreIndex = chatId.lastIndexOf('_');
            if (underscoreIndex > 0) {
                // Extract everything before the last underscore (the character name)
                const charName = chatId.substring(0, underscoreIndex);
                return `💬 Chat: ${charName}`;
            }

            // Final fallback to just the ID
            return `💬 Chat #${chatId.substring(0, 8)}`;
        }

        case 'file':
            return `📄 File: ${metadata.rawId}`;

        case 'lorebook':
            return `📚 Lorebook: ${metadata.rawId}`;

        default:
            return collectionId;
    }
}

// Cache for plugin collection data
let pluginCollectionData = null;

/**
 * Discovers existing collections using server plugin (scans file system)
 * @param {object} settings - VectFox settings, for whether Qdrant keeps every collection in one shared collection
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaPlugin(settings) {
    try {
        log.trace('🔍 VectFox: Requesting collection discovery from plugin...');

        // Plugin now scans ALL sources, not just the current one
        const response = await fetch(`/api/plugins/similharity/collections`, {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            log.warn(`⚠️ VectFox: Plugin collections endpoint failed (status: ${response.status})`);
            log.verbose('   💡 Make sure the Similharity plugin is installed and running');
            return [];
        }

        const data = await response.json();

        if (data.success && Array.isArray(data.collections)) {
            log.lifecycle(`✅ VectFox: Plugin found ${data.collections.length} collections across all sources`);

            // Log the sources found
            const sourcesSummary = {};
            data.collections.forEach(c => {
                sourcesSummary[c.source] = (sourcesSummary[c.source] || 0) + 1;
            });
            log.trace('   Sources:', Object.entries(sourcesSummary).map(([s, count]) => `${s}: ${count}`).join(', '));

            // Cache the plugin data (includes chunk counts, sources, AND backends)
            // Key format: "backend:source:collectionId" to handle same collection in multiple backends
            pluginCollectionData = {};
            const uniqueKeys = [];

            let skippedCorruption = 0;
            let skippedStFile = 0;
            let skippedInternal = 0;
            let emptyCount = 0;
            const emptyList = [];
            for (const collection of data.collections) {
                const backend = collection.backend || 'standard';

                // Strip backend prefix from collection.id if it's already there
                // Some backends (like Qdrant) may return IDs with backend prefix
                let collectionId = collection.id;
                if (collectionId.startsWith(`${backend}:`)) {
                    collectionId = collectionId.substring(backend.length + 1);
                    log.trace(`   🔧 Stripped backend prefix from collection ID: ${collection.id} → ${collectionId}`);
                }

                // Skip corrupted/ST-native/internal IDs at discovery time
                const filterReason = getCollectionFilterReason(collectionId);
                if (filterReason) {
                    if (filterReason === 'corrupted-prefix-stacked') skippedCorruption++;
                    else if (filterReason === 'st-native-file') skippedStFile++;
                    else if (filterReason === 'internal-system') skippedInternal++;
                    log.trace(`   ⛔ Skipping ${collectionId} (${filterReason})`);
                    continue;
                }

                // Track empty collections for the summary log (still added to registry
                // so DB Browser can show them and the user can delete them)
                if (!collection.chunkCount) {
                    emptyCount++;
                    emptyList.push(buildRegistryKey(collectionId, backend));
                }

                log.trace(`   - ${buildRegistryKey(collectionId, backend)} (${collection.chunkCount} chunks)`);

                const collectionData = {
                    chunkCount: collection.chunkCount,
                    source: collection.source,
                    backend: backend,
                    model: collection.model || '',  // Primary model path
                    models: collection.models || []  // All available models
                };

                // Cache by "backend:id" — embedding source is not part of the key.
                // The plugin's /collections endpoint groups by (source, collectionId),
                // so the same vectra collectionId can appear in multiple entries (one
                // per source folder on disk: e.g. openai/, transformers/). When that
                // happens, keep the entry with the highest chunkCount — that's the
                // populated one. Last-write-wins would otherwise let an empty/stub
                // source folder clobber the real data and surface as "0 chunks" in
                // the UI.
                const cacheKey = buildRegistryKey(collectionId, backend);
                const existing = pluginCollectionData[cacheKey];
                const incomingCount = collectionData.chunkCount || 0;
                const existingCount = existing?.chunkCount || 0;
                // `sources` lists EVERY source folder holding this ID, winner or not —
                // deleteCollection must purge all of them, or the leftover folder
                // brings the collection back on the next scan.
                collectionData.sources = [
                    ...(existing?.sources || []),
                    { source: collection.source, models: collectionData.models },
                ];
                if (!existing || incomingCount > existingCount) {
                    if (existing && existingCount !== incomingCount) {
                        log.trace(`   🔀 Collision on ${cacheKey}: keeping ${incomingCount} chunks (source=${collectionData.source}) over ${existingCount} (source=${existing.source})`);
                    }
                    pluginCollectionData[cacheKey] = collectionData;
                    uniqueKeys.push(cacheKey);
                } else {
                    existing.sources = collectionData.sources;
                }

                // Also cache by sanitized version (for backend lookups) — same dedup rule
                const sanitized = collectionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
                if (sanitized !== collectionId) {
                    const sanitizedKey = buildRegistryKey(sanitized, backend);
                    const sanitizedExisting = pluginCollectionData[sanitizedKey];
                    if (!sanitizedExisting || incomingCount > (sanitizedExisting.chunkCount || 0)) {
                        pluginCollectionData[sanitizedKey] = collectionData;
                    }
                }
            }

            // IMPORTANT: Replace registry with what plugin found (removes stale entries)
            // This ensures the registry matches actual disk state
            const currentRegistry = getCollectionRegistry();
            const pluginKeySet = new Set(uniqueKeys);

            if (skippedCorruption > 0 || skippedStFile > 0 || skippedInternal > 0) {
                log.lifecycle(`   🛡️ Discovery filter excluded ${skippedCorruption} corrupted + ${skippedStFile} ST-native + ${skippedInternal} internal collection(s)`);
            }
            if (emptyCount > 0) {
                log.verbose(`   ⚠️ ${emptyCount} empty collection(s) with 0 chunks (kept in registry — delete from DB Browser to clean up):`);
                emptyList.forEach(id => log.trace(`      - ${id}`));
            }

            log.trace(`\n📋 VectFox: Updating registry...`);
            log.trace(`   Current registry has ${currentRegistry.length} entries`);
            log.trace(`   Plugin discovered ${uniqueKeys.length} collections`);

            // The plugin probes every standard (vectra) and qdrant collection that
            // actually exists. Anything in the registry that was NOT found = stale.
            //
            // EXCEPT: absence from the scan only means "deleted" for backends the
            // plugin actually reached. `qdrantScanned` is false when the Qdrant
            // health check failed — the scan then contains zero qdrant collections
            // not because they were deleted but because the server was unreachable.
            // Pruning them here cascaded into cleanupOrphanedMeta() deleting their
            // metadata (chat/character locks, triggers, scope, names) on the next
            // DB-browser refresh — a transient Qdrant hiccup permanently unlocked
            // lorebooks (issue #11 "it stopped working out of the blue").
            // Older plugins don't report the flag at all (undefined); treat that as
            // not-scanned too — a lingering ghost registry entry is recoverable from
            // the DB browser, silently wiped locks are not.
            //
            // With "One shared collection" on, Qdrant's physical names say nothing about VectFox's collections: they
            // all live in vectfox_main. The plugin lists each of its tenants as a collection and says so with
            // qdrantTenantsScanned; without that (a plugin before 3.4.8, or a Qdrant before 1.12), no qdrant entry
            // is pruned (issue #30: discovery pruned every lorebook, with its locks).
            const qdrantVerified = data.qdrantScanned === true
                && (!settings?.qdrant_multitenancy || data.qdrantTenantsScanned === true);
            const updatedRegistry = getCollectionRegistry();
            const staleCandidates = updatedRegistry.filter(key => !pluginKeySet.has(key));
            const staleEntries = qdrantVerified
                ? staleCandidates
                : staleCandidates.filter(key => parseRegistryKey(key).backend !== 'qdrant');
            const preservedUnverified = staleCandidates.length - staleEntries.length;
            if (preservedUnverified > 0) {
                const why = data.qdrantScanned === true
                    ? 'the tenants of the shared Qdrant collection were not listed (Similharity before 3.4.8, or Qdrant before 1.12)'
                    : 'Qdrant was not reachable during discovery';
                log.warn(`VectFox: ${why} — keeping ${preservedUnverified} qdrant registry entr${preservedUnverified === 1 ? 'y' : 'ies'} (and their locks/metadata) instead of pruning. They will re-verify on the next discovery that lists them.`);
            }
            if (staleEntries.length > 0) {
                log.trace(`   🗑️  Removing ${staleEntries.length} stale registry entries:`);
                for (const staleKey of staleEntries) {
                    log.trace(`      - ${staleKey}`);
                    unregisterCollection(staleKey);
                }
            }

            // Register all discovered collections with backend:id format
            let newRegistrations = 0;
            for (const key of uniqueKeys) {
                if (!getCollectionRegistry().includes(key)) {
                    newRegistrations++;
                    log.trace(`   ➕ Registering: ${key}`);
                } else {
                    log.trace(`   ⏭️  Already registered: ${key}`);
                }
                registerCollection(key);
            }
            if (newRegistrations > 0) {
                log.lifecycle(`   ✅ Registered ${newRegistrations} new collections`);
            }

            log.lifecycle(`   Final registry size: ${getCollectionRegistry().length}\n`);

            return uniqueKeys;
        }
    } catch (error) {
        log.error('VectFox: Plugin discovery failed:', error);
    }

    return [];
}

/**
 * Delete SillyTavern's whole vectors folder through Similharity: every local collection, SillyTavern's own Vector
 * Storage included. A Qdrant server keeps its data.
 *
 * @returns {Promise<void>}
 * @throws {Error} when the plugin does not answer with success, so a caller never reads a failed delete as done
 */
export async function deleteVectorsFolder() {
    const response = await fetch('/api/plugins/similharity/purge-all', {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (!response.ok) {
        const body = await readErrorBody(response);
        throw new Error(`Similharity's purge-all returned ${response.status}: ${body.slice(0, 200)}`);
    }
}

/**
 * Cleanup corrupted/ST-native collections from disk.
 *
 * Re-fetches the raw plugin discovery list (bypasses the discovery filter so we
 * can SEE the corrupted entries), then calls the plugin's /chunks/purge endpoint
 * for each one. Also clears any matching registry entries.
 *
 * @returns {Promise<{purged: Array<{key: string, ok: boolean, error?: string}>, total: number, corruption: number, stFile: number}>}
 */
export async function cleanupCorruptedCollections() {
    const result = {
        purged: [],
        total: 0,
        corruption: 0,
        stFile: 0,
    };

    try {
        const response = await fetch('/api/plugins/similharity/collections', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Plugin /collections returned ${response.status}`);
        }

        const data = await response.json();
        if (!data.success || !Array.isArray(data.collections)) {
            throw new Error('Plugin returned no collection list');
        }

        // Pick out everything our discovery filter would skip
        const targets = [];
        for (const collection of data.collections) {
            // A tenant of the shared Qdrant collection is a VectFox collection, never a corrupted or SillyTavern one.
            if (collection.sharedCollection) continue;
            const backend = collection.backend || 'standard';
            let collectionId = collection.id;
            if (collectionId.startsWith(`${backend}:`)) {
                collectionId = collectionId.substring(backend.length + 1);
            }

            const reason = getCollectionFilterReason(collectionId);
            if (reason) {
                targets.push({
                    backend,
                    source: collection.source || 'transformers',
                    collectionId,
                    reason,
                    registryKey: `${backend}:${collection.source}:${collectionId}`,
                });
            }
        }

        result.total = targets.length;
        result.corruption = targets.filter(t => t.reason === 'corrupted-prefix-stacked').length;
        result.stFile = targets.filter(t => t.reason === 'st-native-file').length;

        if (targets.length === 0) {
            log.lifecycle('VECTFOX cleanup: no corrupted or ST-native file collections found on disk');
            return result;
        }

        log.lifecycle(`VECTFOX cleanup: purging ${targets.length} collection(s) (${result.corruption} corrupted, ${result.stFile} ST-native file)`);

        for (const target of targets) {
            try {
                const purgeResp = await fetch('/api/plugins/similharity/chunks/purge', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: target.backend,
                        collectionId: target.collectionId,
                        source: target.source,
                    }),
                });

                if (!purgeResp.ok) {
                    const body = await readErrorBody(purgeResp);
                    throw new Error(`HTTP ${purgeResp.status}: ${body.substring(0, 200)}`);
                }

                // Drop from registry too
                unregisterCollection(target.registryKey);

                result.purged.push({ key: target.registryKey, ok: true });
                log.verbose(`   ✅ Purged ${target.registryKey} (${target.reason})`);
            } catch (err) {
                result.purged.push({ key: target.registryKey, ok: false, error: err.message });
                log.warn(`   ❌ Failed to purge ${target.registryKey}: ${err.message}`);
            }
        }

        // Probe the plugin again on the next discovery.
        resetPluginAvailableCache();
    } catch (error) {
        log.error('VECTFOX cleanup: failed', error);
        throw error;
    }

    return result;
}

/**
 * Probes a collection ID to check if it exists
 * @param {string} collectionId - Collection ID to probe
 * @param {object} settings - VECTFOX settings
 * @returns {Promise<{exists: boolean, count: number}>}
 */
async function probeCollection(collectionId, settings) {
    try {
        const hashes = await getSavedHashes(collectionId, settings);
        if (hashes && hashes.length > 0) {
            return { exists: true, count: hashes.length, unreachable: false };
        }
    } catch (error) {
        // A probe error is NOT "collection doesn't exist" — it usually means the
        // backend/transport was unavailable for this one request. Callers that
        // prune on exists:false must check `unreachable` first, or a transient
        // outage gets recorded as a permanent deletion (and cleanupOrphanedMeta
        // then wipes the collection's locks/metadata).
        log.warn(`VectFox: probe of ${collectionId} failed; treating it as unreachable:`, error);
        return { exists: false, count: 0, unreachable: true };
    }
    return { exists: false, count: 0, unreachable: false };
}

/**
 * Discovers existing collections by probing the registry and known patterns
 * Without the plugin, we can't scan the filesystem directly, so we:
 * 1. Check all collections already in the registry (may have been created before)
 * 2. Probe for current chat's collection
 * 3. Probe for collections based on known character names
 *
 * @param {object} settings VECTFOX settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaFallback(settings) {
    const discovered = [];
    const probed = new Set();

    log.lifecycle('VectFox: Running fallback discovery (no plugin)...');

    // 1. Validate existing registry entries - remove stale ones
    const registry = getCollectionRegistry();
    const validRegistryEntries = [];

    for (const registryKey of [...registry]) {
        if (probed.has(registryKey)) continue;
        probed.add(registryKey);

        // Parse the registry key to get the actual collection ID
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;

        // Fallback discovery runs precisely because the plugin is unavailable —
        // and qdrant collections are only reachable THROUGH the plugin. Probing
        // one here goes down the standard path, finds nothing, and would prune a
        // perfectly healthy qdrant collection (whose locks/metadata then get
        // wiped by cleanupOrphanedMeta). Unverifiable ≠ deleted: keep it.
        if (parsed.backend === 'qdrant') {
            validRegistryEntries.push(registryKey);
            log.verbose(`VectFox: Keeping qdrant registry entry (not verifiable without the plugin): ${registryKey}`);
            continue;
        }

        const result = await probeCollection(collectionId, settings);
        if (result.exists) {
            validRegistryEntries.push(registryKey);
            if (!discovered.includes(registryKey)) {
                discovered.push(registryKey);
            }
            log.verbose(`VectFox: Verified registry entry: ${collectionId} (${result.count} chunks)`);
        } else if (result.unreachable) {
            // Transport/backend error — unknown state, NOT proof of deletion.
            validRegistryEntries.push(registryKey);
            log.warn(`VectFox: Could not verify registry entry ${registryKey} (probe failed) — keeping it and its metadata; will re-verify on next discovery.`);
        } else {
            // Remove stale entry
            unregisterCollection(registryKey);
            log.verbose(`VectFox: Removed stale registry entry: ${registryKey}`);
        }
    }

    // 3. Probe for character-based collections
    for (const char of characters) {
        if (!char.name) continue;

        const sanitizedName = sanitizeNameSegment(char.name, 30);

        // VECTFOX character collection format
        const charCollectionId = `${COLLECTION_PREFIXES.VECTFOX_CHARACTER}${sanitizedName}`;
        if (!probed.has(charCollectionId)) {
            probed.add(charCollectionId);
            const result = await probeCollection(charCollectionId, settings);
            if (result.exists) {
                registerCollection(charCollectionId);
                discovered.push(charCollectionId);
                log.verbose(`VectFox: Discovered character collection: ${charCollectionId} (${result.count} chunks)`);
            }
        }
    }

    // Note: Without filesystem access, we can't discover collections with unknown IDs
    // The registry is our primary source of truth for non-current-chat collections

    log.lifecycle(`VectFox: Fallback discovery complete. Found ${discovered.length} collections.`);
    return discovered;
}

/**
 * Discovers existing collections (uses plugin if available, fallback otherwise)
 * @param {object} settings VECTFOX settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
export async function discoverExistingCollections(settings) {
    const hasPlugin = await checkPluginAvailable();

    if (hasPlugin) {
        log.trace('VectFox: Using plugin for collection discovery');
        return await discoverViaPlugin(settings);
    } else {
        log.lifecycle('VectFox: Plugin not available, using fallback discovery');
        return await discoverViaFallback(settings);
    }
}

/**
 * Loads all collections with metadata
 * @param {object} settings VECTFOX settings
 * @param {boolean} autoDiscover If true, attempts to discover unregistered collections
 * @returns {Promise<object[]>} Array of collection objects
 */
export async function loadAllCollections(settings, autoDiscover = true) {
    log.trace('🐰 VectFox: Loading all collections for Database Browser...');

    // Clean up registry first (remove nulls and duplicates)
    cleanupCollectionRegistry();

    // Auto-discover existing collections on first load
    if (autoDiscover) {
        await discoverExistingCollections(settings);
    }

    const registry = getCollectionRegistry();
    log.trace(`VectFox: Registry contains ${registry.length} collection(s):`, registry);

    const collections = [];
    const hasPlugin = isPluginDetected();

    for (const registryKey of registry) {
        try {
            // Use unified registry key parser from collection-ids.js
            const parsedKey = parseRegistryKey(registryKey);
            const collectionId = parsedKey.collectionId;
            const registrySource = parsedKey.source;
            const registryBackend = parsedKey.backend;

            // Ensure creatorHandle is stamped for any entry that was registered before the stamp
            // logic landed, or imported from another session. registerCollection() is idempotent:
            // won't duplicate, won't overwrite an existing handle, and only saves for truly new entries.
            registerCollection(registryKey);

            log.trace(`VectFox: Loading collection: ${collectionId} (backend: ${registryBackend || 'unknown'}, source: ${registrySource || 'unknown'})`);

            // First check stored metadata for user-defined contentType (authoritative source)
            const storedMeta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
            const parsedMeta = parseCollectionId(collectionId);

            // One-time migration: scope='global' is no longer supported. Rewrite to 'character'
            // so the rest of the codebase only has to handle 'character' and 'chat'. The collection
            // stays inactive until the user locks it in Collection Settings (its lock switch, or Manage locks).
            if (storedMeta.scope === 'global') {
                const collectionsMap = extension_settings?.vectfox?.collections || {};
                const writeKey = collectionsMap[registryKey] ? registryKey : collectionId;
                setCollectionMeta(writeKey, { scope: 'character' });
                storedMeta.scope = 'character';
                log.verbose(`VectFox: Migrated ${collectionId} from scope='global' to scope='character'`);
            }

            // `storedMeta.scope` is already auto-resolved by getCollectionMeta
            // (always returns 'chat' or 'character', never null or 'unknown').
            // No defensive read needed here — the canonical resolution lives
            // in getEffectiveScope. See Doc/collection_helper.md.
            const metadata = {
                type: storedMeta.contentType || parsedMeta.type,
                scope: storedMeta.scope,
                rawId: parsedMeta.rawId,
            };
            log.trace(`VectFox:   Type: ${metadata.type}, Scope: ${metadata.scope}${storedMeta.contentType ? ' (from stored meta)' : ' (parsed from ID)'}`);

            let chunkCount = 0;
            let hashes = [];
            let source = registrySource || 'unknown';
            let backend = registryBackend || 'standard';
            let model = '';
            let models = [];
            let sources = [];

            // If plugin is available, use chunk count, source, and backend from plugin cache
            // Cache key is "backend:collectionId" (same as registryKey for plugin-managed collections)
            const cacheKey = registryKey;
            if (hasPlugin && pluginCollectionData && pluginCollectionData[cacheKey]) {
                log.trace(`VectFox:   Using plugin mode - getting data from cache`);
                const cacheData = pluginCollectionData[cacheKey];
                source = cacheData.source;
                backend = cacheData.backend;
                models = cacheData.models || [];
                sources = cacheData.sources || [];

                // Check if user has a preferred model saved
                const collectionMeta = getCollectionMeta(registryKey);
                const preferredModel = collectionMeta?.preferredModel;

                if (preferredModel !== undefined && models.some(m => m.path === preferredModel)) {
                    // User has a valid preferred model
                    model = preferredModel;
                    const modelInfo = models.find(m => m.path === preferredModel);
                    chunkCount = modelInfo?.chunkCount || 0;
                    log.verbose(`VectFox:   Using user's preferred model: ${model}`);
                } else {
                    // Use plugin's default (most chunks)
                    model = cacheData.model || '';
                    chunkCount = cacheData.chunkCount || 0;
                }

                log.trace(`VectFox:   Plugin reported ${chunkCount} chunks (backend: ${backend}, source: ${source}, models: ${models.length})`);
            } else {
                // Fallback mode: registry key tells us the backend. If it's qdrant, query
                // qdrant directly. Otherwise try standard first.
                const registryBk = registryBackend || settings.vector_backend || 'standard';
                log.verbose(`VectFox:   Using fallback mode - backend from registry: ${registryBk}`);
                const fallbackSettings = { ...settings, vector_backend: registryBk };
                try {
                    hashes = await getSavedHashes(collectionId, fallbackSettings);
                    chunkCount = hashes?.length || 0;
                    log.verbose(`VectFox:   Found ${chunkCount} hashes via ${registryBk} backend`);
                } catch (standardError) {
                    // Try the currently-configured backend if different
                    if (settings.vector_backend && settings.vector_backend !== registryBk) {
                        log.verbose(`VectFox:   ${registryBk} backend failed, trying ${settings.vector_backend}:`, standardError);
                        try {
                            hashes = await getSavedHashes(collectionId, settings);
                            chunkCount = hashes?.length || 0;
                            log.verbose(`VectFox:   Found ${chunkCount} hashes via ${settings.vector_backend}`);
                        } catch (altError) {
                            log.warn(`VectFox:   Both backends failed for ${collectionId}:`, standardError, altError);
                            chunkCount = 0;
                        }
                    } else {
                        log.warn(`VectFox:   ${registryBk} backend failed for ${collectionId}:`, standardError);
                        chunkCount = 0;
                    }
                }
            }

            const displayName = getCollectionDisplayName(collectionId, registryKey, metadata);
            log.trace(`VectFox:   Display name: ${displayName}`);

            // Metadata is stored under the registry-key form ("backend:id") so it
            // stays consistent with setCollectionLock, cleanupOrphanedMeta, and the
            // import path. Writing at the bare collectionId would land in a different
            // bucket that the orphan-cleanup pass would immediately remove.
            const enabled = isCollectionEnabled(registryKey);
            ensureCollectionMeta(registryKey, { scope: metadata.scope });

            collections.push({
                id: collectionId,           // Original collection ID (for API calls)
                registryKey: registryKey,   // Full key with source (for internal tracking)
                name: displayName,
                type: metadata.type,
                scope: metadata.scope,
                chunkCount: chunkCount,
                enabled: enabled,
                hashes: hashes,
                rawId: metadata.rawId,
                source: source,
                backend: backend,
                model: model,               // Primary model path for vectra lookups
                models: models,             // All available models [{name, path, chunkCount}]
                sources: sources            // Every on-disk source folder [{source, models}] — delete purges all
            });
            log.trace(`VectFox:   ✓ Added to collections list`);
        } catch (error) {
            log.error(`VectFox: Failed to load collection ${registryKey}`, error);
            log.error(`VectFox:   Error details:`, error.message);
            log.error(`VectFox:   Stack:`, error.stack);
            // Continue loading other collections
        }
    }

    log.trace(`\n✅ VectFox: Loaded ${collections.length} non-empty collections for Database Browser`);
    if (collections.length === 0 && registry.length > 0) {
        log.trace(`⚠️ VectFox: ${registry.length} collections in registry but all are empty!`);
        log.trace(`   💡 Collections need to have vectorized chunks to appear in Database Browser`);
        log.trace(`   💡 Try vectorizing your chat or content first`);
    } else if (collections.length === 0 && registry.length === 0) {
        log.trace(`ℹ️ VectFox: No collections registered yet`);
        log.trace(`   💡 Collections are created when you vectorize chat messages or documents`);
    }

    return collections;
}

/**
 * Returns true if the collection has 0 chunks according to the plugin discovery cache.
 * Used by retrieval to skip empty collections without querying them.
 * @param {string} registryKey - e.g. "vectra:vf_lorebook_story1_..."
 * @returns {boolean}
 */
export function isCollectionEmpty(registryKey) {
    if (!pluginCollectionData) return false;
    const cached = pluginCollectionData[registryKey];
    return cached !== undefined && !cached.chunkCount;
}
