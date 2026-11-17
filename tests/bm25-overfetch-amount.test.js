/**
 * How many results a BM25 re-rank asks the vector search for (bm25-scorer.js getOverfetchAmount): twice the wanted
 * count, at least 10 and at most 100.
 */

import { describe, it, expect, vi } from 'vitest';

// bm25-scorer.js → src/sillytavern/log.js → ../../../../extensions.js (a SillyTavern host path that doesn't resolve
// under vitest). Mock it.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

import { getOverfetchAmount } from '../src/features/keyword-search/bm25-scorer.js';

describe('getOverfetchAmount', () => {
    it('should return 2x the requested amount', () => {
        expect(getOverfetchAmount(10)).toBe(20);
        expect(getOverfetchAmount(25)).toBe(50);
    });

    it('should have minimum of 10', () => {
        expect(getOverfetchAmount(1)).toBe(10);
        expect(getOverfetchAmount(3)).toBe(10);
    });

    it('should have maximum of 100', () => {
        expect(getOverfetchAmount(60)).toBe(100);
        expect(getOverfetchAmount(100)).toBe(100);
    });

    it('should handle edge cases', () => {
        expect(getOverfetchAmount(0)).toBe(10); // min 10
        expect(getOverfetchAmount(5)).toBe(10); // 2*5=10
        expect(getOverfetchAmount(50)).toBe(100); // 2*50=100 (max)
    });
});
