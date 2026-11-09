/**
 * @vitest-environment jsdom
 *
 * The doors src/sillytavern/popup.js gives a VectFox modal opened over SillyTavern's popups, such as the settings
 * panel's dialog: a modal built from markup goes into the topmost popup, the only place drawn above it; one its own
 * close removed stays removed when that popup closes; and a wait for the other popups to close leaves the panel's
 * dialog open.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({ popups: [] }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: () => {}, error: () => {} } }));

// SillyTavern's popup.js, as src/sillytavern/popup.js imports it. getTopmostModalLayer is SillyTavern 1.19.0's:
// the last open dialog that is not closing, else the page.
vi.mock('../../../../popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: {},
    Popup: class {
        static util = { get popups() { return host.popups; } };
    },
    callGenericPopup: () => {},
    getTopmostModalLayer: () => Array.from(document.querySelectorAll('dialog[open]:not([closing])')).pop() ?? document.body,
}));

const { placeMarkupOnTopmostModalLayer, waitForOtherPopupsToClose } = await import('../src/sillytavern/popup.js');

function openPopup({ isPanel = false } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = isPanel ? 'popup vfx-popup is-panel' : 'popup';
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    return dialog;
}

const startClosing = dialog => dialog.setAttribute('closing', '');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const MODAL = '<div id="a_modal" class="vectfox-modal"><button type="button">Close</button></div>';

beforeEach(() => {
    document.body.innerHTML = '';
    host.popups = [];
});

describe('placeMarkupOnTopmostModalLayer', () => {
    it('builds the modal inside the topmost open popup, and returns its root', () => {
        openPopup();
        const panel = openPopup({ isPanel: true });
        const modal = placeMarkupOnTopmostModalLayer(`\n    ${MODAL}\n`);
        expect(modal.id).toBe('a_modal');
        expect(modal.parentElement).toBe(panel);
    });

    it('builds it on the page when no popup is open', () => {
        expect(placeMarkupOnTopmostModalLayer(MODAL).parentElement).toBe(document.body);
    });

    it('refuses markup without exactly one root element', () => {
        expect(() => placeMarkupOnTopmostModalLayer(`${MODAL}${MODAL}`)).toThrow('exactly one root element');
        expect(() => placeMarkupOnTopmostModalLayer('   ')).toThrow('exactly one root element');
    });

    it('moves an open modal down to the page when its popup starts closing', async () => {
        const panel = openPopup({ isPanel: true });
        const modal = placeMarkupOnTopmostModalLayer(MODAL);
        startClosing(panel);
        await settle();
        expect(modal.parentElement).toBe(document.body);
    });

    it('leaves a modal its own close removed off the page when its popup closes', async () => {
        const panel = openPopup({ isPanel: true });
        const modal = placeMarkupOnTopmostModalLayer(MODAL);
        modal.remove();
        startClosing(panel);
        await settle();
        expect(modal.isConnected).toBe(false);
        expect(document.getElementById('a_modal')).toBeNull();
    });
});

describe('waitForOtherPopupsToClose', () => {
    it('returns at once while only the panel\'s dialog is open, and leaves it open', async () => {
        const panel = openPopup({ isPanel: true });
        await waitForOtherPopupsToClose(1000);
        expect(panel.isConnected).toBe(true);
        expect(panel.hasAttribute('open')).toBe(true);
    });

    it('waits until another popup has gone', async () => {
        const confirm = openPopup();
        setTimeout(() => confirm.remove(), 40);
        const start = Date.now();
        await waitForOtherPopupsToClose(1000);
        expect(Date.now() - start).toBeGreaterThanOrEqual(30);
        expect(confirm.isConnected).toBe(false);
    });

    it('cancels and removes the popups left after its wait, and never the panel\'s dialog', async () => {
        const panel = openPopup({ isPanel: true });
        const stuck = openPopup();
        stuck.close = () => stuck.removeAttribute('open');
        const cancelled = [];
        host.popups = [
            { dlg: panel, completeCancelled: async () => cancelled.push('panel') },
            { dlg: stuck, completeCancelled: async () => cancelled.push('stuck') },
        ];
        await waitForOtherPopupsToClose(40);
        expect(cancelled).toEqual(['stuck']);
        expect(stuck.isConnected).toBe(false);
        expect(panel.isConnected).toBe(true);
    });
});
