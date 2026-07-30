/**
 * VECTFOX Collection Metadata Manager
 *
 * Manages collection-level metadata in extension_settings.vectfox.collections
 * This is the "settings layer" - user preferences for collections.
 *
 * Separation of concerns:
 * - collection-loader.js = Discovery & loading (talks to vector backends)
 * - collection-metadata.js = Settings & state (talks to extension_settings)
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { parseRegistryKey, COLLECTION_PREFIXES, parseCollectionId, sanitizeHandleId } from './collection-ids.js';
import { log } from './log.js';

// ============================================================================
// COLLECTION METADATA CRUD
// ============================================================================

/**
 * Default metadata for a new collection
 */
const defaultCollectionMeta = {
    enabled: true,
    autoSync: false,  // Per-collection auto-sync for chat vectorization
    // `null` (not the string 'unknown'). Truthy-string defaults break the
    // `storedMeta.scope || parsedMeta.scope` fall-through pattern used by
    // the collection loader (line ~1007) — with `'unknown'` as the default,
    // the OR short-circuits and the correctly-parsed scope from the ID
    // structure is ignored, leaving collections un-lockable via the UI.
    // Surfaced 2026-05-24 by a no-plugin user whose fallback-discovered
    // EventBase collection couldn't be activated — the checkbox flipped
    // visually but `saveActivation` had no branch for scope='unknown' and
    // silently wrote nothing. See Doc/collection_helper.md.
    scope: null,
    displayName: null,
    description: '',
    tags: [],
    color: null,
    createdAt: null,
    lastUsed: null,
    queryCount: 0,

    // =========================================================================
    // ACTIVATION TRIGGERS (PRIMARY METHOD - Like Lorebook)
    // =========================================================================
    // Simple keyword-based activation. If ANY trigger matches recent messages,
    // the collection activates. This is the primary, user-friendly method.
    //
    // Priority order:
    // 1. triggers[] not empty → Match keywords in recent messages
    // 2. conditions.enabled=true → Advanced rules (secondary method)
    // 3. No triggers + no conditions → Auto-activates
    triggers: [],                  // Array of trigger keywords (case-insensitive)
    triggerMatchMode: 'any',       // 'any' = OR logic, 'all' = AND logic
    triggerCaseSensitive: false,   // Case sensitivity for trigger matching
    triggerScanDepth: 5,           // How many recent messages to scan for triggers

    // =========================================================================
    // CONDITIONAL ACTIVATION (ADVANCED METHOD - Secondary)
    // =========================================================================
    // Complex rule-based activation. Only evaluated if triggers don't match
    // or if no triggers are set. Use for sophisticated activation logic.
    conditions: {
        enabled: false,
        logic: 'AND', // 'AND' = all rules must pass, 'OR' = any rule passes
        rules: [],    // Array of condition rules
    },

    // =========================================================================
    // PROMPT CONTEXT (Per-Collection)
    // =========================================================================
    // Wraps all chunks from this collection with context/guidance for the AI.
    // Supports {{user}} and {{char}} variables.
    // Example: "Things {{char}} remembers about {{user}}:"
    context: '',      // Natural language context shown before this collection's chunks
    xmlTag: '',       // XML tag to wrap this collection's chunks (e.g., "memories")
};

/**
 * ============================================================================
 * CONDITION TYPES
 * ============================================================================
 *
 * COLLECTION & CHUNK CONDITIONS (11 types):
 * Can be used at both collection-level and chunk-level.
 * Collection-level: Determines if a collection should be queried
 * Chunk-level: Determines if a specific chunk should be included
 *
 * - pattern:          Advanced regex/pattern matching (replaces keyword)
 * - speaker:          Match by who spoke last
 * - characterPresent: Check if specific character(s) spoke recently
 * - messageCount:     Conversation length pacing (eq, gte, lte, between)
 * - isGroupChat:      Group vs 1-on-1 chat
 * - generationType:   Normal, swipe, continue, regenerate, impersonate
 * - lorebookActive:   Specific lorebook entries are triggered
 * - swipeCount:       Number of swipes on last message
 * - timeOfDay:        Real-world time window (supports midnight crossing)
 * - randomChance:     Probabilistic activation (0-100%)
 *
 * CHUNK-ONLY FEATURES:
 * Only make sense at chunk-level, not collection-level.
 *
 * - chunkLinks:       Force/soft links to other chunks ({ targetHash, mode: 'force'|'soft' })
 *                     - hard: Target chunk MUST appear if source appears
 *                     - soft: Target chunk gets score boost if source appears
 *                     Each chunk defines its own links independently.
 *                     For two-way linking, add links on both chunks.
 * - scoreThreshold:   Per-chunk minimum similarity score override
 * - recency:          Filter by message age (messagesAgo)
 * - frequency:        Limit activations (maxActivations, cooldownMessages)
 *
 * See: conditional-activation.js for full implementation.
 * ============================================================================
 */

/**
 * Condition rule structure (for reference):
 * {
 *     type: 'keyword',           // Condition type
 *     negate: false,             // Invert the result
 *     settings: {                // Type-specific settings
 *         values: ['combat'],
 *         matchMode: 'contains', // contains, exact, startsWith, endsWith
 *         caseSensitive: false,
 *     }
 * }
 */

/**
 * Ensures the collections object exists in extension_settings
 */
function ensureCollectionsObject() {
    // VEC-26: Add proper null checks to prevent crashes
    if (!extension_settings) {
        log.error('VectFox: extension_settings is null/undefined - cannot access collections');
        return false;
    }
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.collections) {
        extension_settings.vectfox.collections = {};
    }
    return true;
}


/**
 * Canonical scope resolver — returns the EFFECTIVE scope of a collection,
 * always 'chat' or 'character', never null/undefined/'unknown'.
 *
 * Use this anywhere you need to branch on scope. Never branch on bare
 * `meta.scope === 'chat'` (or compare to 'character'), because `meta.scope`
 * can be `null` (post-2026-05-24 default) or the legacy string `'unknown'`
 * (collections created before the default fix landed). Both cases would
 * silently miss every branch and write nothing — exactly the 2026-05-24
 * "lock checkbox doesn't stick" no-plugin regression.
 *
 * Resolution order:
 *   1. Stored `meta.scope` if it's a valid value ('chat' or 'character').
 *   2. Parsed from the collection ID structure (via `parseCollectionId`):
 *      - `vf_eventbase_*` / `vf_archiveevent_*` → 'chat'
 *      - `vf_character_*` / `vf_lorebook_*` / `vf_document_*` → 'character'
 *   3. Default 'character' (matches `content-vectorization.js` insert default).
 *      Only reached for unparseable IDs (parser returns 'unknown' sentinel)
 *      and legacy stored values like the retired 'global'.
 *
 * @param {string} collectionIdOrRegistryKey - bare ID or "backend:id"
 * @param {object} [meta] - already-loaded meta (avoids re-reading from storage)
 * @returns {'chat'|'character'}
 */
export function getEffectiveScope(collectionIdOrRegistryKey, meta = null) {
    // 1. Stored meta wins if it's a valid scope value.
    const stored = meta?.scope;
    if (stored === 'chat' || stored === 'character') return stored;

    // 2. Parse from the bare collection ID (strip registry-key prefix first).
    const parsed = parseRegistryKey(collectionIdOrRegistryKey);
    const bareId = parsed.collectionId || collectionIdOrRegistryKey;
    const parsedScope = parseCollectionId(bareId).scope;
    if (parsedScope === 'chat' || parsedScope === 'character') return parsedScope;

    // 3. Default — matches the content-vectorization insert default so a
    //    user creating then immediately locking lands on 'character' (the
    //    safer / wider-scope option).
    return 'character';
}

/**
 * Gets metadata for a collection.
 *
 * Auto-resolves `meta.scope` to a valid value via {@link getEffectiveScope}
 * before returning, so callers never see `null` or legacy `'unknown'` and
 * don't have to remember the defensive `scope === 'chat'` branching pattern.
 *
 * @param {string} collectionId Collection identifier
 * @returns {object} Collection metadata (with defaults applied + scope resolved)
 */
export function getCollectionMeta(collectionId) {
    // VEC-26: Add comprehensive null checks
    if (!ensureCollectionsObject()) {
        const fresh = { ...defaultCollectionMeta };
        fresh.scope = getEffectiveScope(collectionId, fresh);
        return fresh;
    }

    const stored = extension_settings.vectfox.collections[collectionId];
    const merged = stored
        ? { ...defaultCollectionMeta, ...stored }
        : { ...defaultCollectionMeta };

    // Always return a usable scope. Cheap when stored is already valid
    // (single string comparison); only parses the ID when stored is null/
    // undefined/'unknown'. This is the single place that fixes every
    // downstream consumer of meta.scope — saveActivation, refreshWIStatus,
    // the badge renderer, the activation editor — without each of them
    // needing their own defensive read.
    merged.scope = getEffectiveScope(collectionId, merged);

    return merged;
}

/**
 * Sets metadata for a collection (merges with existing)
 * @param {string} collectionId Collection identifier
 * @param {object} data Metadata to set (partial or full)
 */
export function setCollectionMeta(collectionId, data) {
    if (!collectionId) {
        log.warn('VectFox: setCollectionMeta called with null/undefined collectionId');
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vectfox.collections[collectionId] || {};

    extension_settings.vectfox.collections[collectionId] = {
        ...defaultCollectionMeta,
        ...existing,
        ...data,
    };

    saveSettingsDebounced();
    log.trace(`VectFox: Updated metadata for collection ${collectionId}`);
}

/**
 * Deletes metadata for a collection
 * @param {string} collectionId Collection identifier
 */
export function deleteCollectionMeta(collectionId) {
    ensureCollectionsObject();

    if (extension_settings.vectfox.collections[collectionId]) {
        delete extension_settings.vectfox.collections[collectionId];
        _updateChatLockIndex(collectionId, null, '*');
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Deleted metadata for collection ${collectionId}`);
    }
}

/**
 * Gets all collection metadata
 * @returns {object} Map of collectionId -> metadata
 */
export function getAllCollectionMeta() {
    ensureCollectionsObject();
    return extension_settings.vectfox.collections;
}

// ============================================================================
// ENABLED STATE (convenience wrappers)
// ============================================================================

/**
 * Sets whether a collection is enabled
 * @param {string} collectionId Collection identifier
 * @param {boolean} enabled Whether collection is enabled
 */
export function setCollectionEnabled(collectionId, enabled) {
    setCollectionMeta(collectionId, { enabled: enabled });
}

/**
 * Checks if a collection is enabled
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is enabled (default: true)
 */
export function isCollectionEnabled(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.enabled !== false;
}

// ============================================================================
// AUTO-SYNC STATE (per-collection auto-sync for chat vectorization)
// ============================================================================

/**
 * Sets whether auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} autoSync Whether auto-sync is enabled
 */
export function setCollectionAutoSync(collectionId, autoSync) {
    setCollectionMeta(collectionId, { autoSync: autoSync });
}

/**
 * Checks if auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether auto-sync is enabled (default: false)
 */
export function isCollectionAutoSyncEnabled(collectionId) {
    if (!collectionId) {
        return false;
    }
    const meta = getCollectionMeta(collectionId);
    return meta.autoSync === true;
}

// ============================================================================
// CHUNK METADATA (per-chunk settings, stored separately)
// ============================================================================
// Chunk metadata is stored per-hash and can include:
// - conditions: { ... }     - Conditional activation rules
// - chunkLinks: []          - Soft/hard links to other chunks ({ targetHash, mode })
// - disabled: boolean       - Exclude from results
// - isSummary: boolean      - Dual-vector summary chunk
// - parentHash: string      - Parent chunk for summaries
// - context: string         - Prompt context text (supports {{user}}/{{char}})
// - xmlTag: string          - XML tag to wrap this chunk
// ============================================================================

/**
 * Gets metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @returns {object|null} Chunk metadata or null if not found
 */
export function getChunkMetadata(hash) {
    if (!extension_settings.vectfox) {
        return null;
    }

    const key = `vectfox_chunk_meta_${hash}`;
    return extension_settings.vectfox[key] || null;
}

/**
 * Saves metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @param {object} metadata Chunk metadata
 */
export function saveChunkMetadata(hash, metadata) {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }

    const key = `vectfox_chunk_meta_${hash}`;
    extension_settings.vectfox[key] = {
        ...metadata,
        updatedAt: Date.now(),
    };

    saveSettingsDebounced();
}

/**
 * Deletes metadata for a specific chunk
 * @param {string} hash Chunk hash
 */
export function deleteChunkMetadata(hash) {
    if (!extension_settings.vectfox) {
        return;
    }

    const key = `vectfox_chunk_meta_${hash}`;
    if (extension_settings.vectfox[key]) {
        delete extension_settings.vectfox[key];
        saveSettingsDebounced();
    }
}

/**
 * Gets all chunk metadata entries
 * @returns {object} Map of hash -> metadata
 */
export function getAllChunkMetadata() {
    if (!extension_settings.vectfox) {
        return {};
    }

    const result = {};
    const prefix = 'vectfox_chunk_meta_';

    for (const key in extension_settings.vectfox) {
        if (key.startsWith(prefix)) {
            const hash = key.replace(prefix, '');
            result[hash] = extension_settings.vectfox[key];
        }
    }

    return result;
}

// ============================================================================
// MIGRATION & CLEANUP
// ============================================================================

/**
 * Migrates old scattered enabled keys to new collections structure
 * Old format: vectfox_collection_enabled_{collectionId} = true/false
 * New format: collections[collectionId].enabled = true/false
 */
export function migrateOldEnabledKeys() {
    if (!extension_settings.vectfox) {
        return { migrated: 0 };
    }

    ensureCollectionsObject();

    let migrated = 0;
    const keysToDelete = [];

    for (const key in extension_settings.vectfox) {
        if (key.startsWith('vectfox_collection_enabled_')) {
            const collectionId = key.replace('vectfox_collection_enabled_', '');
            const enabled = extension_settings.vectfox[key];

            // Only migrate if we don't already have metadata for this collection
            if (!extension_settings.vectfox.collections[collectionId]) {
                extension_settings.vectfox.collections[collectionId] = {
                    ...defaultCollectionMeta,
                    enabled: enabled !== false,
                };
                log.lifecycle(`VectFox: Migrated enabled key for ${collectionId}`);
            }

            keysToDelete.push(key);
            migrated++;
        }
    }

    // Delete old keys
    for (const key of keysToDelete) {
        delete extension_settings.vectfox[key];
    }

    if (migrated > 0) {
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Migrated ${migrated} old enabled keys to new collections structure`);
    }

    return { migrated };
}

/**
 * Cleans up orphaned metadata entries (collections that no longer exist)
 * @param {string[]} actualCollectionIds Array of collection IDs that actually exist
 * @returns {object} Cleanup stats
 */
export function cleanupOrphanedMeta(actualCollectionIds) {
    ensureCollectionsObject();

    const actualSet = new Set(actualCollectionIds);
    const orphaned = [];

    for (const collectionId in extension_settings.vectfox.collections) {
        if (!actualSet.has(collectionId)) {
            orphaned.push(collectionId);
        }
    }

    // Mass-wipe refusal. An empty survivor list with metadata still stored means
    // discovery found NOTHING — which in practice is an outage (plugin down,
    // Qdrant unreachable), not the user having deleted every collection at once.
    // Metadata holds the chat/character locks and triggers; deleting it here is
    // irreversible, while a stale entry costs nothing and self-corrects on the
    // next successful discovery. Refuse and say so.
    if (actualCollectionIds.length === 0 && orphaned.length > 0) {
        log.warn(`VectFox: cleanupOrphanedMeta refused — discovery returned ZERO collections while ${orphaned.length} metadata entr${orphaned.length === 1 ? 'y is' : 'ies are'} stored. This looks like a backend outage, not a real mass deletion; keeping all metadata (locks, triggers) intact.`);
        return { removed: 0, orphanedIds: [], refused: true };
    }

    for (const collectionId of orphaned) {
        delete extension_settings.vectfox.collections[collectionId];
        log.trace(`VectFox: Removed orphaned metadata for ${collectionId}`);
    }

    if (orphaned.length > 0) {
        saveSettingsDebounced();
        // warn, not lifecycle: this deletes locks/triggers with the collection.
        // When a wipe is ever wrong (see the refusal above), this line is the
        // only trace of WHAT was lost — name the entries.
        log.warn(`VectFox: Cleaned up ${orphaned.length} orphaned metadata entries: ${orphaned.join(', ')}`);
    }

    return { removed: orphaned.length, orphanedIds: orphaned, refused: false };
}

// ============================================================================
// COLLECTION LOCKING (Bind collection to one or more chats)
// ============================================================================

/**
 * Maintains the reverse index: extension_settings.vectfox.chat_lock_index[chatId] = [collectionId, ...]
 * @param {string} collectionId
 * @param {string|null} addChatId - chat to add collectionId to (null = skip)
 * @param {string|'*'|null} removeChatId - chat to remove collectionId from, '*' = remove from all, null = skip
 */
function _updateChatLockIndex(collectionId, addChatId, removeChatId) {
    const store = extension_settings?.vectfox;
    if (!store) return;
    if (!store.chat_lock_index) store.chat_lock_index = {};
    const idx = store.chat_lock_index;

    if (addChatId) {
        const key = String(addChatId);
        if (!Array.isArray(idx[key])) idx[key] = [];
        if (!idx[key].includes(collectionId)) idx[key].push(collectionId);
    }

    if (removeChatId === '*') {
        for (const key of Object.keys(idx)) {
            idx[key] = idx[key].filter(id => id !== collectionId);
            if (idx[key].length === 0) delete idx[key];
        }
    } else if (removeChatId) {
        const key = String(removeChatId);
        if (Array.isArray(idx[key])) {
            idx[key] = idx[key].filter(id => id !== collectionId);
            if (idx[key].length === 0) delete idx[key];
        }
    }
}

/**
 * Returns the collection IDs locked to a given chat (O(1) lookup).
 * Only includes collections registered via setCollectionLock after this index was introduced.
 * @param {string} chatId
 * @returns {string[]}
 */
export function getChatLockedCollections(chatId) {
    const idx = extension_settings?.vectfox?.chat_lock_index;
    if (!idx || !chatId) return [];
    return Array.isArray(idx[String(chatId)]) ? [...idx[String(chatId)]] : [];
}

/**
 * Adds a chat to the collection's lock list. Supports multiple chats per collection.
 * Stores chat IDs in metadata field `lockedToChatIds` (array).
 * Automatically migrates old single-value `lockedToChatId` to array format.
 * @param {string} collectionId
 * @param {string|null} chatId - Chat ID to lock to, or null to remove all locks
 */
export function setCollectionLock(collectionId, chatId) {
    if (!collectionId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    if (chatId === null) {
        // Clear all locks
        update.lockedToChatIds = [];
        update.lockedToChatId = null; // Clear old format for backward compat
    } else {
        chatId = String(chatId);
        let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

        // Migrate old single-value format if present
        if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
            locks.push(String(meta.lockedToChatId));
        }

        // Add chat if not already present
        if (!locks.includes(chatId)) {
            locks.push(chatId);
        }

        update.lockedToChatIds = locks;
        update.lockedToChatId = null; // Clear old format
    }

    setCollectionMeta(collectionId, update);
    _updateChatLockIndex(collectionId, chatId === null ? null : chatId, chatId === null ? '*' : null);
    log.lifecycle(`VectFox: Collection ${collectionId} locks updated:`, update.lockedToChatIds);
}

/**
 * Removes a specific chat from a collection's lock list
 * @param {string} collectionId
 * @param {string} chatId - Chat ID to remove from lock list
 */
export function removeCollectionLock(collectionId, chatId) {
    if (!collectionId || !chatId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Migrate old format if present
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    // Remove the chat
    locks = locks.filter(id => String(id) !== String(chatId));

    update.lockedToChatIds = locks;
    update.lockedToChatId = null; // Clear old format

    setCollectionMeta(collectionId, update);
    _updateChatLockIndex(collectionId, null, chatId);
    log.lifecycle(`VectFox: Removed chat ${chatId} from collection ${collectionId} locks`);
}

/**
 * Clears all locks for a collection (removes from all chats)
 * @param {string} collectionId
 */
export function clearCollectionLock(collectionId) {
    setCollectionLock(collectionId, null);
}

/**
 * Gets the array of locked chat IDs for a collection, or empty array if not locked
 * Includes backward compatibility for old single-value `lockedToChatId` format
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Backward compatibility: if old format exists and not already in new format, include it
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    return locks;
}

/**
 * Checks whether the collection is locked to the provided chatId
 * @param {string} collectionId
 * @param {string} chatId
 * @returns {boolean}
 */
export function isCollectionLockedToChat(collectionId, chatId) {
    if (!collectionId || !chatId) return false;
    const locks = getCollectionLocks(collectionId);
    return locks.some(id => String(id) === String(chatId));
}

/**
 * Gets the count of chats this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionLockCount(collectionId) {
    return getCollectionLocks(collectionId).length;
}

// ============================================================================
// CHARACTER LOCKING (Bind collection to one or more character cards)
// ============================================================================

/**
 * Adds a character to the collection's character lock list. Supports multiple characters per collection.
 * Stores character IDs in metadata field `lockedToCharacterIds` (array).
 * @param {string} collectionId
 * @param {string} characterId - Character ID to lock to
 */
export function setCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    characterId = String(characterId);
    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Add character if not already present
    if (!locks.includes(characterId)) {
        locks.push(characterId);
    }

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    log.lifecycle(`VectFox: Collection ${collectionId} character locks updated:`, update.lockedToCharacterIds);
}

/**
 * Removes a specific character from a collection's character lock list
 * @param {string} collectionId
 * @param {string} characterId - Character ID to remove from lock list
 */
export function removeCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Remove the character
    locks = locks.filter(id => String(id) !== String(characterId));

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    log.lifecycle(`VectFox: Removed character ${characterId} from collection ${collectionId} locks`);
}

/**
 * Clears all character locks for a collection
 * @param {string} collectionId
 */
export function clearCollectionCharacterLocks(collectionId) {
    if (!collectionId) return;
    setCollectionMeta(collectionId, { lockedToCharacterIds: [] });
    log.lifecycle(`VectFox: Cleared all character locks for collection ${collectionId}`);
}

/**
 * Gets the array of locked character IDs for a collection, or empty array if not locked
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionCharacterLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];
}

/**
 * Checks whether the collection is locked to the provided character ID
 * @param {string} collectionId
 * @param {string} characterId
 * @returns {boolean}
 */
export function isCollectionLockedToCharacter(collectionId, characterId) {
    if (!collectionId || !characterId) return false;
    const locks = getCollectionCharacterLocks(collectionId);
    return locks.some(id => String(id) === String(characterId));
}

/**
 * Gets the count of characters this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionCharacterLockCount(collectionId) {
    return getCollectionCharacterLocks(collectionId).length;
}

/**
 * Single source of truth for "Active for current chat" — the UI checkbox state and the
 * listing lock badge both derive from this. Scope decides which lock list is consulted:
 *   - scope='chat'      → chat-lock list, match against current chat
 *   - scope='character' → character-lock list, match against current character
 * @param {string} collectionId
 * @param {{chatId?: string, characterId?: string|number}} context
 * @returns {boolean}
 */
export function isCollectionActiveForContext(collectionId, { chatId, characterId } = {}) {
    if (!collectionId) return false;
    const meta = getCollectionMeta(collectionId);
    // Infer missing scope from type so old collections (created before scope stamping)
    // still resolve correctly instead of silently returning false.
    const scope = (meta.scope && meta.scope !== 'unknown') ? meta.scope : (meta.type || 'chat');
    if (scope === 'chat') {
        return Boolean(chatId && isCollectionLockedToChat(collectionId, chatId));
    }
    if (scope === 'character') {
        return Boolean(characterId && isCollectionLockedToCharacter(collectionId, String(characterId)));
    }
    return false;
}

/**
 * Key-tolerant wrapper over {@link isCollectionActiveForContext} — the single
 * entry point for "is this collection active for the current chat/character?"
 * when you hold raw keys instead of a getCollectionListing entry.
 *
 * Lock + scope metadata can live under EITHER key form: the DB Browser pause
 * toggle and the registry write under the registry-key ("backend:id"), while the
 * "Active for current chat" checkbox can write under the bare collectionId. So a
 * caller that has a collection object must check both forms; this collapses that
 * into one call so the active-resolution logic stays in one place. Returns true
 * if active under ANY supplied form.
 *
 * @param {string|string[]} keys - registryKey and/or bare id (falsy entries skipped)
 * @param {{chatId?: string, characterId?: string|number}} [context]
 * @returns {boolean}
 */
export function isCollectionActiveForContextAnyKey(keys, context = {}) {
    const list = Array.isArray(keys) ? keys : [keys];
    return list.some(key => key && isCollectionActiveForContext(key, context));
}

// ============================================================================
// LOCK FACADE — getLock / setLock
// ============================================================================
// Two-function entry point for everything lock-related. Bundles:
//   1. Authorization (superadmin OR creator handle matches current persona)
//   2. Scope-aware lock list (chat vs character)
//   3. Current-context active check (locked to current chat/character)
//
// Callers MUST pass the canonical storage key (registry-key form "backend:id"
// when the collection belongs to a backend, bare ID otherwise). There is no
// auto-resolution — pass `collection.registryKey || collection.id` at call
// sites where you have the loader's collection object.

/**
 * Authorization check for lock operations. Returns true when:
 *   - settings.superadmin === true, OR
 *   - the collection's creatorHandle matches the current persona handle, OR
 *   - the collection has no creatorHandle stamp and its bare ID contains the
 *     current handle (legacy fallback — same logic as getCollectionListing).
 *
 * Returns true (allow) when context is unavailable so headless/system code
 * (collection-export imports, registry registration) isn't blocked.
 *
 * @param {object} meta - already-resolved collection metadata
 * @param {string} collectionId - original ID passed by caller (for legacy fallback)
 * @param {object} [settings] - extension_settings.vectfox (or partial)
 * @returns {boolean}
 */
function _isLockAuthorized(meta, collectionId, settings) {
    const store = settings || extension_settings?.vectfox || {};
    if (store.superadmin === true) return true;

    let currentHandle = '';
    try {
        // Dynamic require to avoid circular import with collection-loader.js.
        // If the context modules aren't ready (early boot), allow the action.
        const ctx = (typeof getContext === 'function') ? getContext() : null;
        // Must match the creatorHandle stamp exactly (sanitizeHandleId: NFC + edge-trim
        // + 30-char cap). The old inline derivation skipped those, so owners with
        // accented / long / punctuation-edged persona names failed this equality check
        // and got locked out of their own collections.
        currentHandle = sanitizeHandleId(ctx?.name1);
    } catch (_) {
        return true; // permissive when context unavailable
    }
    if (!currentHandle || currentHandle === 'user') return true; // permissive when no persona

    const creator = meta?.creatorHandle ? String(meta.creatorHandle).toLowerCase() : '';
    if (creator) return creator === currentHandle;

    // No creatorHandle stamp — legacy fallback to ID substring match.
    const bareId = parseRegistryKey(collectionId).collectionId || collectionId || '';
    return bareId.toLowerCase().includes(`_${currentHandle}_`);
}

/**
 * Get the lock state for a collection. One stop for: "is it locked anywhere?",
 * "is it locked to the current context?", "what chats/characters is it locked
 * to?", and "can the current user modify these locks?".
 *
 * Returns null when the caller is unauthorized (non-superadmin, non-owner).
 * Use options.ignoreAuth=true for internal/system callers that need the raw state.
 *
 * @param {string} collectionId - Bare ID or registry-key form ("backend:id")
 * @param {object} [options]
 * @param {string} [options.chatId] - Override current chat ID for the active check
 * @param {string|number} [options.characterId] - Override current character ID
 * @param {object} [options.settings] - VectFox settings (for superadmin flag)
 * @param {boolean} [options.ignoreAuth=false] - Skip authorization gate
 * @returns {null | {
 *   storageKey: string,
 *   scope: 'chat' | 'character' | 'unknown',
 *   chatLocks: string[],
 *   characterLocks: string[],
 *   isLocked: boolean,
 *   isActiveHere: boolean,
 *   canModify: boolean,
 * }}
 */
export function getLock(collectionId, options = {}) {
    if (!collectionId) return null;
    const { chatId, characterId, settings, ignoreAuth = false } = options;

    const meta = getCollectionMeta(collectionId);
    const canModify = _isLockAuthorized(meta, collectionId, settings);

    if (!ignoreAuth && !canModify) {
        return null;
    }

    const chatLocks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const scope = meta?.scope || 'unknown';

    let isActiveHere = false;
    if (scope === 'chat') {
        isActiveHere = Boolean(chatId && chatLocks.some(id => String(id) === String(chatId)));
    } else if (scope === 'character') {
        isActiveHere = Boolean(characterId && characterLocks.some(id => String(id) === String(characterId)));
    }

    return {
        storageKey: collectionId,
        scope,
        chatLocks,
        characterLocks,
        isLocked: chatLocks.length > 0 || characterLocks.length > 0,
        isActiveHere,
        canModify,
    };
}

/**
 * Mutate a collection's lock state. Validates authorization first.
 *
 * @param {string} collectionId - Bare ID or registry-key form
 * @param {{ kind: 'chat'|'character', op: 'add'|'remove'|'clear', target?: string }} action
 *   - kind:   which lock list to modify
 *   - op:     'add' = include target, 'remove' = drop target, 'clear' = empty the list
 *   - target: chatId or characterId (required for add/remove; ignored for clear)
 * @param {object} [options]
 * @param {object} [options.settings] - VectFox settings (for superadmin)
 * @param {boolean} [options.ignoreAuth=false] - Skip authorization (system use)
 * @returns {{ success: boolean, reason?: string }}
 */
export function setLock(collectionId, action, options = {}) {
    if (!collectionId) return { success: false, reason: 'missing collectionId' };
    if (!action || typeof action !== 'object') return { success: false, reason: 'missing action' };
    const { kind, op, target } = action;
    if (kind !== 'chat' && kind !== 'character') return { success: false, reason: 'invalid kind' };
    if (op !== 'add' && op !== 'remove' && op !== 'clear') return { success: false, reason: 'invalid op' };
    if ((op === 'add' || op === 'remove') && !target) return { success: false, reason: 'missing target' };

    const { settings, ignoreAuth = false } = options;
    const meta = getCollectionMeta(collectionId);

    if (!ignoreAuth && !_isLockAuthorized(meta, collectionId, settings)) {
        log.warn(`VectFox: setLock denied for ${collectionId} (kind=${kind}, op=${op}) — not superadmin and persona handle does not match creatorHandle`);
        return { success: false, reason: 'unauthorized' };
    }

    if (kind === 'chat') {
        if (op === 'add') setCollectionLock(collectionId, target);
        else if (op === 'remove') removeCollectionLock(collectionId, target);
        else clearCollectionLock(collectionId);
    } else {
        if (op === 'add') setCollectionCharacterLock(collectionId, String(target));
        else if (op === 'remove') removeCollectionCharacterLock(collectionId, String(target));
        else clearCollectionCharacterLocks(collectionId);
    }
    return { success: true };
}

/**
 * Ensures a collection has metadata (creates with defaults if missing)
 * Called when a collection is discovered/created
 * @param {string} collectionId Collection identifier
 * @param {object} initialData Optional initial data to set (can include 'type' for collection type)
 */
export function ensureCollectionMeta(collectionId, initialData = {}) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    if (!extension_settings.vectfox.collections[collectionId]) {
        extension_settings.vectfox.collections[collectionId] = {
            ...defaultCollectionMeta,
            createdAt: Date.now(),
            ...initialData,
        };
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Created metadata for new collection ${collectionId}`);
    }
}

/**
 * Updates lastUsed timestamp and increments queryCount
 * Called when a collection is queried
 * @param {string} collectionId Collection identifier
 */
export function recordCollectionUsage(collectionId) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vectfox.collections[collectionId];
    if (existing) {
        existing.lastUsed = Date.now();
        existing.queryCount = (existing.queryCount || 0) + 1;
        saveSettingsDebounced();
    }
}

// ============================================================================
// ACTIVATION TRIGGERS (Primary Method)
// ============================================================================

/**
 * Checks if any activation triggers match the recent messages
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} context Search context containing recentMessages
 * @param {object} options Matching options
 * @returns {boolean} Whether triggers matched
 */
function checkTriggers(triggers, context, options = {}) {
    if (!triggers || triggers.length === 0) {
        return false;
    }

    const {
        matchMode = 'any',
        caseSensitive = false,
        scanDepth = 5,
    } = options;

    // Get recent message text to scan
    const recentMessages = context.recentMessages || [];
    const messagesToScan = recentMessages.slice(0, scanDepth);
    const searchText = messagesToScan.join('\n');

    if (!searchText) {
        return false;
    }

    const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();

    // Check each trigger
    const results = triggers.map(trigger => {
        const triggerText = caseSensitive ? trigger : trigger.toLowerCase();

        // Support regex triggers (wrapped in /.../)
        if (trigger.startsWith('/') && trigger.lastIndexOf('/') > 0) {
            try {
                const lastSlash = trigger.lastIndexOf('/');
                const pattern = trigger.slice(1, lastSlash);
                const flags = trigger.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(pattern, flags);
                return regex.test(searchText);
            } catch (e) {
                log.warn(`VectFox: Invalid trigger regex: ${trigger}`);
                return false;
            }
        }

        // Plain text matching
        return textToSearch.includes(triggerText);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode (default)
}

// ============================================================================
// CONDITIONAL ACTIVATION (Advanced Method - Secondary)
// ============================================================================

// Import condition evaluator (lazy loaded to avoid circular deps)
let evaluateConditionRule = null;

/**
 * Lazily loads the condition evaluator
 */
async function getConditionEvaluator() {
    if (!evaluateConditionRule) {
        const module = await import('./conditional-activation.js');
        evaluateConditionRule = module.evaluateConditionRule;
    }
    return evaluateConditionRule;
}

/**
 * Evaluates advanced conditions for a collection
 * @param {object} meta Collection metadata
 * @param {object} context Search context
 * @param {string} collectionId Collection identifier (for logging)
 * @returns {Promise<boolean>} Whether conditions pass
 */
async function evaluateAdvancedConditions(meta, context, collectionId) {
    if (!meta.conditions || !meta.conditions.enabled) {
        return true; // No conditions = pass
    }

    const rules = meta.conditions.rules || [];
    if (rules.length === 0) {
        return true; // Enabled but no rules = pass
    }

    const evaluate = await getConditionEvaluator();

    const results = rules.map(rule => {
        const result = evaluate(rule, context);
        log.trace(`VectFox: Collection ${collectionId} condition ${rule.type}: ${result}`);
        return result;
    });

    const logic = meta.conditions.logic || 'AND';
    return logic === 'AND' ? results.every(r => r) : results.some(r => r);
}

/**
 * Checks whether a collection should be queried this turn.
 *
 * ACTIVATION IS A CHAIN OF GATES, NOT A LIST OF ALTERNATIVES. Every gate that
 * applies must pass:
 *
 * 1. Pause button (enabled=false)              → never activate
 * 2. Lock (chat or character) — THE MASTER SWITCH → required; unlocked never activates
 * 3. Activation Triggers, when configured      → keyword must match this turn
 * 4. Advanced Conditions, when configured      → rules must pass this turn
 * 5. Locked with no trigger and no condition   → always active
 *
 * The lock is what turns a collection on at all; triggers and conditions only
 * NARROW an already-on collection. A collection with trigger keywords but no
 * lock is inert by design — the user has described what should activate it but
 * has not switched it on.
 *
 * This replaced an OR chain in which a trigger match returned true "regardless
 * of lock state". That inverted the intended model twice over: an unlocked
 * collection could activate on a keyword (the leak the isOwn guard in
 * core/world-info-integration.js was added to contain), and — because a
 * non-matching trigger fell THROUGH to the lock check — a trigger on a locked
 * collection was a no-op that could never gate anything. Both are fixed here.
 *
 * @param {string} collectionId Collection identifier
 * @param {object} context Search context (from buildSearchContext) — must carry
 *   recentMessages for trigger matching, plus currentChatId / currentCharacterId
 * @returns {Promise<boolean>} Whether the collection should be queried
 */
export async function shouldCollectionActivate(collectionId, context) {
    const meta = getCollectionMeta(collectionId);
    const currentChatId = context?.currentChatId;
    const currentCharacterId = context?.currentCharacterId;

    // Gate 1: Pause button — global disable, blocks everything.
    if (meta.enabled === false) {
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ DISABLED`);
        return false;
    }

    // Gate 2: Lock — the master switch. Nothing downstream can activate a
    // collection the user has not switched on for this chat or character.
    const lockedToChat = !!(currentChatId && isCollectionLockedToChat(collectionId, currentChatId));
    const lockedToCharacter = !!(currentCharacterId && isCollectionLockedToCharacter(collectionId, currentCharacterId));
    if (!lockedToChat && !lockedToCharacter) {
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ NOT_LOCKED (master switch off for chat=${currentChatId}, character=${currentCharacterId})`);
        return false;
    }

    const hasTriggers = meta.triggers && meta.triggers.length > 0;
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: locked (chat=${lockedToChat}, character=${lockedToCharacter}), hasTriggers=${hasTriggers}, hasConditions=${hasConditions}`);

    // Gate 3: Activation Triggers narrow the locked collection to matching turns.
    if (hasTriggers) {
        const triggersMatch = checkTriggers(meta.triggers, context, {
            matchMode: meta.triggerMatchMode || 'any',
            caseSensitive: meta.triggerCaseSensitive || false,
            scanDepth: meta.triggerScanDepth || 5,
        });
        if (!triggersMatch) {
            log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ TRIGGERS_UNMATCHED (${meta.triggers.join(', ')})`);
            return false;
        }
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ TRIGGERS_MATCHED`);
    }

    // Gate 4: Advanced Conditions narrow further. Both must hold when both are
    // configured — they are successive filters, not alternatives.
    if (hasConditions) {
        const conditionsPass = await evaluateAdvancedConditions(meta, context, collectionId);
        if (!conditionsPass) {
            log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ CONDITIONS_FAIL`);
            return false;
        }
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ CONDITIONS_PASS`);
    }

    // Gate 5: Locked and every configured filter passed.
    log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ ACTIVE`);
    return true;
}

/**
 * Filters a list of collection IDs to only those that should activate
 * @param {string[]} collectionIds Array of collection IDs to check
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<string[]>} Collection IDs that should be queried
 */
export async function filterActiveCollections(collectionIds, context) {
    const results = await Promise.all(
        collectionIds.map(async (id) => ({
            id,
            active: await shouldCollectionActivate(id, context)
        }))
    );

    const activeIds = results.filter(r => r.active).map(r => r.id);

    if (log.enabled('trace')) {
        log.trace(`[VECTFOX Activation Filter] Summary: ${collectionIds.length} collections → ${activeIds.length} active`);
        if (activeIds.length > 0) {
            log.trace(`[VECTFOX Activation Filter] Active collections:`, activeIds);
        }
    }

    return activeIds;
}

// ============================================================================
// ACTIVATION TRIGGER HELPERS
// ============================================================================

/**
 * Sets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} options Optional: matchMode, caseSensitive, scanDepth
 */
export function setCollectionTriggers(collectionId, triggers, options = {}) {
    const update = { triggers };
    if (options.matchMode !== undefined) update.triggerMatchMode = options.matchMode;
    if (options.caseSensitive !== undefined) update.triggerCaseSensitive = options.caseSensitive;
    if (options.scanDepth !== undefined) update.triggerScanDepth = options.scanDepth;
    setCollectionMeta(collectionId, update);
}

/**
 * Gets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} { triggers, matchMode, caseSensitive, scanDepth }
 */
export function getCollectionTriggers(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return {
        triggers: meta.triggers || [],
        matchMode: meta.triggerMatchMode || 'any',
        caseSensitive: meta.triggerCaseSensitive || false,
        scanDepth: meta.triggerScanDepth || 5,
    };
}

/**
 * Gets a summary of a collection's activation settings
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary of activation state
 */
export function getCollectionActivationSummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const triggers = meta.triggers || [];
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    let mode = 'auto'; // No triggers, no conditions = auto-activate
    if (triggers.length > 0) {
        mode = 'triggers';
    } else if (hasConditions) {
        mode = 'conditions';
    }

    return {
        mode,
        triggerCount: triggers.length,
        conditionCount: meta.conditions?.rules?.length || 0,
        conditionsEnabled: hasConditions,
    };
}

// ============================================================================
// ADVANCED CONDITIONS HELPERS
// ============================================================================

/**
 * Sets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} conditions Conditions object { enabled, logic, rules }
 */
export function setCollectionConditions(collectionId, conditions) {
    setCollectionMeta(collectionId, { conditions });
}

/**
 * Gets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Conditions object
 */
export function getCollectionConditions(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.conditions || { enabled: false, logic: 'AND', rules: [] };
}

