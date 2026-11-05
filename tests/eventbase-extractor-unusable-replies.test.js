/**
 * A reply that cannot give a window its events is a failed window, never an empty one:
 * the workflow marks an empty window extracted and does not send it again.
 *
 * Drives the real extractEvents and schema; only the provider call and ST are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const provider = vi.hoisted(() => ({ reply: { content: '[]', finishReason: 'stop' } }));

vi.mock('../src/features/llm-provider/index.js', async () => {
    const parser = await vi.importActual('../src/features/llm-provider/llm-provider-call.js');
    return {
        parseJsonArrayFromLlm: parser.parseJsonArrayFromLlm,
        LlmCallError: parser.LlmCallError,
        resolveModelParameterStyle: () => ({}),
        postChatCompletion: vi.fn(async () => provider.reply),
    };
});
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/model-http-errors.js', () => ({ getModelConfigErrorMessage: () => null }));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isConnectionError: () => false, notifyConnectionError: vi.fn(), notifyUpstreamRejection: vi.fn(),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: (text) => text }));
vi.mock('../src/features/eventbase/eventbase-message-hash.js', () => ({ hashSourceMessage: (message) => message.mes.length }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));

const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');
const { EventBaseExtractionError } = await import('../src/features/eventbase/eventbase-schema.js');

const WINDOW = {
    messages: [{ name: 'User', mes: 'hello' }, { name: 'Bot', mes: 'hi there' }],
    windowStart: 4,
    windowEnd: 5,
    windowIndex: 2,
};

const extract = (provider_name) => extractEvents({
    ...WINDOW,
    settings: { chat_provider: provider_name, chat_model: 'some-model', chat_vllm_url: 'http://localhost/v1', eventbase_max_tokens: 2048 },
});

const usableEvent = JSON.stringify({ event_type: 'combat', importance: 5, summary: 'A fight breaks out.' });

describe.each(['openrouter', 'vllm'])('extractEvents through %s', (providerName) => {
    beforeEach(() => {
        provider.reply = { content: '[]', finishReason: 'stop' };
    });

    it('fails the window when the provider cut the reply, even if the parser could read part of it', async () => {
        provider.reply = { content: `[${usableEvent},{"event_type":"combat","summ`, finishReason: 'length' };

        await expect(extract(providerName)).rejects.toBeInstanceOf(EventBaseExtractionError);
        await expect(extract(providerName)).rejects.toThrow('cut at the 2048-token limit');
    });

    it('fails the window when no event in the reply is valid', async () => {
        provider.reply = { content: '[{"event_type":"combat","importance":5,"summary":""}]', finishReason: 'stop' };

        await expect(extract(providerName)).rejects.toBeInstanceOf(EventBaseExtractionError);
    });

    it('accepts an empty array as a window with no events', async () => {
        await expect(extract(providerName)).resolves.toEqual([]);
    });

    it('keeps the valid events when only some are invalid', async () => {
        provider.reply = { content: `[${usableEvent},{"event_type":"combat","importance":5,"summary":""}]`, finishReason: 'stop' };

        const events = await extract(providerName);

        expect(events).toHaveLength(1);
        expect(events[0].summary).toBe('A fight breaks out.');
    });
});
