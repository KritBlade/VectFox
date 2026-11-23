/**
 * A chat shorter than what EventBase read, as after messages are deleted or a summarizer replaces some with a summary:
 * auto-sync moves its start marker back to the chat's unread end and reads the turn it held back with the new
 * messages, and a run checks each window against the window record instead of recording every window below the stale
 * tip as read.
 *
 * Drives the real runEventBaseIngestion with the real window record, tip and marker; only ST, the LLM extractor and
 * the vector backend are stubbed. The stub backend keeps its points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    clock: 1000,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'shorter-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'shorter-chat-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_shorter_chat', getRegistryBackend: () => 'qdrant',
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

const { runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');
const { capAutoSyncMarker, clearWindowCache, getAutoSyncMarker, getVectorizationTip, stampAutoSyncMarker, windowFingerprint, writeEventBaseProgress } = await import('../src/features/eventbase/eventbase-store.js');
const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

// Vectorize Content reads windows of 2; auto-sync reads windows of 2 too (one turn) and holds back the latest turn.
const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1, eventbase_autosync_window_turns: 1 };

/** Messages `from` to `to` of the story, inclusive. */
const story = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    name: (from + i) % 2 === 0 ? 'Bot' : 'User', is_user: (from + i) % 2 === 1, mes: `message ${from + i}`,
}));
/** The summary a summarizer put where messages 0 to 4 were. */
const SUMMARY = { name: 'Summary', is_user: false, mes: 'Summary of messages 0 to 4.' };

let chatNumber = 0;
const newChatUUID = () => `shorter-chat-uuid-${++chatNumber}`;
const collectionIdOf = chatUUID => `vf_eventbase_shorter_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const vectorize = (messages, chatUUID) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8, collectionIdOverride: collectionIdOf(chatUUID),
});
const autoSync = (messages, chatUUID) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: true, parallelWindows: 1, collectionIdOverride: collectionIdOf(chatUUID),
    windowSizeOverride: 2, windowOverlapOverride: 0,
});

/** The first message of each window sent to the extractor, counted from 0. */
const windowsSent = () => extractEvents.mock.calls.map(([{ windowStart }]) => windowStart).sort((a, b) => a - b);

beforeEach(() => {
    globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
    state.points = [];
    state.clock = 1000;
    state.extensionSettings.vectfox = {};
    vi.clearAllMocks();
});

describe('auto-sync on a chat shorter than its start marker', () => {
    it('moves the marker back to the chat\'s unread end and reads the messages that come after it', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 9), chatUUID);
        expect(await stampAutoSyncMarker(collectionKeyOf(chatUUID), SETTINGS)).toBe(10);
        extractEvents.mockClear();

        // A summary replaces messages 0 to 4, and message 10 is sent: 7 messages, fewer than the marker's 10.
        await autoSync([SUMMARY, ...story(5, 10)], chatUUID);
        expect(getAutoSyncMarker(collectionKeyOf(chatUUID))).toBe(6);
        expect(windowsSent()).toEqual([]);

        // Once messages 10 and 11 make a settled window, at 6 and 7, auto-sync reads it.
        await autoSync([SUMMARY, ...story(5, 13)], chatUUID);
        expect(windowsSent()).toEqual([6]);
        expect(extractEvents.mock.calls[0][0].messages.map(message => message.mes)).toEqual(['message 10', 'message 11']);
    });

    it('reads the turn auto-sync held back before the chat got shorter', async () => {
        const chatUUID = newChatUUID();
        // Windows up to [10-11] read; with 14 messages, auto-sync holds back the latest turn, messages 12 and 13.
        await vectorize(story(0, 11), chatUUID);
        expect(await stampAutoSyncMarker(collectionKeyOf(chatUUID), SETTINGS)).toBe(12);
        extractEvents.mockClear();

        // A summary replaces messages 0 to 6: 8 messages, fewer than the marker's 12, ending with the turn held back.
        const summaryOfSeven = { name: 'Summary', is_user: false, mes: 'Summary of messages 0 to 6.' };
        await autoSync([summaryOfSeven, ...story(7, 13)], chatUUID);
        expect(getAutoSyncMarker(collectionKeyOf(chatUUID))).toBe(6);
        expect(windowsSent()).toEqual([]);

        // Once the next turn settles it, the turn held back is read, at 6 and 7.
        await autoSync([summaryOfSeven, ...story(7, 15)], chatUUID);
        expect(windowsSent()).toEqual([6]);
        expect(extractEvents.mock.calls[0][0].messages.map(message => message.mes)).toEqual(['message 12', 'message 13']);
    });

    it('moves the marker back to the chat\'s unread end, and leaves one inside the chat as it is', () => {
        const registryKey = collectionKeyOf(newChatUUID());
        const autoSyncWindow = { windowSize: 2, step: 2, hashFn: hashSourceMessage };
        // Windows [0-1] to [8-9] read.
        writeEventBaseProgress(registryKey, { extractedWindows: [0, 2, 4, 6, 8].map(start => windowFingerprint(story(start, start + 1).map(hashSourceMessage))) });
        const shorterChat = [SUMMARY, ...story(5, 10)];
        expect(capAutoSyncMarker(registryKey, shorterChat, autoSyncWindow)).toBeUndefined();
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 4 });
        expect(capAutoSyncMarker(registryKey, shorterChat, autoSyncWindow)).toBe(4);
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 7 });
        expect(capAutoSyncMarker(registryKey, shorterChat, autoSyncWindow)).toBe(7);
        // Past the end: to 6, where message 10 sits, the one after the last message read.
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 12 });
        expect(capAutoSyncMarker(registryKey, shorterChat, autoSyncWindow)).toBe(6);
        expect(getAutoSyncMarker(registryKey)).toBe(6);
        // Its latest messages deleted, every message left was read: to the chat's end, so none is read again.
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 12 });
        expect(capAutoSyncMarker(registryKey, story(0, 6), autoSyncWindow)).toBe(7);
        // An end never read, as Keep up from here leaves it: back no further than auto-sync leaves unread while it
        // keeps up, the turn it holds back and a window not yet full.
        writeEventBaseProgress(registryKey, { autoSyncStartMarker: 30 });
        expect(capAutoSyncMarker(registryKey, story(0, 20), autoSyncWindow)).toBe(18);
    });
});

describe('a run on a chat shorter than its tip', () => {
    it('reads the windows the record does not hold instead of recording every window below the tip as read', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 9), chatUUID);
        expect(getVectorizationTip(collectionKeyOf(chatUUID))).toBe(10);
        extractEvents.mockClear();

        // A summary replaces messages 0 to 4, and messages 10 and 11 follow: 8 messages, and a first window never read.
        await vectorize([SUMMARY, ...story(5, 11)], chatUUID);

        // The summary's window and the new messages' are read; the windows of messages read before are not.
        expect(windowsSent()).toEqual([0, 6]);
    });

    it('reads them too once the chat has grown back past the tip, as the record still holds windows', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 9), chatUUID);
        extractEvents.mockClear();

        // A summary replaces messages 0 to 4, and messages 10 to 14 follow: 11 messages, past the tip of 10.
        await vectorize([SUMMARY, ...story(5, 14)], chatUUID);

        expect(windowsSent()).toEqual([0, 6, 8]);
    });

    it('trusts no tip past the chat\'s end when the record was lost, reading every window', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 9), chatUUID);
        // The record is lost, as an import without its pointer leaves it, and the tip stays at 10.
        clearWindowCache(collectionKeyOf(chatUUID));
        extractEvents.mockClear();

        await vectorize([SUMMARY, ...story(5, 11)], chatUUID);

        expect(windowsSent()).toEqual([0, 2, 4, 6]);
    });
});
