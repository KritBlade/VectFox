/**
 * The key is optional on the manual vLLM route (GitHub issue #37), as a server such as KoboldCpp needs none. With no
 * key saved, the shared connection check (src/features/llm-provider/llm-connection.js), which Agent Mode, StoryArc and
 * LoreBase resolve through, and EventBase's extraction call (src/features/eventbase/eventbase-extractor.js) go on and
 * send the call. OpenRouter, which always needs a key, is the control: with the same empty key slots it stops.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postChatCompletionMock = vi.hoisted(() => vi.fn());

// No key saved in any slot.
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => '', getCustomApiKey: () => '' }));
vi.mock('../src/features/llm-provider/llm-provider-call.js', () => ({ checkConnectionProfile: vi.fn() }));
vi.mock('../src/features/llm-provider/index.js', async () => ({
    LLM_CALL_FEATURES: (await vi.importActual('../src/features/llm-provider/llm-call-report.js')).LLM_CALL_FEATURES,
    CONNECTION_TEST_MAX_TOKENS: 16,
    CONNECTION_TEST_PROMPT: 'Reply with OK.',
    CONNECTION_TEST_TIMEOUT_MS: 1000,
    LlmCallError: class LlmCallError extends Error {},
    parseJsonArrayFromLlm: text => JSON.parse(text),
    postChatCompletion: (...args) => postChatCompletionMock(...args),
    resolveModelParameterStyle: () => ({}),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: text => text, stripGameSystemBlocks: text => text, stripReasoningBlocks: text => text }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));

const { resolveLlmConnection } = await import('../src/features/llm-provider/llm-connection.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

const LOCAL_SERVER = 'http://127.0.0.1:5001/v1';

beforeEach(() => {
    postChatCompletionMock.mockReset();
    postChatCompletionMock.mockResolvedValue({ content: '[]', finishReason: 'stop' });
});

describe('the shared connection check with no key saved', () => {
    it('runs a vLLM connection, with its model and URL', () => {
        expect(resolveLlmConnection({ provider: 'vllm', model: 'koboldcpp/served-model', vllmUrl: LOCAL_SERVER, feature: 'Agent Mode', page: 'AgentMode' }))
            .toEqual({ ok: true, provider: 'vllm', model: 'koboldcpp/served-model', vllmUrl: LOCAL_SERVER });
    });

    it('still stops a vLLM connection with no URL', () => {
        expect(resolveLlmConnection({ provider: 'vllm', model: 'koboldcpp/served-model', vllmUrl: '', feature: 'Agent Mode', page: 'AgentMode' }))
            .toEqual({ ok: false, reason: 'missing_vllm_url' });
    });

    it('stops an OpenRouter connection, which needs its key', () => {
        expect(resolveLlmConnection({ provider: 'openrouter', model: 'openai/gpt-4o-mini', feature: 'Agent Mode', page: 'AgentMode' }))
            .toEqual({ ok: false, reason: 'missing_openrouter_api_key' });
    });
});

describe("EventBase's extraction with no key saved", () => {
    const extract = settings => extractEvents({
        messages: [{ name: 'User', mes: 'hello' }, { name: 'Bot', mes: 'hi there' }],
        windowStart: 0,
        windowEnd: 1,
        settings: { chat_model: 'koboldcpp/served-model', chat_vllm_url: LOCAL_SERVER, ...settings },
    });

    it('sends the window to the vLLM server', async () => {
        await expect(extract({ chat_provider: 'vllm' })).resolves.toEqual([]);
        expect(postChatCompletionMock).toHaveBeenCalledOnce();
        expect(postChatCompletionMock).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'vllm', model: 'koboldcpp/served-model', vllmUrl: LOCAL_SERVER,
        }));
    });

    it('stops on OpenRouter before sending, as OpenRouter needs its key', async () => {
        await expect(extract({ chat_provider: 'openrouter' })).rejects.toMatchObject({ name: 'EventBaseFatalError', code: 'missing_api_key' });
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });
});
