/**
 * migration_world_info_threshold_rrf_workaround — one-time reset of
 * world_info_threshold values that were tuned against raw RRF fused scores
 * (the sub-0.05 workaround for issue #11), now that the Qdrant hybrid path
 * returns real cosine similarities.
 *
 * The contract under test:
 *   - only 0 < value < 0.05 is treated as the RRF-era workaround
 *   - exactly 0 ("gate off") keeps its meaning under both scales → untouched
 *   - RUN-ONCE: after the stamp, a deliberately re-lowered value is respected
 */

import { describe, it, expect } from 'vitest';
import {
    migration_world_info_threshold_rrf_workaround,
    RRF_WORKAROUND_THRESHOLD_CEILING,
    WORLD_INFO_THRESHOLD_DEFAULT,
} from '../Migration/mg_world_info_threshold_rrf_workaround.js';

describe('migration_world_info_threshold_rrf_workaround', () => {
    it('resets a sub-0.05 workaround value to the default and reports what it was', () => {
        const settings = { world_info_threshold: 0.01 };
        const result = migration_world_info_threshold_rrf_workaround(settings);

        expect(result).toEqual({ migrated: true, stamped: true, from: 0.01 });
        expect(settings.world_info_threshold).toBe(WORLD_INFO_THRESHOLD_DEFAULT);
        expect(settings.world_info_threshold_rrf_reset_done).toBe(true);
    });

    it('leaves a sane cosine-scale threshold untouched but still stamps', () => {
        const settings = { world_info_threshold: 0.3 };
        const result = migration_world_info_threshold_rrf_workaround(settings);

        expect(result).toEqual({ migrated: false, stamped: true });
        expect(settings.world_info_threshold).toBe(0.3);
        expect(settings.world_info_threshold_rrf_reset_done).toBe(true);
    });

    it('leaves exactly 0 alone — "gate off" means the same thing under both scales', () => {
        const settings = { world_info_threshold: 0 };
        const result = migration_world_info_threshold_rrf_workaround(settings);

        expect(result.migrated).toBe(false);
        expect(settings.world_info_threshold).toBe(0);
    });

    it('leaves an absent threshold alone (reader falls back to the default)', () => {
        const settings = {};
        const result = migration_world_info_threshold_rrf_workaround(settings);

        expect(result).toEqual({ migrated: false, stamped: true });
        expect(settings).not.toHaveProperty('world_info_threshold');
    });

    it('is run-once: a value deliberately re-lowered AFTER the stamp is respected', () => {
        const settings = { world_info_threshold: 0.01 };
        migration_world_info_threshold_rrf_workaround(settings);          // resets to default
        settings.world_info_threshold = 0.04;                             // user's post-fix choice
        const second = migration_world_info_threshold_rrf_workaround(settings);

        expect(second).toEqual({ migrated: false, stamped: false });
        expect(settings.world_info_threshold).toBe(0.04);
    });

    it('treats the ceiling itself as a deliberate value, not a workaround', () => {
        const settings = { world_info_threshold: RRF_WORKAROUND_THRESHOLD_CEILING };
        const result = migration_world_info_threshold_rrf_workaround(settings);

        expect(result.migrated).toBe(false);
        expect(settings.world_info_threshold).toBe(RRF_WORKAROUND_THRESHOLD_CEILING);
    });

    it('survives null/garbage settings without throwing', () => {
        expect(migration_world_info_threshold_rrf_workaround(null)).toEqual({ migrated: false, stamped: false });
        expect(migration_world_info_threshold_rrf_workaround(undefined)).toEqual({ migrated: false, stamped: false });
        // A corrupted non-numeric value is not "migrated" to anything.
        const settings = { world_info_threshold: 'broken' };
        expect(migration_world_info_threshold_rrf_workaround(settings).migrated).toBe(false);
    });
});
