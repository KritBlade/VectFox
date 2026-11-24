/**
 * A rate limit on an insert (src/features/vector-backend/vector-api.js): the hedge race hands the provider's 429 to
 * insertVectorItems' retry (RETRY_CONFIG), which waits 5s, 8s and 8s between its 4 attempts, one request each, so a
 * limit that passes within the waits lets the insert through, and one that lasts ends as the provider's own error,
 * which the EventBase coordinator's insert retry takes again.
 *
 * Isolation: as in insert-request-batching.test.js, the ST import graph is stubbed and the embedding API rate
 * limiter's execute is a pass-through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [] }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {}, SECRET_KEYS: {}, findSecret: vi.fn(), writeSecret: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: vi.fn(), getBackendForCollection: vi.fn(), invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn(),
}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

const { insertVectorItems, DynamicRateLimiter } = await import('../src/features/vector-backend/vector-api.js');
const { getBackend } = await import('../src/features/vector-backend/backend-registry.js');

/** A Custom embedding profile with the hedge on, as an install has it. */
const SETTINGS = {
    insert_batch_size: 50,
    rate_limit_calls: 60,
    rate_limit_interval: 60,
    vector_group_embedding_call: true,
    vector_hedge_after_ms: 15000,
    embedding_provider: 'custom',
};

const items = [{ text: 'first event', hash: 1 }, { text: 'second event', hash: 2 }];

const rateLimit = () => new Error('[Qdrant] Failed to insert 2 vectors into c: 500 Internal Server Error - {"error":"Custom embedding: 429 Too Many Requests (the server is busy or hit a rate limit)"}');

let backend;
let rateLimiterExecute;

beforeEach(() => {
    vi.useFakeTimers();
    backend = { insertVectorItems: vi.fn() };
    getBackend.mockResolvedValue(backend);
    rateLimiterExecute = vi.spyOn(DynamicRateLimiter.prototype, 'execute').mockImplementation(fn => fn());
});

afterEach(() => {
    rateLimiterExecute.mockRestore();
    vi.useRealTimers();
});

describe('insertVectorItems — a rate limit', () => {
    it('waits before each new attempt, one request at a time, and goes through once the limit passes', async () => {
        backend.insertVectorItems.mockRejectedValueOnce(rateLimit()).mockRejectedValueOnce(rateLimit()).mockResolvedValue(undefined);

        const insert = insertVectorItems('collection', items, SETTINGS);
        await vi.advanceTimersByTimeAsync(0);
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(4999);
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(8000);
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(3);
        await expect(insert).resolves.toBeUndefined();
    });

    it('ends as the provider\'s own error, not hedge-fatal, when the limit outlasts its 4 attempts', async () => {
        backend.insertVectorItems.mockImplementation(async () => { throw rateLimit(); });

        const outcome = insertVectorItems('collection', items, SETTINGS).then(() => 'resolved', error => error);
        await vi.advanceTimersByTimeAsync(5000 + 8000 + 8000);

        const error = await outcome;
        expect(backend.insertVectorItems).toHaveBeenCalledTimes(4);
        expect(error.message).toContain('429 Too Many Requests');
        expect(error.isHedgeFatal).toBeUndefined();
    });
});
