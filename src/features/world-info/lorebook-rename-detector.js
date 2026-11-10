/**
 * ============================================================================
 * VectFox LOREBOOK RENAME DETECTOR
 * ============================================================================
 * Detects when a vectorized lorebook collection references a sourceName that
 * no longer matches any lorebook in ST (renamed or deleted), and asks the user
 * whether to fix it in the Database Browser or inject the stale content.
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';

// ============================================================================
// INTERNALS
// ============================================================================

async function getWorldNames() {
    try {
        const mod = await import('../../sillytavern/world-info.js');
        return Array.isArray(mod.world_names) ? mod.world_names : [];
    } catch (error) {
        log.warn('[LorebookRename] could not read the lorebook names:', error);
        return [];
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Check which lorebook collections reference a sourceName not in ST's world_names.
 * Skips collections with no sourceName (pre-metadata collections or fallback IDs).
 *
 * @param {Array<{id: string, name: string, sourceName: string|null}>} collections
 * @returns {Promise<Array<{id: string, name: string, sourceName: string}>>}
 */
export async function detectLorebookRenames(collections) {
    const worldNames = await getWorldNames();
    // If world_names is empty we can't distinguish "renamed" from "module not loaded yet" — skip.
    if (!worldNames.length) return [];

    return collections.filter(c => c.sourceName && !worldNames.includes(c.sourceName));
}

/**
 * Ask what to do about vectorized lorebooks whose lorebook is gone from SillyTavern:
 *   'open_browser' — open the Database Browser (the caller stops the reply first)
 *   'continue'     — use their stale content this turn, which Escape answers too
 *
 * @param {Array<{id: string, sourceName: string}>} mismatches
 * @returns {Promise<'open_browser'|'continue'>}
 */
export async function askLorebookRenameQuestion(mismatches) {
    const { choicePopup } = await import('../../sillytavern/popup.js');
    const choice = await choicePopup([
        { icon: 'fa-book', text: 'These vectorized lorebooks match no lorebook in SillyTavern, so they were renamed or deleted:' },
        ...mismatches.map(mismatch => ({ name: mismatch.sourceName })),
        { text: 'VectFox injects what they held when vectorized. To fix it, delete the collection and vectorize the lorebook again.' },
        { text: 'Open Database Browser stops this reply. Continue anyway uses the old content this turn.' },
    ], { choices: [{ text: 'Continue anyway', value: 'continue' }, { text: 'Open Database Browser', value: 'open_browser' }], cancelButton: false });
    return choice ?? 'continue';
}

/**
 * Open the VectFox Database Browser after waiting for the popup fade-out animation.
 * Must be called AFTER stopGeneration() so the browser opens into a clean state.
 */
export async function openDatabaseBrowserForRename() {
    // Wait for the modal's close animation to finish before opening the browser behind it.
    const { waitForOtherPopupsToClose } = await import('../../sillytavern/popup.js');
    await waitForOtherPopupsToClose();

    try {
        const { openDatabaseBrowser } = await import('../database-browser/index.js');
        openDatabaseBrowser();
    } catch (e) {
        log.warn('[LorebookRename] Could not open Database Browser:', e?.message);
        // Fallback: open the settings panel on its Action page, where the Database Browser button is.
        try {
            if (typeof $ === 'undefined') return;
            $('#VectFox_tab_action').trigger('click');
            $('#VectFox_open_panel').trigger('click');
            setTimeout(() => {
                const $dbBtn = $('#VectFox_database_browser');
                if ($dbBtn.length) {
                    $dbBtn[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    $dbBtn.focus();
                } else {
                    // toastr is SillyTavern's page global, absent where no page is loaded.
                    globalThis.toastr?.info(
                        'Open VectFox from the Extensions drawer, then Action → Database Browser.',
                        'VectFox',
                        { timeOut: 8000 },
                    );
                }
            }, 150);
        } catch (navErr) {
            log.warn('[LorebookRename] Fallback navigation failed:', navErr?.message);
        }
    }
}
