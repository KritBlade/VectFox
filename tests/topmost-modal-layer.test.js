/**
 * @vitest-environment jsdom
 *
 * The doors src/sillytavern/popup.js gives a floating surface opened over SillyTavern's popups, such as the progress
 * panel over a dialog: it goes into the topmost popup, the only place drawn above it; one its own close removed stays
 * removed when that popup closes; and a wait for the other popups to close leaves the panel's dialog open.
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

const { placeOnTopmostModalLayer, waitForOtherPopupsToClose } = await import('../src/sillytavern/popup.js');

function openPopup({ isPanel = false } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = isPanel ? 'popup vfx-popup is-panel' : 'popup';
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    return dialog;
}

const startClosing = dialog => dialog.setAttribute('closing', '');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function floatingSurface() {
    const surface = document.createElement('div');
    surface.id = 'a_surface';
    return surface;
}

beforeEach(() => {
    document.body.innerHTML = '';
    host.popups = [];
});

describe('placeOnTopmostModalLayer', () => {
    it('puts the surface inside the topmost open popup', () => {
        openPopup();
        const panel = openPopup({ isPanel: true });
        const surface = floatingSurface();
        placeOnTopmostModalLayer(surface);
        expect(surface.parentElement).toBe(panel);
    });

    it('puts it on the page when no popup is open', () => {
        const surface = floatingSurface();
        placeOnTopmostModalLayer(surface);
        expect(surface.parentElement).toBe(document.body);
    });

    it('moves an open surface down to the page when its popup starts closing', async () => {
        const panel = openPopup({ isPanel: true });
        const surface = floatingSurface();
        placeOnTopmostModalLayer(surface);
        startClosing(panel);
        await settle();
        expect(surface.parentElement).toBe(document.body);
    });

    it('leaves a surface its own close removed off the page when its popup closes', async () => {
        const panel = openPopup({ isPanel: true });
        const surface = floatingSurface();
        placeOnTopmostModalLayer(surface);
        surface.remove();
        startClosing(panel);
        await settle();
        expect(surface.isConnected).toBe(false);
        expect(document.getElementById('a_surface')).toBeNull();
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
