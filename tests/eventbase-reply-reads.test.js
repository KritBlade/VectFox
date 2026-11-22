/**
 * What a reply's EventBase retrieval reads (runEventBaseRetrieval, src/features/eventbase/eventbase-workflow.js; §2.2 and
 * D18 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): the chat's collection in use, from the one
 * route (collectionInUse), unless it is paused, beside the collections of other chats and chat files locked here, each
 * unless paused; StoryArc reads the collection in use alone. With none in use, the chat's own events are read nowhere.
 *
 * Drives the real runEventBaseRetrieval with the route, retrieveEventsForTurn and the archive search stubbed, and records
 * what each was handed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    inUse: null,
    shared: { otherChats: [], archives: [] },
    collectionInUse: null,
    retrieveEventsForTurn: null,
    searchArchiveEvents: null,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'harbor-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'harbor-uuid', COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`,
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', () => ({ isCollectionEnabled: () => true, setCollectionLock: vi.fn(), setCollectionMeta: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => {
    state.collectionInUse = vi.fn(() => state.inUse);
    return {
        collectionInUse: state.collectionInUse,
        noCollectionInUseText: () => null,
        resolveEventBaseRunTarget: () => null,
        sharedCollectionsLockedHere: () => state.shared,
        useChatCollection: vi.fn(),
    };
});
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), getSavedHashes: vi.fn(),
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({ getBackend: vi.fn() }));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error {}, EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => {
    state.searchArchiveEvents = vi.fn(async () => []);
    return { retrieveEvents: vi.fn(), searchArchiveEvents: state.searchArchiveEvents };
});
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => {
    state.retrieveEventsForTurn = vi.fn(async () => ({ events: [], debug: {} }));
    return { retrieveEventsForTurn: state.retrieveEventsForTurn };
});
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({
    formatEventsForInjectionDetailed: vi.fn(() => ({ text: '', includedCount: 0 })),
    formatStoryArcForInjection: vi.fn(() => ({ text: '', includedCount: 0 })),
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({ isInvalidModelConfigError: () => false, notifyInvalidModel: vi.fn(), notifyMemoryNotInjected: vi.fn() }));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false, domainEnabled: () => false, domain: vi.fn() } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { runEventBaseRetrieval } = await import('../src/features/eventbase/eventbase-workflow.js');

const lockedIn = (registryKey, isPaused = false) => ({ registryKey, collectionId: registryKey.slice(7), isPaused });
const IN_USE = lockedIn('qdrant:vf_eventbase_harbor');
const OTHER_CHAT = lockedIn('qdrant:vf_eventbase_tides');
const ARCHIVE = lockedIn('qdrant:vf_archiveevent_harbor');
const inUseOf = collection => ({ collection, reason: collection ? null : 'none-in-use', collections: [IN_USE], lockedElsewhere: [] });
const turn = (params = {}) => runEventBaseRetrieval({ chat: [{ is_user: true, mes: 'who won the duel' }], searchText: 'who won the duel', settings: {}, ...params });
const handed = () => state.retrieveEventsForTurn.mock.calls[0][0];

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
    state.inUse = inUseOf(IN_USE);
    state.shared = { otherChats: [], archives: [] };
});

describe("what a reply's EventBase retrieval reads", () => {
    it('reads the collection in use beside the collections of other chats and chat files locked here; StoryArc the one in use alone', async () => {
        state.shared = { otherChats: [OTHER_CHAT], archives: [ARCHIVE] };
        await turn();
        expect(handed()).toMatchObject({
            liveCollectionIds: [IN_USE.registryKey, OTHER_CHAT.registryKey],
            storyArcCollectionKey: IN_USE.registryKey,
            skipLiveQuery: false,
            skipContextDedup: true,
        });
        expect(state.searchArchiveEvents.mock.calls[0][0]).toEqual([ARCHIVE]);
    });

    it('reads the answer the reply step resolved, asking the route nothing', async () => {
        const later = lockedIn('qdrant:vf_eventbase_harbor_mh3k2x1a');
        await turn({ inUse: inUseOf(later) });
        expect(state.collectionInUse).not.toHaveBeenCalled();
        expect(handed()).toMatchObject({ liveCollectionIds: [later.registryKey], storyArcCollectionKey: later.registryKey, skipContextDedup: false });
    });

    it('reads none of the chat\'s own events while none is in use, only what is locked in beside it, and StoryArc nothing', async () => {
        state.inUse = inUseOf(null);
        state.shared = { otherChats: [OTHER_CHAT], archives: [] };
        await turn();
        expect(handed()).toMatchObject({ liveCollectionIds: [OTHER_CHAT.registryKey], storyArcCollectionKey: null });
    });

    it('skips a paused collection, the one in use included, with nothing else to read searching nothing', async () => {
        state.inUse = inUseOf(lockedIn(IN_USE.registryKey, true));
        state.shared = { otherChats: [lockedIn(OTHER_CHAT.registryKey, true)], archives: [lockedIn(ARCHIVE.registryKey, true)] };
        await turn();
        expect(state.retrieveEventsForTurn).not.toHaveBeenCalled();
        expect(state.searchArchiveEvents).not.toHaveBeenCalled();
    });
});
