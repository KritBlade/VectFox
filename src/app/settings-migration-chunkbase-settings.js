/**
 * ============================================================================
 * VECTFOX SETTINGS MIGRATION — ChunkBase's settings removed
 * ============================================================================
 * SETTINGS MIGRATION CONVENTION: see settings-migration-connection-setting-names.js.
 *
 * THIS MIGRATION deletes the settings only ChunkBase read, which retired with
 * Vectorize Content's Character, Document, Web page, Wiki and YouTube sources
 * (B29 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-
 * index.md): its retrieval's results per collection and similarity threshold,
 * keyword extraction at ingest and its custom stopwords, the acronym glossary,
 * Auto-Reformat's settings and the source texts it kept, and every per-chunk
 * metadata key (`vectfox_chunk_meta_<hash>`: keywords, links, prompt fields and
 * Summaries' lists), which one user's settings held 9.45 MiB of. Nothing reads
 * them, and SillyTavern saves every key of `extension_settings.vectfox`, so they
 * would stay in settings.json. Each key is deleted where present; re-running
 * does nothing. Covered by tests/settings-migration-chunkbase-settings.test.js.
 * ============================================================================
 */

/** The settings only ChunkBase read. */
export const CHUNKBASE_SETTING_KEYS = Object.freeze([
    'top_k',
    'insert',
    'score_threshold',
    'keyword_extraction_level',
    'custom_stopwords',
    'document_glossary_injection',
    'reformat_provider',
    'reformat_connection_profile_id',
    'reformat_model',
    'reformat_vllm_url',
    'reformat_batch_chars',
    'reformat_max_output_tokens',
    'reformat_temperature',
    'reformat_timeout_ms',
    'reformat_concurrency',
    'reformat_max_body_chars',
    'reformat_name_fuzzy_threshold',
    'reformat_custom_prompt',
    'reformat_cache',
]);

/** Each chunk's metadata was saved under this prefix and its hash. */
const CHUNK_METADATA_KEY_PREFIX = 'vectfox_chunk_meta_';

/**
 * Delete ChunkBase's settings and every per-chunk metadata key. Idempotent: running again after they are gone is a
 * no-op.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{migrated: number, keys: string[], chunkMetadataCount: number}} how many keys were deleted this run, the
 *     named settings among them, and how many were per-chunk metadata
 */
export function migration_remove_chunkbase_settings(settings) {
    if (!settings || typeof settings !== 'object') return { migrated: 0, keys: [], chunkMetadataCount: 0 };

    const keys = CHUNKBASE_SETTING_KEYS.filter(key => Object.prototype.hasOwnProperty.call(settings, key));
    const chunkMetadataKeys = Object.keys(settings).filter(key => key.startsWith(CHUNK_METADATA_KEY_PREFIX));
    for (const key of [...keys, ...chunkMetadataKeys]) delete settings[key];
    return { migrated: keys.length + chunkMetadataKeys.length, keys, chunkMetadataCount: chunkMetadataKeys.length };
}
