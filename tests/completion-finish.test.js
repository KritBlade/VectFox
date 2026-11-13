/**
 * Why a chat completion stopped (src/features/llm-provider/completion-finish.js): the finish reason in OpenAI's words,
 * Ollama's, llama.cpp's and Cohere's own replies included, whether it means the provider cut the reply, and what a reply
 * with no text held.
 */

import { describe, expect, it } from 'vitest';
import { completionCutReason, completionFinishReason, describeNoTextAnswer } from '../src/features/llm-provider/completion-finish.js';

const reply = (choice, extra = {}) => ({ choices: [{ message: { content: 'text' }, ...choice }], ...extra });
// The servers' own replies, as SillyTavern 1.19.0 hands them back: Ollama's /api/generate, llama.cpp's /completion and
// Cohere's v2 chat.
const ollamaReply = doneReason => ({ model: 'harbor-model', response: 'text', done: true, done_reason: doneReason });
const llamaCppReply = stopType => ({ content: 'text', stop: true, stop_type: stopType, stopping_word: '' });
const cohereReply = finishReason => ({ id: 'reply-1', finish_reason: finishReason, message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] } });

describe('completionFinishReason', () => {
    it('reads the first choice\'s finish reason, and gives nothing where a reply has none', () => {
        expect(completionFinishReason(reply({ finish_reason: 'content_filter' }))).toBe('content_filter');
        expect(completionFinishReason(reply({}))).toBe('');
        expect(completionFinishReason({ content: [{ type: 'text', text: 'Claude, rewrapped' }] })).toBe('');
        expect(completionFinishReason('a string')).toBe('');
        expect(completionFinishReason(null)).toBe('');
    });

    it('reads Ollama\'s done_reason as it is, as it already uses OpenAI\'s words', () => {
        expect(completionFinishReason(ollamaReply('length'))).toBe('length');
        expect(completionFinishReason(ollamaReply('stop'))).toBe('stop');
    });

    it('reads llama.cpp\'s stop_type in OpenAI\'s words', () => {
        expect(completionFinishReason(llamaCppReply('limit'))).toBe('length');
        expect(completionFinishReason(llamaCppReply('eos'))).toBe('stop');
        expect(completionFinishReason(llamaCppReply('word'))).toBe('stop');
        expect(completionFinishReason(llamaCppReply('none'))).toBe('none');
    });

    it('reads Cohere\'s finish_reason in OpenAI\'s words', () => {
        expect(completionFinishReason(cohereReply('MAX_TOKENS'))).toBe('length');
        expect(completionFinishReason(cohereReply('COMPLETE'))).toBe('stop');
        expect(completionFinishReason(cohereReply('STOP_SEQUENCE'))).toBe('stop');
        expect(completionFinishReason(cohereReply('TOOL_CALL'))).toBe('tool_calls');
        expect(completionFinishReason(cohereReply('ERROR'))).toBe('ERROR');
    });

    it('reads the choices first, where a reply has them', () => {
        expect(completionFinishReason(reply({ finish_reason: 'stop' }, { finish_reason: 'MAX_TOKENS', done_reason: 'length', stop_type: 'limit' }))).toBe('stop');
        expect(completionFinishReason({ done_reason: 'stop', stop_type: 'limit', finish_reason: 'MAX_TOKENS' })).toBe('stop');
        expect(completionFinishReason({ stop_type: 'eos', finish_reason: 'MAX_TOKENS' })).toBe('stop');
    });
});

describe('completionCutReason', () => {
    it('gives nothing for a reply the model finished', () => {
        for (const reason of ['stop', 'STOP', 'end_turn', 'tool_calls', 'function_call']) {
            expect(completionCutReason(reply({ finish_reason: reason })), reason).toBe('');
        }
        expect(completionCutReason(reply({}))).toBe('');
    });

    it('names a cut, with the provider\'s own reason where it says more', () => {
        expect(completionCutReason(reply({ finish_reason: 'length' }))).toBe('length');
        expect(completionCutReason(reply({ finish_reason: 'content_filter', native_finish_reason: 'SAFETY' }))).toBe('content_filter (native: SAFETY)');
        expect(completionCutReason(reply({ finish_reason: 'content_filter', native_finish_reason: 'CONTENT_FILTER' }))).toBe('content_filter');
        expect(completionCutReason(reply({ finish_reason: 'stop', native_finish_reason: 'SAFETY' }))).toBe('');
    });

    it('names a cut on Ollama, llama.cpp and Cohere, the server\'s own word beside a translated one', () => {
        expect(completionCutReason(ollamaReply('length'))).toBe('length');
        expect(completionCutReason(llamaCppReply('limit'))).toBe('length (native: limit)');
        expect(completionCutReason(llamaCppReply('none'))).toBe('none');
        expect(completionCutReason(cohereReply('MAX_TOKENS'))).toBe('length (native: MAX_TOKENS)');
        expect(completionCutReason(cohereReply('ERROR'))).toBe('ERROR');
        expect(completionCutReason(cohereReply('TIMEOUT'))).toBe('TIMEOUT');
    });

    it('gives nothing for a reply Ollama, llama.cpp or Cohere finished', () => {
        expect(completionCutReason(ollamaReply('stop'))).toBe('');
        for (const stopType of ['eos', 'word']) expect(completionCutReason(llamaCppReply(stopType)), stopType).toBe('');
        for (const finishReason of ['COMPLETE', 'STOP_SEQUENCE', 'TOOL_CALL']) {
            expect(completionCutReason(cohereReply(finishReason)), finishReason).toBe('');
        }
    });
});

describe('describeNoTextAnswer', () => {
    it('names the finish reason, the refusal and the tokens spent', () => {
        const refused = reply(
            { message: { content: null, refusal: 'I can\'t help with that.' }, finish_reason: 'stop' },
            { usage: { completion_tokens: 9 } },
        );
        expect(describeNoTextAnswer(refused)).toBe('finish_reason "stop" · refusal "I can\'t help with that." · 9 output tokens');
        const once = reply({ message: { content: '' }, finish_reason: 'stop', native_finish_reason: 'completed' }, { usage: { completion_tokens: 1 } });
        expect(describeNoTextAnswer(once)).toBe('finish_reason "stop" (native: completed) · 1 output token');
    });

    it('names a filter\'s cut and the tokens spent on reasoning', () => {
        const filtered = reply(
            { message: { content: '' }, finish_reason: 'content_filter', native_finish_reason: 'SAFETY' },
            { usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 40 } } },
        );
        expect(describeNoTextAnswer(filtered)).toBe('finish_reason "content_filter" (native: SAFETY) · 40 output tokens, 40 of them reasoning');
    });

    it('names the finish reason of Ollama\'s, llama.cpp\'s and Cohere\'s own replies', () => {
        expect(describeNoTextAnswer({ ...ollamaReply('length'), response: '' })).toBe('finish_reason "length"');
        expect(describeNoTextAnswer({ ...llamaCppReply('limit'), content: '' })).toBe('finish_reason "length" (native: limit)');
        expect(describeNoTextAnswer({ ...cohereReply('MAX_TOKENS'), message: { role: 'assistant', content: [] } })).toBe('finish_reason "length" (native: MAX_TOKENS)');
    });

    it('says when the reply carries nothing to tell why', () => {
        expect(describeNoTextAnswer({ choices: [{ message: { content: '' } }] })).toBe('the reply carries no finish reason and no token counts');
        expect(describeNoTextAnswer(null)).toBe('the reply carries no finish reason and no token counts');
        expect(describeNoTextAnswer('')).toBe('the reply carries no finish reason and no token counts');
    });
});
