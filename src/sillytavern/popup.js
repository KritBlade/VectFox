// popup.js — SillyTavern's popups: the generic popup call, the Popup class, and the popup types and results, which the rest
// of VectFox imports here, never from SillyTavern (tools/check-host-imports.mjs). Also the doors a GUI-DNA surface opens its
// dialogs through, which carry .vfx-popup.vfx-ui and are drawn by shared/gui-dna/dialogs.css; the way an element that floats
// over the page, such as the progress panel or a modal opened from the settings panel, is shown above an open popup; and the
// wait for every popup but the settings panel's to finish closing.
//
// FAILURE STANCE: a dialog that cannot open answers NO. A caller guards an action, so "the dialog broke" must never read as
// "the user said yes".
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup, getTopmostModalLayer } from '../../../../../popup.js';
import { log } from './log.js';
import { dialogLineSegments } from './popup-core.js';

export { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup };

/** A dialog's lines as paragraphs (popup-core.js). */
function dialogTextBlock(lines) {
    const block = document.createElement('div');
    block.className = 'vfx-dialog-text';
    for (const line of lines) {
        const segments = dialogLineSegments(line);
        if (!segments.length) continue;
        const paragraph = document.createElement('p');
        for (const segment of segments) {
            if (segment.icon) {
                const icon = document.createElement('i');
                icon.className = 'fa-solid vfx-dialog-icon';
                icon.classList.add(segment.icon);
                icon.setAttribute('aria-hidden', 'true');
                paragraph.append(icon);
            } else if (segment.key) {
                paragraph.append(document.createTextNode(segment.key));
            } else if (segment.isStrong) {
                const value = document.createElement('span');
                value.className = 'vfx-dialog-value';
                value.textContent = segment.value;
                paragraph.append(value);
            } else {
                paragraph.append(document.createTextNode(segment.value));
            }
        }
        block.append(paragraph);
    }
    return block;
}

/** The class on the settings panel's own dialog, which shared/gui-dna/dialogs.css sizes near-fullscreen. */
const PANEL_DIALOG_CLASS = 'is-panel';
const OTHER_OPEN_POPUPS = `dialog.popup:not(.${PANEL_DIALOG_CLASS})[open], dialog.popup:not(.${PANEL_DIALOG_CLASS})[closing]`;

/**
 * Open one dialog in the GUI-DNA frame. Its content scrolls once taller than the window: SillyTavern's popup clips it otherwise.
 * A destructive dialog opens on Cancel: SillyTavern focuses the button of the default answer, and Enter presses the focused
 * button. Resolves to SillyTavern's answer.
 */
function showDialog(content, type, { okButton, cancelButton, isDestructive = false, isPanel = false, isWide = false, popupOptions = {} }) {
    const defaultResult = isDestructive ? POPUP_RESULT.NEGATIVE : POPUP_RESULT.AFFIRMATIVE;
    const popup = new Popup(content, type, '', { okButton, cancelButton, leftAlign: true, allowVerticalScrolling: true, defaultResult, ...popupOptions });
    popup.dlg.classList.add('vfx-popup', 'vfx-ui');
    if (isPanel) popup.dlg.classList.add(PANEL_DIALOG_CLASS);
    if (isWide) popup.dlg.classList.add('is-wide');
    return popup.show();
}

/**
 * Wait until every SillyTavern popup but the settings panel's has finished closing. callGenericPopup resolves as soon as
 * a button is clicked, but the dialog stays on top through its ~300ms close animation, over anything opened behind it.
 * Past maxWaitMs, the popups left are cancelled and removed. The panel's dialog stays open. Never throws.
 *
 * @param {number} [maxWaitMs]
 * @returns {Promise<void>}
 */
export async function waitForOtherPopupsToClose(maxWaitMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        if (!document.querySelector(OTHER_OPEN_POPUPS)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    const popupsLeft = (Popup.util?.popups ?? []).filter(popup => !popup.dlg?.classList.contains(PANEL_DIALOG_CLASS));
    for (const popup of popupsLeft) {
        try {
            await popup.completeCancelled();
        } catch (error) {
            log.warn('A popup would not close, so it is removed:', error);
        }
    }
    for (const dialog of document.querySelectorAll(OTHER_OPEN_POPUPS)) {
        dialog.close();
        dialog.remove();
    }
}

/**
 * Ask the user to confirm. Returns truthy only when they press the action button, and never throws.
 *
 * @param {object[]} lines - What is about to happen (popup-core.js). Say what is lost, not only what is clicked.
 * @param {object} options
 * @param {string} options.okButton - The action, as a verb
 * @param {string} [options.cancelButton]
 * @param {boolean} [options.isDestructive] - Yes deletes, removes, replaces or resets something: the dialog opens on Cancel,
 *     so Enter cancels, and its action stays primary
 * @returns {Promise<*>}
 */
export async function confirmPopup(lines, { okButton, cancelButton = 'Cancel', isDestructive = false }) {
    try {
        return await showDialog(dialogTextBlock(lines), POPUP_TYPE.CONFIRM, { okButton, cancelButton, isDestructive });
    } catch (error) {
        log.warn('A confirm dialog could not open, so it answers no:', error);
        return false;
    }
}

/**
 * Show something that needs no answer: its lines (popup-core.js), then `body`, an element built from the gene builders,
 * such as a read-only preview. Never throws: a dialog that cannot open logs, and the caller carries on.
 *
 * @param {object[]} lines
 * @param {{body?: HTMLElement, isWide?: boolean}} [options] - isWide for a body of long lines
 */
export async function noticePopup(lines, { body = null, isWide = false } = {}) {
    const content = document.createElement('div');
    content.className = 'vfx-stack';
    content.append(dialogTextBlock(lines));
    if (body) content.append(body);
    try {
        await showDialog(content, POPUP_TYPE.TEXT, { okButton: 'Close', cancelButton: false, isWide });
    } catch (error) {
        log.warn('A notice dialog could not open:', error);
    }
}

/**
 * Show a panel in a near-fullscreen dialog and wait until the user closes it. The panel is MOVED into the dialog, never cloned,
 * so every handler keeps working, and the caller moves it back afterwards. Never throws.
 *
 * @param {HTMLElement} panel
 * @param {{canClose?: () => boolean}} [options] - canClose answers false to keep the dialog open, on Escape or Close
 * @returns {Promise<void>}
 */
export async function openPanelPopup(panel, { canClose } = {}) {
    const popupOptions = { large: true, ...(canClose ? { onClosing: () => canClose() } : {}) };
    try {
        await showDialog(panel, POPUP_TYPE.TEXT, { okButton: 'Close', cancelButton: false, isPanel: true, popupOptions });
    } catch (error) {
        log.error('A panel dialog could not open:', error);
    }
}

/** The watcher that moves an element down when the popup holding it starts closing, by element. */
const closingPopupWatchers = new WeakMap();

/**
 * Put an element last on SillyTavern's topmost open popup, or last on the page when no popup is open, as SillyTavern does
 * with its toasts. An open popup is a modal dialog in the browser's top layer: nothing outside it is drawn above it, at
 * any z-index, and nothing outside it can be clicked. When that popup starts closing, the element moves down to the next
 * popup or the page, since SillyTavern removes a closed popup from the page with everything in it.
 *
 * @param {HTMLElement} element
 */
export function placeOnTopmostModalLayer(element) {
    closingPopupWatchers.get(element)?.disconnect();
    closingPopupWatchers.delete(element);
    const layer = getTopmostModalLayer();
    layer.appendChild(element);
    if (layer === document.body) return;
    const watcher = new MutationObserver(() => {
        if (layer.hasAttribute('open') && !layer.hasAttribute('closing')) return;
        // An element its own close removed, or that moved on, stays where it is.
        if (!layer.contains(element)) {
            watcher.disconnect();
            closingPopupWatchers.delete(element);
            return;
        }
        placeOnTopmostModalLayer(element);
    });
    watcher.observe(layer, { attributes: true, attributeFilter: ['open', 'closing'] });
    closingPopupWatchers.set(element, watcher);
}

/**
 * Build a floating surface from its markup and put it on the topmost modal layer, as placeOnTopmostModalLayer does.
 *
 * @param {string} html - Markup with exactly one root element
 * @returns {HTMLElement} the root element
 */
export function placeMarkupOnTopmostModalLayer(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    if (template.content.childElementCount !== 1) {
        throw new Error(`A floating surface needs exactly one root element, and its markup has ${template.content.childElementCount}`);
    }
    const element = template.content.firstElementChild;
    placeOnTopmostModalLayer(element);
    return element;
}
