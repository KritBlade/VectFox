/**
 * Tests for how every EventBase search queries an event collection (src/features/eventbase/eventbase-search.js).
 *
 * Guards that:
 *   - an event search runs on EventBase's keyword scoring and similarity threshold, never ChunkBase's,
 *   - the threshold defaults to 0, so ChunkBase's 0.25 never gates events,
 *   - Standard's query applies the threshold, so its hits, which may carry no score, are all kept,
 *   - on Qdrant the hits below the threshold are dropped by their similarity, not a fused score,
 *   - re-ranked events take their similarity from a plain search, and those outside it are dropped,
 *   - no other EventBase file searches a collection itself.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryCollectionMock = vi.fn();
vi.mock('../src/features/vector-backend/index.js', () => ({
    queryCollection: (...args) => queryCollectionMock(...args),
}));

// The real module reaches SillyTavern host modules; this reads the backend from a registry key the same way.
vi.mock('../src/shared/collection-ids.js', () => ({
    resolveBackendForCollection: (id) => ({ backend: id.includes(':') ? id.split(':')[0] : null, collectionId: id }),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { verbose: vi.fn() } }));

const { eventSearchSettings, eventSimilarityOf, keepRerankedEventsAtThreshold, searchEventCollection } = await import('../src/features/eventbase/eventbase-search.js');

const searchSettingsOfCall = () => queryCollectionMock.mock.calls[0][3];

beforeEach(() => {
    queryCollectionMock.mockReset();
});

describe('eventSearchSettings', () => {
    it('swaps in EventBase\'s keyword scoring and threshold for ChunkBase\'s', () => {
        const settings = { keyword_scoring_method: 'hybrid', score_threshold: 0.25, eventbase_keyword_scoring_method: 'hybrid', eventbase_score_threshold: 0.4 };
        expect(eventSearchSettings(settings)).toMatchObject({ keyword_scoring_method: 'hybrid', score_threshold: 0.4 });
        expect(eventSearchSettings({ keyword_scoring_method: 'hybrid', score_threshold: 0.25 })).toMatchObject({ keyword_scoring_method: 'bm25', score_threshold: 0 });
    });

    it('takes a threshold given over the EventBase page\'s', () => {
        expect(eventSearchSettings({ eventbase_score_threshold: 0.4 }, 0).score_threshold).toBe(0);
    });
});

describe('eventSimilarityOf', () => {
    it('reads the raw similarity before a fused score, and 0 when a hit has neither', () => {
        expect(eventSimilarityOf({ score: 0.9, vectorScore: 0.3 })).toBe(0.3);
        expect(eventSimilarityOf({ score: 0.6 })).toBe(0.6);
        expect(eventSimilarityOf({})).toBe(0);
    });
});

describe('searchEventCollection', () => {
    const hits = [
        { hash: 1, score: 0.9, vectorScore: 0.3 },
        { hash: 2, score: 0.5 },
        { hash: 3, score: 0.4 },
        { hash: 4, score: 0.39 },
        { hash: 5 },
    ];
    const answer = { hashes: hits.map(hit => hit.hash), metadata: hits };

    it('sends EventBase\'s threshold with the query, never ChunkBase\'s', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });
        await searchEventCollection('standard:vf_eventbase_x', 'the duel', 8, { vector_backend: 'standard', score_threshold: 0.25 }, { queryVector: [0.1, 0.2] });
        expect(queryCollectionMock.mock.calls[0].slice(0, 3)).toEqual(['standard:vf_eventbase_x', 'the duel', 8]);
        expect(searchSettingsOfCall()).toMatchObject({ score_threshold: 0, keyword_scoring_method: 'bm25' });
        expect(queryCollectionMock.mock.calls[0][4]).toEqual([0.1, 0.2]);
    });

    it('keeps every Standard hit, since its query already applied the threshold', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [1, 2], metadata: [{ score: 0 }, { score: 0 }] });
        const result = await searchEventCollection('standard:vf_eventbase_x', 'the duel', 8, { vector_backend: 'standard', eventbase_score_threshold: 0.4 });
        expect(searchSettingsOfCall().score_threshold).toBe(0.4);
        expect(result.hashes).toEqual([1, 2]);
    });

    it('drops the Qdrant hits below the threshold by their similarity', async () => {
        queryCollectionMock.mockResolvedValue(answer);
        const result = await searchEventCollection('qdrant:vf_eventbase_x', 'the duel', 8, { vector_backend: 'qdrant', eventbase_score_threshold: 0.4 });
        expect(result.hashes).toEqual([2, 3]);
        expect(result.metadata).toEqual([hits[1], hits[2]]);
    });

    it('reads a bare id\'s backend from the settings', async () => {
        queryCollectionMock.mockResolvedValue(answer);
        const result = await searchEventCollection('vf_eventbase_x', 'the duel', 8, { vector_backend: 'qdrant', eventbase_score_threshold: 0.4 });
        expect(result.hashes).toEqual([2, 3]);
    });

    it('keeps every Qdrant hit at threshold 0, and at a threshold of 0 given over the page\'s', async () => {
        queryCollectionMock.mockResolvedValue(answer);
        expect((await searchEventCollection('qdrant:vf_eventbase_x', 'the duel', 8, { vector_backend: 'qdrant' })).hashes).toEqual([1, 2, 3, 4, 5]);
        const settings = { vector_backend: 'qdrant', eventbase_score_threshold: 0.4 };
        expect((await searchEventCollection('qdrant:vf_eventbase_x', 'the duel', 8, settings, { threshold: 0 })).hashes).toEqual([1, 2, 3, 4, 5]);
    });
});

describe('keepRerankedEventsAtThreshold', () => {
    it('gives each re-ranked event its similarity from the plain search and drops those below or outside it', () => {
        const events = [{ _hash: '1', score: 0.9 }, { _hash: '2', score: 0.8 }, { _hash: '3', score: 0.7 }];
        const similaritySearch = { hashes: [1, 2], metadata: [{ score: 0.5 }, { score: 0.2 }] };
        expect(keepRerankedEventsAtThreshold(events, similaritySearch, 0.3)).toEqual([{ _hash: '1', score: 0.9, vectorScore: 0.5 }]);
    });
});

describe('EventBase searches', () => {
    it('all go through eventbase-search.js, so none can take ChunkBase\'s threshold', () => {
        const folder = new URL('../src/features/eventbase/', import.meta.url);
        const importers = readdirSync(folder)
            .filter(name => name.endsWith('.js'))
            .filter(name => /import\s*\{[^}]*\bqueryCollection\b[^}]*\}\s*from\s*'\.\.\/vector-backend\/index\.js'/.test(readFileSync(new URL(name, folder), 'utf8')));
        expect(importers).toEqual(['eventbase-search.js']);
    });
});
