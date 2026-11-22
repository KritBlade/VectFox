/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — retired fields of each collection's metadata
 * ============================================================================
 * SETTINGS MIGRATION CONVENTION: see settings-migration-connection-setting-names.js.
 *
 * THIS MIGRATION deletes, from each entry of `extension_settings.vectfox.collections`,
 * the fields nothing reads once ChunkBase retired (B9 and B29 of InternalProject/
 * Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): the activation
 * triggers and Advanced Conditions, the prompt context only chunk retrieval read
 * (context, XML tag, position and depth), and fields no code had read for a long
 * time (`alwaysActive`, `temporalDecay`, `lastUsed`, `queryCount`). Every other
 * field stays: locks, pause, auto-sync, scope, names, tags and StoryArc's lists.
 * Each field is deleted where present; re-running does nothing. Covered by
 * tests/settings-migration-collection-retired-fields.test.js.
 * ============================================================================
 */

/** The retired fields of a collection's metadata. */
export const RETIRED_COLLECTION_FIELDS = Object.freeze([
    'triggers',
    'triggerMatchMode',
    'triggerCaseSensitive',
    'triggerScanDepth',
    'conditions',
    'context',
    'xmlTag',
    'position',
    'depth',
    'alwaysActive',
    'temporalDecay',
    'lastUsed',
    'queryCount',
]);

/**
 * Delete the retired fields from every collection's metadata. Idempotent: running again after they are gone is a
 * no-op.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{migrated: number, collectionCount: number}} how many fields were deleted this run, from how many collections
 */
export function migration_remove_retired_collection_fields(settings) {
    const collections = settings?.collections;
    if (!collections || typeof collections !== 'object') return { migrated: 0, collectionCount: 0 };

    let migrated = 0;
    let collectionCount = 0;
    for (const meta of Object.values(collections)) {
        if (!meta || typeof meta !== 'object') continue;
        const fields = RETIRED_COLLECTION_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(meta, field));
        for (const field of fields) delete meta[field];
        if (fields.length) {
            migrated += fields.length;
            collectionCount += 1;
        }
    }
    return { migrated, collectionCount };
}
