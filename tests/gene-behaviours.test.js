/**
 * @vitest-environment jsdom
 *
 * shared/gui-dna/gene-behaviours.js scrollPageToTop: a page the nav switches to opens at its top, whichever box of its
 * dialog scrolls it, and nothing outside the dialog moves.
 */

/* global document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach } from 'vitest';
import { scrollPageToTop } from '../src/shared/gui-dna/gene-behaviours.js';

describe('scrollPageToTop', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="outside">
                <dialog id="dialog" open>
                    <div id="scroller"><div id="main"><section id="page"></section></div></div>
                </dialog>
            </div>
            <div id="holder"><section id="loose-page"></section></div>`;
    });

    it('scrolls every box from the page up to its dialog back to the top', () => {
        for (const id of ['outside', 'dialog', 'scroller', 'main']) document.getElementById(id).scrollTop = 500;
        scrollPageToTop(document.getElementById('page'));
        expect(['dialog', 'scroller', 'main'].map(id => document.getElementById(id).scrollTop)).toEqual([0, 0, 0]);
        expect(document.getElementById('outside').scrollTop).toBe(500);
    });

    it('leaves a page outside a dialog alone', () => {
        document.getElementById('holder').scrollTop = 300;
        scrollPageToTop(document.getElementById('loose-page'));
        scrollPageToTop(null);
        expect(document.getElementById('holder').scrollTop).toBe(300);
    });
});
