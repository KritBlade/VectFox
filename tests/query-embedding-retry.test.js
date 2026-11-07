/**
 * A failed query embedding is tried once more after a short pause, as a busy
 * provider's 500 or 429 tends to clear within a second, and an immediate retry
 * usually meets the same failure.
 *
 * Isolation: vector-api.js reaches ST modules that don't resolve under vitest,
 * so its import graph is stubbed, as in hedge-scheduling.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [] }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {}, SECRET_KEYS: {}, findSecret: vi.fn(), writeSecret: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => false }));
vi.mock('../src/features/embedding/webllm-provider.js', () => ({ getWebLlmProvider: vi.fn() }));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: vi.fn(), getBackendForCollection: vi.fn(), invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn(),
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

const { getQueryVector, QUERY_EMBEDDING_RETRY_PAUSE_MS } = await import('../src/features/vector-backend/vector-api.js');

const SETTINGS = { embedding_provider: 'openrouter' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('getQueryVector', () => {
    it('waits a short pause before its one retry', async () => {
        const backend = {
            embedQuery: vi.fn()
                .mockRejectedValueOnce(new Error("Query embedding via 'openrouter' failed: 500"))
                .mockResolvedValueOnce([0.1, 0.2]),
        };

        const vector = getQueryVector(backend, 'who won the duel', SETTINGS);
        await vi.advanceTimersByTimeAsync(QUERY_EMBEDDING_RETRY_PAUSE_MS - 1);
        expect(backend.embedQuery).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(backend.embedQuery).toHaveBeenCalledTimes(2);
        await expect(vector).resolves.toEqual([0.1, 0.2]);
    });

    it('pauses for about a second', () => {
        expect(QUERY_EMBEDDING_RETRY_PAUSE_MS).toBe(1000);
    });

    it('throws the second failure when the retry fails too', async () => {
        const backend = {
            embedQuery: vi.fn()
                .mockRejectedValueOnce(new Error('first failure'))
                .mockRejectedValueOnce(new Error('second failure')),
        };

        const vector = getQueryVector(backend, 'who won the duel', SETTINGS);
        const outcome = expect(vector).rejects.toThrow('second failure');
        await vi.advanceTimersByTimeAsync(QUERY_EMBEDDING_RETRY_PAUSE_MS);
        await outcome;
        expect(backend.embedQuery).toHaveBeenCalledTimes(2);
    });

    it('does not retry an invalid model', async () => {
        const invalidModel = Object.assign(new Error('model not found'), { code: 'invalid_model_config' });
        const backend = { embedQuery: vi.fn().mockRejectedValue(invalidModel) };

        await expect(getQueryVector(backend, 'who won the duel', SETTINGS)).rejects.toBe(invalidModel);
        expect(backend.embedQuery).toHaveBeenCalledTimes(1);
    });
});
