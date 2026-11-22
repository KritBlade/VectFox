/**
 * A chat's own EventBase collections and the one it uses (§2.2 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): a chat reads and writes one of its own collections
 * at a time, the one locked to it. Every reader and writer asks one function which that is (collectionInUse), so none
 * guesses: with none in use, nothing reads or writes the chat's events or StoryArc, and whatever is switched on says so
 * in red (noCollectionInUseText, showNoCollectionInUse; D18). One lock function puts a collection in use
 * (useChatCollection), on the rule LoreBase's selections follow too (oneInUseLockChanges), so a reply never reads two
 * versions of the same story. A run with none in use asks which one to use (askWhichChatCollection). New collection makes
 * another collection of the chat (startNewChatCollection, §2.5). Collections of other chats and chat files locked in to
 * be read beside the chat's own are found by sharedCollectionsLockedHere.
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import {
    COLLECTION_PREFIXES, buildEventBaseCollectionId, buildRegistryKey, getChatUUID, getRegistryBackend, parseCollectionId,
    parseRegistryKey, vectorBackendName,
} from '../../shared/collection-ids.js';
import { select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';
import { newTimeId, numberedName } from '../../shared/new-group-member.js';
import { oneInUseLockChanges } from '../../shared/one-in-use-locks.js';
import {
    collectionNameOf, getCollectionListing, getCollectionRegistry, isCollectionActiveForContextAnyKey, isCollectionAutoSyncEnabled,
    isCollectionEnabled, registerCollection, removeCollectionLock, setCollectionLock, setCollectionMeta,
} from '../collections/index.js';
import { findEventBaseCollectionsForChat, setCollectionWindowSize } from './eventbase-store.js';

/** The question's dropdown, by its id. */
const QUESTION_LIST_ID = 'vectfox_eventbase_collection_in_use';

/** What the question answers when New collection is chosen: no registry key holds a "+". */
export const NEW_COLLECTION = '+new';

/** Why a chat has no collection in use (collectionInUse). */
export const NOT_IN_USE_REASON = Object.freeze({
    /** No chat is open. */
    NO_CHAT: 'no-chat',
    /** The chat has no collection of its own on the current backend: its first run makes one. */
    NO_COLLECTION: 'no-collection',
    /** The chat has collections on the current backend, none locked to it. */
    NONE_IN_USE: 'none-in-use',
    /** More than one of its collections is locked to it, as locks saved before a chat kept one in use can be. */
    SEVERAL_IN_USE: 'several-in-use',
    /** The one locked to it was made on the backend VectFox no longer uses. */
    OTHER_BACKEND: 'other-backend',
});

/** Where the user chooses the collection a chat uses. */
const CHOOSE_ONE = 'Choose one in Collection in use here, on the AutoSync page.';

/**
 * Whether a collection is locked to the chat: the Database Browser's Active here, under the registry key or the bare ID
 * an older version locked it by. The one lock check every reader and writer of a chat's collection makes.
 * @param {string} registryKey
 * @param {string|null} chatId
 * @returns {boolean}
 */
function isLockedHere(registryKey, chatId) {
    return Boolean(chatId) && isCollectionActiveForContextAnyKey([registryKey, parseRegistryKey(registryKey).collectionId], { chatId });
}

/** Whether a collection is paused in the Database Browser, under either key form: no reply reads it. */
function isPaused(registryKey) {
    return [registryKey, parseRegistryKey(registryKey).collectionId].some(key => !isCollectionEnabled(key));
}

/**
 * Every EventBase collection of the chat in the registry (findEventBaseCollectionsForChat), on every backend, each with
 * its name, whether it is locked to the chat, paused, has auto-sync on, and belongs to this account.
 * @param {object} settings - VectFox settings
 * @param {string} chatUUID
 * @param {string|null} chatId
 */
function describeChatCollections(settings, chatUUID, chatId) {
    const ownKeys = new Set(getCollectionListing(settings).filter(entry => entry.isOwn).map(entry => entry.registryKey));
    return findEventBaseCollectionsForChat(chatUUID).map(({ registryKey, collectionId, backend }) => ({
        registryKey,
        collectionId,
        backend,
        name: collectionNameOf(registryKey),
        isLockedHere: isLockedHere(registryKey, chatId),
        isPaused: isPaused(registryKey),
        isAutoSyncOn: isCollectionAutoSyncEnabled(registryKey),
        isOwn: ownKeys.has(registryKey),
    }));
}

/** The chat's own collections on the backend given: those this account made, and any locked to the chat. */
function ownOnBackend(members, backend) {
    return members
        .filter(collection => collection.backend === backend && (collection.isOwn || collection.isLockedHere))
        .map(({ isOwn: _isOwn, ...collection }) => collection);
}

/** The chat a collectionInUse call reads: the open chat's id by default, none for a chat that is not open. */
function lockChatIdOf(chatUUID, chatId) {
    if (chatId !== undefined) return chatId;
    return chatUUID === getChatUUID() ? getCurrentChatId() : null;
}

/**
 * The open chat's own collections on the current backend, as Collection in use here and the question list them: each
 * `vf_eventbase_` collection whose chat UUID (parseCollectionId) is the chat's, never an archive, that this account made
 * or that is locked to the chat; each by its name, with whether it is locked to the chat, is paused and has auto-sync on.
 * @param {object} settings - VectFox settings
 * @param {{chatUUID?: string|null, chatId?: string|null}} [chat] - The open chat by default
 * @returns {Array<{registryKey: string, collectionId: string, backend: string, name: string, isLockedHere: boolean,
 *   isPaused: boolean, isAutoSyncOn: boolean}>}
 */
export function chatOwnCollections(settings, { chatUUID = getChatUUID(), chatId } = {}) {
    if (!chatUUID) return [];
    const backend = getRegistryBackend(settings?.vector_backend);
    return ownOnBackend(describeChatCollections(settings, chatUUID, lockChatIdOf(chatUUID, chatId)), backend);
}

/**
 * The collection the chat uses, which every reader and writer of its events asks for (D18): its own collection locked to
 * it on the current backend (chatOwnCollections), or why there is none (NOT_IN_USE_REASON). Never a guess: with none
 * locked, several locked, or the one locked on the other backend, nothing reads or writes the chat's events.
 * @param {object} settings - VectFox settings
 * @param {{chatUUID?: string|null, chatId?: string|null}} [chat] - The open chat by default
 * @returns {{collection: object|null, reason: string|null, collections: object[], lockedElsewhere: object[], backend: string}}
 *   collection: the one in use (as chatOwnCollections gives it), else null with reason; collections: the chat's own
 *   collections on the current backend; lockedElsewhere: its collections locked to it on another backend
 */
export function collectionInUse(settings, { chatUUID = getChatUUID(), chatId } = {}) {
    const backend = getRegistryBackend(settings?.vector_backend);
    const lockChatId = chatUUID ? lockChatIdOf(chatUUID, chatId) : null;
    if (!chatUUID || !lockChatId) {
        return { collection: null, reason: NOT_IN_USE_REASON.NO_CHAT, collections: [], lockedElsewhere: [], backend };
    }
    const members = describeChatCollections(settings, chatUUID, lockChatId);
    const collections = ownOnBackend(members, backend);
    const lockedHere = collections.filter(collection => collection.isLockedHere);
    if (lockedHere.length === 1) return { collection: lockedHere[0], reason: null, collections, lockedElsewhere: [], backend };
    const lockedElsewhere = members
        .filter(collection => collection.backend !== backend && collection.isLockedHere)
        .map(({ isOwn: _isOwn, ...collection }) => collection);
    let reason = NOT_IN_USE_REASON.NO_COLLECTION;
    if (lockedHere.length > 1) reason = NOT_IN_USE_REASON.SEVERAL_IN_USE;
    else if (lockedElsewhere.length) reason = NOT_IN_USE_REASON.OTHER_BACKEND;
    else if (collections.length) reason = NOT_IN_USE_REASON.NONE_IN_USE;
    return { collection: null, reason, collections, lockedElsewhere, backend };
}

const listNames = collections => new Intl.ListFormat('en', { type: 'conjunction' }).format(collections.map(collection => `"${collection.name}"`));

/**
 * Why nothing reads or writes the open chat's events, and where to choose the collection it uses; null when one is in
 * use, no chat is open, or the chat has no collection to choose from (collectionInUse).
 * @param {ReturnType<typeof collectionInUse>} inUse
 * @param {string} consequence - What was not done, as "this reply read none of its events"
 * @param {{isWhereToChooseSaid?: boolean}} [options] - false: the words leave out where to choose, for a question that
 *   asks it
 * @returns {string|null}
 */
export function noCollectionInUseText(inUse, consequence, { isWhereToChooseSaid = true } = {}) {
    let why;
    let whereToChoose = CHOOSE_ONE;
    switch (inUse?.reason) {
        case NOT_IN_USE_REASON.NONE_IN_USE:
            why = `No collection is in use in this chat, so ${consequence}.`;
            break;
        case NOT_IN_USE_REASON.SEVERAL_IN_USE: {
            const lockedHere = inUse.collections.filter(collection => collection.isLockedHere);
            why = `${listNames(lockedHere)} are ${lockedHere.length === 2 ? 'both' : 'all'} locked to this chat, `
                + `which uses one at a time, so ${consequence}.`;
            break;
        }
        case NOT_IN_USE_REASON.OTHER_BACKEND: {
            const isOne = inUse.lockedElsewhere.length === 1;
            why = `${listNames(inUse.lockedElsewhere)}, in use in this chat, ${isOne ? 'is' : 'are'} on `
                + `${vectorBackendName(inUse.lockedElsewhere[0].backend)}, and VectFox uses ${vectorBackendName(inUse.backend)} now, `
                + `so ${consequence}.`;
            if (!inUse.collections.length) whereToChoose = 'Switch back on the Core page, or vectorize this chat here.';
            break;
        }
        default:
            return null;
    }
    return isWhereToChooseSaid ? `${why} ${whereToChoose}` : why;
}

/**
 * Say in red why nothing reads or writes the open chat's events (noCollectionInUseText), as whatever is switched on tries
 * to. Nothing when the chat has a collection in use, or none to choose from.
 * @param {ReturnType<typeof collectionInUse>} inUse
 * @param {string} consequence - What was not done
 * @returns {boolean} Whether it said so
 */
export function showNoCollectionInUse(inUse, consequence) {
    const text = noCollectionInUseText(inUse, consequence);
    if (!text) return false;
    log.warn(`[EventBase] ${text}`);
    // toastr is SillyTavern's page global, absent where no page is loaded.
    // preventDuplicates: auto-sync tries on each message, so one toast stands while it shows.
    globalThis.toastr?.error(text, 'EventBase', { timeOut: 15000, extendedTimeOut: 10000, preventDuplicates: true });
    return true;
}

/**
 * The collections locked to the chat to be read beside its own: other chats' EventBase collections and chat files'
 * archive collections, on any backend, each with whether it is paused. Never one of the chat's own: that one is
 * collectionInUse's.
 * @param {{chatUUID?: string|null, chatId?: string|null}} [chat] - The open chat by default
 * @returns {{otherChats: Array<{registryKey: string, collectionId: string, isPaused: boolean}>,
 *   archives: Array<{registryKey: string, collectionId: string, isPaused: boolean}>}}
 */
export function sharedCollectionsLockedHere({ chatUUID = getChatUUID(), chatId = getCurrentChatId() } = {}) {
    const otherChats = [];
    const archives = [];
    if (!chatId) return { otherChats, archives };
    const seenIds = new Set();
    for (const registryKey of getCollectionRegistry()) {
        const { collectionId } = parseRegistryKey(registryKey);
        if (!collectionId || seenIds.has(collectionId) || !isLockedHere(registryKey, chatId)) continue;
        const isOtherChats = collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) && parseCollectionId(collectionId).chatUUID !== chatUUID;
        const isArchive = collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT);
        if (!isOtherChats && !isArchive) continue;
        seenIds.add(collectionId);
        (isArchive ? archives : otherChats).push({ registryKey, collectionId, isPaused: isPaused(registryKey) });
    }
    return { otherChats, archives };
}

/**
 * Put one of a chat's own collections in use there: lock it to the chat, and unlock the chat's other own collections
 * there, on every backend and under every persona (oneInUseLockChanges), so the chat has one in use wherever its
 * collections are registered. The one lock function every lock of an own collection goes through: a chat's first read,
 * the question, the AutoSync page's Collection in use here and its switch, the Database Browser's lock, and a fork. A
 * collection of another chat or an archive, locked in for sharing, is never touched.
 * @param {string} registryKey - The collection's registry key
 * @param {{chatId?: string|null}} [chat] - The open chat by default
 * @returns {{lockedKeys: string[], unlockedKeys: string[]}} What changed; nothing with no chat
 */
export function useChatCollection(registryKey, { chatId = getCurrentChatId() } = {}) {
    if (!chatId) return { lockedKeys: [], unlockedKeys: [] };
    const { chatUUID } = parseCollectionId(parseRegistryKey(registryKey).collectionId);
    const members = findEventBaseCollectionsForChat(chatUUID).map(member => ({ id: member.registryKey, isLockedHere: isLockedHere(member.registryKey, chatId) }));
    if (!members.some(member => member.id === registryKey)) members.push({ id: registryKey, isLockedHere: isLockedHere(registryKey, chatId) });
    const { lockIds, unlockIds } = oneInUseLockChanges(members, registryKey);
    for (const key of unlockIds) {
        for (const lockKey of [key, parseRegistryKey(key).collectionId]) removeCollectionLock(lockKey, chatId);
    }
    for (const key of lockIds) setCollectionLock(key, chatId);
    // A chat lock counts only on a collection scoped to chats (isCollectionActiveForContext).
    setCollectionMeta(registryKey, { scope: 'chat' });
    if (lockIds.length || unlockIds.length) {
        log.lifecycle(`[EventBase] ${registryKey} in use in chat ${chatId}; unlocked there: ${unlockIds.join(', ') || 'none'}`);
        globalThis.document?.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    }
    return { lockedKeys: lockIds, unlockedKeys: unlockIds };
}

/**
 * Lock a collection to the open chat, as the Database Browser's lock does: one of the chat's own collections is put in
 * use there (useChatCollection); another chat's collection or an archive, locked in to be read beside it, is locked
 * alone, leaving the chat's own as they are.
 * @param {string} registryKey - The collection's registry key
 */
export function lockCollectionToOpenChat(registryKey) {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const { collectionId } = parseRegistryKey(registryKey);
    const isChatOwn = collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) && parseCollectionId(collectionId).chatUUID === getChatUUID();
    if (isChatOwn) useChatCollection(registryKey, { chatId });
    else setCollectionLock(registryKey, chatId);
}

/**
 * The collection a run on the open chat reads into: the one in use (collectionInUse); for a chat with no collection of
 * its own on the current backend, its first, under the ID its first run builds; null when it has some but none in use,
 * so nothing is written until one is chosen.
 * @param {object} settings - VectFox settings
 * @param {string} chatUUID
 * @returns {{collectionId: string, registryKey: string}|null}
 */
export function resolveEventBaseRunTarget(settings, chatUUID) {
    const inUse = collectionInUse(settings, { chatUUID });
    if (inUse.collection) return { collectionId: inUse.collection.collectionId, registryKey: inUse.collection.registryKey };
    if (inUse.reason === NOT_IN_USE_REASON.NO_CHAT || inUse.collections.length) return null;
    const collectionId = buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    return { collectionId, registryKey: buildRegistryKey(collectionId, settings) };
}

/**
 * Ask which of the open chat's own collections to use, when it has some and none is in use (collectionInUse), and put
 * the one chosen in use (useChatCollection). Vectorize, Resume, Sync chat and the AutoSync page's switch ask it before
 * writing; the first three offer New collection last, which puts nothing in use, as its run locks the collection it
 * makes.
 * @param {object} settings - VectFox settings
 * @param {{canMakeNew?: boolean}} [options] - canMakeNew: New collection is offered
 * @returns {Promise<string|null>} The registry key of the collection in use: the one in use already, the one chosen;
 *   NEW_COLLECTION when New collection is chosen; null on Cancel, or when the chat has no own collection, which its
 *   first run makes
 */
export async function askWhichChatCollection(settings, { canMakeNew = false } = {}) {
    const inUse = collectionInUse(settings);
    if (inUse.collection) return inUse.collection.registryKey;
    const { collections } = inUse;
    if (!collections.length) return null;
    // Loaded when asked, so the modules that read a chat's collections load no dialog.
    const { formPopup } = await import('../../sillytavern/popup.js');
    const form = document.createElement('div');
    form.className = 'vfx-field';
    form.innerHTML = select({
        id: QUESTION_LIST_ID,
        title: 'Collection to use',
        options: [
            ...collections.map((collection, index) => selectOption({ value: collection.registryKey, name: collection.name, isSelected: index === 0 })),
            ...(canMakeNew ? [selectOption({ value: NEW_COLLECTION, text: 'New collection' })] : []),
        ],
    });
    const isChosen = await formPopup([
        { text: 'Which collection should this chat use?' },
        { text: noCollectionInUseText(inUse, 'EventBase reads and writes nothing here', { isWhereToChooseSaid: false }) },
        { text: 'The one you choose is locked to this chat, and EventBase reads and writes it here.' },
    ], form, { okButton: 'Use', focusSelector: `#${QUESTION_LIST_ID}` });
    if (!isChosen) return null;
    const registryKey = form.querySelector(`#${QUESTION_LIST_ID}`).value;
    if (registryKey === NEW_COLLECTION) return NEW_COLLECTION;
    useChatCollection(registryKey);
    return registryKey;
}

/**
 * New collection's collection (§2.5 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): the chat's
 * first ID with the time it was made in base 36 after it, never made twice (newTimeId); named as the chat's first
 * collection is, with the lowest number from 2 the names of its collections do not use (numberedName), as "Harbor Night
 * 2"; read at the window size given; scoped to chats and listed at once. Its run locks it to the chat as it starts,
 * unlocking the chat's others there (runEventBaseIngestion, through useChatCollection); auto-sync starts off for it.
 * @param {object} settings - VectFox settings
 * @param {{windowSize: number}} reading - The Vectorize dialog's window size, which the collection keeps
 * @returns {{registryKey: string, collectionId: string, name: string}}
 * @throws {Error} With no chat open, or one whose UUID its file name stands in for (getChatUUID's fallback), which a
 *   later collection's suffix cannot be told from
 */
export function startNewChatCollection(settings, { windowSize }) {
    const chatUUID = getChatUUID();
    const firstId = chatUUID ? buildEventBaseCollectionId(chatUUID, settings?.vector_backend) : null;
    if (!firstId) throw new Error('No chat is open.');
    const laterPrefix = `${firstId}_`;
    const takenSuffixes = getCollectionRegistry()
        .map(key => parseRegistryKey(key).collectionId ?? '')
        .filter(collectionId => collectionId.startsWith(laterPrefix))
        .map(collectionId => collectionId.slice(laterPrefix.length));
    const collectionId = `${laterPrefix}${newTimeId(takenSuffixes)}`;
    if (parseCollectionId(collectionId).chatUUID !== chatUUID) {
        throw new Error('This chat has no UUID of its own, so a second collection of it could not be told from its first.');
    }
    const registryKey = buildRegistryKey(collectionId, settings);
    // The name its ID gives with no record yet: the chat's first collection's automatic name.
    const name = numberedName(collectionNameOf(registryKey), chatOwnCollections(settings).map(collection => collection.name));
    setCollectionMeta(registryKey, { displayName: name, scope: 'chat' });
    setCollectionWindowSize(registryKey, windowSize);
    registerCollection(registryKey);
    log.lifecycle(`[EventBase] New collection ${registryKey}, "${name}", window size ${windowSize}`);
    return { registryKey, collectionId, name };
}
