/**
 * Tests for Agent Mode's planner with StoryArc mode off (src/features/eventbase/agentic-retrieval.js).
 *
 * Guards that:
 *   - the pre-search keeps every seat it won, and the planner's searches add up to 5 from outside its results,
 *   - there is no second rerank,
 *   - the planner runs alongside the pre-search, and sees none of its hits,
 *   - a failed planner or query leaves the turn with what still works,
 *   - added events pass the same filters and duplicate rule as the pre-search's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryCollectionMock = vi.fn();
vi.mock('../src/features/vector-backend/index.js', () => ({
    queryCollection: (...args) => queryCollectionMock(...args),
    listChunks: vi.fn(),
    getQueryVector: vi.fn(),
    getBackendForCollection: vi.fn(),
    getBackend: vi.fn(),
}));
vi.mock('../src/features/collections/index.js', () => ({ getCollectionMeta: () => ({}), setCollectionMeta: vi.fn() }));

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

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ chat: [{ is_user: true, name: 'Rin', mes: 'an earlier line' }] }) }));
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

const { retrieveEventsForTurn } = await import('../src/features/eventbase/agentic-retrieval.js');

const COLLECTION = 'qdrant:vf_eventbase_chat';
const event = (id, extra = {}) => ({ event_id: id, source_window_start: 100, source_window_end: 101, importance: 5, text: `text of ${id}`, ...extra });
const ids = events => events.map(item => item.event_id);

const kept = [event('kept1'), event('kept2')];
const preSearch = { events: kept, poolEvents: [...kept, event('trimmed')], debug: { rawCount: 3 } };
const agentOn = { vector_backend: 'qdrant', agentic_retrieval_enabled: true, agent_provider: 'openrouter', agent_model: 'agent-model' };
const baseParams = { keywordQuery: 'Where did Nora go?', searchText: 'recent chat', chatLength: 3000, liveCollectionIds: [COLLECTION] };
const callAgent = (settings = agentOn) => retrieveEventsForTurn({ ...baseParams, settings });

const planReturns = (plan) => postChatCompletionMock.mockResolvedValue({ content: JSON.stringify(plan), usage: {} });
const hitsReturn = (hitsByQuery) => queryCollectionMock.mockImplementation(async (collection, query) => {
    const hits = hitsByQuery[query] ?? [];
    if (hits instanceof Error) throw hits;
    return { hashes: hits.map((_, place) => place + 1), metadata: hits };
});

beforeEach(() => {
    vi.clearAllMocks();
    queryCollectionMock.mockReset();
    postChatCompletionMock.mockReset();
    retrieveEventsMock.mockReset();
    retrieveEventsMock.mockResolvedValue(preSearch);
});

describe('Agent Mode seats', () => {
    it('keeps every pre-search seat, and adds the queries\' events from outside its results', async () => {
        planReturns({ queries: ['first query', 'second query'], rationale: 'why' });
        hitsReturn({
            'first query': [event('kept1'), event('trimmed'), event('new1'), event('new2')],
            'second query': [event('new3')],
        });
        const result = await callAgent();
        expect(ids(result.events)).toEqual(['kept1', 'kept2', 'new1', 'new3', 'new2']);
    });

    it('adds at most 5, and runs no second rerank', async () => {
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': Array.from({ length: 20 }, (_, place) => event(`new${place}`)) });
        const result = await callAgent();
        expect(result.events).toHaveLength(7);
        expect(retrieveEventsMock).toHaveBeenCalledTimes(1);
    });

    it('takes the queries in turn across collections, so no collection takes every seat', async () => {
        const queries = ['query one', 'query two', 'query three', 'query four', 'query five', 'query six'];
        planReturns({ queries });
        queryCollectionMock.mockImplementation(async (collection, query) => {
            const hit = event(`${collection} ${query}`);
            return { hashes: [1], metadata: [hit] };
        });
        const result = await retrieveEventsForTurn({ ...baseParams, liveCollectionIds: ['first', 'second'], settings: agentOn });
        expect(ids(result.events).slice(2)).toEqual(['first query one', 'second query one', 'first query two', 'second query two', 'first query three']);
    });

    it('tags each added event with its collection, for the injector', async () => {
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': [event('new1')] });
        const result = await callAgent();
        expect(result.events[2]._sortFrame).toBe(COLLECTION);
    });

    it('reports what the planner did', async () => {
        planReturns({ queries: ['only query'], rationale: 'why' });
        hitsReturn({ 'only query': [event('kept1'), event('new1')] });
        const { debug } = await callAgent();
        expect(debug).toMatchObject({ rawCount: 3, agenticMode: true, agenticQueries: ['only query'], agenticRationale: 'why', agenticHitCount: 2, agenticAddedSeats: 1 });
    });

    it('gives no seat to an event under the minimum importance', async () => {
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': [event('low', { importance: 2 }), event('fine', { importance: 4 })] });
        const result = await callAgent({ ...agentOn, eventbase_retrieval_min_importance: 3 });
        expect(ids(result.events)).toEqual(['kept1', 'kept2', 'fine']);
    });

    it('gives no seat to an event the recent chat already shows', async () => {
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': [event('visible', { source_window_end: 2995 }), event('older')] });
        const result = await callAgent({ ...agentOn, deduplication_depth: 20 });
        expect(ids(result.events)).toEqual(['kept1', 'kept2', 'older']);
    });

    it('gives no seat to a duplicate of a pre-search seat', async () => {
        const scene = { event_type: 'battle', characters: ['Nora', 'Rin'] };
        retrieveEventsMock.mockResolvedValue({ events: [event('kept', { ...scene, source_window_end: 100 })], poolEvents: [], debug: {} });
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': [event('twin', { ...scene, source_window_end: 103 }), event('later', { ...scene, source_window_end: 400 })] });
        const result = await callAgent();
        expect(ids(result.events)).toEqual(['kept', 'later']);
    });
});

describe('Agent Mode planner', () => {
    it('plans alongside the pre-search, before its results are in', async () => {
        let finishPreSearch;
        retrieveEventsMock.mockReturnValue(new Promise((resolve) => { finishPreSearch = resolve; }));
        planReturns({ queries: ['only query'] });
        hitsReturn({ 'only query': [event('new1')] });
        const pending = callAgent();
        await vi.waitFor(() => expect(postChatCompletionMock).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(queryCollectionMock).toHaveBeenCalledTimes(1));
        finishPreSearch(preSearch);
        expect(ids((await pending).events)).toEqual(['kept1', 'kept2', 'new1']);
    });

    it('shows the planner recent chat and the message, and no search result', async () => {
        planReturns({ queries: ['only query'] });
        hitsReturn({});
        await callAgent();
        const [[call]] = postChatCompletionMock.mock.calls;
        const [, { content: userMessage }] = call.messages;
        expect(call.model).toBe('agent-model');
        expect(userMessage).toContain('an earlier line');
        expect(userMessage).toContain('Where did Nora go?');
        expect(userMessage).not.toContain('text of kept1');
        expect(userMessage).not.toMatch(/candidate/i);
    });

    it('keeps the pre-search and warns when the planner call fails', async () => {
        postChatCompletionMock.mockRejectedValue(new Error('provider down'));
        expect(await callAgent()).toBe(preSearch);
        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Planner LLM call failed');
    });

    it('keeps the pre-search when the plan has no usable query', async () => {
        planReturns({ queries: [] });
        expect(await callAgent()).toBe(preSearch);
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });

    it('keeps the pre-search and warns when no model is set', async () => {
        expect(await callAgent({ ...agentOn, agent_model: '', chat_model: '' })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.calls.flat().join(' ')).toContain('reason=missing_model');
    });

    it('loses only a failed query\'s own hits, and warns', async () => {
        planReturns({ queries: ['failing query', 'working query'] });
        hitsReturn({ 'failing query': new Error('search down'), 'working query': [event('new1')] });
        const result = await callAgent();
        expect(ids(result.events)).toEqual(['kept1', 'kept2', 'new1']);
        expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Query failed');
    });

    it('does not plan when Agent Mode is off', async () => {
        expect(await callAgent({ ...agentOn, agentic_retrieval_enabled: false })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });

    it('does not plan on a backend that is not Qdrant', async () => {
        expect(await callAgent({ ...agentOn, vector_backend: 'standard' })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });
});
