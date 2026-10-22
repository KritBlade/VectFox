/**
 * Unit tests for how insertVectorItems (core/core-vector-api.js) splits items
 * into insert requests.
 *
 * Local GPU sources send one item per request whatever insert_batch_size says,
 * and skip the embedding API rate limiter. API sources batch up to
 * insert_batch_size items per request and stay rate-limited. Every case runs
 * with the settings a fresh install has, because insert_batch_size is always
 * set there.
 *
 * Isolation: core-vector-api.js reaches ST modules that don't resolve under
 * vitest, so the whole import graph is stubbed. The rate limiter's execute is
 * replaced by a pass-through spy so a test asserts routing, never waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [] }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {}, SECRET_KEYS: {}, findSecret: vi.fn(), writeSecret: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => false }));
vi.mock('../providers/webllm.js', () => ({ getWebLlmProvider: vi.fn() }));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(), getBackendForCollection: vi.fn(), invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn(),
}));
vi.mock('../core/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

const { insertVectorItems, DynamicRateLimiter } = await import('../core/core-vector-api.js');
const { getBackend } = await import('../backends/backend-manager.js');

/** The index.js defaults for every setting insertVectorItems reads. */
const INSTALL_DEFAULTS = {
    insert_batch_size: 50,
    rate_limit_calls: 60,
    rate_limit_interval: 60,
    vector_group_embedding_call: true,
    vector_hedge_after_ms: 15000,
};

const items = [
    { text: 'first chunk', hash: 1 },
    { text: 'second chunk', hash: 2 },
    { text: 'third chunk', hash: 3 },
];

let backend;
let rateLimiterExecute;

beforeEach(() => {
    backend = { insertVectorItems: vi.fn().mockResolvedValue(undefined) };
    getBackend.mockResolvedValue(backend);
    rateLimiterExecute = vi.spyOn(DynamicRateLimiter.prototype, 'execute').mockImplementation(fn => fn());
});

afterEach(() => rateLimiterExecute.mockRestore());

/** @returns {number[]} item count of every insert request the backend received */
function requestSizes() {
    return backend.insertVectorItems.mock.calls.map(([, batch]) => batch.length);
}

describe('insertVectorItems — local GPU sources', () => {
    it.each(['transformers', 'ollama', 'llamacpp'])('%s sends one item per request at the default insert_batch_size', async (provider) => {
        await insertVectorItems('collection', items, { ...INSTALL_DEFAULTS, embedding_provider: provider });

        expect(requestSizes()).toEqual([1, 1, 1]);
    });

    it('is not routed through the embedding API rate limiter', async () => {
        await insertVectorItems('collection', items, { ...INSTALL_DEFAULTS, embedding_provider: 'transformers' });

        expect(rateLimiterExecute).not.toHaveBeenCalled();
    });
});

describe('insertVectorItems — API sources', () => {
    it('batch up to insert_batch_size items into one rate-limited request', async () => {
        await insertVectorItems('collection', items, { ...INSTALL_DEFAULTS, embedding_provider: 'openai' });

        expect(requestSizes()).toEqual([3]);
        expect(rateLimiterExecute).toHaveBeenCalledTimes(1);
    });
});
