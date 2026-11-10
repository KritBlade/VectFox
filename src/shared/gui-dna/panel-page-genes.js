/**
 * ============================================================================
 * PANEL PAGE GENES
 * ============================================================================
 * The genes with parts that a page of a VectFox shell (the settings panel, the Database
 * Browser) writes as static markup and that gui-dna-core.js, generated from mvu-helper,
 * does not build: a nav item, a page's header, a card's header, a switch row, a slider
 * with its number box, a button found by its id, an action card and the danger zone
 * (mvu-helper/devdoc/gui-dna.md §5). Each takes the id its page's wiring finds the
 * control by. Every word passed in is escaped; `actions` and `status` are markup from
 * the builders. Pure: builds strings.
 * ============================================================================
 */

import { escapeHtmlAttribute as escape } from '../html-escape.js';
import { input } from './gui-dna-core.js';

const COLLAPSE_BUTTON = '<button type="button" class="vfx-collapse" aria-expanded="true" title="Show or hide"><i class="fa-solid fa-chevron-up"></i></button>';

const iconTag = (icon, extraClass = '') => `<i class="fa-solid ${escape(icon)}${extraClass}"></i>`;

/**
 * The nav's brand: VectFox's wolf (Font Awesome has no fox) and the shell's name.
 *
 * @param {string} title - VectFox, or the tool the shell holds
 * @returns {string}
 */
export function navBrand(title) {
    return `<div class="vfx-nav-brand"><i class="fa-brands fa-wolf-pack-battalion"></i><span>${escape(title)}</span></div>`;
}

/**
 * A nav item: its icon and title. The shown page's item is `isActive`, marked as the current page.
 *
 * @param {{id: string, icon: string, title: string, isActive?: boolean}} item
 * @returns {string}
 */
export function navItem({ id, icon, title, isActive = false }) {
    return `<button type="button" id="${escape(id)}" class="vfx-nav-item${isActive ? ' is-active' : ''}"${isActive ? ' aria-current="page"' : ''}>`
        + `${iconTag(icon)}<span>${escape(title)}</span></button>`;
}

/**
 * A page's header: its icon, "<group> / <title>" as the eyebrow, the title and the one-line subtitle, then its pills.
 *
 * @param {{icon: string, eyebrow: string, title: string, subtitle: string, status?: string}} header
 * @returns {string}
 */
export function pageHeader({ icon, eyebrow, title, subtitle, status = '' }) {
    return '<header class="vfx-page-header">'
        + `<span class="vfx-page-icon">${iconTag(icon)}</span>`
        + '<div class="vfx-page-heading">'
        + `<div class="vfx-page-eyebrow">${escape(eyebrow)}</div>`
        + `<h2 class="vfx-page-title">${escape(title)}</h2>`
        + `<p class="vfx-page-subtitle">${escape(subtitle)}</p>`
        + '</div>'
        + (status ? `<div class="vfx-page-status">${status}</div>` : '')
        + '</header>';
}

/**
 * A card's header: its badge, title and one-line description, then any actions and the collapse chevron. A pane of a
 * split is not `isCollapsible`: folded, it would leave its half of the split empty.
 *
 * @param {{icon: string, title: string, description?: string, actions?: string, isCollapsible?: boolean}} card
 * @returns {string}
 */
export function cardHeader({ icon, title, description = '', actions = '', isCollapsible = true }) {
    return '<header class="vfx-card-header">'
        + `<span class="vfx-badge">${iconTag(icon)}</span>`
        + `<h3 class="vfx-card-title">${escape(title)}</h3>`
        + (description ? `<p class="vfx-card-desc">${escape(description)}</p>` : '')
        + (actions ? `<div class="vfx-card-actions">${actions}</div>` : '')
        + (isCollapsible ? COLLAPSE_BUTTON : '')
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
 * A slider beside its number box. The box owns the value and the id; the shell keeps the slider on it
 * (panel-shell.js), and the box takes an exact value where a long range is hard to hit by dragging. `title` names
 * the slider for a screen reader. Disabling the box does not disable the slider: the wiring disables both.
 *
 * @param {{id: string, min: number, max: number, step: number, title: string}} slider
 * @returns {string}
 */
export function sliderNumber({ id, min, max, step, title }) {
    const limits = `min="${escape(String(min))}" max="${escape(String(max))}" step="${escape(String(step))}"`;
    return '<div class="vfx-slider">'
        + `<input type="range" class="vfx-range" data-vfx-slider-for="${escape(id)}" ${limits} title="${escape(title)}">`
        + input({ id, type: 'number', min, max, step })
        + '</div>';
}

/**
 * A button its page's wiring finds by `id`: icon and words. `isPrimary` gives it the primary fill.
 *
 * @param {{id: string, text: string, icon: string, isPrimary?: boolean}} button
 * @returns {string}
 */
export function buttonWithId({ id, text, icon, isPrimary = false }) {
    return `<button type="button" id="${escape(id)}" class="vfx-btn${isPrimary ? ' vfx-btn-primary' : ''}">${iconTag(icon)}<span>${escape(text)}</span></button>`;
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
        + buttonWithId({ ...button, isPrimary })
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
