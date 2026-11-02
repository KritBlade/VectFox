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

import { escapeHtml } from '../src/shared/html-escape.js';
import { log } from '../src/sillytavern/log.js';

const metadataCache = new Map();

async function getRequestHeadersImport() {
    const mod = await import('../src/sillytavern/requests.js');
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
    const { callGenericPopup, POPUP_TYPE } = await import('../src/sillytavern/popup.js');

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
 * Mirrors the work the dropdown change handler does
 * (ui/ui-manager.js:2929-2952): persist via saveSettingsDebounced, update
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
        await import('../src/features/keyword-search/bm25-scorer.js');
    const { saveSettingsDebounced, extension_settings } = await import('../src/sillytavern/settings.js');

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
    } catch { /* tolerate — UI may not be rendered */ }

    if (savedMode === CJK_TOKENIZER_MODES.jieba) {
        await ensureJiebaTokenizerLoaded();
    } else if (savedMode === CJK_TOKENIZER_MODES.jieba_tw) {
        await ensureJiebaTwLoaded();
    }
}

/**
 * Handle the "Open Settings" choice from the tokenizer mismatch modal.
 *
 * Expands the VectFox inline drawer if collapsed, switches to the Core tab
 * (which contains the CJK Tokenizer Mode dropdown), scrolls the dropdown
 * into view, and briefly focuses it so the user can find what they came for.
 *
 * Previously this branch only aborted the query, leaving the user nowhere —
 * the modal said "Open Settings" but nothing actually opened.
 */
/**
 * Wait until ST's <dialog.popup> elements have finished their close animation
 * and been removed from the DOM. callGenericPopup resolves as soon as a button
 * is clicked, but #hide() sets a `closing` attribute and only removes the
 * dialog after a CSS fade animation — so for ~300ms after click the popup is
 * still visually on top of anything we open behind it.
 *
 * If the popup hasn't cleared within maxWaitMs, fall back to calling
 * completeCancelled() on Popup.util.popups survivors and then removing any
 * stragglers from the DOM directly.
 */
async function waitForPopupsClosed(maxWaitMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const stillVisible = document.querySelectorAll('dialog.popup[open], dialog.popup[closing]').length;
        if (stillVisible === 0) return;
        await new Promise(r => setTimeout(r, 30));
    }

    // Last-resort manual close: walk Popup.util.popups and force completeCancelled on any
    // that survived. Then strip them from the DOM if they still cling on.
    try {
        const { Popup } = await import('../src/sillytavern/popup.js');
        const survivors = (Popup?.util?.popups || []).slice();
        for (const p of survivors) {
            try { await p.completeCancelled(); } catch { /* tolerate */ }
        }
        document.querySelectorAll('dialog.popup[open], dialog.popup[closing]').forEach(d => {
            d.close();
            d.remove();
        });
    } catch (e) {
        log.warn('[TokenizerLock] force-close fallback failed:', e?.message);
    }
}

export async function openCjkTokenizerSetting() {
    try {
        if (typeof $ === 'undefined') {
            log.warn('[TokenizerLock] jQuery ($) is undefined — cannot navigate');
            return;
        }

        // The triggering popup is still mid-fade when callGenericPopup resolves.
        // Wait until it's actually gone before opening drawers behind it.
        await waitForPopupsClosed();

        // Step 1: open ST's top-bar Extensions drawer if it's collapsed.
        // ST wraps #extensions_settings2 (where VectFox mounts) inside
        // #extensions-settings-button, which is a .drawer with a .drawer-toggle.
        // The drawer-icon carries .closedIcon while collapsed and .openIcon when open.
        // Source: SillyTavern/public/index.html (release branch) — searched 2026-05-20.
        const $extToggle = $('#extensions-settings-button').children('.drawer-toggle').first();
        const $extIcon = $extToggle.find('.drawer-icon').first();
        if ($extToggle.length && $extIcon.hasClass('closedIcon')) {
            $extToggle.trigger('click');
        }

        // Step 2: expand VectFox's own inline drawer if collapsed.
        const $drawerToggle = $('#VectFox_settings .inline-drawer-toggle').first();
        if ($drawerToggle.length) {
            const $icon = $drawerToggle.find('.inline-drawer-icon');
            const $content = $drawerToggle.closest('.inline-drawer').find('.inline-drawer-content');
            if ($icon.hasClass('down') || $content.is(':hidden')) {
                $drawerToggle.trigger('click');
            }
        }

        // Step 3: switch to the Core tab.
        const $coreTab = $('#VectFox_settings .vectfox-tab-btn[data-tab="core"]');
        if ($coreTab.length) $coreTab.trigger('click');

        // Step 4: scroll the dropdown into view (deferred so panels finish opening first).
        // 150ms gives ST's slide animations time to settle before we measure positions.
        setTimeout(() => {
            const $select = $('#VectFox_cjk_tokenizer_mode');
            if ($select.length && $select.is(':visible')) {
                $select[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                $select.focus();
            } else {
                // Couldn't surface the panel automatically — tell the user where to look.
                try {
                    toastr.info(
                        'Open the Extensions drawer and look in VectFox → Core → CJK Tokenizer Mode.',
                        'VectFox',
                        { timeOut: 8000 },
                    );
                } catch { /* toastr may not be available */ }
            }
        }, 150);
    } catch (error) {
        log.warn('[TokenizerLock] Failed to navigate to settings:', error?.message);
    }
}
