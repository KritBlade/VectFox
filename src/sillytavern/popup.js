// popup.js — SillyTavern's popups: the generic popup call, the Popup class, and the popup types and results, which the rest
// of VectFox imports here, never from SillyTavern (tools/check-host-imports.mjs). Also the doors a GUI-DNA surface opens its
// dialogs through, which carry .vfx-popup.vfx-ui and are drawn by shared/gui-dna/dialogs.css.
//
// FAILURE STANCE: a dialog that cannot open answers NO. A caller guards an action, so "the dialog broke" must never read as
// "the user said yes".
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../../../popup.js';
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

/**
 * Open one dialog in the GUI-DNA frame. Its content scrolls once taller than the window: SillyTavern's popup clips it otherwise.
 * Resolves to SillyTavern's answer.
 */
function showDialog(content, type, { okButton, cancelButton, isPanel = false, popupOptions = {} }) {
    const popup = new Popup(content, type, '', { okButton, cancelButton, leftAlign: true, allowVerticalScrolling: true, ...popupOptions });
    popup.dlg.classList.add('vfx-popup', 'vfx-ui');
    if (isPanel) popup.dlg.classList.add('is-panel');
    return popup.show();
}

/**
 * Ask the user to confirm. Returns truthy only when they press the action button, and never throws.
 *
 * @param {object[]} lines - What is about to happen (popup-core.js)
 * @param {{okButton: string, cancelButton?: string}} options - okButton is the action, as a verb
 * @returns {Promise<*>}
 */
export async function confirmPopup(lines, { okButton, cancelButton = 'Cancel' }) {
    try {
        return await showDialog(dialogTextBlock(lines), POPUP_TYPE.CONFIRM, { okButton, cancelButton });
    } catch (error) {
        log.warn('A confirm dialog could not open, so it answers no:', error);
        return false;
    }
}

/**
 * Show a panel in a near-fullscreen dialog and wait until the user closes it. The panel is MOVED into the dialog, never cloned,
 * so every handler keeps working, and the caller moves it back afterwards. Never throws.
 *
 * @param {HTMLElement} panel
 * @returns {Promise<void>}
 */
export async function openPanelPopup(panel) {
    try {
        await showDialog(panel, POPUP_TYPE.TEXT, { okButton: 'Close', cancelButton: false, isPanel: true, popupOptions: { large: true } });
    } catch (error) {
        log.error('A panel dialog could not open:', error);
    }
}
