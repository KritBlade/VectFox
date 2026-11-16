/**
 * Tests for the language a story's events and Agent Mode's searches are written in
 * (src/features/eventbase/prompts-i18n.js, story-language.js and eventbase-extractor.js).
 *
 * Guards that:
 *   - a story whose letters are mostly not CJK is not a CJK story, so a Chinese, Japanese or Korean mode reads it
 *     with the "others" prompts, while a CJK story keeps the mode's own, and other modes keep theirs,
 *   - the "others" prompts' language rules name no language: they write in the story's own,
 *   - the language is read from the latest 200 messages, without system messages, after the planner's cleaning,
 *   - a window's extraction prompt follows the story's language, and names a CJK language only in a CJK story.
 *
 * The stories are made up: plain English and Chinese lines about a made-up cast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = vi.hoisted(() => ({ prompts: [] }));

vi.mock('../src/features/llm-provider/index.js', async () => {
    const parser = await vi.importActual('../src/features/llm-provider/llm-provider-call.js');
    return {
        parseJsonArrayFromLlm: parser.parseJsonArrayFromLlm,
        LlmCallError: parser.LlmCallError,
        resolveModelParameterStyle: () => ({}),
        postChatCompletion: vi.fn(async ({ messages }) => {
            sent.prompts.push(messages[0].content);
            return { content: '[]', finishReason: 'stop' };
        }),
    };
});
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/model-http-errors.js', () => ({ getModelConfigErrorMessage: () => null }));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isConnectionError: () => false, notifyConnectionError: vi.fn(), notifyUpstreamRejection: vi.fn(),
}));
// Thinking is the one block these tests need gone, as a model may think in a language its story is not in.
vi.mock('../src/features/text-cleaning/index.js', () => ({
    cleanText: text => text,
    stripGameSystemBlocks: text => text,
    stripReasoningBlocks: text => text.replace(/<think>[\s\S]*?<\/think>/g, ''),
}));
vi.mock('../src/features/eventbase/eventbase-message-hash.js', () => ({ hashSourceMessage: message => message.mes.length }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));

const { getAgenticPlannerPrompt, getEventBaseExtractionPrompt, storyLanguageOf } = await import('../src/features/eventbase/prompts-i18n.js');
const { readStoryLanguage } = await import('../src/features/eventbase/story-language.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

const ENGLISH = 'Rose finds the harbour map in the old tower, and Tom swears to keep it from the guild.';
const CHINESE = 'Rose 在舊塔裡找到了港口地圖，Tom 發誓不讓公會拿到它。';
const message = (mes, extra = {}) => ({ name: 'Narrator', mes, ...extra });

describe('storyLanguageOf', () => {
    it('reads an English story under a CJK mode with the others prompts', () => {
        for (const mode of ['jieba', 'jieba_tw', 'tiny_segmenter', 'korean']) {
            expect(storyLanguageOf(mode, ENGLISH)).toEqual({ promptMode: 'others', isCjkStory: false });
        }
    });

    it('keeps a CJK mode\'s own prompts for a CJK story, names written in Latin letters and all', () => {
        expect(storyLanguageOf('jieba_tw', CHINESE)).toEqual({ promptMode: 'jieba_tw', isCjkStory: true });
    });

    it('reads an English story with a little Chinese in it as English', () => {
        expect(storyLanguageOf('jieba_tw', `${ENGLISH.repeat(8)} 繼續按照建議。`)).toEqual({ promptMode: 'others', isCjkStory: false });
    });

    it('leaves other modes as they are', () => {
        expect(storyLanguageOf('intl', ENGLISH)).toEqual({ promptMode: 'intl', isCjkStory: false });
        expect(storyLanguageOf('intl', CHINESE)).toEqual({ promptMode: 'intl', isCjkStory: true });
        expect(storyLanguageOf('others', ENGLISH)).toEqual({ promptMode: 'others', isCjkStory: false });
    });
});

describe('the others prompts', () => {
    const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

    it('write in the story\'s own language and name none', () => {
        const extractionRule = between(getEventBaseExtractionPrompt('others'), '1. LANGUAGE', '2. EVENT COUNT');
        const plannerRule = between(getAgenticPlannerPrompt('others'), 'LANGUAGE RULE', 'Example 1');
        expect(extractionRule).toContain('the same language as the excerpt');
        expect(plannerRule).toContain('the same language as the chat');
        for (const rule of [extractionRule, plannerRule]) {
            expect(rule).not.toMatch(/English|Chinese|Japanese|Korean/);
        }
        expect(getEventBaseExtractionPrompt('others')).toContain('One event (its shape only — write yours in the excerpt\'s language):');
    });
});

describe('readStoryLanguage', () => {
    const settings = { cjk_tokenizer_mode: 'jieba_tw' };

    it('reads the latest 200 messages, so a story that moved to English reads as English', () => {
        const messages = [...Array.from({ length: 100 }, () => message(CHINESE)), ...Array.from({ length: 200 }, () => message(ENGLISH))];
        expect(readStoryLanguage(messages, settings).promptMode).toBe('others');
        expect(readStoryLanguage(messages.slice(0, 150), settings).promptMode).toBe('jieba_tw');
    });

    it('leaves out system messages and the model\'s thinking', () => {
        const thinking = `<think>${ENGLISH.repeat(20)}</think>`;
        const messages = [message(`${thinking}${CHINESE}`), message(ENGLISH.repeat(20), { is_system: true }), message(CHINESE)];
        expect(readStoryLanguage(messages, settings)).toEqual({ promptMode: 'jieba_tw', isCjkStory: true });
    });
});

describe('extractEvents in a story\'s language', () => {
    const settings = { cjk_tokenizer_mode: 'jieba_tw', chat_provider: 'openrouter', chat_model: 'some-model' };
    const extract = (messages, storyLanguage) => extractEvents({ messages, windowStart: 0, windowEnd: messages.length - 1, settings, storyLanguage });

    beforeEach(() => {
        sent.prompts.length = 0;
    });

    it('writes an English story\'s window with the others prompt and names no language, even a window mostly in Chinese', async () => {
        await extract([message(CHINESE), message(CHINESE)], { promptMode: 'others', isCjkStory: false });
        expect(sent.prompts[0]).toContain('All string fields MUST be in the same language as the excerpt.');
        expect(sent.prompts[0]).not.toContain('Traditional Chinese');
        expect(sent.prompts[0]).not.toContain('DETECTED EXCERPT LANGUAGE');
    });

    it('writes a Chinese story\'s window with the mode\'s prompt, naming the window\'s CJK language', async () => {
        await extract([message(CHINESE), message(CHINESE)], { promptMode: 'jieba_tw', isCjkStory: true });
        expect(sent.prompts[0]).toContain('Traditional Chinese (繁體中文)');
        expect(sent.prompts[0]).toContain('DETECTED EXCERPT LANGUAGE: 中文 (Chinese)');
    });

    it('reads a window\'s own language when no story language is given', async () => {
        await extract([message(ENGLISH), message(ENGLISH)]);
        expect(sent.prompts[0]).toContain('All string fields MUST be in the same language as the excerpt.');
    });
});
