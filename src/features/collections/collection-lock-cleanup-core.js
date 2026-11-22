/**
 * Clean up locks, the collections' part (§1.1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * which of a collection's locks name a chat or a character that no longer exists, and the reverse lock index
 * (`chat_lock_index`) its records' chat locks give. A chat lock is the chat's ID, in `lockedToChatIds` or the single
 * `lockedToChatId` saved before them; a character lock is the character's place in SillyTavern's character list (D9),
 * so only one past the list's end is known to name no character. Pure: no settings, no SillyTavern.
 */

/**
 * The chats a collection's record is locked to: `lockedToChatIds`, then the single `lockedToChatId` saved before them
 * when the list lacks it.
 * @param {object|null|undefined} record - One collection's record
 * @returns {string[]}
 */
export function chatLocksOf(record) {
    const locks = Array.isArray(record?.lockedToChatIds) ? [...record.lockedToChatIds] : [];
    if (record?.lockedToChatId && !locks.includes(String(record.lockedToChatId))) locks.push(String(record.lockedToChatId));
    return locks;
}

/**
 * Whether a character lock names no character: a whole number below 0, or at or past the end of a character list of
 * `characterCount`. A lock of any other form is kept, as nothing here can tell it is gone.
 * @param {string|number} characterLock - A place in SillyTavern's character list
 * @param {number} characterCount
 * @returns {boolean}
 */
function isPastCharacterList(characterLock, characterCount) {
    const text = String(characterLock).trim();
    if (!/^-?\d+$/.test(text)) return false;
    const place = Number(text);
    return place < 0 || place >= characterCount;
}

/**
 * How a rebuilt index differs from the saved one, each entry a chat and a collection key: the saved entries the
 * rebuilt index lacks, a repeated one included, and the rebuilt entries the saved index lacks.
 * @param {Record<string, unknown>|null|undefined} savedIndex
 * @param {Record<string, string[]>} rebuiltIndex
 * @returns {{indexEntriesRemoved: number, indexEntriesAdded: number}}
 */
function lockIndexDifference(savedIndex, rebuiltIndex) {
    const entryOf = (chatId, key) => JSON.stringify([String(chatId), String(key)]);
    const rebuilt = new Set(Object.entries(rebuiltIndex).flatMap(([chatId, keys]) => keys.map(key => entryOf(chatId, key))));
    const saved = new Set();
    let indexEntriesRemoved = 0;
    for (const [chatId, keys] of Object.entries(savedIndex ?? {})) {
        for (const key of Array.isArray(keys) ? keys : []) {
            const entry = entryOf(chatId, key);
            if (!rebuilt.has(entry) || saved.has(entry)) indexEntriesRemoved += 1;
            saved.add(entry);
        }
    }
    const indexEntriesAdded = [...rebuilt].filter(entry => !saved.has(entry)).length;
    return { indexEntriesRemoved, indexEntriesAdded };
}

/**
 * What Clean up locks changes in the collections' records: each chat lock on a chat `isChatPresent` does not know and
 * each character lock past the character list's end go; then `chat_lock_index` is rebuilt from the chat locks left,
 * each record's under the key the record is saved under, which is the key its locks were written with. A null
 * `isChatPresent` (the chat list could not be read whole) judges no chat lock, and a `characterCount` of 0 (no
 * character list) no character lock.
 * @param {Record<string, object>|null|undefined} records - The collections' records, by key
 * @param {Record<string, unknown>|null|undefined} savedIndex - `chat_lock_index` as saved
 * @param {{isChatPresent: ((chatId: string) => boolean)|null, characterCount: number}} targets
 * @returns {{updates: Record<string, {lockedToChatIds?: string[], lockedToChatId?: null, lockedToCharacterIds?: string[]}>,
 *   goneChatLockCount: number, goneCharacterLockCount: number, lockIndex: Record<string, string[]>,
 *   indexEntriesRemoved: number, indexEntriesAdded: number}} Each record's new lock lists, by key, for a record losing a
 *   lock; how many locks go of each kind; the rebuilt index, and how it differs from the saved one
 */
export function planCollectionLockCleanup(records, savedIndex, { isChatPresent, characterCount }) {
    const updates = {};
    const lockIndex = {};
    let goneChatLockCount = 0;
    let goneCharacterLockCount = 0;
    for (const [key, record] of Object.entries(records ?? {})) {
        const update = {};
        let chatLocks = chatLocksOf(record);
        if (isChatPresent) {
            const kept = chatLocks.filter(chatId => isChatPresent(String(chatId)));
            if (kept.length < chatLocks.length) {
                goneChatLockCount += chatLocks.length - kept.length;
                update.lockedToChatIds = kept;
                update.lockedToChatId = null;
                chatLocks = kept;
            }
        }
        const characterLocks = Array.isArray(record?.lockedToCharacterIds) ? record.lockedToCharacterIds : [];
        if (characterCount > 0) {
            const kept = characterLocks.filter(characterLock => !isPastCharacterList(characterLock, characterCount));
            if (kept.length < characterLocks.length) {
                goneCharacterLockCount += characterLocks.length - kept.length;
                update.lockedToCharacterIds = kept;
            }
        }
        if (Object.keys(update).length) updates[key] = update;
        for (const chatId of chatLocks) {
            const chatKeys = (lockIndex[String(chatId)] ??= []);
            if (!chatKeys.includes(key)) chatKeys.push(key);
        }
    }
    return { updates, goneChatLockCount, goneCharacterLockCount, lockIndex, ...lockIndexDifference(savedIndex, lockIndex) };
}
