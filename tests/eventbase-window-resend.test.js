/**
 * A window whose extraction fails is sent again, and stays on record until it succeeds.
 *
 * Drives the real runEventBaseIngestion with the real fingerprint cache, tip and
 * start-marker; only ST, the LLM extractor and the vector insert are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    sends: [],
    failureFor: () => null,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'resend-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'resend-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_resend', getRegistryBackend: () => 'qdrant',
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), deleteVectorItems: vi.fn(), getAdditionalArgs: vi.fn(),
    getSavedHashes: async () => state.points.map((_, i) => i),
}));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error { constructor(message, code = 'fatal') { super(message); this.code = code; } },
    EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({
    extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => {
        state.sends.push(windowStart);
        const sendNumber = state.sends.filter(start => start === windowStart).length;
        const failure = state.failureFor(windowStart, sendNumber);
        if (failure) throw failure;
        return [{ event_id: `event-${windowStart}`, importance: 5, summary: messages.map(m => m.mes).join(' | '), source_window_start: windowStart, source_window_end: windowEnd }];
    }),
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

const { runEventBaseIngestion, isChatFullyVectorized } = await import('../src/features/eventbase/eventbase-workflow.js');
const { getUnfinishedWindowFingerprints, clearExtractionCachesForChat } = await import('../src/features/eventbase/eventbase-store.js');
const { EventBaseFatalError, EventBaseExtractionError } = await import('../src/features/eventbase/eventbase-schema.js');

const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1, eventbase_autosync_window_turns: 1 };
const WINDOW_SIZE = 2;

const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'User' : 'Bot', is_user: i % 2 === 0, mes: `message ${i}`,
}));

const extractionError = () => new EventBaseExtractionError('EventBase: model reply could not be used');

let chatNumber = 0;
const newChatUUID = () => `resend-uuid-${++chatNumber}`;

const manualRun = (messages, chatUUID, options = {}) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8,
    collectionIdOverride: 'vf_eventbase_resend', ...options,
});

const autoSyncRun = (messages, chatUUID) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: true, parallelWindows: 8,
    collectionIdOverride: 'vf_eventbase_resend', windowSizeOverride: WINDOW_SIZE, windowOverlapOverride: 0,
});

const sendsOf = (windowStart) => state.sends.filter(start => start === windowStart).length;
const unfinishedCount = (chatUUID) => getUnfinishedWindowFingerprints(chatUUID, WINDOW_SIZE).size;

describe('window re-send', () => {
    /** Delays the run asked for, in order. Each wait ends at once so the tests stay fast. */
    let requestedDelays;

    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points.length = 0;
        state.sends.length = 0;
        state.failureFor = () => null;
        state.extensionSettings.vectfox = {};
        requestedDelays = [];
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
            requestedDelays.push(delay);
            callback();
            return 0;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('in the same run', () => {
        it('sends a failed window again and stores its events', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start, sendNumber) => (start === 2 && sendNumber === 1 ? extractionError() : null);

            const result = await manualRun(buildChat(8), chatUUID);

            expect(sendsOf(2)).toBe(2);
            expect(result.windowsFailed).toBe(0);
            expect(result.eventsExtracted).toBe(4);
            expect(state.points.map(p => p.source_window_start).sort()).toEqual([0, 2, 4, 6]);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });

        // Red means a run stopped, and a toast asks the player to act. A window that gets
        // through on a later send does neither, so it stays in the console.
        it('raises no toast for a window that gets through on a later send', async () => {
            state.failureFor = (start, sendNumber) => (start === 2 && sendNumber === 1 ? extractionError() : null);

            await manualRun(buildChat(8), newChatUUID());

            expect(globalThis.toastr.error).not.toHaveBeenCalled();
            expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        });

        it('raises no toast for a window that times out and then gets through', async () => {
            const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
            state.failureFor = (start, sendNumber) => (start === 2 && sendNumber === 1 ? timeout : null);

            await manualRun(buildChat(8), newChatUUID());

            expect(globalThis.toastr.error).not.toHaveBeenCalled();
            expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        });

        // A collection holding another vector size refuses every attempt, and the pause needs the code to reach it.
        it('stops at once, with no retry, on an insert refused for its configuration', async () => {
            const { insertEvents } = await import('../src/features/eventbase/eventbase-store.js');
            const sizeError = Object.assign(new Error('Embedding: this collection holds vectors of size 1024, but the current embedding model makes size 768, so nothing was stored.'), { code: 'invalid_model_config' });
            insertEvents.mockRejectedValueOnce(sizeError);
            const callsBefore = insertEvents.mock.calls.length;

            await expect(manualRun(buildChat(8), newChatUUID())).rejects.toMatchObject({ code: 'invalid_model_config', message: sizeError.message });

            expect(insertEvents.mock.calls.length - callsBefore).toBe(1);
        });

        it('raises no toast for an insert that gets through on a retry', async () => {
            const { insertEvents } = await import('../src/features/eventbase/eventbase-store.js');
            insertEvents.mockRejectedValueOnce(new Error('Unexpected end of JSON input'));

            const result = await manualRun(buildChat(8), newChatUUID());

            expect(result.eventsExtracted).toBe(4);
            expect(globalThis.toastr.warning).not.toHaveBeenCalled();
            expect(globalThis.toastr.success).not.toHaveBeenCalled();
        });

        it('hands the reason to whoever reports the run', async () => {
            state.failureFor = (start) => (start === 2 ? extractionError() : null);

            const result = await manualRun(buildChat(8), newChatUUID());

            expect(result.windowsFailed).toBe(1);
            expect(result.firstFailureDetail).toContain('could not be used');
            expect(globalThis.toastr.error).not.toHaveBeenCalled();
        });

        it('sends a timed-out window again', async () => {
            const chatUUID = newChatUUID();
            const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
            state.failureFor = (start, sendNumber) => (start === 4 && sendNumber === 1 ? timeout : null);

            const result = await manualRun(buildChat(8), chatUUID);

            expect(sendsOf(4)).toBe(2);
            expect(result.windowsTimedOut).toBe(0);
            expect(result.eventsExtracted).toBe(4);
        });

        it('sends only the window that failed', async () => {
            state.failureFor = (start, sendNumber) => (start === 2 && sendNumber === 1 ? extractionError() : null);

            await manualRun(buildChat(8), newChatUUID());

            expect(state.sends.slice().sort()).toEqual([0, 2, 2, 4, 6]);
        });

        it('gives up after the last pass, waiting longer before each one, and reports the window', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start) => (start === 2 ? extractionError() : null);

            const result = await manualRun(buildChat(8), chatUUID);

            expect(sendsOf(2)).toBe(3);
            expect(requestedDelays).toEqual([5000, 10000]);
            expect(result.windowsFailed).toBe(1);
            expect(result.eventsExtracted).toBe(3);
            expect(unfinishedCount(chatUUID)).toBe(1);
        });

        it('does not repeat a run where nothing came back and more than 8 windows failed', async () => {
            state.failureFor = () => extractionError();

            const result = await manualRun(buildChat(20), newChatUUID());

            expect(state.sends.length).toBe(10);
            expect(requestedDelays).toEqual([]);
            expect(result.windowsFailed).toBe(10);
        });

        it('still re-sends a short run where nothing came back', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start, sendNumber) => (sendNumber === 1 ? extractionError() : null);

            const result = await manualRun(buildChat(8), chatUUID);

            expect(state.sends.length).toBe(8);
            expect(result.windowsFailed).toBe(0);
            expect(result.eventsExtracted).toBe(4);
        });

        it('stops waiting when the user presses Stop, and keeps the window on record', async () => {
            const chatUUID = newChatUUID();
            const controller = new AbortController();
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            vi.mocked(globalThis.setTimeout).mockImplementation(() => {
                controller.abort();
                return 0;
            });

            await manualRun(buildChat(8), chatUUID, { abortSignal: controller.signal });

            expect(sendsOf(2)).toBe(1);
            expect(unfinishedCount(chatUUID)).toBe(1);
        });
    });

    describe('on a later run', () => {
        it('sends a window left unfinished even though the last window is done', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);

            state.sends.length = 0;
            state.failureFor = () => null;
            const result = await manualRun(chat, chatUUID);

            expect(state.sends).toEqual([2]);
            expect(result.windowsFailed).toBe(0);
            expect(result.eventsExtracted).toBe(1);
            expect(state.points.map(p => p.source_window_start).sort()).toEqual([0, 2, 4, 6]);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });

        it('does nothing once the window has succeeded', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);
            state.failureFor = () => null;
            await manualRun(chat, chatUUID);

            state.sends.length = 0;
            await manualRun(chat, chatUUID);

            expect(state.sends).toEqual([]);
        });

        it('does not let the stored tip skip a failed first window', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start) => (start === 0 ? extractionError() : null);
            await manualRun(buildChat(8), chatUUID);

            state.sends.length = 0;
            state.failureFor = () => null;
            const result = await manualRun(buildChat(10), chatUUID);

            expect(state.sends.slice().sort()).toEqual([0, 8]);
            expect(result.eventsExtracted).toBe(2);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });

        it('sends a window already on record once per run', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);

            state.sends.length = 0;
            requestedDelays.length = 0;
            const result = await manualRun(chat, chatUUID);

            expect(state.sends).toEqual([2]);
            expect(requestedDelays).toEqual([]);
            expect(result.windowsFailed).toBe(1);
            expect(unfinishedCount(chatUUID)).toBe(1);
        });

        it('sends a window that hit a fatal error, once the run is started again', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? new EventBaseFatalError('EventBase: invalid model') : null);

            await expect(manualRun(chat, chatUUID)).rejects.toThrow('invalid model');
            expect(sendsOf(2)).toBe(1);
            expect(unfinishedCount(chatUUID)).toBe(1);

            state.sends.length = 0;
            state.failureFor = () => null;
            await manualRun(chat, chatUUID);

            expect(state.sends).toEqual([2]);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });

        it('forgets a window whose message has since changed, and sends the changed window', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);

            state.sends.length = 0;
            state.failureFor = () => null;
            const editedChat = chat.map((message, i) => (i === 2 ? { ...message, mes: 'edited message' } : message));
            await manualRun(editedChat, chatUUID);

            expect(state.sends).toEqual([2]);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });
    });

    describe('auto-sync', () => {
        it('keeps its quick exit until a new turn commits, then sends the window', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await autoSyncRun(buildChat(10), chatUUID);
            expect(sendsOf(2)).toBe(3);

            state.sends.length = 0;
            state.failureFor = () => null;
            await autoSyncRun(buildChat(10), chatUUID);
            expect(state.sends).toEqual([]);

            await autoSyncRun(buildChat(12), chatUUID);
            expect(state.sends.slice().sort()).toEqual([2, 8]);
            expect(unfinishedCount(chatUUID)).toBe(0);
        });

        it('leaves a window before its start marker to a manual run', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);
            state.extensionSettings.vectfox.eventbase_autosync_start_marker = { [chatUUID]: 8 };

            state.sends.length = 0;
            state.failureFor = () => null;
            await autoSyncRun(buildChat(12), chatUUID);
            expect(state.sends).toEqual([8]);
            expect(unfinishedCount(chatUUID)).toBe(1);

            state.sends.length = 0;
            await manualRun(buildChat(12), chatUUID);
            expect(state.sends.slice().sort()).toEqual([10, 2].sort());
            expect(unfinishedCount(chatUUID)).toBe(0);
        });
    });

    describe('the record', () => {
        it('reads as not fully vectorized while a window is unfinished', async () => {
            const chatUUID = newChatUUID();
            const chat = buildChat(8);
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(chat, chatUUID);
            expect(isChatFullyVectorized(chat, SETTINGS, chatUUID, WINDOW_SIZE, 0)).toBe(false);

            state.failureFor = () => null;
            await manualRun(chat, chatUUID);
            expect(isChatFullyVectorized(chat, SETTINGS, chatUUID, WINDOW_SIZE, 0)).toBe(true);
        });

        it('applies only to the window size it was recorded under', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(buildChat(8), chatUUID);

            expect(getUnfinishedWindowFingerprints(chatUUID, 2).size).toBe(1);
            expect(getUnfinishedWindowFingerprints(chatUUID, 4).size).toBe(0);
        });

        it('is dropped with the other extraction caches', async () => {
            const chatUUID = newChatUUID();
            state.failureFor = (start) => (start === 2 ? extractionError() : null);
            await manualRun(buildChat(8), chatUUID);

            clearExtractionCachesForChat(chatUUID);

            expect(unfinishedCount(chatUUID)).toBe(0);
        });
    });
});
