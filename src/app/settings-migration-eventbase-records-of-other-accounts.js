/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — EventBase's records on other accounts' collections
 * ============================================================================
 * SETTINGS MIGRATION CONVENTION: see settings-migration-connection-setting-names.js.
 *
 * THIS MIGRATION deletes EventBase's record (`collections[<registry key>].eventbaseProgress`) from every EventBase and
 * archive collection that is not this account's, as isAccountCollection says (isCollectionOfAccount). Discovery
 * registers other accounts' collections too, and settings-migration-eventbase-progress.js once copied a chat's old
 * per-chat record onto every collection with that chat's UUID, so a chat imported from another account put this
 * account's record on that account's collections: a record whose windows that collection's events do not show, which
 * the window record cleanup cannot trim and nothing of this account reads (InternalProject/Vectfox/plans/
 * eventbase-window-record.md, D5). The rest of each collection's metadata stays. Re-running deletes nothing more.
 * Covered by tests/settings-migration-eventbase-records-of-other-accounts.test.js.
 * ============================================================================
 */

import { parseCollectionId, parseRegistryKey } from '../shared/collection-ids.js';

/** Whether a registry entry is an EventBase or archive collection, the collections that hold a chat's UUID. */
const isEventBaseCollection = registryKey => Boolean(parseCollectionId(parseRegistryKey(registryKey).collectionId).chatUUID);

/**
 * Delete EventBase's record from each EventBase and archive collection that is not this account's.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {(registryKey: string) => boolean} isAccountCollection - Whether a registry entry is this account's collection
 * @returns {{migrated: number}} How many records were deleted
 */
export function migration_drop_eventbase_records_of_other_accounts(settings, isAccountCollection) {
    if (!settings?.collections || typeof settings.collections !== 'object') return { migrated: 0 };
    let migrated = 0;
    for (const [registryKey, record] of Object.entries(settings.collections)) {
        if (!record?.eventbaseProgress || !isEventBaseCollection(registryKey) || isAccountCollection(registryKey)) continue;
        delete record.eventbaseProgress;
        migrated += 1;
    }
    return { migrated };
}
