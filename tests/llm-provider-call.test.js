/**
 * Unit tests for core/llm-provider-call.js — the shared chat-completions wire
 * path + LLM JSON-array parser now used by the summarizer, EventBase extractor,
 * agentic planner, and Auto-Reformat. None of those four had wire-level fetch
 * coverage before this module consolidated them; this is that coverage.
 *
 * Mocks ST globals + the error/connection classifiers + fetch — same
 * convention as reformat-extractor.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

// Configurable per test.
const mockGetModelConfigError = vi.fn(() => null);
vi.mock('../core/model-http-errors.js', () => ({
    getModelConfigErrorMessage: (...args) => mockGetModelConfigError(...args),
}));

const mockIsConnectionError = vi.fn(() => false);
const mockNotifyConnectionError = vi.fn();
const mockNotifyUpstreamRejection = vi.fn();
vi.mock('../core/model-config-notifier.js', () => ({
    isConnectionError: (...args) => mockIsConnectionError(...args),
    notifyConnectionError: (...args) => mockNotifyConnectionError(...args),
    notifyUpstreamRejection: (...args) => mockNotifyUpstreamRejection(...args),
}));

vi.mock('../core/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

import StringUtils from '../utils/string-utils.js';
import { postChatCompletion, parseJsonArrayFromLlm, resolveModelParameterStyle, LlmCallError } from '../core/llm-provider-call.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse({ content = '[]', finishReason = 'stop', usage = null } = {}) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ message: { content }, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
        }),
    };
}

function errorResponse(status, text = 'boom', bodyJson = null) {
    return {
        ok: false,
        status,
        statusText: text,
        text: async () => text,
        json: async () => bodyJson ?? {},
    };
}

function baseArgs(overrides = {}) {
    return {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'test/model',
        provider: 'openrouter',
        maxTokens: 100,
        temperature: 0.3,
        timeoutMs: 5000,
        contextLabel: 'TestFeature',
        ...overrides,
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
    mockGetModelConfigError.mockReturnValue(null);
    mockIsConnectionError.mockReturnValue(false);
    mockNotifyConnectionError.mockReset();
    mockNotifyUpstreamRejection.mockReset();
});

// ---------------------------------------------------------------------------
// postChatCompletion — request shaping
// ---------------------------------------------------------------------------

describe('postChatCompletion — request body', () => {
    it('routes OpenRouter through the proxy with chat_completion_source=openrouter', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: 'hi', usage: { total_tokens: 7 } }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await postChatCompletion(baseArgs());
        expect(res.content).toBe('hi');
        expect(res.usage.total_tokens).toBe(7);

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.chat_completion_source).toBe('openrouter');
        expect(body.custom_url).toBeUndefined();
        expect(body.model).toBe('test/model');
        expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
        expect(body.max_tokens).toBe(100);
        expect(body.temperature).toBe(0.3);
    });

    it('routes vLLM through the proxy with chat_completion_source=custom + custom_url', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: 'hi' }));
        vi.stubGlobal('fetch', fetchMock);

        await postChatCompletion(baseArgs({ provider: 'vllm', vllmUrl: 'http://localhost:8000' }));

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.chat_completion_source).toBe('custom');
        expect(body.custom_url).toBe('http://localhost:8000');
    });

    it('passes response_format through only when provided', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: '{}' }));
        vi.stubGlobal('fetch', fetchMock);

        await postChatCompletion(baseArgs({ responseFormat: { type: 'json_object' } }));
        let body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.response_format).toEqual({ type: 'json_object' });

        fetchMock.mockClear();
        await postChatCompletion(baseArgs());
        body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.response_format).toBeUndefined();
    });

    // Reasoning models (gpt-5.x, o1/o3/o4) reject `temperature` and `max_tokens`
    // outright — see resolveModelParameterStyle. GitHub issue #13.
    it('omits temperature entirely when sendTemperature is false', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: 'hi' }));
        vi.stubGlobal('fetch', fetchMock);

        await postChatCompletion(baseArgs({ sendTemperature: false }));

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect('temperature' in body).toBe(false);
        expect(body.max_tokens).toBe(100);
    });

    it('renames the token cap when tokenLimitParameter is max_completion_tokens', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: 'hi' }));
        vi.stubGlobal('fetch', fetchMock);

        await postChatCompletion(baseArgs({ tokenLimitParameter: 'max_completion_tokens' }));

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.max_completion_tokens).toBe(100);
        expect('max_tokens' in body).toBe(false);
    });

    it('never sends sampling params VectFox does not support', async () => {
        const fetchMock = vi.fn(async () => okResponse({ content: 'hi' }));
        vi.stubGlobal('fetch', fetchMock);

        await postChatCompletion(baseArgs());

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        for (const key of ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty']) {
            expect(key in body).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// resolveModelParameterStyle — settings → request shape
// ---------------------------------------------------------------------------

describe('resolveModelParameterStyle', () => {
    it('defaults to the classic OpenAI shape', () => {
        expect(resolveModelParameterStyle({})).toEqual({
            sendTemperature: true,
            tokenLimitParameter: 'max_tokens',
        });
    });

    it('treats a missing settings object as the default shape', () => {
        expect(resolveModelParameterStyle()).toEqual({
            sendTemperature: true,
            tokenLimitParameter: 'max_tokens',
        });
    });

    it('switches to the reasoning-model shape when both switches are set', () => {
        expect(resolveModelParameterStyle({
            should_send_temperature: false,
            should_use_max_completion_tokens: true,
        })).toEqual({
            sendTemperature: false,
            tokenLimitParameter: 'max_completion_tokens',
        });
    });

    it('resolves the two switches independently', () => {
        expect(resolveModelParameterStyle({ should_send_temperature: false }))
            .toEqual({ sendTemperature: false, tokenLimitParameter: 'max_tokens' });
        expect(resolveModelParameterStyle({ should_use_max_completion_tokens: true }))
            .toEqual({ sendTemperature: true, tokenLimitParameter: 'max_completion_tokens' });
    });
});

// ---------------------------------------------------------------------------
// postChatCompletion — error classification
// ---------------------------------------------------------------------------

describe('postChatCompletion — error classification', () => {
    it('401/403 → kind:auth when authBranch is on (default)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(401)));
        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({
            name: 'LlmCallError', kind: 'auth', status: 401,
        });
    });

    it('401 folds into http when authBranch is off and no model-config match', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(401)));
        await expect(postChatCompletion(baseArgs({ authBranch: false })))
            .rejects.toMatchObject({ kind: 'http', status: 401 });
    });

    it('maps a model-config match → kind:model_config', async () => {
        mockGetModelConfigError.mockReturnValue('model retired');
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400)));
        await expect(postChatCompletion(baseArgs()))
            .rejects.toMatchObject({ kind: 'model_config', message: 'model retired' });
    });

    it('detects a connection error → kind:connection and notifies by default', async () => {
        mockIsConnectionError.mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(502, 'ECONNREFUSED')));
        await expect(postChatCompletion(baseArgs({ provider: 'vllm', vllmUrl: 'http://x' })))
            .rejects.toMatchObject({ kind: 'connection' });
        expect(mockNotifyConnectionError).toHaveBeenCalledWith('TestFeature', 'http://x', 'ECONNREFUSED');
    });

    it('suppresses the connection toast when shouldNotifyProviderFailure=false', async () => {
        mockIsConnectionError.mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(502, 'ECONNREFUSED')));
        await expect(postChatCompletion(baseArgs({ shouldNotifyProviderFailure: false })))
            .rejects.toMatchObject({ kind: 'connection' });
        expect(mockNotifyConnectionError).not.toHaveBeenCalled();
    });

    it('other non-2xx → kind:http', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(503, 'temporarily down')));
        await expect(postChatCompletion(baseArgs()))
            .rejects.toMatchObject({ kind: 'http', status: 503 });
    });

    it('empty 200 with no model-config match → kind:empty', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse({ content: '' })));
        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({ kind: 'empty' });
    });

    it('empty 200 that is really a model error in the body → kind:model_config', async () => {
        mockGetModelConfigError.mockReturnValue('retired model in body');
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, json: async () => ({ error: { message: 'Not Found' } }),
        })));
        await expect(postChatCompletion(baseArgs()))
            .rejects.toMatchObject({ kind: 'model_config', message: 'retired model in body' });
    });

    // ST's proxy downgrades an upstream non-2xx to HTTP 200 carrying only the
    // status text. Reproduced live against OpenAI + gpt-5.6-luna: the exact body
    // below is what the browser received while the real 400 stayed server-side.
    it('200 carrying {error:{message}} → kind:upstream_error, not empty', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ error: { message: 'Bad Request' }, quota_error: false }),
        })));

        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({
            kind: 'upstream_error',
            status: 200,
        });
    });

    it('names the model and the upstream detail in the upstream_error message', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, json: async () => ({ error: { message: 'Bad Request' } }),
        })));

        await expect(postChatCompletion(baseArgs())).rejects.toThrow(/test\/model/);
        await expect(postChatCompletion(baseArgs())).rejects.toThrow(/Bad Request/);
    });

    it('raises the de-duped upstream toast, and honors shouldNotifyProviderFailure=false', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, json: async () => ({ error: { message: 'Bad Request' }, quota_error: true }),
        })));

        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({ kind: 'upstream_error' });
        expect(mockNotifyUpstreamRejection).toHaveBeenCalledWith('TestFeature', 'test/model', 'Bad Request', true);

        mockNotifyUpstreamRejection.mockReset();
        await expect(postChatCompletion(baseArgs({ shouldNotifyProviderFailure: false })))
            .rejects.toMatchObject({ kind: 'upstream_error' });
        expect(mockNotifyUpstreamRejection).not.toHaveBeenCalled();
    });

    it('still reports a genuinely empty completion as kind:empty', async () => {
        // choices present, no error anywhere → the model really did answer nothing.
        vi.stubGlobal('fetch', vi.fn(async () => okResponse({ content: '   ' })));
        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({ kind: 'empty' });
        expect(mockNotifyUpstreamRejection).not.toHaveBeenCalled();
    });

    it('treats a bare top-level {message} body as an upstream rejection too', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, json: async () => ({ message: 'Bad Request' }),
        })));
        await expect(postChatCompletion(baseArgs())).rejects.toMatchObject({ kind: 'upstream_error' });
    });
});

// ---------------------------------------------------------------------------
// parseJsonArrayFromLlm
// ---------------------------------------------------------------------------

describe('parseJsonArrayFromLlm', () => {
    const ident = { identKeys: ['name'] };

    it('parses a clean JSON array', () => {
        expect(parseJsonArrayFromLlm('[{"name":"A"},{"name":"B"}]', ident)).toHaveLength(2);
    });

    it('strips ```json code fences', () => {
        expect(parseJsonArrayFromLlm('```json\n[{"name":"A"}]\n```', ident)).toEqual([{ name: 'A' }]);
    });

    it('extracts an array embedded in prose', () => {
        const raw = 'Sure! Here are the records:\n[{"name":"A"}]\nHope that helps.';
        expect(parseJsonArrayFromLlm(raw, ident)).toEqual([{ name: 'A' }]);
    });

    it('parses NDJSON (one object per line)', () => {
        expect(parseJsonArrayFromLlm('{"name":"A"}\n{"name":"B"}', ident)).toHaveLength(2);
    });

    it('treats an empty object {} as an empty result', () => {
        expect(parseJsonArrayFromLlm('{}', ident)).toEqual([]);
    });

    it('prefers the record array over a property array', () => {
        // A wrapping object whose "items" is a bare-string array must not be
        // mistaken for the record array; the real records carry an identKey.
        const raw = '[{"name":"Hero","items":["sword"]}]';
        const out = parseJsonArrayFromLlm(raw, ident);
        expect(out).toEqual([{ name: 'Hero', items: ['sword'] }]);
    });

    it('honors custom identKeys', () => {
        const raw = '[{"entry_type":"character","name":"X","body":"..."}]';
        expect(parseJsonArrayFromLlm(raw, { identKeys: ['entry_type', 'name', 'body'] })).toHaveLength(1);
    });

    it('throws LlmCallError{kind:parse} on empty input', () => {
        expect(() => parseJsonArrayFromLlm('   ', ident)).toThrow(LlmCallError);
        try { parseJsonArrayFromLlm('', ident); } catch (e) { expect(e.kind).toBe('parse'); }
    });

    it('throws LlmCallError{kind:parse} when no usable array is found', () => {
        try {
            parseJsonArrayFromLlm('the model refused to answer', ident);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(LlmCallError);
            expect(e.kind).toBe('parse');
        }
    });
});

// ---------------------------------------------------------------------------
// StringUtils.ensureArray (the shared string-array coercion)
// ---------------------------------------------------------------------------

describe('StringUtils.ensureArray', () => {
    it('trims, dedupes, and drops empties', () => {
        expect(StringUtils.ensureArray([' a ', 'a', '', 'b', '  '])).toEqual(['a', 'b']);
    });
    it('returns [] for non-arrays', () => {
        expect(StringUtils.ensureArray(null)).toEqual([]);
        expect(StringUtils.ensureArray('x')).toEqual([]);
        expect(StringUtils.ensureArray(undefined)).toEqual([]);
    });
    it('coerces non-string members via String()', () => {
        expect(StringUtils.ensureArray([1, 2, 2, null])).toEqual(['1', '2']);
    });
});
