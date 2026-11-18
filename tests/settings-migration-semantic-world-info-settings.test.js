/**
 * settings-migration-semantic-world-info-settings.test.js — the deleted semantic World Info search's settings leave
 * saved settings (src/app/settings-migration-semantic-world-info-settings.js):
 *   - every one of its keys is deleted, whatever its value, and every other key is left
 *   - a second run is a no-op
 *   - settings without them, empty settings and a non-object are safe no-ops
 *
 * The migration is a pure in-memory key removal with no SillyTavern imports, so this file needs no module mocks.
 */
import { describe, it, expect } from 'vitest';
import {
    SEMANTIC_WORLD_INFO_SETTING_KEYS,
    migration_remove_semantic_world_info_settings,
} from '../src/app/settings-migration-semantic-world-info-settings.js';

const savedBeforeLoreBase = () => ({
    enabled_world_info: true,
    world_info_threshold: 0.3,
    world_info_threshold_rrf_reset_done: true,
    world_info_top_k: 3,
    world_info_query_depth: 3,
    world_info_retrieval_popup: false,
    world_info_respect_entry_disable: true,
    lorebook_xml_tag: 'VectFoxLorebook',
    // Settings that stay: LoreBase's own, and others beside them.
    lorebase_accuracy: 'high',
    lorebase_books: { 'Harbor Atlas': { selectedUids: ['0'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } },
    qdrant_host: 'localhost',
});

describe('migration_remove_semantic_world_info_settings', () => {
    it('deletes every setting of the semantic World Info search and leaves the rest', () => {
        const settings = savedBeforeLoreBase();
        const result = migration_remove_semantic_world_info_settings(settings);

        expect(result).toEqual({ migrated: SEMANTIC_WORLD_INFO_SETTING_KEYS.length, keys: [...SEMANTIC_WORLD_INFO_SETTING_KEYS] });
        for (const key of SEMANTIC_WORLD_INFO_SETTING_KEYS) expect(settings, key).not.toHaveProperty(key);
        expect(settings).toEqual({
            lorebase_accuracy: 'high',
            lorebase_books: { 'Harbor Atlas': { selectedUids: ['0'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } },
            qdrant_host: 'localhost',
        });
    });

    it('deletes a key saved as false, zero, empty or null too', () => {
        const settings = { enabled_world_info: false, world_info_threshold: 0, lorebook_xml_tag: '', world_info_top_k: null };
        expect(migration_remove_semantic_world_info_settings(settings).keys)
            .toEqual(['enabled_world_info', 'world_info_threshold', 'world_info_top_k', 'lorebook_xml_tag']);
        expect(settings).toEqual({});
    });

    it('does nothing on a second run', () => {
        const settings = savedBeforeLoreBase();
        migration_remove_semantic_world_info_settings(settings);
        const after = structuredClone(settings);
        expect(migration_remove_semantic_world_info_settings(settings)).toEqual({ migrated: 0, keys: [] });
        expect(settings).toEqual(after);
    });

    it('is a safe no-op on settings without them, empty settings and a non-object', () => {
        const settings = { qdrant_host: 'localhost' };
        expect(migration_remove_semantic_world_info_settings(settings)).toEqual({ migrated: 0, keys: [] });
        expect(settings).toEqual({ qdrant_host: 'localhost' });
        expect(migration_remove_semantic_world_info_settings({})).toEqual({ migrated: 0, keys: [] });
        expect(migration_remove_semantic_world_info_settings(null)).toEqual({ migrated: 0, keys: [] });
        expect(migration_remove_semantic_world_info_settings('settings')).toEqual({ migrated: 0, keys: [] });
    });
});
