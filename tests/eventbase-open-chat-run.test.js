/**
 * Running EventBase over the open chat tells it whether the run reads the chat from its first message,
 * as only then can a window read again replace its events.
 *
 * chat-vectorization.js's host modules and direct imports are stubbed as in
 * chunk-retrieval-setup-failure.test.js, and the EventBase run is a stub that records what it was asked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    chat: [],
    runEventBaseIngestion: vi.fn(async () => ({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 })),
    log: {
        error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(),
        domain: vi.fn(), enabled: () => false, domainEnabled: () => false,
    },
}));

vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat-1'),
    is_send_press: false,
    setExtensionPrompt: vi.fn(),
    substituteParams: vi.fn((text) => text),
    chat_metadata: {},
    extension_prompts: {},
    getRequestHeaders: vi.fn(() => ({})),
}));
vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ chat: mocks.chat })), extension_settings: { vectfox: {} } }));
vi.mock('../../../../utils.js', () => ({ getStringHash: vi.fn(() => 1) }));
vi.mock('../src/features/keyword-search/keyword-extraction.js', () => ({ extractChatKeywords: vi.fn(() => []), extractBM25Keywords: vi.fn() }));
vi.mock('../src/features/text-cleaning/text-cleaning.js', () => ({ cleanText: vi.fn((text) => text) }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), queryCollection: vi.fn(),
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({ isBackendAvailable: vi.fn(async () => true) }));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    registerCollection: vi.fn(), getCollectionRegistry: vi.fn(() => []), isCollectionEmpty: vi.fn(() => false),
}));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: vi.fn(() => true), filterActiveCollections: vi.fn(async (keys) => keys), setCollectionLock: vi.fn(),
    getChunkMetadata: vi.fn(), getCollectionMeta: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { complete: vi.fn() } }));
vi.mock('../src/features/collections/conditional-activation.js', () => ({ buildSearchContext: vi.fn(() => ({})), processChunkLinks: vi.fn() }));
vi.mock('../src/features/vector-backend/bounded-retrieval.js', () => ({ runBoundedRetrieval: vi.fn(async (work) => work) }));
vi.mock('../src/shared/retrieval-budget.js', () => ({ resolveEventBaseRetrievalTimeoutMs: vi.fn(() => 15000) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: mocks.log }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: vi.fn(() => 'uuid-1'),
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'vf_eventbase_', VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_LOREBOOK: 'vf_lorebook_' },
    INTERNAL_COLLECTION_IDS: [],
    parseCollectionId: vi.fn(),
    parseRegistryKey: vi.fn((registryKey) => ({ collectionId: registryKey.slice(registryKey.indexOf(':') + 1) })),
    getRegistryBackend: vi.fn(),
}));
vi.mock('../src/features/eventbase/index.js', () => ({
    runEventBaseIngestion: mocks.runEventBaseIngestion, runEventBaseRetrieval: vi.fn(), runSummarizerInjection: vi.fn(), applyGhosting: vi.fn(),
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

const { runEventBaseOnOpenChat } = await import('../src/features/chunkbase/chat-vectorization.js');

describe('EventBase over the open chat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
        mocks.chat.length = 0;
        mocks.chat.push(
            { name: 'Harbor Keeper', is_user: false, mes: 'The gate is shut.' },
            { name: 'Rook', is_user: true, mes: 'Open it.' },
            { name: 'Harbor Keeper', is_user: false, mes: 'It opens.' },
            { name: 'Rook', is_user: true, mes: 'Go in.' },
        );
    });

    it('reads the chat from its first message by default', async () => {
        await runEventBaseOnOpenChat({ vector_backend: 'qdrant' });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0]).toMatchObject({ isReadFromChatStart: true });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0].messages).toHaveLength(4);
    });

    it('says a run from a later message does not read from the chat\'s first message', async () => {
        await runEventBaseOnOpenChat({ vector_backend: 'qdrant' }, null, { startFromMessage: 3 });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0]).toMatchObject({ isReadFromChatStart: false });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0].messages).toHaveLength(2);
    });
});
