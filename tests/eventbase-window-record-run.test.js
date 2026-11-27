/**
 * A run on a window record that keeps only what its collection cannot show (InternalProject/Vectfox/plans/
 * eventbase-window-record.md): once trimmed, a run reads no window the events show; it stops before reading when the
 * record was trimmed and the events cannot be read, and goes on with the record alone when it never was; a window whose
 * only event was removed stays read.
 *
 * Drives the real runEventBaseIngestion with the real window record and the windows its events show; only ST, the LLM
 * extractor and the vector backend are stubbed. The stub backend keeps its points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    clock: 1000,
    // The open chat, which story order reads (src/shared/chat-messages.js).
    chat: [],
    isListingRefused: false,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'record-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: state.chat, chatMetadata: {} }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'record-chat-uuid',
    parseRegistryKey: (k) => (k.includes(':') ? { backend: k.slice(0, k.indexOf(':')), collectionId: k.slice(k.indexOf(':') + 1) } : { backend: '', collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_record_chat', getRegistryBackend: () => 'qdrant',
    parseCollectionId: () => ({ scope: 'chat' }),
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    getCollectionRegistry: () => [], registerCollection: vi.fn(), getCollectionListing: vi.fn(),
    collectionNameOf: registryKey => `💬 Chat: ${registryKey.split('_').pop()}`,
}));
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
    getBackend: async () => ({ listChunks: async () => {
        if (state.isListingRefused) throw new Error('Qdrant is not answering');
        return { items: state.points.map(point => ({ hash: point.hash, text: point.text, metadata: point.metadata })) };
    } }),
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

const { runEventBaseIngestion, EVENT_WINDOWS_UNREAD } = await import('../src/features/eventbase/eventbase-workflow.js');
const { clearCachesForDeletedOrImportedCollection, keepWindowsOfRemovedEvents, loadEventWindows, readEventBaseProgress } = await import('../src/features/eventbase/eventbase-store.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');

const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1 };

/** Messages `from` to `to` of the story, inclusive. */
const story = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    name: (from + i) % 2 === 0 ? 'Bot' : 'User', is_user: (from + i) % 2 === 1, mes: `message ${from + i}`,
}));

let chatNumber = 0;
const newChatUUID = () => `record-chat-uuid-${++chatNumber}`;
const collectionIdOf = chatUUID => `vf_eventbase_record_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const vectorize = (messages, chatUUID) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8, collectionIdOverride: collectionIdOf(chatUUID),
});

/** The first message of each window sent to the extractor, counted from 0. */
const windowsSent = () => extractEvents.mock.calls.map(([{ windowStart }]) => windowStart).sort((a, b) => a - b);

/** As after a page reload: what is in memory of the collection's events is gone, and the next load reads them. */
const reload = chatUUID => clearCachesForDeletedOrImportedCollection(collectionIdOf(chatUUID));

beforeEach(() => {
    globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
    state.points = [];
    state.clock = 1000;
    state.extensionSettings.vectfox = {};
    state.chat = [];
    state.isListingRefused = false;
    vi.clearAllMocks();
});

describe('a run on a record trimmed to what its events cannot show', () => {
    it('reads nothing again: the events show the windows the record dropped', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 5), chatUUID);
        expect(readEventBaseProgress(collectionKeyOf(chatUUID)).extractedWindows).toHaveLength(3);

        reload(chatUUID);
        await loadEventWindows(collectionKeyOf(chatUUID), SETTINGS);
        expect(readEventBaseProgress(collectionKeyOf(chatUUID))).toMatchObject({ isTrimmed: true });
        expect(readEventBaseProgress(collectionKeyOf(chatUUID)).extractedWindows).toBeUndefined();
        extractEvents.mockClear();

        reload(chatUUID);
        await vectorize(story(0, 7), chatUUID);
        expect(windowsSent()).toEqual([6]);
    });

    it('stops before reading when the events cannot be read, and sends no window', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 5), chatUUID);
        reload(chatUUID);
        await loadEventWindows(collectionKeyOf(chatUUID), SETTINGS);
        extractEvents.mockClear();

        reload(chatUUID);
        state.isListingRefused = true;
        const stop = await vectorize(story(0, 7), chatUUID).catch(error => error);
        expect(stop).toMatchObject({ code: EVENT_WINDOWS_UNREAD });
        expect(extractEvents).not.toHaveBeenCalled();
        // The user reads the collection by its name; the database's own words are kept for the console.
        expect(stop.message).toContain(`"💬 Chat: ${chatUUID.split('_').pop()}"`);
        expect(stop.message).not.toContain(collectionIdOf(chatUUID));
        expect(stop.message).not.toContain('Qdrant is not answering');
        expect(stop.problem).toContain('Qdrant is not answering');
    });

    it('goes on with the record alone when it was never trimmed, as the record holds every window read', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 3), chatUUID);
        extractEvents.mockClear();

        reload(chatUUID);
        state.isListingRefused = true;
        await vectorize(story(0, 5), chatUUID);
        expect(windowsSent()).toEqual([4]);
    });

    it('keeps a window read after its only event is removed, so the next run does not write it again', async () => {
        const chatUUID = newChatUUID();
        await vectorize(story(0, 5), chatUUID);
        reload(chatUUID);
        await loadEventWindows(collectionKeyOf(chatUUID), SETTINGS);
        const removed = state.points.filter(point => point.metadata.source_window_start === 0);
        state.points = state.points.filter(point => !removed.includes(point));
        keepWindowsOfRemovedEvents(collectionIdOf(chatUUID), removed.map(point => point.metadata), SETTINGS);
        extractEvents.mockClear();

        reload(chatUUID);
        await vectorize(story(0, 5), chatUUID);
        expect(windowsSent()).toEqual([]);
    });
});
