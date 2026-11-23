/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — forced setting values
 * ============================================================================
 * Follows the convention in settings-migration-connection-setting-names.js: a one-time, on-load migration with no
 * network calls, safe on every page load.
 *
 * A forced value (a "push") overwrites one setting on an install's next start-up, even over a value the user saved.
 * It is for the rare case where keeping a saved value would break something; a better default reaches new installs
 * through `defaultSettings` alone. Each push has an ID: once applied, its ID is recorded in the setting
 * `forced_setting_values_applied` and the push never runs again, so the user can change the setting afterwards.
 * Forcing the same setting again takes a new ID.
 *
 * A new install starts with every ID already recorded (`defaultSettings` in src/index.js lists them all), so it never
 * replays a push over a newer default. An existing install has no record until its first push, so every push listed
 * applies once: init runs this before it merges the defaults in. Covered by
 * tests/settings-migration-forced-values.test.js.
 * ============================================================================
 */

/**
 * The pushes, oldest first. An ID is never reused. A push stays listed while any install may not have started since
 * it was added; removing one only stops it reaching those installs.
 * @type {ReadonlyArray<Readonly<{id: string, key: string, value: unknown}>>}
 */
export const FORCED_SETTING_VALUES = Object.freeze([]);

/** The IDs a new install records as applied: every push listed. */
export function forcedSettingValueIds(pushes = FORCED_SETTING_VALUES) {
    return pushes.map(push => push.id);
}

/**
 * Applies each push whose ID the settings have not recorded, then records it.
 * @param {object} settings - extension_settings.vectfox
 * @param {ReadonlyArray<{id: string, key: string, value: unknown}>} [pushes] - FORCED_SETTING_VALUES by default
 * @returns {{ migrated: number, ids: string[], keys: string[] }} the pushes applied now, and the keys among them
 *   whose saved value they changed
 */
export function migration_apply_forced_setting_values(settings, pushes = FORCED_SETTING_VALUES) {
    if (!settings || typeof settings !== 'object') return { migrated: 0, ids: [], keys: [] };

    const recorded = Array.isArray(settings.forced_setting_values_applied) ? settings.forced_setting_values_applied : [];
    const done = new Set(recorded);
    const ids = [];
    const keys = [];
    for (const push of pushes) {
        if (done.has(push.id)) continue;
        // Settings are saved as JSON, so two values are the same when their JSON is.
        if (JSON.stringify(settings[push.key]) !== JSON.stringify(push.value)) {
            keys.push(push.key);
        }
        settings[push.key] = structuredClone(push.value);
        done.add(push.id);
        ids.push(push.id);
    }
    if (ids.length) {
        settings.forced_setting_values_applied = [...recorded, ...ids];
    }
    return { migrated: ids.length, ids, keys };
}
