/**
 * Chunk injection: the RAG page's context prompt and XML tag wrap every chunk block the generation interceptor
 * (rearrangeChat) sends. A chunk whose collection or chunk sets its own position goes out in a block of its own, one
 * per position, and each of those blocks is wrapped as a single block is. An empty context prompt and tag send the
 * chunks as they are.
 *
 * chat-vectorization.js reaches ST host modules (through src/sillytavern/) that don't resolve under vitest, so
 * those host modules and every other direct import are stubbed, except constants.js, feature-gate.js and
 * lru-cache.js, which stay real. Each collection's search returns the chunks a test places in it.
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
vi.mock('../src/features/keyword-search/keyword-boost.js', () => ({ extractChatKeywords: vi.fn(() => []), extractBM25Keywords: vi.fn() }));
vi.mock('../src/features/text-cleaning/text-cleaning.js', () => ({ cleanText: vi.fn((text) => text) }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(),
    queryCollection: vi.fn(async (registryKey) => mocks.searchResults[registryKey]),
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
const KEEP = 'The old keep has a hidden stair.';
const WRAPPER = { rag_context: 'Things {{char}} remembers:', rag_xml_tag: 'VectFoxMemory' };
const wrapped = (text) => `<VectFoxMemory>\nThings {{char}} remembers:\n\n${text}\n</VectFoxMemory>`;

/** Two document collections, one chunk each; `keepPayload` adds to the keep chunk's stored payload. */
function placeChunks(keepPayload = {}) {
    mocks.searchResults['standard:vf_document_harbor'] = { hashes: [101], metadata: [{ text: HARBOR, score: 0.9 }] };
    mocks.searchResults['standard:vf_document_keep'] = { hashes: [102], metadata: [{ text: KEEP, score: 0.8, ...keepPayload }] };
}

async function injectChunks(wrapperSettings) {
    await rearrangeChat(CHAT, { enabled: true, position: 1, depth: 2, query: 2, top_k: 3, score_threshold: 0, ...wrapperSettings }, 'normal');
    expect(globalThis.toastr.error).not.toHaveBeenCalled();
}

const promptOf = (tag) => mocks.extensionPrompts[tag];

beforeEach(() => {
    for (const key of Object.keys(mocks.extensionPrompts)) delete mocks.extensionPrompts[key];
    for (const key of Object.keys(mocks.searchResults)) delete mocks.searchResults[key];
    vi.clearAllMocks();
    vi.stubGlobal('window', {});
    vi.stubGlobal('toastr', { error: vi.fn(), info: vi.fn(), success: vi.fn() });
});

describe('the RAG page wrapper on chunk blocks', () => {
    it('wraps the chunks once when they all go to one position', async () => {
        placeChunks();
        await injectChunks(WRAPPER);

        expect(promptOf('3_vectfox')).toEqual({ value: wrapped(`${HARBOR}\n\n${KEEP}`), position: 1, depth: 2 });
    });

    it('wraps each block when a chunk sets a position of its own', async () => {
        placeChunks({ position: 0, depth: 0 });
        await injectChunks(WRAPPER);

        expect(promptOf('3_vectfox_pos0')).toEqual({ value: wrapped(HARBOR), position: 1, depth: 2 });
        expect(promptOf('3_vectfox_pos1')).toEqual({ value: wrapped(KEEP), position: 0, depth: 0 });
        expect(promptOf('3_vectfox').value).toBe('');
    });

    it('sends each block as it is when the context prompt and tag are empty', async () => {
        placeChunks({ position: 0, depth: 0 });
        await injectChunks({ rag_context: '', rag_xml_tag: '' });

        expect(promptOf('3_vectfox_pos0').value).toBe(HARBOR);
        expect(promptOf('3_vectfox_pos1').value).toBe(KEEP);
    });
});
