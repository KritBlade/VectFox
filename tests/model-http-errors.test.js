import { describe, expect, it } from 'vitest';

import { getModelConfigErrorMessage } from '../src/shared/model-http-errors.js';

describe('getModelConfigErrorMessage', () => {
    it('classifies OpenRouter deprecated model 404 responses as fatal model config errors', () => {
        const message = getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'OpenRouter',
            model: 'x-ai/grok-4.1-fast',
            status: 404,
            responseText: 'Grok 4.1 Fast is deprecated. Please switch to Grok 4.3.',
        });

        expect(message).toContain('EventBase');
        expect(message).toContain('OpenRouter');
        expect(message).toContain('x-ai/grok-4.1-fast');
        expect(message).toContain('HTTP 404');
        expect(message).toContain('Grok 4.1 Fast is deprecated');
    });

    it('classifies vLLM missing model 400 responses as fatal model config errors', () => {
        const message = getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'vLLM',
            model: 'missing-model',
            status: 400,
            responseText: 'No endpoints found for model missing-model.',
        });

        expect(message).toContain('vLLM');
        expect(message).toContain('missing-model');
        expect(message).toContain('HTTP 400');
        expect(message).toContain('No endpoints found');
    });

    it('uses the caller-supplied contextLabel as the message prefix', () => {
        const message = getModelConfigErrorMessage({
            contextLabel: 'Embedding',
            provider: 'OpenRouter',
            model: 'qwen/qwen3-embedding-8b',
            status: 404,
            responseText: 'No endpoints found for qwen/qwen3-embedding-8b.',
        });

        expect(message.startsWith('Embedding:')).toBe(true);
    });

    it('classifies "model does not exist" and snake_case "model_not_found" as fatal', () => {
        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'openai/gpt-foo',
            status: 404,
            responseText: 'The model `openai/gpt-foo` does not exist or you do not have access to it.',
        })).toContain('openai/gpt-foo');

        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'x/y',
            status: 404,
            responseText: '{"error":{"code":"model_not_found"}}',
        })).toContain('HTTP 404');
    });

    it('leaves non-model provider failures as per-window extraction failures', () => {
        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'anthropic/claude-haiku-4-5',
            status: 500,
            responseText: 'upstream overloaded',
        })).toBeNull();

        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'anthropic/claude-haiku-4-5',
            status: 429,
            responseText: 'rate limited for this model',
        })).toBeNull();
    });

    it('does NOT promote per-window 400s (context-length, content-policy) to fatal', () => {
        // context_length_exceeded is HTTP 400 and mentions "model's maximum context
        // length" — it is a per-window problem, not a config error, so must stay a skip.
        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'openai/gpt-4o-mini',
            status: 400,
            responseText: "This model's maximum context length is 8192 tokens, however you requested 9001.",
        })).toBeNull();

        // content/safety moderation refusal that happens to mention "model".
        expect(getModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'openai/gpt-4o-mini',
            status: 400,
            responseText: 'The model produced content that violates the usage policy.',
        })).toBeNull();
    });

    it('can bypass the 400/404 status gate for plugin-wrapped embedding errors (HTTP 500)', () => {
        // similharity may wrap a model error as HTTP 500 — with enforceStatusGate:false
        // we classify on the forwarded text alone.
        expect(getModelConfigErrorMessage({
            contextLabel: 'Embedding',
            provider: 'OpenRouter',
            model: 'qwen/qwen3-embedding-8b',
            status: 500,
            responseText: 'No endpoints found for qwen/qwen3-embedding-8b.',
            enforceStatusGate: false,
        })).toContain('Embedding');

        // still null for a genuine transient 500 with no model-config signal.
        expect(getModelConfigErrorMessage({
            contextLabel: 'Embedding',
            provider: 'OpenRouter',
            model: 'qwen/qwen3-embedding-8b',
            status: 500,
            responseText: 'upstream overloaded',
            enforceStatusGate: false,
        })).toBeNull();
    });

    it('catches OpenRouter\'s HTTP-200 "Not Found" body but NOT a genuinely empty reply', () => {
        // Real-world: OpenRouter via ST's proxy returns 200 + {"message":"Not Found"}
        // for a retired/unknown model. We must catch the error text...
        expect(getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'OpenRouter',
            model: 'x-ai/grok-4.1-fast',
            status: 200,
            responseText: '{"message":"Not Found"}',
            enforceStatusGate: false,
        })).toContain('x-ai/grok-4.1-fast');

        // ...but a genuinely empty 200 (no content, no error) must stay a per-window
        // skip, never a hard stop — we can't fail just because the body was empty.
        expect(getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'OpenRouter',
            model: 'openai/gpt-4o-mini',
            status: 200,
            responseText: '{"choices":[]}',
            enforceStatusGate: false,
        })).toBeNull();
    });
});
