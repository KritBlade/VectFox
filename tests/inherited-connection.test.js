/**
 * The connection Agent Mode and Auto-Reformat take from the EventBase model
 * (src/features/llm-provider/inherited-connection.js): Same as EventBase model runs on the EventBase model's provider
 * and Base URL, never the consumer's own hidden Base URL; a blank model takes the EventBase model's on any provider,
 * and a typed one replaces only the model; a consumer on vLLM with no Base URL of its own takes the EventBase model's.
 */

import { describe, expect, it } from 'vitest';
import { resolveInheritedConnection } from '../src/features/llm-provider/inherited-connection.js';

const EVENTBASE_MODEL = { chat_provider: 'vllm', chat_model: 'eventbase-model', chat_vllm_url: 'http://eventbase-host:8000/v1' };

describe('resolveInheritedConnection', () => {
    it('runs Same as EventBase model on the EventBase model\'s whole connection', () => {
        expect(resolveInheritedConnection({ provider: '', model: '', vllmUrl: '' }, EVENTBASE_MODEL))
            .toEqual({ provider: 'vllm', model: 'eventbase-model', vllmUrl: 'http://eventbase-host:8000/v1' });
    });

    it('leaves out the consumer\'s own Base URL under Same as EventBase model, where its row is hidden', () => {
        expect(resolveInheritedConnection({ provider: '', vllmUrl: 'http://old-host:8000/v1' }, EVENTBASE_MODEL).vllmUrl)
            .toBe('http://eventbase-host:8000/v1');
    });

    it('replaces only the model with a typed one, on the EventBase model\'s provider', () => {
        expect(resolveInheritedConnection({ provider: '', model: 'planner-model' }, EVENTBASE_MODEL))
            .toEqual({ provider: 'vllm', model: 'planner-model', vllmUrl: 'http://eventbase-host:8000/v1' });
    });

    it('takes the EventBase model\'s model for a blank or spaces-only box, on any provider', () => {
        for (const own of [{ provider: '' }, { provider: '', model: '   ' }, { provider: 'openrouter', model: '' }, { provider: 'vllm', model: undefined }]) {
            expect(resolveInheritedConnection(own, EVENTBASE_MODEL).model, JSON.stringify(own)).toBe('eventbase-model');
        }
    });

    it('keeps the consumer\'s own provider and Base URL when it picks vLLM itself, and fills a blank URL from the EventBase model', () => {
        expect(resolveInheritedConnection({ provider: 'vLLM', vllmUrl: ' http://own-host:9000/v1 ' }, EVENTBASE_MODEL))
            .toEqual({ provider: 'vllm', model: 'eventbase-model', vllmUrl: 'http://own-host:9000/v1' });
        expect(resolveInheritedConnection({ provider: 'vllm', vllmUrl: '' }, EVENTBASE_MODEL).vllmUrl).toBe('http://eventbase-host:8000/v1');
    });

    it('runs on OpenRouter when neither the consumer nor the EventBase model names a provider, with nothing set left empty', () => {
        expect(resolveInheritedConnection({}, {})).toEqual({ provider: 'openrouter', model: '', vllmUrl: '' });
    });
});
