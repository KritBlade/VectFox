/**
 * Tests for StoryArc mode's recipes (src/features/eventbase/story-arc-retrieval.js)
 * and how Agent Mode routes to them (src/features/eventbase/agentic-retrieval.js).
 *
 * Guards that:
 *   - a thread question gets a wide pool in chat order, past the top-K trim,
 *   - a first-time question gets the subject's earliest events and closest hits,
 *   - ordinary turns, router failures and empty recipes keep today's path,
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
    resolveModelParameterStyle: () => ({}),
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
const { retrieveEventsWithAgent } = await import('../src/features/eventbase/agentic-retrieval.js');

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
    it('gives a thread question 50 hits in chat order, past the top-K trim', async () => {
        const hits = Array.from({ length: 50 }, (_, i) => event(1000 - i));
        queryReturns(hits);
        const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, { ...baseParams, settings: { ...baseParams.settings, eventbase_retrieval_top_k: 10 } });
        expect(queryCollectionMock.mock.calls[0].slice(0, 3)).toEqual([COLLECTION, 'How did Nora get here?', 50]);
        expect(events).toHaveLength(50);
        expect(starts(events)).toEqual(starts(hits).reverse());
        expect(blockShape).toBe('chain');
        expect(listChunksMock).not.toHaveBeenCalled();
    });

    it('gives a first-time question the earliest events naming the subject plus its closest hits, without repeats', async () => {
        const stored = [event(10, 'Nora arrives'), event(5, 'Bo alone'), event(20, 'Nora speaks'), event(900, 'Nora later')];
        listReturns(stored);
        queryReturns([event(900, 'Nora later'), event(800, 'Bo at the docks'), event(700, 'Nora at the docks')]);
        const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, baseParams);
        expect(queryCollectionMock.mock.calls[0][2]).toBe(100);
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

    it('still uses the closest hits when the listing fails, and warns', async () => {
        listChunksMock.mockRejectedValue(new Error('list failed'));
        queryReturns([event(400, 'Nora at the gate')]);
        const { events } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, baseParams);
        expect(starts(events)).toEqual([400]);
        expect(logWarnMock).toHaveBeenCalled();
    });

    it('returns nothing when the query fails, and warns', async () => {
        queryCollectionMock.mockRejectedValue(new Error('query failed'));
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: '' }, baseParams);
        expect(events).toEqual([]);
        expect(logWarnMock).toHaveBeenCalled();
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
            [{ shape: 'current', subject: '' }, baseParams],
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

    it('sends an ordinary turn down the existing planner path', async () => {
        llmReplies({ shape: 'scene', subject: '' }, { queries: [] });
        const result = await callAgent(storyArcOn);
        expect(result).toBe(preSearch);
        expect(postChatCompletionMock).toHaveBeenCalledTimes(2);
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });

    it('keeps today\'s path for a current-state question', async () => {
        llmReplies({ shape: 'current', subject: 'Nora' }, { queries: [] });
        expect(await callAgent(storyArcOn)).toBe(preSearch);
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });

    it('keeps today\'s path and warns when the router fails', async () => {
        postChatCompletionMock.mockRejectedValueOnce(new Error('router down'));
        llmReplies({ queries: [] });
        expect(await callAgent(storyArcOn)).toBe(preSearch);
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('StoryArc router'))).toBe(true);
    });

    it('keeps today\'s path and warns on an unknown shape', async () => {
        llmReplies({ shape: 'history', subject: '' }, { queries: [] });
        expect(await callAgent(storyArcOn)).toBe(preSearch);
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('unknown shape'))).toBe(true);
    });

    it('keeps today\'s path when the recipe finds nothing', async () => {
        llmReplies({ shape: 'chain', subject: 'Nora' }, { queries: [] });
        queryReturns([]);
        const result = await callAgent(storyArcOn);
        expect(result).toBe(preSearch);
        expect(result.storyArcShape).toBeUndefined();
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
        expect(result).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('Router skipped'))).toBe(true);
    });
});
