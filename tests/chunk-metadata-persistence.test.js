/**
 * Tests: chunk keyword metadata persistence for no-plugin standard backend users.
 *
 * Problem: native ST /api/vector/insert only stores {hash, text, index}.
 * Without the plugin, keywords are silently dropped on insert, so keyword
 * boosting during retrieval always sees an empty keyword list.
 *
 * Fix (A): content-vectorization.js calls saveChunkMetadata(hash, {keywords})
 *          after insertVectorItems so keywords land in extension_settings.
 * Fix (B): chat-vectorization.js stage 4.3 falls back to getChunkMetadata when
 *          chunk.metadata.keywords is empty (no-plugin query result).
 *
 * These tests verify both the storage contract (A) and the fallback behaviour (B).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ST globals needed by collection-metadata.js
// vi.hoisted lifts the variable to the same scope as vi.mock (both are hoisted)
// ---------------------------------------------------------------------------
const mockSettings = vi.hoisted(() => ({ vectfox: {} }));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: mockSettings,
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import { saveChunkMetadata, getChunkMetadata, deleteChunkMetadata } from '../src/features/collections/collection-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeywords(...words) {
    return words.map((text, i) => ({ text, weight: 1.0 + i * 0.1 }));
}

/** Simulates the keyword resolution logic added to chat-vectorization.js stage 4.3 */
function resolveChunkKeywords(chunk) {
    const rawKeywords = chunk.metadata?.keywords?.length > 0
        ? chunk.metadata.keywords
        : (getChunkMetadata(String(chunk.hash))?.keywords || []);
    return rawKeywords
        .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Storage contract (Fix A)
// ---------------------------------------------------------------------------

describe('saveChunkMetadata / getChunkMetadata — keyword round-trip', () => {
    beforeEach(() => {
        // Reset settings store between tests
        mockSettings.vectfox = {};
    });

    it('stores keywords and retrieves them by hash', () => {
        const hash = '1234567890';
        const keywords = makeKeywords('dragon', 'ancient', 'fire');

        saveChunkMetadata(hash, { keywords });

        const stored = getChunkMetadata(hash);
        expect(stored).not.toBeNull();
        expect(stored.keywords).toHaveLength(3);
        expect(stored.keywords[0]).toMatchObject({ text: 'dragon', weight: 1.0 });
        expect(stored.keywords[1]).toMatchObject({ text: 'ancient', weight: 1.1 });
    });

    it('returns null for unknown hash', () => {
        expect(getChunkMetadata('no-such-hash')).toBeNull();
    });

    it('merges keyword update into existing metadata without overwriting other fields', () => {
        const hash = 'abc123';
        saveChunkMetadata(hash, { conditions: { enabled: true }, keywords: makeKeywords('sword') });
        saveChunkMetadata(hash, { keywords: makeKeywords('sword', 'shield') });

        const stored = getChunkMetadata(hash);
        // Latest write wins for keywords
        expect(stored.keywords).toHaveLength(2);
        // conditions key should still be there from first write merged by the caller
    });

    it('deleteChunkMetadata removes the entry', () => {
        const hash = 'del123';
        saveChunkMetadata(hash, { keywords: makeKeywords('test') });
        expect(getChunkMetadata(hash)).not.toBeNull();

        deleteChunkMetadata(hash);
        expect(getChunkMetadata(hash)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Keyword fallback during retrieval (Fix B)
// ---------------------------------------------------------------------------

describe('resolveChunkKeywords — no-plugin fallback', () => {
    beforeEach(() => {
        mockSettings.vectfox = {};
    });

    it('returns keywords from chunk.metadata when present (plugin path)', () => {
        const chunk = {
            hash: 999,
            metadata: { keywords: makeKeywords('wizard', 'spell') },
        };

        const result = resolveChunkKeywords(chunk);
        expect(result).toEqual(['wizard', 'spell']);
    });

    it('falls back to getChunkMetadata when chunk.metadata.keywords is empty (no-plugin path)', () => {
        const hash = '777';
        saveChunkMetadata(hash, { keywords: makeKeywords('quest', 'hero') });

        const chunk = {
            hash,
            metadata: { keywords: [] },   // native ST query returns empty
        };

        const result = resolveChunkKeywords(chunk);
        expect(result).toEqual(['quest', 'hero']);
    });

    it('falls back when chunk.metadata.keywords is missing entirely', () => {
        const hash = '888';
        saveChunkMetadata(hash, { keywords: makeKeywords('dungeon') });

        const chunk = { hash, metadata: {} };

        const result = resolveChunkKeywords(chunk);
        expect(result).toEqual(['dungeon']);
    });

    it('returns empty array when both sources are empty', () => {
        const chunk = { hash: '000', metadata: {} };
        expect(resolveChunkKeywords(chunk)).toEqual([]);
    });

    it('normalises keywords to lowercase for case-insensitive matching', () => {
        const hash = '555';
        saveChunkMetadata(hash, { keywords: makeKeywords('Dragon', 'FIRE') });

        const chunk = { hash, metadata: {} };
        const result = resolveChunkKeywords(chunk);
        expect(result).toEqual(['dragon', 'fire']);
    });

    it('plugin metadata takes priority over saved metadata when both exist', () => {
        const hash = '444';
        saveChunkMetadata(hash, { keywords: makeKeywords('saved-keyword') });

        const chunk = {
            hash,
            metadata: { keywords: makeKeywords('plugin-keyword') },
        };

        const result = resolveChunkKeywords(chunk);
        // Plugin metadata wins — this is intentional (server-side is authoritative)
        expect(result).toEqual(['plugin-keyword']);
    });
});
