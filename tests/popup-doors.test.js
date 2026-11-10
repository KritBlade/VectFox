/**
 * @vitest-environment jsdom
 *
 * The dialog doors in src/sillytavern/popup.js: a destructive confirm opens on Cancel, so Enter never says yes to it,
 * and any other dialog opens on its action; a confirm that cannot open answers no; a notice shows its lines, then its
 * body, and a wide one carries .is-wide; a form shows its lines, then the form, focuses the control it names, and
 * submits on Enter in a one-line box only when asked.
 */
/* global document, KeyboardEvent -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({ opened: [], failToOpen: false, answer: true }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: () => {}, error: () => {} } }));

// SillyTavern's Popup, as src/sillytavern/popup.js builds it: the content, the type and the options it was given.
vi.mock('../../../../popup.js', () => ({
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
    Popup: class {
        constructor(content, type, inputValue, options) {
            if (host.failToOpen) throw new Error('no popup today');
            this.dlg = document.createElement('dialog');
            host.opened.push({ content, type, options, dialog: this.dlg });
        }

        show() {
            return Promise.resolve(host.answer);
        }
    },
    callGenericPopup: () => {},
    getTopmostModalLayer: () => document.body,
}));

const { confirmPopup, formPopup, noticePopup } = await import('../src/sillytavern/popup.js');

beforeEach(() => {
    host.opened = [];
    host.failToOpen = false;
    host.answer = true;
});

describe('confirmPopup', () => {
    it('opens a destructive question on Cancel, and keeps its action primary', async () => {
        await confirmPopup([{ text: 'Delete it?' }], { okButton: 'Delete', isDestructive: true });
        expect(host.opened[0].options).toMatchObject({ okButton: 'Delete', cancelButton: 'Cancel', defaultResult: 0 });
        expect(host.opened[0].dialog.classList.contains('vfx-popup')).toBe(true);
    });

    it('opens any other question on its action', async () => {
        await confirmPopup([{ text: 'Merge these names?' }], { okButton: 'Merge' });
        expect(host.opened[0].options.defaultResult).toBe(1);
    });

    it('answers no when the dialog cannot open', async () => {
        host.failToOpen = true;
        expect(await confirmPopup([{ text: 'Delete it?' }], { okButton: 'Delete', isDestructive: true })).toBe(false);
    });
});

describe('noticePopup', () => {
    it('shows its lines, then its body, with one Close button', async () => {
        const body = document.createElement('textarea');
        await noticePopup([{ text: 'Summarizer preview' }, { text: 'Events:', name: '3' }], { body, isWide: true });
        const { content, options, dialog } = host.opened[0];
        expect(content.classList.contains('vfx-stack')).toBe(true);
        expect(content.firstElementChild.classList.contains('vfx-dialog-text')).toBe(true);
        expect(content.firstElementChild.textContent).toBe('Summarizer previewEvents: 3');
        expect(content.lastElementChild).toBe(body);
        expect(options).toMatchObject({ okButton: 'Close', cancelButton: false });
        expect(dialog.classList.contains('is-wide')).toBe(true);
    });

    it('is not wide unless asked, and never throws', async () => {
        await noticePopup([{ text: 'Nothing would be injected this turn.' }]);
        expect(host.opened[0].dialog.classList.contains('is-wide')).toBe(false);
        expect(host.opened[0].content.children).toHaveLength(1);
        host.failToOpen = true;
        await expect(noticePopup([{ text: 'Hello' }])).resolves.toBeUndefined();
    });
});

describe('formPopup', () => {
    const formWith = (html) => {
        const form = document.createElement('div');
        form.innerHTML = html;
        return form;
    };

    it('shows its lines, then the form, with the action and Cancel', async () => {
        const form = formWith('<input id="name" value="Mira">');
        expect(await formPopup([{ text: 'Rename the collection' }], form, { okButton: 'Rename', isWide: true })).toBe(true);
        const { content, options, dialog } = host.opened[0];
        expect(content.firstElementChild.textContent).toBe('Rename the collection');
        expect(content.lastElementChild).toBe(form);
        expect(options).toMatchObject({ okButton: 'Rename', cancelButton: 'Cancel', defaultResult: 1 });
        expect(dialog.classList.contains('is-wide')).toBe(true);
    });

    it('focuses and selects the control it names once open, and submits on Enter in a one-line box when asked', async () => {
        const form = formWith('<input id="name" value="Mira"><textarea id="notes"></textarea>');
        await formPopup([{ text: 'Rename the collection' }], form, { okButton: 'Rename', focusSelector: '#name', isSubmittedOnEnter: true });
        // SillyTavern puts the content in its dialog on the page before onOpen runs.
        document.body.append(host.opened[0].content);
        const popup = { complete: vi.fn() };
        host.opened[0].options.onOpen(popup);
        const box = form.querySelector('#name');
        expect(document.activeElement).toBe(box);
        expect([box.selectionStart, box.selectionEnd]).toEqual([0, 4]);
        form.querySelector('#notes').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(popup.complete).not.toHaveBeenCalled();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(popup.complete).toHaveBeenCalledWith(1);
        host.opened[0].content.remove();
    });

    it('leaves Enter alone unless asked, and answers no when it cannot open', async () => {
        const form = formWith('<input id="name">');
        await formPopup([{ text: 'Collection settings' }], form, { okButton: 'Save' });
        const popup = { complete: vi.fn() };
        host.opened[0].options.onOpen(popup);
        form.querySelector('#name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(popup.complete).not.toHaveBeenCalled();
        host.failToOpen = true;
        expect(await formPopup([{ text: 'Collection settings' }], form, { okButton: 'Save' })).toBe(false);
    });
});
