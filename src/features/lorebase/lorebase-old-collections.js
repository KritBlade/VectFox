/**
 * Deleting the old vectorized lorebook collections LoreBase replaced (D5 and §6.4 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md), once collection discovery has filled the registry and SillyTavern has
 * loaded (src/app/retired-collections.js runs it then). Each collection's chat and character locks move to its book's
 * first selection first, then it is deleted with every index discovery found it in, and the notice's lines name the books to
 * choose entries for again. It asks nothing (D5): no old collection can serve LoreBase. A collection that could not be
 * deleted is tried again at the next start, and when none could be, there are no lines.
 */
import { deleteCollectionWhereDiscovered, getCollectionCharacterLocks, getCollectionLocks, getCollectionRegistry } from '../collections/index.js';
import { getContext } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { world_names } from '../../sillytavern/world-info.js';
import { ensureLoreSelection, setLoreSelectionLock } from './lorebase-books.js';
import { oldCollectionsNoticeLines, oldLorebookCollections } from './lorebase-old-collections-core.js';

function moveLocksToBooks(collections) {
    for (const { bookName, chatIds, characterAvatars } of collections) {
        if (!bookName) continue;
        const { id } = ensureLoreSelection(bookName);
        for (const chatId of chatIds) setLoreSelectionLock(bookName, id, { chatId }, true);
        for (const characterAvatar of characterAvatars) setLoreSelectionLock(bookName, id, { characterAvatar }, true);
    }
}

/**
 * Delete the old lorebook collections in the registry. It reads SillyTavern's books and characters, so it runs once
 * SillyTavern has loaded. Never throws.
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<object[]>} The notice's lines, none when nothing was deleted
 */
export async function deleteOldLorebookCollections(settings) {
    try {
        const characters = getContext().characters ?? [];
        const collections = oldLorebookCollections([...getCollectionRegistry()], {
            bookNames: world_names,
            chatLocksOf: getCollectionLocks,
            characterLocksOf: getCollectionCharacterLocks,
            avatarOf: characterId => characters[Number(characterId)]?.avatar ?? null,
        });
        if (!collections.length) return [];
        moveLocksToBooks(collections);
        const deleted = [];
        let failedCount = 0;
        for (const collection of collections) {
            if (await deleteCollectionWhereDiscovered(collection, settings, 'LoreBase')) deleted.push(collection);
            else failedCount += 1;
        }
        log.lifecycle(`LoreBase: deleted ${deleted.length} of ${collections.length} old lorebook collection(s)`);
        return deleted.length ? oldCollectionsNoticeLines({ deleted, failedCount }) : [];
    } catch (error) {
        log.error('LoreBase: deleting the old lorebook collections failed:', error);
        return [];
    }
}
