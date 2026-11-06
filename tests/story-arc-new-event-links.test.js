/**
 * A finished ingestion run starts StoryArc's link step for the events it stored,
 * without waiting for it.
 *
 * Drives the real runEventBaseIngestion; only ST, the LLM extractor, the vector
 * insert and the link step are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ extensionSettings: { vectfox: {} }, points: [] }));
const linkNewStoryEventsMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'popup-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'popup-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_popup', getRegistryBackend: () => 'qdrant',
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), getAdditionalArgs: vi.fn(),
    getSavedHashes: async () => state.points.map((_, i) => i),
}));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error {}, EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({
    extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => [{
        event_id: `event-${windowStart}`, importance: 5, summary: messages.map(m => m.mes).join(' | '), source_window_start: windowStart, source_window_end: windowEnd,
    }]),
}));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../src/features/eventbase/eventbase-store.js', async (importOriginal) => ({
    ...(await importOriginal()),
    insertEvents: vi.fn(async (events) => { state.points.push(...events); }),
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: async () => ({ listChunks: async () => ({ items: state.points.map(p => ({ metadata: { source_window_end: p.source_window_end } })) }) }),
}));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn() }));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({ linkNewStoryEvents: (...args) => linkNewStoryEventsMock(...args) }));
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(), getChatLockedCollections: () => [],
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');

const COLLECTION = 'vf_eventbase_links';
const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'User' : 'Bot', is_user: i % 2 === 0, mes: `message ${i}`,
}));
const ingest = (settings, chatUUID, extra = {}) => runEventBaseIngestion({
    messages: buildChat(4),
    chatUUID,
    settings: { eventbase_min_importance_store: 1, ...settings },
    collectionIdOverride: COLLECTION,
    windowSizeOverride: 2,
    windowOverlapOverride: 0,
    ...extra,
});

describe('new events after an ingestion run', () => {
    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points.length = 0;
        state.extensionSettings.vectfox = {};
        linkNewStoryEventsMock.mockReset().mockResolvedValue(undefined);
    });

    it('hands the link step every event the run stored', async () => {
        const settings = { story_arc_mode_enabled: true };
        await ingest(settings, 'links-on-uuid');
        expect(linkNewStoryEventsMock).toHaveBeenCalledTimes(1);
        const [{ collectionId, newEventIds, settings: passedSettings }] = linkNewStoryEventsMock.mock.calls[0];
        expect(collectionId).toBe(COLLECTION);
        expect(newEventIds.length).toBeGreaterThan(0);
        expect(newEventIds).toEqual(state.points.map(point => point.event_id));
        expect(passedSettings.story_arc_mode_enabled).toBe(true);
    });

    // The link step can take minutes on a slow model, and ingestion has already succeeded.
    it('does not wait for the link step', async () => {
        linkNewStoryEventsMock.mockReturnValue(new Promise(() => {}));
        const result = await ingest({ story_arc_mode_enabled: true }, 'links-slow-uuid');
        expect(result.eventsExtracted).toBeGreaterThan(0);
    });

    it('does nothing when StoryArc mode is off', async () => {
        await ingest({}, 'links-off-uuid');
        expect(linkNewStoryEventsMock).not.toHaveBeenCalled();
    });

    it('does nothing when the run stored no events', async () => {
        await ingest({ story_arc_mode_enabled: true }, 'links-empty-uuid', { messages: buildChat(1) });
        expect(linkNewStoryEventsMock).not.toHaveBeenCalled();
    });

    it('does nothing when the run was stopped', async () => {
        const controller = new AbortController();
        controller.abort('user-stop');
        await ingest({ story_arc_mode_enabled: true }, 'links-stopped-uuid', { abortSignal: controller.signal });
        expect(linkNewStoryEventsMock).not.toHaveBeenCalled();
    });
});
