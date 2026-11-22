/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — EventBase's pointer into each collection's record
 * ============================================================================
 * SETTINGS MIGRATION CONVENTION: see settings-migration-connection-setting-names.js.
 *
 * THIS MIGRATION copies how far EventBase has read each chat, kept until now in
 * five stores keyed by the chat's UUID, into the record of each of the chat's
 * collections (`collections[<registry key>].eventbaseProgress`), so every
 * collection carries on where it was (§2.4 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md):
 *   eventbase_vectorization_tip      → vectorizationTip
 *   eventbase_extracted_windows      → extractedWindows
 *   eventbase_unfinished_windows     → unfinishedWindows
 *   eventbase_autosync_start_marker  → autoSyncStartMarker
 *   eventbase_last_used_window_size  → windowSize
 * Each chat's entries go onto every EventBase and archive collection in the
 * registry whose chat UUID, as parseCollectionId reads it, is the entry's key,
 * and whose record has no pointer yet. The
 * window size is the number of messages in the first window on the chat's record,
 * the size Vectorize read it with; the stored size only when the record holds no
 * window, and the Vectorize dialog's Window size when there is neither. An entry
 * whose UUID no collection holds is dropped, then the five stores are deleted. An
 * empty registry leaves them for the next start, so a start that knows no
 * collection yet drops nothing. Re-running once the stores are gone does
 * nothing. Covered by tests/settings-migration-eventbase-progress.test.js.
 * ============================================================================
 */

import { parseCollectionId, parseRegistryKey } from '../shared/collection-ids.js';

/** Each store of a chat's pointer, keyed by the chat's UUID, and the part of the pointer it becomes. */
export const EVENTBASE_PROGRESS_STORES = Object.freeze({
    eventbase_vectorization_tip: 'vectorizationTip',
    eventbase_extracted_windows: 'extractedWindows',
    eventbase_unfinished_windows: 'unfinishedWindows',
    eventbase_autosync_start_marker: 'autoSyncStartMarker',
    eventbase_last_used_window_size: 'windowSize',
});

/**
 * The chat UUID an EventBase or archive collection's ID holds, a registry entry being "backend:id" or a bare ID from
 * older versions; null for any other collection.
 */
const chatUUIDOf = registryKey => parseCollectionId(parseRegistryKey(registryKey).collectionId).chatUUID;

/** Whether a record holds any part of a pointer. */
const hasPointer = record => Boolean(record?.eventbaseProgress) && Object.keys(record.eventbaseProgress).length > 0;

/**
 * The pointer one chat's entries make: each store's entry under its part, the window size as the header says.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} chatUUID
 * @returns {object} The parts the chat's entries hold
 */
function pointerOfChat(settings, chatUUID) {
    const pointer = {};
    for (const [store, part] of Object.entries(EVENTBASE_PROGRESS_STORES)) {
        const value = settings[store]?.[chatUUID];
        if (value === undefined || value === null) continue;
        pointer[part] = Array.isArray(value) ? [...value] : value;
    }
    const [firstWindow] = Array.isArray(pointer.extractedWindows) ? pointer.extractedWindows : [];
    if (typeof firstWindow === 'string' && firstWindow) {
        pointer.windowSize = firstWindow.split(',').length;
    } else if (typeof pointer.windowSize !== 'number' && Number.isFinite(settings.eventbase_window_size)) {
        pointer.windowSize = settings.eventbase_window_size;
    }
    for (const part of ['extractedWindows', 'unfinishedWindows']) {
        if (Array.isArray(pointer[part]) && pointer[part].length === 0) delete pointer[part];
    }
    return pointer;
}

/**
 * Copy each chat's pointer from the five per-chat stores onto its collections' records, then delete the stores.
 * Idempotent: once the stores are gone, a no-op.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{migrated: number, chatCount: number, droppedChatCount: number, storeCount: number}} how many collections
 *   got a pointer, from how many chats' entries, how many chats' entries no collection held, and how many stores were
 *   deleted
 */
export function migration_eventbase_progress_into_collections(settings) {
    const none = { migrated: 0, chatCount: 0, droppedChatCount: 0, storeCount: 0 };
    if (!settings || typeof settings !== 'object') return none;
    const stores = Object.keys(EVENTBASE_PROGRESS_STORES).filter(store => Object.prototype.hasOwnProperty.call(settings, store));
    if (!stores.length) return none;

    const registry = Array.isArray(settings.vectfox_collection_registry) ? settings.vectfox_collection_registry : [];
    if (!registry.length) return none;

    const chatUUIDs = new Set();
    for (const store of stores) {
        const entries = settings[store];
        if (entries && typeof entries === 'object') for (const chatUUID of Object.keys(entries)) chatUUIDs.add(chatUUID);
    }

    const collectionsByChat = new Map();
    for (const registryKey of registry) {
        if (typeof registryKey !== 'string') continue;
        const chatUUID = chatUUIDOf(registryKey);
        if (!chatUUID || !chatUUIDs.has(chatUUID)) continue;
        collectionsByChat.set(chatUUID, [...(collectionsByChat.get(chatUUID) ?? []), registryKey]);
    }

    if (!settings.collections || typeof settings.collections !== 'object') settings.collections = {};
    let migrated = 0;
    for (const [chatUUID, registryKeys] of collectionsByChat) {
        const pointer = pointerOfChat(settings, chatUUID);
        if (!Object.keys(pointer).length) continue;
        for (const registryKey of registryKeys) {
            const record = settings.collections[registryKey];
            if (hasPointer(record)) continue;
            settings.collections[registryKey] = { ...(record ?? {}), eventbaseProgress: structuredClone(pointer) };
            migrated += 1;
        }
    }

    for (const store of stores) delete settings[store];
    return { migrated, chatCount: collectionsByChat.size, droppedChatCount: chatUUIDs.size - collectionsByChat.size, storeCount: stores.length };
}
