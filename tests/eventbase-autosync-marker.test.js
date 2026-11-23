/**
 * Auto-sync's windows start at its start marker. A marker that is not a multiple of auto-sync's window size, as
 * max(source_window_end) + 1 from windows of another size or the chat's length at Keep up from here leave it, has a
 * window start exactly there, so auto-sync reads no message before the marker again and skips none after it. The
 * quick-exit and the AutoSync page's status count windows the same way, and the stamp counts the chat as a run does.
 *
 * Drives the real runEventBaseIngestion and stampAutoSyncMarker with the real window record, tip and marker; only ST,
 * the LLM extractor and the vector backend are stubbed. The stub backend keeps its points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    chat: [],
    clock: 1000,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'marker-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: state.chat }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'marker-chat-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_marker_chat', getRegistryBackend: () => 'qdrant',
    parseCollectionId: () => ({ scope: 'chat' }),
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: vi.fn(), insertVectorItems: vi.fn(), updateChunkMetadata: vi.fn(),
    deleteVectorItems: vi.fn(async (collectionId, hashes) => {
        state.points = state.points.filter(point => !hashes.includes(point.hash));
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
    return {
        extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => {
            state.clock += 1000;
            return [{
                event_id: `eb_${state.clock}_${windowStart}_0_t`,
                importance: 5,
                summary: messages.map(message => message.mes).join(' | '),
                source_window_start: windowStart,
                source_window_end: windowEnd,
                source_message_hashes: messages.map(hashSourceMessage),
                window_event_order: 0,
                created_at: state.clock,
            }];
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
vi.mock('../src/features/collections/collection-metadata.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), getChatLockedCollections: () => [],
}));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: new Proxy({}, { get: (methods, name) => (methods[name] ??= vi.fn()) }),
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { isChatFullyVectorized, runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');
const { autoSyncFirstWindowStart, getAutoSyncMarker, stampAutoSyncMarker } = await import('../src/features/eventbase/eventbase-store.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

// Vectorize Content reads windows of 2. Auto-sync reads the AutoSync page's turns, two messages each, and holds back
// the latest turn.
const settingsAtTurns = turns => ({ eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1, eventbase_autosync_window_turns: turns });
const SETTINGS = settingsAtTurns(1);

/** Messages `from` to `to` of the story, inclusive. */
const story = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    name: (from + i) % 2 === 0 ? 'Bot' : 'User', is_user: (from + i) % 2 === 1, mes: `message ${from + i}`,
}));

let chatNumber = 0;
const newChatUUID = () => `marker-chat-uuid-${++chatNumber}`;
const collectionIdOf = chatUUID => `vf_eventbase_marker_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const vectorize = (messages, chatUUID) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8, collectionIdOverride: collectionIdOf(chatUUID),
});
const autoSync = (messages, chatUUID, turns = 1) => runEventBaseIngestion({
    messages, chatUUID, settings: settingsAtTurns(turns), isAutoSync: true, parallelWindows: 1, collectionIdOverride: collectionIdOf(chatUUID),
    windowSizeOverride: turns * 2, windowOverlapOverride: 0,
});

/** The messages of each window sent to the extractor, in the order sent. */
const windowsRead = () => extractEvents.mock.calls.map(([{ messages }]) => messages.map(message => message.mes));

beforeEach(() => {
    globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
    state.points = [];
    state.chat = [];
    state.clock = 1000;
    state.extensionSettings.vectfox = {};
    vi.clearAllMocks();
});

describe('auto-sync from a marker that is not a multiple of its window size', () => {
    it('reads from the marker at a new window size, neither reading the messages before it again nor skipping those after it', async () => {
        const chatUUID = newChatUUID();
        const registryKey = collectionKeyOf(chatUUID);
        // Messages 0 and 1 read at a window of 2; auto-sync then reads at 2 turns, a window of 4.
        await vectorize(story(0, 1), chatUUID);
        expect(await stampAutoSyncMarker(registryKey, SETTINGS)).toBe(2);
        expect(autoSyncFirstWindowStart(registryKey, 4)).toBe(2);
        extractEvents.mockClear();

        // 10 messages, the latest turn of 4 held back: the window of messages 2 to 5 is read.
        await autoSync(story(0, 9), chatUUID, 2);
        expect(windowsRead()).toEqual([['message 2', 'message 3', 'message 4', 'message 5']]);

        // 14 messages: the next window, of messages 6 to 9.
        extractEvents.mockClear();
        await autoSync(story(0, 13), chatUUID, 2);
        expect(windowsRead()).toEqual([['message 6', 'message 7', 'message 8', 'message 9']]);
    });

    it('reads the first message after Keep up from here on a chat with an odd number of messages', async () => {
        const chatUUID = newChatUUID();
        const registryKey = collectionKeyOf(chatUUID);
        // Messages 0 to 3 read, then Keep up from here at 13 messages: 4 to 12 are left unread on purpose.
        await vectorize(story(0, 3), chatUUID);
        state.chat = story(0, 12);
        expect(await stampAutoSyncMarker(registryKey, SETTINGS, { floor: 'chatLength' })).toBe(13);
        extractEvents.mockClear();

        // Messages 13 and 14 are the latest turn, held back.
        await autoSync(story(0, 14), chatUUID);
        expect(windowsRead()).toEqual([]);

        // The next turn settles them: messages 13 and 14 are read, and none left unread before the marker.
        await autoSync(story(0, 16), chatUUID);
        expect(windowsRead()).toEqual([['message 13', 'message 14']]);

        // The status counts windows as the run does: up to date, though message 12 before the marker was never read,
        // and still once message 15 starts the next window.
        const firstWindowStart = autoSyncFirstWindowStart(registryKey, 2);
        expect(isChatFullyVectorized(story(0, 14), SETTINGS, registryKey, 2, 0, firstWindowStart)).toBe(true);
        expect(isChatFullyVectorized(story(0, 14), SETTINGS, registryKey, 2, 0, 0)).toBe(false);
        expect(isChatFullyVectorized(story(0, 15), SETTINGS, registryKey, 2, 0, firstWindowStart)).toBe(true);

        // And the next run with nothing new takes the quick-exit, building no window.
        extractEvents.mockClear();
        expect(await autoSync(story(0, 16), chatUUID)).toEqual({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 });
        expect(windowsRead()).toEqual([]);

        // Catch up in Vectorize Content counts its windows from the chat's first message, marker or not, and reads
        // the messages Keep up from here left unread.
        extractEvents.mockClear();
        await vectorize(story(0, 16), chatUUID);
        expect(extractEvents.mock.calls.map(([{ windowStart }]) => windowStart).sort((a, b) => a - b)).toEqual([4, 6, 8, 10, 12, 14]);
    });
});

describe('the auto-sync start marker\'s stamp', () => {
    it('counts the chat as a run does, leaving out messages with no text', async () => {
        const chatUUID = newChatUUID();
        const registryKey = collectionKeyOf(chatUUID);
        // 8 messages, one of them with no text: a run reads 7, at positions 0 to 6.
        state.chat = [...story(0, 4), { name: 'Bot', is_user: false, mes: '' }, ...story(5, 6)];

        expect(await stampAutoSyncMarker(registryKey, SETTINGS, { floor: 'chatLength' })).toBe(7);
        // An empty collection starts from the chat's end the same way.
        expect(await stampAutoSyncMarker(registryKey, SETTINGS)).toBe(7);
        expect(getAutoSyncMarker(registryKey)).toBe(7);
    });
});
