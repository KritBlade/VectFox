/**
 * ============================================================================
 * TOKENIZER MODE LOCK
 * ============================================================================
 * When Qdrant native sparse vectors are enabled, the active CJK tokenizer mode
 * is baked into the indexed sparse vectors via FNV-1a hashes. A later mode
 * switch silently breaks query→indexed token matching.
 *
 * This module:
 *   - Reads the per-collection sentinel metadata (cached per session)
 *   - Compares the saved mode against the current setting
 *   - Shows a blocking modal so the user can revert the mode or accept the cost
 *
 * Returns null when the collection has no sentinel (legacy / non-migrated collections).
 *
 * @author VectFox
 * @since Phase 2 — Qdrant native sparse vectors
 * ============================================================================
 */

import { escapeHtml } from '../../shared/html-escape.js';
import { log } from '../../sillytavern/log.js';

const metadataCache = new Map();

async function getRequestHeadersImport() {
    const mod = await import('../../sillytavern/requests.js');
    return mod.getRequestHeaders;
}

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
        const getRequestHeaders = await getRequestHeadersImport();
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
 * Compare saved tokenizer mode to the current setting. Returns null when no mismatch,
 * or `{ saved, current }` when the user must take action.
 *
 * @param {object} settings - VectFox settings (reads `cjk_tokenizer_mode`)
 * @param {string} actualCollectionId
 * @returns {Promise<{saved: string, current: string} | null>}
 */
export async function detectTokenizerMismatch(settings, actualCollectionId) {
    const payload = await fetchCollectionMetadata(actualCollectionId);
    if (!payload || !payload.cjk_tokenizer_mode) return null; // collection has no sentinel (legacy / non-sparse)
    const current = settings.cjk_tokenizer_mode;
    if (payload.cjk_tokenizer_mode === current) return null;
    return { saved: payload.cjk_tokenizer_mode, current };
}

/**
 * Show the tokenizer mismatch modal. Returns the user's choice:
 *   'revert'   — revert setting to `saved` and retry
 *   'settings' — keep current setting, do not retry (user will purge/re-vector manually)
 *   'cancel'   — abort the operation
 *
 * @param {{saved: string, current: string}} mismatch
 * @param {string} actualCollectionId
 * @returns {Promise<'revert'|'settings'|'cancel'>}
 */
export async function showTokenizerMismatchModal(mismatch, actualCollectionId) {
    const { callGenericPopup, POPUP_TYPE } = await import('../../sillytavern/popup.js');

    const html = `
        <h3>Tokenizer Mode Mismatch</h3>
        <p>This Qdrant collection (<code>${escapeHtml(actualCollectionId)}</code>) was vectorized with the
        <code>${escapeHtml(mismatch.saved)}</code> CJK tokenizer.</p>
        <p>Your current setting is <code>${escapeHtml(mismatch.current)}</code>.</p>
        <p>Querying with a different tokenizer produces inaccurate BM25 results because
        sparse-vector indices are tokenizer-specific.</p>
        <p>To switch tokenizer modes for this collection you must
        <strong>delete the collection and re-vectorize from scratch.</strong></p>
        <p style="margin-top:1em;">Choose:</p>
        <ul>
            <li><strong>Revert</strong> — switch CJK mode back to <code>${escapeHtml(mismatch.saved)}</code> and continue.</li>
            <li><strong>Open Settings</strong> — keep current mode; you will purge and re-vectorize this collection.</li>
            <li><strong>Cancel</strong> — abort this query.</li>
        </ul>
    `;

    const choice = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: `Revert to ${mismatch.saved}`,
        cancelButton: 'Cancel',
        customButtons: ['Open Settings'],
        wide: false,
    });

    // callGenericPopup returns:
    //   true (or 1)  for OK / first button
    //   false / null for cancel
    //   2+           for customButtons (index in array, 1-based after ok)
    if (choice === true || choice === 1) return 'revert';
    if (choice === 2) return 'settings';
    return 'cancel';
}

/**
 * Apply the "Revert to <saved>" action from the tokenizer mismatch modal.
 *
 * Symptom this exists to fix: the original revert path only mutated the
 * `settings` reference and the module-local mode, leaving the actual setting
 * unpersisted, the UI dropdown out of sync, and (for jieba modes) the WASM
 * tokenizer not loaded. From the user's perspective the language never
 * actually changed.
 *
 * Mirrors the work the #VectFox_cjk_tokenizer_mode change handler in
 * src/features/settings-panel/settings-panel.js does: persist via saveSettingsDebounced, update
 * the dropdown, fire the namespaced eventbasePromptSync handler so the
 * EventBase extraction prompt matches the reverted language, and await
 * WASM loading for jieba / jieba_tw so the imminent sparse encoding step
 * uses the correct tokenizer.
 *
 * @param {string} savedMode - The collection's locked tokenizer mode
 * @param {object} settings - VectFox settings reference (caller's copy)
 */
export async function applyTokenizerRevert(savedMode, settings) {
    const { setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded, CJK_TOKENIZER_MODES } =
        await import('../keyword-search/index.js');
    const { saveSettingsDebounced, extension_settings } = await import('../../sillytavern/settings.js');

    settings.cjk_tokenizer_mode = savedMode;
    setCjkTokenizerMode(savedMode);

    if (extension_settings?.vectfox) {
        Object.assign(extension_settings.vectfox, settings);
    }
    saveSettingsDebounced();

    try {
        if (typeof $ !== 'undefined') {
            const $select = $('#VectFox_cjk_tokenizer_mode');
            if ($select.length) {
                $select.val(savedMode);
                // Fire only the namespaced prompt-sync handler; the main
                // change handler would redundantly redo everything above
                // (and would re-await WASM, doubling the wait).
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
export async function openCjkTokenizerSetting() {
    try {
        if (typeof $ === 'undefined') {
            log.warn('[TokenizerLock] jQuery ($) is undefined — cannot navigate');
            return;
        }

        // The triggering popup is still mid-fade when callGenericPopup resolves.
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
