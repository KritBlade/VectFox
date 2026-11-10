/**
 * @vitest-environment jsdom
 *
 * shared/gui-dna/gene-behaviours.js: setCollapsed folds a card as its chevron does, leaving a card inside it alone;
 * scrollPageToTop opens a page the nav switches to at its top, whichever box of its dialog scrolls it, while nothing
 * outside the dialog moves; and a split's divider moves with the keys within each pane's minimum, writing the width
 * into a stylesheet rule and never onto the split.
 */

/* global document, Element, KeyboardEvent -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import $ from 'jquery';
import {
    SPLIT_KEY_STEP,
    SPLIT_MIN_PANE,
    bindGeneBehaviours,
    scrollPageToTop,
    setCollapsed,
    splitLimits,
    splitWidthAfterKey,
    syncSliders,
} from '../src/shared/gui-dna/gene-behaviours.js';

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

describe('a split divider', () => {
    it('keeps each pane its minimum, and moves a step for an arrow and to a limit for Home and End', () => {
        expect(splitLimits(1000, 12)).toEqual({ min: SPLIT_MIN_PANE, max: 1000 - 12 - SPLIT_MIN_PANE });
        expect(splitLimits(300, 12)).toEqual({ min: SPLIT_MIN_PANE, max: SPLIT_MIN_PANE });
        const limits = { min: 240, max: 748 };
        expect(splitWidthAfterKey(400, 'ArrowRight', limits)).toBe(400 + SPLIT_KEY_STEP);
        expect(splitWidthAfterKey(250, 'ArrowLeft', limits)).toBe(240);
        expect(splitWidthAfterKey(400, 'Home', limits)).toBe(240);
        expect(splitWidthAfterKey(400, 'End', limits)).toBe(748);
        expect(splitWidthAfterKey(400, 'a', limits)).toBeNull();
    });

    it('writes the width into a stylesheet rule for the split, never onto it, and tells a screen reader', () => {
        vi.stubGlobal('$', $);
        document.head.innerHTML = '';
        document.body.innerHTML = '<div id="root"><div id="test_split" class="vfx-split"><section></section>'
            + '<div class="vfx-split-divider" role="separator" tabindex="0"></div><section></section></div></div>';
        // The split is 1000 wide, its divider 12 and its start pane 400.
        const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
            const width = this.id === 'test_split' ? 1000 : (this.classList.contains('vfx-split-divider') ? 12 : 400);
            return { width, left: 0, top: 0, right: width, bottom: 0, height: 0, x: 0, y: 0 };
        });
        bindGeneBehaviours(document.getElementById('root'));
        const divider = document.querySelector('.vfx-split-divider');
        divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(divider.getAttribute('aria-valuenow')).toBe(String(400 + SPLIT_KEY_STEP));
        expect(divider.getAttribute('aria-valuemax')).toBe(String(1000 - 12 - SPLIT_MIN_PANE));
        expect(document.getElementById('test_split').hasAttribute('style')).toBe(false);
        const rule = [...document.querySelector('style[data-vfx-split-widths]').sheet.cssRules].find(each => each.selectorText === '#test_split');
        expect(rule.style.getPropertyValue('--vfx-split-start')).toBe(`${400 + SPLIT_KEY_STEP}px`);
        rects.mockRestore();
    });
});

describe('a slider beside its number box', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"><div class="vfx-slider"><input type="range" class="vfx-range" data-vfx-slider-for="depth" min="1" max="20" step="1"><input type="number" id="depth" min="1" max="20" step="1" value="4"></div></div>';
    });

    it('writes its box, firing the box\'s own input and change, and follows a typed number', () => {
        globalThis.$ = $;
        bindGeneBehaviours(document.getElementById('root'));
        const fired = [];
        $('#depth').on('input change', event => fired.push(`${event.type} ${event.target.value}`));
        const range = document.querySelector('.vfx-range');
        range.value = '9';
        $(range).trigger('input');
        expect(fired).toEqual(['input 9', 'change 9']);
        $('#depth').val('15').trigger('input');
        expect(range.value).toBe('15');
    });

    it('moves to a box code set', () => {
        document.getElementById('depth').value = '12';
        syncSliders(document.getElementById('root'));
        expect(document.querySelector('.vfx-range').value).toBe('12');
    });
});
