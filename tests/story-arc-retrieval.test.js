/**
 * Tests for StoryArc mode's recipes (src/features/eventbase/story-arc-retrieval.js)
 * and how Agent Mode routes to them (src/features/eventbase/agentic-retrieval.js).
 *
 * Guards that:
 *   - a thread question gets a wide pool in chat order, past the top-K trim,
 *   - a first-time question gets the subject's earliest events and closest hits,
 *   - stored links are walked once a chat has them,
 *   - a thread question asks the link model which threads to add, and survives its failure,
 *   - a long block is cut by the link model with a prompt for its shape, and survives its failure,
 *   - ordinary turns, router failures, a failed listing and empty recipes keep today's path,
 *   - every StoryArc turn reports the Route rule that decided it,
 *   - StoryArc mode does nothing unless Agent Mode and its own switch are on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryCollectionMock = vi.fn();
const listChunksMock = vi.fn();
vi.mock('../src/features/vector-backend/index.js', () => ({
    queryCollection: (...args) => queryCollectionMock(...args),
    listChunks: (...args) => listChunksMock(...args),
    getQueryVector: vi.fn(),
    getBackendForCollection: vi.fn(),
    getBackend: vi.fn(),
}));

const retrieveEventsMock = vi.fn();
vi.mock('../src/features/eventbase/eventbase-retrieval.js', async (importOriginal) => ({
    ...(await importOriginal()),
    retrieveEvents: (...args) => retrieveEventsMock(...args),
}));

const postChatCompletionMock = vi.fn();
vi.mock('../src/features/llm-provider/index.js', () => ({
    postChatCompletion: (...args) => postChatCompletionMock(...args),
    resolveModelParameterStyle: () => ({ sendTemperature: true, reasoningEffort: 'none' }),
    LlmCallError: class LlmCallError extends Error {},
}));

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => true) }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({
    generationRateLimiter: { execute: (run) => run() },
    generationRateLimitSettings: () => ({}),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({
    stripReasoningBlocks: (text) => text,
    stripGameSystemBlocks: (text) => text,
}));
vi.mock('../src/features/eventbase/prompts-i18n.js', () => ({
    buildPlannerUserMessage: () => 'planner message',
    getAgenticPlannerPrompt: () => 'planner prompt',
    getEventBaseExtractionPrompt: () => '',
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isInvalidModelConfigError: () => false,
    notifyInvalidModel: vi.fn(),
}));
const logWarnMock = vi.fn();
vi.mock('../src/sillytavern/log.js', () => ({
    log: {
        warn: (...args) => logWarnMock(...args),
        error: vi.fn(),
        lifecycle: vi.fn(),
        verbose: vi.fn(),
        trace: vi.fn(),
        domain: vi.fn(),
        enabled: () => false,
        domainEnabled: () => false,
    },
}));

const { retrieveStoryRecipeEvents } = await import('../src/features/eventbase/story-arc-retrieval.js');
const { resolveStoryLinkLlmConfig, retrieveEventsWithAgent } = await import('../src/features/eventbase/agentic-retrieval.js');
const { BLOCK_CUT_PROMPT_BY_SHAPE } = await import('../src/features/eventbase/story-arc-core.js');

const COLLECTION = 'qdrant:vf_eventbase_chat';
const event = (start, text = `event at ${start}`, extra = {}) => ({
    event_id: `id${start}`,
    source_window_start: start,
    source_window_end: start + 1,
    timeline_sort_key: start * 10000,
    importance: 5,
    text,
    ...extra,
});
const queryReturns = (events) => queryCollectionMock.mockResolvedValue({
    hashes: events.map(item => item.source_window_start),
    metadata: events,
});
const listReturns = (events) => listChunksMock.mockResolvedValue({
    items: events.map(item => ({ hash: item.source_window_start, text: item.text, metadata: { ...item, eventbase: true } })),
});
const starts = (events) => events.map(item => item.source_window_start);

const baseParams = {
    keywordQuery: 'How did Nora get here?',
    searchText: 'recent chat',
    chatLength: 3000,
    settings: { vector_backend: 'qdrant' },
    liveCollectionIds: [COLLECTION],
    boundQuery: (promise) => promise,
};

beforeEach(() => {
    vi.clearAllMocks();
    queryCollectionMock.mockReset();
    listChunksMock.mockReset();
    listReturns([]);
});

describe('retrieveStoryRecipeEvents', () => {
    it('gives a thread question 75 hits in chat order, past the top-K trim', async () => {
        const hits = Array.from({ length: 75 }, (_, i) => event(1000 - i));
        queryReturns(hits);
        const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, { ...baseParams, settings: { ...baseParams.settings, eventbase_retrieval_top_k: 10 } });
        expect(queryCollectionMock.mock.calls[0].slice(0, 3)).toEqual([COLLECTION, 'How did Nora get here?', 200]);
        expect(events).toHaveLength(75);
        expect(starts(events)).toEqual(starts(hits).reverse());
        expect(blockShape).toBe('chain');
    });

    // A hit's score is cosine, while its place is the fusion order, which also weighs the keyword match.
    it('keeps the search\'s own order, whatever the scores say', async () => {
        const hits = Array.from({ length: 90 }, (_, i) => event(1000 + i, `hit ${i}`, { score: i / 100 }));
        queryReturns(hits);
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, baseParams);
        expect(starts(events)).toContain(1000);
        expect(starts(events)).not.toContain(1089);
    });

    it('takes turns between searches, so no collection crowds out another', async () => {
        const first = Array.from({ length: 90 }, (_, i) => event(1000 + i, `first ${i}`));
        const second = Array.from({ length: 90 }, (_, i) => event(5000 + i, `second ${i}`));
        queryCollectionMock.mockResolvedValueOnce({ hashes: starts(first), metadata: first });
        queryCollectionMock.mockResolvedValueOnce({ hashes: starts(second), metadata: second });
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, { ...baseParams, liveCollectionIds: [COLLECTION, 'qdrant:vf_eventbase_other'] });
        expect(starts(events).filter(start => start >= 5000)).toHaveLength(37);
    });

    it('walks stored links once the chat has them, reaching events the search did not find', async () => {
        const steps = [100, 200, 300].map((start, i, all) => event(start, `step ${start}`, { story_links: i ? [{ hash: all[i - 1], type: 'continues', thread: 't' }] : [] }));
        listReturns(steps);
        queryReturns([steps[2]]);
        const { events, blockShape, ruleName } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, baseParams);
        expect(starts(events)).toEqual([100, 200, 300]);
        expect(blockShape).toBe('chain');
        expect(ruleName).toBe('shape-recipe');
    });

    it('matches a hit to its listed event when one reports its hash as text', async () => {
        const steps = [100, 200].map((start, i, all) => event(start, `step ${start}`, { story_links: i ? [{ hash: all[i - 1], type: 'continues', thread: 't' }] : [] }));
        listReturns(steps);
        queryCollectionMock.mockResolvedValue({ hashes: ['200'], metadata: [steps[1]] });
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, baseParams);
        expect(starts(events)).toEqual([100, 200]);
    });

    it('gives a first-time question the earliest events naming the subject plus its closest hits, without repeats', async () => {
        const stored = [event(10, 'Nora arrives'), event(5, 'Bo alone'), event(20, 'Nora speaks'), event(900, 'Nora later')];
        listReturns(stored);
        queryReturns([event(900, 'Nora later'), event(800, 'Bo at the docks'), event(700, 'Nora at the docks')]);
        const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, baseParams);
        expect(queryCollectionMock.mock.calls[0][2]).toBe(200);
        expect(listChunksMock.mock.calls[0][2]).toEqual({ limit: 50000 });
        expect(starts(events)).toEqual([10, 20, 700, 900]);
        expect(blockShape).toBe('first_time');
    });

    it('lists only EventBase events, and takes the text from the listing', async () => {
        listChunksMock.mockResolvedValue({
            items: [
                { hash: 1, text: 'Nora in a chunk', metadata: { source_window_start: 1 } },
                { hash: 2, text: 'Nora in an event', metadata: { eventbase: true, source_window_start: 2 } },
            ],
        });
        queryReturns([]);
        const { events } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, baseParams);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ text: 'Nora in an event', _hash: 2, _sortFrame: COLLECTION });
    });

    it('falls to the closest events in time order when the subject is empty or named nowhere', async () => {
        listReturns([event(1, 'Bo alone')]);
        queryReturns([event(300), event(100), event(200)]);
        for (const subject of ['', 'Nora']) {
            const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject }, baseParams);
            expect(starts(events), subject).toEqual([100, 200, 300]);
            expect(blockShape, subject).toBe('chain');
        }
    });

    // Without the listing, a first-time block could not say which events are earliest, and would say so anyway.
    it('finds nothing when the listing fails, and warns, so the turn keeps today\'s path', async () => {
        listChunksMock.mockRejectedValue(new Error('list failed'));
        queryReturns([event(400, 'Nora at the gate')]);
        for (const shape of ['first_time', 'chain', 'current']) {
            const { events, ruleName } = await retrieveStoryRecipeEvents({ shape, subject: 'Nora' }, baseParams);
            expect(events, shape).toEqual([]);
            expect(ruleName, shape).toBe('listing-failed');
        }
        expect(logWarnMock).toHaveBeenCalled();
    });

    it('returns nothing when the query fails, and warns', async () => {
        queryCollectionMock.mockRejectedValue(new Error('query failed'));
        const { events, ruleName } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, baseParams);
        expect(events).toEqual([]);
        expect(ruleName).toBe('recipe-found-nothing');
        expect(logWarnMock).toHaveBeenCalled();
    });

    it('leaves a current-state question to today\'s path until the chat has links', async () => {
        queryReturns([event(100)]);
        const { events, ruleName } = await retrieveStoryRecipeEvents({ shape: 'current', subject: '' }, baseParams);
        expect(events).toEqual([]);
        expect(ruleName).toBe('links-not-generated');
    });

    it('keeps the same rules as normal retrieval: minimum importance and events still in context', async () => {
        queryReturns([event(100, 'kept'), event(200, 'unimportant', { importance: 1 }), event(2990, 'still visible')]);
        const settings = { ...baseParams.settings, eventbase_retrieval_min_importance: 3, deduplication_depth: 20 };
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, { ...baseParams, settings });
        expect(starts(events)).toEqual([100]);
    });

    it('does not apply the context rule across chats', async () => {
        queryReturns([event(2990)]);
        const settings = { ...baseParams.settings, deduplication_depth: 20 };
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, { ...baseParams, settings, skipContextDedup: true });
        expect(starts(events)).toEqual([2990]);
    });

    it('searches every live collection and adds archive hits, without repeats', async () => {
        queryReturns([event(100, 'live', { score: 0.9 })]);
        const { events } = await retrieveStoryRecipeEvents({ shape: 'why', subject: '' }, {
            ...baseParams,
            liveCollectionIds: [COLLECTION, 'qdrant:vf_eventbase_other'],
            additionalCandidates: [event(50, 'archive', { score: 0.5, event_id: 'archive50' })],
        });
        expect(queryCollectionMock).toHaveBeenCalledTimes(2);
        expect(starts(events)).toEqual([50, 100]);
    });

    it('does nothing without a recipe, a collection or a query', async () => {
        for (const [route, params] of [
            [{ shape: 'scene', subject: '' }, baseParams],
            [{ shape: 'chain', subject: '' }, { ...baseParams, liveCollectionIds: [] }],
            [{ shape: 'chain', subject: '' }, { ...baseParams, skipLiveQuery: true }],
            [{ shape: 'chain', subject: '' }, { ...baseParams, keywordQuery: '', searchText: '' }],
        ]) {
            expect((await retrieveStoryRecipeEvents(route, params)).events).toEqual([]);
        }
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });
});

describe('retrieveEventsWithAgent with StoryArc mode', () => {
    const preSearch = { events: [event(9, 'pre-search hit')], debug: { rawCount: 1 } };
    const storyArcOn = {
        vector_backend: 'qdrant',
        agentic_retrieval_enabled: true,
        story_arc_mode_enabled: true,
        agent_provider: 'openrouter',
        agent_model: 'router-model',
    };
    const llmReplies = (...replies) => {
        for (const reply of replies) {
            postChatCompletionMock.mockResolvedValueOnce({ content: JSON.stringify(reply), usage: {} });
        }
    };
    const callAgent = (settings) => retrieveEventsWithAgent({ ...baseParams, settings });
    const routerCalls = () => postChatCompletionMock.mock.calls.filter(([call]) => call.messages[0].content.startsWith('A player is writing'));

    beforeEach(() => {
        postChatCompletionMock.mockReset();
        retrieveEventsMock.mockReset();
        retrieveEventsMock.mockResolvedValue(preSearch);
    });

    it('answers a question about the past from its recipe, skipping the planner and the rerank', async () => {
        llmReplies({ shape: 'chain', subject: 'Nora' });
        queryReturns([event(200), event(100)]);
        const result = await callAgent(storyArcOn);
        expect(starts(result.events)).toEqual([100, 200]);
        expect(result.storyArcShape).toBe('chain');
        expect(result.debug.storyArc).toEqual({ ruleName: 'links-not-generated', cutRuleName: '', shape: 'chain', subject: 'Nora', finalCount: 2 });
        expect(postChatCompletionMock).toHaveBeenCalledTimes(1);
        expect(retrieveEventsMock).toHaveBeenCalledTimes(1);
    });

    it('asks the router with no event hits in its prompt', async () => {
        llmReplies({ shape: 'scene', subject: '' }, { queries: [] });
        await callAgent(storyArcOn);
        const [routerCall] = routerCalls();
        expect(routerCall[0].model).toBe('router-model');
        expect(routerCall[0].messages[1].content).toContain('How did Nora get here?');
        expect(routerCall[0].messages[1].content).not.toContain('pre-search hit');
    });

    describe('thread pick', () => {
        const linkOn = { ...storyArcOn, story_arc_link_provider: 'openrouter', story_arc_link_model: 'link-model' };
        const threadLink = (hash, thread) => ({ hash, type: 'continues', thread });
        /** A thread the search misses, and the hit it does find. */
        const missed = [
            event(10, 'first step', { story_links: [] }),
            event(20, 'second step', { story_links: [threadLink(10, 'Finding the father')] }),
        ];
        const hit = event(500, 'the closest hit', { story_links: [] });
        const pickCalls = () => postChatCompletionMock.mock.calls.filter(([call]) => call.messages[0].content.startsWith('A player asks about the past'));

        beforeEach(() => {
            listReturns([...missed, hit]);
            queryReturns([hit]);
        });

        it('asks the link model at low effort, and seats the events of the threads it picks', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['#20 Finding the father'] });
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual([10, 20, 500]);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick');
            const [[pickCall]] = pickCalls();
            expect(pickCall.model).toBe('link-model');
            expect(pickCall.reasoningEffort).toBe('low');
            expect(pickCall.sendTemperature).toBe(false);
            expect(pickCall.messages[1].content).toBe("Threads:\n#20 Finding the father\n\nPlayer's question:\nHow did Nora get here?");
        });

        it('asks only for a question about a thread', async () => {
            for (const shape of ['first_time', 'current']) {
                postChatCompletionMock.mockReset();
                llmReplies({ shape, subject: 'hit' });
                await callAgent(linkOn);
                expect(pickCalls(), shape).toHaveLength(0);
            }
        });

        it('does not ask on a chat with too few decided events', async () => {
            listReturns([...missed, hit, event(600), event(601), event(602)]);
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(linkOn);
            expect(pickCalls()).toHaveLength(0);
            expect(result.debug.storyArc.ruleName).toBe('links-not-generated');
        });

        it('does not ask when no link has a name', async () => {
            listReturns([event(10, 'first', { story_links: [] }), event(20, 'second', { story_links: [threadLink(10, '')] })]);
            queryReturns([event(20, 'second', { story_links: [threadLink(10, '')] })]);
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(linkOn);
            expect(pickCalls()).toHaveLength(0);
            expect(result.debug.storyArc.ruleName).toBe('shape-recipe');
        });

        it('keeps the recipe when the pick reports nothing', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: [] });
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual([500]);
            expect(result.debug.storyArc.ruleName).toBe('shape-recipe');
        });

        it('runs the recipe without a pick when the call fails, and warns', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual([500]);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('StoryArc thread pick LLM call failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('so the recipe runs without it');
        });

        // A malformed reply must not read as "no threads fit".
        it('counts a reply with no list as a failed pick', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { thread: 'Finding the father' });
            const result = await callAgent(linkOn);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
        });

        it('runs the recipe without a pick when there is no link model, and warns', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([500]);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
            expect(pickCalls()).toHaveLength(0);
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Thread pick skipped: missing_model');
        });
    });

    describe('block cut', () => {
        const linkOn = { ...storyArcOn, story_arc_link_provider: 'openrouter', story_arc_link_model: 'link-model' };
        /** 30 hits at messages 100 to 158, closest last, on a chat with no links. */
        const hits = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, `Nora at ${100 + i * 2}`));
        const closestFirst = [...hits].reverse();
        const cutCalls = () => postChatCompletionMock.mock.calls.filter(([call]) => Object.values(BLOCK_CUT_PROMPT_BY_SHAPE).includes(call.messages[0].content));

        beforeEach(() => queryReturns(closestFirst));

        it('asks the link model at low effort, and keeps the lines it chooses', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: [110, '#102', 999] });
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual([102, 110]);
            expect(result.storyArcShape).toBe('chain');
            expect(result.debug.storyArc).toEqual({ ruleName: 'links-not-generated', cutRuleName: 'block-cut', shape: 'chain', subject: 'Nora', finalCount: 2 });
            const [[cutCall]] = cutCalls();
            expect(cutCall.model).toBe('link-model');
            expect(cutCall.reasoningEffort).toBe('low');
            expect(cutCall.sendTemperature).toBe(false);
            expect(cutCall.messages[0].content).toBe(BLOCK_CUT_PROMPT_BY_SHAPE.chain);
            expect(cutCall.messages[1].content).toContain('- #100: Nora at 100\n- #102: Nora at 102');
            expect(cutCall.messages[1].content.endsWith("Player's question:\nHow did Nora get here?")).toBe(true);
        });

        it('does not ask for a block of 20 or fewer', async () => {
            queryReturns(closestFirst.slice(0, 20));
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(linkOn);
            expect(result.events).toHaveLength(20);
            expect(cutCalls()).toHaveLength(0);
            expect(result.debug.storyArc.cutRuleName).toBe('');
        });

        it('keeps the closest 20 when the call fails, and warns', async () => {
            llmReplies({ shape: 'why', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual(starts(hits).slice(-20));
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut-failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('StoryArc block cut LLM call failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('so the block is cut without it');
        });

        // A malformed reply must not read as "nothing answers this".
        it('counts a reply with no list, or one naming no line, as a failed cut', async () => {
            for (const reply of [{ lines: [100] }, { events: [] }, { events: [999] }]) {
                postChatCompletionMock.mockReset();
                llmReplies({ shape: 'chain', subject: 'Nora' }, reply);
                const result = await callAgent(linkOn);
                expect(result.events, JSON.stringify(reply)).toHaveLength(20);
                expect(result.debug.storyArc.cutRuleName, JSON.stringify(reply)).toBe('block-cut-failed');
            }
        });

        it('keeps the closest 20 when there is no link model, and warns', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual(starts(hits).slice(-20));
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut-failed');
            expect(cutCalls()).toHaveLength(0);
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Block cut skipped: missing_model');
        });

        it('offers no event the filters removed, and seats none', async () => {
            const stillVisible = event(2990, 'Nora still in context');
            queryReturns([stillVisible, ...closestFirst]);
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: [100] });
            const result = await callAgent({ ...linkOn, deduplication_depth: 20 });
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[1].content).not.toContain('#2990');
            expect(starts(result.events)).toEqual([100]);
        });

        it('asks a first-time question with its own prompt, and fills the seats by the rule', async () => {
            listReturns(hits);
            llmReplies({ shape: 'first_time', subject: 'Nora' }, { events: [130] });
            const result = await callAgent(linkOn);
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(BLOCK_CUT_PROMPT_BY_SHAPE.first_time);
            expect(result.events).toHaveLength(20);
            expect(starts(result.events)).toContain(130);
            expect(starts(result.events)).toContain(100);
            expect(result.storyArcShape).toBe('first_time');
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut');
        });

        it('routes a last-time question to its recipe, with its own prompt and block', async () => {
            listReturns(hits);
            // Closest oldest first, so the closest hits are not also its latest events.
            queryReturns(hits);
            llmReplies({ shape: 'last_time', subject: 'Nora' }, { events: [130] });
            const result = await callAgent(linkOn);
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(BLOCK_CUT_PROMPT_BY_SHAPE.last_time);
            expect(result.events).toHaveLength(20);
            expect(starts(result.events)).toContain(130);
            expect(starts(result.events)).toContain(158);
            expect(result.storyArcShape).toBe('last_time');
            expect(result.debug.storyArc).toMatchObject({ ruleName: 'links-not-generated', cutRuleName: 'block-cut', shape: 'last_time' });
        });

        it('fills a first-time block by the rule alone when the call fails', async () => {
            listReturns(hits);
            llmReplies({ shape: 'first_time', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(linkOn);
            // The block is the earliest 5 and the closest 20, so its first 20 skip what neither holds.
            expect(starts(result.events)).toEqual([...starts(hits).slice(0, 5), ...starts(hits).slice(10, 25)]);
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut-failed');
        });

        it('runs after the thread pick, on the block that made', async () => {
            const steps = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, `step ${i}`, { story_links: i ? [{ hash: 100 + (i - 1) * 2, type: 'continues', thread: 'The long road' }] : [] }));
            listReturns(steps);
            queryReturns([steps[29]]);
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['The long road'] }, { events: [100, 158] });
            const result = await callAgent(linkOn);
            expect(starts(result.events)).toEqual([100, 158]);
            expect(result.debug.storyArc).toMatchObject({ ruleName: 'thread-pick', cutRuleName: 'block-cut' });
            expect(cutCalls()).toHaveLength(1);
        });
    });

    describe('resolveStoryLinkLlmConfig', () => {
        // A link needs thought, so the settings that turn thinking off do not apply.
        it('keeps the model\'s own reasoning default and temperature', () => {
            const config = resolveStoryLinkLlmConfig({ story_arc_link_provider: 'openrouter', story_arc_link_model: 'link-model' });
            expect(config).toMatchObject({ ok: true, provider: 'openrouter', model: 'link-model' });
            expect(config.parameterStyle).toEqual({ sendTemperature: false, reasoningEffort: null });
        });

        it('reports a missing model', () => {
            expect(resolveStoryLinkLlmConfig({})).toEqual({ ok: false, reason: 'missing_model' });
        });
    });

    it('sends an ordinary turn down the existing planner path', async () => {
        llmReplies({ shape: 'scene', subject: '' }, { queries: [] });
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('ordinary-turn');
        expect(postChatCompletionMock).toHaveBeenCalledTimes(2);
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });

    it('routes a current-state question to its recipe, which keeps today\'s path until the chat has links', async () => {
        llmReplies({ shape: 'current', subject: 'Nora' }, { queries: [] });
        queryReturns([event(100)]);
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.storyArcShape).toBeUndefined();
        expect(result.debug.storyArc.ruleName).toBe('links-not-generated');
    });

    it('keeps today\'s path and warns when the router fails', async () => {
        postChatCompletionMock.mockRejectedValueOnce(new Error('router down'));
        llmReplies({ queries: [] });
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('StoryArc router'))).toBe(true);
    });

    it('keeps today\'s path and warns on an unknown shape', async () => {
        llmReplies({ shape: 'history', subject: '' }, { queries: [] });
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('unknown shape'))).toBe(true);
    });

    it('keeps today\'s path when the recipe finds nothing', async () => {
        llmReplies({ shape: 'chain', subject: 'Nora' }, { queries: [] });
        queryReturns([]);
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.storyArcShape).toBeUndefined();
        expect(result.debug.storyArc.ruleName).toBe('recipe-found-nothing');
    });

    it('keeps today\'s path when the listing fails, and names the rule', async () => {
        llmReplies({ shape: 'first_time', subject: 'Nora' }, { queries: [] });
        queryReturns([event(100, 'Nora')]);
        listChunksMock.mockRejectedValue(new Error('list failed'));
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('listing-failed');
    });

    it('does not run the router when StoryArc mode is off', async () => {
        llmReplies({ queries: [] });
        await callAgent({ ...storyArcOn, story_arc_mode_enabled: false });
        expect(routerCalls()).toHaveLength(0);
    });

    it('does nothing when Agent Mode is off or the backend is not Qdrant', async () => {
        for (const settings of [{ ...storyArcOn, agentic_retrieval_enabled: false }, { ...storyArcOn, vector_backend: 'standard' }]) {
            expect(await callAgent(settings)).toBe(preSearch);
        }
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });

    it('skips the router and warns when no Agent Mode model is set', async () => {
        const result = await callAgent({ ...storyArcOn, agent_model: '', chat_model: '' });
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('Router skipped'))).toBe(true);
    });
});
