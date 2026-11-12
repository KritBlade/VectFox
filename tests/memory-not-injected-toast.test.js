/**
 * When a memory search fails, a query embedding included after its retry, the player
 * is told with a yellow toast, so they can regenerate: no memory, or incomplete memory
 * when the other searches still found some. A search that failed on its setup, such as
 * a deleted embedding profile, fails the same way on every turn, so it gets the sticky
 * configuration toast instead.
 *
 * Drives the real runEventBaseRetrieval with retrieveEventsForTurn stubbed, and the
 * real notifier against a stubbed toastr.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ extensionSettings: { vectfox: {} }, turn: null }));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'lost-memory-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'lost-memory-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_lost', getRegistryBackend: () => 'qdrant',
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => ['vf_eventbase_lost'], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(), getChatLockedCollections: () => [],
}));
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
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn(async () => state.turn) }));
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

const EMBEDDING_ERROR = "Query embedding via 'openrouter' failed: 500 - {\"error\":\"API request failed\"}";
const runTurn = () => runEventBaseRetrieval({ chat: [{ is_user: true, mes: 'who won the duel' }], searchText: 'who won the duel', settings: {} });

beforeEach(() => {
    globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
});

describe('a turn whose memory search failed', () => {
    it('warns in yellow that no memory was injected', async () => {
        state.turn = { events: [], debug: { failedSearchCount: 2, searchFailureMessage: EMBEDDING_ERROR } };

        await runTurn();

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        const [message, title] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('A memory search failed, so no memory was injected this turn');
        expect(message).toContain('API request failed');
        expect(title).toBe('VectFox — memory not injected correctly');
    });

    it('warns again on the next turn that fails the same way', async () => {
        state.turn = { events: [], debug: { failedSearchCount: 1, searchFailureMessage: EMBEDDING_ERROR } };

        await runTurn();
        await runTurn();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    // A StoryArc block can still hold its picked threads when its search failed.
    it('warns that the memory is incomplete when a search failed but some memory was injected', async () => {
        state.turn = { events: [{ summary: 'the duel at the mill' }], storyArcShape: 'chain', debug: { failedSearchCount: 1, searchFailureMessage: EMBEDDING_ERROR } };

        await runTurn();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        const [message, title] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('A memory search failed, so this turn\'s memory is incomplete');
        expect(message).toContain('API request failed');
        expect(title).toBe('VectFox — memory not injected correctly');
    });

    it('shows the sticky configuration toast, and no advice to regenerate, when a search failed on its setup', async () => {
        const problem = 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.';
        state.turn = { events: [], debug: { failedSearchCount: 2, searchFailureMessage: "Query embedding via 'openrouter' failed: 500", setupFailureMessage: problem } };

        await runTurn();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(problem, 'VectFox — configuration invalid', { timeOut: 0, extendedTimeOut: 0 });
    });

    it('stays quiet when memory was injected and every search worked', async () => {
        state.turn = { events: [{ summary: 'the duel at the mill' }], debug: { failedSearchCount: 0, searchFailureMessage: '' } };

        await runTurn();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('stays quiet when nothing matched and every embedding worked', async () => {
        state.turn = { events: [], debug: { failedSearchCount: 0, searchFailureMessage: '' } };

        await runTurn();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });
});
