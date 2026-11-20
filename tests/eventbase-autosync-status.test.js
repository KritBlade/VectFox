/**
 * getChatAutoSyncStatus — the backend probe and diagnostics a passive refresh skips.
 *
 * The auto-sync status feeds the Chat Auto-Sync checkbox + LED. Its one backend
 * call is the vectorization-tip probe (ensureVectorizationTip), which runs on a cold
 * or far-behind tip; resolving the write target logs `[EventBase][resolve]` diagnostics. The
 * panel refreshes this status on every chat change, including while VectFox is
 * disabled — and a disabled VectFox must neither call the backend nor log. These
 * tests lock in that `shouldProbeBackend: false` reads only the cached tip and
 * `shouldLogResolution: false` reaches the resolver, while the defaults keep both;
 * that a chat with collections but none locked to it is told from one with none
 * (§2.2 of vectfox-multi-collection-per-chat.md); and that a run on such a chat
 * writes nothing.
 *
 * eventbase-workflow.js transitively imports ST modules that don't resolve under
 * vitest, so the whole graph is stubbed. Same harness as eventbase-settle-lag.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureVectorizationTip: vi.fn(),
    getVectorizationTip: vi.fn(),
    resolveEventBaseWriteTarget: vi.fn(),
    ownCollections: [],
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
    readEventBaseProgress: vi.fn(() => ({})), getAutoSyncMarker: vi.fn(), setLastUsedWindowSize: vi.fn(),
    getVectorizationTip: mocks.getVectorizationTip, setVectorizationTip: vi.fn(),
    ensureVectorizationTip: mocks.ensureVectorizationTip, shouldUseTipFallback: vi.fn(),
    resolveEventBaseWriteTarget: mocks.resolveEventBaseWriteTarget,
}));
// The chat's own collections; the run target is the write target, none with collections but none locked.
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    NONE_IN_USE_TEXT: 'No collection of this chat is locked to it, so EventBase writes nothing here.',
    chatOwnCollections: () => mocks.ownCollections,
    resolveEventBaseRunTarget: () => mocks.resolveEventBaseWriteTarget(),
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
    mocks.resolveEventBaseWriteTarget.mockReset()
        .mockReturnValue({ collectionId: 'vf_eventbase_c1', registryKey: 'qdrant:vf_eventbase_c1' });
    mocks.ownCollections = [];
});

describe('getChatAutoSyncStatus — a chat with none of its collections locked (§2.2)', () => {
    it('reads none-locked, with the collections, for a chat that has some but none locked, and no-collection for one with none', async () => {
        mocks.resolveEventBaseWriteTarget.mockReturnValue(null);
        mocks.ownCollections = [{ registryKey: 'qdrant:vf_eventbase_c1', name: 'Harbor Keeper', isLockedHere: false }];
        expect(await getChatAutoSyncStatus({})).toEqual({ state: 'none-locked', collections: mocks.ownCollections });
        mocks.ownCollections = [];
        expect(await getChatAutoSyncStatus({})).toEqual({ state: 'no-collection' });
    });

    it('writes nothing for such a chat: a run refuses before reading a window', async () => {
        mocks.resolveEventBaseWriteTarget.mockReturnValue(null);
        mocks.ownCollections = [{ registryKey: 'qdrant:vf_eventbase_c1', name: 'Harbor Keeper', isLockedHere: false }];
        await expect(runEventBaseIngestion({ messages: [{ mes: 'm0' }], chatUUID: 'uuid-1', settings: {} }))
            .rejects.toThrow('No collection of this chat is locked to it, so EventBase writes nothing here.');
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

describe('getChatAutoSyncStatus — write-target diagnostics', () => {
    it('lets the resolver log by default', async () => {
        await getChatAutoSyncStatus({});
        expect(mocks.resolveEventBaseWriteTarget).toHaveBeenCalledWith({}, 'uuid-1', { shouldLogResolution: true });
    });

    it('tells the resolver to stay quiet when diagnostics are off', async () => {
        await getChatAutoSyncStatus({}, { shouldProbeBackend: false, shouldLogResolution: false });
        expect(mocks.resolveEventBaseWriteTarget).toHaveBeenCalledWith({}, 'uuid-1', { shouldLogResolution: false });
    });
});
