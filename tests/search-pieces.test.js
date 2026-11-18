/**
 * The pieces a search text is searched in at the embedding provider's piece size (src/features/embedding/
 * search-pieces.js, the sizes in providers.js; plan: InternalProject/Vectfox/plans/executed/search-text-pieces.md §2),
 * and the guard in fetchQueryEmbedding (query-embedding.js): a text over the size still embeds, with a console warning
 * naming the search that sent it whole.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({ warn: vi.fn(), verbose: vi.fn(), lifecycle: vi.fn(), trace: vi.fn(), error: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: logMock }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/features/embedding/embedding-latency-warning.js', () => ({ warnIfEmbeddingSlow: vi.fn() }));
vi.mock('../src/features/embedding/embedding-request-failure.js', () => ({ throwIfEmbeddingConfigError: vi.fn() }));
vi.mock('../src/features/embedding/providers.js', async importOriginal => ({ ...(await importOriginal()), getModelFromSettings: () => 'test-model' }));

// SillyTavern modules embedding/providers.js reaches; SECRET_KEYS is read when it loads.
vi.mock('../../../../extensions.js', () => ({}));
vi.mock('../../../../../script.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

const { EMBEDDING_PROVIDERS } = await import('../src/features/embedding/providers.js');
const { searchPieces, searchPieceTokensOf } = await import('../src/features/embedding/search-pieces.js');
const { searchTokens } = await import('../src/features/embedding/search-pieces-core.js');
const { fetchQueryEmbedding } = await import('../src/features/embedding/query-embedding.js');

/** A text of about `tokens` tokens: Latin words of 1.3 tokens each, in short sentences. */
const textOf = tokens => Array.from({ length: Math.ceil(tokens / 1.3) }, (_, i) => `word${i}${i % 8 === 7 ? '.' : ''}`).join(' ');

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) }));
});

describe('the piece size per provider', () => {
    it('gives every embedding provider a size', () => {
        for (const [providerId, provider] of Object.entries(EMBEDDING_PROVIDERS)) {
            expect(provider.searchPieceTokens, providerId).toBeGreaterThan(0);
        }
    });

    it('reads the provider from the settings, Local (Transformers) when none is set', () => {
        expect(searchPieceTokensOf({ embedding_provider: 'llamacpp' })).toBe(500);
        expect(searchPieceTokensOf({ embedding_provider: 'custom' })).toBe(6000);
        expect(searchPieceTokensOf({})).toBe(4000);
    });

    it('searches a text whole for a provider missing from the table, as an old setting can name', () => {
        expect(searchPieceTokensOf({ embedding_provider: 'retired-provider' })).toBe(Infinity);
        const text = textOf(9000);
        expect(searchPieces(text, { embedding_provider: 'retired-provider' })).toEqual([text]);
    });
});

describe('searchPieces', () => {
    it('keeps an everyday search, the last 2 replies, as one piece on Custom', () => {
        const text = textOf(3000);
        expect(searchPieces(text, { embedding_provider: 'custom' })).toEqual([text]);
        expect(logMock.verbose).not.toHaveBeenCalled();
    });

    it('cuts the same text into pieces within llama.cpp\'s size, and says so in the console', () => {
        const pieces = searchPieces(textOf(3000), { embedding_provider: 'llamacpp' });
        expect(pieces.length).toBeGreaterThanOrEqual(6);
        for (const piece of pieces) expect(searchTokens(piece)).toBeLessThanOrEqual(500);
        expect(logMock.verbose).toHaveBeenCalledWith(expect.stringContaining(`searched in ${pieces.length} pieces of at most 500 ('llamacpp')`));
    });
});

describe('the guard in fetchQueryEmbedding', () => {
    it('embeds a text over the size whole, warning that the search sending it did not cut it', async () => {
        await expect(fetchQueryEmbedding(textOf(800), { embedding_provider: 'llamacpp' }, {})).resolves.toEqual([0.1, 0.2]);
        expect(logMock.warn).toHaveBeenCalledTimes(1);
        expect(logMock.warn.mock.calls[0][0]).toMatch(/a search text of about \d+ tokens reached 'llamacpp' whole, over its piece size of 500/);
    });

    it('embeds a text within the size with no warning', async () => {
        await fetchQueryEmbedding(textOf(300), { embedding_provider: 'llamacpp' }, {});
        expect(logMock.warn).not.toHaveBeenCalled();
    });
});
