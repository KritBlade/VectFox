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

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { parseRegistryKey, parseCollectionId } from '../../shared/collection-ids.js';
import { log } from '../../sillytavern/log.js';
import { renamedChatIds } from '../../shared/renamed-chat.js';
import { chatLocksOf, planCollectionLockCleanup } from './collection-lock-cleanup-core.js';

// ============================================================================
// COLLECTION METADATA CRUD
// ============================================================================

/**
 * Default metadata for a new collection
 */
const defaultCollectionMeta = {
    enabled: true,
    autoSync: false,  // Per-collection auto-sync for chat vectorization
    // null = not set: getEffectiveScope() derives the scope from the collection ID.
    scope: null,
    displayName: null,
    description: '',
    tags: [],
    color: null,
    createdAt: null,
    // StoryArc's merged entity names, { kept name: [other names] } (eventbase/story-arc-entity-core.js).
    storyEntityMerges: {},
    // Kept names StoryArc's Entity tab keeps off its list; StoryArc still reads them (eventbase/story-arc-entities.js).
    storyEntityHiddenNames: [],
};

/**
 * Returns a deep copy of the defaults. Each collection gets its own tags and
 * StoryArc lists, so editing one collection's metadata in place never reaches
 * another collection or the defaults themselves.
 */
function createDefaultCollectionMeta() {
    return structuredClone(defaultCollectionMeta);
}

/**
 * Ensures the collections object exists in extension_settings
 */
function ensureCollectionsObject() {
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
 * `meta.scope === 'chat'` (or compare to 'character'): `meta.scope` can be
 * `null` (the default) or the legacy stored string `'unknown'`, and either
 * would silently miss every branch and write nothing.
 *
 * Resolution order:
 *   1. Stored `meta.scope` if it's a valid value ('chat' or 'character').
 *   2. Parsed from the collection ID structure (via `parseCollectionId`):
 *      - `vf_eventbase_*` / `vf_archiveevent_*` → 'chat'
 *      - `vf_lorebook_*` → 'character'
 *   3. Default 'character', the wider scope. Only reached for unparseable IDs
 *      (parser returns 'unknown' sentinel) and legacy stored values like the
 *      retired 'global'.
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

    // 3. Default: the wider scope.
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
    // No extension_settings to read: return the defaults without storing anything.
    if (!ensureCollectionsObject()) {
        const fresh = createDefaultCollectionMeta();
        fresh.scope = getEffectiveScope(collectionId, fresh);
        return fresh;
    }

    const stored = extension_settings.vectfox.collections[collectionId];
    const merged = stored
        ? { ...createDefaultCollectionMeta(), ...stored }
        : createDefaultCollectionMeta();

    // Always return a usable scope. Cheap when stored is already valid
    // (single string comparison); only parses the ID when stored is null/
    // undefined/'unknown'. This is the single place that fixes every
    // downstream consumer of meta.scope (the Collection Settings lock switch,
    // the Database Browser's rows) without each of them
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
        ...createDefaultCollectionMeta(),
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
                    ...createDefaultCollectionMeta(),
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
    // Metadata holds the chat/character locks; deleting it here is irreversible,
    // while a stale entry costs nothing and self-corrects on the next successful
    // discovery. Refuse and say so.
    if (actualCollectionIds.length === 0 && orphaned.length > 0) {
        log.warn(`VectFox: cleanupOrphanedMeta refused — discovery returned ZERO collections while ${orphaned.length} metadata entr${orphaned.length === 1 ? 'y is' : 'ies are'} stored. This looks like a backend outage, not a real mass deletion; keeping all metadata (locks) intact.`);
        return { removed: 0, orphanedIds: [], refused: true };
    }

    for (const collectionId of orphaned) {
        delete extension_settings.vectfox.collections[collectionId];
        // Its chat locks go with it, so chat_lock_index keeps no entry for them.
        _updateChatLockIndex(collectionId, null, '*');
        log.trace(`VectFox: Removed orphaned metadata for ${collectionId}`);
    }

    if (orphaned.length > 0) {
        saveSettingsDebounced();
        // warn, not lifecycle: this deletes locks with the collection.
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
        // The old single-value lockedToChatId joins the list, and is cleared below.
        const locks = chatLocksOf(meta);

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

    // The old single-value lockedToChatId joins the list, and is cleared below.
    update.lockedToChatIds = chatLocksOf(meta).filter(id => String(id) !== String(chatId));
    update.lockedToChatId = null; // Clear old format

    setCollectionMeta(collectionId, update);
    _updateChatLockIndex(collectionId, null, chatId);
    log.lifecycle(`VectFox: Removed chat ${chatId} from collection ${collectionId} locks`);
}

/**
 * Move every collection's lock on a chat to the chat's new ID, through removeCollectionLock and setCollectionLock, which
 * keep each record's list and the chat lock index in step.
 * @param {string} oldChatId
 * @param {string} newChatId
 * @returns {number} How many collections' locks moved
 */
export function moveCollectionChatLocks(oldChatId, newChatId) {
    if (!oldChatId || !newChatId || oldChatId === newChatId || !ensureCollectionsObject()) return 0;
    const keys = new Set([...Object.keys(extension_settings.vectfox.collections), ...getChatLockedCollections(oldChatId)]);
    let movedCount = 0;
    for (const key of keys) {
        if (!getCollectionLocks(key).includes(String(oldChatId))) continue;
        removeCollectionLock(key, oldChatId);
        setCollectionLock(key, newChatId);
        movedCount += 1;
    }
    return movedCount;
}

/**
 * Follow a chat's rename (SillyTavern's CHAT_RENAMED): every collection locked to it stays locked to it, under the name
 * the server saved its file as (renamedChatIds). The locks stay on the old name, with a warning, when the server cannot
 * say that name. Once locks moved, `vectfox:collections-updated` redraws the AutoSync page: SillyTavern opens the
 * renamed chat (CHAT_CHANGED) before CHAT_RENAMED, so the page was drawn while the locks were still on the old name.
 * @param {{oldFileName?: string, newFileName?: string}} renamed - CHAT_RENAMED's data
 * @returns {Promise<void>}
 */
export async function followChatRenameOfCollections(renamed) {
    let chatIds;
    try {
        chatIds = await renamedChatIds(renamed);
    } catch (error) {
        log.warn('VectFox: could not learn the name a renamed chat was saved under, so its collection locks stay on the old name:', error);
        return;
    }
    const movedCount = moveCollectionChatLocks(chatIds.oldChatId, chatIds.newChatId);
    if (!movedCount) return;
    log.lifecycle(`VectFox: moved the chat locks of ${movedCount} collection(s) to the renamed chat "${chatIds.newChatId}"`);
    globalThis.document?.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
}

/**
 * Clears all locks for a collection (removes from all chats)
 * @param {string} collectionId
 */
export function clearCollectionLock(collectionId) {
    setCollectionLock(collectionId, null);
}

/**
 * Gets the array of locked chat IDs for a collection, or empty array if not locked: `lockedToChatIds`, then the old
 * single-value `lockedToChatId` when the list lacks it (chatLocksOf)
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionLocks(collectionId) {
    return chatLocksOf(getCollectionMeta(collectionId));
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

// ============================================================================
// CLEAN UP LOCKS (the Action page's Clean up locks)
// ============================================================================

/**
 * Clean up locks, the collections' part (§1.1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * count, and with `shouldApply` remove, each chat lock on a chat that no longer exists and each character lock past
 * the character list's end, then rebuild `chat_lock_index` from the chat locks left (planCollectionLockCleanup).
 * Nothing is written when nothing changes.
 * @param {{isChatPresent: ((chatId: string) => boolean)|null, characterCount: number}} targets - isChatPresent null
 *   when the chat list could not be read whole, so no chat lock is judged; characterCount 0 judges no character lock
 * @param {{shouldApply: boolean}} options
 * @returns {{goneChatLockCount: number, goneCharacterLockCount: number, indexEntriesRemoved: number, indexEntriesAdded: number}}
 */
export function cleanUpCollectionLocks(targets, { shouldApply }) {
    const store = extension_settings.vectfox;
    const { updates, lockIndex, ...counts } = planCollectionLockCleanup(store.collections, store.chat_lock_index, targets);
    if (!shouldApply || !Object.values(counts).some(Boolean)) return counts;
    for (const [key, update] of Object.entries(updates)) setCollectionMeta(key, update);
    store.chat_lock_index = lockIndex;
    saveSettingsDebounced();
    log.lifecycle(`VectFox: Clean up locks removed ${counts.goneChatLockCount} chat and ${counts.goneCharacterLockCount} character lock(s) of collections, `
        + `and rebuilt chat_lock_index (${counts.indexEntriesRemoved} entries removed, ${counts.indexEntriesAdded} added)`);
    return counts;
}

/**
 * Single source of truth for whether a collection is active here: the Collection Settings
 * lock switch and the Database Browser's Active here pill both derive from this. Scope decides which lock list is consulted:
 *   - scope='chat'      → chat-lock list, match against current chat
 *   - scope='character' → character-lock list, match against current character
 * @param {string} collectionId
 * @param {{chatId?: string, characterId?: string|number}} context
 * @returns {boolean}
 */
export function isCollectionActiveForContext(collectionId, { chatId, characterId } = {}) {
    if (!collectionId) return false;
    const meta = getCollectionMeta(collectionId);
    // getCollectionMeta resolves scope to 'chat' or 'character' for every collection,
    // including those created before scope stamping (see getEffectiveScope).
    if (meta.scope === 'chat') {
        return Boolean(chatId && isCollectionLockedToChat(collectionId, chatId));
    }
    if (meta.scope === 'character') {
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
 * Collection Settings lock switch can write under the bare collectionId. So a
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
            ...createDefaultCollectionMeta(),
            createdAt: Date.now(),
            ...initialData,
        };
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Created metadata for new collection ${collectionId}`);
    }
}
