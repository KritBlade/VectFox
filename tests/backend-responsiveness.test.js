/**
 * Diagnostics' Backend Responsiveness check (src/features/diagnostics/visualizer-tests.js) times the embedding apart
 * from the database steps, and the test collection's one-time setup apart from the steps after it, and names the slow
 * part, so a slow embedding provider is not reported as a slow database (GitHub issue #26); a failure names the step
 * it happened in; and the test collection is cleaned up on every outcome once a write has started. Vector Insert and
 * Vector Delete clean up after their early failures as well.
 *
 * The clock is the test's own: each stubbed step moves it on by the time the test gives that step. The backend is
 * stubbed as the Qdrant backend behaves: an insert registers its collection under its "backend:collectionId" key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const host = vi.hoisted(() => {
    const state = {
        clock: 0,
        stepMs: {},
        failingStep: null,
        isEmbeddingPerRequest: false,
        listsNothing: false,
        deleteKeepsHashes: false,
        insertCount: 0,
        stored: new Map(),
        registry: new Set(),
    };
    /** One stubbed step: the clock moves on by its time, then it fails when the test makes it the failing one. */
    state.runStep = name => {
        state.clock += state.stepMs[name] ?? 0;
        if (state.failingStep === name) throw new Error(`${name} refused: 503 Service Unavailable`);
    };
    return state;
});

const VECTOR = [0.1, 0.2, 0.3];

vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({
    getStringHash: text => [...String(text)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) | 0, 7),
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(() => 'chat-1'), chat_metadata: {} }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: async () => true }));
vi.mock('../src/features/embedding/index.js', () => ({
    embeddingProfileRequestFields: async () => ({}),
    embeddingProviderLabel: settings => `${settings.embedding_provider} (qwen/qwen3-embedding-8b)`,
    getModelFromSettings: () => 'qwen/qwen3-embedding-8b',
    resolveProviderApiUrl: () => undefined,
    // Two thirds of the default 15 s retrieval timeout, as embedding-latency-warning.js derives it.
    slowEmbeddingWarnMs: () => 10000,
}));
vi.mock('../src/features/vector-backend/index.js', async () => {
    const { buildRegistryKey } = await vi.importActual('../src/shared/collection-ids.js');
    return {
        getBackend: vi.fn(async () => {
            host.runStep('connection');
            return {
                embedQuery: vi.fn(async () => {
                    host.runStep('embedding');
                    return host.isEmbeddingPerRequest ? null : VECTOR;
                }),
            };
        }),
        insertVectorItems: vi.fn(async (collectionId, items, settings) => {
            host.runStep(host.insertCount++ === 0 ? 'collection setup' : 'write');
            host.registry.add(buildRegistryKey(collectionId, settings));
            const hashes = host.stored.get(collectionId) ?? new Set();
            for (const item of items) hashes.add(String(item.hash));
            host.stored.set(collectionId, hashes);
        }),
        getSavedHashes: vi.fn(async collectionId => {
            host.runStep('list');
            return host.listsNothing ? [] : [...(host.stored.get(collectionId) ?? [])];
        }),
        deleteVectorItems: vi.fn(async (collectionId, hashes) => {
            host.runStep('delete');
            if (host.deleteKeepsHashes) return;
            for (const hash of hashes) host.stored.get(collectionId)?.delete(String(hash));
        }),
        purgeVectorIndex: vi.fn(async collectionId => { host.stored.delete(collectionId); }),
        reciprocalRankFusion: vi.fn(),
        weightedCombination: vi.fn(),
    };
});
vi.mock('../src/features/collections/index.js', () => ({
    unregisterCollection: vi.fn(key => host.registry.delete(key)),
    deleteCollection: vi.fn(),
}));

const { checkBackendResponsiveness, checkVectorDelete, checkVectorInsert } = await import('../src/features/diagnostics/visualizer-tests.js');
const { insertVectorItems, purgeVectorIndex } = await import('../src/features/vector-backend/index.js');
const { unregisterCollection } = await import('../src/features/collections/index.js');

const QDRANT_ON_VLLM = { vector_backend: 'qdrant', embedding_provider: 'vllm' };

/** The test collection a check inserted into. */
function testCollectionOf() {
    return insertVectorItems.mock.calls[0][0];
}

/** Whether the check left its test collection purged and out of the registry. */
function expectCleanedUp(settings) {
    const collectionId = testCollectionOf();
    expect(purgeVectorIndex).toHaveBeenCalledWith(collectionId, settings);
    expect(unregisterCollection).toHaveBeenCalledWith(`${settings.vector_backend}:${collectionId}`);
    expect(host.stored.has(collectionId)).toBe(false);
    expect(host.registry.size).toBe(0);
}

beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(host, {
        clock: 0,
        stepMs: {},
        failingStep: null,
        isEmbeddingPerRequest: false,
        listsNothing: false,
        deleteKeepsHashes: false,
        insertCount: 0,
        stored: new Map(),
        registry: new Set(),
    });
    vi.spyOn(performance, 'now').mockImplementation(() => host.clock);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Backend Responsiveness', () => {
    it('#26: names a slow embedding as the embedding, not the database, and keeps its time out of the database steps', async () => {
        // The issue's timings: NanoGPT embedding 22 s, Qdrant Cloud's new collection 2.6 s and its other steps fast.
        host.stepMs = { embedding: 22000, 'collection setup': 2600, write: 270, list: 90, delete: 50 };

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result.status).toBe('fail');
        expect(result.message).toBe(
            'Embedding very slow, over the 15.0 s retrieval timeout - check the embedding provider. '
            + 'Embedding 22.0 s on vllm (qwen/qwen3-embedding-8b); qdrant: collection setup 2.6 s, write 270 ms, list 90 ms, delete 50 ms',
        );
        expect(result.message).not.toMatch(/check the qdrant backend/);
        // Every write carries the vector the embedding step made, so no database step embeds.
        expect(insertVectorItems).toHaveBeenCalledTimes(2);
        for (const [, items] of insertVectorItems.mock.calls) {
            expect(items.map(item => item.vector)).toEqual([VECTOR]);
        }
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('names a slow database as the backend, with its slowest step, and not as the embedding', async () => {
        host.stepMs = { embedding: 800, 'collection setup': 300, write: 15200, list: 300, delete: 200 };

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result.status).toBe('fail');
        expect(result.message).toBe(
            'qdrant very slow (15.7 s after its setup; slowest step: write) - check the qdrant backend. '
            + 'Embedding 800 ms on vllm (qwen/qwen3-embedding-8b); qdrant: collection setup 300 ms, write 15.2 s, list 300 ms, delete 200 ms',
        );
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('rates a slow collection setup, which each collection pays once, as a warning and never a failure', async () => {
        // A local Qdrant on Windows makes each of a new collection's payload indexes in about 0.4 s.
        host.stepMs = { embedding: 11, 'collection setup': 60000, write: 22, list: 15, delete: 11 };

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result.status).toBe('warning');
        expect(result.message).toBe(
            'qdrant collection setup slow: a new collection\'s first write waits 60.0 s. '
            + 'Embedding 11 ms on vllm (qwen/qwen3-embedding-8b); qdrant: collection setup 60.0 s, write 22 ms, list 15 ms, delete 11 ms',
        );
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('names the slowest database step wherever it ran', async () => {
        host.stepMs = { embedding: 100, 'collection setup': 300, write: 200, list: 100, delete: 5600 };

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result.status).toBe('warning');
        expect(result.message.startsWith('qdrant slow (5.9 s after its setup; slowest step: delete). ')).toBe(true);
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('passes a fast run with each step\'s time', async () => {
        host.stepMs = { embedding: 812, 'collection setup': 2600, write: 265, list: 90, delete: 50 };

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result).toEqual({
            name: 'Backend Responsiveness',
            status: 'pass',
            message: 'Embedding 812 ms on vllm (qwen/qwen3-embedding-8b); qdrant: collection setup 2.6 s, write 265 ms, list 90 ms, delete 50 ms',
            category: 'visualizer',
        });
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it.each([
        ['an embedding under two thirds of the retrieval timeout', 'pass', { embedding: 9999 }, ''],
        ['an embedding at two thirds of the retrieval timeout', 'warning', { embedding: 10000 }, 'Embedding slow, near the 15.0 s retrieval timeout.'],
        ['an embedding at the retrieval timeout', 'warning', { embedding: 15000 }, 'Embedding slow, near the 15.0 s retrieval timeout.'],
        ['an embedding over the retrieval timeout', 'fail', { embedding: 15001 }, 'Embedding very slow, over the 15.0 s retrieval timeout'],
        ['a collection setup of 15 s', 'pass', { 'collection setup': 15000 }, ''],
        ['a collection setup over 15 s', 'warning', { 'collection setup': 15001 }, 'qdrant collection setup slow: a new collection\'s first write waits 15.0 s.'],
        ['steps after the setup of 5 s in all', 'pass', { write: 5000 }, ''],
        ['steps after the setup over 5 s in all', 'warning', { write: 5001 }, 'qdrant slow (5.0 s after its setup; slowest step: write).'],
        ['steps after the setup of 15 s in all', 'warning', { write: 15000 }, 'qdrant slow (15.0 s after its setup; slowest step: write).'],
        ['steps after the setup over 15 s in all', 'fail', { write: 15001 }, 'qdrant very slow (15.0 s after its setup; slowest step: write)'],
        ['a slow embedding and a very slow database', 'fail', { embedding: 11000, write: 16000 }, 'Embedding slow, near the 15.0 s retrieval timeout. qdrant very slow'],
        ['a very slow embedding and a slow database', 'fail', { embedding: 16000, write: 6000 }, 'Embedding very slow, over the 15.0 s retrieval timeout - check the embedding provider. qdrant slow'],
        ['a very slow embedding and a slow setup', 'fail', { embedding: 16000, 'collection setup': 20000 }, 'Embedding very slow, over the 15.0 s retrieval timeout - check the embedding provider. qdrant collection setup slow'],
    ])('rates %s as %s, and cleans up', async (_, status, stepMs, lead) => {
        host.stepMs = stepMs;

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result.status).toBe(status);
        expect(result.message.startsWith(lead ? lead : 'Embedding ')).toBe(true);
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it.each([
        ['connection', 'qdrant connection failed: connection refused: 503 Service Unavailable', false],
        ['embedding', 'Embedding on vllm (qwen/qwen3-embedding-8b) failed: embedding refused: 503 Service Unavailable', false],
        ['collection setup', 'qdrant collection setup failed: collection setup refused: 503 Service Unavailable', true],
        ['write', 'qdrant write failed: write refused: 503 Service Unavailable', true],
        ['list', 'qdrant list failed: list refused: 503 Service Unavailable', true],
        ['delete', 'qdrant delete failed: delete refused: 503 Service Unavailable', true],
    ])('names a failure in the %s step, and cleans up only once a write has started', async (stepName, message, hasWritten) => {
        host.failingStep = stepName;

        const result = await checkBackendResponsiveness(QDRANT_ON_VLLM);

        expect(result).toMatchObject({ name: 'Backend Responsiveness', status: 'fail', message });
        if (hasWritten) {
            expectCleanedUp(QDRANT_ON_VLLM);
        } else {
            expect(insertVectorItems).not.toHaveBeenCalled();
            expect(purgeVectorIndex).not.toHaveBeenCalled();
            expect(unregisterCollection).not.toHaveBeenCalled();
        }
    });

    it('is skipped on Standard without Similharity, where SillyTavern embeds inside the insert, and writes nothing', async () => {
        host.isEmbeddingPerRequest = true;
        const standard = { vector_backend: 'standard', embedding_provider: 'transformers' };

        const result = await checkBackendResponsiveness(standard);

        expect(result.status).toBe('skipped');
        expect(result.message).toMatch(/^Needs the Similharity plugin/);
        expect(insertVectorItems).not.toHaveBeenCalled();
        expect(purgeVectorIndex).not.toHaveBeenCalled();
    });
});

describe('Vector Insert and Vector Delete', () => {
    it('Vector Insert cleans up when the inserted hash is not listed', async () => {
        host.listsNothing = true;

        const result = await checkVectorInsert(QDRANT_ON_VLLM);

        expect(result).toMatchObject({ status: 'fail', message: 'Insert succeeded but hash not found in collection' });
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('Vector Delete cleans up when its insert is not listed', async () => {
        host.listsNothing = true;

        const result = await checkVectorDelete(QDRANT_ON_VLLM);

        expect(result).toMatchObject({ status: 'fail', message: 'Could not set up test - insert did not work' });
        expectCleanedUp(QDRANT_ON_VLLM);
    });

    it('Vector Delete cleans up when the deleted hash is still listed', async () => {
        host.deleteKeepsHashes = true;

        const result = await checkVectorDelete(QDRANT_ON_VLLM);

        expect(result).toMatchObject({ status: 'fail', message: 'Delete called but hash still exists in collection' });
        expectCleanedUp(QDRANT_ON_VLLM);
    });
});
