/**
 * settings-migration-embedding-provider-key.test.js — Phase B `source` → `embedding_provider` rename.
 *
 * Same crash-safety / idempotency contract as Phase A
 * (plans/settings-naming-convention-migration.md §9, R2–R4, R8):
 *   - old → new (copy-before-delete)
 *   - already-new → no-op
 *   - both-present → keep new, drop old (don't-clobber)
 *   - empty / non-object → safe
 *   - R8 interruption: re-run converges identically
 *
 * Pure in-memory rename, no ST imports → no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import {
    migration_embedding_source_key,
    EMBEDDING_SOURCE_RENAME,
} from '../src/app/settings-migration-embedding-provider-key.js';

describe('migration_embedding_source_key', () => {
    it('renames source → embedding_provider, preserving the value', () => {
        const s = { source: 'openrouter', vector_backend: 'qdrant' };
        const r = migration_embedding_source_key(s);
        expect(s.embedding_provider).toBe('openrouter');
        expect('source' in s).toBe(false);
        expect(s.vector_backend).toBe('qdrant'); // unrelated key untouched
        expect(r).toEqual({ migrated: 1, keys: ['source'] });
    });

    it('is a no-op when already migrated', () => {
        const s = { embedding_provider: 'transformers' };
        const before = { ...s };
        const r = migration_embedding_source_key(s);
        expect(r).toEqual({ migrated: 0, keys: [] });
        expect(s).toEqual(before);
    });

    it('keeps the NEW value when both keys present (no clobber), drops old', () => {
        const s = { source: 'OLD', embedding_provider: 'NEW' };
        const r = migration_embedding_source_key(s);
        expect(s.embedding_provider).toBe('NEW');
        expect('source' in s).toBe(false);
        expect(r.migrated).toBe(0);
    });

    it('is safe on empty / null / non-object input', () => {
        expect(migration_embedding_source_key({})).toEqual({ migrated: 0, keys: [] });
        expect(migration_embedding_source_key(null)).toEqual({ migrated: 0, keys: [] });
        expect(migration_embedding_source_key(undefined)).toEqual({ migrated: 0, keys: [] });
        expect(migration_embedding_source_key('nope')).toEqual({ migrated: 0, keys: [] });
    });

    it('R8 — re-running on the migrated result converges identically', () => {
        const s = { source: 'vllm' };
        const first = migration_embedding_source_key(s);
        const afterFirst = { ...s };
        const second = migration_embedding_source_key(s);
        expect(first.migrated).toBe(1);
        expect(second.migrated).toBe(0);
        expect(s).toEqual(afterFirst);
        expect(s.embedding_provider).toBe('vllm');
    });

    it('the rename map is exactly { source: embedding_provider }', () => {
        expect(EMBEDDING_SOURCE_RENAME).toEqual({ source: 'embedding_provider' });
    });

    it('preserves a falsy/empty source value through the rename', () => {
        const s = { source: '' };
        migration_embedding_source_key(s);
        expect(s.embedding_provider).toBe('');
        expect('source' in s).toBe(false);
    });
});
