/**
 * Unit tests for core/reformat-extractor.js
 *
 * Covers the parts that are risky to get wrong and aren't exercised by
 * reformat-schema.test.js: the oversized-section batching/continuation
 * packer, retry-vs-fatal-error provider-call behavior, and the
 * expandOversizedChunk() accept-time fallback. Mocks ST globals + fetch —
 * same convention as chunk-metadata-persistence.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../core/api-keys.js', () => ({
    getOpenRouterApiKey: () => 'mock-masked-key',
    getCustomApiKey: () => 'mock-masked-key',
}));

// core/log.js reads extension_settings for verbosity/domain gating — mock the
// same way chunk-metadata-persistence.test.js mocks it for collection-metadata.js.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

import { reformatDocument, expandOversizedChunk } from '../core/reformat-extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChatCompletionResponse(entries, finishReason = 'stop') {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{
                message: { content: JSON.stringify(entries) },
                finish_reason: finishReason,
            }],
        }),
    };
}

function extractPrompt(fetchCallArgs) {
    const body = JSON.parse(fetchCallArgs[1].body);
    return body.messages[0].content;
}

function baseSettings(overrides = {}) {
    return {
        // Inherit chain: reformat_* → chat_* (Core → LLM Summarization keys)
        chat_provider: 'openrouter',
        chat_model: 'test/mock-model',
        reformat_batch_chars: 150,
        reformat_concurrency: 1, // deterministic call ordering for assertions
        reformat_timeout_ms: 5000,
        ...overrides,
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Oversized-section batching
// ---------------------------------------------------------------------------

describe('reformatDocument — batching', () => {
    it('splits an oversized section into continuation batches and threads already-extracted names forward', async () => {
        const doc = [
            '# Intro',
            '',
            'Short intro paragraph.',
            '',
            '## Roster',
            '',
            '***Hero A*** leads a squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
            '',
            '***Hero B*** leads another squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
            '',
            '***Hero C*** leads a third squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
        ].join('\n');

        let callCount = 0;
        const fetchMock = vi.fn(async () => {
            callCount++;
            // Each call "discovers" one new hero — mirrors what a real model would do.
            return mockChatCompletionResponse([
                { entry_type: 'character', name: `Hero-${callCount}`, aliases: [], affiliation: '', traits: [], relationships: [], keywords: [], body: `Body for call ${callCount}.` },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings() });

        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

        // At least one call after the first must be a continuation carrying the
        // "already extracted" note — proves the oversized-section splitter fired
        // and threaded prior names forward instead of re-processing from scratch.
        const prompts = fetchMock.mock.calls.map(extractPrompt);
        const continuationPrompts = prompts.filter(p => /continuation of section/i.test(p));
        expect(continuationPrompts.length).toBeGreaterThanOrEqual(1);
        expect(continuationPrompts[0]).toMatch(/already extracted from earlier in this same section/i);

        vi.unstubAllGlobals();
    });

    it('runs a short document as a single batch with no continuation note', async () => {
        const doc = '# Topic\n\nOne short paragraph, well under the batch budget.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([
            { entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', traits: [], relationships: [], keywords: [], body: 'One short paragraph.' },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].name).toBe('Topic');

        vi.unstubAllGlobals();
    });

    it('surfaces a truncated completion (finish_reason=length) as a warning without dropping the whole run', async () => {
        const doc = '# Topic\n\nSome content.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse(
            [{ entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', traits: [], relationships: [], keywords: [], body: 'Some content.' }],
            'length',
        ));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(result.chunks).toHaveLength(1);
        expect(result.warnings.some(w => /truncated/i.test(w))).toBe(true);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Retry vs. fatal-error behavior
// ---------------------------------------------------------------------------

describe('reformatDocument — provider call resilience', () => {
    it('retries a transient HTTP failure and succeeds on the second attempt', async () => {
        const doc = '# Topic\n\nSome content.';
        let attempt = 0;
        const fetchMock = vi.fn(async () => {
            attempt++;
            if (attempt === 1) {
                return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'temporarily down' };
            }
            return mockChatCompletionResponse([
                { entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', traits: [], relationships: [], keywords: [], body: 'Some content.' },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000 }),
        });

        expect(attempt).toBe(2);
        expect(result.chunks).toHaveLength(1);
        expect(result.batchesFailed).toBe(0);

        vi.unstubAllGlobals();
    });

    it('does not retry and aborts the whole run on missing model config (fatal error)', async () => {
        const doc = '# Topic\n\nSome content.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        const settings = baseSettings({ reformat_batch_chars: 6000 });
        settings.chat_model = ''; // no model anywhere → missing_model fatal error

        await expect(
            reformatDocument({ text: doc, contentType: 'document', settings })
        ).rejects.toThrow(/No model configured/);
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Oversized-entity fallback (accept-time)
// ---------------------------------------------------------------------------

describe('expandOversizedChunk', () => {
    it('returns the chunk unchanged when body is within the size ceiling', async () => {
        const chunk = { entry_type: 'character', name: 'Bulwark', body: 'Short body.' };
        const result = await expandOversizedChunk(chunk, 2000);
        expect(result).toEqual([chunk]);
    });

    it('splits an oversized body into multiple physical chunks sharing entity metadata', async () => {
        const longBody = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some padding text to grow the body.`).join('\n\n');
        const chunk = { entry_type: 'character', name: 'Bulwark', aliases: ['Eleanor Graves'], body: longBody };

        const result = await expandOversizedChunk(chunk, 200);

        expect(result.length).toBeGreaterThan(1);
        for (const [i, piece] of result.entries()) {
            expect(piece.name).toBe('Bulwark');
            expect(piece.entry_type).toBe('character');
            expect(piece.aliases).toEqual(['Eleanor Graves']);
            expect(piece.subChunkIndex).toBe(i);
            expect(piece.subChunkTotal).toBe(result.length);
            expect(piece.body.length).toBeLessThanOrEqual(longBody.length);
        }
    });
});
