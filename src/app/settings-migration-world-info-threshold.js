/**
 * ============================================================================
 * VECTFOX MIGRATION — reset world_info_threshold values tuned against raw RRF
 * ============================================================================
 * (Folder conventions: see Migration/mg_setting_name_for_connection.js.)
 *
 * WHY: until 2026-07-31 the Qdrant native hybrid path returned raw RRF fused
 * scores (top hit ≈ 1/(rrfK+1) ≈ 0.016) while `world_info_threshold` — default
 * 0.3, designed for 0-1 cosine similarities — was applied to them directly. At
 * defaults, semantic lorebook activation on Qdrant therefore returned ZERO
 * entries, always (GitHub issue #11). The only way users could make it work was
 * to lower the threshold to ≈0.0x, the correct value for the wrong scale.
 *
 * backends/qdrant.js::hybridQuery now attaches real cosine scores, so a saved
 * 0.0x threshold flips from "the workaround that makes Qdrant work" to "gate
 * open — inject everything", silently polluting every prompt. This migration
 * resets such values to the 0.3 default once. A threshold this low was also
 * already misconfigured on Vectra (cosine there all along, so 0.0x admitted
 * near-everything) — the reset repairs that too.
 *
 * RUN-ONCE, not value-idempotent, on purpose: the stamp below guarantees a user
 * who deliberately re-lowers the threshold AFTER the migration keeps their
 * choice — we repair the value once at upgrade, we do not police it forever.
 *
 * Exactly 0 is NOT migrated: "gate off" means the same thing under both scales,
 * so a saved 0 keeps its behavior and needs no repair.
 * ============================================================================
 */

/**
 * Threshold values strictly below this can only have been chosen against the
 * raw RRF scale (single-leg hits spanned ≈0.012-0.016, dual-leg ≈0.033). No one
 * tuning against cosine similarities picks a gate under 0.05.
 */
export const RRF_WORKAROUND_THRESHOLD_CEILING = 0.05;

/** Must match `world_info_threshold` in index.js defaultSettings. */
export const WORLD_INFO_THRESHOLD_DEFAULT = 0.3;

/**
 * Reset a world_info_threshold that was tuned against raw RRF scores. Run-once:
 * stamps `world_info_threshold_rrf_reset_done` on first run (whether or not a
 * reset happened) and never touches the value again.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{ migrated: boolean, stamped: boolean, from?: number }}
 *   migrated: the threshold was reset this run (toast + persist).
 *   stamped: the run-once flag was newly written this run (persist).
 */
export function migration_world_info_threshold_rrf_workaround(settings) {
    if (!settings || typeof settings !== 'object') return { migrated: false, stamped: false };
    if (settings.world_info_threshold_rrf_reset_done === true) return { migrated: false, stamped: false };

    settings.world_info_threshold_rrf_reset_done = true;

    const value = settings.world_info_threshold;
    const isRrfWorkaround = typeof value === 'number'
        && value > 0
        && value < RRF_WORKAROUND_THRESHOLD_CEILING;
    if (!isRrfWorkaround) return { migrated: false, stamped: true };

    settings.world_info_threshold = WORLD_INFO_THRESHOLD_DEFAULT;
    return { migrated: true, stamped: true, from: value };
}
