/**
 * EventBase's reply step (runEventBaseReplyStep, src/features/eventbase/eventbase-reply.js), which the generation
 * interceptor runs: prompt clearing, the master switch and a live turn.
 *
 * SillyTavern keeps every extension prompt until it is overwritten, so a VectFox block the reply step does not clear
 * keeps reaching the model on later generations. These tests lock in that each generation first empties the
 * EventBase and Summarizer blocks, and nothing else; that with the master switch OFF it stops right after, with no
 * retrieval and no lifecycle logging; that a quiet prompt stops there too, so it searches nothing and sends none of the
 * last reply's memory, while a quiet-to-loud generation and an impersonation run the step (D4 of
 * vectfox-public-api.md); that a live turn searches EventBase
 * with the last messages, then runs the Summarizer and ghosting, each search bounded, all three on the one route's
 * answer asked once (collectionInUse); and that a reply with none in use says so once, naming what was switched on
 * to read the chat's events (D18 of vectfox-multi-collection-per-chat.md).
 *
 * The module's SillyTavern wrappers and its EventBase and backend imports are stubbed; constants.js and
 * feature-gate.js stay real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const extensionPrompts = {};
    const boundedRun = Object.freeze({ isCurrent: () => true });
    return {
        extensionPrompts,
        boundedRun,
        setExtensionPrompt: vi.fn((key, value, position, depth) => {
            extensionPrompts[key] = { value, position, depth };
        }),
        // Starts the retrieval with its run, as runBoundedRetrieval does.
        runBoundedRetrieval: vi.fn(async startRetrieval => startRetrieval(boundedRun)),
        runEventBaseRetrieval: vi.fn(async () => {}),
        runSummarizerInjection: vi.fn(async () => {}),
        applyGhosting: vi.fn(),
        collectionInUse: vi.fn(),
        showNoCollectionInUse: vi.fn(),
        lastGeneration: null,
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
// What GENERATION_AFTER_COMMANDS carried for the generation under test.
vi.mock('../src/shared/last-generation.js', () => ({ lastGenerationPastCommands: () => mocks.lastGeneration }));
vi.mock('../src/features/vector-backend/index.js', () => ({ runBoundedRetrieval: mocks.runBoundedRetrieval }));
vi.mock('../src/features/eventbase/eventbase-workflow.js', () => ({ runEventBaseRetrieval: mocks.runEventBaseRetrieval }));
vi.mock('../src/features/eventbase/summarizer-injection.js', () => ({
    applyGhosting: mocks.applyGhosting, runSummarizerInjection: mocks.runSummarizerInjection,
}));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    collectionInUse: mocks.collectionInUse, showNoCollectionInUse: mocks.showNoCollectionInUse,
}));
const IN_USE = { collection: { registryKey: 'qdrant:vf_eventbase_c1' }, reason: null, collections: [], lockedElsewhere: [] };

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
    mocks.lastGeneration = null;
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

    it('sends a quiet prompt none of the last reply\'s memory, and searches nothing for it', async () => {
        mocks.lastGeneration = { type: 'quiet', isQuietToLoud: false };
        mocks.collectionInUse.mockReturnValue(IN_USE);
        await runEventBaseReplyStep(CHAT, { enabled: true, query: 2, position: 1, depth: 2, summarizer_injection_enabled: true }, 'quiet');

        for (const tag of REPLY_STEP_TAGS) expect(valueOf(tag)).toBe('');
        expect(valueOf('1_memory')).toBe('another extension');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
        expect(mocks.applyGhosting).not.toHaveBeenCalled();
        expect(mocks.collectionInUse).not.toHaveBeenCalled();
    });

    it('runs the step on a quiet-to-loud generation, shown as a reply, and on an impersonation', async () => {
        mocks.collectionInUse.mockReturnValue(IN_USE);
        const settings = { enabled: true, query: 2, position: 1, depth: 2 };

        mocks.lastGeneration = { type: 'quiet', isQuietToLoud: true };
        await runEventBaseReplyStep(CHAT, settings, 'quiet');
        expect(mocks.runEventBaseRetrieval).toHaveBeenCalledTimes(1);
        expect(mocks.applyGhosting).toHaveBeenCalledTimes(1);

        mocks.lastGeneration = { type: 'impersonate', isQuietToLoud: false };
        await runEventBaseReplyStep(CHAT, settings, 'impersonate');
        expect(mocks.runEventBaseRetrieval).toHaveBeenCalledTimes(2);
    });

    it('searches EventBase with the last messages, then runs the Summarizer and ghosting, each search bounded', async () => {
        const chat = [
            { mes: 'We camped by the river.', is_user: false },
            { mes: 'Where did we leave the map?', is_user: true },
            { mes: '[The scene changes.]', is_system: true },
            { mes: 'Under the cart, I think.', is_user: false },
        ];
        const settings = { enabled: true, query: 2, position: 1, depth: 2 };
        mocks.collectionInUse.mockReturnValue(IN_USE);
        await runEventBaseReplyStep(chat, settings, 'normal');

        expect(mocks.collectionInUse).toHaveBeenCalledTimes(1);
        expect(mocks.runEventBaseRetrieval).toHaveBeenCalledWith({ chat, searchText: 'Under the cart, I think.\nWhere did we leave the map?', settings, chatUUID: 'uuid-1', inUse: IN_USE, boundedRun: mocks.boundedRun });
        expect(mocks.runBoundedRetrieval.mock.calls.map(([, bound]) => bound.contextLabel)).toEqual(['EventBase', 'Summarizer']);
        expect(mocks.runBoundedRetrieval.mock.calls[0][1]).toMatchObject({ settings, timeoutMs: 15000 });
        expect(mocks.runSummarizerInjection).toHaveBeenCalledWith(settings, IN_USE, mocks.boundedRun);
        expect(mocks.applyGhosting).toHaveBeenCalledWith(chat, settings, IN_USE);
        expect(mocks.applyGhosting.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.runSummarizerInjection.mock.invocationCallOrder[0]);
        expect(chat.map(message => message.mes)).toEqual(['We camped by the river.', 'Where did we leave the map?', '[The scene changes.]', 'Under the cart, I think.']);
    });

    it('says once per reply, through the route\'s red toast, what was switched on to read the chat\'s events', async () => {
        const none = { collection: null, reason: 'none-in-use', collections: [{ registryKey: 'qdrant:vf_eventbase_c1' }], lockedElsewhere: [] };
        mocks.collectionInUse.mockReturnValue(none);
        const settings = { enabled: true, query: 2, position: 1, depth: 2, summarizer_injection_enabled: true, story_arc_mode_enabled: true, vector_backend: 'qdrant' };
        await runEventBaseReplyStep(CHAT, settings, 'normal');
        expect(mocks.showNoCollectionInUse).toHaveBeenCalledTimes(1);
        expect(mocks.showNoCollectionInUse).toHaveBeenCalledWith(none, 'this reply read none of its events: retrieval, Summarizer Injection, and StoryArc');

        mocks.showNoCollectionInUse.mockClear();
        await runEventBaseReplyStep(CHAT, { enabled: true, query: 2, position: 1, depth: 2 }, 'normal');
        expect(mocks.showNoCollectionInUse).toHaveBeenCalledWith(none, 'this reply read none of its events: retrieval');
    });
});
