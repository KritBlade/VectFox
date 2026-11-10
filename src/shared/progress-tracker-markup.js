/**
 * The progress panel's markup on GUI-DNA (progress-tracker.js paints it): a compact card with the run's title, Stop and
 * close, one status line over the bar, one row of pills, the item at work and the errors met. In the page's corner, or
 * on a touch screen over a backdrop that covers the page, where nothing of SillyTavern's can sit above it.
 */

import { button, iconButton, resultList, statusPill } from './gui-dna/gui-dna-core.js';

export const PROGRESS_PANEL_ID = 'VectFox_progress_panel';

/** The pills, in the order the row shows them. */
export const PROGRESS_PILLS = Object.freeze(['items', 'units', 'found', 'time', 'speed']);

const HIDDEN = ' style="display:none;"';

/**
 * @param {{isTouchLayout: boolean}} layout
 * @returns {string}
 */
export function progressPanelMarkup({ isTouchLayout }) {
    const pills = PROGRESS_PILLS.map(part => statusPill({ name: '', isHidden: true, data: { 'progress-part': part } }));
    return `<div id="${PROGRESS_PANEL_ID}" class="vfx-ui vfx-progress${isTouchLayout ? ' is-touch' : ''}"${HIDDEN}>`
        + '<section class="vfx-progress-card">'
        + '<div class="vfx-progress-header">'
        + '<span class="vfx-progress-title" data-progress-part="title"></span>'
        + `<span data-progress-part="stop"${HIDDEN}>${stopButtonMarkup({ isStopping: false })}</span>`
        + iconButton({ icon: 'fa-xmark', title: 'Close', data: { 'progress-action': 'close' } })
        + '</div>'
        + '<div class="vfx-progress-status" aria-live="polite"><span data-progress-part="status"></span><span class="vfx-progress-percent" data-progress-part="percent"></span></div>'
        + '<progress class="vfx-progress-bar" max="100" value="0" data-progress-part="bar"></progress>'
        + `<div class="vfx-progress-pills">${pills.join('')}</div>`
        + `<p class="vfx-hint" data-progress-part="current"${HIDDEN}></p>`
        + `<div data-progress-part="errors"${HIDDEN}></div>`
        + '</section></div>';
}

/** Stop, or Stopping while the run winds down, when nothing more can be asked of it. */
export function stopButtonMarkup({ isStopping }) {
    return isStopping
        ? button({ text: 'Stopping…', icon: 'fa-spinner fa-spin', isDisabled: true })
        : button({ text: 'Stop', icon: 'fa-stop', data: { 'progress-action': 'stop' } });
}

/** The errors a run met, each a line of its own. */
export function progressErrorsMarkup(messages) {
    return resultList({ heading: { text: 'Errors' }, lines: messages.map(name => ({ status: 'danger', name })) });
}
