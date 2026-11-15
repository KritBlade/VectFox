/**
 * Deleting the old vectorized lorebook collections LoreBase replaced (D5 and §6.4 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md), once collection discovery has filled the registry. Each collection's
 * chat and character locks move to its book's record first, then it is deleted with every index discovery found it
 * in, and one notice names the books to choose entries for again. It asks nothing (D5): no old collection can serve
 * LoreBase. A collection that could not be deleted is tried again at the next start, and when none could be, no
 * notice shows.
 */
import { deleteCollection, discoveredIndexesOf, getCollectionCharacterLocks, getCollectionLocks, getCollectionRegistry } from '../collections/index.js';
import { getContext } from '../../sillytavern/chat.js';
import { event_types, eventSource } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { noticePopup } from '../../sillytavern/popup.js';
import { world_names } from '../../sillytavern/world-info.js';
import { setLoreBookLock } from './lorebase-books.js';
import { oldCollectionsNoticeLines, oldLorebookCollections } from './lorebase-old-collections-core.js';

let deletionInFlight = null;

// SillyTavern calls an APP_READY listener added after that event at once.
const appReady = () => new Promise(resolve => eventSource.once(event_types.APP_READY, resolve));

function moveLocksToBooks(collections) {
    for (const { bookName, chatIds, characterAvatars } of collections) {
        if (!bookName) continue;
        for (const chatId of chatIds) setLoreBookLock(bookName, { chatId }, true);
        for (const characterAvatar of characterAvatars) setLoreBookLock(bookName, { characterAvatar }, true);
    }
}

/** Delete one collection where discovery found it, as the Database Browser does. Whether it is fully gone. */
async function deleteOldCollection(collection, settings) {
    const found = discoveredIndexesOf(collection.registryKey);
    const collectionSettings = {
        ...settings,
        vector_backend: found?.backend ?? collection.backend ?? settings.vector_backend,
        _discoveredSources: found?.sources ?? [],
    };
    try {
        const result = await deleteCollection(collection.collectionId, collectionSettings, collection.registryKey);
        if (!result.success) log.warn(`LoreBase: the old lorebook collection ${collection.collectionId} was only partly deleted:`, result.errors);
        return result.success;
    } catch (error) {
        log.warn(`LoreBase: the old lorebook collection ${collection.collectionId} could not be deleted:`, error);
        return false;
    }
}

/**
 * Delete the old lorebook collections in the registry, then show the notice. Waits for SillyTavern to have loaded, as
 * it reads the books and characters there; a second call while one runs joins it. Never throws.
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<void>}
 */
export function deleteOldLorebookCollections(settings) {
    deletionInFlight ??= (async () => {
        try {
            await appReady();
            const characters = getContext().characters ?? [];
            const collections = oldLorebookCollections([...getCollectionRegistry()], {
                bookNames: world_names,
                chatLocksOf: getCollectionLocks,
                characterLocksOf: getCollectionCharacterLocks,
                avatarOf: characterId => characters[Number(characterId)]?.avatar ?? null,
            });
            if (!collections.length) return;
            moveLocksToBooks(collections);
            const deleted = [];
            let failedCount = 0;
            for (const collection of collections) {
                if (await deleteOldCollection(collection, settings)) deleted.push(collection);
                else failedCount += 1;
            }
            log.lifecycle(`LoreBase: deleted ${deleted.length} of ${collections.length} old lorebook collection(s)`);
            if (deleted.length) await noticePopup(oldCollectionsNoticeLines({ deleted, failedCount }));
        } catch (error) {
            log.error('LoreBase: deleting the old lorebook collections failed:', error);
        } finally {
            deletionInFlight = null;
        }
    })();
    return deletionInFlight;
}
