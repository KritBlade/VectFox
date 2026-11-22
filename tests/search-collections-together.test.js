/**
 * searchCollectionsTogether (src/features/vector-backend/vector-api.js, §4.5 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the texts are embedded in one request, tried again once as
 * a single query's embedding is, and each text gets one fused search over every collection listed, all sent at once.
 *
 * Isolation: vector-api.js reaches ST modules that don't resolve under vitest, so its import graph is stubbed, as in
 * query-embedding-retry.test.js.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [] }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {}, SECRET_KEYS: {}, findSecret: vi.fn(), writeSecret: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: vi.fn(), getBackendForCollection: vi.fn(), invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn(),
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

const { getBackendForCollection, recordError } = await import('../src/features/vector-backend/backend-registry.js');
const { QUERY_EMBEDDING_RETRY_PAUSE_MS, searchCollectionsTogether } = await import('../src/features/vector-backend/vector-api.js');

const BOOKS = ['vf_lorebase_qdrant_rabbit_harbor_atlas_1x', 'vf_lorebase_qdrant_rabbit_wren_journal_2y'];
const SETTINGS = { embedding_provider: 'custom', qdrant_multitenancy: true, qdrant_shared_collection: 'vf_lorebase_rabbit' };
const TEXTS = ['Who keeps the lamp tonight?', 'The lamp is lit.'];

function fakeBackend(overrides = {}) {
    return {
        embedQueries: vi.fn(async texts => texts.map((_, index) => [index, 1])),
        hybridQueryCollections: vi.fn(async (_ids, text) => [{ hash: text.length, score: 0.5, metadata: {} }]),
        ...overrides,
    };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('searchCollectionsTogether', () => {
    it('embeds the texts in one request, then searches each over every collection, its own vector given', async () => {
        const backend = fakeBackend();
        getBackendForCollection.mockResolvedValue(backend);

        const searches = await searchCollectionsTogether(BOOKS, TEXTS, 400, SETTINGS);

        expect(getBackendForCollection).toHaveBeenCalledWith('qdrant', SETTINGS);
        expect(backend.embedQueries).toHaveBeenCalledTimes(1);
        expect(backend.embedQueries).toHaveBeenCalledWith(TEXTS, SETTINGS);
        expect(backend.hybridQueryCollections.mock.calls).toEqual([
            [BOOKS, TEXTS[0], 400, SETTINGS, [0, 1]],
            [BOOKS, TEXTS[1], 400, SETTINGS, [1, 1]],
        ]);
        expect(searches).toEqual([[{ hash: TEXTS[0].length, score: 0.5, metadata: {} }], [{ hash: TEXTS[1].length, score: 0.5, metadata: {} }]]);
    });

    it('tries the embedding once more after a short pause, but never a wrong setup', async () => {
        const backend = fakeBackend({
            embedQueries: vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([[0, 1], [1, 1]]),
        });
        getBackendForCollection.mockResolvedValue(backend);
        const searching = searchCollectionsTogether(BOOKS, TEXTS, 400, SETTINGS);
        await vi.advanceTimersByTimeAsync(QUERY_EMBEDDING_RETRY_PAUSE_MS);
        await expect(searching).resolves.toHaveLength(2);
        expect(backend.embedQueries).toHaveBeenCalledTimes(2);

        const invalidModel = Object.assign(new Error('model not found'), { code: 'invalid_model_config' });
        const wrongSetup = fakeBackend({ embedQueries: vi.fn().mockRejectedValue(invalidModel) });
        getBackendForCollection.mockResolvedValue(wrongSetup);
        await expect(searchCollectionsTogether(BOOKS, TEXTS, 400, SETTINGS)).rejects.toBe(invalidModel);
        expect(wrongSetup.embedQueries).toHaveBeenCalledTimes(1);
        expect(wrongSetup.hybridQueryCollections).not.toHaveBeenCalled();
    });

    it('throws a failed search, recorded as a Qdrant error', async () => {
        const failure = new Error('Hybrid query failed');
        getBackendForCollection.mockResolvedValue(fakeBackend({ hybridQueryCollections: vi.fn().mockRejectedValue(failure) }));
        await expect(searchCollectionsTogether(BOOKS, TEXTS, 400, SETTINGS)).rejects.toBe(failure);
        expect(recordError).toHaveBeenCalledWith('qdrant', failure);
    });
});
