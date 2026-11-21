/**
 * A window EventBase extracts again replaces the events it holds, so a chat whose
 * messages changed never holds two versions of the same moment.
 *
 * Drives the real runEventBaseIngestion with the real fingerprint record, tip and
 * window replacement; only ST, the LLM extractor and the vector backend are stubbed.
 * The stub backend keeps its points in `state.points`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    points: [],
    clock: 1000,
    eventCountFor: () => 1,
    listChunks: null,
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'replace-chat', substituteParams: (s) => s,
    saveSettingsDebounced: vi.fn(), getRequestHeaders: () => ({}),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extensionSettings, getContext: () => ({ chat: [] }) }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'replace-uuid', parseRegistryKey: (k) => ({ collectionId: k }),
    COLLECTION_PREFIXES: { VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_', VECTFOX_EVENTBASE: 'vf_eventbase_' },
    buildRegistryKey: (id) => `qdrant:${id}`, buildEventBaseCollectionId: () => 'vf_eventbase_replace', getRegistryBackend: () => 'qdrant',
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
    return {
        extractEvents: vi.fn(async ({ messages, windowStart, windowEnd }) => {
            state.clock += 1000;
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
    getBackend: async () => ({ listChunks: (...args) => state.listChunks(...args) }),
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
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');
const { clearExtractionCaches, markWindowExtracted, setVectorizationTip } = await import('../src/features/eventbase/eventbase-store.js');
const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');
const { deleteVectorItems } = await import('../src/features/vector-backend/vector-api.js');
const { log } = await import('../src/sillytavern/log.js');

const SETTINGS = { eventbase_window_size: 2, eventbase_window_overlap: 0, eventbase_min_importance_store: 1 };

const buildChat = (count) => Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? 'Bot' : 'User', is_user: i % 2 === 1, mes: `message ${i}`,
}));

/** The chat with these messages' text changed, as an edit or a script rewriting old replies leaves it. */
const rewritten = (chat, ...indexes) => chat.map((message, i) => (indexes.includes(i) ? { ...message, mes: `${message.mes}, rewritten` } : message));

/**
 * The chat after its next turn. A run whose last window is already extracted exits at once, so a
 * rewritten window is read again when a later turn comes, as it is in play.
 */
const withNextTurn = chat => [...chat, ...buildChat(chat.length + 2).slice(chat.length)];

let chatNumber = 0;
const newChatUUID = () => `replace-uuid-${++chatNumber}`;
/** Each chat reads into a collection of its own, so no test sees another's pointer. */
const collectionIdOf = chatUUID => `vf_eventbase_replace_${chatUUID}`;
const collectionKeyOf = chatUUID => `qdrant:${collectionIdOf(chatUUID)}`;

const run = (messages, chatUUID, options = {}) => runEventBaseIngestion({
    messages, chatUUID, settings: SETTINGS, isAutoSync: false, parallelWindows: 8,
    collectionIdOverride: collectionIdOf(chatUUID), ...options,
});

const listedPoints = () => ({ items: state.points.map(point => ({ hash: point.hash, text: point.text, metadata: point.metadata })) });

/** Each window's extraction calls, as the times its stored events were written. */
const callsByWindow = () => {
    const calls = {};
    for (const { metadata } of state.points) {
        calls[metadata.source_window_start] ??= new Set();
        calls[metadata.source_window_start].add(metadata.created_at);
    }
    return Object.fromEntries(Object.entries(calls).map(([start, times]) => [start, times.size]));
};

const eventIdsOfWindow = windowStart => state.points
    .filter(point => point.metadata.source_window_start === windowStart)
    .map(point => point.metadata.event_id);

describe('a window extracted again', () => {
    beforeEach(() => {
        globalThis.toastr = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
        state.points = [];
        state.clock = 1000;
        state.eventCountFor = () => 1;
        state.listChunks = vi.fn(async () => listedPoints());
        state.extensionSettings.vectfox = {};
        vi.mocked(deleteVectorItems).mockClear();
        vi.mocked(log.warn).mockClear();
    });

    it('replaces the events of a window whose reply was rewritten, and no others', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        state.eventCountFor = start => (start === 2 ? 2 : 1);
        await run(chat, chatUUID);
        const firstEventsOfWindow2 = eventIdsOfWindow(2);
        const otherEvents = [...eventIdsOfWindow(0), ...eventIdsOfWindow(4)];

        state.eventCountFor = () => 1;
        const result = await run(withNextTurn(rewritten(chat, 2)), chatUUID);

        expect(result.eventsExtracted).toBe(2);
        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1 });
        expect(eventIdsOfWindow(2)).toHaveLength(1);
        expect(firstEventsOfWindow2).not.toContain(eventIdsOfWindow(2)[0]);
        expect([...eventIdsOfWindow(0), ...eventIdsOfWindow(4)]).toEqual(otherEvents);
    });

    it('leaves one version of each window when the chat is read again from the start', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);

        clearExtractionCaches(collectionKeyOf(chatUUID));
        await run(chat, chatUUID, { skipTipFallback: true });

        expect(state.points).toHaveLength(3);
        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1 });
    });

    it('replaces the windows a run from a later message reads again, and keeps the ones before it, even where a reply repeated word for word matches', async () => {
        const chatUUID = newChatUUID();
        // Every user reply is the same words, so it hashes the same wherever it sits.
        const chat = buildChat(8).map(message => (message.is_user ? { ...message, mes: 'Go on.' } : message));
        await run(chat, chatUUID);
        const firstEventsOfWindow0 = eventIdsOfWindow(0);

        clearExtractionCaches(collectionKeyOf(chatUUID));
        await run(chat, chatUUID, { skipTipFallback: true, startFromMessage: 3 });

        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1 });
        expect(eventIdsOfWindow(0)).toEqual(firstEventsOfWindow0);
    });

    it('keeps a window\'s earlier events when its new reading finds none', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);
        const firstEventsOfWindow2 = eventIdsOfWindow(2);

        // Window 4 is read again too, so the run reads the collection and removes window 4's earlier event.
        state.eventCountFor = start => (start === 2 ? 0 : 1);
        await run(withNextTurn(rewritten(chat, 2, 4)), chatUUID);

        expect(eventIdsOfWindow(2)).toEqual(firstEventsOfWindow2);
        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1 });
        expect(deleteVectorItems).toHaveBeenCalledTimes(1);
    });

    it('moves a StoryArc link off the replaced event to the event that replaced it', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);
        const [replacedId] = eventIdsOfWindow(2);
        const linker = state.points.find(point => point.metadata.source_window_start === 4);
        linker.metadata.story_links = [{ event_id: replacedId, type: 'continues', thread: '' }];

        await run(withNextTurn(rewritten(chat, 2)), chatUUID);

        const [replacementId] = eventIdsOfWindow(2);
        expect(replacementId).not.toBe(replacedId);
        expect(linker.metadata.story_links).toEqual([{ event_id: replacementId, type: 'continues', thread: '' }]);
    });

    it('reads nothing more when the run extracts only the window after the newest, as an ordinary turn does', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(4);
        await run(chat, chatUUID);
        state.listChunks.mockClear();

        await run(buildChat(6), chatUUID);

        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1 });
        expect(state.listChunks).not.toHaveBeenCalled();
    });

    it('replaces windows an older settings file made it forget, across batches', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);
        // A tab left open saves the settings file it loaded, whose record and tip end at window 0.
        clearExtractionCaches(collectionKeyOf(chatUUID));
        markWindowExtracted(chat.slice(0, 2).map(hashSourceMessage), collectionKeyOf(chatUUID));
        setVectorizationTip(collectionKeyOf(chatUUID), 2);

        // One window per batch: window 2 sits at that tip, and only window 4 shows the run reads windows again.
        await run(withNextTurn(chat), chatUUID, { parallelWindows: 1 });

        expect(callsByWindow()).toEqual({ 0: 1, 2: 1, 4: 1, 6: 1 });
    });

    it('keeps both versions, and says so, when the earlier events cannot be removed', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);
        vi.mocked(deleteVectorItems).mockRejectedValueOnce(new Error('Qdrant refused the delete'));

        const result = await run(withNextTurn(rewritten(chat, 2)), chatUUID);

        expect(result.eventsExtracted).toBe(2);
        expect(callsByWindow()).toEqual({ 0: 1, 2: 2, 4: 1, 6: 1 });
        expect(log.warn.mock.calls.some(([message]) => String(message).includes('keep both versions'))).toBe(true);
    });

    it('keeps both versions, and says so, when the collection cannot be read', async () => {
        const chatUUID = newChatUUID();
        const chat = buildChat(6);
        await run(chat, chatUUID);
        state.listChunks = vi.fn(async () => { throw new Error('Qdrant is unreachable'); });

        const result = await run(withNextTurn(rewritten(chat, 2)), chatUUID);

        expect(result.eventsExtracted).toBe(2);
        expect(callsByWindow()).toEqual({ 0: 1, 2: 2, 4: 1, 6: 1 });
        expect(log.warn.mock.calls.some(([message]) => String(message).includes('keep both versions'))).toBe(true);
    });
});
