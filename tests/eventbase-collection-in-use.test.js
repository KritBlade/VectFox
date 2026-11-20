/**
 * @vitest-environment jsdom
 *
 * A chat's own EventBase collections and the one it uses (src/features/eventbase/eventbase-chat-collections.js, §2.2 of
 * InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): which collections are the chat's own and listed;
 * the one lock function, which locks the one chosen and unlocks the chat's other own collections on every backend and
 * under every persona, never another chat's or an archive; the Database Browser's lock; the run target, which writes
 * nothing while the chat has collections but none locked; the question asked then, with New collection where a run can
 * make one; New collection's ID, name and window size (§2.5); and the line warning that auto-sync is on for a collection
 * not in use.
 *
 * The collections feature is an in-memory registry with its locks, scopes, names and auto-sync switches, a collection
 * with no name taking the chat's automatic one; collection IDs are parsed and built by the real collection-ids.js; the
 * store's lookups read that registry.
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

const host = vi.hoisted(() => ({
    chatId: null, chatUUID: null, registry: [], locks: new Map(), scopes: new Map(), autoSync: new Set(), owners: new Map(),
    names: new Map(), answer: true, chosenKey: null,
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
            .map(registryKey => ({ registryKey, collectionId: parseRegistryKey(registryKey).collectionId }))
            .filter(({ collectionId }) => collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) && parseCollectionId(collectionId).chatUUID === uuid),
        // The chat's own collection locked to it on Qdrant, as the real write target is.
        resolveEventBaseWriteTarget: () => {
            const registryKey = host.registry.find(key => key.startsWith('qdrant:vf_eventbase_') && key.includes(host.chatUUID)
                && (host.locks.get(key) ?? []).includes(host.chatId));
            return registryKey ? { registryKey, collectionId: parseRegistryKey(registryKey).collectionId } : null;
        },
        setCollectionWindowSize: vi.fn(),
    };
});

const chatCollections = await import('../src/features/eventbase/eventbase-chat-collections.js');
const collections = await import('../src/features/collections/index.js');
const store = await import('../src/features/eventbase/eventbase-store.js');
const { formPopup } = await import('../src/sillytavern/popup.js');
const SETTINGS = { vector_backend: 'qdrant' };
const lockedHere = () => host.registry.filter(key => (host.locks.get(key) ?? []).includes(CHAT_ID));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('toastr', { warning: vi.fn() });
    Object.assign(host, { chatId: CHAT_ID, chatUUID: CHAT_UUID, answer: true, chosenKey: null });
    host.registry = [FIRST, LATER, OTHER_PERSONA, OTHER_BACKEND, OTHER_CHAT, ARCHIVE];
    host.locks = new Map();
    host.scopes = new Map();
    host.autoSync = new Set();
    host.owners = new Map([[OTHER_PERSONA, false]]);
    host.names = new Map([[FIRST, AUTOMATIC_NAME], [LATER, 'Harbor Keeper 2']]);
});

describe("a chat's own collections", () => {
    it('lists those of this persona on the current backend, by name, with which is locked here and has auto-sync on', () => {
        host.locks.set(LATER, [CHAT_ID]);
        host.autoSync.add(FIRST);
        expect(chatCollections.chatOwnCollections(SETTINGS)).toEqual([
            { registryKey: FIRST, collectionId: FIRST.slice(7), name: '💬 Chat: Harbor Keeper', isLockedHere: false, isAutoSyncOn: true },
            { registryKey: LATER, collectionId: LATER.slice(7), name: 'Harbor Keeper 2', isLockedHere: true, isAutoSyncOn: false },
        ]);
    });

    it('lists none with no chat open', () => {
        host.chatUUID = null;
        expect(chatCollections.chatOwnCollections(SETTINGS)).toEqual([]);
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
    it('is the one in use; none while the chat has collections but none locked; the first, built, for a chat with none', () => {
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toEqual({ registryKey: LATER, collectionId: LATER.slice(7) });
        host.locks.clear();
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toBeNull();
        host.registry = [OTHER_CHAT];
        expect(chatCollections.resolveEventBaseRunTarget(SETTINGS, CHAT_UUID)).toEqual({ registryKey: FIRST, collectionId: FIRST.slice(7) });
    });
});

describe('the question asked while none is in use', () => {
    it("lists the chat's own collections, puts the one chosen in use, and answers its key", async () => {
        host.chosenKey = LATER;
        expect(await chatCollections.askWhichChatCollection(SETTINGS)).toBe(LATER);
        const [lines, form, options] = formPopup.mock.calls[0];
        expect(lines[1]).toEqual({ text: 'No collection of this chat is locked to it, so EventBase writes nothing here.' });
        expect([...form.querySelectorAll('option')].map(option => [option.value, option.textContent])).toEqual([
            [FIRST, '💬 Chat: Harbor Keeper'], [LATER, 'Harbor Keeper 2'],
        ]);
        expect(options).toMatchObject({ okButton: 'Use' });
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

describe('auto-sync on for a collection not in use', () => {
    it('names each one with auto-sync on while none is locked here, and says where to choose one', () => {
        host.autoSync = new Set([FIRST]);
        expect(chatCollections.autoSyncNotInUseText(SETTINGS)).toBe('Auto-sync is on for "💬 Chat: Harbor Keeper", but it is not '
            + 'locked to this chat, so EventBase writes nothing here. Choose one in Collection in use here, on the AutoSync page.');
        host.autoSync.add(LATER);
        expect(chatCollections.autoSyncNotInUseText(SETTINGS)).toMatch(/^Auto-sync is on for "💬 Chat: Harbor Keeper" and "Harbor Keeper 2", but none of them is locked/u);
        chatCollections.warnOfAutoSyncNotInUse(SETTINGS);
        expect(toastr.warning).toHaveBeenCalledWith(expect.stringMatching(/^Auto-sync is on for/u), 'EventBase', { timeOut: 12000 });
    });

    it('says nothing once one is locked here, or while none has auto-sync on', () => {
        expect(chatCollections.autoSyncNotInUseText(SETTINGS)).toBeNull();
        host.autoSync = new Set([FIRST]);
        host.locks.set(LATER, [CHAT_ID]);
        expect(chatCollections.autoSyncNotInUseText(SETTINGS)).toBeNull();
        chatCollections.warnOfAutoSyncNotInUse(SETTINGS);
        expect(toastr.warning).not.toHaveBeenCalled();
    });
});
