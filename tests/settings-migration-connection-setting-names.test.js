/**
 * settings-migration-connection-setting-names.test.js — Phase A connection-key rename migration.
 *
 * Covers the crash-safety / idempotency contract from
 * plans/settings-naming-convention-migration.md §9 (R2–R4, R8):
 *   - old-shape → new-shape (copy-before-delete)
 *   - already-new → no-op
 *   - both-present → keep the new value, drop the old (don't-clobber)
 *   - empty / non-object → safe no-op
 *   - partial → completes
 *   - interruption regression (R8): re-running on the migrated result converges
 *     to the identical state (proves "migrated in memory but never persisted →
 *     re-migrates safely" can't corrupt or double-apply).
 *
 * The migration is a PURE in-memory key rename with no ST imports, so this file
 * needs no module mocks.
 */
import { describe, it, expect } from 'vitest';
import {
    migration_setting_name_for_connection,
    CONNECTION_SETTING_RENAMES,
} from '../src/app/settings-migration-connection-setting-names.js';

describe('migration_setting_name_for_connection', () => {
    it('renames every old key to its new name and deletes the old key', () => {
        const s = {
            vllm_alt_endpoint_url: 'http://vllm:8000',
            ollama_alt_endpoint_url: 'http://ollama:11434',
            vllm_use_alt_endpoint: true,
            ollama_use_alt_endpoint: false,
            vllm_model: 'qwen',
            ollama_model: 'mxbai',
            openrouter_model: 'openai/text-embedding-3-large',
            summarize_provider: 'openrouter',
            summarize_model: 'gemini-flash',
            summarize_vllm_url: 'http://chat:8000',
            agentic_retrieval_provider: 'vllm',
            agentic_retrieval_model: 'planner',
            agentic_retrieval_vllm_url: 'http://agent:8000',
            // unrelated key — must be left untouched
            qdrant_host: 'localhost',
        };

        const r = migration_setting_name_for_connection(s);

        // new names hold the old values
        expect(s.embedding_vllm_url).toBe('http://vllm:8000');
        expect(s.embedding_ollama_url).toBe('http://ollama:11434');
        expect(s.embedding_vllm_url_override).toBe(true);
        expect(s.embedding_ollama_url_override).toBe(false);
        expect(s.embedding_vllm_model).toBe('qwen');
        expect(s.embedding_ollama_model).toBe('mxbai');
        expect(s.embedding_openrouter_model).toBe('openai/text-embedding-3-large');
        expect(s.chat_provider).toBe('openrouter');
        expect(s.chat_model).toBe('gemini-flash');
        expect(s.chat_vllm_url).toBe('http://chat:8000');
        expect(s.agent_provider).toBe('vllm');
        expect(s.agent_model).toBe('planner');
        expect(s.agent_vllm_url).toBe('http://agent:8000');

        // every old key removed
        for (const oldKey of Object.keys(CONNECTION_SETTING_RENAMES)) {
            expect(Object.prototype.hasOwnProperty.call(s, oldKey)).toBe(false);
        }

        // unrelated key untouched
        expect(s.qdrant_host).toBe('localhost');

        // report
        expect(r.migrated).toBe(13);
        expect(r.keys.sort()).toEqual(Object.keys(CONNECTION_SETTING_RENAMES).sort());
    });

    it('is a no-op on already-migrated (new-shape) settings', () => {
        const s = { chat_model: 'gemini-flash', embedding_vllm_model: 'qwen', agent_provider: 'vllm' };
        const before = { ...s };
        const r = migration_setting_name_for_connection(s);
        expect(r.migrated).toBe(0);
        expect(r.keys).toEqual([]);
        expect(s).toEqual(before);
    });

    it('keeps the NEW value when both old and new keys are present (no clobber), and drops the old', () => {
        const s = { summarize_model: 'OLD', chat_model: 'NEW' };
        const r = migration_setting_name_for_connection(s);
        expect(s.chat_model).toBe('NEW');                 // new value preserved
        expect('summarize_model' in s).toBe(false);       // old key dropped regardless
        expect(r.migrated).toBe(0);                        // nothing was *copied*
        expect(r.keys).toEqual([]);
    });

    it('completes a partial migration (some old, some already-new)', () => {
        const s = { summarize_model: 'gemini', chat_provider: 'openrouter', vllm_model: 'qwen' };
        const r = migration_setting_name_for_connection(s);
        expect(s.chat_model).toBe('gemini');
        expect(s.embedding_vllm_model).toBe('qwen');
        expect(s.chat_provider).toBe('openrouter');
        expect('summarize_model' in s).toBe(false);
        expect('vllm_model' in s).toBe(false);
        expect(r.migrated).toBe(2);
        expect(r.keys.sort()).toEqual(['summarize_model', 'vllm_model']);
    });

    it('is safe on empty / null / non-object input', () => {
        expect(migration_setting_name_for_connection({})).toEqual({ migrated: 0, keys: [] });
        expect(migration_setting_name_for_connection(null)).toEqual({ migrated: 0, keys: [] });
        expect(migration_setting_name_for_connection(undefined)).toEqual({ migrated: 0, keys: [] });
        expect(migration_setting_name_for_connection('nope')).toEqual({ migrated: 0, keys: [] });
    });

    it('R8 — re-running on the migrated result converges to the identical state (interruption-safe)', () => {
        const s = {
            summarize_vllm_url: 'http://chat:8000',
            vllm_alt_endpoint_url: 'http://vllm:8000',
            agentic_retrieval_model: 'planner',
        };
        const first = migration_setting_name_for_connection(s);
        const afterFirst = { ...s };

        // Simulate "migrated in memory but save never persisted → reload re-runs."
        const second = migration_setting_name_for_connection(s);

        expect(first.migrated).toBe(3);
        expect(second.migrated).toBe(0);     // second pass does nothing
        expect(s).toEqual(afterFirst);       // state is byte-identical
        expect(s.chat_vllm_url).toBe('http://chat:8000');
        expect(s.embedding_vllm_url).toBe('http://vllm:8000');
        expect(s.agent_model).toBe('planner');
    });

    it('preserves falsy values (empty string, false) through the rename', () => {
        const s = { summarize_model: '', vllm_use_alt_endpoint: false };
        migration_setting_name_for_connection(s);
        expect(s.chat_model).toBe('');
        expect(s.embedding_vllm_url_override).toBe(false);
        expect('summarize_model' in s).toBe(false);
        expect('vllm_use_alt_endpoint' in s).toBe(false);
    });
});
