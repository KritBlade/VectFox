/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — semantic World Info settings removed
 * ============================================================================
 * SETTINGS MIGRATION CONVENTION: see settings-migration-connection-setting-names.js.
 *
 * THIS MIGRATION deletes the settings of the vectorized lorebook search that
 * LoreBase replaced (B7 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): the WorldInfo page's Semantic
 * activation switch and Matching controls, the XML tag of the lorebook block it
 * sent, and the stamp of that search's one-time threshold reset. Nothing reads them,
 * and SillyTavern saves every key of `extension_settings.vectfox`, so they would
 * stay in settings.json. Each key is deleted where present; re-running does
 * nothing. SillyTavern's own World Info settings live elsewhere and are not
 * touched. Covered by tests/settings-migration-semantic-world-info-settings.test.js.
 * ============================================================================
 */

/** The settings of the deleted semantic World Info search. */
export const SEMANTIC_WORLD_INFO_SETTING_KEYS = Object.freeze([
    'enabled_world_info',
    'world_info_threshold',
    'world_info_threshold_rrf_reset_done',
    'world_info_top_k',
    'world_info_query_depth',
    'world_info_retrieval_popup',
    'world_info_respect_entry_disable',
    'lorebook_xml_tag',
]);

/**
 * Delete the semantic World Info settings. Idempotent: running again after they are
 * gone is a no-op.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{ migrated: number, keys: string[] }} count + which keys were deleted this run
 */
export function migration_remove_semantic_world_info_settings(settings) {
    if (!settings || typeof settings !== 'object') return { migrated: 0, keys: [] };

    const keys = SEMANTIC_WORLD_INFO_SETTING_KEYS.filter(key => Object.prototype.hasOwnProperty.call(settings, key));
    for (const key of keys) delete settings[key];
    return { migrated: keys.length, keys };
}
