/**
 * ============================================================================
 * PUBLICAPI PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's PublicAPI page on GUI-DNA, in the Development group: the
 * switch that puts VectFox's mark on the signal of each request its LLM calls
 * send, for a usage tracker that reads it (Doc/public-api.md, VectFox's own LLM
 * calls). The public API writes the mark while the switch is on (public-api.js).
 * The control keeps the id settings-panel.js wires it by. Pure: builds strings.
 * ============================================================================
 */

import { cardHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

function requestMarkCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-stamp', title: 'Request mark', description: 'Off by default. Turn it on when an extension you use asks for it.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_own_request_mark_enabled', title: 'Mark VectFox\'s LLM requests', description: 'Lets a usage tracker tell VectFox\'s calls from the story reply. Nothing sent changes.', isSpan: true })}
        </div>
    </section>`;
}

/**
 * The page's content under its header.
 *
 * @returns {string}
 */
export function publicApiPageMarkup() {
    return requestMarkCard();
}
