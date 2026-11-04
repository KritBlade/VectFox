/**
 * Tests for writing StoryArc links (src/features/eventbase/story-arc-links.js).
 *
 * Guards that:
 *   - a pass stores each decision, reports failures, and keeps going past one,
 *   - it stops on an invalid model and on a run of failures, and when asked,
 *   - it can skip events already decided, and shows its cost first,
 *   - a new event is linked only when that spends nothing unasked for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchPortableChunksMock = vi.fn();
vi.mock('../src/features/collections/index.js', () => ({
    fetchPortableChunks: (...args) => fetchPortableChunksMock(...args),
}));

const queryCollectionMock = vi.fn();
const updateChunkMetadataMock = vi.fn();
vi.mock('../src/features/vector-backend/index.js', () => ({
    queryCollection: (...args) => queryCollectionMock(...args),
    updateChunkMetadata: (...args) => updateChunkMetadataMock(...args),
}));

vi.mock('../src/features/llm-provider/index.js', () => ({
    resolveModelParameterStyle: () => ({ sendTemperature: true, tokenLimitParameter: 'max_tokens', reasoningEffort: 'none' }),
}));

const callLlmForJsonMock = vi.fn();
const resolveLlmConnectionMock = vi.fn();
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({
    callLlmForJson: (...args) => callLlmForJsonMock(...args),
    resolveLlmConnection: (...args) => resolveLlmConnectionMock(...args),
}));

const resolveActiveCollectionMock = vi.fn();
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    resolveActiveEventBaseCollection: (...args) => resolveActiveCollectionMock(...args),
}));

const listStoryEventsMock = vi.fn();
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({
    listStoryEvents: (...args) => listStoryEventsMock(...args),
}));

vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({
    generationRateLimiter: { execute: (run) => run() },
    generationRateLimitSettings: () => ({}),
}));

const notifyInvalidModelMock = vi.fn();
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isInvalidModelConfigError: (err) => err?.code === 'invalid_model_config',
    notifyInvalidModel: (...args) => notifyInvalidModelMock(...args),
}));

const progressMock = vi.hoisted(() => ({
    show: vi.fn(),
    setCancelHandler: vi.fn(),
    clearCancelHandler: vi.fn(),
    updateProgress: vi.fn(),
    updateCurrentItem: vi.fn(),
    addError: vi.fn(),
    complete: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: progressMock }));

const logWarnMock = vi.fn();
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: (...args) => logWarnMock(...args), lifecycle: vi.fn(), domain: vi.fn(), error: vi.fn() },
}));

const { describeStoryLinkPass, linkNewStoryEvents, readStoryLinkCoverage, runStoryLinkPass } = await import('../src/features/eventbase/story-arc-links.js');

const COLLECTION = 'vf_eventbase_chat';
const settings = {
    vector_backend: 'qdrant',
    story_arc_mode_enabled: true,
    agentic_retrieval_enabled: true,
    story_arc_link_provider: 'openrouter',
    story_arc_link_model: 'openai/gpt-6-luna',
};
const stored = (hash, start, extra = {}) => ({ _hash: hash, event_id: `id${hash}`, source_window_start: start, text: `[other] event ${hash}`, ...extra });
const chunk = (hash, start, extra = {}) => ({
    hash,
    text: `[other] event ${hash}`,
    vector: [1, 0],
    metadata: { eventbase: true, source_window_start: start, event_id: `id${hash}`, ...extra },
});
const writtenLinks = () => Object.fromEntries(updateChunkMetadataMock.mock.calls.map(([, hash, metadata]) => [hash, metadata.story_links]));

beforeEach(() => {
    vi.clearAllMocks();
    fetchPortableChunksMock.mockReset();
    queryCollectionMock.mockReset();
    updateChunkMetadataMock.mockReset().mockResolvedValue({});
    callLlmForJsonMock.mockReset().mockResolvedValue({ links: [] });
    listStoryEventsMock.mockReset();
    resolveLlmConnectionMock.mockReset().mockReturnValue({ ok: true, provider: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'key' });
    resolveActiveCollectionMock.mockReset().mockReturnValue({ collectionId: COLLECTION, registryKey: `qdrant:${COLLECTION}` });
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'openai/gpt-6-luna', pricing: { prompt: '0.0000001', completion: '0.0000005' } }] }),
    })));
    vi.stubGlobal('toastr', { info: vi.fn() });
});

describe('runStoryLinkPass', () => {
    it('stores what the LLM decides for each event, and asks about earlier events only', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(2, 20), chunk(1, 10), { hash: 9, text: 'not an event', vector: [1, 0], metadata: {} }]);
        callLlmForJsonMock.mockResolvedValue({ links: [{ id: 'E1', type: 'continues', thread: 'The blockade' }] });
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });

        // The first event has nothing earlier, so it needs no call.
        expect(callLlmForJsonMock).toHaveBeenCalledTimes(1);
        const [call] = callLlmForJsonMock.mock.calls[0];
        expect(call.userMessage).toContain('E1: (message 10)');
        expect(call.userMessage).toContain('NEW:\n(message 20)');
        expect(writtenLinks()).toEqual({ 1: [], 2: [{ hash: 1, type: 'continues', thread: 'The blockade' }] });
        expect(updateChunkMetadataMock.mock.calls[0][0]).toBe(COLLECTION);
        expect(result).toEqual({ decidedCount: 2, failedCount: 0, isStopped: false });
        expect(progressMock.complete.mock.calls[0][0]).toBe(true);
    });

    // A link needs thought, so the settings that switch thinking off for other features must not apply.
    it('lets the link model think, with room for its reasoning', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), chunk(2, 20)]);
        await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        const [call] = callLlmForJsonMock.mock.calls[0];
        expect(call.llmCfg.parameterStyle).toEqual({ sendTemperature: false, tokenLimitParameter: 'max_tokens', reasoningEffort: null });
        expect(call.maxTokens).toBeGreaterThan(8000);
    });

    it('offers the nearest earlier events by stored vector, and the 3 just before', async () => {
        const far = (hash, start) => ({ ...chunk(hash, start), vector: [0, 1] });
        fetchPortableChunksMock.mockResolvedValue([
            chunk(1, 10),
            ...Array.from({ length: 14 }, (_, i) => far(100 + i, 100 + i)),
            chunk(2, 500),
        ]);
        await runStoryLinkPass({ collectionId: COLLECTION, settings: { ...settings, generation_rate_limit_calls: 0 }, shouldRelinkDecided: false });
        const message = callLlmForJsonMock.mock.calls.map(([call]) => call.userMessage).find(text => text.includes('NEW:\n(message 500)'));
        // The close event at message 10 is offered even though many events came after it.
        expect(message).toContain('(message 10)');
        expect(message).toContain('(message 113)');
        expect(message.match(/^E\d+:/gm).length).toBeLessThanOrEqual(13);
    });

    it('skips decided events unless asked to redo them, and still shows them as candidates', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10, { story_links: [] }), chunk(2, 20)]);
        await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: false });
        expect(Object.keys(writtenLinks())).toEqual(['2']);
        expect(callLlmForJsonMock.mock.calls[0][0].userMessage).toContain('E1: (message 10)');
    });

    it('tries a failed event once more, then counts it, reports it and carries on', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), chunk(2, 20), chunk(3, 30)]);
        callLlmForJsonMock.mockImplementation(async ({ userMessage }) => {
            if (userMessage.includes('NEW:\n(message 20)')) throw new Error('PROHIBITED_CONTENT');
            return { links: [] };
        });
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(callLlmForJsonMock).toHaveBeenCalledTimes(3);
        expect(writtenLinks()).toEqual({ 1: [], 3: [] });
        expect(result).toEqual({ decidedCount: 2, failedCount: 1, isStopped: false });
        expect(progressMock.addError.mock.calls[0][0]).toContain('PROHIBITED_CONTENT');
        expect(progressMock.complete.mock.calls[0][0]).toBe(false);
        expect(logWarnMock).toHaveBeenCalled();
    });

    it('counts a malformed reply as failed, never as "no links"', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), chunk(2, 20)]);
        callLlmForJsonMock.mockResolvedValue({ answer: 'none' });
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result.failedCount).toBe(1);
        expect(writtenLinks()).toEqual({ 1: [] });
    });

    // Each decision is a paid call, and a failed write says nothing against the decision.
    it('tries a failed write again without paying for another decision, then counts it as failed', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), chunk(2, 20), chunk(3, 30)]);
        updateChunkMetadataMock.mockRejectedValue(new Error('write failed'));
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result.failedCount).toBe(3);
        // The first event has nothing earlier, so two events make one call each.
        expect(callLlmForJsonMock).toHaveBeenCalledTimes(2);
        expect(updateChunkMetadataMock).toHaveBeenCalledTimes(6);
    });

    it('recovers when a second write succeeds', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), chunk(2, 20)]);
        updateChunkMetadataMock.mockRejectedValueOnce(new Error('write failed'));
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result).toEqual({ decidedCount: 2, failedCount: 0, isStopped: false });
    });

    // Choosing from recent events alone and counting as decided would hide a weak link pass.
    it('counts an event whose vector cannot be read as failed, with no call', async () => {
        fetchPortableChunksMock.mockResolvedValue([chunk(1, 10), { ...chunk(2, 20), vector: null }]);
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result.failedCount).toBe(1);
        expect(callLlmForJsonMock).not.toHaveBeenCalled();
        expect(progressMock.addError.mock.calls[0][0]).toContain('vector');
        expect(writtenLinks()).toEqual({ 1: [] });
    });

    it('stops at once on an invalid model, and tells the player', async () => {
        fetchPortableChunksMock.mockResolvedValue(Array.from({ length: 40 }, (_, i) => chunk(i + 1, i * 10)));
        const invalidModel = Object.assign(new Error('no such model'), { code: 'invalid_model_config' });
        callLlmForJsonMock.mockRejectedValue(invalidModel);
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(notifyInvalidModelMock).toHaveBeenCalledWith('no such model');
        expect(result.isStopped).toBe(true);
        expect(callLlmForJsonMock.mock.calls.length).toBeLessThanOrEqual(8);
        expect(progressMock.complete.mock.calls[0][1]).toContain('no such model');
    });

    it('stops after a run of failures rather than failing every event', async () => {
        fetchPortableChunksMock.mockResolvedValue(Array.from({ length: 200 }, (_, i) => chunk(i + 1, i * 10)));
        callLlmForJsonMock.mockRejectedValue(new Error('connection refused'));
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result.isStopped).toBe(true);
        expect(result.failedCount).toBeLessThan(40);
        expect(progressMock.complete.mock.calls[0][1]).toContain('connection refused');
    });

    it('stops when asked, and keeps what it finished', async () => {
        fetchPortableChunksMock.mockResolvedValue(Array.from({ length: 100 }, (_, i) => chunk(i + 1, i * 10)));
        callLlmForJsonMock.mockImplementation(async () => {
            progressMock.setCancelHandler.mock.lastCall[0]();
            return { links: [] };
        });
        const result = await runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true });
        expect(result.isStopped).toBe(true);
        expect(updateChunkMetadataMock.mock.calls.length).toBeLessThan(100);
        expect(progressMock.complete.mock.calls[0][1]).toContain('Stopped by you');
    });

    it('reports a failure to read the events, and clears the Stop button', async () => {
        fetchPortableChunksMock.mockRejectedValue(new Error('read failed'));
        await expect(runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true })).rejects.toThrow('read failed');
        expect(progressMock.complete.mock.calls[0][0]).toBe(false);
        expect(progressMock.clearCancelHandler).toHaveBeenCalled();
    });

    it('refuses to start without a usable model', async () => {
        resolveLlmConnectionMock.mockReturnValueOnce({ ok: false, reason: 'missing_model' });
        await expect(runStoryLinkPass({ collectionId: COLLECTION, settings, shouldRelinkDecided: true })).rejects.toThrow('missing_model');
        expect(progressMock.show).not.toHaveBeenCalled();
    });
});

describe('describeStoryLinkPass', () => {
    it('gives the cost of all events and of the undecided ones', async () => {
        listStoryEventsMock.mockResolvedValue([stored(1, 10, { story_links: [] }), stored(2, 20), stored(3, 30)]);
        const pass = await describeStoryLinkPass(settings);
        expect(pass.coverage).toMatchObject({ totalCount: 3, decidedCount: 1 });
        expect(pass.allEstimate.eventCount).toBe(3);
        expect(pass.undecidedEstimate.eventCount).toBe(2);
        expect(pass.allEstimate.costUsd).toBeGreaterThan(pass.undecidedEstimate.costUsd);
        expect(pass.model).toBe('openai/gpt-6-luna');
        expect(pass.collectionId).toBe(COLLECTION);
    });

    it('shows tokens without a price when the price cannot be read, and warns', async () => {
        listStoryEventsMock.mockResolvedValue([stored(1, 10)]);
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const pass = await describeStoryLinkPass(settings);
        expect(pass.allEstimate.costUsd).toBeNull();
        expect(logWarnMock).toHaveBeenCalled();
    });

    it('does not read a price for another provider', async () => {
        listStoryEventsMock.mockResolvedValue([stored(1, 10)]);
        const pass = await describeStoryLinkPass({ ...settings, story_arc_link_provider: 'vllm' });
        expect(pass.allEstimate.costUsd).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('names what is missing', async () => {
        expect((await describeStoryLinkPass({ ...settings, vector_backend: 'standard' })).problem).toContain('Qdrant');
        resolveActiveCollectionMock.mockReturnValueOnce(null);
        expect((await describeStoryLinkPass(settings)).problem).toContain('no EventBase collection');
        listStoryEventsMock.mockResolvedValueOnce([stored(1, 10)]);
        resolveLlmConnectionMock.mockReturnValueOnce({ ok: false, reason: 'missing_openrouter_api_key' });
        expect((await describeStoryLinkPass(settings)).problem).toContain('missing_openrouter_api_key');
        listStoryEventsMock.mockResolvedValueOnce(null);
        expect((await describeStoryLinkPass(settings)).problem).toContain('Could not read');
        listStoryEventsMock.mockResolvedValueOnce([]);
        expect((await describeStoryLinkPass(settings)).problem).toContain('no stored events');
    });
});

describe('readStoryLinkCoverage', () => {
    it('reports coverage', async () => {
        listStoryEventsMock.mockResolvedValueOnce([stored(1, 10, { story_links: [] })]);
        expect(await readStoryLinkCoverage(settings)).toMatchObject({ totalCount: 1, decidedCount: 1 });
    });

    // A chat with 1,400 linked events must not read as empty because one listing failed.
    it('tells a failed listing from a chat with nothing stored', async () => {
        expect((await readStoryLinkCoverage({ ...settings, vector_backend: 'standard' })).problem).toContain('Qdrant');
        resolveActiveCollectionMock.mockReturnValueOnce(null);
        expect((await readStoryLinkCoverage(settings)).problem).toContain('no EventBase collection');
        listStoryEventsMock.mockResolvedValueOnce(null);
        expect((await readStoryLinkCoverage(settings)).problem).toContain('Could not read');
        listStoryEventsMock.mockResolvedValueOnce([]);
        expect((await readStoryLinkCoverage(settings)).problem).toContain('no stored events');
    });
});

describe('linkNewStoryEvents', () => {
    const decidedOlder = [stored(1, 10, { story_links: [] }), stored(2, 20, { story_links: [] })];
    const run = (newEventIds, extra = {}) => linkNewStoryEvents({ collectionId: COLLECTION, newEventIds, settings: { ...settings, ...extra } });

    it('links a new event from its closest earlier hits, leaving out itself and later events', async () => {
        const newEvent = stored(3, 30);
        const later = stored(4, 40, { story_links: [] });
        listStoryEventsMock.mockResolvedValue([...decidedOlder, newEvent, later]);
        queryCollectionMock.mockResolvedValue({ hashes: [3, 4, 1] });
        callLlmForJsonMock.mockResolvedValue({ links: [{ id: 'E1', type: 'continues', thread: 'A' }] });
        await run(['id3']);
        expect(queryCollectionMock.mock.calls[0].slice(0, 2)).toEqual([COLLECTION, newEvent.text]);
        const { userMessage } = callLlmForJsonMock.mock.calls[0][0];
        expect(userMessage).toContain('(message 10)');
        expect(userMessage).toContain('(message 20)');
        expect(userMessage).not.toContain('(message 40)');
        expect(writtenLinks()).toEqual({ 3: [{ hash: 1, type: 'continues', thread: 'A' }] });
    });

    it('decides the first event of a chat with no call and no search', async () => {
        listStoryEventsMock.mockResolvedValue([stored(1, 10)]);
        await run(['id1']);
        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(callLlmForJsonMock).not.toHaveBeenCalled();
        expect(writtenLinks()).toEqual({ 1: [] });
    });

    // A chat that never had a link pass would otherwise pay on every reply for links nothing can walk yet.
    it('waits for the button when older events were never linked', async () => {
        listStoryEventsMock.mockResolvedValue([stored(1, 10), stored(2, 20), stored(3, 30)]);
        await run(['id3']);
        expect(callLlmForJsonMock).not.toHaveBeenCalled();
        expect(updateChunkMetadataMock).not.toHaveBeenCalled();
    });

    // A large import must show its cost first.
    it('leaves a large batch for the button, and says so', async () => {
        await run(Array.from({ length: 51 }, (_, i) => `id${i}`));
        expect(listStoryEventsMock).not.toHaveBeenCalled();
        expect(globalThis.toastr.info.mock.calls[0][0]).toContain('51 new events');
    });

    it('does nothing when StoryArc mode is not active', async () => {
        await run(['id1'], { story_arc_mode_enabled: false });
        await run(['id1'], { agentic_retrieval_enabled: false });
        await run(['id1'], { vector_backend: 'standard' });
        await run([]);
        expect(listStoryEventsMock).not.toHaveBeenCalled();
    });

    it('never throws, leaves a failed event undecided and warns', async () => {
        listStoryEventsMock.mockResolvedValue([...decidedOlder, stored(3, 30)]);
        queryCollectionMock.mockResolvedValue({ hashes: [1] });
        callLlmForJsonMock.mockRejectedValue(new Error('model down'));
        await expect(run(['id3'])).resolves.toBeUndefined();
        expect(updateChunkMetadataMock).not.toHaveBeenCalled();
        expect(logWarnMock).toHaveBeenCalled();
    });

    // Nobody can stop this step by hand, so a dead endpoint must not fail every event.
    it('stops after a run of failures, says so, and leaves the rest undecided', async () => {
        const newEvents = Array.from({ length: 50 }, (_, i) => stored(100 + i, 100 + i));
        listStoryEventsMock.mockResolvedValue([...decidedOlder, ...newEvents]);
        queryCollectionMock.mockResolvedValue({ hashes: [1] });
        callLlmForJsonMock.mockRejectedValue(new Error('endpoint down'));
        await run(newEvents.map(item => item.event_id));
        expect(callLlmForJsonMock.mock.calls.length).toBeLessThan(40);
        expect(updateChunkMetadataMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.lastCall[0]).toContain('linking stopped');
    });

    it('counts a failed search as a failed event', async () => {
        listStoryEventsMock.mockResolvedValue([...decidedOlder, stored(3, 30)]);
        queryCollectionMock.mockRejectedValue(new Error('search failed'));
        await run(['id3']);
        expect(callLlmForJsonMock).not.toHaveBeenCalled();
        expect(logWarnMock.mock.lastCall[0]).toContain('1 of 1 new events');
    });

    it('tells the player about an invalid model', async () => {
        listStoryEventsMock.mockResolvedValue([...decidedOlder, stored(3, 30)]);
        queryCollectionMock.mockResolvedValue({ hashes: [1] });
        callLlmForJsonMock.mockRejectedValue(Object.assign(new Error('no such model'), { code: 'invalid_model_config' }));
        await run(['id3']);
        expect(notifyInvalidModelMock).toHaveBeenCalledWith('no such model');
    });

    it('warns when the link model is not set, and when listing throws', async () => {
        resolveLlmConnectionMock.mockReturnValueOnce({ ok: false, reason: 'missing_model' });
        await run(['id1']);
        expect(logWarnMock.mock.calls[0][0]).toContain('missing_model');
        listStoryEventsMock.mockRejectedValueOnce(new Error('boom'));
        await expect(run(['id1'])).resolves.toBeUndefined();
        expect(logWarnMock.mock.calls[1][1].message).toBe('boom');
    });
});
