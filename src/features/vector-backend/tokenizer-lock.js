/**
 * ============================================================================
 * TOKENIZER MODE LOCK
 * ============================================================================
 * When Qdrant native sparse vectors are enabled, the active CJK tokenizer mode
 * is baked into the indexed sparse vectors via FNV-1a hashes. A later mode
 * switch silently breaks query→indexed token matching.
 *
 * Before a search, settleTokenizerMismatch reads the collection's sentinel
 * metadata (cached per session) and compares its mode with the saved setting.
 * When they differ it asks the user, in one blocking question for every search
 * that meets the mismatch while it is open, to revert the setting or stop the
 * reply. A collection with no sentinel (legacy or non-sparse) is never locked.
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';

const metadataCache = new Map();

/** The question open now, as a promise of its answer, shared by every search that meets a mismatch meanwhile. */
let openQuestion = null;

/**
 * Fetch the sentinel metadata for a Qdrant collection. Cached per-session.
 * @param {string} actualCollectionId - the resolved Qdrant collection name (after multitenancy resolution)
 * @returns {Promise<object|null>}
 */
export async function fetchCollectionMetadata(actualCollectionId) {
    if (metadataCache.has(actualCollectionId)) {
        return metadataCache.get(actualCollectionId);
    }
    try {
        const resp = await fetch('/api/plugins/similharity/chunks/collection-metadata', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backend: 'qdrant', collectionId: actualCollectionId }),
        });
        if (!resp.ok) {
            metadataCache.set(actualCollectionId, null);
            return null;
        }
        const data = await resp.json();
        const payload = data?.payload || null;
        metadataCache.set(actualCollectionId, payload);
        return payload;
    } catch (error) {
        log.warn('[TokenizerLock] Failed to fetch collection metadata:', error.message);
        metadataCache.set(actualCollectionId, null);
        return null;
    }
}

/**
 * Invalidate the cached sentinel for a collection (e.g. after migration or purge).
 */
export function invalidateCollectionMetadata(actualCollectionId) {
    metadataCache.delete(actualCollectionId);
}

/**
 * Settle a Qdrant collection's CJK tokenizer lock before a search. The search goes on when the collection was made
 * with the tokenizer VectFox is set to, or once the user answers Revert; it stops on Open Settings or Cancel, which
 * also stop the reply. One question at a time: Agent Mode sends a reply's searches together, so a search that meets a
 * mismatch while the question is open waits for that answer instead of asking again.
 *
 * @param {object} settings - The search's settings, often its own copy (EventBase search's carries its own threshold);
 *   its CJK tokenizer is set to the saved setting, so a copy made before a Revert follows it
 * @param {string} actualCollectionId - The resolved Qdrant collection name
 * @returns {Promise<boolean>} Whether the search goes on
 */
export async function settleTokenizerMismatch(settings, actualCollectionId) {
    for (;;) {
        if (openQuestion && (await openQuestion) !== 'revert') return false;
        const madeWith = (await fetchCollectionMetadata(actualCollectionId))?.cjk_tokenizer_mode;
        // Read once the record has arrived, so a Revert answered meanwhile counts.
        const current = extension_settings.vectfox?.cjk_tokenizer_mode;
        if (current) settings.cjk_tokenizer_mode = current;
        if (!madeWith || madeWith === current) return true;
        // Another search asked while this one read the collection's record: its answer serves this one too.
        if (openQuestion) continue;
        openQuestion = askAboutMismatch({ saved: madeWith, current }, actualCollectionId);
        let choice;
        try {
            choice = await openQuestion;
        } finally {
            openQuestion = null;
        }
        if (choice !== 'revert') return false;
        settings.cjk_tokenizer_mode = madeWith;
        return true;
    }
}

/**
 * Ask about a mismatch and carry out the answer: Revert saves the collection's mode as the setting; Open Settings and
 * Cancel stop the reply, so it does not go on with a search that found nothing, and Open Settings shows the setting.
 *
 * @param {{saved: string, current: string}} mismatch
 * @param {string} actualCollectionId
 * @returns {Promise<'revert'|'settings'|'cancel'>}
 */
async function askAboutMismatch(mismatch, actualCollectionId) {
    const debugLog = log.enabled('lifecycle');
    if (debugLog) log.lifecycle(`[TokenizerLock] Mismatch: collection=${mismatch.saved}, current=${mismatch.current} — prompting user`);
    const choice = await askTokenizerMismatchQuestion(mismatch, actualCollectionId);
    if (debugLog) log.lifecycle(`[TokenizerLock] User chose: ${choice}`);
    if (choice === 'revert') {
        await applyTokenizerRevert(mismatch.saved);
        return choice;
    }
    try {
        const { stopGeneration } = await import('../../sillytavern/generation.js');
        stopGeneration();
    } catch (error) {
        log.warn('[TokenizerLock] could not stop the reply:', error);
    }
    if (choice === 'settings') void openCjkTokenizerSetting();
    return choice;
}

/**
 * Ask what to do about a collection made with another CJK tokenizer than the one set:
 *   'revert'   — set the CJK tokenizer back to the collection's, and go on
 *   'settings' — keep the setting and show it, to delete the collection and vectorize it again
 *   'cancel'   — stop, which Cancel and Escape answer
 *
 * @param {{saved: string, current: string}} mismatch
 * @param {string} actualCollectionId
 * @returns {Promise<'revert'|'settings'|'cancel'>}
 */
async function askTokenizerMismatchQuestion(mismatch, actualCollectionId) {
    const { choicePopup } = await import('../../sillytavern/popup.js');
    const { languageModeLabel } = await import('../keyword-search/index.js');
    const choice = await choicePopup([
        { icon: 'fa-language', text: 'This collection was vectorized with another CJK tokenizer.' },
        { text: 'Collection:', name: actualCollectionId },
        { text: 'Vectorized with:', name: languageModeLabel(mismatch.saved) },
        { text: 'Set now:', name: languageModeLabel(mismatch.current) },
        { text: 'BM25 finds its words only with the tokenizer it was made with. To use another, delete the collection and vectorize it again.' },
        { text: 'Revert sets the CJK tokenizer back and goes on. Open Settings and Cancel stop this reply.' },
    ], { choices: [{ text: 'Revert', value: 'revert' }, { text: 'Open Settings', value: 'settings' }] });
    return choice ?? 'cancel';
}

/**
 * Apply the Revert answer: save the collection's mode as the CJK tokenizer setting, and nothing else of
 * the search's settings, show it in the dropdown, sync the EventBase extraction prompt to its language, and load the
 * Jieba tokenizer it needs before the search encodes its query.
 *
 * Mirrors the work the #VectFox_cjk_tokenizer_mode change handler in src/features/settings-panel/settings-panel.js
 * does; the dropdown fires only its namespaced eventbasePromptSync handler, as the main handler would redo the rest.
 *
 * @param {string} savedMode - The collection's locked tokenizer mode
 */
async function applyTokenizerRevert(savedMode) {
    const { setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded, CJK_TOKENIZER_MODES } =
        await import('../keyword-search/index.js');

    setCjkTokenizerMode(savedMode);
    if (extension_settings.vectfox) {
        extension_settings.vectfox.cjk_tokenizer_mode = savedMode;
    }
    saveSettingsDebounced();

    try {
        if (typeof $ !== 'undefined') {
            const $select = $('#VectFox_cjk_tokenizer_mode');
            if ($select.length) {
                $select.val(savedMode);
                $select.trigger('change.eventbasePromptSync');
            }
        }
    } catch (error) {
        log.warn('[TokenizerLock] could not show the saved mode in its dropdown:', error);
    }

    if (savedMode === CJK_TOKENIZER_MODES.jieba) {
        await ensureJiebaTokenizerLoaded();
    } else if (savedMode === CJK_TOKENIZER_MODES.jieba_tw) {
        await ensureJiebaTwLoaded();
    }
}

/**
 * Handle the "Open Settings" choice from the tokenizer mismatch modal: open the
 * settings panel on its Core page, which holds the CJK Tokenizer Mode dropdown,
 * scroll the dropdown into view and focus it.
 */
async function openCjkTokenizerSetting() {
    try {
        if (typeof $ === 'undefined') {
            log.warn('[TokenizerLock] jQuery ($) is undefined — cannot navigate');
            return;
        }

        // The question is still mid-fade when its answer arrives.
        // Wait until it's actually gone before opening the panel behind it.
        const { waitForOtherPopupsToClose } = await import('../../sillytavern/popup.js');
        await waitForOtherPopupsToClose();

        // The Core page, then the panel's launcher, which opens on the page last shown
        // and only shows that page when the panel is open already (settings-panel/panel-shell.js).
        $('#VectFox_tab_core').trigger('click');
        $('#VectFox_open_panel').trigger('click');

        // Scroll the dropdown into view, deferred so the dialog has finished opening.
        setTimeout(() => {
            const $select = $('#VectFox_cjk_tokenizer_mode');
            if ($select.length && $select.is(':visible')) {
                $select[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                $select.focus();
            } else {
                // Couldn't surface the panel automatically — tell the user where to look.
                // toastr is SillyTavern's page global, absent where no page is loaded.
                globalThis.toastr?.info(
                    'Open VectFox from the Extensions drawer, then Core → CJK Tokenizer Mode.',
                    'VectFox',
                    { timeOut: 8000 },
                );
            }
        }, 150);
    } catch (error) {
        log.warn('[TokenizerLock] Failed to navigate to settings:', error?.message);
    }
}
