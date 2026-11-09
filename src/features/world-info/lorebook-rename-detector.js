/**
 * ============================================================================
 * VectFox LOREBOOK RENAME DETECTOR
 * ============================================================================
 * Detects when a vectorized lorebook collection references a sourceName that
 * no longer matches any lorebook in ST (renamed or deleted). Shows a blocking
 * popup so the user can re-vectorize before stale content is injected.
 *
 * Its popup closes through sillytavern/popup.js, as tokenizer-lock.js does.
 * ============================================================================
 */

import { escapeHtml } from '../../shared/html-escape.js';
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
 * Show a blocking center-screen popup listing mismatched lorebook collections.
 *
 * Returns:
 *   'open_browser' — user wants to open the Database Browser (caller must stop generation)
 *   'continue'     — user chose to proceed with stale content
 *
 * @param {Array<{id: string, sourceName: string}>} mismatches
 * @returns {Promise<'open_browser'|'continue'>}
 */
export async function showLorebookRenameModal(mismatches) {
    const { callGenericPopup, POPUP_TYPE } = await import('../../sillytavern/popup.js');

    const list = mismatches
        .map(m => `<li><code>${escapeHtml(m.sourceName)}</code></li>`)
        .join('');

    const html = `
        <h3>Lorebook Mismatch Detected</h3>
        <p>The following vectorized lorebook(s) no longer match any lorebook in SillyTavern.
        The lorebook may have been <strong>renamed or deleted</strong> after vectorization:</p>
        <ul>${list}</ul>
        <p>VectFox will inject stale vectorized content. To fix this, delete the stale
        collection and re-vectorize the current lorebook.</p>
        <hr style="margin: 1em 0;">
        <ul>
            <li><strong>Open Database Browser</strong> — stop generation and manage collections.</li>
            <li><strong>Continue Anyway</strong> — inject stale content for this turn only.</li>
        </ul>
    `;

    const choice = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Continue Anyway',
        cancelButton: null,
        customButtons: ['Open Database Browser'],
    });

    // callGenericPopup: true/1 = okButton (Continue Anyway), 2 = customButtons[0] (Open DB Browser)
    if (choice === 2) return 'open_browser';
    return 'continue';
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
