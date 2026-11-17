/**
 * EventBase's reply step (runEventBaseReplyStep, src/features/eventbase/eventbase-reply.js), which the generation
 * interceptor runs: prompt clearing, the master switch and a live turn.
 *
 * SillyTavern keeps every extension prompt until it is overwritten, so a VectFox block the reply step does not clear
 * keeps reaching the model on later generations. These tests lock in that each live generation first empties the
 * EventBase and Summarizer blocks, and nothing else; that with the master switch OFF it stops right after, with no
 * retrieval and no lifecycle logging; that a quiet generation is left alone; and that a live turn searches EventBase
 * with the last messages, then runs the Summarizer and ghosting, each search bounded.
 *
 * The module's SillyTavern wrappers and its EventBase and backend imports are stubbed; constants.js and
 * feature-gate.js stay real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const extensionPrompts = {};
    return {
        extensionPrompts,
        setExtensionPrompt: vi.fn((key, value, position, depth) => {
            extensionPrompts[key] = { value, position, depth };
        }),
        runBoundedRetrieval: vi.fn(async work => work),
        runEventBaseRetrieval: vi.fn(async () => {}),
        runSummarizerInjection: vi.fn(async () => {}),
        applyGhosting: vi.fn(),
        log: {
            error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(),
            domain: vi.fn(), enabled: () => false, domainEnabled: () => false,
        },
    };
});

vi.mock('../src/sillytavern/chat.js', () => ({ getCurrentChatId: vi.fn(() => 'chat-1'), substituteParams: vi.fn(text => text) }));
vi.mock('../src/sillytavern/prompt-injection.js', () => ({ setExtensionPrompt: mocks.setExtensionPrompt }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../src/sillytavern/log.js', () => ({ log: mocks.log }));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: vi.fn(() => 'uuid-1') }));
vi.mock('../src/shared/retrieval-budget.js', () => ({ resolveEventBaseRetrievalTimeoutMs: vi.fn(() => 15000) }));
vi.mock('../src/features/vector-backend/index.js', () => ({ runBoundedRetrieval: mocks.runBoundedRetrieval }));
vi.mock('../src/features/eventbase/eventbase-workflow.js', () => ({ runEventBaseRetrieval: mocks.runEventBaseRetrieval }));
vi.mock('../src/features/eventbase/summarizer-injection.js', () => ({
    applyGhosting: mocks.applyGhosting, runSummarizerInjection: mocks.runSummarizerInjection,
}));

import { clearInterceptorPrompts, runEventBaseReplyStep } from '../src/features/eventbase/eventbase-reply.js';

/** Blocks left over from a previous generation, plus another extension's, which the reply step must not touch. */
function seedPreviousGeneration() {
    Object.assign(mocks.extensionPrompts, {
        '3_vectfox_eventbase': { value: '<VectFoxMemory>events</VectFoxMemory>' },
        '3_vectfox_summarizer': { value: '<VectFoxSummarizer>recent</VectFoxSummarizer>' },
        '1_memory': { value: 'another extension' },
    });
}

const REPLY_STEP_TAGS = ['3_vectfox_eventbase', '3_vectfox_summarizer'];
const valueOf = (tag) => mocks.extensionPrompts[tag].value;
const CHAT = [{ mes: 'Where did we leave the map?', is_user: true }];

beforeEach(() => {
    for (const key of Object.keys(mocks.extensionPrompts)) delete mocks.extensionPrompts[key];
    vi.clearAllMocks();
    seedPreviousGeneration();
});

describe('clearInterceptorPrompts', () => {
    it('empties the EventBase and Summarizer blocks, at the injection\'s position and depth, and writes no other', () => {
        clearInterceptorPrompts({ position: 1, depth: 2 });
        for (const tag of REPLY_STEP_TAGS) expect(valueOf(tag)).toBe('');
        expect(mocks.setExtensionPrompt.mock.calls).toEqual(REPLY_STEP_TAGS.map(tag => [tag, '', 1, 2, false]));
    });

    it("leaves other extensions' blocks alone", () => {
        clearInterceptorPrompts({ position: 1, depth: 2 });
        expect(valueOf('1_memory')).toBe('another extension');
    });
});

describe('runEventBaseReplyStep with the master switch OFF', () => {
    it('removes last turn\'s blocks, retrieves nothing and logs nothing at lifecycle', async () => {
        await runEventBaseReplyStep(CHAT, { enabled: false, position: 1, depth: 2 }, 'normal');

        for (const tag of REPLY_STEP_TAGS) expect(valueOf(tag)).toBe('');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
        expect(mocks.log.lifecycle).not.toHaveBeenCalled();
    });
});

describe('runEventBaseReplyStep with the master switch ON', () => {
    it('removes last turn\'s blocks even when this turn injects nothing', async () => {
        // Chat shorter than min_chat_length: the reply step exits before any retrieval.
        await runEventBaseReplyStep(CHAT, { enabled: true, min_chat_length: 10, position: 1, depth: 2 }, 'normal');

        for (const tag of REPLY_STEP_TAGS) expect(valueOf(tag)).toBe('');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
    });

    it('leaves a quiet generation alone: it clears and retrieves nothing', async () => {
        await runEventBaseReplyStep(CHAT, { enabled: true, position: 1, depth: 2 }, 'quiet');

        expect(mocks.setExtensionPrompt).not.toHaveBeenCalled();
        expect(valueOf('3_vectfox_eventbase')).toBe('<VectFoxMemory>events</VectFoxMemory>');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
    });

    it('searches EventBase with the last messages, then runs the Summarizer and ghosting, each search bounded', async () => {
        const chat = [
            { mes: 'We camped by the river.', is_user: false },
            { mes: 'Where did we leave the map?', is_user: true },
            { mes: '[The scene changes.]', is_system: true },
            { mes: 'Under the cart, I think.', is_user: false },
        ];
        const settings = { enabled: true, query: 2, position: 1, depth: 2 };
        await runEventBaseReplyStep(chat, settings, 'normal');

        expect(mocks.runEventBaseRetrieval).toHaveBeenCalledWith({ chat, searchText: 'Under the cart, I think.\nWhere did we leave the map?', settings, chatUUID: 'uuid-1' });
        expect(mocks.runBoundedRetrieval.mock.calls.map(([, bound]) => bound.contextLabel)).toEqual(['EventBase', 'Summarizer']);
        expect(mocks.runBoundedRetrieval.mock.calls[0][1]).toMatchObject({ settings, timeoutMs: 15000 });
        expect(mocks.runSummarizerInjection).toHaveBeenCalledWith(settings);
        expect(mocks.applyGhosting).toHaveBeenCalledWith(chat, settings);
        expect(mocks.applyGhosting.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.runSummarizerInjection.mock.invocationCallOrder[0]);
        expect(chat.map(message => message.mes)).toEqual(['We camped by the river.', 'Where did we leave the map?', '[The scene changes.]', 'Under the cart, I think.']);
    });
});
