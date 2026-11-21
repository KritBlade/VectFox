/**
 * A run from a later message numbers its windows from the chat's first message and starts at the
 * window that holds that message, so its events, the tip and the records mean what a whole-chat
 * run's do.
 *
 * Drives the real runEventBaseIngestion with the real fingerprint record, unfinished record and
 * tip; only ST, the LLM extractor and the vector backend are stubbed. The stub backend keeps its
 * points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    clock: 1000,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'start-from-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'start-from-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_start_from', getRegistryBackend: () => 'qdrant',
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
// The chat's collections: the run's collection is put in use in the chat (eventbase-collection-in-use.test.js holds the rule).
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', async () => {
    const { setCollectionMeta } = await import('../src/features/collections/collection-metadata.js');
    return {
        collectionInUse: () => ({ collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] }),
        noCollectionInUseText: () => null, resolveEventBaseRunTarget: () => null,
        sharedCollectionsLockedHere: () => ({ otherChats: [], archives: [] }),
        // In use in the chat: scoped to chats, as the real one leaves it.
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
// The real records, where each collection keeps its pointer; locks and pauses are left out.
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
const { clearWindowCache, getUnfinishedWindowFingerprints, getVectorizationTip, markWindowUnfinished, windowFingerprint } = await import('../src/features/eventbase/eventbase-store.js');
const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');
const { progressTracker } = await import('../src/shared/progress-tracker.js');

const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1 };

const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'Bot' : 'User', is_user: i % 2 === 1, mes: `message ${i}`,
}));

let chatNumber = 0;
const newChatUUID = () => `start-from-uuid-${++chatNumber}`;
/** Each chat reads into a collection of its own, so no test sees another's pointer. */
const collectionIdOf = chatUUID => `vf_eventbase_start_from_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const run = (messages, chatUUID, options = {}) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8,
    collectionIdOverride: collectionIdOf(chatUUID), ...options,
});

/** The first message of each window sent to the extractor, counted from 0. */
const windowsSent = () => extractEvents.mock.calls.map(([{ windowStart }]) => windowStart).sort((a, b) => a - b);

describe('a run from a later message', () => {
    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points = [];
        state.clock = 1000;
        state.extensionSettings.vectfox = {};
        vi.clearAllMocks();
    });

    it('numbers its windows from the chat and starts at the window that holds the message', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(8);

        await run(chat, chatUUID, { startFromMessage: 4 });

        expect(windowsSent()).toEqual([2, 4, 6]);
        const eventOfWindow2 = state.points.find(point => point.metadata.source_window_start === 2).metadata;
        expect(eventOfWindow2.source_message_hashes).toEqual(chat.slice(2, 4).map(hashSourceMessage));
        expect(getVectorizationTip(collectionKeyOf(chatUUID))).toBe(8);
    });

    it('skips by the tip only the windows before it', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(10);
        await run(chat.slice(0, 6), chatUUID);
        // The record is lost, as an older settings file can lose it, and the tip stays at message 6.
        clearWindowCache(collectionKeyOf(chatUUID));
        extractEvents.mockClear();

        await run(chat, chatUUID, { startFromMessage: 3 });

        expect(windowsSent()).toEqual([6, 8]);
    });

    it('keeps the unfinished windows before the message on record', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(8);
        const firstWindowHashes = chat.slice(0, 2).map(hashSourceMessage);
        markWindowUnfinished(firstWindowHashes, collectionKeyOf(chatUUID));

        await run(chat, chatUUID, { startFromMessage: 3 });

        expect(windowsSent()).toEqual([2, 4, 6]);
        expect(getUnfinishedWindowFingerprints(collectionKeyOf(chatUUID), 2)).toEqual(new Set([windowFingerprint(firstWindowHashes)]));
    });

    it('counts its chunk progress from the chat\'s first message, as the planned chunks are', async () => {
        const chatUUID = newChatUUID();

        await run(buildChat(8), chatUUID, { startFromMessage: 5, progressPlan: { strategy: 'per_message', batchSize: 1, totalChunks: 8 } });

        expect(progressTracker.updateEmbeddingProgress).toHaveBeenLastCalledWith(8, 8);
    });
});
