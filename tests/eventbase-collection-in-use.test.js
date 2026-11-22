/**
 * @vitest-environment jsdom
 *
 * A chat's own EventBase collections and the one it uses (src/features/eventbase/eventbase-chat-collections.js, §2.2 and
 * D18 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): the one route every reader and writer asks,
 * collectionInUse, and why a chat has none in use; its words and its red toast; which collections are the chat's own
 * and listed; the collections of other chats and chat files locked in beside them; the one lock function, which locks
 * the one chosen and unlocks the chat's other own collections on every backend and under every persona, never another
 * chat's or an archive; the Database Browser's lock; the run target, which writes nothing while the chat has collections
 * but none in use; the question asked then, with New collection where a run can make one; and New collection's ID, name
 * and window size (§2.5).
 *
 * The collections feature is an in-memory registry with its locks, scopes, pauses, owners, names and auto-sync switches,
 * a collection with no name taking the chat's automatic one; a lock counts as the Database Browser's Active here does,
 * a chat lock on a collection scoped to characters counting for nothing; collection IDs are parsed and built by the real
 * collection-ids.js; the store's lookup reads that registry.
 */
/* global document, toastr -- this file runs under the jsdom environment; toastr is stubbed per test */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CHAT_ID = 'Harbor Keeper - 2026-11-20';
const FIRST = `qdrant:vf_eventbase_qdrant_wren_harbor_keeper_${CHAT_UUID}`;
const LATER = `qdrant:vf_eventbase_qdrant_wren_harbor_keeper_${CHAT_UUID}_mh3k2x1a`;
const OTHER_PERSONA = `qdrant:vf_eventbase_qdrant_orrin_harbor_keeper_${CHAT_UUID}`;
const OTHER_BACKEND = `vectra:vf_eventbase_standard_wren_harbor_keeper_${CHAT_UUID}`;
const OTHER_CHAT = `qdrant:vf_eventbase_qdrant_wren_harbor_keeper_${OTHER_UUID}`;
const ARCHIVE = `qdrant:vf_archiveevent_qdrant_wren_harbor_keeper_${CHAT_UUID}`;
/** The name a collection of the chat has with no record naming it: its first's automatic name. */
const AUTOMATIC_NAME = '💬 Chat: Harbor Keeper';
const CHOOSE_ONE = 'Choose one in Collection in use here, on the AutoSync page.';

const host = vi.hoisted(() => ({
    chatId: null, chatUUID: null, registry: [], locks: new Map(), scopes: new Map(), autoSync: new Set(), owners: new Map(),
    names: new Map(), paused: new Set(), answer: true, chosenKey: null,
}));

vi.mock('../src/sillytavern/chat.js', () => ({
    getCurrentChatId: () => host.chatId,
    getContext: () => ({ name1: 'Wren', name2: 'Harbor Keeper' }),
    chat_metadata: { get integrity() { return host.chatUUID; } },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), warn: vi.fn(), verbose: vi.fn(), trace: vi.fn(), enabled: () => false } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // The question: the user picks host.chosenKey in its dropdown, then Use, or Cancel.
    formPopup: vi.fn(async (lines, form) => {
        document.body.append(form);
        if (host.chosenKey) form.querySelector('select').value = host.chosenKey;
        form.remove();
        return host.answer;
    }),
}));
vi.mock('../src/features/collections/index.js', async () => {
    const { parseRegistryKey } = await import('../src/shared/collection-ids.js');
    const locksOf = key => host.locks.get(key) ?? [];
    return {
        getCollectionListing: () => host.registry.map(registryKey => {
            const { collectionId, backend } = parseRegistryKey(registryKey);
            return { registryKey, collectionId, backend, isOwn: host.owners.get(registryKey) !== false };
        }),
        getCollectionRegistry: () => host.registry,
        registerCollection: vi.fn((key) => { if (!host.registry.includes(key)) host.registry.push(key); }),
        getCollectionLocks: locksOf,
        // As the Database Browser's Active here: a chat lock counts on a collection scoped to chats.
        isCollectionActiveForContextAnyKey: (keys, { chatId }) => keys.some(key => key && host.scopes.get(key) !== 'character' && locksOf(key).includes(chatId)),
        isCollectionEnabled: key => !host.paused.has(key),
        setCollectionLock: vi.fn((key, chatId) => host.locks.set(key, [...new Set([...locksOf(key), chatId])])),
        removeCollectionLock: vi.fn((key, chatId) => host.locks.set(key, locksOf(key).filter(id => id !== chatId))),
        setCollectionMeta: vi.fn((key, fields) => {
            if (fields.scope) host.scopes.set(key, fields.scope);
            if (fields.displayName) host.names.set(key, fields.displayName);
        }),
        isCollectionAutoSyncEnabled: key => host.autoSync.has(key),
        collectionNameOf: key => host.names.get(key) ?? AUTOMATIC_NAME,
    };
});
vi.mock('../src/features/eventbase/eventbase-store.js', async () => {
    const { COLLECTION_PREFIXES, parseCollectionId, parseRegistryKey } = await import('../src/shared/collection-ids.js');
    return {
        // Every EventBase collection of the chat in the registry, as the real one finds them.
        findEventBaseCollectionsForChat: uuid => host.registry
            .map(registryKey => ({ registryKey, ...parseRegistryKey(registryKey) }))
            .filter(({ collectionId }) => collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) && parseCollectionId(collectionId).chatUUID === uuid)
            .map(({ registryKey, collectionId, backend }) => ({ registryKey, collectionId, backend })),
        setCollectionWindowSize: vi.fn(),
    };
});

const chatCollections = await import('../src/features/eventbase/eventbase-chat-collections.js');
const collections = await import('../src/features/collections/index.js');
const store = await import('../src/features/eventbase/eventbase-store.js');
const { formPopup } = await import('../src/sillytavern/popup.js');
const SETTINGS = { vector_backend: 'qdrant' };
const lockedHere = () => host.registry.filter(key => (host.locks.get(key) ?? []).includes(CHAT_ID));
const { NOT_IN_USE_REASON } = chatCollections;

/** A collection as the route gives it. */
const listed = (registryKey, fields = {}) => ({
    registryKey,
    collectionId: registryKey.slice(registryKey.indexOf(':') + 1),
    backend: registryKey.slice(0, registryKey.indexOf(':')),
    name: host.names.get(registryKey) ?? AUTOMATIC_NAME,
    isLockedHere: false,
    isPaused: false,
    isAutoSyncOn: false,
    ...fields,
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('toastr', { warning: vi.fn(), error: vi.fn() });
    Object.assign(host, { chatId: CHAT_ID, chatUUID: CHAT_UUID, answer: true, chosenKey: null });
    host.registry = [FIRST, LATER, OTHER_PERSONA, OTHER_BACKEND, OTHER_CHAT, ARCHIVE];
    host.locks = new Map();
    host.scopes = new Map();
    host.autoSync = new Set();
    host.paused = new Set();
    host.owners = new Map([[OTHER_PERSONA, false]]);
    host.names = new Map([[FIRST, AUTOMATIC_NAME], [LATER, 'Harbor Keeper 2']]);
});

describe("a chat's own collections", () => {
    it('lists those of this persona on the current backend, by name, with which is locked here, paused and has auto-sync on', () => {
        host.locks.set(LATER, [CHAT_ID]);
        host.autoSync.add(FIRST);
        host.paused.add(FIRST);
        expect(chatCollections.chatOwnCollections(SETTINGS)).toEqual([
            listed(FIRST, { isPaused: true, isAutoSyncOn: true }),
            listed(LATER, { isLockedHere: true }),
        ]);
    });

    it("lists another persona's collection of the chat only while it is locked here", () => {
        host.locks.set(OTHER_PERSONA, [CHAT_ID]);
        expect(chatCollections.chatOwnCollections(SETTINGS).map(collection => collection.registryKey)).toEqual([FIRST, LATER, OTHER_PERSONA]);
    });

    it('lists none with no chat open', () => {
        host.chatUUID = null;
        host.chatId = null;
        expect(chatCollections.chatOwnCollections(SETTINGS)).toEqual([]);
    });
});

describe('the collection in use, the one route every reader and writer asks', () => {
    it('is the chat\'s own collection locked to it on the current backend, paused or not', () => {
        host.locks.set(LATER, [CHAT_ID]);
        host.paused.add(LATER);
        expect(chatCollections.collectionInUse(SETTINGS)).toEqual({
            collection: listed(LATER, { isLockedHere: true, isPaused: true }),
            reason: null,
            collections: [listed(FIRST), listed(LATER, { isLockedHere: true, isPaused: true })],
            lockedElsewhere: [],
            backend: 'qdrant',
        });
    });

    it('is none, never the first, while the chat has collections and none is locked to it', () => {
        const inUse = chatCollections.collectionInUse(SETTINGS);
        expect(inUse.collection).toBeNull();
        expect(inUse.reason).toBe(NOT_IN_USE_REASON.NONE_IN_USE);
        expect(inUse.collections.map(collection => collection.registryKey)).toEqual([FIRST, LATER]);
    });

    it('is none while several are locked to it, as locks saved before one in use was kept can be', () => {
        host.locks.set(FIRST, [CHAT_ID]);
        host.locks.set(LATER, [CHAT_ID]);
        const inUse = chatCollections.collectionInUse(SETTINGS);
        expect(inUse.collection).toBeNull();
        expect(inUse.reason).toBe(NOT_IN_USE_REASON.SEVERAL_IN_USE);
    });

    it('is none while the one locked here was made on the other backend, which it names', () => {
        host.locks.set(OTHER_BACKEND, [CHAT_ID]);
        const inUse = chatCollections.collectionInUse(SETTINGS);
        expect(inUse.collection).toBeNull();
        expect(inUse.reason).toBe(NOT_IN_USE_REASON.OTHER_BACKEND);
        expect(inUse.lockedElsewhere).toEqual([listed(OTHER_BACKEND, { isLockedHere: true })]);
    });

    it('counts a chat lock on a collection scoped to characters for nothing, as the Database Browser does', () => {
        host.locks.set(FIRST, [CHAT_ID]);
        host.scopes.set(FIRST, 'character');
        expect(chatCollections.collectionInUse(SETTINGS).reason).toBe(NOT_IN_USE_REASON.NONE_IN_USE);
    });

    it("is the chat's own, never another chat's collection locked here beside it, whatever the registry order", () => {
        host.registry = [OTHER_CHAT, FIRST];
        host.locks.set(OTHER_CHAT, [CHAT_ID]);
        host.locks.set(FIRST, [CHAT_ID]);
        expect(chatCollections.collectionInUse(SETTINGS).collection?.registryKey).toBe(FIRST);
        host.locks.set(FIRST, []);
        expect(chatCollections.collectionInUse(SETTINGS)).toMatchObject({ collection: null, reason: NOT_IN_USE_REASON.NONE_IN_USE });
    });

    it('is the one on the current backend while one on each backend is locked here', () => {
        host.locks.set(OTHER_BACKEND, [CHAT_ID]);
        host.locks.set(FIRST, [CHAT_ID]);
        expect(chatCollections.collectionInUse(SETTINGS)).toMatchObject({ collection: { registryKey: FIRST }, reason: null });
        expect(chatCollections.collectionInUse({ vector_backend: 'standard' })).toMatchObject({ collection: { registryKey: OTHER_BACKEND }, reason: null });
    });

    it("is another persona's collection of the chat once it is locked here", () => {
        host.locks.set(OTHER_PERSONA, [CHAT_ID]);
        expect(chatCollections.collectionInUse(SETTINGS).collection?.registryKey).toBe(OTHER_PERSONA);
    });

    it('is no collection for a chat with none of its own here, and no chat with none open', () => {
        host.registry = [OTHER_CHAT, ARCHIVE];
        host.locks.set(OTHER_CHAT, [CHAT_ID]);
        expect(chatCollections.collectionInUse(SETTINGS)).toMatchObject({ collection: null, reason: NOT_IN_USE_REASON.NO_COLLECTION, collections: [] });
        host.chatId = null;
        expect(chatCollections.collectionInUse(SETTINGS)).toMatchObject({ collection: null, reason: NOT_IN_USE_REASON.NO_CHAT });
    });

    it('reads no lock of the open chat for another chat', () => {
        host.locks.set(OTHER_CHAT, [CHAT_ID]);
        expect(chatCollections.collectionInUse(SETTINGS, { chatUUID: OTHER_UUID }).reason).toBe(NOT_IN_USE_REASON.NO_CHAT);
    });
});

describe('the words for a chat with no collection in use', () => {
    const WHY = 'this reply read none of its events: retrieval';

    it('says why and where to choose, for each reason', () => {
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY))
            .toBe(`No collection is in use in this chat, so ${WHY}. ${CHOOSE_ONE}`);
        host.locks.set(FIRST, [CHAT_ID]);
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY))
            .toBe(`"${AUTOMATIC_NAME}" and "Harbor Keeper 2" are both locked to this chat, which uses one at a time, so ${WHY}. ${CHOOSE_ONE}`);
        host.locks.set(OTHER_PERSONA, [CHAT_ID]);
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY))
            .toBe(`"${AUTOMATIC_NAME}", "Harbor Keeper 2", and "${AUTOMATIC_NAME}" are all locked to this chat, which uses one at a time, so ${WHY}. ${CHOOSE_ONE}`);
        host.locks.clear();
        host.locks.set(OTHER_BACKEND, [CHAT_ID]);
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY))
            .toBe(`"${AUTOMATIC_NAME}", in use in this chat, is on Standard, and VectFox uses Qdrant now, so ${WHY}. ${CHOOSE_ONE}`);
        host.registry = [OTHER_BACKEND];
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY))
            .toMatch(/, so this reply read none of its events: retrieval\. Switch back on the Core page, or vectorize this chat here\.$/u);
    });

    it('leaves out where to choose for a question that asks it, and has no words with nothing to choose', () => {
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), 'EventBase reads nothing', { isWhereToChooseSaid: false }))
            .toBe('No collection is in use in this chat, so EventBase reads nothing.');
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY)).toBeNull();
        host.registry = [OTHER_CHAT];
        expect(chatCollections.noCollectionInUseText(chatCollections.collectionInUse(SETTINGS), WHY)).toBeNull();
    });

    it('says it in red, one toast standing while it shows, and nothing for a chat with one in use or none to choose', () => {
        expect(chatCollections.showNoCollectionInUse(chatCollections.collectionInUse(SETTINGS), 'auto-sync wrote nothing for this message')).toBe(true);
        expect(toastr.error).toHaveBeenCalledWith(
            `No collection is in use in this chat, so auto-sync wrote nothing for this message. ${CHOOSE_ONE}`,
            'EventBase',
            { timeOut: 15000, extendedTimeOut: 10000, preventDuplicates: true },
        );
        host.locks.set(FIRST, [CHAT_ID]);
        expect(chatCollections.showNoCollectionInUse(chatCollections.collectionInUse(SETTINGS), 'x')).toBe(false);
        host.registry = [OTHER_CHAT];
        expect(chatCollections.showNoCollectionInUse(chatCollections.collectionInUse(SETTINGS), 'x')).toBe(false);
        expect(toastr.error).toHaveBeenCalledTimes(1);
        expect(toastr.warning).not.toHaveBeenCalled();
    });
});

describe('the collections locked in beside the chat\'s own', () => {
    it("are other chats' collections and chat files locked here, each with its pause, never the chat's own", () => {
        for (const key of [FIRST, OTHER_CHAT, ARCHIVE]) host.locks.set(key, [CHAT_ID]);
        host.paused.add(OTHER_CHAT);
        expect(chatCollections.sharedCollectionsLockedHere()).toEqual({
            otherChats: [{ registryKey: OTHER_CHAT, collectionId: OTHER_CHAT.slice(7), isPaused: true }],
            archives: [{ registryKey: ARCHIVE, collectionId: ARCHIVE.slice(7), isPaused: false }],
        });
    });

    it('are none with no chat open', () => {
        host.locks.set(OTHER_CHAT, [CHAT_ID]);
        host.chatId = null;
        expect(chatCollections.sharedCollectionsLockedHere()).toEqual({ otherChats: [], archives: [] });
    });
});

describe('one collection in use per chat', () => {
    it("locks the one chosen, scoped to chats, and unlocks the chat's other own collections on every backend and persona", () => {
        for (const key of [FIRST, OTHER_PERSONA, OTHER_BACKEND, OTHER_CHAT, ARCHIVE]) host.locks.set(key, [CHAT_ID]);
        const updated = vi.fn();
        document.addEventListener('vectfox:collections-updated', updated);
        expect(chatCollections.useChatCollection(LATER)).toEqual({ lockedKeys: [LATER], unlockedKeys: [FIRST, OTHER_PERSONA, OTHER_BACKEND] });
        expect(lockedHere()).toEqual([LATER, OTHER_CHAT, ARCHIVE]);
        expect(host.scopes.get(LATER)).toBe('chat');
        expect(updated).toHaveBeenCalledTimes(1);
        document.removeEventListener('vectfox:collections-updated', updated);
    });

    it('changes nothing for the one already in use alone, nor with no chat open', () => {
        host.locks.set(FIRST, [CHAT_ID]);
        expect(chatCollections.useChatCollection(FIRST)).toEqual({ lockedKeys: [], unlockedKeys: [] });
        host.chatId = null;
        expect(chatCollections.useChatCollection(LATER)).toEqual({ lockedKeys: [], unlockedKeys: [] });
        expect(collections.setCollectionLock).not.toHaveBeenCalled();
    });

    it('locks a collection the registry does not list yet, as a first read does before it registers', () => {
        host.registry = [FIRST];
        host.locks.set(FIRST, [CHAT_ID]);
        expect(chatCollections.useChatCollection(LATER)).toEqual({ lockedKeys: [LATER], unlockedKeys: [FIRST] });
    });

    it("locks another chat's collection or an archive from the Database Browser beside the one in use, and puts an own one in use", () => {
        host.locks.set(FIRST, [CHAT_ID]);
        chatCollections.lockCollectionToOpenChat(OTHER_CHAT);
        chatCollections.lockCollectionToOpenChat(ARCHIVE);
        expect(lockedHere()).toEqual([FIRST, OTHER_CHAT, ARCHIVE]);
        chatCollections.lockCollectionToOpenChat(LATER);
        expect(lockedHere()).toEqual([LATER, OTHER_CHAT, ARCHIVE]);
    });
});

describe('the collection a run reads into', () => {
    it('is the one in use; none while the chat has collections but none in use; the first, built, for a chat with none', () => {
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toEqual({ registryKey: LATER, collectionId: LATER.slice(7) });
        host.locks.clear();
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toBeNull();
        host.locks.set(FIRST, [CHAT_ID]);
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toBeNull();
        host.registry = [OTHER_CHAT];
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toEqual({ registryKey: FIRST, collectionId: FIRST.slice(7) });
    });

    it('is the first here when the chat has collections only on the other backend', () => {
        host.registry = [OTHER_BACKEND];
        host.locks.set(OTHER_BACKEND, [CHAT_ID]);
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toEqual({ registryKey: FIRST, collectionId: FIRST.slice(7) });
    });
});

describe('the question asked while none is in use', () => {
    it("lists the chat's own collections, puts the one chosen in use, and answers its key", async () => {
        host.chosenKey = LATER;
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBe(LATER);
        const [lines, form, options] = formPopup.mock.calls[0];
        expect(lines[1]).toEqual({ text: 'No collection is in use in this chat, so EventBase reads and writes nothing here.' });
        expect([...form.querySelectorAll('option')].map(option => [option.value, option.textContent])).toEqual([
            [FIRST, '💬 Chat: Harbor Keeper'], [LATER, 'Harbor Keeper 2'],
        ]);
        expect(options).toMatchObject({ okButton: 'Use' });
        expect(lockedHere()).toEqual([LATER]);
    });

    it('asks while several are locked here, rather than taking the first, and leaves the one chosen alone in use', async () => {
        host.locks.set(FIRST, [CHAT_ID]);
        host.locks.set(LATER, [CHAT_ID]);
        host.chosenKey = LATER;
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBe(LATER);
        expect(formPopup).toHaveBeenCalledTimes(1);
        expect(lockedHere()).toEqual([LATER]);
    });

    it('locks nothing on Cancel, and asks nothing with one in use or none to choose', async () => {
        host.answer = false;
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBeNull();
        expect(lockedHere()).toEqual([]);

        host.locks.set(FIRST, [CHAT_ID]);
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBe(FIRST);
        host.registry = [OTHER_CHAT];
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBeNull();
        expect(formPopup).toHaveBeenCalledTimes(1);
    });

    it('offers New collection last where a run can make one, answering it and locking nothing', async () => {
        host.chosenKey = chatCollections.NEW_COLLECTION;
        expect(await chatCollections.askWhichChatCollection(SETTINGS, { canMakeNew: true })).toBe(chatCollections.NEW_COLLECTION);
        const [, form] = formPopup.mock.calls[0];
        expect([...form.querySelectorAll('option')].map(option => [option.value, option.textContent])).toEqual([
            [FIRST, AUTOMATIC_NAME], [LATER, 'Harbor Keeper 2'], [chatCollections.NEW_COLLECTION, 'New collection'],
        ]);
        expect(lockedHere()).toEqual([]);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });
});

describe('New collection', () => {
    const NOW = 1_700_000_000_000;
    const keyAt = time => `${FIRST}_${time.toString(36)}`;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        return () => vi.useRealTimers();
    });

    it("is the chat's first ID with the time it was made in base 36, named as its first with the lowest number its collections leave, at the window size given, scoped to chats and listed", () => {
        host.names.set(LATER, `${AUTOMATIC_NAME} 2`);
        expect(chatCollections.startNewChatCollection(SETTINGS, { windowSize: 4 })).toEqual({
            registryKey: keyAt(NOW), collectionId: keyAt(NOW).slice(7), name: `${AUTOMATIC_NAME} 3`,
        });
        expect(collections.setCollectionMeta).toHaveBeenCalledWith(keyAt(NOW), { displayName: `${AUTOMATIC_NAME} 3`, scope: 'chat' });
        expect(store.setCollectionWindowSize).toHaveBeenCalledWith(keyAt(NOW), 4);
        expect(host.registry).toContain(keyAt(NOW));
        expect(lockedHere()).toEqual([]);
    });

    it('never makes an ID twice, and takes a number again once a rename freed it', () => {
        host.registry.push(keyAt(NOW));
        host.names.set(keyAt(NOW), `${AUTOMATIC_NAME} 3`);
        const made = chatCollections.startNewChatCollection(SETTINGS, { windowSize: 2 });
        expect(made.registryKey).toBe(keyAt(NOW + 1));
        expect(made.name).toBe(`${AUTOMATIC_NAME} 2`);
    });

    it('makes none with no chat open, nor for a chat whose file name stands in for its UUID, as its suffix could not be told from it', () => {
        host.chatUUID = null;
        expect(() => chatCollections.startNewChatCollection(SETTINGS, { windowSize: 2 })).toThrow('This chat has no UUID of its own');
        host.chatId = null;
        expect(() => chatCollections.startNewChatCollection(SETTINGS, { windowSize: 2 })).toThrow('No chat is open.');
        expect(collections.registerCollection).not.toHaveBeenCalled();
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });
});
