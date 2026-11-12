/**
 * ============================================================================
 * MANUAL CONNECTION NOTICE
 * ============================================================================
 * The notice that manual OpenRouter and vLLM retire (connection plan row N1, §7):
 * shown once per install, after SillyTavern has finished loading, at the first
 * start where VectFox is on and a Provider dropdown holds one of them. A start
 * where none does shows nothing and leaves it for a later one.
 * ============================================================================
 */

import { event_types, eventSource } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { noticePopup } from '../../sillytavern/popup.js';
import { saveSettingsDebounced } from '../../sillytavern/settings.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { manualConnectionNoticeLines, manualConnections } from './manual-connection-notice-core.js';

/**
 * Show the notice if this start is the one: it has not shown on this install, VectFox is on, and a Provider dropdown
 * holds manual OpenRouter or vLLM. It is marked shown before it opens, so a reload while it is open does not show it
 * again.
 *
 * @param {object} settings - extension_settings.vectfox, the store itself
 * @returns {Promise<boolean>} Whether it showed
 */
export async function showManualConnectionNotice(settings) {
    if (settings.has_shown_manual_connection_retirement_notice || !isVectFoxEnabled(settings)) return false;
    const connections = manualConnections(settings);
    if (!connections.length) return false;
    settings.has_shown_manual_connection_retirement_notice = true;
    saveSettingsDebounced();
    await noticePopup(manualConnectionNoticeLines(connections, { vectorBackend: settings.vector_backend }), { isWide: true });
    return true;
}

/**
 * Show the notice once SillyTavern has finished loading. SillyTavern calls an APP_READY listener added after that
 * event at once.
 *
 * @param {object} settings - extension_settings.vectfox, the store itself
 */
export function scheduleManualConnectionNotice(settings) {
    eventSource.once(event_types.APP_READY, () => {
        showManualConnectionNotice(settings).catch(error => {
            log.error('VectFox: the notice that manual OpenRouter and vLLM retire failed:', error);
        });
    });
}
