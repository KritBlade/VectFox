/**
 * settings-migration-chunkbase-settings.test.js — the settings only ChunkBase read, and every per-chunk metadata key,
 * leave saved settings (src/app/settings-migration-chunkbase-settings.js):
 *   - every one of its settings is deleted, whatever its value, and every other key is left, the settings EventBase,
 *     the Core page and the Database Browser still read among them
 *   - every `vectfox_chunk_meta_<hash>` key is deleted and counted apart from the named settings
 *   - a second run is a no-op
 *   - settings without them, empty settings and a non-object are safe no-ops
 *
 * The migration is a pure in-memory key removal with no SillyTavern imports, so this file needs no module mocks.
 */
import { describe, it, expect } from 'vitest';
import {
    CHUNKBASE_SETTING_KEYS,
    migration_remove_chunkbase_settings,
} from '../src/app/settings-migration-chunkbase-settings.js';

/** The settings that stay: the ones EventBase, the Core page and the Database Browser read, and others beside them. */
const keptSettings = () => ({
    keyword_scoring_method: 'hybrid',
    hybrid_keyword_level: 'balance',
    insert_batch_size: 50,
    query: 2,
    eventbase_score_threshold: 0.25,
    vectfox_collection_registry: ['qdrant:vf_eventbase_harbor_1'],
    qdrant_host: 'localhost',
});

/** What an install saved while ChunkBase ran, written out key by key so the list the migration deletes is pinned. */
const savedBeforeRetirement = () => ({
    top_k: 3,
    insert: 3,
    score_threshold: 0.25,
    keyword_extraction_level: 'balanced',
    custom_stopwords: 'harbor, ledger',
    document_glossary_injection: true,
    reformat_provider: '',
    reformat_connection_profile_id: 'profile-harbor',
    reformat_model: 'harbor/reformat-model',
    reformat_vllm_url: 'http://harbor.local:8000/v1',
    reformat_batch_chars: 12000,
    reformat_max_output_tokens: 8000,
    reformat_temperature: 0.2,
    reformat_timeout_ms: 120000,
    reformat_concurrency: 2,
    reformat_max_body_chars: 4000,
    reformat_name_fuzzy_threshold: 0.85,
    reformat_custom_prompt: 'Rewrite each section as short notes.',
    reformat_cache: { 'document-hash-1': { original: 'The harbor ledger lists every ship.' } },
    vectfox_chunk_meta_1001: { enabled: true, keywords: [{ text: 'harbor', weight: 1.5 }] },
    vectfox_chunk_meta_1002: { context: 'Ship notes', xmlTag: 'ships', summaries: ['The ledger lists ships.'] },
    ...keptSettings(),
});

describe('migration_remove_chunkbase_settings', () => {
    it('deletes every ChunkBase setting and every per-chunk metadata key, and leaves the rest', () => {
        const settings = savedBeforeRetirement();
        const result = migration_remove_chunkbase_settings(settings);

        expect(result).toEqual({ migrated: CHUNKBASE_SETTING_KEYS.length + 2, keys: [...CHUNKBASE_SETTING_KEYS], chunkMetadataCount: 2 });
        for (const key of CHUNKBASE_SETTING_KEYS) expect(settings, key).not.toHaveProperty(key);
        expect(settings).toEqual(keptSettings());
    });

    it('deletes a key saved as false, zero, empty or null too', () => {
        const settings = {
            document_glossary_injection: false, insert: 0, custom_stopwords: '', reformat_cache: null, reformat_temperature: 0,
            vectfox_chunk_meta_1003: null,
        };
        expect(migration_remove_chunkbase_settings(settings)).toEqual({
            migrated: 6,
            keys: ['insert', 'custom_stopwords', 'document_glossary_injection', 'reformat_temperature', 'reformat_cache'],
            chunkMetadataCount: 1,
        });
        expect(settings).toEqual({});
    });

    it('counts the per-chunk metadata keys apart from the named settings, and keeps every other vectfox_ key', () => {
        const settings = {
            vectfox_chunk_meta_1001: { enabled: false },
            vectfox_chunk_meta_1002: {},
            vectfox_chunk_meta_1003: { keywords: [] },
            vectfox_collection_registry: ['vf_eventbase_harbor_1'],
        };
        expect(migration_remove_chunkbase_settings(settings)).toEqual({ migrated: 3, keys: [], chunkMetadataCount: 3 });
        expect(settings).toEqual({ vectfox_collection_registry: ['vf_eventbase_harbor_1'] });
    });

    it('does nothing on a second run', () => {
        const settings = savedBeforeRetirement();
        migration_remove_chunkbase_settings(settings);
        const after = structuredClone(settings);
        expect(migration_remove_chunkbase_settings(settings)).toEqual({ migrated: 0, keys: [], chunkMetadataCount: 0 });
        expect(settings).toEqual(after);
    });

    it('is a safe no-op on settings without them, empty settings and a non-object', () => {
        const nothingToDelete = { migrated: 0, keys: [], chunkMetadataCount: 0 };
        const settings = keptSettings();
        expect(migration_remove_chunkbase_settings(settings)).toEqual(nothingToDelete);
        expect(settings).toEqual(keptSettings());
        expect(migration_remove_chunkbase_settings({})).toEqual(nothingToDelete);
        expect(migration_remove_chunkbase_settings(null)).toEqual(nothingToDelete);
        expect(migration_remove_chunkbase_settings('settings')).toEqual(nothingToDelete);
    });
});
