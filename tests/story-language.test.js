/**
 * Tests for the language a story's events and Agent Mode's searches are written in
 * (src/features/eventbase/prompts-i18n.js, story-language.js and eventbase-extractor.js).
 *
 * Guards that:
 *   - a story whose letters are mostly not CJK is not a CJK story, so a Chinese, Japanese or Korean mode reads it
 *     with the "others" prompts, while a CJK story keeps the mode's own,
 *   - intl and others read every story with the "others" prompts, which are the same for both, so every mode writes
 *     the story's own language,
 *   - the "others" prompts' language rules name no language: they write in the story's own, and never tell the model
 *     to avoid its examples' language,
 *   - the language is read from the latest 200 messages, without system messages, after the planner's cleaning,
 *   - a window's extraction prompt follows the story's language, and names a CJK language only in a CJK story; the
 *     others prompt names Chinese with the story's script, read from the story without the model's thinking, while a
 *     Chinese mode's prompt, which fixes the script, says only Chinese,
 *   - a window of a story not written in CJK that holds CJK text is told so before the prompt and again after the
 *     excerpt, where a custom prompt's {{storyLanguageNotice}} is; in a CJK story or with no CJK text, never,
 *   - the language check names the fields in another script than the window's.
 *
 * The stories are made up: plain English and Chinese lines about a made-up cast.
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

const { chineseLanguageNameFor, getAgenticPlannerPrompt, getEventBaseExtractionPrompt, shouldGiveStoryLanguageNotice, storyLanguageOf, STORY_LANGUAGE_NOTICE } = await import('../src/features/eventbase/prompts-i18n.js');
const { readStoryLanguage } = await import('../src/features/eventbase/story-language.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');
const { log } = await import('../src/sillytavern/log.js');

const ENGLISH = 'Rose finds the harbour map in the old tower, and Tom swears to keep it from the guild.';
const CHINESE = 'Rose 在舊塔裡找到了港口地圖，Tom 發誓不讓公會拿到它。';
const SIMPLIFIED_CHINESE = 'Rose 在旧塔里找到了港口地图，Tom 发誓不让公会拿到它。';
const message = (mes, extra = {}) => ({ name: 'Narrator', mes, ...extra });

describe('storyLanguageOf', () => {
    it('reads an English story under a CJK mode with the others prompts', () => {
        for (const mode of ['jieba', 'jieba_tw', 'tiny_segmenter', 'korean']) {
            expect(storyLanguageOf(mode, ENGLISH)).toEqual({ promptMode: 'others', isCjkStory: false, chineseScript: null });
        }
    });

    it('keeps a CJK mode\'s own prompts for a CJK story, names written in Latin letters and all', () => {
        expect(storyLanguageOf('jieba_tw', CHINESE)).toEqual({ promptMode: 'jieba_tw', isCjkStory: true, chineseScript: 'traditional' });
    });

    it('reads an English story with a little Chinese in it as English', () => {
        expect(storyLanguageOf('jieba_tw', `${ENGLISH.repeat(8)} 繼續按照建議。`)).toEqual({ promptMode: 'others', isCjkStory: false, chineseScript: null });
    });

    it('reads every story under intl or others with the others prompts, a Chinese story too', () => {
        for (const mode of ['intl', 'others']) {
            expect(storyLanguageOf(mode, ENGLISH)).toEqual({ promptMode: 'others', isCjkStory: false, chineseScript: null });
            expect(storyLanguageOf(mode, CHINESE)).toEqual({ promptMode: 'others', isCjkStory: true, chineseScript: 'traditional' });
        }
    });

    it('reads a Chinese story\'s script, and none when no character tells the two apart', () => {
        expect(storyLanguageOf('intl', SIMPLIFIED_CHINESE).chineseScript).toBe('simplified');
        expect(storyLanguageOf('intl', `${CHINESE}${CHINESE}${SIMPLIFIED_CHINESE}`).chineseScript).toBe('traditional');
        expect(storyLanguageOf('intl', '月光照在山上，海浪拍打岩石。').chineseScript).toBeNull();
    });
});

describe('chineseLanguageNameFor', () => {
    it('names the story\'s script under the others prompt, which fixes none', () => {
        expect(chineseLanguageNameFor(storyLanguageOf('intl', CHINESE))).toBe('繁體中文 (Traditional Chinese)');
        expect(chineseLanguageNameFor(storyLanguageOf('others', SIMPLIFIED_CHINESE))).toBe('简体中文 (Simplified Chinese)');
        expect(chineseLanguageNameFor(storyLanguageOf('intl', '月光照在山上，海浪拍打岩石。'))).toBe('中文 (Chinese)');
    });

    it('says only Chinese under a Chinese mode, whose prompt fixes the script', () => {
        expect(chineseLanguageNameFor(storyLanguageOf('jieba_tw', CHINESE))).toBe('中文 (Chinese)');
        expect(chineseLanguageNameFor(storyLanguageOf('jieba', CHINESE))).toBe('中文 (Chinese)');
    });
});

describe('the others prompts', () => {
    const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

    it('write in the story\'s own language and name none', () => {
        const extractionRule = between(getEventBaseExtractionPrompt('others'), '1. LANGUAGE', '2. EVENT COUNT');
        const plannerRule = between(getAgenticPlannerPrompt('others'), 'LANGUAGE RULE', 'Example 1');
        expect(extractionRule).toContain('the same language as the excerpt');
        expect(plannerRule).toContain('the same language as the chat');
        expect(extractionRule).toContain('write every field in the one most of the excerpt is written in');
        expect(extractionRule).not.toContain('each field\'s source');
        for (const rule of [extractionRule, plannerRule]) {
            // Told to avoid the English examples' language, the model wrote an English story's events in Spanish.
            expect(rule).not.toContain('never take their language');
            expect(rule).not.toMatch(/English|Chinese|Japanese|Korean/);
        }
        expect(getEventBaseExtractionPrompt('others')).toContain('One event (its shape only — write yours in the excerpt\'s language):');
    });

    it('are intl\'s prompts too', () => {
        expect(getEventBaseExtractionPrompt('intl')).toBe(getEventBaseExtractionPrompt('others'));
        expect(getAgenticPlannerPrompt('intl')).toBe(getAgenticPlannerPrompt('others'));
    });
});

describe('shouldGiveStoryLanguageNotice', () => {
    it('gives the notice to a window holding CJK text in a story not written in CJK, under every mode', () => {
        for (const mode of ['jieba_tw', 'intl', 'others']) {
            expect(shouldGiveStoryLanguageNotice(storyLanguageOf(mode, ENGLISH), `${ENGLISH}\n${CHINESE}`)).toBe(true);
        }
        expect(shouldGiveStoryLanguageNotice(storyLanguageOf('others', ENGLISH), `${ENGLISH} 【狀態欄】`)).toBe(true);
    });

    it('gives none to a window with no CJK text, or in a CJK story', () => {
        expect(shouldGiveStoryLanguageNotice(storyLanguageOf('jieba_tw', ENGLISH), ENGLISH)).toBe(false);
        expect(shouldGiveStoryLanguageNotice(storyLanguageOf('jieba_tw', CHINESE), `${ENGLISH}\n${CHINESE}`)).toBe(false);
        expect(shouldGiveStoryLanguageNotice(storyLanguageOf('intl', CHINESE), `${ENGLISH}\n${CHINESE}`)).toBe(false);
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
        expect(readStoryLanguage(messages, settings)).toEqual({ promptMode: 'jieba_tw', isCjkStory: true, chineseScript: 'traditional' });
    });

    it('reads a Traditional story as Traditional though its model thinks in Simplified', () => {
        const messages = [message(`<think>${SIMPLIFIED_CHINESE.repeat(5)}</think>${CHINESE}`), message(CHINESE)];
        expect(readStoryLanguage(messages, { cjk_tokenizer_mode: 'intl' }).chineseScript).toBe('traditional');
    });
});

describe('extractEvents in a story\'s language', () => {
    const settings = { cjk_tokenizer_mode: 'jieba_tw', chat_provider: 'openrouter', chat_model: 'some-model' };
    const extract = (messages, storyLanguage) => extractEvents({ messages, windowStart: 0, windowEnd: messages.length - 1, settings, storyLanguage });

    beforeEach(() => {
        sent.prompts.length = 0;
        sent.reply = '[]';
        vi.mocked(log.warn).mockClear();
    });

    it('writes an English story\'s window with the others prompt, naming no language to write in, even a window mostly in Chinese', async () => {
        await extract([message(CHINESE), message(CHINESE)], storyLanguageOf('jieba_tw', ENGLISH));
        expect(sent.prompts[0]).toContain('All string fields MUST be in the same language as the excerpt.');
        expect(sent.prompts[0]).not.toContain('Traditional Chinese');
        expect(sent.prompts[0]).not.toContain('DETECTED EXCERPT LANGUAGE');
    });

    it('tells an English story\'s window that holds Chinese text that the story is not written in it, before the prompt and again after the excerpt', async () => {
        await extract([message(ENGLISH), message(CHINESE)], storyLanguageOf('jieba_tw', ENGLISH));
        const prompt = sent.prompts[0];
        expect(prompt.startsWith(`${STORY_LANGUAGE_NOTICE.beforePrompt}\n\n`)).toBe(true);
        expect(prompt).toContain(`=========================\n${STORY_LANGUAGE_NOTICE.afterExcerpt} Return ONLY the JSON array now.`);
        expect(prompt.indexOf(STORY_LANGUAGE_NOTICE.afterExcerpt)).toBeGreaterThan(prompt.lastIndexOf(CHINESE));
    });

    it('gives an English story\'s window with no CJK text no notice, and leaves the prompt\'s last lines as they were', async () => {
        await extract([message(ENGLISH), message(ENGLISH)], storyLanguageOf('jieba_tw', ENGLISH));
        expect(sent.prompts[0]).not.toContain('STORY LANGUAGE:');
        expect(sent.prompts[0]).not.toContain('{{storyLanguageNotice}}');
        expect(sent.prompts[0]).toContain('=========================\nReturn ONLY the JSON array now.');
    });

    it('puts the notice after the excerpt only where a custom prompt holds {{storyLanguageNotice}}', async () => {
        const storyLanguage = storyLanguageOf('jieba_tw', ENGLISH);
        const messages = [message(ENGLISH), message(CHINESE)];
        const extractWith = customPrompt => extractEvents({ messages, windowStart: 0, windowEnd: 1, settings: { ...settings, eventbase_custom_prompt: customPrompt }, storyLanguage });
        await extractWith('Events of:\n{{text}}\n{{storyLanguageNotice}}Reply with JSON.');
        await extractWith('Events of:\n{{text}}\nReply with JSON.');
        expect(sent.prompts[0].startsWith(STORY_LANGUAGE_NOTICE.beforePrompt)).toBe(true);
        expect(sent.prompts[0]).toContain(`${STORY_LANGUAGE_NOTICE.afterExcerpt} Reply with JSON.`);
        expect(sent.prompts[1].startsWith(STORY_LANGUAGE_NOTICE.beforePrompt)).toBe(true);
        expect(sent.prompts[1]).not.toContain(STORY_LANGUAGE_NOTICE.afterExcerpt);
    });

    it('writes a Chinese story\'s window with the mode\'s prompt, naming the window\'s CJK language', async () => {
        await extract([message(CHINESE), message(CHINESE)], storyLanguageOf('jieba_tw', CHINESE));
        expect(sent.prompts[0]).toContain('Traditional Chinese (繁體中文)');
        expect(sent.prompts[0]).toContain('DETECTED EXCERPT LANGUAGE: 中文 (Chinese)');
        expect(sent.prompts[0]).not.toContain('STORY LANGUAGE:');
    });

    it('writes every story under intl in its own language: a Chinese story\'s window names its script, an English one\'s gets the notice', async () => {
        await extract([message(CHINESE), message(CHINESE)], storyLanguageOf('intl', CHINESE));
        await extract([message(ENGLISH), message(CHINESE)], storyLanguageOf('intl', ENGLISH));
        await extract([message(SIMPLIFIED_CHINESE), message(SIMPLIFIED_CHINESE)], storyLanguageOf('intl', SIMPLIFIED_CHINESE));
        expect(sent.prompts[0]).toContain('DETECTED EXCERPT LANGUAGE: 繁體中文 (Traditional Chinese)');
        expect(sent.prompts[1].startsWith(STORY_LANGUAGE_NOTICE.beforePrompt)).toBe(true);
        expect(sent.prompts[2]).toContain('DETECTED EXCERPT LANGUAGE: 简体中文 (Simplified Chinese)');
        for (const prompt of sent.prompts) {
            expect(prompt).toContain('All string fields MUST be in the same language as the excerpt.');
            expect(prompt).not.toContain('MUST be in English');
        }
    });

    it('keeps an event with fields in another script than the window, and names those fields in a warning', async () => {
        sent.reply = JSON.stringify([{ event_type: 'discovery', importance: 6, summary: 'Rose finds the harbour map.', cause: '她想找到地圖', result: 'The guild loses the map.', concepts: ['信任', '秘密'] }]);
        const events = await extract([message(ENGLISH), message(ENGLISH)], storyLanguageOf('intl', ENGLISH));
        expect(events).toHaveLength(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('item 0: cause, concepts not in the excerpt\'s script (latin) — kept'));
    });

    it('reads a window\'s own language when no story language is given', async () => {
        await extract([message(ENGLISH), message(ENGLISH)]);
        expect(sent.prompts[0]).toContain('All string fields MUST be in the same language as the excerpt.');
    });
});
