/**
 * ============================================================================
 * PANEL PAGE GENES
 * ============================================================================
 * The genes with parts that a page of the settings panel writes as static markup and
 * that gui-dna-core.js, generated from mvu-helper, does not build: a card's header, a
 * switch row, an action card and the danger zone (mvu-helper/devdoc/gui-dna.md §5). Each
 * takes the id its page's wiring finds the control by. Every word passed in is escaped;
 * `actions` is markup from the builders. Pure: builds strings.
 * ============================================================================
 */

import { escapeHtmlAttribute as escape } from '../html-escape.js';

const COLLAPSE_BUTTON = '<button type="button" class="vfx-collapse" aria-expanded="true" title="Show or hide"><i class="fa-solid fa-chevron-up"></i></button>';

const iconTag = (icon, extraClass = '') => `<i class="fa-solid ${escape(icon)}${extraClass}"></i>`;

/**
 * A card's header: its badge, title and one-line description, then any actions and the collapse chevron.
 *
 * @param {{icon: string, title: string, description?: string, actions?: string}} card
 * @returns {string}
 */
export function cardHeader({ icon, title, description = '', actions = '' }) {
    return '<header class="vfx-card-header">'
        + `<span class="vfx-badge">${iconTag(icon)}</span>`
        + `<h3 class="vfx-card-title">${escape(title)}</h3>`
        + (description ? `<p class="vfx-card-desc">${escape(description)}</p>` : '')
        + (actions ? `<div class="vfx-card-actions">${actions}</div>` : '')
        + COLLAPSE_BUTTON
        + '</header>';
}

/**
 * A switch row: the switch, its title and its one-line description. `isSpan` takes the grid's whole row.
 *
 * @param {{id: string, title: string, description: string, isSpan?: boolean}} row
 * @returns {string}
 */
export function switchRow({ id, title, description, isSpan = false }) {
    return `<label class="vfx-switch-row${isSpan ? ' vfx-span' : ''}">`
        + `<input type="checkbox" role="switch" id="${escape(id)}" class="vfx-switch">`
        + `<span class="vfx-switch-title">${escape(title)}</span>`
        + `<span class="vfx-switch-desc">${escape(description)}</span>`
        + '</label>';
}

/**
 * An action card: icon, title, a description of at most two lines, and the button that runs it. The page's one
 * primary card, `isPrimary`, has the primary button.
 *
 * @param {{icon: string, title: string, description: string, button: {id: string, text: string, icon: string}, isPrimary?: boolean}} card
 * @returns {string}
 */
export function actionCard({ icon, title, description, button, isPrimary = false }) {
    return `<div class="vfx-action-card${isPrimary ? ' is-primary' : ''}">`
        + iconTag(icon, ' vfx-action-icon')
        + `<span class="vfx-action-title">${escape(title)}</span>`
        + `<p class="vfx-action-desc">${escape(description)}</p>`
        + `<button type="button" id="${escape(button.id)}" class="vfx-btn${isPrimary ? ' vfx-btn-primary' : ''}">${iconTag(button.icon)}<span>${escape(button.text)}</span></button>`
        + '</div>';
}

/**
 * The danger zone, last on its page: its title, "Requires confirmation." and its danger buttons. Each button's
 * tooltip says what it destroys.
 *
 * @param {{title: string, buttons: {id: string, icon: string, text: string, tooltip: string}[]}} zone
 * @returns {string}
 */
export function dangerZone({ title, buttons }) {
    const dangerButtons = buttons.map(({ id, icon, text, tooltip }) => `<button type="button" id="${escape(id)}" class="vfx-btn vfx-btn-danger" title="${escape(tooltip)}">${iconTag(icon)}<span>${escape(text)}</span></button>`);
    return '<div class="vfx-danger-zone">'
        + iconTag('fa-trash-can', ' vfx-danger-icon')
        + `<div class="vfx-danger-text"><p class="vfx-danger-title">${escape(title)}</p><p class="vfx-danger-desc">Requires confirmation.</p></div>`
        + `<div class="vfx-danger-actions">${dangerButtons.join('')}</div>`
        + '</div>';
}
