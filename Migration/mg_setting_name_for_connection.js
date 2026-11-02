/**
 * ============================================================================
 * VECTFOX MIGRATION — connection setting names
 * ============================================================================
 * MIGRATION FOLDER CONVENTION (read before adding files here):
 *   - Every one-time, on-load settings migration lives under `Migration/`.
 *   - FILES are prefixed `mg_` (e.g. `mg_setting_name_for_connection.js`) so the
 *     folder's migrations group together at a glance.
 *   - Each exported migration FUNCTION is prefixed `migration_` so that at the
 *     CALL SITE (in core init) it is OBVIOUS we are running a migration — e.g.
 *     `migration_setting_name_for_connection(settings)`.
 *   - Migrations MUST be idempotent: safe to run on every page load; a no-op
 *     once the data is already in the new shape.
 *   - A migration only renames/moves keys on the passed `settings` object. It
 *     makes NO network calls and NEVER throws on already-migrated data.
 *   - One concern per file; the file name describes the migration.
 *
 * THIS MIGRATION renames the convention-less connection setting keys to a
 * consistent `<consumer>_<provider>_<field>` scheme. Old key → new key, then the
 * old key is deleted. Re-running does nothing.
 *
 * ⚠️ TWO HALVES: this file only moves the stored values. Landing the rename also
 * requires updating every READ SITE (llm-config-validation.js, eventbase-extractor.js,
 * agentic-retrieval.js, providers.js, core-vector-api.js, ui-manager.js) and the
 * `defaultSettings` keys in index.js to the new names. Do NOT wire this migration
 * into init until those read sites are switched, or reads will miss the renamed keys.
 *
 * STATUS: LANDED — Phase A, 2026-06-21. Convention confirmed (chat_ / embedding_ /
 * agent_; `url_override` field vocab). Wired into init in index.js (after the
 * eventbase→chat copy), with all read sites + defaultSettings converted in the
 * same change (two-halves rule satisfied). Covered by
 * tests/mg-setting-name-for-connection.test.js. Phase B (`source` →
 * `embedding_provider`) is a SEPARATE migration — intentionally NOT in this map.
 * ============================================================================
 */

/**
 * Old → new connection setting key map.
 * Convention: `<consumer>_<provider>_<field>`, consumer ∈ { embedding, chat, agent }.
 *
 * Note on an inherent asymmetry the rename does NOT change: embedding keeps a model
 * PER provider (you can switch source and it remembers each), while chat stores ONE
 * shared model — that's a data-model difference, not a naming one. We only rename here.
 */
export const CONNECTION_SETTING_RENAMES = Object.freeze({
    // ── Embedding (per-provider URL override + model) ───────────────────────
    vllm_alt_endpoint_url:      'embedding_vllm_url',
    ollama_alt_endpoint_url:    'embedding_ollama_url',
    vllm_use_alt_endpoint:      'embedding_vllm_url_override',
    ollama_use_alt_endpoint:    'embedding_ollama_url_override',
    vllm_model:                 'embedding_vllm_model',
    ollama_model:               'embedding_ollama_model',
    openrouter_model:           'embedding_openrouter_model',

    // ── Chat LLM (shared by summarization + EventBase extraction) ───────────
    summarize_provider:         'chat_provider',
    summarize_model:            'chat_model',
    summarize_vllm_url:         'chat_vllm_url',

    // ── Agent mode ──────────────────────────────────────────────────────────
    agentic_retrieval_provider: 'agent_provider',
    agentic_retrieval_model:    'agent_model',
    agentic_retrieval_vllm_url: 'agent_vllm_url',
});

/**
 * Rename connection setting keys to the consistent scheme. Idempotent: copies each
 * old key to its new name (only if the new name isn't already set), then removes the
 * old key. Running again after completion is a no-op.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {{ migrated: number, keys: string[] }} count + which old keys were moved this run
 */
export function migration_setting_name_for_connection(settings) {
    if (!settings || typeof settings !== 'object') return { migrated: 0, keys: [] };

    const keys = [];
    for (const [oldKey, newKey] of Object.entries(CONNECTION_SETTING_RENAMES)) {
        if (!Object.prototype.hasOwnProperty.call(settings, oldKey)) continue;
        // Don't clobber a value already written under the new name.
        if (!Object.prototype.hasOwnProperty.call(settings, newKey)) {
            settings[newKey] = settings[oldKey];
            keys.push(oldKey);
        }
        delete settings[oldKey];
    }
    return { migrated: keys.length, keys };
}
