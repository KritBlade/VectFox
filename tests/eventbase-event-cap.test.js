/**
 * A window's events are capped at eventbase_max_events_per_window, 3 when the setting is missing, as it defaults to:
 * the prompt asks for at most that many, and a longer reply keeps its most important events.
 *
 * Drives the real extractEvents and schema; only the provider call and ST are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = vi.hoisted(() => ({ prompts: [], reply: '[]' }));

vi.mock('../src/features/llm-provider/index.js', async () => {
    const parser = await vi.importActual('../src/features/llm-provider/llm-provider-call.js');
    return {
        parseJsonArrayFromLlm: parser.parseJsonArrayFromLlm,
        LlmCallError: parser.LlmCallError,
        resolveModelParameterStyle: () => ({}),
        postChatCompletion: vi.fn(async ({ messages }) => {
            sent.prompts.push(messages[0].content);
            return { content: sent.reply, finishReason: 'stop' };
        }),
    };
});
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/model-http-errors.js', () => ({ getModelConfigErrorMessage: () => null }));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isConnectionError: () => false, notifyConnectionError: vi.fn(), notifyUpstreamRejection: vi.fn(),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: text => text, stripGameSystemBlocks: text => text, stripReasoningBlocks: text => text }));
vi.mock('../src/features/eventbase/eventbase-message-hash.js', () => ({ hashSourceMessage: message => message.mes.length }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));

const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

const messages = [
    { name: 'Narrator', mes: 'Rose finds the harbour map in the old tower.' },
    { name: 'Narrator', mes: 'Tom swears to keep it from the guild.' },
];
const extract = settings => extractEvents({
    messages, windowStart: 0, windowEnd: 1, settings: { chat_provider: 'openrouter', chat_model: 'some-model', ...settings },
});
const eventOf = importance => ({ event_type: 'discovery', importance, summary: `Rose finds a clue worth ${importance}.` });

describe('the per-window event cap', () => {
    beforeEach(() => {
        sent.prompts.length = 0;
        sent.reply = '[]';
    });

    it('asks for at most 3 events when the setting is missing', async () => {
        await extract({});
        expect(sent.prompts[0]).toContain('Return AT MOST 3 events.');
    });

    it('asks for at most the set number of events', async () => {
        await extract({ eventbase_max_events_per_window: 8 });
        expect(sent.prompts[0]).toContain('Return AT MOST 8 events.');
    });

    it('keeps the 3 most important events of a longer reply when the setting is missing', async () => {
        sent.reply = JSON.stringify([2, 9, 4, 7, 5].map(eventOf));
        const events = await extract({});
        expect(events.map(event => event.importance).sort((a, b) => b - a)).toEqual([9, 7, 5]);
    });
});
