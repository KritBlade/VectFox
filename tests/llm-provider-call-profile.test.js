/**
 * postChatCompletion on a SillyTavern connection profile (src/features/llm-provider/llm-provider-call.js, connection
 * plan §2 and §4): the profile is checked before any request, SillyTavern sends the request with the profile's URL and
 * key and VectFox's closed set of override keys, each reply shape §2 names is read, a reply with no text goes through
 * the manual path's own handling, and a failed request becomes the kind its callers act on.
 *
 * SillyTavern's reply reader is copied below from 1.19.0 (public/script.js extractMessageFromData, the two APIs a
 * profile request uses), so the shapes are read as SillyTavern reads them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

const notices = vi.hoisted(() => ({ connection: vi.fn(), upstream: vi.fn() }));
vi.mock('../src/shared/model-config-notifier.js', async () => ({
    ...(await vi.importActual('../src/shared/model-config-notifier.js')),
    notifyConnectionError: (...args) => notices.connection(...args),
    notifyUpstreamRejection: (...args) => notices.upstream(...args),
}));

const { LlmCallError, postChatCompletion } = await import('../src/features/llm-provider/llm-provider-call.js');

function extractMessageFromData(data, activeApi) {
    const result = (() => {
        if (typeof data === 'string') return data;
        switch (activeApi) {
            case 'textgenerationwebui':
                return data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data[0]?.content ?? '';
            case 'openai':
                return data?.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join('\n\n') ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.text ?? data?.message?.content?.[0]?.text ?? data?.message?.tool_plan ?? '';
            default:
                return '';
        }
    })();
    return Array.isArray(result) ? result.map(x => x.text).filter(x => x).join('') : result;
}

const CONNECT_API_MAP = {
    custom: { selected: 'openai', source: 'custom' },
    claude: { selected: 'openai', source: 'claude' },
    cohere: { selected: 'openai', source: 'cohere' },
    llamacpp: { selected: 'textgenerationwebui', type: 'llamacpp' },
    ollama: { selected: 'textgenerationwebui', type: 'ollama' },
};
const PROFILES = {
    custom: { id: 'p-custom', name: 'Harbor custom', api: 'custom', model: 'harbor-model', 'secret-id': 'secret-3' },
    claude: { id: 'p-claude', name: 'Harbor claude', api: 'claude', model: 'claude-model', 'secret-id': 'secret-4' },
    cohere: { id: 'p-cohere', name: 'Harbor cohere', api: 'cohere', model: 'command-model', 'secret-id': 'secret-5' },
    llamacpp: { id: 'p-llama', name: 'Harbor llama', api: 'llamacpp', model: '' },
    ollama: { id: 'p-ollama', name: 'Harbor ollama', api: 'ollama', model: 'harbor-text' },
};

const host = vi.hoisted(() => ({ context: null, reply: null, failure: null }));

beforeEach(() => {
    notices.connection.mockClear();
    notices.upstream.mockClear();
    host.reply = { choices: [{ message: { content: '[{"name":"gate"}]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
    host.failure = null;
    host.context = {
        extensionSettings: { disabledExtensions: [], connectionManager: { profiles: Object.values(PROFILES) } },
        CONNECT_API_MAP,
        extractMessageFromData,
        ConnectionManagerRequestService: {
            isProfileSupported: profile => ['openai', 'textgenerationwebui'].includes(CONNECT_API_MAP[profile.api].selected),
            sendRequest: vi.fn(async () => {
                if (host.failure) throw host.failure;
                return host.reply;
            }),
        },
    };
    vi.stubGlobal('SillyTavern', { getContext: () => host.context });
});

const call = (profile, extra = {}) => postChatCompletion({
    messages: [{ role: 'user', content: 'Read this window.' }],
    provider: 'connection_profile',
    connectionProfileId: profile.id,
    connectionProfilePage: 'Core',
    maxTokens: 900,
    temperature: 0.2,
    timeoutMs: 5000,
    contextLabel: 'EventBase',
    sendTemperature: true,
    tokenLimitParameter: 'max_completion_tokens',
    reasoningEffort: 'none',
    responseFormat: { type: 'json_object' },
    ...extra,
});
const sentRequest = () => host.context.ConnectionManagerRequestService.sendRequest.mock.calls[0];
const failed = (message, name = 'Error') => Object.assign(new Error('API request failed'), { cause: Object.assign(new Error(message), { name }) });

describe('a chat call on a connection profile', () => {
    it('sends the messages on the profile with only the closed override keys, and reads an OpenAI-style reply', async () => {
        const reply = await call(PROFILES.custom);
        expect(reply).toMatchObject({ content: '[{"name":"gate"}]', finishReason: 'stop', usage: { total_tokens: 14 } });
        const [profileId, messages, maxTokens, custom, overridePayload] = sentRequest();
        expect([profileId, messages[0].content, maxTokens]).toEqual(['p-custom', 'Read this window.', undefined]);
        expect(custom).toMatchObject({ includePreset: false, extractData: false });
        expect(overridePayload).toEqual({ temperature: 0.2, max_completion_tokens: 900, reasoning_effort: 'none', response_format: { type: 'json_object' } });
    });

    it('reads Claude\'s content array', async () => {
        host.reply = { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '[{"name":"bell"}]' }], stop_reason: 'end_turn' };
        expect((await call(PROFILES.claude)).content).toBe('[{"name":"bell"}]');
    });

    it('reads a Text Completion reply, llama.cpp\'s content and Ollama\'s response, sending only temperature, the max tokens as num_predict and n_predict, and the no-key ID', async () => {
        host.reply = { choices: [{ text: '[{"name":"lamp"}]', finish_reason: 'stop' }] };
        expect((await call(PROFILES.ollama)).content).toBe('[{"name":"lamp"}]');
        const [, , maxTokens, , overridePayload] = sentRequest();
        expect(maxTokens).toBe(900);
        expect(Object.keys(overridePayload).sort()).toEqual(['n_predict', 'num_predict', 'secret_id', 'temperature']);
        expect(overridePayload).toMatchObject({ num_predict: 900, n_predict: 900 });

        host.reply = { content: '[{"name":"rope"}]' };
        expect((await call(PROFILES.llamacpp)).content).toBe('[{"name":"rope"}]');
        host.reply = { response: '[{"name":"oar"}]' };
        expect((await call(PROFILES.ollama)).content).toBe('[{"name":"oar"}]');
    });

    it('reads a cut in Ollama\'s, llama.cpp\'s and Cohere\'s own replies, and a finished one as finished', async () => {
        host.reply = { response: '[{"name":"o', done: true, done_reason: 'length' };
        await expect(call(PROFILES.ollama)).resolves.toMatchObject({ content: '[{"name":"o', finishReason: 'length', cutReason: 'length' });
        host.reply = { response: '[{"name":"oar"}]', done: true, done_reason: 'stop' };
        await expect(call(PROFILES.ollama)).resolves.toMatchObject({ finishReason: 'stop', cutReason: null });

        host.reply = { content: '[{"name":"ro', stop: true, stop_type: 'limit' };
        await expect(call(PROFILES.llamacpp)).resolves.toMatchObject({ finishReason: 'length', cutReason: 'length (native: limit)' });
        host.reply = { content: '[{"name":"rope"}]', stop: true, stop_type: 'eos' };
        await expect(call(PROFILES.llamacpp)).resolves.toMatchObject({ finishReason: 'stop', cutReason: null });

        host.reply = { finish_reason: 'MAX_TOKENS', message: { role: 'assistant', content: [{ type: 'text', text: '[{"name":"ke' }] } };
        await expect(call(PROFILES.cohere)).resolves.toMatchObject({ content: '[{"name":"ke', finishReason: 'length', cutReason: 'length (native: MAX_TOKENS)' });
        host.reply = { finish_reason: 'COMPLETE', message: { role: 'assistant', content: [{ type: 'text', text: '[{"name":"keel"}]' }] } };
        await expect(call(PROFILES.cohere)).resolves.toMatchObject({ finishReason: 'stop', cutReason: null });
    });

    it('treats a budget spent before the answer as the manual path does', async () => {
        host.reply = { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens_details: { reasoning_tokens: 880 } } };
        await expect(call(PROFILES.custom)).rejects.toMatchObject({ kind: 'model_config', message: expect.stringContaining('880 of them on reasoning') });
    });

    it('reads a cut and a refusal as the manual path does', async () => {
        host.reply = { choices: [{ message: { content: '[{"name":"ga' }, finish_reason: 'content_filter', native_finish_reason: 'SAFETY' }] };
        await expect(call(PROFILES.custom)).resolves.toMatchObject({ content: '[{"name":"ga', cutReason: 'content_filter (native: SAFETY)' });

        host.reply = { choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }], usage: { completion_tokens: 2 } };
        await expect(call(PROFILES.custom)).rejects.toMatchObject({
            kind: 'empty', message: 'EventBase: profile "Harbor custom" returned no text for model "harbor-model" — finish_reason "stop" · refusal "No." · 2 output tokens',
        });
    });

    it('sees no stop reason in Claude\'s reply, which SillyTavern rewraps without it', async () => {
        host.reply = { choices: [{ message: { content: '[{"name":"bell"}]' } }], content: [{ type: 'text', text: '[{"name":"bell"}]' }] };
        await expect(call(PROFILES.claude)).resolves.toMatchObject({ finishReason: null, cutReason: null });
    });

    it('treats an upstream rejection in a body with no text as the manual path does', async () => {
        host.reply = { error: { message: 'Bad Request' } };
        await expect(call(PROFILES.custom)).rejects.toMatchObject({ kind: 'upstream_error', message: 'EventBase: profile "Harbor custom" rejected the request for model "harbor-model" — Bad Request' });
        expect(notices.upstream).toHaveBeenCalledTimes(1);
    });
});

describe('a profile call that cannot run', () => {
    it('stops before any request when the profile is gone or the Connection Manager is off', async () => {
        await expect(call({ id: 'p-deleted' })).rejects.toMatchObject({ kind: 'model_config', message: expect.stringContaining('was deleted in SillyTavern') });
        host.context.extensionSettings.disabledExtensions = ['connection-manager'];
        await expect(call(PROFILES.custom)).rejects.toBeInstanceOf(LlmCallError);
        expect(host.context.ConnectionManagerRequestService.sendRequest).not.toHaveBeenCalled();
    });

    it('turns a rejected key into the key message, a configuration error that pauses auto-sync', async () => {
        host.failure = failed('Unauthorized');
        await expect(call(PROFILES.custom)).rejects.toMatchObject({ kind: 'model_config', message: expect.stringContaining('rejected the API key for profile "Harbor custom"') });
    });

    it('turns an unreachable server into a connection failure and says so once', async () => {
        host.failure = failed('Connection refused: 127.0.0.1:8080');
        await expect(call(PROFILES.custom)).rejects.toMatchObject({ kind: 'connection' });
        expect(notices.connection).toHaveBeenCalledWith('EventBase', 'profile "Harbor custom"', 'Connection refused: 127.0.0.1:8080');
    });

    it('rethrows a timeout as the manual path does', async () => {
        host.failure = failed('signal timed out', 'TimeoutError');
        await expect(call(PROFILES.custom)).rejects.toMatchObject({ name: 'TimeoutError' });
    });
});
