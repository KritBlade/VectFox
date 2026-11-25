/**
 * An EventBase retrieval that settles past its bound publishes nothing (GitHub issue #28, part 3): the reply went
 * without it, so it sets no EventBase block, which would wait for whatever SillyTavern sends next, and shows no toast
 * of what it found after the timeout's own toast. A setup that cannot run is still said. One inside its bound injects
 * and says so; a preview injects nothing and says nothing was injected; and after a failed search the result toast
 * does not say "no events matched".
 *
 * Drives the real runBoundedRetrieval and runEventBaseRetrieval on a fake clock, with the archive search and
 * retrieveEventsForTurn held until the test lets them settle, and the real notifier against a stubbed toastr.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    prompts: {},
    turn: null,
    archive: null,
    // The open chat, which story order reads (src/shared/chat-messages.js).
    chat: [],
}));

/** A promise and the function that settles it, so the test decides when a search answers. */
function held() {
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    return { promise, settle };
}

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn((key, value) => { state.prompts[key] = value; }),
    extension_prompts: {}, getCurrentChatId: () => 'late-memory-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: state.chat, chatMetadata: {} }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'late-memory-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_late', getRegistryBackend: () => 'qdrant',
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => ['vf_eventbase_late'], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
// The chat's collection in use, from the one route (collectionInUse), with an archive locked in beside it.
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => {
    const collection = { registryKey: 'qdrant:vf_eventbase_late', collectionId: 'vf_eventbase_late', isPaused: false };
    const archive = { registryKey: 'qdrant:vf_archiveevent_harbor', collectionId: 'vf_archiveevent_harbor', isPaused: false };
    return {
        collectionInUse: () => ({ collection, reason: null, collections: [collection], lockedElsewhere: [] }),
        noCollectionInUseText: () => null,
        resolveEventBaseRunTarget: () => collection,
        sharedCollectionsLockedHere: () => ({ otherChats: [], archives: [archive] }),
        useChatCollection: vi.fn(),
    };
});
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(), getChatLockedCollections: () => [],
}));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), getSavedHashes: vi.fn(),
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({ getBackend: vi.fn() }));
vi.mock('../src/shared/constants.js', async () => ({ ...(await vi.importActual('../src/shared/constants.js')), EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error {}, EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn(), searchArchiveEvents: vi.fn(() => state.archive) }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn(() => state.turn) }));
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({
    formatEventsForInjectionDetailed: vi.fn(() => ({ text: '- the duel at the mill', includedCount: 1 })),
    formatStoryArcForInjection: vi.fn(() => ({ text: '- #120: the duel at the mill', includedCount: 1 })),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false, domainEnabled: () => false, domain: vi.fn() } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { runEventBaseRetrieval } = await import('../src/features/eventbase/eventbase-workflow.js');
const { runBoundedRetrieval } = await import('../src/features/vector-backend/index.js');
const { retrieveEventsForTurn } = await import('../src/features/eventbase/agentic-retrieval.js');

const BOUND_MS = 15000;
const EVENTBASE_BLOCK = '3_vectfox_eventbase';
const SETTINGS = { retrieval_popup_on_start: false, retrieval_popup_on_result: true, position: 1, depth: 2 };
const FOUND = { events: [{ summary: 'the duel at the mill' }], debug: { failedSearchCount: 0, rawCount: 1 } };
const CHAT = [{ is_user: true, mes: 'who won the duel' }];

/**
 * A reply's EventBase retrieval as the reply step runs it: bounded, the retrieval started with its run.
 * @returns {{reply: Promise<void>, retrieval: () => Promise<void>}} The reply step's wait, and the retrieval itself,
 *   which keeps running past the bound
 */
function startReplyRetrieval() {
    let retrieval;
    const reply = runBoundedRetrieval(
        boundedRun => (retrieval = runEventBaseRetrieval({ chat: CHAT, searchText: 'who won the duel', settings: SETTINGS, boundedRun })),
        { contextLabel: 'EventBase', sourceName: 'event memory', timeoutMessage: 'EventBase retrieval timed out', settings: SETTINGS, timeoutMs: BOUND_MS },
    );
    return { reply, retrieval: () => retrieval };
}

/** Each toast's text, by kind. */
function toastsShown() {
    return Object.fromEntries(['error', 'warning', 'info', 'success'].map(kind => [kind, globalThis.toastr[kind].mock.calls.map(call => call[0])]));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.prompts = {};
    state.archive = Promise.resolve([]);
    state.turn = Promise.resolve(FOUND);
    globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an EventBase retrieval that settles past its bound', () => {
    it('sets no block and shows no toast of what it found, after the timeout\'s own toast', async () => {
        const search = held();
        state.turn = search.promise;
        const { reply, retrieval } = startReplyRetrieval();

        await vi.advanceTimersByTimeAsync(BOUND_MS);
        await reply;
        expect(toastsShown().error).toHaveLength(1);
        expect(toastsShown().error[0]).toContain('EventBase retrieval timed out');

        search.settle(FOUND);
        await retrieval();

        expect(state.prompts).toEqual({});
        expect(toastsShown()).toMatchObject({ error: [expect.stringContaining('timed out')], warning: [], info: [], success: [] });
    });

    it('says nothing of a search that failed in it, as the timeout already said the reply went without memory', async () => {
        const search = held();
        state.turn = search.promise;
        const { reply, retrieval } = startReplyRetrieval();

        await vi.advanceTimersByTimeAsync(BOUND_MS);
        await reply;
        search.settle({ events: [], debug: { failedSearchCount: 2, searchFailureMessage: "Query embedding via 'openrouter' failed: 500" } });
        await retrieval();

        expect(state.prompts).toEqual({});
        expect(toastsShown()).toMatchObject({ warning: [], info: [], success: [] });
    });

    it('still says a setup that cannot run, which fails every turn until it is fixed', async () => {
        const search = held();
        state.turn = search.promise;
        const { reply, retrieval } = startReplyRetrieval();
        const problem = 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.';

        await vi.advanceTimersByTimeAsync(BOUND_MS);
        await reply;
        search.settle({ events: [], debug: { failedSearchCount: 1, searchFailureMessage: 'failed', setupFailureMessage: problem } });
        await retrieval();

        expect(globalThis.toastr.error).toHaveBeenCalledWith(problem, 'VectFox — configuration invalid', { timeOut: 0, extendedTimeOut: 0 });
        expect(state.prompts).toEqual({});
    });

    it('starts no further search when its bound passed during the archive search', async () => {
        const archiveSearch = held();
        state.archive = archiveSearch.promise;
        const { reply, retrieval } = startReplyRetrieval();

        await vi.advanceTimersByTimeAsync(BOUND_MS);
        await reply;
        archiveSearch.settle([]);
        await retrieval();

        expect(retrieveEventsForTurn).not.toHaveBeenCalled();
        expect(state.prompts).toEqual({});
    });
});

describe('an EventBase retrieval inside its bound', () => {
    it('sets its block and says what it injected', async () => {
        const { reply, retrieval } = startReplyRetrieval();

        await reply;
        await retrieval();

        expect(state.prompts[EVENTBASE_BLOCK]).toBe('- the duel at the mill');
        expect(toastsShown()).toMatchObject({ error: [], success: ['EventBase: 1 event(s) injected'] });
    });

    it('says no events matched when every search worked and none matched', async () => {
        state.turn = Promise.resolve({ events: [], debug: { failedSearchCount: 0, rawCount: 0 } });
        const { reply } = startReplyRetrieval();

        await reply;

        expect(toastsShown()).toMatchObject({ warning: [], info: ['EventBase: no events matched'] });
    });

    it('says only that a search failed when one did, not that no events matched', async () => {
        state.turn = Promise.resolve({ events: [], debug: { failedSearchCount: 2, searchFailureMessage: "Query embedding via 'openrouter' failed: 500" } });
        const { reply } = startReplyRetrieval();

        await reply;

        expect(toastsShown().warning).toEqual([expect.stringContaining('A memory search failed, so no memory was injected this turn')]);
        expect(toastsShown().info).toEqual([]);
    });
});

describe('a preview, as the Query Tester runs it', () => {
    it('returns what it found, and neither injects it nor says it was injected', async () => {
        const preview = await runEventBaseRetrieval({ chat: CHAT, searchText: 'who won the duel', settings: SETTINGS, dryRun: true, testMessage: 'who won the duel' });

        expect(preview).toMatchObject({ injectionText: '- the duel at the mill', eventCount: 1 });
        expect(state.prompts).toEqual({});
        expect(toastsShown().success).toEqual([]);
    });
});

// H4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md: the events' message numbers count the story, so recency
// and "already in context" measure the story's length, each summary a message source answers for as its messages.
describe('the length a retrieval measures the events by', () => {
    it('is the story\'s, the messages with text in story order', async () => {
        const { setMessageSource } = await import('../src/shared/chat-messages.js');
        const fought = { mes: 'They fought at the mill.', stands: [{ mes: 'Draw.' }, { mes: 'Strike.' }, { mes: 'Yield.' }] };
        state.chat = [fought, { mes: '' }, { is_user: true, mes: 'who won the duel' }];
        setMessageSource(message => (message.stands ? { owner: 'Mill Summaries', originals: message.stands } : null));
        try {
            await runEventBaseRetrieval({ chat: CHAT, searchText: 'who won the duel', settings: SETTINGS, dryRun: true });
        } finally {
            setMessageSource(null);
            state.chat = [];
        }
        expect(retrieveEventsForTurn.mock.calls[0][0].chatLength).toBe(4);
    });
});
