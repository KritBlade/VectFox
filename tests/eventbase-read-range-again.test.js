/**
 * A stretch of the chat read again (InternalProject/Vectfox/plans/executed/eventbase-read-range-again.md, B1): the run reads
 * every window from the one holding its first message to the one holding its last, on the chat's window grid, though
 * the record holds them; each window's new events replace its earlier ones once stored, and a window whose new read
 * finds none loses its earlier ones (D4); a window whose read fails keeps its events; a stop, or an insert that fails,
 * keeps the windows already stored, each in one version, with the links off their replaced events moved; windows outside
 * the stretch, the tip and the auto-sync marker are left as they were. The StoryArc links and the verdict are the
 * caller's.
 *
 * Drives the real runEventBaseIngestion with the real fingerprint record, tip and window replacement; only ST, the LLM
 * extractor and the vector backend are stubbed. The stub backend keeps its points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    clock: 1000,
    eventCountFor: () => 1,
    failingWindowStart: null,
    failingInsertWindowStart: null,
    onExtract: null,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'read-again-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'read-again-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_read_again', getRegistryBackend: () => 'qdrant',
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(async (collectionId, hashes) => {
        state.points = state.points.filter(point => !hashes.includes(point.hash));
    }),
    updateChunkMetadata: vi.fn(async (collectionId, hash, metadata) => {
        Object.assign(state.points.find(point => point.hash === hash).metadata, metadata);
    }),
    getSavedHashes: async () => state.points.map(point => point.hash),
}));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    EventBaseFatalError: class extends Error { constructor(message, code = 'fatal') { super(message); this.code = code; } },
    EventBaseExtractionError: class extends Error {}, buildEmbedText: (e) => e.summary,
}));
vi.mock('../src/features/eventbase/eventbase-extractor.js', async () => {
    const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');
    const { EventBaseExtractionError } = await import('../src/features/eventbase/eventbase-schema.js');
    return {
        extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => {
            state.clock += 1000;
            state.onExtract?.(windowStart);
            if (windowStart === state.failingWindowStart) throw new EventBaseExtractionError('The provider refused the prompt');
            return Array.from({ length: state.eventCountFor(windowStart) }, (_, order) => ({
                event_id: `eb_${state.clock}_${windowStart}_${order}_t`,
                importance: 5,
                summary: `${messages.map(message => message.mes).join(' | ')} (${order})`,
                source_window_start: windowStart,
                source_window_end: windowEnd,
                source_message_hashes: messages.map(hashSourceMessage),
                window_event_order: order,
                created_at: state.clock,
            }));
        }),
    };
});
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', async () => {
    const { setCollectionMeta } = await import('../src/features/collections/collection-metadata.js');
    return {
        collectionInUse: () => ({ collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] }),
        noCollectionInUseText: () => null, resolveEventBaseRunTarget: () => null,
        sharedCollectionsLockedHere: () => ({ otherChats: [], archives: [] }),
        useChatCollection: vi.fn(registryKey => setCollectionMeta(registryKey, { scope: 'chat' })),
    };
});
vi.mock('../src/features/eventbase/eventbase-store.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        insertEvents: vi.fn(async (events) => {
            // As the embedding provider's rate limit outlasting every hedge ends a run.
            if (events.some(event => event.source_window_start === state.failingInsertWindowStart)) {
                throw Object.assign(new Error('Hedge fatal: 4 attempts via custom failed'), { name: 'HedgeFatalError', isHedgeFatal: true });
            }
            state.points.push(...events.map(event => ({ hash: original.eventPointHash(event.event_id), text: event.summary, metadata: { ...event, eventbase: true } })));
        }),
    };
});
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: async () => ({ listChunks: async () => ({ items: state.points.map(point => ({ hash: point.hash, text: point.text, metadata: point.metadata })) }) }),
}));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({ linkNewStoryEvents: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), getChatLockedCollections: () => [],
}));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: new Proxy({}, { get: (methods, name) => (methods[name] ??= vi.fn()) }),
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false } }));

vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');
const { getAutoSyncMarker, getVectorizationTip, markWindowUnfinished, writeEventBaseProgress } = await import('../src/features/eventbase/eventbase-store.js');
const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');
const { linkNewStoryEvents } = await import('../src/features/eventbase/story-arc-links.js');
const { progressTracker } = await import('../src/shared/progress-tracker.js');
const { setEventBaseListeners } = await import('../src/features/eventbase/eventbase-announcements.js');

/** Each run's end as EventBase's listener heard it. */
const runsEnded = [];
setEventBaseListeners({ onRunEnded: run => runsEnded.push(run) });

const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1, story_arc_mode_enabled: true, vector_backend: 'qdrant' };

const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'Bot' : 'User', is_user: i % 2 === 1, mes: `message ${i}`,
}));

let chatNumber = 0;
const newChatUUID = () => `read-again-uuid-${++chatNumber}`;
const collectionIdOf = chatUUID => `vf_eventbase_read_again_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const run = (messages, chatUUID, options = {}) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8,
    collectionIdOverride: collectionIdOf(chatUUID), ...options,
});

/** Read messages 4 to 7 again (counted from 1), as Vectorize Content does with Read windows already read again on. */
const readAgain = (messages, chatUUID, options = {}) => run(messages, chatUUID, {
    startFromMessage: 4, endAtMessage: 7, isReadingAgain: true, shouldCompleteProgress: false, ...options,
});

const eventIdsOfWindow = windowStart => state.points
    .filter(point => point.metadata.source_window_start === windowStart)
    .map(point => point.metadata.event_id);

const eventOfWindow = windowStart => state.points.find(point => point.metadata.source_window_start === windowStart).metadata;

/** The first message of each window sent to the extractor since the last clear, counted from 0. */
const windowsSent = () => extractEvents.mock.calls.map(([{ windowStart }]) => windowStart).sort((a, b) => a - b);

/** Each window's extraction calls, as the times its stored events were written: 1 means one version. */
const versionsByWindow = () => {
    const calls = {};
    for (const { metadata } of state.points) {
        calls[metadata.source_window_start] ??= new Set();
        calls[metadata.source_window_start].add(metadata.created_at);
    }
    return Object.fromEntries(Object.entries(calls).map(([start, times]) => [start, times.size]));
};

describe('a stretch read again', () => {
    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points = [];
        state.clock = 1000;
        state.eventCountFor = () => 1;
        state.failingWindowStart = null;
        state.failingInsertWindowStart = null;
        state.onExtract = null;
        state.extensionSettings.vectfox = {};
        vi.clearAllMocks();
        runsEnded.length = 0;
    });

    it('reads every window from the one holding its first message to the one holding its last, though the record holds them, and replaces their events', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const untouched = [0, 8, 10].map(start => eventIdsOfWindow(start));
        const earlier = [2, 4, 6].map(start => eventIdsOfWindow(start));
        extractEvents.mockClear();

        const result = await readAgain(chat, chatUUID);

        // Message 4 sits in window 2 (messages 3 and 4 counted from 1), message 7 in window 6.
        expect(windowsSent()).toEqual([2, 4, 6]);
        expect(result.windowsProcessed).toBe(3);
        expect([0, 8, 10].map(start => eventIdsOfWindow(start))).toEqual(untouched);
        for (const [position, start] of [2, 4, 6].entries()) {
            expect(eventIdsOfWindow(start)).toHaveLength(1);
            expect(earlier[position]).not.toContain(eventIdsOfWindow(start)[0]);
        }
        expect(versionsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1 });
        expect(result.insertedEventIds.sort()).toEqual([2, 4, 6].flatMap(start => eventIdsOfWindow(start)).sort());
    });

    it('removes the events of a window whose new read finds none, drops the links to them, and moves the links to a replaced event to its replacement', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const [emptiedId] = eventIdsOfWindow(2);
        const [replacedId] = eventIdsOfWindow(4);
        const linker = eventOfWindow(8);
        linker.story_links = [
            { event_id: emptiedId, type: 'continues', thread: 'The harbor' },
            { event_id: replacedId, type: 'causes', thread: 'The harbor' },
        ];

        state.eventCountFor = start => (start === 2 ? 0 : 1);
        const result = await readAgain(chat, chatUUID);

        expect(eventIdsOfWindow(2)).toEqual([]);
        const [replacementId] = eventIdsOfWindow(4);
        expect(linker.story_links).toEqual([{ event_id: replacementId, type: 'causes', thread: 'The harbor' }]);
        expect(result.eventIdsWithMovedLinks).toEqual([linker.event_id]);
    });

    it('removes the events of every window when no new read finds one', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const untouched = [0, 8, 10].map(start => eventIdsOfWindow(start));

        state.eventCountFor = () => 0;
        const result = await readAgain(chat, chatUUID);

        expect(result.eventsExtracted).toBe(0);
        expect([2, 4, 6].map(start => eventIdsOfWindow(start))).toEqual([[], [], []]);
        expect([0, 8, 10].map(start => eventIdsOfWindow(start))).toEqual(untouched);
    });

    it('keeps the events of a window whose read fails, so nothing is stored twice', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const keptIds = eventIdsOfWindow(4);
        // On the unfinished record already, so the run sends it once and waits for no second pass.
        markWindowUnfinished(chat.slice(4, 6).map(hashSourceMessage), collectionKeyOf(chatUUID));
        state.failingWindowStart = 4;

        const result = await readAgain(chat, chatUUID);

        expect(result.windowsFailed).toBe(1);
        expect(eventIdsOfWindow(4)).toEqual(keptIds);
        expect(versionsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1 });
    });

    it('keeps the window stored before a stop in one version, and moves the links off the event it replaced', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const [replacedId] = eventIdsOfWindow(2);
        const linker = eventOfWindow(8);
        linker.story_links = [{ event_id: replacedId, type: 'continues', thread: '' }];
        const stop = new AbortController();
        // Stop comes as window 4 is sent, while window 2's events are being stored.
        state.onExtract = start => { if (start === 4) stop.abort(); };

        const result = await readAgain(chat, chatUUID, { abortSignal: stop.signal, parallelWindows: 1 });

        const [replacementId] = eventIdsOfWindow(2);
        expect(replacementId).not.toBe(replacedId);
        expect(versionsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1 });
        expect(linker.story_links).toEqual([{ event_id: replacementId, type: 'continues', thread: '' }]);
        expect(result.insertedEventIds).toEqual([replacementId]);
        expect(result.eventIdsWithMovedLinks).toEqual([linker.event_id]);
        // The stopped run's end is heard, with the event it stored.
        expect(runsEnded.at(-1)).toEqual({ collectionId: collectionIdOf(chatUUID), eventsAdded: 1, windowsProcessed: result.windowsProcessed });
    });

    it('moves the links off the window it replaced when a later window\'s insert fails, which keeps its events', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        const [replacedId] = eventIdsOfWindow(2);
        const keptIds = eventIdsOfWindow(4);
        const linker = eventOfWindow(8);
        linker.story_links = [{ event_id: replacedId, type: 'continues', thread: '' }];
        state.failingInsertWindowStart = 4;

        const runsBefore = runsEnded.length;
        await expect(readAgain(chat, chatUUID, { parallelWindows: 1 })).rejects.toThrow('Hedge fatal');

        // The failed run's end is heard too, once, with the event it stored before the failure.
        expect(runsEnded.slice(runsBefore)).toEqual([{ collectionId: collectionIdOf(chatUUID), eventsAdded: 1, windowsProcessed: expect.any(Number) }]);
        const [replacementId] = eventIdsOfWindow(2);
        expect(replacementId).not.toBe(replacedId);
        expect(eventIdsOfWindow(4)).toEqual(keptIds);
        expect(versionsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1 });
        expect(linker.story_links).toEqual([{ event_id: replacementId, type: 'continues', thread: '' }]);
    });

    it('leaves the tip and the auto-sync marker where they were', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        writeEventBaseProgress(collectionKeyOf(chatUUID), { autoSyncStartMarker: 10 });

        await readAgain(chat, chatUUID);

        expect(getVectorizationTip(collectionKeyOf(chatUUID))).toBe(12);
        expect(getAutoSyncMarker(collectionKeyOf(chatUUID))).toBe(10);
    });

    it('leaves its StoryArc links and its verdict to the caller', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);
        await run(chat, chatUUID);
        vi.clearAllMocks();

        await readAgain(chat, chatUUID, { progressTitle: 'Reading again, step 1 of 3: windows' });

        expect(linkNewStoryEvents).not.toHaveBeenCalled();
        expect(progressTracker.show).toHaveBeenCalledWith('Reading again, step 1 of 3: windows', 3, 'Windows', expect.anything());
        expect(progressTracker.complete).not.toHaveBeenCalled();
    });
});

describe('a run with an End message', () => {
    beforeEach(() => {
        state.points = [];
        state.clock = 1000;
        state.eventCountFor = () => 1;
        state.failingWindowStart = null;
        vi.clearAllMocks();
    });

    it('ends at the window that holds it, and reads the windows after it on its next run', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(12);

        await run(chat, chatUUID, { endAtMessage: 5 });
        expect(windowsSent()).toEqual([0, 2, 4]);

        extractEvents.mockClear();
        await run(chat, chatUUID);
        expect(windowsSent()).toEqual([6, 8, 10]);
    });
});
