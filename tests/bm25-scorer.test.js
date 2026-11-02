/**
 * BM25+ Scorer Tests
 * Tests for the BM25+ keyword scoring algorithm including:
 * - Porter Stemmer
 * - Tokenization
 * - Term Frequency calculation
 * - IDF calculation
 * - BM25Scorer class
 * - Score application
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// bm25-scorer.js imports src/sillytavern/log.js, which imports ../../../../extensions.js
// (a SillyTavern host path that doesn't resolve under vitest). Mock it so the
// module graph loads. See tests/hybrid-search.test.js for the same pattern.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

import {
    BM25Scorer,
    createBM25Scorer,
    applyBM25Scoring,
    porterStemmer,
    tokenize,
} from '../core/bm25-scorer.js';

// =============================================================================
// PORTER STEMMER TESTS
// =============================================================================

describe('Porter Stemmer', () => {
    describe('basic stemming', () => {
        it('should return short words unchanged', () => {
            expect(porterStemmer('a')).toBe('a');
            expect(porterStemmer('go')).toBe('go');
            expect(porterStemmer('')).toBe('');
        });

        it('should handle null/undefined input', () => {
            expect(porterStemmer(null)).toBe(null);
            expect(porterStemmer(undefined)).toBe(undefined);
        });

        it('should lowercase input', () => {
            expect(porterStemmer('RUNNING')).toBe(porterStemmer('running'));
        });
    });

    describe('plural removal (Step 1a)', () => {
        it('should remove -sses suffix', () => {
            expect(porterStemmer('caresses')).toBe('caress');
            expect(porterStemmer('stresses')).toBe('stress');
        });

        it('should handle -ies suffix', () => {
            expect(porterStemmer('ponies')).toBe('poni');
            expect(porterStemmer('ties')).toBe('ti');
        });

        it('should keep -ss unchanged', () => {
            expect(porterStemmer('caress')).toBe('caress');
            expect(porterStemmer('stress')).toBe('stress');
        });

        it('should remove trailing -s', () => {
            expect(porterStemmer('cats')).toBe('cat');
            expect(porterStemmer('dogs')).toBe('dog');
        });
    });

    describe('-ed and -ing handling (Step 1b)', () => {
        it('should handle -eed suffix', () => {
            expect(porterStemmer('agreed')).toBe('agree');
            expect(porterStemmer('freed')).toBe('free');
        });

        it('should handle -ed suffix with vowel in stem', () => {
            expect(porterStemmer('plastered')).toBe('plaster');
            expect(porterStemmer('bled')).toBe('bled'); // No vowel before -ed
        });

        it('should handle -ing suffix with vowel in stem', () => {
            expect(porterStemmer('motoring')).toBe('motor');
            expect(porterStemmer('sing')).toBe('sing'); // No vowel before -ing
        });

        it('should add -e after at/bl/iz', () => {
            expect(porterStemmer('conflated')).toBe('conflate');
            expect(porterStemmer('troubling')).toBe('trouble');
        });
    });

    describe('suffix replacements (Step 2)', () => {
        it('should replace -ational with -ate', () => {
            expect(porterStemmer('relational')).toBe('relate');
        });

        it('should replace -ization with -ize', () => {
            expect(porterStemmer('organization')).toBe('organize');
        });

        it('should replace -iveness with -ive', () => {
            expect(porterStemmer('effectiveness')).toBe('effective');
        });
    });

    describe('caching', () => {
        it('should return same result for repeated calls', () => {
            const word = 'adventuring';
            const result1 = porterStemmer(word);
            const result2 = porterStemmer(word);
            expect(result1).toBe(result2);
        });
    });
});

// =============================================================================
// TOKENIZER TESTS
// =============================================================================

describe('Tokenize', () => {
    describe('basic tokenization', () => {
        it('should split text into tokens', () => {
            // Note: avoid stopwords here — 'world' is in the English stopword set
            // (core/stop-words.js) and would be filtered out by tokenize(). Use
            // content words so the split itself is what's under test.
            const tokens = tokenize('hello dragon test');
            expect(tokens).toContain('hello');
            expect(tokens).toContain('dragon');
            expect(tokens).toContain('test');
        });

        it('should handle empty input', () => {
            expect(tokenize('')).toEqual([]);
            expect(tokenize(null)).toEqual([]);
            expect(tokenize(undefined)).toEqual([]);
        });

        it('should remove punctuation', () => {
            const tokens = tokenize('hello, world! test?');
            expect(tokens.some(t => t.includes(','))).toBe(false);
            expect(tokens.some(t => t.includes('!'))).toBe(false);
        });

        it('should lowercase tokens', () => {
            const tokens = tokenize('HELLO World TeSt');
            tokens.forEach(t => {
                expect(t).toBe(t.toLowerCase());
            });
        });
    });

    describe('stop word removal', () => {
        it('should remove stop words by default', () => {
            const tokens = tokenize('the quick brown fox jumps over the lazy dog');
            expect(tokens).not.toContain('the');
            expect(tokens).not.toContain('over');
            expect(tokens).toContain('quick');
            expect(tokens).toContain('brown');
            expect(tokens).toContain('fox');
        });

        it('should keep stop words when disabled', () => {
            const tokens = tokenize('the quick fox', { removeStopWords: false });
            expect(tokens).toContain('the');
        });
    });

    describe('stemming', () => {
        it('should apply stemming by default', () => {
            const tokens = tokenize('running jumps quickly');
            // Stemmed versions
            expect(tokens.some(t => t !== 'running' && t !== 'jumps' && t !== 'quickly')).toBe(true);
        });

        it('should skip stemming when disabled', () => {
            const tokens = tokenize('running jumping', { stem: false, removeStopWords: false });
            expect(tokens).toContain('running');
            expect(tokens).toContain('jumping');
        });
    });

    describe('minimum length filtering', () => {
        it('should filter tokens below minimum length', () => {
            const tokens = tokenize('a ab abc abcd', { removeStopWords: false, stem: false });
            expect(tokens).not.toContain('a');
            expect(tokens).toContain('ab');
            expect(tokens).toContain('abc');
        });

        it('should respect custom minimum length', () => {
            const tokens = tokenize('ab abc abcd', { minLength: 3, removeStopWords: false, stem: false });
            expect(tokens).not.toContain('ab');
            expect(tokens).toContain('abc');
        });
    });

    describe('deduplication', () => {
        it('should remove duplicate tokens', () => {
            const tokens = tokenize('test test test hello hello', { stem: false, removeStopWords: false });
            expect(tokens.filter(t => t === 'test').length).toBe(1);
            expect(tokens.filter(t => t === 'hello').length).toBe(1);
        });
    });
});

// =============================================================================
// STOP WORDS TESTS
// =============================================================================

// =============================================================================
// BM25 SCORER CLASS TESTS
// =============================================================================

describe('BM25Scorer', () => {
    let scorer;

    const testDocuments = [
        { text: 'The quick brown fox jumps over the lazy dog' },
        { text: 'A fast brown fox leaps across the sleeping hound' },
        { text: 'The lazy cat sleeps all day long' },
        { text: 'Dogs and cats are popular pets worldwide' },
        { text: 'The fox is a cunning and quick animal' }
    ];

    beforeEach(() => {
        scorer = new BM25Scorer();
        scorer.indexDocuments(testDocuments);
    });

    describe('constructor', () => {
        it('should use default parameters', () => {
            const defaultScorer = new BM25Scorer();
            expect(defaultScorer.k1).toBe(1.5);
            expect(defaultScorer.b).toBe(0.75);
            expect(defaultScorer.delta).toBe(0.5);
            expect(defaultScorer.sublinearTf).toBe(true);
            expect(defaultScorer.coverageBonus).toBe(true);
        });

        it('should accept custom parameters', () => {
            const customScorer = new BM25Scorer({
                k1: 2.0,
                b: 0.5,
                delta: 1.0,
                sublinearTf: false,
                coverageBonus: false
            });
            expect(customScorer.k1).toBe(2.0);
            expect(customScorer.b).toBe(0.5);
            expect(customScorer.delta).toBe(1.0);
            expect(customScorer.sublinearTf).toBe(false);
            expect(customScorer.coverageBonus).toBe(false);
        });
    });

    describe('indexDocuments', () => {
        it('should set correct document count', () => {
            expect(scorer.totalDocs).toBe(5);
        });

        it('should calculate average document length', () => {
            expect(scorer.avgDocLength).toBeGreaterThan(0);
        });

        it('should create term frequency maps for each document', () => {
            expect(scorer.documentTermFreqs.length).toBe(5);
        });

        it('should calculate IDF for terms', () => {
            expect(scorer.idf.size).toBeGreaterThan(0);
        });

        it('should handle empty document array', () => {
            const emptyScorer = new BM25Scorer();
            emptyScorer.indexDocuments([]);
            expect(emptyScorer.totalDocs).toBe(0);
            expect(emptyScorer.avgDocLength).toBe(0);
        });
    });

    describe('scoreDocument', () => {
        it('should return higher score for matching documents', () => {
            const queryTokens = tokenize('quick brown fox');
            const score0 = scorer.scoreDocument(queryTokens, 0); // Contains quick, brown, fox
            const score2 = scorer.scoreDocument(queryTokens, 2); // Contains none of these
            expect(score0).toBeGreaterThan(score2);
        });

        it('should return 0 for empty query', () => {
            expect(scorer.scoreDocument([], 0)).toBe(0);
        });

        it('should return 0 for invalid document index', () => {
            const queryTokens = tokenize('fox');
            expect(scorer.scoreDocument(queryTokens, -1)).toBe(0);
            expect(scorer.scoreDocument(queryTokens, 100)).toBe(0);
        });

        it('should apply coverage bonus when all terms match', () => {
            const bonusScorer = new BM25Scorer({ coverageBonus: true });
            const noBonusScorer = new BM25Scorer({ coverageBonus: false });

            bonusScorer.indexDocuments(testDocuments);
            noBonusScorer.indexDocuments(testDocuments);

            const queryTokens = tokenize('quick fox');
            const bonusScore = bonusScorer.scoreDocument(queryTokens, 0);
            const noBonusScore = noBonusScorer.scoreDocument(queryTokens, 0);

            // With coverage bonus should be higher
            expect(bonusScore).toBeGreaterThanOrEqual(noBonusScore);
        });
    });

    describe('search', () => {
        it('should return ranked results', () => {
            const results = scorer.search('quick brown fox', 3);
            expect(results.length).toBeLessThanOrEqual(3);
            expect(results[0].score).toBeGreaterThanOrEqual(results[1]?.score || 0);
        });

        it('should return empty array for empty query', () => {
            const results = scorer.search('');
            expect(results).toEqual([]);
        });

        it('should include document reference in results', () => {
            const results = scorer.search('fox', 1);
            expect(results[0].document).toBeDefined();
            expect(results[0].document.text).toBeDefined();
        });

        it('should include index in results', () => {
            const results = scorer.search('fox', 1);
            expect(typeof results[0].index).toBe('number');
        });

        it('should respect topK parameter', () => {
            const results = scorer.search('fox', 2);
            expect(results.length).toBeLessThanOrEqual(2);
        });
    });

    describe('scoreDocumentSubset', () => {
        it('should score only specified indices', () => {
            const scores = scorer.scoreDocumentSubset('quick fox', [0, 2, 4]);
            expect(scores.size).toBe(3);
            expect(scores.has(0)).toBe(true);
            expect(scores.has(2)).toBe(true);
            expect(scores.has(4)).toBe(true);
            expect(scores.has(1)).toBe(false);
        });

        it('should return empty map for empty query', () => {
            const scores = scorer.scoreDocumentSubset('', [0, 1]);
            expect(scores.size).toBe(0);
        });

        it('should ignore invalid indices', () => {
            const scores = scorer.scoreDocumentSubset('fox', [-1, 0, 100]);
            expect(scores.size).toBe(1);
            expect(scores.has(0)).toBe(true);
        });
    });
});

// =============================================================================
// FIELD BOOSTING TESTS
// =============================================================================

describe('BM25Scorer with Field Boosting', () => {
    it('should boost title matches', () => {
        const boostScorer = new BM25Scorer({ fieldBoosting: true });

        const docs = [
            { text: 'A document about cats', title: 'Fox Story' },
            { text: 'A story about the quick brown fox', title: 'Cat Story' }
        ];

        boostScorer.indexDocuments(docs);

        const boostResults = boostScorer.search('fox', 2);

        // With field boosting, doc with "fox" in title should score higher
        expect(boostResults[0].index).toBe(0);
    });

    it('should boost tag matches', () => {
        const scorer = new BM25Scorer({ fieldBoosting: true });
        const docs = [
            { text: 'A generic document', tags: ['fox', 'animal'] },
            { text: 'A document about foxes in the wild' }
        ];

        scorer.indexDocuments(docs);
        const results = scorer.search('fox', 2);

        // Doc with "fox" in tags should be boosted
        expect(results[0].index).toBe(0);
    });
});

// =============================================================================
// HELPER FUNCTIONS TESTS
// =============================================================================

describe('createBM25Scorer', () => {
    it('should create and index scorer in one step', () => {
        const docs = [
            { text: 'Document one' },
            { text: 'Document two' }
        ];

        const scorer = createBM25Scorer(docs);
        expect(scorer.totalDocs).toBe(2);
        expect(scorer instanceof BM25Scorer).toBe(true);
    });

    it('should pass options to scorer', () => {
        const docs = [{ text: 'Test' }];
        const scorer = createBM25Scorer(docs, { k1: 2.0 });
        expect(scorer.k1).toBe(2.0);
    });
});

describe('applyBM25Scoring', () => {
    const testResults = [
        { text: 'The quick brown fox', score: 0.9 },
        { text: 'A lazy sleeping cat', score: 0.8 },
        { text: 'Dogs running in park', score: 0.7 }
    ];

    it('should return empty array for empty results', () => {
        expect(applyBM25Scoring([], 'test')).toEqual([]);
    });

    it('should return original results for empty query', () => {
        const results = applyBM25Scoring(testResults, '');
        expect(results).toEqual(testResults);
    });

    it('should add BM25 scores to results', () => {
        const scored = applyBM25Scoring(testResults, 'quick fox');
        expect(scored[0].bm25Score).toBeDefined();
        expect(scored[0].normalizedBM25).toBeDefined();
        expect(scored[0].vectorScore).toBeDefined();
    });

    it('should preserve original score', () => {
        const scored = applyBM25Scoring(testResults, 'fox');
        expect(scored[0].originalScore).toBeDefined();
    });

    it('should calculate combined score', () => {
        const scored = applyBM25Scoring(testResults, 'fox', {
            alpha: 0.5,
            beta: 0.5
        });
        // Combined score should be between min and max of components
        scored.forEach(r => {
            expect(r.score).toBeDefined();
        });
    });

    it('should re-rank results by combined score', () => {
        const scored = applyBM25Scoring(testResults, 'quick fox');
        // Results should be sorted by combined score descending
        for (let i = 1; i < scored.length; i++) {
            expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
        }
    });

    it('should respect alpha/beta weights', () => {
        const vectorOnly = applyBM25Scoring(testResults, 'fox', { alpha: 1.0, beta: 0.0 });
        const bm25Only = applyBM25Scoring(testResults, 'fox', { alpha: 0.0, beta: 1.0 });

        // With alpha=1, beta=0, ranking should match original order (by vector score)
        // With alpha=0, beta=1, ranking should be purely by BM25
        expect(vectorOnly[0].score).not.toBe(bm25Only[0].score);
    });
});

// =============================================================================
// EDGE CASES AND PERFORMANCE
// =============================================================================

describe('Edge Cases', () => {
    it('should handle documents with only stop words', () => {
        const scorer = new BM25Scorer();
        scorer.indexDocuments([{ text: 'the and or but' }]);
        // Should not crash, tokens will be empty after stop word removal
        const results = scorer.search('important content');
        expect(results).toBeDefined();
    });

    it('should handle very long documents', () => {
        const longDoc = { text: 'word '.repeat(10000) + 'unique' };
        const scorer = new BM25Scorer();
        scorer.indexDocuments([longDoc]);
        const results = scorer.search('unique');
        expect(results[0].score).toBeGreaterThan(0);
    });

    it('should handle special characters in text', () => {
        const scorer = new BM25Scorer();
        scorer.indexDocuments([
            { text: 'Hello! @#$% World?' },
            { text: 'Test <html> tags & entities' }
        ]);
        const results = scorer.search('hello world');
        expect(results.length).toBeGreaterThan(0);
    });

    it('should handle numeric content', () => {
        const scorer = new BM25Scorer();
        scorer.indexDocuments([
            { text: '123 456 789' },
            { text: 'Numbers like 42 and 100' }
        ]);
        const results = scorer.search('42');
        expect(results.length).toBeGreaterThan(0);
    });
});

describe('IDF Calculation', () => {
    it('should give higher IDF to rare terms', () => {
        const scorer = new BM25Scorer();
        scorer.indexDocuments([
            { text: 'common rare' },
            { text: 'common everyday' },
            { text: 'common normal' }
        ]);

        // "rare" appears in 1 doc, "common" in 3
        const rareIdf = scorer.idf.get(porterStemmer('rare'));
        const commonIdf = scorer.idf.get(porterStemmer('common'));

        expect(rareIdf).toBeGreaterThan(commonIdf);
    });
});
