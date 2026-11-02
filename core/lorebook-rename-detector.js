/**
 * ============================================================================
 * VectFox LOREBOOK RENAME DETECTOR
 * ============================================================================
 * Detects when a vectorized lorebook collection references a sourceName that
 * no longer matches any lorebook in ST (renamed or deleted). Shows a blocking
 * popup so the user can re-vectorize before stale content is injected.
 *
 * Popup close + generation-stop pattern mirrors core/tokenizer-lock.js.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';
import { log } from './log.js';

// ============================================================================
// INTERNALS
// ============================================================================

async function getWorldNames() {
    try {
        const mod = await import('../../../../world-info.js');
        return Array.isArray(mod.world_names) ? mod.world_names : [];
    } catch {
        return [];
    }
}

/**
 * Wait for ST's dialog.popup fade-out before opening anything behind it.
 * Mirrors the same function in core/tokenizer-lock.js — the popup resolves
 * immediately on button click but the CSS close animation runs for ~300ms.
 */
async function waitForPopupsClosed(maxWaitMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const stillVisible = document.querySelectorAll('dialog.popup[open], dialog.popup[closing]').length;
        if (stillVisible === 0) return;
        await new Promise(r => setTimeout(r, 30));
    }
    // Last-resort: force-complete any survivors, then strip from DOM.
    try {
        const { Popup } = await import('../../../../../scripts/popup.js');
        const survivors = (Popup?.util?.popups || []).slice();
        for (const p of survivors) {
            try { await p.completeCancelled(); } catch { /* tolerate */ }
        }
        document.querySelectorAll('dialog.popup[open], dialog.popup[closing]').forEach(d => {
            d.close();
            d.remove();
        });
    } catch (e) {
        log.warn('[LorebookRename] force-close fallback failed:', e?.message);
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
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');

    const list = mismatches
        .map(m => `<li><code>${StringUtils.escapeHtml(m.sourceName)}</code></li>`)
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
    // Wait for the modal's CSS close animation to finish before opening the drawer.
    // Same timing fix as openCjkTokenizerSetting() in tokenizer-lock.js.
    await waitForPopupsClosed();

    try {
        const { openDatabaseBrowser } = await import('../ui/database-browser.js');
        openDatabaseBrowser();
    } catch (e) {
        log.warn('[LorebookRename] Could not open Database Browser:', e?.message);
        // Fallback: scroll the Database Browser button into view so user can click it.
        try {
            if (typeof $ === 'undefined') return;
            const $extToggle = $('#extensions-settings-button').children('.drawer-toggle').first();
            const $extIcon = $extToggle.find('.drawer-icon').first();
            if ($extToggle.length && $extIcon.hasClass('closedIcon')) {
                $extToggle.trigger('click');
            }
            setTimeout(() => {
                const $dbBtn = $('#VectFox_database_browser');
                if ($dbBtn.length) {
                    $dbBtn[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    $dbBtn.focus();
                } else {
                    try {
                        toastr.info(
                            'Open the Extensions drawer and click the VectFox Database Browser button.',
                            'VectFox',
                            { timeOut: 8000 },
                        );
                    } catch { /* toastr may not be available */ }
                }
            }, 150);
        } catch (navErr) {
            log.warn('[LorebookRename] Fallback navigation failed:', navErr?.message);
        }
    }
}
