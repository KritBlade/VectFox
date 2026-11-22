/**
 * Collection in use here, on the AutoSync page (§1.2 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * a collection chosen in its dropdown is put in use in the open chat through EventBase's one lock function, which
 * unlocks the chat's other own collections there, and the page is drawn again, so the auto-sync status and switch follow
 * the collection now in use. New collection, its last choice, opens Vectorize Content on New collection and changes
 * nothing until that runs. The dropdown itself is drawn by autoSyncCollectionMarkup on each refresh.
 */
import { AUTOSYNC_IN_USE_ID } from './autosync-page-markup.js';
import { IN_USE_NEW } from './in-use-switcher-markup.js';

/**
 * Wire Collection in use here's choices. Called once, as the panel is mounted.
 * @param {object} settings - VectFox settings
 * @param {(settings: object) => Promise<void>} redrawAutoSync - Draws the AutoSync status, switch and dropdown again
 */
export function bindCollectionInUse(settings, redrawAutoSync) {
    $('#VectFox_autosync_collection').on('change', `#${AUTOSYNC_IN_USE_ID}`, async function () {
        // "None in use here" puts nothing in use: the Database Browser's lock switch takes a collection out of use.
        if (!this.value) return;
        if (this.value === IN_USE_NEW) {
            const { openContentVectorizer } = await import('../eventbase/index.js');
            // The dropdown goes back to the collection in use, as nothing changes until the new one is read.
            await redrawAutoSync(settings);
            openContentVectorizer({ isOnNewCollection: true });
            return;
        }
        const { useChatCollection } = await import('../eventbase/index.js');
        useChatCollection(this.value);
        await redrawAutoSync(settings);
        document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    });
}
