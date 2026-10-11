/**
 * getChatAutoSyncStatus — the backend probe and diagnostics a passive refresh skips.
 *
 * The auto-sync status feeds the Chat Auto-Sync checkbox + LED. Its one backend
 * call is the vectorization-tip probe (ensureVectorizationTip), which runs on a cold
 * tip cache; resolving the write target logs `[EventBase][resolve]` diagnostics. The
 * panel refreshes this status on every chat change, including while VectFox is
 * disabled — and a disabled VectFox must neither call the backend nor log. These
 * tests lock in that `shouldProbeBackend: false` reads only the cached tip and
 * `shouldLogResolution: false` reaches the resolver, while the defaults keep both.
 *
 * eventbase-workflow.js transitively imports ST modules that don't resolve under
 * vitest, so the whole graph is stubbed. Same harness as eventbase-settle-lag.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureVectorizationTip: vi.fn(),
    getVectorizationTip: vi.fn(),
    resolveEventBaseWriteTarget: vi.fn(),
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: vi.fn(() => 'chat-1'), substituteParams: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [{ mes: 'm0' }, { mes: 'm1' }, { mes: 'm2' }, { mes: 'm3' }] })),
}));
vi.mock('../core/collection-ids.js', () => ({ getChatUUID: vi.fn(() => 'uuid-1'), parseRegistryKey: vi.fn(), COLLECTION_PREFIXES: {}, buildRegistryKey: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../core/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../core/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {} }));
vi.mock('../core/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../core/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(),
    clearExtractionCachesForChat: vi.fn(), buildEventBaseCollectionId: vi.fn(), isLastWindowExtracted: vi.fn(() => false),
    getVectorizationTip: mocks.getVectorizationTip, setVectorizationTip: vi.fn(),
    ensureVectorizationTip: mocks.ensureVectorizationTip, shouldUseTipFallback: vi.fn(),
    resolveEventBaseWriteTarget: mocks.resolveEventBaseWriteTarget,
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: vi.fn(), isCollectionActiveForContextAnyKey: vi.fn(), setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(),
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

const { getChatAutoSyncStatus } = await import('../core/eventbase-workflow.js');

beforeEach(() => {
    mocks.ensureVectorizationTip.mockReset().mockResolvedValue(4);
    mocks.getVectorizationTip.mockReset().mockReturnValue(2);
    mocks.resolveEventBaseWriteTarget.mockReset()
        .mockReturnValue({ collectionId: 'vf_eventbase_c1', registryKey: 'qdrant:vf_eventbase_c1' });
});

describe('getChatAutoSyncStatus — vectorization tip source', () => {
    it('probes the backend by default', async () => {
        const status = await getChatAutoSyncStatus({});
        expect(mocks.ensureVectorizationTip).toHaveBeenCalledWith('uuid-1', 'vf_eventbase_c1', {});
        expect(status.vectorizationTip).toBe(4);
    });

    it('reads only the cached tip when probing is off', async () => {
        const status = await getChatAutoSyncStatus({}, { shouldProbeBackend: false });
        expect(mocks.ensureVectorizationTip).not.toHaveBeenCalled();
        expect(mocks.getVectorizationTip).toHaveBeenCalledWith('uuid-1');
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
