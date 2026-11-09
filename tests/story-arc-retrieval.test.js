/**
 * Tests for StoryArc mode's recipes (src/features/eventbase/story-arc-retrieval.js)
 * and how retrieval routes to them (src/features/eventbase/agentic-retrieval.js).
 *
 * Guards that:
 *   - a thread question gets a wide pool in chat order, past the top-K trim,
 *   - a first-time question gets the subject's earliest events and closest hits,
 *   - stored links are walked once a chat has them,
 *   - a thread question asks the link model which threads to add, by label, and survives its failure,
 *   - a long block is cut by the link model with a prompt for its shape, and survives its failure,
 *   - ordinary turns, router failures, a failed listing and empty recipes keep the pre-search, and no planner runs,
 *   - the listing and the pool query start beside the router, unless entity merges make the pool wait for its subject,
 *   - the router follows Core's thinking switch, and the thread pick and the cut ask at low effort,
 *   - every StoryArc turn reports the Route rule that decided it,
 *   - StoryArc mode runs on its own switch and Qdrant, with Agent Mode on or off,
 *   - merged entity names reach the search, the recipe, the cut and the block, and nothing stored changes,
 *   - a story web search calls no LLM.
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

let entityMerges = {};
vi.mock('../src/features/collections/index.js', () => ({
    getCollectionMeta: () => ({ storyEntityMerges: entityMerges }),
    setCollectionMeta: vi.fn(),
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

const chatState = vi.hoisted(() => ({ chat: [] }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ chat: chatState.chat }) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => true) }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({
    generationRateLimiter: { execute: (run) => run() },
    generationRateLimitSettings: () => ({}),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({
    stripReasoningBlocks: (text) => text,
    stripGameSystemBlocks: (text) => text,
    // Stands in for a Text Cleaning preset that removes an aside block.
    cleanText: (text) => text.replace(/<aside>[\s\S]*?<\/aside>/g, '').trim(),
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

const { findStoryWebEvents, retrieveStoryRecipeEvents } = await import('../src/features/eventbase/story-arc-retrieval.js');
const { resolveStoryLinkLlmConfig, retrieveEventsForTurn } = await import('../src/features/eventbase/agentic-retrieval.js');
const { buildBlockCutPrompt } = await import('../src/features/eventbase/story-arc-core.js');

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
    settings: { vector_backend: 'qdrant', story_arc_block_scale: 0.7 },
    liveCollectionIds: [COLLECTION],
    boundQuery: (promise) => promise,
};

beforeEach(() => {
    vi.clearAllMocks();
    queryCollectionMock.mockReset();
    listChunksMock.mockReset();
    listReturns([]);
    entityMerges = {};
});

describe('retrieveStoryRecipeEvents', () => {
    it('gives a short story\'s thread question 40 hits in chat order, past the top-K trim', async () => {
        const hits = Array.from({ length: 75 }, (_, i) => event(1000 - i));
        queryReturns(hits);
        const { events, blockShape } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, { ...baseParams, settings: { ...baseParams.settings, eventbase_retrieval_top_k: 10 } });
        expect(queryCollectionMock.mock.calls[0].slice(0, 3)).toEqual([COLLECTION, 'How did Nora get here?', 200]);
        expect(events).toHaveLength(40);
        expect(starts(events)).toEqual(starts(hits).slice(0, 40).reverse());
        expect(blockShape).toBe('chain');
    });

    it('gives a longer story\'s thread question more hits', async () => {
        listReturns(Array.from({ length: 1800 }, (_, i) => event(5000 + i)));
        queryReturns(Array.from({ length: 90 }, (_, i) => event(1000 - i)));
        const { events } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, baseParams);
        expect(events).toHaveLength(75);
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
        expect(starts(events).filter(start => start >= 5000)).toHaveLength(20);
    });

    it('walks stored links once the chat has them, reaching events the search did not find', async () => {
        const steps = [100, 200, 300].map((start, i, all) => event(start, `step ${start}`, { story_links: i ? [{ event_id: `id${all[i - 1]}`, type: 'continues', thread: 't' }] : [] }));
        listReturns(steps);
        queryReturns([steps[2]]);
        const { events, blockShape, ruleName } = await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Nora' }, baseParams);
        expect(starts(events)).toEqual([100, 200, 300]);
        expect(blockShape).toBe('chain');
        expect(ruleName).toBe('shape-recipe');
    });

    it('matches a hit to its listed event when one reports its hash as text', async () => {
        const steps = [100, 200].map((start, i, all) => event(start, `step ${start}`, { story_links: i ? [{ event_id: `id${all[i - 1]}`, type: 'continues', thread: 't' }] : [] }));
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

describe('entity merges', () => {
    const stored = [
        event(10, 'The Oracle speaks through a servant'),
        event(20, 'Nora prays', { characters: ['Nora'] }),
        event(30, 'Nora hears the Oracle again'),
    ];
    const question = 'How did Nora first reach me?';

    it('leaves the search as it is with no merges', async () => {
        listReturns(stored);
        queryReturns([stored[1]]);
        const { entityNames } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, { ...baseParams, keywordQuery: question });
        expect(queryCollectionMock.mock.calls[0][1]).toBe(question);
        expect(entityNames).toEqual([]);
    });

    it('asks the search for the other names', async () => {
        entityMerges = { Nora: ['Oracle'] };
        listReturns(stored);
        queryReturns([stored[1]]);
        await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, { ...baseParams, keywordQuery: question });
        expect(queryCollectionMock.mock.calls[0][1]).toBe(`${question} Oracle`);
    });

    it('finds a first event stored under the other name, and reads it with the kept name', async () => {
        entityMerges = { Nora: ['Oracle'] };
        listReturns(stored);
        queryReturns([stored[1]]);
        const { events } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, { ...baseParams, keywordQuery: question });
        expect(starts(events)).toEqual([10, 20, 30]);
        expect(events[0].text).toBe('The Nora speaks through a servant');
    });

    it('resolves a subject the player gave under the other name', async () => {
        entityMerges = { Nora: ['Oracle'] };
        listReturns(stored);
        queryReturns([stored[1]]);
        const { events, entityNames } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Oracle' }, { ...baseParams, keywordQuery: 'How did the Oracle first reach me?' });
        expect(starts(events)).toEqual([10, 20, 30]);
        expect(entityNames).toEqual([{ name: 'Oracle', keptName: 'Nora' }]);
    });

    it('gives the cut and the thread pick kept names', async () => {
        entityMerges = { Nora: ['Oracle'] };
        const many = Array.from({ length: 30 }, (_, i) => event(100 + i, `Oracle step ${i}`));
        listReturns(many);
        queryReturns(many);
        const pickThreads = vi.fn(async () => []);
        const chooseBlockEvents = vi.fn(async () => null);
        await retrieveStoryRecipeEvents({ shape: 'chain', subject: 'Oracle' }, { ...baseParams, keywordQuery: 'How did the Oracle get here?', pickThreads, chooseBlockEvents });
        const [cutEvents, keptNames] = chooseBlockEvents.mock.calls[0];
        expect(keptNames).toEqual({ question: 'How did the Nora get here?', subject: 'Nora' });
        expect(cutEvents[0].text).toBe('Nora step 0');
    });

    it('still reports a failed listing', async () => {
        entityMerges = { Nora: ['Oracle'] };
        listChunksMock.mockRejectedValue(new Error('gone'));
        queryReturns([stored[1]]);
        const { events, ruleName } = await retrieveStoryRecipeEvents({ shape: 'first_time', subject: 'Nora' }, { ...baseParams, keywordQuery: question });
        expect(events).toEqual([]);
        expect(ruleName).toBe('listing-failed');
    });
});

describe('findStoryWebEvents', () => {
    it('finds the closest events and what they reach along links, with no LLM', async () => {
        const stored = [
            { ...event(10, 'Oracle one'), _hash: 10, story_links: [] },
            { ...event(20, 'Nora two'), _hash: 20, story_links: [{ event_id: 'id10', type: 'continues', thread: 'A' }] },
            { ...event(30, 'Tom three'), _hash: 30, story_links: [] },
        ];
        queryReturns([stored[1]]);
        const found = await findStoryWebEvents({ question: 'Where is Nora?', collectionKey: COLLECTION, storedEvents: stored, merges: { Nora: ['Oracle'] }, settings: baseParams.settings });
        expect(queryCollectionMock.mock.calls[0][1]).toBe('Where is Nora? Oracle');
        expect(found.closestHashes).toEqual([20]);
        expect(found.reachedHashes.sort()).toEqual([10, 20]);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });
});

describe('retrieveEventsForTurn with StoryArc mode', () => {
    const preSearch = { events: [event(9, 'pre-search hit')], debug: { rawCount: 1 } };
    const storyArcOn = {
        vector_backend: 'qdrant',
        story_arc_mode_enabled: true,
        story_arc_link_provider: 'openrouter',
        story_arc_link_model: 'link-model',
        story_arc_block_scale: 0.7,
    };
    const llmReplies = (...replies) => {
        for (const reply of replies) {
            postChatCompletionMock.mockResolvedValueOnce({ content: JSON.stringify(reply), usage: {} });
        }
    };
    const callAgent = (settings) => retrieveEventsForTurn({ ...baseParams, settings });
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

    it('asks the router at low effort when Core\'s thinking switch is off, as some models reject none', async () => {
        llmReplies({ shape: 'scene', subject: '' });
        await callAgent({ ...storyArcOn, should_disable_thinking: false });
        expect(routerCalls()[0][0].reasoningEffort).toBe('low');
    });

    it('asks the router on the link model with no thinking while Core\'s thinking switch is on, with no event hits in its prompt', async () => {
        llmReplies({ shape: 'scene', subject: '' });
        await callAgent({ ...storyArcOn, agent_provider: 'openrouter', agent_model: 'agent-model' });
        const [routerCall] = routerCalls();
        expect(routerCall[0].model).toBe('link-model');
        expect(routerCall[0].reasoningEffort).toBe('none');
        expect(routerCall[0].sendTemperature).toBe(false);
        expect(routerCall[0].messages[1].content).toContain('How did Nora get here?');
        expect(routerCall[0].messages[1].content).not.toContain('pre-search hit');
    });

    it('reads the recent chat through Text Cleaning, then the first 3,500 characters of each turn', async () => {
        const story = `Nora draws her sword at the gate.${'x'.repeat(4000)}`;
        chatState.chat = [
            { is_user: false, name: 'Nora', mes: `<aside>${'status '.repeat(200)}</aside>${story}` },
            { is_user: true, mes: 'How did Nora get here?' },
        ];
        llmReplies({ shape: 'scene', subject: '' });
        await callAgent(storyArcOn);
        chatState.chat = [];
        const routerMessage = routerCalls()[0][0].messages[1].content;
        expect(routerMessage).toContain(`Nora: ${story.slice(0, 3500)}\n`);
        expect(routerMessage).not.toContain(story.slice(0, 3501));
        expect(routerMessage).not.toContain('status');
    });

    describe('thread pick', () => {
        const threadLink = (hash, thread) => ({ event_id: `id${hash}`, type: 'continues', thread });
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

        it('asks the link model at low effort for thread labels, and seats the events of the threads it picks', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['T1'] });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([10, 20, 500]);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick');
            const [[pickCall]] = pickCalls();
            expect(pickCall.model).toBe('link-model');
            expect(pickCall.reasoningEffort).toBe('low');
            expect(pickCall.sendTemperature).toBe(false);
            expect(pickCall.messages[1].content).toBe("Threads:\nT1 #20 Finding the father\n\nPlayer's question:\nHow did Nora get here?");
        });

        it('stays at low effort with Core\'s thinking switch off, never the switch\'s minimal', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['T1'] });
            await callAgent({ ...storyArcOn, should_disable_thinking: false });
            expect(pickCalls()[0][0].reasoningEffort).toBe('low');
        });

        it('asks only for a question about a thread', async () => {
            for (const shape of ['first_time', 'current']) {
                postChatCompletionMock.mockReset();
                llmReplies({ shape, subject: 'hit' });
                await callAgent(storyArcOn);
                expect(pickCalls(), shape).toHaveLength(0);
            }
        });

        it('does not ask on a chat with too few decided events', async () => {
            listReturns([...missed, hit, event(600), event(601), event(602)]);
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(storyArcOn);
            expect(pickCalls()).toHaveLength(0);
            expect(result.debug.storyArc.ruleName).toBe('links-not-generated');
        });

        it('does not ask when no link has a name', async () => {
            listReturns([event(10, 'first', { story_links: [] }), event(20, 'second', { story_links: [threadLink(10, '')] })]);
            queryReturns([event(20, 'second', { story_links: [threadLink(10, '')] })]);
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(storyArcOn);
            expect(pickCalls()).toHaveLength(0);
            expect(result.debug.storyArc.ruleName).toBe('shape-recipe');
        });

        it('keeps the recipe when the pick reports nothing', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: [] });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([500]);
            expect(result.debug.storyArc.ruleName).toBe('shape-recipe');
        });

        it('runs the recipe without a pick when the call fails, and warns', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([500]);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('StoryArc thread pick LLM call failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('so the recipe runs without it');
        });

        // A malformed reply must not read as "no threads fit".
        it('counts a reply with no list as a failed pick', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { thread: 'Finding the father' });
            const result = await callAgent(storyArcOn);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
        });

        // The block still holds the picked threads, so the turn says its memory is incomplete.
        it('reports a failed search with the block the picked threads still give', async () => {
            queryCollectionMock.mockRejectedValue(new Error('provider down'));
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['T1'] });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([10, 20]);
            expect(result.debug.failedSearchCount).toBe(1);
            expect(result.debug.searchFailureMessage).toBe('provider down');
        });

        // An ordinary turn injects the pre-search, so its failures are the turn's, and the recipe's reads are not.
        it('reports the pre-search\'s failures on an ordinary turn, not the reads started beside the router', async () => {
            queryCollectionMock.mockRejectedValue(new Error('provider down'));
            retrieveEventsMock.mockResolvedValue({ ...preSearch, debug: { rawCount: 1, failedSearchCount: 0, searchFailureMessage: '' } });
            llmReplies({ shape: 'scene', subject: '' });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([9]);
            expect(result.debug.failedSearchCount).toBe(0);
        });

        it('counts a reply of names, with no thread label, as a failed pick', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['Finding the father'] });
            const result = await callAgent(storyArcOn);
            expect(result.debug.storyArc.ruleName).toBe('thread-pick-failed');
        });

    });

    describe('ordinary turn', () => {
        /** A linked thread of 30 steps at messages 100 to 158, longer than a short story's 10 lines. */
        const steps = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, `step ${i}`, { story_links: i ? [{ event_id: `id${100 + (i - 1) * 2}`, type: 'continues', thread: 'The long road' }] : [] }));

        beforeEach(() => listReturns(steps));

        it('gets the chain block, cut by the fixed rule, with no LLM call after the router', async () => {
            llmReplies({ shape: 'scene', subject: 'Nora' });
            queryReturns([steps[29], steps[14]]);
            const result = await callAgent(storyArcOn);
            expect(result.events).toHaveLength(10);
            expect(starts(result.events)).toEqual(expect.arrayContaining([128, 158]));
            expect(result.storyArcShape).toBe('scene');
            expect(result.debug.storyArc).toEqual({ ruleName: 'ordinary-turn', cutRuleName: 'block-cut-by-rule', shape: 'scene', subject: 'Nora', finalCount: 10 });
            expect(postChatCompletionMock).toHaveBeenCalledTimes(1);
        });

        // The block is the chain recipe with no subject, as the free chain was judged.
        it('searches with the message alone, not the router\'s subject', async () => {
            entityMerges = { Nora: ['Oracle'] };
            listReturns([...steps, event(300, 'The Oracle speaks through a servant'), event(302, 'Nora prays')]);
            llmReplies({ shape: 'scene', subject: 'Nora' });
            queryReturns([steps[29]]);
            await retrieveEventsForTurn({ ...baseParams, keywordQuery: 'How did she get here?', settings: storyArcOn });
            // With the subject, the search would read "How did she get here? Nora Oracle".
            expect(queryCollectionMock.mock.calls.map(call => call[1])).toEqual(['How did she get here?']);
        });

        it('keeps the pre-search when its block finds nothing', async () => {
            llmReplies({ shape: 'scene', subject: '' });
            queryReturns([]);
            const result = await callAgent(storyArcOn);
            expect(result.events).toBe(preSearch.events);
            expect(result.debug.storyArc).toMatchObject({ ruleName: 'recipe-found-nothing', finalCount: 0 });
        });

        it('keeps the pre-search when the router fails, as that is no ordinary turn', async () => {
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            queryReturns([steps[29]]);
            const result = await callAgent(storyArcOn);
            expect(result.events).toBe(preSearch.events);
            expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        });
    });

    describe('block cut', () => {
        /** 30 hits at messages 100 to 158, closest last, on a chat with no links. */
        const hits = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, `Nora at ${100 + i * 2}`));
        const closestFirst = [...hits].reverse();
        const cutCalls = () => postChatCompletionMock.mock.calls.filter(([call]) => call.messages[0].content.includes('# label of each line'));

        beforeEach(() => queryReturns(closestFirst));

        it('stays at low effort with Core\'s thinking switch off, never the switch\'s minimal', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: [120] });
            await callAgent({ ...storyArcOn, should_disable_thinking: false });
            expect(cutCalls()[0][0].reasoningEffort).toBe('low');
        });

        it('asks the link model at low effort, and keeps the lines it chooses', async () => {
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: [120, '#112', 999] });
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual([112, 120]);
            expect(result.storyArcShape).toBe('chain');
            expect(result.debug.storyArc).toEqual({ ruleName: 'links-not-generated', cutRuleName: 'block-cut', shape: 'chain', subject: 'Nora', finalCount: 2 });
            const [[cutCall]] = cutCalls();
            expect(cutCall.model).toBe('link-model');
            expect(cutCall.reasoningEffort).toBe('low');
            expect(cutCall.sendTemperature).toBe(false);
            expect(cutCall.messages[0].content).toBe(buildBlockCutPrompt('chain', 10));
            expect(cutCall.messages[1].content).toContain('- #110: Nora at 110\n- #112: Nora at 112');
            expect(cutCall.messages[1].content.endsWith("Player's question:\nHow did Nora get here?")).toBe(true);
        });

        it('does not ask for a block no longer than a short story\'s 10 lines', async () => {
            queryReturns(closestFirst.slice(0, 10));
            llmReplies({ shape: 'chain', subject: 'Nora' });
            const result = await callAgent(storyArcOn);
            expect(result.events).toHaveLength(10);
            expect(cutCalls()).toHaveLength(0);
            expect(result.debug.storyArc.cutRuleName).toBe('');
        });

        it('asks for the lines a longer story keeps, and holds the reply to them', async () => {
            listReturns(Array.from({ length: 800 }, (_, i) => event(5000 + i)));
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: starts(hits) });
            const result = await callAgent(storyArcOn);
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(buildBlockCutPrompt('chain', 27));
            expect(result.events).toHaveLength(27);
        });

        it('asks for the lines the Block size setting gives', async () => {
            listReturns(Array.from({ length: 800 }, (_, i) => event(5000 + i)));
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: starts(hits) });
            const result = await callAgent({ ...storyArcOn, story_arc_block_scale: 0.5 });
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(buildBlockCutPrompt('chain', 19));
            expect(result.events).toHaveLength(19);
        });

        it('keeps the closest of a short story\'s 10 lines when the call fails, and warns', async () => {
            llmReplies({ shape: 'why', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(storyArcOn);
            expect(starts(result.events)).toEqual(starts(hits).slice(-10));
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut-failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('StoryArc block cut LLM call failed');
            expect(logWarnMock.mock.calls.flat().join(' ')).toContain('so the block is cut without it');
        });

        // A malformed reply must not read as "nothing answers this".
        it('counts a reply with no list, or one naming no line, as a failed cut', async () => {
            for (const reply of [{ lines: [100] }, { events: [] }, { events: [999] }]) {
                postChatCompletionMock.mockReset();
                llmReplies({ shape: 'chain', subject: 'Nora' }, reply);
                const result = await callAgent(storyArcOn);
                expect(result.events, JSON.stringify(reply)).toHaveLength(10);
                expect(result.debug.storyArc.cutRuleName, JSON.stringify(reply)).toBe('block-cut-failed');
            }
        });

        it('offers no event the filters removed, and seats none', async () => {
            const stillVisible = event(2990, 'Nora still in context');
            queryReturns([stillVisible, ...closestFirst]);
            llmReplies({ shape: 'chain', subject: 'Nora' }, { events: [120] });
            const result = await callAgent({ ...storyArcOn, deduplication_depth: 20 });
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[1].content).not.toContain('#2990');
            expect(starts(result.events)).toEqual([120]);
        });

        it('asks a first-time question with its own prompt, and keeps the chosen line\'s scene', async () => {
            listReturns(hits);
            llmReplies({ shape: 'first_time', subject: 'Nora' }, { events: [130] });
            const result = await callAgent(storyArcOn);
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(buildBlockCutPrompt('first_time', 10));
            // The 10 lines are the one chosen and the block's lines closest to it.
            expect(starts(result.events)).toEqual(starts(hits).filter(start => start >= 120 && start <= 138));
            expect(result.storyArcShape).toBe('first_time');
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut');
        });

        it('routes a last-time question to its recipe, with its own prompt and block', async () => {
            listReturns(hits);
            // Closest oldest first, so the closest hits are not also its latest events.
            queryReturns(hits);
            llmReplies({ shape: 'last_time', subject: 'Nora' }, { events: [130] });
            const result = await callAgent(storyArcOn);
            const [[cutCall]] = cutCalls();
            expect(cutCall.messages[0].content).toBe(buildBlockCutPrompt('last_time', 10));
            expect(starts(result.events)).toEqual(starts(hits).filter(start => start >= 120 && start <= 138));
            expect(result.storyArcShape).toBe('last_time');
            expect(result.debug.storyArc).toMatchObject({ ruleName: 'links-not-generated', cutRuleName: 'block-cut', shape: 'last_time' });
        });

        it('fills a first-time block by the rule alone when the call fails', async () => {
            listReturns(hits);
            llmReplies({ shape: 'first_time', subject: 'Nora' });
            postChatCompletionMock.mockRejectedValueOnce(new Error('provider down'));
            const result = await callAgent(storyArcOn);
            // The block is the earliest 5 and the closest 20, so its first 10 skip what neither holds.
            expect(starts(result.events)).toEqual([...starts(hits).slice(0, 5), ...starts(hits).slice(10, 15)]);
            expect(result.debug.storyArc.cutRuleName).toBe('block-cut-failed');
        });

        it('runs after the thread pick, on the block that made', async () => {
            const steps = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, `step ${i}`, { story_links: i ? [{ event_id: `id${100 + (i - 1) * 2}`, type: 'continues', thread: 'The long road' }] : [] }));
            listReturns(steps);
            queryReturns([steps[29]]);
            llmReplies({ shape: 'chain', subject: 'Nora' }, { threads: ['T1'] }, { events: [100, 158] });
            const result = await callAgent(storyArcOn);
            // The cut's 2 lines, then the windows right beside them in its free seats.
            expect(starts(result.events)).toEqual([100, 102, 156, 158]);
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

    describe('what a recipe reads, beside the router', () => {
        /** The router's call, which answers only when the test says so. */
        const holdRouter = () => {
            let answer;
            postChatCompletionMock.mockImplementationOnce(() => new Promise((resolve) => {
                answer = reply => resolve({ content: JSON.stringify(reply), usage: {} });
            }));
            return reply => answer(reply);
        };
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));

        it('lists the collection and runs the pool query before the router answers, and reads each once', async () => {
            const answerRouter = holdRouter();
            queryReturns([event(200), event(100)]);
            const turn = callAgent(storyArcOn);
            await settle();
            expect(listChunksMock).toHaveBeenCalledTimes(1);
            expect(queryCollectionMock.mock.calls.map(call => call.slice(0, 3))).toEqual([[COLLECTION, 'How did Nora get here?', 200]]);
            answerRouter({ shape: 'chain', subject: 'Nora' });
            const result = await turn;
            expect(starts(result.events)).toEqual([100, 200]);
            expect(listChunksMock).toHaveBeenCalledTimes(1);
            expect(queryCollectionMock).toHaveBeenCalledTimes(1);
        });

        it('waits for the router\'s subject before the pool query when entity merges change its text', async () => {
            entityMerges = { Nora: ['Oracle'] };
            listReturns([event(10, 'The Oracle speaks through a servant'), event(100, 'Nora prays')]);
            const answerRouter = holdRouter();
            queryReturns([event(100, 'Nora prays')]);
            const turn = callAgent(storyArcOn);
            await settle();
            expect(listChunksMock).toHaveBeenCalledTimes(1);
            expect(queryCollectionMock).not.toHaveBeenCalled();
            answerRouter({ shape: 'chain', subject: 'Nora' });
            await turn;
            expect(queryCollectionMock.mock.calls[0][1]).toBe('How did Nora get here? Oracle');
        });

        it('keeps the pre-search on an ordinary turn of a chat with too few links, with no planner call', async () => {
            llmReplies({ shape: 'scene', subject: '' });
            queryReturns([event(200)]);
            const result = await callAgent(storyArcOn);
            expect(result.events).toBe(preSearch.events);
            expect(result.storyArcShape).toBeUndefined();
            expect(result.debug.storyArc).toMatchObject({ ruleName: 'links-not-generated', cutRuleName: '', finalCount: 0 });
            expect(result.debug.agenticMode).toBeUndefined();
            expect(postChatCompletionMock).toHaveBeenCalledTimes(1);
        });

        it('reads nothing without a link model, as no router runs', async () => {
            await callAgent({ ...storyArcOn, story_arc_link_model: '' });
            expect(listChunksMock).not.toHaveBeenCalled();
            expect(queryCollectionMock).not.toHaveBeenCalled();
        });
    });

    it('runs no planner with Agent Mode on as well', async () => {
        llmReplies({ shape: 'scene', subject: '' });
        const result = await callAgent({ ...storyArcOn, agentic_retrieval_enabled: true, agent_provider: 'openrouter', agent_model: 'agent-model' });
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.agenticMode).toBeUndefined();
        expect(postChatCompletionMock).toHaveBeenCalledTimes(1);
    });

    it('routes a current-state question to its recipe, which keeps the pre-search until the chat has links', async () => {
        llmReplies({ shape: 'current', subject: 'Nora' });
        queryReturns([event(100)]);
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.storyArcShape).toBeUndefined();
        expect(result.debug.storyArc.ruleName).toBe('links-not-generated');
    });

    it('keeps the pre-search and warns when the router fails', async () => {
        postChatCompletionMock.mockRejectedValueOnce(new Error('router down'));
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('StoryArc router'))).toBe(true);
    });

    it('keeps the pre-search and warns on an unknown shape', async () => {
        llmReplies({ shape: 'history', subject: '' });
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('unknown shape'))).toBe(true);
    });

    it('keeps the pre-search when the recipe finds nothing', async () => {
        llmReplies({ shape: 'chain', subject: 'Nora' });
        queryReturns([]);
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.storyArcShape).toBeUndefined();
        expect(result.debug.storyArc.ruleName).toBe('recipe-found-nothing');
    });

    it('keeps the pre-search when the listing fails, and names the rule', async () => {
        llmReplies({ shape: 'first_time', subject: 'Nora' });
        queryReturns([event(100, 'Nora')]);
        listChunksMock.mockRejectedValue(new Error('list failed'));
        const result = await callAgent(storyArcOn);
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('listing-failed');
    });

    it('gives the router its own token limit, not Agent Mode\'s', async () => {
        llmReplies({ shape: 'scene', subject: '' });
        await callAgent({ ...storyArcOn, agentic_retrieval_max_tokens: 256 });
        const [routerCall] = routerCalls();
        expect(routerCall[0].maxTokens).toBe(9000);
    });

    it('does not run the router when StoryArc mode is off', async () => {
        await callAgent({ ...storyArcOn, story_arc_mode_enabled: false });
        expect(routerCalls()).toHaveLength(0);
    });

    it('does nothing when the backend is not Qdrant', async () => {
        expect(await callAgent({ ...storyArcOn, vector_backend: 'standard' })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });

    it('answers a question with Agent Mode off', async () => {
        llmReplies({ shape: 'chain', subject: 'Nora' });
        queryReturns([event(200), event(100)]);
        const result = await callAgent({ ...storyArcOn, agentic_retrieval_enabled: false });
        expect(starts(result.events)).toEqual([100, 200]);
        expect(result.storyArcShape).toBe('chain');
    });

    it('skips the router and warns when no link model is set', async () => {
        const result = await callAgent({ ...storyArcOn, story_arc_link_model: '', agent_model: 'agent-model', chat_model: 'chat-model' });
        expect(result.events).toBe(preSearch.events);
        expect(result.debug.storyArc.ruleName).toBe('router-unusable');
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.calls.some(([message]) => String(message).includes('Router skipped: missing_model'))).toBe(true);
    });
});
