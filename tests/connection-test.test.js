/**
 * The EventBase model's Test connection, and the message every chat consumer's test sends
 * (src/features/llm-provider/connection-test.js, connection plan §1): a test sends one fixed line and never chat text,
 * with room for a model that thinks; the EventBase model sends it through its own call for the chosen provider, so its
 * checks and messages are the ones a run gives; and the shared sender raises no toast of its own and passes on a cut
 * the provider made. The provider's reply is made up: postChatCompletion is the one part replaced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ reply: null, calls: [] }));

vi.mock('../src/features/llm-provider/llm-provider-call.js', async () => ({
    ...(await vi.importActual('../src/features/llm-provider/llm-provider-call.js')),
    postChatCompletion: vi.fn(async (request) => {
        provider.calls.push(request);
        return provider.reply;
    }),
}));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ getContext: () => ({}) }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: {}, deleteSecret: vi.fn(), readSecretState: vi.fn(), secret_state: {}, writeSecret: vi.fn() }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'masked', getCustomApiKey: () => 'masked' }));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: text => text, stripGameSystemBlocks: text => text, stripReasoningBlocks: text => text }));
vi.mock('../src/features/eventbase/eventbase-message-hash.js', () => ({ hashSourceMessage: message => message.mes.length }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

const { CONNECTION_TEST_MAX_TOKENS, CONNECTION_TEST_PROMPT, CONNECTION_TEST_TIMEOUT_MS, sendConnectionTest } = await import('../src/features/llm-provider/connection-test.js');
const { testEventBaseConnection } = await import('../src/features/eventbase/eventbase-extractor.js');

const TEST_MESSAGES = [{ role: 'user', content: CONNECTION_TEST_PROMPT }];

beforeEach(() => {
    provider.reply = { content: 'OK', finishReason: 'stop', cutReason: null, usage: null, data: {} };
    provider.calls = [];
});

describe('the connection test message', () => {
    it('is one fixed line, with room for a model that thinks before it answers', () => {
        expect(CONNECTION_TEST_PROMPT).toBe('This is a connection test from VectFox. Reply with the single word OK.');
        expect(CONNECTION_TEST_MAX_TOKENS).toBe(1024);
        expect(CONNECTION_TEST_TIMEOUT_MS).toBe(60000);
    });

    it('goes out on the route a consumer resolved, with its request switches, and raises no toast of its own', async () => {
        const reply = await sendConnectionTest(
            { provider: 'connection_profile', connectionProfileId: 'p-harbor', connectionProfilePage: 'AgentMode', ok: true },
            { contextLabel: 'Agent Mode', feature: 'agent', parameterStyle: { sendTemperature: false, tokenLimitParameter: 'max_completion_tokens', reasoningEffort: 'none' } },
        );
        expect(reply).toEqual({ content: 'OK', cutReason: null });
        expect(provider.calls).toEqual([{
            feature: 'agent', messages: TEST_MESSAGES, model: undefined, provider: 'connection_profile', vllmUrl: '', connectionProfileId: 'p-harbor',
            connectionProfilePage: 'AgentMode', maxTokens: CONNECTION_TEST_MAX_TOKENS, temperature: 0, timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
            contextLabel: 'Agent Mode', shouldNotifyProviderFailure: false, sendTemperature: false, tokenLimitParameter: 'max_completion_tokens',
            reasoningEffort: 'none',
        }]);
    });

    it('passes on a cut the provider made, for the button to report', async () => {
        provider.reply = { content: 'OK', finishReason: 'length', cutReason: 'length', usage: null, data: {} };
        await expect(sendConnectionTest({ provider: 'openrouter', model: 'harbor-chat', ok: true }, { contextLabel: 'StoryArc', feature: 'storyarc' }))
            .resolves.toEqual({ content: 'OK', cutReason: 'length' });
        expect(provider.calls).toHaveLength(1);
    });
});

describe('the EventBase model\'s Test connection', () => {
    it('sends the test message through the chosen provider\'s own call, on the panel\'s settings', async () => {
        const settings = { chat_provider: 'vllm', chat_model: 'harbor-chat', chat_vllm_url: 'http://harbor.local/v1', eventbase_max_tokens: 4096, eventbase_timeout_ms: 90000 };
        await expect(testEventBaseConnection(settings)).resolves.toEqual({ content: 'OK', cutReason: null });
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]).toMatchObject({
            messages: TEST_MESSAGES, provider: 'vllm', model: 'harbor-chat', vllmUrl: 'http://harbor.local/v1',
            maxTokens: CONNECTION_TEST_MAX_TOKENS, timeoutMs: CONNECTION_TEST_TIMEOUT_MS, contextLabel: 'EventBase', feature: 'eventbase',
        });
        expect(settings).toMatchObject({ eventbase_max_tokens: 4096, eventbase_timeout_ms: 90000 });
    });

    it('runs on the EventBase model\'s profile when it is on one', async () => {
        await testEventBaseConnection({ chat_provider: 'connection_profile', chat_connection_profile_id: 'p-harbor' });
        expect(provider.calls[0]).toMatchObject({ messages: TEST_MESSAGES, provider: 'connection_profile', connectionProfileId: 'p-harbor', connectionProfilePage: 'Core' });
    });

    it('stops with the run\'s own message on a missing model or an unknown provider, and sends nothing', async () => {
        await expect(testEventBaseConnection({ chat_provider: 'openrouter', chat_model: '' }))
            .rejects.toThrow('EventBase: No model configured. Set the Model in Core → EventBase model.');
        await expect(testEventBaseConnection({ chat_provider: 'cohere' }))
            .rejects.toThrow('EventBase: provider "cohere" is not one VectFox knows. Choose one in Core → EventBase model.');
        expect(provider.calls).toEqual([]);
    });
});
