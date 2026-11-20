/**
 * A chat's own EventBase collections and the one it uses (§2.2 of
 * InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): a chat reads and writes one of its own collections
 * at a time, the one locked to it. One lock function puts a collection in use (useChatCollection), on the rule LoreBase's
 * selections follow too (oneInUseLockChanges), so a reply never reads two versions of the same story. With none of its
 * collections locked, nothing is written for the chat: a run asks which one to use (askWhichChatCollection), auto-sync
 * passes it by, and opening it while auto-sync is on for one of them says so (warnOfAutoSyncNotInUse).
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import {
    COLLECTION_PREFIXES, buildEventBaseCollectionId, buildRegistryKey, getChatUUID, getRegistryBackend, parseCollectionId,
    parseRegistryKey,
} from '../../shared/collection-ids.js';
import { select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';
import { oneInUseLockChanges } from '../../shared/one-in-use-locks.js';
import {
    collectionNameOf, getCollectionListing, getCollectionLocks, isCollectionAutoSyncEnabled, removeCollectionLock, setCollectionLock,
    setCollectionMeta,
} from '../collections/index.js';
import { findEventBaseCollectionsForChat, resolveEventBaseWriteTarget } from './eventbase-store.js';

/** The question's dropdown, by its id. */
const QUESTION_LIST_ID = 'vectfox_eventbase_collection_in_use';

/** What a chat with collections but none locked to it is told: EventBase writes nothing there until one is chosen. */
export const NONE_IN_USE_TEXT = 'No collection of this chat is locked to it, so EventBase writes nothing here.';

/**
 * Whether a collection is locked to the chat, under its registry key or the bare ID an older version locked it by.
 * @param {string} registryKey
 * @param {string} chatId
 * @returns {boolean}
 */
function isLockedTo(registryKey, chatId) {
    const { collectionId } = parseRegistryKey(registryKey);
    return [registryKey, collectionId].some(key => getCollectionLocks(key).includes(String(chatId)));
}

/**
 * The open chat's own collections, as the Database Browser lists them for this persona, on the current backend: each
 * `vf_eventbase_` collection whose chat UUID (parseCollectionId) is the chat's, never an archive. What Collection in use
 * here and the question list, each by its name, with whether it is locked to the chat and has auto-sync on.
 * @param {object} settings - VectFox settings
 * @param {{chatUUID?: string|null, chatId?: string|null}} [chat] - The open chat by default
 * @returns {Array<{registryKey: string, collectionId: string, name: string, isLockedHere: boolean, isAutoSyncOn: boolean}>}
 */
export function chatOwnCollections(settings, { chatUUID = getChatUUID(), chatId = getCurrentChatId() } = {}) {
    if (!chatUUID) return [];
    const backend = getRegistryBackend(settings?.vector_backend);
    return getCollectionListing(settings)
        .filter(entry => entry.isOwn && entry.backend === backend && entry.collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)
            && parseCollectionId(entry.collectionId).chatUUID === chatUUID)
        .map(({ registryKey, collectionId }) => ({
            registryKey,
            collectionId,
            name: collectionNameOf(registryKey),
            isLockedHere: Boolean(chatId) && isLockedTo(registryKey, chatId),
            isAutoSyncOn: isCollectionAutoSyncEnabled(registryKey),
        }));
}

/**
 * Put one of a chat's own collections in use there: lock it to the chat, and unlock the chat's other own collections
 * there, on every backend and under every persona (oneInUseLockChanges), as a reply reads every collection locked to the
 * chat. The one lock function every lock of an own collection goes through: a chat's first read, the question, the
 * AutoSync page's Collection in use here and its switch, the Database Browser's lock, and a fork. A collection of
 * another chat or an archive, locked in for sharing, is never touched.
 * @param {string} registryKey - The collection's registry key
 * @param {{chatId?: string|null}} [chat] - The open chat by default
 * @returns {{lockedKeys: string[], unlockedKeys: string[]}} What changed; nothing with no chat
 */
export function useChatCollection(registryKey, { chatId = getCurrentChatId() } = {}) {
    if (!chatId) return { lockedKeys: [], unlockedKeys: [] };
    const { chatUUID } = parseCollectionId(parseRegistryKey(registryKey).collectionId);
    const members = findEventBaseCollectionsForChat(chatUUID).map(member => ({ id: member.registryKey, isLockedHere: isLockedTo(member.registryKey, chatId) }));
    if (!members.some(member => member.id === registryKey)) members.push({ id: registryKey, isLockedHere: isLockedTo(registryKey, chatId) });
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
 * The collection a run on the open chat reads into: the chat's own collection locked to it on the current backend
 * (resolveEventBaseWriteTarget); with none, the chat's first collection, under the ID its first run builds, when the
 * chat has no own collection yet; null when it has some but none is locked, so nothing is written until one is chosen.
 * @param {object} settings - VectFox settings
 * @param {string} chatUUID
 * @returns {{collectionId: string, registryKey: string}|null}
 */
export function resolveEventBaseRunTarget(settings, chatUUID) {
    const writeTarget = resolveEventBaseWriteTarget(settings, chatUUID);
    if (writeTarget) return writeTarget;
    if (chatOwnCollections(settings, { chatUUID }).length) return null;
    const collectionId = buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    return { collectionId, registryKey: buildRegistryKey(collectionId, settings) };
}

/**
 * Ask which of the open chat's own collections to use, when it has some and none is locked to it, and put the one
 * chosen in use (useChatCollection). Vectorize, Resume, Sync chat and the AutoSync page's switch ask it before writing.
 * @param {object} settings - VectFox settings
 * @returns {Promise<string|null>} The registry key of the collection in use: the one locked already, the one chosen;
 *   null on Cancel, or when the chat has no own collection, which its first run makes
 */
export async function askWhichChatCollection(settings) {
    const collections = chatOwnCollections(settings);
    const inUse = collections.find(collection => collection.isLockedHere);
    if (inUse || !collections.length) return inUse?.registryKey ?? null;
    // Loaded when asked, so the modules that read a chat's collections load no dialog.
    const { formPopup } = await import('../../sillytavern/popup.js');
    const form = document.createElement('div');
    form.className = 'vfx-field';
    form.innerHTML = select({
        id: QUESTION_LIST_ID,
        title: 'Collection to use',
        options: collections.map((collection, index) => selectOption({ value: collection.registryKey, name: collection.name, isSelected: index === 0 })),
    });
    const isChosen = await formPopup([
        { text: 'Which collection should this chat use?' },
        { text: NONE_IN_USE_TEXT },
        { text: 'The one you choose is locked to this chat, and EventBase reads and writes it here.' },
    ], form, { okButton: 'Use', focusSelector: `#${QUESTION_LIST_ID}` });
    if (!isChosen) return null;
    const registryKey = form.querySelector(`#${QUESTION_LIST_ID}`).value;
    useChatCollection(registryKey);
    return registryKey;
}

/**
 * The line saying auto-sync is on for collections of the open chat that are not locked to it, so EventBase writes nothing
 * there; null when one of its collections is locked to it, or none has auto-sync on.
 * @param {object} settings - VectFox settings
 * @returns {string|null}
 */
export function autoSyncNotInUseText(settings) {
    const collections = chatOwnCollections(settings);
    if (collections.some(collection => collection.isLockedHere)) return null;
    const names = collections.filter(collection => collection.isAutoSyncOn).map(collection => `"${collection.name}"`);
    if (!names.length) return null;
    const listed = new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
    const lockedTo = names.length === 1 ? 'it is not' : 'none of them is';
    return `Auto-sync is on for ${listed}, but ${lockedTo} locked to this chat, so EventBase writes nothing here. `
        + 'Choose one in Collection in use here, on the AutoSync page.';
}

/**
 * On opening a chat: warn, with a yellow toast, that auto-sync is on for its collections but none is locked to it.
 * @param {object} settings - VectFox settings
 */
export function warnOfAutoSyncNotInUse(settings) {
    const text = autoSyncNotInUseText(settings);
    if (text) toastr.warning(text, 'EventBase', { timeOut: 12000 });
}
