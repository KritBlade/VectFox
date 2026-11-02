/**
 * ============================================================================
 * VECTFOX MIGRATION — embedding source key (Phase B)
 * ============================================================================
 * Renames the single highest-churn connection key: `source` → `embedding_provider`.
 *
 * Isolated in its own file (separate from Phase A's mg_setting_name_for_connection.js)
 * BECAUSE `source` is read across nearly every backend / query / UI / diagnostics
 * path. Keeping it standalone bounded its read-site sweep + tests and let Phase A
 * land and soak first. See plans/settings-naming-convention-migration.md §6a.
 *
 * ⚠️ COLLISION NOTE for maintainers: `source` is a very generic token. The
 * read-site conversion was done BY READ SITE (only `settings.source` /
 * `currentSettings.source` / `exportSettings.source`), NEVER a blind text replace —
 * the codebase is full of unrelated `.source` (collection/chunk embedding metadata,
 * request-body `source:` fields, JSDoc params). Do not "tidy" those.
 *
 * Same crash-safety contract as Phase A (plans §9, R2–R4): copy-before-delete,
 * don't-clobber-new, idempotent, no I/O. Covered by
 * tests/mg-embedding-source-key.test.js.
 * ============================================================================
 */

/**
 * Old → new key map. One entry — kept as a map for symmetry with Phase A and so
 * a future related key can be added without changing the call shape.
 */
export const EMBEDDING_SOURCE_RENAME = Object.freeze({
    source: 'embedding_provider',
});

/**
 * Rename `source` → `embedding_provider`. Idempotent: copies the old key to the
 * new name (only if the new name isn't already set), then removes the old key.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{ migrated: number, keys: string[] }} count + which old keys were moved
 */
export function migration_embedding_source_key(settings) {
    if (!settings || typeof settings !== 'object') return { migrated: 0, keys: [] };

    const keys = [];
    for (const [oldKey, newKey] of Object.entries(EMBEDDING_SOURCE_RENAME)) {
        if (!Object.prototype.hasOwnProperty.call(settings, oldKey)) continue;
        if (!Object.prototype.hasOwnProperty.call(settings, newKey)) {
            settings[newKey] = settings[oldKey];
            keys.push(oldKey);
        }
        delete settings[oldKey];
    }
    return { migrated: keys.length, keys };
}
