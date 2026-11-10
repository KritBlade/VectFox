/**
 * @vitest-environment jsdom
 *
 * shared/gui-dna/gene-behaviours.js: setCollapsed folds a card as its chevron does, leaving a card inside it alone, and
 * scrollPageToTop opens a page the nav switches to at its top, whichever box of its dialog scrolls it, while nothing
 * outside the dialog moves.
 */

/* global document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach } from 'vitest';
import { scrollPageToTop, setCollapsed } from '../src/shared/gui-dna/gene-behaviours.js';

describe('setCollapsed', () => {
    const chevron = '<button type="button" class="vfx-collapse" aria-expanded="true"></button>';

    it('folds and unfolds a card and tells its own chevron, never a nested record\'s', () => {
        document.body.innerHTML = `<section id="card" class="vfx-card"><header>${chevron}</header>`
            + `<div id="record" class="vfx-record">${chevron}</div></section>`;
        const card = document.getElementById('card');
        const [cardChevron, recordChevron] = card.querySelectorAll('.vfx-collapse');
        setCollapsed(card, true);
        expect(card.classList.contains('is-collapsed')).toBe(true);
        expect([cardChevron.getAttribute('aria-expanded'), recordChevron.getAttribute('aria-expanded')]).toEqual(['false', 'true']);
        expect(document.getElementById('record').classList.contains('is-collapsed')).toBe(false);
        setCollapsed(card, false);
        expect(card.classList.contains('is-collapsed')).toBe(false);
        expect(cardChevron.getAttribute('aria-expanded')).toBe('true');
    });
});

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
