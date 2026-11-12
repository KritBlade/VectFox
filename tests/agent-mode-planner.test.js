/**
 * Tests for Agent Mode's planner with StoryArc mode off (src/features/eventbase/agentic-retrieval.js).
 *
 * Guards that:
 *   - the pre-search keeps every seat it won, and the planner's searches add up to 5 from outside its results,
 *   - there is no second rerank,
 *   - the planner runs alongside the pre-search, and sees none of its hits,
 *   - a failed planner or query leaves the turn with what still works, and every degrade is announced,
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
const checkConnectionProfileMock = vi.fn();
const sendConnectionTestMock = vi.fn();
vi.mock('../src/features/llm-provider/index.js', async () => ({
    postChatCompletion: (...args) => postChatCompletionMock(...args),
    resolveModelParameterStyle: () => ({ sendTemperature: true, reasoningEffort: 'none' }),
    // The real rule, so the tests of the planner's connection read what ships.
    resolveInheritedConnection: (await import('../src/features/llm-provider/inherited-connection.js')).resolveInheritedConnection,
    resolveConnectionProfileId: (await import('../src/features/llm-provider/connection-profile-core.js')).resolveConnectionProfileId,
    checkConnectionProfile: (...args) => checkConnectionProfileMock(...args),
    sendConnectionTest: (...args) => sendConnectionTestMock(...args),
    LlmCallError: class LlmCallError extends Error {},
}));

const EARLIER_CHAT = [{ is_user: true, name: 'Rin', mes: 'an earlier line' }];
const chatState = vi.hoisted(() => ({ chat: null }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ chat: chatState.chat ?? EARLIER_CHAT }) }));
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
const notifySetupIncompleteMock = vi.fn();
const notifyInvalidModelMock = vi.fn();
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isInvalidModelConfigError: (err) => err?.code === 'invalid_model_config',
    notifyInvalidModel: (...args) => notifyInvalidModelMock(...args),
    notifySetupIncomplete: (...args) => notifySetupIncompleteMock(...args),
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

const { retrieveEventsForTurn, describeLlmSetupProblem, _resolveAgenticLLMConfig, testAgentModeConnection, testStoryArcConnection } = await import('../src/features/eventbase/agentic-retrieval.js');

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

    it('reads each recent turn through Text Cleaning, then its first 3,500 characters', async () => {
        const story = `Nora rides north at dawn.${'x'.repeat(4000)}`;
        chatState.chat = [{ is_user: false, name: 'Nora', mes: `<aside>${'status '.repeat(200)}</aside>${story}` }];
        planReturns({ queries: ['only query'] });
        hitsReturn({});
        await callAgent();
        chatState.chat = null;
        const [[call]] = postChatCompletionMock.mock.calls;
        const [, { content: userMessage }] = call.messages;
        expect(userMessage).toContain(`Nora: ${story.slice(0, 3500)}\n`);
        expect(userMessage).not.toContain(story.slice(0, 3501));
        expect(userMessage).not.toContain('status');
    });

    it('loses only a failed query\'s own hits, and warns', async () => {
        planReturns({ queries: ['failing query', 'working query'] });
        hitsReturn({ 'failing query': new Error('search down'), 'working query': [event('new1')] });
        const result = await callAgent();
        expect(ids(result.events)).toEqual(['kept1', 'kept2', 'new1']);
        expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Query failed');
        expect(result.debug.failedSearchCount).toBeUndefined();
    });

    it('does not plan when Agent Mode is off', async () => {
        expect(await callAgent({ ...agentOn, agentic_retrieval_enabled: false })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(notifySetupIncompleteMock).not.toHaveBeenCalled();
    });
});

// Every row of the connection plan's §5: the pre-search still runs, and the degrade is announced.
describe('Agent Mode failures', () => {
    const failureOf = result => ({ count: result.debug.failedSearchCount, message: result.debug.searchFailureMessage });

    it('warns once that it needs Qdrant, and keeps the pre-search', async () => {
        expect(await callAgent({ ...agentOn, vector_backend: 'standard' })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(notifySetupIncompleteMock).toHaveBeenCalledWith('Agent Mode', expect.stringContaining('needs the Qdrant backend'));
    });

    it('warns which setting is missing when the connection cannot run, and keeps the pre-search', async () => {
        expect(await callAgent({ ...agentOn, agent_model: '', chat_model: '' })).toBe(preSearch);
        expect(postChatCompletionMock).not.toHaveBeenCalled();
        expect(notifySetupIncompleteMock).toHaveBeenCalledWith('Agent Mode', describeLlmSetupProblem('Agent Mode', 'missing_model'));
    });

    it('says in plain words what each connection problem is and where to fix it', () => {
        expect(describeLlmSetupProblem('Agent Mode', 'missing_model')).toContain('has no model. Set Model on the AgentMode page');
        expect(describeLlmSetupProblem('Agent Mode', 'missing_openrouter_api_key')).toContain('no OpenRouter key is saved');
        expect(describeLlmSetupProblem('Agent Mode', 'missing_vllm_url')).toContain('vLLM with no URL');
        expect(describeLlmSetupProblem('Agent Mode', 'missing_vllm_api_key')).toContain('no vLLM key is saved');
        expect(describeLlmSetupProblem('Agent Mode', 'unknown_provider_mystery')).toContain('provider "mystery" is not one VectFox knows');
        for (const reason of ['missing_model', 'unknown_provider_mystery', 'a_reason_added_later']) {
            expect(describeLlmSetupProblem('Agent Mode', reason)).toMatch(/^Agent Mode is on, but .+ Until then each turn uses the normal memory search only\.$/);
        }
    });

    it('counts a failed planner call as the turn\'s failed memory search, and keeps the pre-search', async () => {
        postChatCompletionMock.mockRejectedValue(new Error('provider down'));
        const result = await callAgent();
        expect(result.events).toBe(kept);
        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(failureOf(result)).toEqual({ count: 1, message: 'Agent Mode\'s planner failed: provider down' });
        expect(logWarnMock.mock.calls.flat().join(' ')).toContain('Planner LLM call failed');
    });

    it('names the provider\'s cut when a cut reply is not valid JSON', async () => {
        postChatCompletionMock.mockResolvedValue({ content: '{"queries": ["first qu', usage: {}, finishReason: 'content_filter', cutReason: 'content_filter' });
        expect(failureOf(await callAgent()).message).toMatch(/^Agent Mode's planner failed: Agent Mode reply was cut short by the provider, with finish reason content_filter, so it is not valid JSON: /);

        postChatCompletionMock.mockResolvedValue({ content: '{"queries": ["first qu', usage: {}, finishReason: 'length', cutReason: 'length' });
        expect(failureOf(await callAgent()).message).toMatch(/^Agent Mode's planner failed: Agent Mode reply was cut at the \d+-token limit, so it is not valid JSON: /);
    });

    it('uses a cut reply whose JSON closed before the cut', async () => {
        hitsReturn({ 'only query': [event('new1')] });
        postChatCompletionMock.mockResolvedValue({ content: '{"queries": ["only query"]}', usage: {}, finishReason: 'content_filter', cutReason: 'content_filter' });
        expect(ids((await callAgent()).events)).toEqual(['kept1', 'kept2', 'new1']);
    });

    it('names the timeout setting when the planner times out', async () => {
        postChatCompletionMock.mockRejectedValue(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
        const { debug } = await callAgent();
        expect(debug.searchFailureMessage).toMatch(/^Agent Mode's planner timed out after \d+ ms\. Raise Planner timeout on the AgentMode page/);
    });

    it('raises only the invalid-model toast for a model that is no longer valid', async () => {
        postChatCompletionMock.mockRejectedValue(Object.assign(new Error('model gone'), { code: 'invalid_model_config' }));
        const result = await callAgent();
        expect(notifyInvalidModelMock).toHaveBeenCalledWith('model gone');
        expect(result).toBe(preSearch);
    });

    it('keeps the pre-search\'s own failure first, and adds the planner\'s to the count', async () => {
        retrieveEventsMock.mockResolvedValue({ ...preSearch, debug: { failedSearchCount: 1, searchFailureMessage: 'embedding down' } });
        postChatCompletionMock.mockRejectedValue(new Error('provider down'));
        expect(failureOf(await callAgent())).toEqual({ count: 2, message: 'embedding down' });
    });

    it('stays quiet on an empty plan, which means nothing to search', async () => {
        planReturns({ queries: [] });
        expect(await callAgent()).toBe(preSearch);
        expect(queryCollectionMock).not.toHaveBeenCalled();
    });

    it('counts a plan with no queries list as a failure', async () => {
        planReturns({ rationale: 'no list' });
        const result = await callAgent();
        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(failureOf(result)).toEqual({ count: 1, message: 'Agent Mode\'s planner answered without a list of searches.' });
    });

    it('counts one failure when every planned search failed', async () => {
        planReturns({ queries: ['first query', 'second query'] });
        hitsReturn({ 'first query': new Error('search down'), 'second query': new Error('search down') });
        const result = await callAgent();
        expect(result.events).toBe(kept);
        expect(failureOf(result)).toEqual({ count: 1, message: 'Every Agent Mode search failed: search down' });
    });
});

describe('the planner\'s connection', () => {
    const eventBaseModel = { chat_provider: 'vllm', chat_model: 'eventbase-model', chat_vllm_url: 'http://eventbase-host:8000/v1' };

    it('runs Same as EventBase model on the EventBase model\'s Base URL, not the hidden one this page saved', () => {
        const connection = _resolveAgenticLLMConfig({ ...eventBaseModel, agent_provider: '', agent_model: '', agent_vllm_url: 'http://old-host:8000/v1' });
        expect([connection.ok, connection.provider, connection.model, connection.vllmUrl]).toEqual([true, 'vllm', 'eventbase-model', 'http://eventbase-host:8000/v1']);
    });

    it('takes the EventBase model\'s model when Model is blank, and a typed one otherwise', () => {
        expect(_resolveAgenticLLMConfig({ ...eventBaseModel, agent_provider: 'openrouter', agent_model: '' }).model).toBe('eventbase-model');
        expect(_resolveAgenticLLMConfig({ ...eventBaseModel, agent_provider: '', agent_model: 'planner-model' }).model).toBe('planner-model');
    });

    const eventBaseOnProfile = { chat_provider: 'connection_profile', chat_connection_profile_id: 'profile-eventbase', chat_model: 'hidden-model' };

    it('runs Same as EventBase model on the EventBase model\'s profile, checked as chosen on the Core page', () => {
        checkConnectionProfileMock.mockReturnValue({ ok: true, profile: { model: 'profile-model' }, api: 'chat', storesKey: true });
        const connection = _resolveAgenticLLMConfig({ ...eventBaseOnProfile, agent_provider: '', agent_model: 'typed-model' });
        expect(connection).toMatchObject({ ok: true, provider: 'connection_profile', connectionProfileId: 'profile-eventbase', connectionProfilePage: 'Core' });
        expect(checkConnectionProfileMock).toHaveBeenCalledWith('profile-eventbase', { feature: 'Agent Mode', page: 'Core' });
    });

    it('warns with the profile\'s own problem, naming the AgentMode page, when its own profile cannot run', () => {
        const problem = 'Agent Mode: no connection profile is chosen. Choose one on the AgentMode page.';
        checkConnectionProfileMock.mockReturnValue({ ok: false, reason: problem });
        const connection = _resolveAgenticLLMConfig({ chat_provider: 'openrouter', agent_provider: 'connection_profile', agent_connection_profile_id: '' });
        expect(connection).toEqual({ ok: false, reason: 'connection_profile', problem });
        expect(checkConnectionProfileMock).toHaveBeenCalledWith('', { feature: 'Agent Mode', page: 'AgentMode' });
        expect(describeLlmSetupProblem('Agent Mode', connection.reason, connection.problem))
            .toBe(`${problem} Until then each turn uses the normal memory search only.`);
    });

    it('fails a blank Model on a manual provider while the EventBase model runs on a profile, never reading its hidden model', () => {
        expect(_resolveAgenticLLMConfig({ ...eventBaseOnProfile, agent_provider: 'openrouter', agent_model: '' })).toEqual({ ok: false, reason: 'missing_model' });
    });

    it('sends the planner\'s call on its profile', async () => {
        checkConnectionProfileMock.mockReturnValue({ ok: true, profile: { model: 'profile-model' }, api: 'chat', storesKey: true });
        planReturns({ queries: [] });
        await callAgent({ ...agentOn, ...eventBaseOnProfile, agent_provider: '' });
        expect(postChatCompletionMock.mock.calls[0][0]).toMatchObject({
            provider: 'connection_profile', connectionProfileId: 'profile-eventbase', connectionProfilePage: 'Core', contextLabel: 'Agent Mode',
        });
    });
});

describe('Test connection of Agent Mode and StoryArc', () => {
    beforeEach(() => {
        sendConnectionTestMock.mockReset();
        sendConnectionTestMock.mockResolvedValue({ content: 'OK', cutReason: null });
    });

    it('sends the test on the planner\'s connection, Same as EventBase model resolved, with the planner\'s request switches', async () => {
        const settings = { agent_provider: '', chat_provider: 'vllm', chat_model: 'harbor-chat', chat_vllm_url: 'http://harbor.local/v1' };
        await expect(testAgentModeConnection(settings)).resolves.toEqual({ content: 'OK', cutReason: null });
        expect(sendConnectionTestMock).toHaveBeenCalledWith(
            expect.objectContaining({ ok: true, provider: 'vllm', model: 'harbor-chat', vllmUrl: 'http://harbor.local/v1' }),
            { contextLabel: 'Agent Mode', parameterStyle: { sendTemperature: true, reasoningEffort: 'none' } },
        );
        expect(postChatCompletionMock).not.toHaveBeenCalled();
    });

    it('says what stops the planner, as its setup warning says it, and sends nothing', async () => {
        await expect(testAgentModeConnection({ agent_provider: 'openrouter', agent_model: '', chat_model: '' }))
            .rejects.toThrow(describeLlmSetupProblem('Agent Mode', 'missing_model'));
        const problem = 'Agent Mode: its connection profile was deleted in SillyTavern. Choose another on the AgentMode page.';
        checkConnectionProfileMock.mockReturnValue({ ok: false, reason: problem });
        await expect(testAgentModeConnection({ agent_provider: 'connection_profile', agent_connection_profile_id: 'p-gone' }))
            .rejects.toThrow(problem);
        expect(sendConnectionTestMock).not.toHaveBeenCalled();
    });

    it('sends StoryArc\'s test on the link model\'s connection with no temperature and the model\'s own reasoning, or says what stops it', async () => {
        checkConnectionProfileMock.mockReturnValue({ ok: true, profile: { model: 'profile-model' }, api: 'chat', storesKey: true });
        await testStoryArcConnection({ story_arc_link_provider: 'connection_profile', story_arc_link_connection_profile_id: 'p-harbor' });
        expect(sendConnectionTestMock).toHaveBeenCalledWith(
            expect.objectContaining({ ok: true, provider: 'connection_profile', connectionProfileId: 'p-harbor', connectionProfilePage: 'StoryArc' }),
            { contextLabel: 'StoryArc', parameterStyle: { sendTemperature: false, reasoningEffort: null } },
        );

        const problem = 'StoryArc: no connection profile is chosen. Choose one on the StoryArc page.';
        checkConnectionProfileMock.mockReturnValue({ ok: false, reason: problem });
        await expect(testStoryArcConnection({ story_arc_link_provider: 'connection_profile' })).rejects.toThrow(problem);
        expect(sendConnectionTestMock).toHaveBeenCalledTimes(1);
    });
});
