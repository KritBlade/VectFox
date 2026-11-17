/**
 * The Database Browser's search results when its query is searched in pieces
 * (src/features/database-browser/search-results-core.js): per collection, each hash once at its best score, closest
 * first, cut to topK, as one search returns them; a collection shows an error only when every piece failed there.
 */
import { describe, expect, it } from 'vitest';
import { mergeSearchPieceResults } from '../src/features/database-browser/search-results-core.js';

const hits = (...pairs) => ({ hashes: pairs.map(([hash]) => hash), metadata: pairs.map(([hash, score]) => ({ text: `chunk ${hash}`, score })) });

describe('mergeSearchPieceResults', () => {
    it('returns one search\'s results as they are', () => {
        const only = { harbor: hits([1, 0.9]) };
        expect(mergeSearchPieceResults([only], 5)).toBe(only);
    });

    it('keeps each hash once at its best score, closest first, cut to topK', () => {
        const merged = mergeSearchPieceResults([
            { harbor: hits([1, 0.6], [2, 0.5]) },
            { harbor: hits([1, 0.9], [3, 0.7], [4, 0.2]) },
        ], 3);
        expect(merged.harbor.hashes).toEqual([1, 3, 2]);
        expect(merged.harbor.metadata.map(meta => meta.score)).toEqual([0.9, 0.7, 0.5]);
    });

    it('keeps a collection\'s hits when one piece failed there, and its error only when every piece failed', () => {
        const merged = mergeSearchPieceResults([
            { harbor: { hashes: [], metadata: [], error: 'timeout' }, tides: { hashes: [], metadata: [], error: 'timeout' } },
            { harbor: hits([1, 0.8]), tides: { hashes: [], metadata: [], error: 'gone' } },
        ], 5);
        expect(merged.harbor).toEqual(hits([1, 0.8]));
        expect(merged.tides.error).toBe('timeout');
    });
});
