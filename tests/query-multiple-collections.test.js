/**
 * vector-backend/vector-api.js queryMultipleCollections, the Database Browser's search: a collection whose query
 * failed keeps an `error` on both paths, so the browser can tell "not searched" from "nothing matched", and the hybrid
 * path drops results scored below the threshold, as the standard path's backend does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), lifecycle: vi.fn(), trace: vi.fn(), enabled: () => false },
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: vi.fn(),
    getBackendForCollection: vi.fn(),
    invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(),
    recordInsert: vi.fn(),
    recordDelete: vi.fn(),
    recordError: vi.fn(),
}));
vi.mock('../src/features/embedding/index.js', () => ({ getModelFromSettings: vi.fn(), resolveProviderApiUrl: vi.fn() }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ isConnectionError: () => false, notifyConnectionError: vi.fn() }));
vi.mock('../src/features/keyword-search/index.js', () => ({
    getOverfetchAmount: topK => topK,
    applyBM25Scoring: vi.fn(),
    porterStemmer: token => token,
    extractQueryKeywords: () => [],
    RETRIEVAL_KEYWORD_LEVELS: {},
    isCJKToken: () => false,
}));
vi.mock('../src/features/vector-backend/hybrid-search.js', () => ({ hybridSearch: vi.fn() }));

import { getBackend } from '../src/features/vector-backend/backend-registry.js';
import { hybridSearch } from '../src/features/vector-backend/hybrid-search.js';
import { queryMultipleCollections } from '../src/features/vector-backend/vector-api.js';

describe('queryMultipleCollections', () => {
    beforeEach(() => vi.clearAllMocks());

    it('keeps the reason a collection could not be searched on the hybrid path', async () => {
        getBackend.mockResolvedValue({ supportsHybridSearch: () => true });
        const hit = { hashes: [7], metadata: [{ text: 'river', score: 0.9 }] };
        hybridSearch.mockImplementation(async (collectionId) => {
            if (collectionId === 'down') throw new Error('Query embedding failed: 500');
            return hit;
        });
        const results = await queryMultipleCollections(['down', 'up'], 'river', 5, 0.3, { embedding_provider: 'openrouter' });
        expect(results.down).toEqual({ hashes: [], metadata: [], error: 'Query embedding failed: 500' });
        expect(results.up).toEqual(hit);
    });

    it('drops hybrid results scored below the threshold, keeping hashes and metadata in step', async () => {
        getBackend.mockResolvedValue({ supportsHybridSearch: () => true });
        hybridSearch.mockResolvedValue({
            hashes: [1, 2, 3],
            metadata: [{ text: 'tide', score: 0.52 }, { text: 'keyword only', score: 0 }, { text: 'harbor', score: 0.3 }],
        });
        const results = await queryMultipleCollections(['notes'], 'river', 5, 0.3, { embedding_provider: 'openrouter' });
        expect(results.notes.hashes).toEqual([1, 3]);
        expect(results.notes.metadata.map(meta => meta.text)).toEqual(['tide', 'harbor']);
    });

    it('keeps the reason the backend gave on the standard path', async () => {
        const failed = { hashes: [], metadata: [], error: '500 Internal Server Error' };
        getBackend.mockResolvedValue({
            supportsHybridSearch: () => false,
            queryMultipleCollections: async () => ({ down: failed, empty: { hashes: [], metadata: [] } }),
        });
        const results = await queryMultipleCollections(['down', 'empty'], 'river', 5, 0.3, { keyword_scoring_method: 'keyword' });
        expect(results.down).toEqual(failed);
        expect(results.empty).toEqual({ hashes: [], metadata: [] });
    });
});
