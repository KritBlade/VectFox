/**
 * @vitest-environment jsdom
 *
 * The progress panel (src/shared/progress-tracker.js) on GUI-DNA: a compact card in the corner, or on a touch screen
 * over a backdrop covering the page; its pills name their units, so an EventBase run counts messages and events where
 * the old panel said "Chunks 12/13 (1 left)"; Stop and close; the verdict stays on the panel; and where show() places
 * it over SillyTavern's popups.
 *
 * The touch layout serves the auto-sync catch-up (backfillCurrentChatWithProgress), which the Playwright e2e cannot
 * reach: it runs a desktop viewport, so `matchMedia('(hover: none) and (pointer: coarse)')` is always false there.
 */
/* global window, document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// progress-tracker.js imports src/sillytavern/log.js, whose host import does not resolve under vitest.
vi.mock('../src/sillytavern/log.js', () => ({
    log: { verbose: () => {}, trace: () => {}, error: () => {}, warn: () => {}, lifecycle: () => {}, log: () => {}, enabled: () => false },
}));

// SillyTavern's popup.js, as src/sillytavern/popup.js imports it. getTopmostModalLayer is SillyTavern 1.19.0's:
// the last open dialog that is not closing, else the page.
vi.mock('../../../../popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: {},
    Popup: class {},
    getTopmostModalLayer: () => Array.from(document.querySelectorAll('dialog[open]:not([closing])')).pop() ?? document.body,
}));

import { ProgressTracker } from '../src/shared/progress-tracker.js';

/** jsdom has no matchMedia, and the tracker keys its layout off `(hover: none) and (pointer: coarse)`. */
function setTouchDevice(isTouch) {
    window.matchMedia = (query) => ({ matches: isTouch && /pointer:\s*coarse/.test(query), media: query });
}

let tracker;
const panel = () => document.getElementById('VectFox_progress_panel');
const part = name => panel().querySelector(`[data-progress-part="${name}"]`);
const isShown = element => element.style.display !== 'none';
const shownPills = () => ['items', 'units', 'found', 'time', 'speed'].map(part).filter(isShown).map(pill => pill.textContent);
const click = action => panel().querySelector(`[data-progress-action="${action}"]`).click();

beforeEach(() => {
    document.body.innerHTML = '';
    setTouchDevice(false);
});

afterEach(() => {
    tracker?.stopTimeUpdater();
    tracker = undefined;
    document.body.innerHTML = '';
});

describe('the progress panel', () => {
    it('floats in the corner as a DNA card, and on a touch screen sits over a backdrop', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Extraction', 10, 'Windows');
        expect(panel().classList.contains('vfx-ui')).toBe(true);
        expect(panel().classList.contains('is-touch')).toBe(false);
        expect(isShown(panel())).toBe(true);

        document.body.innerHTML = '';
        setTouchDevice(true);
        tracker.stopTimeUpdater();
        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');
        expect(tracker.isTouchLayout).toBe(true);
        expect(panel().classList.contains('is-touch')).toBe(true);
    });

    it('counts an EventBase run in windows, messages and events, with units on its speed', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Extraction', 6, 'Windows', { unitLabel: 'Messages', foundLabel: 'Events' });
        tracker.updateEmbeddingProgress(0, 13);
        tracker.stats.lastBatchStartTime = Date.now() - 2000;
        tracker.updateEmbeddingProgress(6, 13);
        tracker.updateChunks(4);
        tracker.updateProgress(3, '4 events found, processing windows...');

        expect(part('title').textContent).toBe('EventBase Extraction');
        expect(part('status').textContent).toBe('4 events found, processing windows...');
        expect(part('percent').textContent).toBe('46%');
        expect(part('bar').value).toBe(46);
        const pills = shownPills();
        expect(pills.slice(0, 3)).toEqual(['Windows 3 / 6', 'Messages 6 of 13', 'Events 4']);
        expect(pills[3]).toMatch(/^\d+\.\d s$/);
        expect(pills[4]).toMatch(/^\d+\.\d messages\/s$/);
    });

    it('says a count once when the items are the units, as a links run counts events', () => {
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 10, 'Events', { unitLabel: 'Events' });
        tracker.updateProgress(3);
        tracker.updateEmbeddingProgress(3, 10);
        expect(shownPills().filter(text => text.startsWith('Events'))).toEqual(['Events 3 / 10']);
    });

    it('shows Stop while a run can stop, Stopping once asked, and stops through its handler', () => {
        tracker = new ProgressTracker();
        const stop = vi.fn();
        tracker.show('EventBase Extraction', 6, 'Windows');
        expect(isShown(part('stop'))).toBe(false);
        tracker.setCancelHandler(stop);
        expect(isShown(part('stop'))).toBe(true);

        click('stop');
        expect(stop).toHaveBeenCalledTimes(1);
        expect(part('stop').textContent).toContain('Stopping…');
        expect(part('stop').querySelector('button').disabled).toBe(true);
        expect(part('status').textContent).toBe('Stopping…');
    });

    it('keeps the verdict on the panel until the user closes it, through a repaint', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Extraction', 6, 'Windows');
        tracker.setCancelHandler(() => {});
        tracker.complete(true, 'EventBase: extracted 9 event(s) from 6 window(s); 1 message waits for the next window');
        tracker.updateProgress(6);

        expect(part('status').textContent).toMatch(/^EventBase: extracted 9 event\(s\) from 6 window\(s\); 1 message waits for the next window \(\d+\.\d s\)$/);
        expect(panel().dataset.progressOutcome).toBe('success');
        expect(part('bar').value).toBe(100);
        expect(isShown(part('stop'))).toBe(false);
        expect(isShown(panel())).toBe(true);

        click('close');
        expect(isShown(panel())).toBe(false);
        expect(tracker.isVisible).toBe(false);
        expect(tracker.reopen()).toBe(true);
        expect(part('status').textContent).toContain('1 message waits for the next window');
    });

    it('lists the errors a run met as text, never as markup', () => {
        tracker = new ProgressTracker();
        tracker.show('Importing Collection', 3, 'Steps');
        tracker.addError('<img src=x onerror=alert(1)> refused');
        expect(isShown(part('errors'))).toBe(true);
        expect(part('errors').querySelector('img')).toBeNull();
        expect(part('errors').textContent).toContain('<img src=x onerror=alert(1)> refused');
    });

    it('starts the next run clean: no verdict, no errors, no item line', () => {
        tracker = new ProgressTracker();
        tracker.show('Importing Collection', 3, 'Steps');
        tracker.updateCurrentItem('vf_lorebook_harbor');
        tracker.addError('refused');
        tracker.complete(false, 'Import failed');
        tracker.show('Exporting Collection', 3, 'Steps');

        expect(panel().dataset.progressOutcome).toBeUndefined();
        expect(isShown(part('errors'))).toBe(false);
        expect(isShown(part('current'))).toBe(false);
        expect(part('status').textContent).toBe('Starting…');
    });

    it('never touches the content-vectorizer dialog, so the headless catch-up cannot strand on it', () => {
        const stray = document.createElement('div');
        stray.id = 'vectfox_content_vectorizer';
        stray.style.display = 'none';
        document.body.appendChild(stray);
        setTouchDevice(true);
        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');
        tracker.complete(true, 'done');
        click('close');
        expect(document.getElementById('vectfox_content_vectorizer').style.display).toBe('none');
    });
});

/**
 * A popup as SillyTavern's Popup shows one: a dialog on the page, opened. jsdom has no showModal(), so the dialog
 * gets the `open` attribute showModal() sets. That an open popup hides everything outside it is the browser's top
 * layer, which jsdom does not draw.
 */
function openPopup() {
    const popup = document.createElement('dialog');
    popup.className = 'popup';
    popup.setAttribute('open', '');
    document.body.appendChild(popup);
    return popup;
}

/** What SillyTavern's Popup does first when it hides: it marks the popup closing, and removes it after its animation. */
function startClosing(popup) {
    popup.setAttribute('closing', '');
}

/** Lets a MutationObserver's callback run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the progress panel over a SillyTavern popup', () => {
    it('shows inside the topmost open popup, the only place drawn above it', () => {
        const lower = openPopup();
        const upper = openPopup();
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 600, 'Events');

        expect(tracker.panel.parentElement).toBe(upper);
        expect(lower.contains(tracker.panel)).toBe(false);
    });

    it('skips a popup that is closing, such as the confirm popup a run starts from', () => {
        const page = openPopup();
        const confirm = openPopup();
        startClosing(confirm);
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 600, 'Events');

        expect(tracker.panel.parentElement).toBe(page);
    });

    it('moves down to the page when its popup starts closing, so removing the popup keeps it', async () => {
        const popup = openPopup();
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 600, 'Events');

        startClosing(popup);
        await settle();
        expect(tracker.panel.parentElement).toBe(document.body);

        popup.removeAttribute('open');
        popup.remove();
        expect(tracker.panel.isConnected).toBe(true);
    });

    it('moves to the popup underneath when the top one closes', async () => {
        const lower = openPopup();
        const upper = openPopup();
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 600, 'Events');

        startClosing(upper);
        await settle();
        expect(tracker.panel.parentElement).toBe(lower);

        startClosing(lower);
        await settle();
        expect(tracker.panel.parentElement).toBe(document.body);
    });

    it('stays on the page when no popup is open', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Extraction', 10, 'Windows');

        expect(tracker.panel.parentElement).toBe(document.body);
    });

    it('puts the touch layout inside the popup too', () => {
        setTouchDevice(true);
        const popup = openPopup();
        tracker = new ProgressTracker();
        tracker.show('Linking story events', 600, 'Events');

        expect(tracker.panel.classList.contains('is-touch')).toBe(true);
        expect(tracker.panel.parentElement).toBe(popup);
    });
});
