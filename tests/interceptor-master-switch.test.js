/**
 * Generation interceptor (rearrangeChat) — prompt clearing and the master switch.
 *
 * ST keeps every extension prompt until it is overwritten, so any VectFox block the
 * interceptor does not clear keeps reaching the model on later generations. These
 * tests lock in that each live generation first empties every block the interceptor
 * owns (chunks, its per-position variants, EventBase, Summarizer), and that with the
 * master switch OFF it stops right after: no retrieval and no lifecycle logging.
 *
 * The lorebook block belongs to the GENERATION_STARTED handler and is covered in
 * world-info-integration.test.js.
 *
 * chat-vectorization.js imports ST host modules that don't resolve under vitest, so
 * every direct import is stubbed except constants.js, feature-gate.js and
 * data-structures.js, which stay real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const extensionPrompts = {};
    return {
        extensionPrompts,
        setExtensionPrompt: vi.fn((key, value, position, depth) => {
            extensionPrompts[key] = { value, position, depth };
        }),
        runBoundedRetrieval: vi.fn(),
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
vi.mock('../../../../utils.js', () => ({ getStringHash: vi.fn(() => 1) }));
vi.mock('../core/chunking.js', () => ({ isUnitStrategy: vi.fn() }));
vi.mock('../core/keyword-boost.js', () => ({ extractChatKeywords: vi.fn(), extractBM25Keywords: vi.fn() }));
vi.mock('../core/text-cleaning.js', () => ({ cleanText: vi.fn((text) => text) }));
vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), queryCollection: vi.fn(),
    queryActiveCollections: vi.fn(), deleteVectorItems: vi.fn(),
}));
vi.mock('../backends/backend-manager.js', () => ({ isBackendAvailable: vi.fn() }));
vi.mock('../core/summarizer.js', () => ({ summarizeText: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: vi.fn(() => []), isCollectionEmpty: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: vi.fn(), filterActiveCollections: vi.fn(), setCollectionLock: vi.fn(),
    getChunkMetadata: vi.fn(), getCollectionMeta: vi.fn(),
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/conditional-activation.js', () => ({ buildSearchContext: vi.fn(), filterChunksByConditions: vi.fn(), processChunkLinks: vi.fn() }));
vi.mock('../ui/search-debug.js', () => ({ createDebugData: vi.fn(), setLastSearchDebug: vi.fn(), addTrace: vi.fn(), recordChunkFate: vi.fn() }));
vi.mock('../core/bounded-retrieval.js', () => ({ runBoundedRetrieval: mocks.runBoundedRetrieval }));
vi.mock('../core/retrieval-budget.js', () => ({ resolveEventBaseRetrievalTimeoutMs: vi.fn(() => 15000) }));
vi.mock('../core/log.js', () => ({ log: mocks.log }));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: vi.fn(() => 'uuid-1'), COLLECTION_PREFIXES: {}, INTERNAL_COLLECTION_IDS: {},
    parseCollectionId: vi.fn(), parseRegistryKey: vi.fn(), getRegistryBackend: vi.fn(),
}));

import { clearInterceptorPrompts, rearrangeChat } from '../core/chat-vectorization.js';

/** Blocks left over from a previous generation, plus two the interceptor must not touch. */
function seedPreviousGeneration() {
    Object.assign(mocks.extensionPrompts, {
        '3_vectfox': { value: 'chunks' },
        '3_vectfox_pos0': { value: 'chunks at position 0' },
        '3_vectfox_pos12': { value: 'chunks at position 12' },
        '3_vectfox_eventbase': { value: '<VectFoxMemory>events</VectFoxMemory>' },
        '3_vectfox_summarizer': { value: '<VectFoxSummarizer>recent</VectFoxSummarizer>' },
        '3_vectfox_lorebook': { value: '<VectFoxLorebook>lore</VectFoxLorebook>' },
        '1_memory': { value: 'another extension' },
    });
}

const INTERCEPTOR_TAGS = ['3_vectfox', '3_vectfox_pos0', '3_vectfox_pos12', '3_vectfox_eventbase', '3_vectfox_summarizer'];
const valueOf = (tag) => mocks.extensionPrompts[tag].value;
const CHAT = [{ mes: 'Where did we leave the map?', is_user: true }];

beforeEach(() => {
    for (const key of Object.keys(mocks.extensionPrompts)) delete mocks.extensionPrompts[key];
    vi.clearAllMocks();
    seedPreviousGeneration();
});

describe('clearInterceptorPrompts', () => {
    it('empties the chunk block, every position variant, EventBase and Summarizer', () => {
        clearInterceptorPrompts({ position: 1, depth: 2 });
        for (const tag of INTERCEPTOR_TAGS) expect(valueOf(tag)).toBe('');
    });

    it('leaves the lorebook block and other extensions alone', () => {
        clearInterceptorPrompts({ position: 1, depth: 2 });
        expect(valueOf('3_vectfox_lorebook')).toBe('<VectFoxLorebook>lore</VectFoxLorebook>');
        expect(valueOf('1_memory')).toBe('another extension');
    });
});

describe('rearrangeChat with the master switch OFF', () => {
    it('removes last turn\'s blocks, retrieves nothing and logs nothing at lifecycle', async () => {
        await rearrangeChat(CHAT, { enabled: false, position: 1, depth: 2 }, 'normal');

        for (const tag of INTERCEPTOR_TAGS) expect(valueOf(tag)).toBe('');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
        expect(mocks.log.lifecycle).not.toHaveBeenCalled();
    });
});

describe('rearrangeChat with the master switch ON', () => {
    it('removes last turn\'s blocks even when this turn injects nothing', async () => {
        // Chat shorter than min_chat_length: the interceptor exits before any retrieval.
        await rearrangeChat(CHAT, { enabled: true, min_chat_length: 10, position: 1, depth: 2 }, 'normal');

        for (const tag of INTERCEPTOR_TAGS) expect(valueOf(tag)).toBe('');
        expect(mocks.runBoundedRetrieval).not.toHaveBeenCalled();
    });
});
