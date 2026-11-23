/**
 * getChatAutoSyncStatus — the backend probe a passive refresh skips, and the collection it reports on.
 *
 * The auto-sync status feeds the Chat Auto-Sync checkbox + LED. Its one backend
 * call is the vectorization-tip probe (ensureVectorizationTip), which runs on a cold
 * or far-behind tip. The panel refreshes this status on every chat change, including
 * while VectFox is disabled — and a disabled VectFox must not call the backend. These
 * tests lock in that `shouldProbeBackend: false` reads only the cached tip while the
 * default probes; that the collection is the one route's answer (collectionInUse);
 * that a chat with collections but none in use is told from one with none, with why
 * (§2.2 and D18 of vectfox-multi-collection-per-chat.md); and that a run on such a
 * chat writes nothing.
 *
 * eventbase-workflow.js transitively imports ST modules that don't resolve under
 * vitest, so the whole graph is stubbed. Same harness as eventbase-settle-lag.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureVectorizationTip: vi.fn(),
    getVectorizationTip: vi.fn(),
    collectionInUse: vi.fn(),
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: vi.fn(() => 'chat-1'), substituteParams: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [{ mes: 'm0' }, { mes: 'm1' }, { mes: 'm2' }, { mes: 'm3' }] })),
}));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: vi.fn(() => 'uuid-1'), parseRegistryKey: vi.fn(), COLLECTION_PREFIXES: {}, buildRegistryKey: vi.fn() }));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {} }));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(), getUnfinishedWindowFingerprints: vi.fn(() => new Set()),
    clearExtractionCaches: vi.fn(), isLastWindowExtracted: vi.fn(() => false),
    readEventBaseProgress: vi.fn(() => ({})), getAutoSyncMarker: vi.fn(), autoSyncFirstWindowStart: vi.fn(() => 0),
    getVectorizationTip: mocks.getVectorizationTip, setVectorizationTip: vi.fn(),
    ensureVectorizationTip: mocks.ensureVectorizationTip, shouldUseTipFallback: vi.fn(),
}));
// The one route: the chat's collection in use, or why there is none; the run target is the one in use.
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    collectionInUse: mocks.collectionInUse,
    noCollectionInUseText: (inUse, consequence) => (inUse.collection ? null : `No collection is in use in this chat, so ${consequence}.`),
    resolveEventBaseRunTarget: () => mocks.collectionInUse().collection,
    sharedCollectionsLockedHere: () => ({ otherChats: [], archives: [] }),
    useChatCollection: vi.fn(),
}));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: vi.fn(), isCollectionActiveForContextAnyKey: vi.fn(), setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { getChatAutoSyncStatus, runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');

beforeEach(() => {
    mocks.ensureVectorizationTip.mockReset().mockResolvedValue(4);
    mocks.getVectorizationTip.mockReset().mockReturnValue(2);
    mocks.collectionInUse.mockReset().mockReturnValue({
        collection: { collectionId: 'vf_eventbase_c1', registryKey: 'qdrant:vf_eventbase_c1' }, reason: null, collections: [], lockedElsewhere: [],
    });
});

const NONE_IN_USE = {
    collection: null, reason: 'none-in-use', lockedElsewhere: [],
    collections: [{ registryKey: 'qdrant:vf_eventbase_c1', name: 'Harbor Keeper', isLockedHere: false }],
};

describe('getChatAutoSyncStatus — a chat with none of its collections in use (§2.2, D18)', () => {
    it('reads none-locked, with the collections and why, for a chat that has some but none in use, and no-collection for one with none', async () => {
        mocks.collectionInUse.mockReturnValue(NONE_IN_USE);
        expect(await getChatAutoSyncStatus({})).toEqual({
            state: 'none-locked',
            collections: NONE_IN_USE.collections,
            noneInUseText: 'No collection is in use in this chat, so EventBase reads and writes nothing here.',
        });
        mocks.collectionInUse.mockReturnValue({ collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] });
        expect(await getChatAutoSyncStatus({})).toEqual({ state: 'no-collection' });
    });

    it('writes nothing for such a chat: a run refuses before reading a window, saying why', async () => {
        mocks.collectionInUse.mockReturnValue(NONE_IN_USE);
        await expect(runEventBaseIngestion({ messages: [{ mes: 'm0' }], chatUUID: 'uuid-1', settings: {} }))
            .rejects.toThrow('EventBase: No collection is in use in this chat, so EventBase writes nothing here.');
    });
});

describe('getChatAutoSyncStatus — vectorization tip source', () => {
    it('probes the backend by default', async () => {
        const status = await getChatAutoSyncStatus({});
        expect(mocks.ensureVectorizationTip).toHaveBeenCalledWith('qdrant:vf_eventbase_c1', {}, { commitBoundary: 2, windowSize: 2 });
        expect(status.vectorizationTip).toBe(4);
    });

    it('reads only the cached tip when probing is off', async () => {
        const status = await getChatAutoSyncStatus({}, { shouldProbeBackend: false });
        expect(mocks.ensureVectorizationTip).not.toHaveBeenCalled();
        expect(mocks.getVectorizationTip).toHaveBeenCalledWith('qdrant:vf_eventbase_c1');
        expect(status.vectorizationTip).toBe(2);
    });

    it('reports no tip, instead of probing, when probing is off and the cache is cold', async () => {
        mocks.getVectorizationTip.mockReturnValue(undefined);
        const status = await getChatAutoSyncStatus({}, { shouldProbeBackend: false });
        expect(mocks.ensureVectorizationTip).not.toHaveBeenCalled();
        expect(status.vectorizationTip).toBeUndefined();
        expect(status.state).toBe('partial');
    });
});

describe('getChatAutoSyncStatus — a chat shorter than what EventBase read', () => {
    it('reports vectorization-ahead when the tip is past the chat\'s end, with the counts the page shows', async () => {
        mocks.ensureVectorizationTip.mockResolvedValue(6);
        const status = await getChatAutoSyncStatus({});
        expect(status).toMatchObject({ state: 'vectorization-ahead', registryKey: 'qdrant:vf_eventbase_c1', chatMessageCount: 4, vectorizationTip: 6, unfinishedWindowCount: 0 });
    });

    it('reports no shorter chat for a tip at its end, a marker past it included, as an auto-sync run moves that marker back', async () => {
        const { getAutoSyncMarker } = await import('../src/features/eventbase/eventbase-store.js');
        getAutoSyncMarker.mockReturnValue(9);
        const status = await getChatAutoSyncStatus({});
        expect(status.state).toBe('partial');
        expect(status.markerValue).toBe(9);
        getAutoSyncMarker.mockReset();
    });
});

describe('getChatAutoSyncStatus — the collection it reports on', () => {
    it('is the open chat\'s collection in use, from the one route', async () => {
        await getChatAutoSyncStatus({});
        expect(mocks.collectionInUse).toHaveBeenCalledWith({}, { chatUUID: 'uuid-1', chatId: 'chat-1' });
    });
});

describe('getChatAutoSyncStatus — the windows it counts', () => {
    it('counts auto-sync\'s windows from its start marker, as an auto-sync run does', async () => {
        const { autoSyncFirstWindowStart, isLastWindowExtracted } = await import('../src/features/eventbase/eventbase-store.js');
        autoSyncFirstWindowStart.mockReturnValueOnce(1);
        await getChatAutoSyncStatus({});
        expect(autoSyncFirstWindowStart).toHaveBeenCalledWith('qdrant:vf_eventbase_c1', 2);
        expect(isLastWindowExtracted).toHaveBeenCalledWith(expect.any(Array), 2, 2, 'qdrant:vf_eventbase_c1', expect.any(Function), 1);
    });
});
