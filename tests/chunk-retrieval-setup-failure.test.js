/**
 * A collection whose search fails on its setup on a live turn (rearrangeChat), such as a document collection after
 * its embedding profile was deleted: the sticky configuration toast says what to fix, as the search fails the same
 * way on every turn, and the message still sends with the other collections' chunks. Any other failed search stays
 * in the console.
 *
 * chat-vectorization.js's host modules and direct imports are stubbed as in chunk-block-wrapper.test.js, and the
 * notifier is real. Each collection's search returns what a test places in it, or throws it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const extensionPrompts = {};
    return {
        extensionPrompts,
        searchResults: {},
        setExtensionPrompt: vi.fn((key, value, position, depth) => {
            extensionPrompts[key] = { value, position, depth };
        }),
        log: {
            error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(),
            domain: vi.fn(), enabled: () => false, domainEnabled: () => false,
        },
    };
});

vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat-1'),
    is_send_press: false,
    setExtensionPrompt: mocks.setExtensionPrompt,
    substituteParams: vi.fn((text) => text),
    chat_metadata: {},
    extension_prompts: mocks.extensionPrompts,
    getRequestHeaders: vi.fn(() => ({})),
}));
vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ chat: [] })), extension_settings: { vectfox: {} } }));
// Every chat message hashes to 1, so no chunk below is dropped as already in the chat.
vi.mock('../../../../utils.js', () => ({ getStringHash: vi.fn(() => 1) }));
vi.mock('../src/features/keyword-search/keyword-extraction.js', () => ({ extractChatKeywords: vi.fn(() => []), extractBM25Keywords: vi.fn() }));
vi.mock('../src/features/text-cleaning/text-cleaning.js', () => ({ cleanText: vi.fn((text) => text) }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(),
    queryCollection: vi.fn(async (registryKey) => {
        const result = mocks.searchResults[registryKey];
        if (result instanceof Error) throw result;
        return result;
    }),
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({ isBackendAvailable: vi.fn() }));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    registerCollection: vi.fn(),
    getCollectionRegistry: vi.fn(() => Object.keys(mocks.searchResults)),
    isCollectionEmpty: vi.fn(() => false),
}));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: vi.fn(() => true), filterActiveCollections: vi.fn(async (keys) => keys), setCollectionLock: vi.fn(),
    getChunkMetadata: vi.fn(), getCollectionMeta: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: {} }));
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
// EventBase retrieval, Summarizer Injection and ghosting run first on a live turn; they have their own tests.
vi.mock('../src/features/eventbase/index.js', () => ({ runEventBaseRetrieval: vi.fn(), runSummarizerInjection: vi.fn(), applyGhosting: vi.fn() }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { rearrangeChat } from '../src/features/chunkbase/chat-vectorization.js';

const CHAT = [{ mes: 'Where did we leave the map?', is_user: true }];
const HARBOR = 'The harbor gate closes at dusk.';

/** One collection that answers, and one whose search throws `failure`. */
function placeCollections(failure) {
    mocks.searchResults['standard:vf_document_harbor'] = { hashes: [101], metadata: [{ text: HARBOR, score: 0.9 }] };
    mocks.searchResults['standard:vf_document_keep'] = failure;
}

const runTurn = () => rearrangeChat(CHAT, { enabled: true, position: 1, depth: 2, query: 2, top_k: 3, score_threshold: 0, rag_context: '', rag_xml_tag: '' }, 'normal');

beforeEach(() => {
    for (const key of Object.keys(mocks.extensionPrompts)) delete mocks.extensionPrompts[key];
    for (const key of Object.keys(mocks.searchResults)) delete mocks.searchResults[key];
    vi.clearAllMocks();
    vi.stubGlobal('window', {});
    vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
});

describe('a collection whose search fails on a live turn', () => {
    it('shows the sticky configuration toast when it failed on its setup, and still sends the other chunks', async () => {
        const problem = 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.';
        placeCollections(Object.assign(new Error(problem), { code: 'invalid_model_config' }));

        await runTurn();

        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(problem, 'VectFox — configuration invalid', { timeOut: 0, extendedTimeOut: 0 });
        expect(mocks.extensionPrompts['3_vectfox'].value).toBe(HARBOR);
    });

    it('keeps any other failure in the console', async () => {
        placeCollections(new Error('Qdrant answered 500'));

        await runTurn();

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to query collection standard:vf_document_keep'), 'Qdrant answered 500');
        expect(mocks.extensionPrompts['3_vectfox'].value).toBe(HARBOR);
    });
});
