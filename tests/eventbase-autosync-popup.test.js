/**
 * The "Auto-Sync: extracting events..." popup must appear only when an auto-sync
 * run has windows left to extract.
 *
 * Drives the real runEventBaseIngestion with the real fingerprint cache and
 * start-marker; only ST, the LLM extractor and the vector insert are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ extensionSettings: { vectfox: {} }, points: [] }));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'popup-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'popup-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_popup', getRegistryBackend: () => 'qdrant',
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
}));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), getAdditionalArgs: vi.fn(),
    getSavedHashes: async () => state.points.map((_, i) => i),
}));
vi.mock('../core/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../core/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error {}, EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../core/eventbase-extractor.js', () => ({
    extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => [{
        importance: 5, summary: messages.map(m => m.mes).join(' | '), source_window_start: windowStart, source_window_end: windowEnd,
    }]),
}));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../core/eventbase-store.js', async (importOriginal) => ({
    ...(await importOriginal()),
    insertEvents: vi.fn(async (events) => { state.points.push(...events); }),
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: async () => ({ listChunks: async () => ({ items: state.points.map(p => ({ metadata: { source_window_end: p.source_window_end } })) }) }),
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(), getChatLockedCollections: () => [],
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../core/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

const { runEventBaseIngestion, getAutoSyncWindowSize } = await import('../core/eventbase-workflow.js');

const SETTINGS = { eventbase_autosync_window_turns: 1, eventbase_min_importance_store: 1, eventbase_autosync_popup: true };
const POPUP_TEXT = 'Auto-Sync: extracting events...';

/** Alternating user/AI messages, `count` long. */
const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'User' : 'Bot', is_user: i % 2 === 0, mes: `message ${i}`,
}));

const autoSync = (messages, chatUUID, { suppressAutoSyncPopup = false } = {}) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: true, suppressAutoSyncPopup,
    collectionIdOverride: 'vf_eventbase_popup',
    windowSizeOverride: getAutoSyncWindowSize(SETTINGS), windowOverlapOverride: 0,
});

const popupCount = () => globalThis.toastr.info.mock.calls.filter(([text]) => text === POPUP_TEXT).length;

describe('auto-sync popup', () => {
    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points.length = 0;
        state.extensionSettings.vectfox = {};
    });

    // Live case: marker stamped at 450 on a 452-message chat. The quick-exit misses
    // (window 448-449 was never extracted, it predates the marker) but the marker
    // filter leaves nothing to do.
    it('stays hidden when the start-marker filter leaves no window to extract', async () => {
        state.extensionSettings.vectfox.eventbase_autosync_start_marker = { 'marker-uuid': 450 };

        const result = await autoSync(buildChat(452), 'marker-uuid');

        expect(result.eventsExtracted).toBe(0);
        expect(popupCount()).toBe(0);
    });

    it('stays hidden when the committed slice is shorter than one window', async () => {
        await autoSync(buildChat(2), 'short-uuid');
        expect(popupCount()).toBe(0);
    });

    it('shows once when a newly committed turn is extracted', async () => {
        const result = await autoSync(buildChat(4), 'commit-uuid');

        expect(result.eventsExtracted).toBe(1);
        expect(popupCount()).toBe(1);
    });

    it('stays hidden on MESSAGE_SENT while extraction still runs', async () => {
        const result = await autoSync(buildChat(4), 'sent-uuid', { suppressAutoSyncPopup: true });

        expect(result.eventsExtracted).toBe(1);
        expect(popupCount()).toBe(0);
    });
});
