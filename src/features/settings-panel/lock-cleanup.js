/**
 * Clean up locks, in the Action page's Stored data (§1.1 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md). It reads which chats and characters exist: every character's chats as
 * SillyTavern lists its chat files, every group's chats and the open chat; and the character list, by avatar file name
 * and by place. Then it counts the locks of collections and lorebooks on chats and characters that no longer exist,
 * and the chat lock index entries the collections' own locks do not back or that they lack. Once the user confirms,
 * each feature removes its own (cleanUpCollectionLocks, cleanUpLoreBookLocks) and the index is rebuilt. A chat list
 * that cannot be read whole leaves every chat lock alone, and the confirm says why.
 */

import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { counted } from '../../shared/counted.js';
import { cleanUpCollectionLocks } from '../collections/index.js';
import { cleanUpLoreBookLocks } from '../lorebase/index.js';

const TOAST_TITLE = 'VectFox';
// How many characters' chat lists are asked for at once.
const CHAT_LISTS_AT_ONCE = 6;

/**
 * The IDs of one character's chats, as SillyTavern lists its chat files. SillyTavern answers `{error: true}` for a
 * character with no chats folder, as for one it could not read: that counts as no chats only while the character list
 * says the character has none.
 * @param {{avatar: string, name?: string, chat_size?: number}} character
 * @returns {Promise<string[]>}
 * @throws {Error} When the list could not be read
 */
async function chatIdsOf(character) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
    });
    const name = character.name || character.avatar;
    if (!response.ok) throw new Error(`SillyTavern answered ${response.status} when asked for the chats of ${name}.`);
    const chats = await response.json();
    if (Array.isArray(chats)) return chats.map(chat => String(chat.file_id ?? String(chat.file_name ?? '').replace(/\.jsonl$/, '')));
    if (chats?.error && !(Number(character.chat_size) > 0)) return [];
    throw new Error(`SillyTavern could not list the chats of ${name}.`);
}

/**
 * Which chats and characters exist. A chat list that could not be read whole gives no chat test, and why; a character
 * list with no characters gives no character test.
 * @returns {Promise<{isChatPresent: ((chatId: string) => boolean)|null, chatListProblem: string|null,
 *   isCharacterPresent: ((avatar: string) => boolean)|null, characterCount: number}>}
 */
async function readLockTargets() {
    const context = getContext();
    const characterList = Array.isArray(context?.characters) ? context.characters : [];
    const characters = characterList.filter(character => character?.avatar);
    const chatIds = new Set();
    let chatListProblem = null;
    for (let start = 0; start < characters.length && !chatListProblem; start += CHAT_LISTS_AT_ONCE) {
        const lists = await Promise.allSettled(characters.slice(start, start + CHAT_LISTS_AT_ONCE).map(chatIdsOf));
        for (const list of lists) {
            if (list.status === 'fulfilled') list.value.forEach(chatId => chatIds.add(chatId));
            else chatListProblem ??= String(list.reason?.message || list.reason);
        }
    }
    for (const group of Array.isArray(context?.groups) ? context.groups : []) {
        for (const chatId of Array.isArray(group?.chats) ? group.chats : []) chatIds.add(String(chatId));
    }
    const openChatId = getCurrentChatId();
    if (openChatId) chatIds.add(String(openChatId));
    const avatars = new Set(characters.map(character => String(character.avatar)));
    return {
        isChatPresent: chatListProblem ? null : chatId => chatIds.has(chatId),
        chatListProblem,
        isCharacterPresent: avatars.size ? avatar => avatars.has(avatar) : null,
        characterCount: characterList.length,
    };
}

/**
 * Count, or with `shouldApply` remove, what Clean up locks removes: the collections' part, then LoreBase's.
 * @param {Awaited<ReturnType<typeof readLockTargets>>} targets
 * @param {boolean} shouldApply
 */
function cleanUpEveryLock(targets, shouldApply) {
    return {
        collections: cleanUpCollectionLocks(targets, { shouldApply }),
        lorebooks: cleanUpLoreBookLocks(targets, { shouldApply }),
    };
}

const goneLockCount = ({ collections, lorebooks }) => collections.goneChatLockCount + collections.goneCharacterLockCount
    + lorebooks.goneChatLockCount + lorebooks.goneCharacterLockCount;

/**
 * The confirm's lines: its question, removing the locks on what no longer exists, or only rebuilding the chat lock
 * index; each kind of lock that goes, with its count; the chat lock index entries that go and those added; why chat
 * locks were not checked, when they were not; and what the index is.
 * @param {ReturnType<typeof cleanUpEveryLock>} counts
 * @param {string|null} chatListProblem
 * @returns {Array<{icon?: string, text: string}>}
 */
function confirmLines(counts, chatListProblem) {
    const { collections, lorebooks } = counts;
    const goneKinds = [
        [collections.goneChatLockCount, 'collection lock on a chat that no longer exists', 'collection locks on chats that no longer exist'],
        [collections.goneCharacterLockCount, 'collection lock on a character that no longer exists', 'collection locks on characters that no longer exist'],
        [lorebooks.goneChatLockCount, 'lorebook lock on a chat that no longer exists', 'lorebook locks on chats that no longer exist'],
        [lorebooks.goneCharacterLockCount, 'lorebook lock on a character that no longer exists', 'lorebook locks on characters that no longer exist'],
    ];
    const isRemovingLocks = goneLockCount(counts) > 0;
    const lines = [{
        text: isRemovingLocks ? 'Remove the locks on chats and characters that no longer exist?' : "Rebuild the chat lock index from the collections' own locks?",
    }];
    for (const [count, one, many] of goneKinds) {
        if (count) lines.push({ text: `${counted(count, one, many)}.` });
    }
    if (collections.goneChatLockCount) {
        lines.push({ text: 'A chat renamed while a collection was locked to it counts as gone: the lock kept the old name.' });
    }
    const removedCount = collections.indexEntriesRemoved;
    if (removedCount) {
        lines.push({ text: `${counted(removedCount, 'chat lock index entry has', 'chat lock index entries have')} no lock behind ${removedCount === 1 ? 'it' : 'them'}.` });
    }
    if (collections.indexEntriesAdded) {
        lines.push({ text: `${counted(collections.indexEntriesAdded, 'lock', 'locks')} the chat lock index lacks.` });
    }
    if (chatListProblem) lines.push({ icon: 'fa-triangle-exclamation', text: `Chat locks were not checked: ${chatListProblem}` });
    lines.push({
        text: isRemovingLocks
            ? "Clean up locks removes those locks and rebuilds the chat lock index, VectFox's list of the collections locked to each chat. Cancel keeps them."
            : "The chat lock index is VectFox's list of the collections locked to each chat. Clean up locks rebuilds it; Cancel keeps it as it is.",
    });
    return lines;
}

/**
 * What was done, in a toast's line.
 * @param {ReturnType<typeof cleanUpEveryLock>} done
 * @returns {string}
 */
function doneText(done) {
    const goneCount = goneLockCount(done);
    const { indexEntriesRemoved, indexEntriesAdded } = done.collections;
    const parts = [];
    if (goneCount) parts.push(`Removed ${counted(goneCount, 'lock')} on chats and characters that no longer exist.`);
    if (indexEntriesRemoved || indexEntriesAdded) {
        parts.push(`Rebuilt the chat lock index: ${counted(indexEntriesRemoved, 'entry', 'entries')} removed, ${counted(indexEntriesAdded, 'entry', 'entries')} added.`);
    }
    return parts.join(' ');
}

/**
 * Clean up locks: read which chats and characters exist, count what would go, and once the user confirms, remove it.
 * Nothing found says so; a chat list that could not be read whole leaves the chat locks alone and says why.
 * @returns {Promise<void>}
 */
export async function cleanUpLocks() {
    try {
        const targets = await readLockTargets();
        if (targets.chatListProblem) log.warn(`VectFox: Clean up locks leaves every chat lock alone: ${targets.chatListProblem}`);
        const counts = cleanUpEveryLock(targets, false);
        if (!goneLockCount(counts) && !counts.collections.indexEntriesRemoved && !counts.collections.indexEntriesAdded) {
            if (targets.chatListProblem) toastr.warning(`No lock to remove, but chat locks were not checked: ${targets.chatListProblem}`, TOAST_TITLE);
            else toastr.info('Every lock names a chat or character that exists, and the chat lock index matches the locks.', TOAST_TITLE);
            return;
        }
        const isConfirmed = await confirmPopup(confirmLines(counts, targets.chatListProblem), { okButton: 'Clean up locks', isDestructive: true });
        if (!isConfirmed) return;
        toastr.success(doneText(cleanUpEveryLock(targets, true)), 'Locks cleaned up');
    } catch (error) {
        log.error('VectFox: Clean up locks failed:', error);
        toastr.error(`Clean up locks failed: ${error?.message || error}`, TOAST_TITLE);
    }
}
