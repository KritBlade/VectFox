/**
 * Sparse Vector Encoder Tests
 * Verifies determinism, collision rate, and tokenizer reuse.
 */

import { describe, it, expect, vi } from 'vitest';

// sparse-vector-encoder.js → bm25-scorer.js → src/sillytavern/log.js → ../../../../extensions.js
// (a SillyTavern host path that doesn't resolve under vitest). Mock it.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them.
vi.mock('../../../../../script.js', () => ({}));

import {
    encodeSparseVector,
    encodeSparseQuery,
    hashToken,
} from '../src/features/vector-backend/sparse-vector-encoder.js';

describe('hashToken', () => {
    it('returns an unsigned 32-bit integer', () => {
        const h = hashToken('hello');
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 ** 32);
    });

    it('is deterministic', () => {
        expect(hashToken('abc')).toBe(hashToken('abc'));
        expect(hashToken('勇者')).toBe(hashToken('勇者'));
    });

    it('produces different hashes for different inputs', () => {
        expect(hashToken('aragorn')).not.toBe(hashToken('legolas'));
        expect(hashToken('a')).not.toBe(hashToken('b'));
    });

    it('handles empty string', () => {
        expect(hashToken('')).toBe(0x811c9dc5);
    });
});

describe('encodeSparseVector', () => {
    it('returns empty sparse vector for empty/null input', () => {
        expect(encodeSparseVector('')).toEqual({ indices: [], values: [] });
        expect(encodeSparseVector(null)).toEqual({ indices: [], values: [] });
        expect(encodeSparseVector(undefined)).toEqual({ indices: [], values: [] });
    });

    it('is deterministic for the same input', () => {
        const a = encodeSparseVector('Aragorn fought the orcs at Helms Deep');
        const b = encodeSparseVector('Aragorn fought the orcs at Helms Deep');
        expect(a.indices).toEqual(b.indices);
        expect(a.values).toEqual(b.values);
    });

    it('emits indices and values arrays of equal length', () => {
        const sv = encodeSparseVector('Aragorn fought orcs');
        expect(sv.indices.length).toBe(sv.values.length);
        expect(sv.indices.length).toBeGreaterThan(0);
    });

    it('accumulates term frequency for repeated tokens', () => {
        const sv = encodeSparseVector('orc orc orc');
        const orcIdx = hashToken('orc');
        const i = sv.indices.indexOf(orcIdx);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(sv.values[i]).toBe(3);
    });

    it('all indices are unique within a single output', () => {
        const sv = encodeSparseVector(
            'Aragorn fought orcs at Helms Deep while Legolas shot arrows from the wall'
        );
        const set = new Set(sv.indices);
        expect(set.size).toBe(sv.indices.length);
    });

    it('all indices are valid uint32', () => {
        const sv = encodeSparseVector('lorem ipsum dolor sit amet');
        for (const idx of sv.indices) {
            expect(Number.isInteger(idx)).toBe(true);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(2 ** 32);
        }
    });

    it('handles CJK text (Chinese)', () => {
        const sv = encodeSparseVector('勇者 与 法师 一起 战斗');
        expect(sv.indices.length).toBeGreaterThan(0);
        expect(sv.indices.length).toBe(sv.values.length);
    });

    it('handles mixed Latin + CJK text', () => {
        const sv = encodeSparseVector('Aragorn 勇者 fought the 半兽人');
        expect(sv.indices.length).toBeGreaterThan(0);
    });

    it('produces no values of zero', () => {
        const sv = encodeSparseVector('the quick brown fox jumps');
        for (const v of sv.values) {
            expect(v).toBeGreaterThan(0);
        }
    });
});

describe('encodeSparseQuery', () => {
    it('matches encodeSparseVector for identical input', () => {
        const text = 'find events about Aragorn at Helms Deep';
        const a = encodeSparseVector(text);
        const b = encodeSparseQuery(text);
        expect(b.indices).toEqual(a.indices);
        expect(b.values).toEqual(a.values);
    });
});

describe('hash collision rate', () => {
    it('keeps collision rate < 0.5% on a realistic 5k-token sample', () => {
        // Build a 5k unique-token sample from generated strings.
        const seen = new Map();
        const tokens = [];
        let i = 0;
        while (tokens.length < 5000) {
            const t = `tok_${i}_${(i * 2654435761) % 1000003}`;
            if (!seen.has(t)) {
                seen.set(t, hashToken(t));
                tokens.push(t);
            }
            i++;
        }
        const uniqueHashes = new Set(seen.values());
        const collisions = tokens.length - uniqueHashes.size;
        const rate = collisions / tokens.length;
        expect(rate).toBeLessThan(0.005);
    });
});
