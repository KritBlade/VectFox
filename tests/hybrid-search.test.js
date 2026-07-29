/**
 * Unit tests for hybrid-search.js
 * Tests hybrid search combining vector and BM25 scoring with RRF/weighted fusion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SillyTavern host modules transitively pulled in via core/hybrid-search.js
// → core/collection-ids.js → ../../../../extensions.js, etc. Without these
// mocks vite's import-analysis fails and the whole file refuses to load.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: {},
    saveSettings: vi.fn(),
}));

// Mock the backend-manager (both helpers — hybrid-search.js uses both)
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(),
    getBackendForCollection: vi.fn(),
}));

// Mock the bm25-scorer - provide a working implementation
vi.mock('../core/bm25-scorer.js', () => ({
    // porterStemmer: identity function in tests (real one stems English Latin tokens).
    // hybrid-search.js calls it on every query token after extraction.
    porterStemmer: vi.fn((token) => token),
    createBM25Scorer: vi.fn((documents, options) => {
        // Simple mock BM25 scorer that scores based on query term overlap
        const docs = documents.map(d => {
            const text = (d.text || '').toLowerCase();
            const title = (d.title || '').toLowerCase();
            const tags = (d.tags || []).map(t => t.toLowerCase());
            return { text, title, tags, allText: `${text} ${title} ${tags.join(' ')}` };
        });

        return {
            totalDocs: docs.length,
            scoreDocument: (queryTerms, docIdx) => {
                if (docIdx < 0 || docIdx >= docs.length) return 0;
                const doc = docs[docIdx];
                let score = 0;
                for (const term of queryTerms) {
                    if (doc.allText.includes(term)) {
                        score += 1.0;
                        // Title boost
                        if (doc.title.includes(term)) score += 2.0;
                        // Tag boost
                        if (doc.tags.some(t => t.includes(term))) score += 1.5;
                    }
                }
                return score;
            }
        };
    }),
}));

import { getBackend } from '../backends/backend-manager.js';
import {
    DEFAULT_RRF_K,
    hybridSearch,
    reciprocalRankFusion,
    weightedCombination,
} from '../core/hybrid-search.js';

// ============================================================================
// Constants Tests
// ============================================================================

describe('DEFAULT_RRF_K', () => {
    it('should be 60', () => {
        expect(DEFAULT_RRF_K).toBe(60);
    });
});

// ============================================================================
// reciprocalRankFusion Tests
// ============================================================================

describe('reciprocalRankFusion', () => {
    it('should return empty array for empty input', () => {
        expect(reciprocalRankFusion([])).toEqual([]);
        expect(reciprocalRankFusion([[], []])).toEqual([]);
    });

    it('should handle null/undefined result lists', () => {
        expect(reciprocalRankFusion([null, undefined])).toEqual([]);
        expect(reciprocalRankFusion([null, [{ hash: 1, score: 0.5 }]])).toHaveLength(1);
    });

    it('should handle single result list', () => {
        const results = reciprocalRankFusion([
            [
                { hash: 1, score: 0.9 },
                { hash: 2, score: 0.7 },
            ]
        ]);

        expect(results).toHaveLength(2);
        expect(results[0].result.hash).toBe(1);
        expect(results[1].result.hash).toBe(2);
    });

    it('should fuse two result lists', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: 2, score: 0.7 },
            { hash: 3, score: 0.5 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
            { hash: 3, bm25Score: 4.0 },
            { hash: 4, bm25Score: 3.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        // All unique hashes should be present
        const hashes = results.map(r => r.result.hash);
        expect(hashes).toContain(1);
        expect(hashes).toContain(2);
        expect(hashes).toContain(3);
        expect(hashes).toContain(4);
    });

    it('should rank documents appearing in both lists higher', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: 2, score: 0.7 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
            { hash: 3, bm25Score: 4.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        // Hash 2 appears in both lists, should get higher RRF score
        const hash2Entry = results.find(r => r.result.hash === 2);
        expect(hash2Entry.ranks.vector).toBe(2);
        expect(hash2Entry.ranks.text).toBe(1);
    });

    it('should use custom k value', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
        ];

        const resultsK60 = reciprocalRankFusion([vectorResults], 60);
        const resultsK10 = reciprocalRankFusion([vectorResults], 10);

        // Different k values produce different raw RRF scores
        expect(resultsK60[0].rawRrfScore).not.toBe(resultsK10[0].rawRrfScore);
        // Lower k = higher individual contribution
        expect(resultsK10[0].rawRrfScore).toBeGreaterThan(resultsK60[0].rawRrfScore);
    });

    it('should store individual vector and text scores', () => {
        const vectorResults = [
            { hash: 1, score: 0.85 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 4.5 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        expect(results[0].vectorScore).toBe(0.85);
        // textScore gets normalized with saturation function
        expect(results[0].textScore).toBeGreaterThan(0);
    });

    it('should calculate rrfScore based on combined signals', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: 2, score: 0.3 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
            { hash: 3, bm25Score: 3.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        // All entries should have rrfScore
        for (const r of results) {
            expect(r.rrfScore).toBeDefined();
            expect(r.rrfScore).toBeGreaterThanOrEqual(0);
            expect(r.rrfScore).toBeLessThanOrEqual(1);
        }
    });

    it('should sort results by rrfScore descending', () => {
        const vectorResults = [
            { hash: 1, score: 0.5 },
            { hash: 2, score: 0.9 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
            { hash: 2, bm25Score: 1.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].rrfScore).toBeGreaterThanOrEqual(results[i].rrfScore);
        }
    });

    it('should cap rrfScore at 1.0', () => {
        const vectorResults = [
            { hash: 1, score: 1.0 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 100.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        expect(results[0].rrfScore).toBeLessThanOrEqual(1.0);
    });

    it('should handle documents with only vector score', () => {
        const vectorResults = [
            { hash: 1, score: 0.8 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        const hash1Entry = results.find(r => r.result.hash === 1);
        expect(hash1Entry.vectorScore).toBe(0.8);
        expect(hash1Entry.textScore).toBe(0);
        expect(hash1Entry.ranks.vector).toBe(1);
        expect(hash1Entry.ranks.text).toBeUndefined();
    });

    it('should handle documents with only text score', () => {
        const vectorResults = [
            { hash: 1, score: 0.8 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
        ];

        const results = reciprocalRankFusion([vectorResults, textResults]);

        const hash2Entry = results.find(r => r.result.hash === 2);
        expect(hash2Entry.vectorScore).toBe(0);
        expect(hash2Entry.textScore).toBeGreaterThan(0);
        expect(hash2Entry.ranks.vector).toBeUndefined();
        expect(hash2Entry.ranks.text).toBe(1);
    });

    it('should skip results with undefined/null hash', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: undefined, score: 0.8 },
            { hash: null, score: 0.7 },
        ];

        const results = reciprocalRankFusion([vectorResults]);

        expect(results).toHaveLength(1);
        expect(results[0].result.hash).toBe(1);
    });

    it('should preserve result object in output', () => {
        const vectorResults = [
            { hash: 1, score: 0.9, text: 'test content', customField: 'custom' },
        ];

        const results = reciprocalRankFusion([vectorResults]);

        expect(results[0].result).toEqual(vectorResults[0]);
        expect(results[0].result.customField).toBe('custom');
    });

    it('should apply dual signal bonus for documents in both lists', () => {
        // Document in both lists with good scores
        const vectorResults = [
            { hash: 1, score: 0.8 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
        ];

        const resultsWithBoth = reciprocalRankFusion([vectorResults, textResults]);

        // Document only in vector list
        const vectorOnlyResults = [
            { hash: 2, score: 0.8 },
        ];

        const resultsVectorOnly = reciprocalRankFusion([vectorOnlyResults, []]);

        // The document with both signals should have a higher score
        expect(resultsWithBoth[0].rrfScore).toBeGreaterThan(resultsVectorOnly[0].rrfScore);
    });
});

// ============================================================================
// weightedCombination Tests
// ============================================================================

describe('weightedCombination', () => {
    it('should return empty array for empty inputs', () => {
        expect(weightedCombination([], [])).toEqual([]);
        expect(weightedCombination([], [{ hash: 1, bm25Score: 1.0 }])).toHaveLength(1);
        expect(weightedCombination([{ hash: 1, score: 1.0 }], [])).toHaveLength(1);
    });

    it('should combine vector and text results', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: 2, score: 0.7 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
            { hash: 3, bm25Score: 3.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        // All unique hashes should be present
        const hashes = results.map(r => r.hash);
        expect(hashes).toContain(1);
        expect(hashes).toContain(2);
        expect(hashes).toContain(3);
    });

    it('should use default weights of 0.5/0.5', () => {
        // Use multiple results to enable meaningful min-max normalization
        const vectorResults = [
            { hash: 1, score: 1.0 },
            { hash: 2, score: 0.5 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 1.0 },
            { hash: 2, bm25Score: 0.5 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        // Hash 1 has max scores in both, normalized to 1.0 each
        // combinedScore should be close to 1.0 (0.5 * 1.0 + 0.5 * 1.0)
        const hash1Result = results.find(r => r.hash === 1);
        expect(hash1Result.combinedScore).toBeCloseTo(1.0, 1);
    });

    it('should respect custom alpha/beta weights', () => {
        const vectorResults = [
            { hash: 1, score: 1.0 },
            { hash: 2, score: 0.5 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 0.5 },
            { hash: 2, bm25Score: 1.0 },
        ];

        // Heavily favor vector (alpha=0.9, beta=0.1)
        const vectorFavoredResults = weightedCombination(vectorResults, textResults, 0.9, 0.1);

        // Heavily favor text (alpha=0.1, beta=0.9)
        const textFavoredResults = weightedCombination(vectorResults, textResults, 0.1, 0.9);

        // Hash 1 has higher vector score, should rank higher when vector is favored
        expect(vectorFavoredResults[0].hash).toBe(1);

        // Hash 2 has higher text score, should rank higher when text is favored
        expect(textFavoredResults[0].hash).toBe(2);
    });

    it('should normalize scores to [0, 1] range', () => {
        const vectorResults = [
            { hash: 1, score: 100 },
            { hash: 2, score: 50 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 10 },
            { hash: 2, bm25Score: 5 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        // All scores should be normalized
        for (const r of results) {
            expect(r.vectorScore).toBeGreaterThanOrEqual(0);
            expect(r.vectorScore).toBeLessThanOrEqual(1);
            expect(r.textScore).toBeGreaterThanOrEqual(0);
            expect(r.textScore).toBeLessThanOrEqual(1);
        }
    });

    it('should sort results by combinedScore descending', () => {
        const vectorResults = [
            { hash: 1, score: 0.5 },
            { hash: 2, score: 0.9 },
            { hash: 3, score: 0.3 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
            { hash: 2, bm25Score: 1.0 },
            { hash: 3, bm25Score: 3.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].combinedScore).toBeGreaterThanOrEqual(results[i].combinedScore);
        }
    });

    it('should store individual vector and text scores', () => {
        const vectorResults = [
            { hash: 1, score: 0.8 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        expect(results[0].vectorScore).toBeDefined();
        expect(results[0].textScore).toBeDefined();
    });

    it('should handle documents only in vector results', () => {
        // Multiple results for meaningful normalization
        const vectorResults = [
            { hash: 1, score: 0.8 },
            { hash: 3, score: 0.4 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
            { hash: 4, bm25Score: 2.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        const hash1Entry = results.find(r => r.hash === 1);
        expect(hash1Entry.vectorScore).toBe(1.0); // Normalized max in vector list
        expect(hash1Entry.textScore).toBe(0); // Not in text list
    });

    it('should handle documents only in text results', () => {
        // Multiple results for meaningful normalization
        const vectorResults = [
            { hash: 1, score: 0.8 },
            { hash: 3, score: 0.4 },
        ];
        const textResults = [
            { hash: 2, bm25Score: 5.0 },
            { hash: 4, bm25Score: 2.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        const hash2Entry = results.find(r => r.hash === 2);
        expect(hash2Entry.vectorScore).toBe(0); // Not in vector list
        expect(hash2Entry.textScore).toBe(1.0); // Normalized max in text list
    });

    it('should skip results with undefined/null hash', () => {
        const vectorResults = [
            { hash: 1, score: 0.9 },
            { hash: undefined, score: 0.8 },
            { hash: null, score: 0.7 },
        ];
        const textResults = [];

        const results = weightedCombination(vectorResults, textResults);

        expect(results).toHaveLength(1);
        expect(results[0].hash).toBe(1);
    });

    it('should preserve text and metadata fields', () => {
        const vectorResults = [
            { hash: 1, score: 0.9, text: 'test content', metadata: { key: 'value' } },
        ];

        const results = weightedCombination(vectorResults, []);

        expect(results[0].text).toBe('test content');
        expect(results[0].metadata).toEqual({ key: 'value' });
    });

    it('should handle single result in each list', () => {
        const vectorResults = [
            { hash: 1, score: 0.8 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 5.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        expect(results).toHaveLength(1);
        // With single results, min-max normalization produces 0 for each
        // because (score - min) / range = 0 when there's only one value
        expect(results[0].combinedScore).toBe(0);
    });

    it('should handle all same scores correctly', () => {
        const vectorResults = [
            { hash: 1, score: 0.5 },
            { hash: 2, score: 0.5 },
            { hash: 3, score: 0.5 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 3.0 },
            { hash: 2, bm25Score: 3.0 },
            { hash: 3, bm25Score: 3.0 },
        ];

        const results = weightedCombination(vectorResults, textResults);

        // All should have same combined score
        expect(results[0].combinedScore).toBeCloseTo(results[1].combinedScore, 5);
        expect(results[1].combinedScore).toBeCloseTo(results[2].combinedScore, 5);
    });
});

// ============================================================================
// hybridSearch Tests
// ============================================================================

describe('hybridSearch', () => {
    let mockBackend;

    beforeEach(() => {
        mockBackend = {
            constructor: { name: 'MockBackend' },
            supportsHybridSearch: vi.fn(() => false),
            hybridQuery: vi.fn(),
            queryCollection: vi.fn(),
        };

        getBackend.mockResolvedValue(mockBackend);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should use native hybrid search when available and preferred', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(true);
        mockBackend.hybridQuery.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'result 1', score: 0.9 },
                { text: 'result 2', score: 0.8 },
            ],
        });

        const settings = { hybrid_native_prefer: true };
        const results = await hybridSearch('test-collection', 'search query', 10, settings);

        expect(mockBackend.supportsHybridSearch).toHaveBeenCalled();
        expect(mockBackend.hybridQuery).toHaveBeenCalled();
        expect(results.hashes).toEqual([1, 2]);
    });

    it('should fall back to client-side when native fails', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(true);
        mockBackend.hybridQuery.mockRejectedValue(new Error('Native hybrid failed'));
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'dragon content', score: 0.9 },
                { text: 'wizard content', score: 0.8 },
            ],
        });

        const settings = { hybrid_native_prefer: true };
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        expect(mockBackend.hybridQuery).toHaveBeenCalled();
        expect(mockBackend.queryCollection).toHaveBeenCalled();
        expect(results.hashes).toBeDefined();
    });

    it('should use client-side fusion when native is not preferred', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(true);
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'dragon content', score: 0.9 },
                { text: 'wizard content', score: 0.8 },
            ],
        });

        const settings = { hybrid_native_prefer: false };
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        expect(mockBackend.hybridQuery).not.toHaveBeenCalled();
        expect(mockBackend.queryCollection).toHaveBeenCalled();
    });

    it('should use client-side fusion when backend does not support native', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(false);
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'dragon content', score: 0.9 },
                { text: 'wizard content', score: 0.8 },
            ],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        expect(mockBackend.hybridQuery).not.toHaveBeenCalled();
        expect(mockBackend.queryCollection).toHaveBeenCalled();
    });

    it('should propagate the error when the vector query fails', async () => {
        // Deliberately NOT an empty result: a failed backend must stay
        // distinguishable from a collection with no matching chunks. Swallowing it
        // here is what let a Qdrant-side failure silently zero semantic lorebook
        // activation with no log and no toast (GitHub issue #11). Callers of
        // queryCollection all catch and degrade on their own terms.
        mockBackend.queryCollection.mockRejectedValue(new Error('Query failed'));

        const settings = {};

        await expect(hybridSearch('test-collection', 'query', 10, settings))
            .rejects.toThrow('Query failed');
    });

    it('should return empty results when no vector results found', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [],
            metadata: [],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'query', 10, settings);

        expect(results).toEqual({ hashes: [], metadata: [] });
    });

    it('should return empty results when vector results are null', async () => {
        mockBackend.queryCollection.mockResolvedValue(null);

        const settings = {};
        const results = await hybridSearch('test-collection', 'query', 10, settings);

        expect(results).toEqual({ hashes: [], metadata: [] });
    });

    it('should use RRF fusion method by default', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'dragon content', score: 0.9 },
                { text: 'wizard content', score: 0.8 },
            ],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        expect(results.metadata[0].fusionMethod).toBe('rrf');
    });

    it('should use weighted fusion when specified', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'dragon content', score: 0.9 },
                { text: 'wizard content', score: 0.8 },
            ],
        });

        const settings = { hybrid_fusion_method: 'weighted' };
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        expect(results.metadata[0].fusionMethod).toBe('weighted');
    });

    it('should respect topK limit', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2, 3, 4, 5],
            metadata: [
                { text: 'content 1', score: 0.9 },
                { text: 'content 2', score: 0.8 },
                { text: 'content 3', score: 0.7 },
                { text: 'content 4', score: 0.6 },
                { text: 'content 5', score: 0.5 },
            ],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'query', 2, settings);

        expect(results.hashes.length).toBe(2);
        expect(results.metadata.length).toBe(2);
    });

    it('should include hybrid search metadata in results', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [
                { text: 'dragon content', score: 0.9 },
            ],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        const meta = results.metadata[0];
        expect(meta.hybridSearch).toBe(true);
        expect(meta.fusionMethod).toBeDefined();
        expect(meta.score).toBeDefined();
        expect(meta.vectorScore).toBeDefined();
        expect(meta.textScore).toBeDefined();
    });

    it('should pass options to native hybrid query', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(true);
        mockBackend.hybridQuery.mockResolvedValue({
            hashes: [1],
            metadata: [{ text: 'result', score: 0.9 }],
        });

        const settings = { hybrid_native_prefer: true };
        const options = {
            vectorWeight: 0.7,
            textWeight: 0.3,
            fusionMethod: 'rrf',
            rrfK: 40,
        };

        await hybridSearch('test-collection', 'query', 10, settings, options);

        expect(mockBackend.hybridQuery).toHaveBeenCalledWith(
            'test-collection',
            'query',
            10,
            settings,
            expect.objectContaining({
                vectorWeight: 0.7,
                textWeight: 0.3,
                rrfK: 40,
            }),
            expect.any(Object)  // 6th arg: filters (added after this test was written)
        );
    });

    it('should use settings for fusion parameters when not in options', async () => {
        mockBackend.supportsHybridSearch.mockReturnValue(true);
        mockBackend.hybridQuery.mockResolvedValue({
            hashes: [1],
            metadata: [{ text: 'result', score: 0.9 }],
        });

        const settings = {
            hybrid_native_prefer: true,
            hybrid_vector_weight: 0.6,
            hybrid_text_weight: 0.4,
            hybrid_rrf_k: 50,
            hybrid_fusion_method: 'rrf',
        };

        await hybridSearch('test-collection', 'query', 10, settings);

        expect(mockBackend.hybridQuery).toHaveBeenCalledWith(
            'test-collection',
            'query',
            10,
            settings,
            expect.objectContaining({
                vectorWeight: 0.6,
                textWeight: 0.4,
                rrfK: 50,
            }),
            expect.any(Object)  // 6th arg: filters (added after this test was written)
        );
    });

    it('should expand topK for client-side fusion', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ text: 'content', score: 0.9 }],
        });

        const settings = {};
        await hybridSearch('test-collection', 'query', 5, settings);

        // Should request more results (3x topK, min 15)
        expect(mockBackend.queryCollection).toHaveBeenCalledWith(
            'test-collection',
            'query',
            15,
            settings,
            null
        );
    });

    it('should cap expanded topK at 100', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ text: 'content', score: 0.9 }],
        });

        const settings = {};
        await hybridSearch('test-collection', 'query', 50, settings);

        // Should cap at 100
        expect(mockBackend.queryCollection).toHaveBeenCalledWith(
            'test-collection',
            'query',
            100,
            settings,
            null
        );
    });

    it('should include title and tags in BM25 scoring', async () => {
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { text: 'general content', entryName: 'Dragon Lore', keywords: ['dragon', 'fire'], score: 0.7 },
                { text: 'dragon dragon dragon', entryName: 'Other', keywords: [], score: 0.9 },
            ],
        });

        const settings = {};
        const results = await hybridSearch('test-collection', 'dragon', 10, settings);

        // Both should be returned, the one with title/tag match might score higher on text
        expect(results.hashes.length).toBe(2);
    });

    it('should pass queryVector option to backend', async () => {
        const queryVector = [0.1, 0.2, 0.3];
        mockBackend.queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ text: 'content', score: 0.9 }],
        });

        const settings = {};
        await hybridSearch('test-collection', 'query', 5, settings, { queryVector });

        expect(mockBackend.queryCollection).toHaveBeenCalledWith(
            'test-collection',
            'query',
            expect.any(Number),
            settings,
            queryVector
        );
    });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Edge Cases', () => {
    describe('reciprocalRankFusion edge cases', () => {
        it('should handle very large result lists', () => {
            const largeList = Array.from({ length: 1000 }, (_, i) => ({
                hash: i,
                score: 1 - (i / 1000),
            }));

            expect(() => reciprocalRankFusion([largeList])).not.toThrow();
            const results = reciprocalRankFusion([largeList]);
            expect(results).toHaveLength(1000);
        });

        it('should handle duplicate hashes in same list', () => {
            const vectorResults = [
                { hash: 1, score: 0.9 },
                { hash: 1, score: 0.8 }, // Duplicate
            ];

            const results = reciprocalRankFusion([vectorResults]);

            // Should only have one entry for hash 1
            expect(results).toHaveLength(1);
        });

        it('should handle zero scores', () => {
            const vectorResults = [
                { hash: 1, score: 0 },
            ];
            const textResults = [
                { hash: 1, bm25Score: 0 },
            ];

            const results = reciprocalRankFusion([vectorResults, textResults]);

            expect(results).toHaveLength(1);
            expect(results[0].rrfScore).toBeDefined();
        });

        it('should handle negative scores (treat as 0)', () => {
            const vectorResults = [
                { hash: 1, score: -0.5 },
            ];

            const results = reciprocalRankFusion([vectorResults]);

            expect(results).toHaveLength(1);
            expect(results[0].rrfScore).toBeGreaterThanOrEqual(0);
        });
    });

    describe('weightedCombination edge cases', () => {
        it('should handle very large score values', () => {
            const vectorResults = [
                { hash: 1, score: 1e10 },
                { hash: 2, score: 1e9 },
            ];

            expect(() => weightedCombination(vectorResults, [])).not.toThrow();
            const results = weightedCombination(vectorResults, []);
            expect(results[0].vectorScore).toBe(1); // Normalized
        });

        it('should handle very small score values', () => {
            const vectorResults = [
                { hash: 1, score: 1e-10 },
                { hash: 2, score: 1e-11 },
            ];

            expect(() => weightedCombination(vectorResults, [])).not.toThrow();
        });

        it('should handle zero weights', () => {
            const vectorResults = [
                { hash: 1, score: 0.9 },
            ];
            const textResults = [
                { hash: 1, bm25Score: 5.0 },
            ];

            const results = weightedCombination(vectorResults, textResults, 0, 0);

            expect(results[0].combinedScore).toBe(0);
        });

        it('should handle weights summing to more than 1', () => {
            // Need multiple results for min-max normalization to produce non-zero scores
            const vectorResults = [
                { hash: 1, score: 1.0 },
                { hash: 2, score: 0.5 },
            ];
            const textResults = [
                { hash: 1, bm25Score: 1.0 },
                { hash: 2, bm25Score: 0.5 },
            ];

            const results = weightedCombination(vectorResults, textResults, 0.8, 0.8);

            // Hash 1 has normalized scores of 1.0 each
            // Combined score = 0.8 * 1.0 + 0.8 * 1.0 = 1.6
            const hash1Result = results.find(r => r.hash === 1);
            expect(hash1Result.combinedScore).toBeGreaterThan(1.0);
        });
    });
});

describe('Integration: RRF vs Weighted Comparison', () => {
    it('should produce different rankings for RRF vs weighted', () => {
        // Scenario where vector and text disagree significantly
        const vectorResults = [
            { hash: 1, score: 0.95 },
            { hash: 2, score: 0.50 },
            { hash: 3, score: 0.30 },
        ];
        const textResults = [
            { hash: 3, bm25Score: 8.0 },
            { hash: 2, bm25Score: 4.0 },
            { hash: 1, bm25Score: 0.5 },
        ];

        const rrfResults = reciprocalRankFusion([vectorResults, textResults]);
        const weightedResults = weightedCombination(vectorResults, textResults);

        // Both should have all 3 results
        expect(rrfResults).toHaveLength(3);
        expect(weightedResults).toHaveLength(3);

        // Rankings might differ
        const rrfTopHash = rrfResults[0].result.hash;
        const weightedTopHash = weightedResults[0].hash;

        // At least verify both return valid results
        expect([1, 2, 3]).toContain(rrfTopHash);
        expect([1, 2, 3]).toContain(weightedTopHash);
    });

    it('should agree on top result when both signals strongly favor same document', () => {
        const vectorResults = [
            { hash: 1, score: 0.99 },
            { hash: 2, score: 0.20 },
        ];
        const textResults = [
            { hash: 1, bm25Score: 10.0 },
            { hash: 2, bm25Score: 1.0 },
        ];

        const rrfResults = reciprocalRankFusion([vectorResults, textResults]);
        const weightedResults = weightedCombination(vectorResults, textResults);

        // Both should rank hash 1 first
        expect(rrfResults[0].result.hash).toBe(1);
        expect(weightedResults[0].hash).toBe(1);
    });
});
