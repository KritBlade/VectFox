/**
 * Deleting the collections VectFox no longer reads, once collection discovery has filled the registry: the old
 * vectorized lorebooks LoreBase replaced (features/lorebase/lorebase-old-collections.js) and the collections Vectorize
 * Content made from sources it no longer reads (features/collections/retired-content-collections.js). One notice says
 * both (D5 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md). It asks nothing: none of them
 * can serve VectFox again. A collection that could not be deleted is tried again at the next start.
 */
import { deleteRetiredContentCollections } from '../features/collections/index.js';
import { deleteOldLorebookCollections } from '../features/lorebase/index.js';
import { event_types, eventSource } from '../sillytavern/events.js';
import { log } from '../sillytavern/log.js';
import { noticePopup } from '../sillytavern/popup.js';

let deletionInFlight = null;

// SillyTavern calls an APP_READY listener added after that event at once.
const appReady = () => new Promise(resolve => eventSource.once(event_types.APP_READY, resolve));

/**
 * Delete the collections VectFox no longer reads, then show one notice when any went. Waits for SillyTavern to have
 * loaded, as the lorebook part reads its books and characters; a second call while one runs joins it. Never throws.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<void>}
 */
export function deleteRetiredCollections(settings) {
    deletionInFlight ??= (async () => {
        try {
            await appReady();
            const lines = [...await deleteOldLorebookCollections(settings), ...await deleteRetiredContentCollections(settings)];
            if (lines.length) await noticePopup(lines);
        } catch (error) {
            log.error('VectFox: deleting the collections VectFox no longer reads failed:', error);
        } finally {
            deletionInFlight = null;
        }
    })();
    return deletionInFlight;
}
