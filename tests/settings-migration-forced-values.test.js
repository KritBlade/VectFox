/**
 * settings-migration-forced-values.test.js — a forced setting value applies once per push, over a saved value, and
 * never on a new install. Pure in-memory, no SillyTavern imports.
 */
import { describe, it, expect } from 'vitest';
import {
    FORCED_SETTING_VALUES,
    forcedSettingValueIds,
    migration_apply_forced_setting_values,
} from '../src/app/settings-migration-forced-values.js';

const pushes = Object.freeze([
    Object.freeze({ id: 'budget-4000', key: 'lore_budget', value: 4000 }),
    Object.freeze({ id: 'mode-fast', key: 'mode', value: 'fast' }),
]);

describe('migration_apply_forced_setting_values', () => {
    it('overwrites a value the user saved and records the push', () => {
        const settings = { lore_budget: 3000, mode: 'fast', other: true, forced_setting_values_applied: [] };
        const result = migration_apply_forced_setting_values(settings, pushes);
        expect(settings.lore_budget).toBe(4000);
        expect(settings.other).toBe(true);
        expect(settings.forced_setting_values_applied).toEqual(['budget-4000', 'mode-fast']);
        expect(result).toEqual({ migrated: 2, ids: ['budget-4000', 'mode-fast'], keys: ['lore_budget'] });
    });

    it('runs a push only once, so the value the user sets after it stays', () => {
        const settings = { lore_budget: 3000 };
        migration_apply_forced_setting_values(settings, pushes);
        settings.lore_budget = 6000;
        const again = migration_apply_forced_setting_values(settings, pushes);
        expect(settings.lore_budget).toBe(6000);
        expect(again).toEqual({ migrated: 0, ids: [], keys: [] });
    });

    it('applies every push on an install with no record, and a later push of the same key wins', () => {
        const settings = { lore_budget: 3000 };
        const later = [...pushes, { id: 'budget-5000', key: 'lore_budget', value: 5000 }];
        migration_apply_forced_setting_values(settings, later);
        expect(settings.lore_budget).toBe(5000);
        expect(settings.forced_setting_values_applied).toEqual(['budget-4000', 'mode-fast', 'budget-5000']);
    });

    it('applies only the pushes added since the last start', () => {
        const settings = { lore_budget: 3000, mode: 'high', forced_setting_values_applied: ['budget-4000'] };
        const result = migration_apply_forced_setting_values(settings, pushes);
        expect(settings.lore_budget).toBe(3000);
        expect(settings.mode).toBe('fast');
        expect(settings.forced_setting_values_applied).toEqual(['budget-4000', 'mode-fast']);
        expect(result.ids).toEqual(['mode-fast']);
    });

    it('applies nothing on a new install, which records every push as applied', () => {
        const settings = { lore_budget: 4500, forced_setting_values_applied: forcedSettingValueIds(pushes) };
        expect(migration_apply_forced_setting_values(settings, pushes)).toEqual({ migrated: 0, ids: [], keys: [] });
        expect(settings.lore_budget).toBe(4500);
    });

    it('writes a copy of an object value, never the listed one', () => {
        const listed = Object.freeze({ id: 'weights', key: 'weights', value: { a: 1 } });
        const settings = {};
        const result = migration_apply_forced_setting_values(settings, [listed]);
        settings.weights.a = 2;
        expect(listed.value.a).toBe(1);
        expect(result.keys).toEqual(['weights']);
        expect(migration_apply_forced_setting_values({ weights: { a: 1 } }, [listed]).keys).toEqual([]);
    });

    it('is safe on empty or non-object settings', () => {
        expect(migration_apply_forced_setting_values(null, pushes)).toEqual({ migrated: 0, ids: [], keys: [] });
        expect(migration_apply_forced_setting_values(undefined, pushes)).toEqual({ migrated: 0, ids: [], keys: [] });
        expect(migration_apply_forced_setting_values({}, [])).toEqual({ migrated: 0, ids: [], keys: [] });
    });
});

describe('FORCED_SETTING_VALUES', () => {
    it('gives each push its own ID and a setting key', () => {
        const ids = FORCED_SETTING_VALUES.map(push => push.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const push of FORCED_SETTING_VALUES) {
            expect(typeof push.id === 'string' && push.id.length > 0).toBe(true);
            expect(typeof push.key === 'string' && push.key.length > 0).toBe(true);
            expect('value' in push).toBe(true);
        }
        expect(forcedSettingValueIds()).toEqual(ids);
    });
});
