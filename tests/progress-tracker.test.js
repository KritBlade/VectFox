/**
 * @vitest-environment jsdom
 *
 * ProgressTracker — mobile full-screen vs desktop floating panel.
 *
 * Covers the mobile path exercised by the auto-sync "Catch up now" backfill
 * (ui-manager.js → backfillCurrentChatWithProgress), which the Playwright e2e
 * cannot reach: that suite runs a desktop viewport with no touch/mobile project,
 * so `matchMedia('(hover: none) and (pointer: coarse)')` is always false there.
 *
 * The tracker is self-contained DOM (its only import is core/log.js), so jsdom +
 * a mocked matchMedia exercises the real createPanel/show/complete/hide logic.
 */
/* global window, document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// progress-tracker.js imports core/log.js, which imports ../../../../extensions.js
// (a SillyTavern host path that doesn't resolve under vitest — and under the jsdom
// environment vite's import-analysis errors on it rather than externalizing).
// Mock log.js directly so its real source (and that import) is never transformed.
// The tracker only calls log.verbose / log.trace.
vi.mock('../core/log.js', () => ({
    log: { verbose: () => {}, trace: () => {}, error: () => {}, warn: () => {}, lifecycle: () => {}, log: () => {}, enabled: () => false },
}));

import { ProgressTracker } from '../ui/progress-tracker.js';

/**
 * Mock window.matchMedia. jsdom does not implement it, and the tracker keys its
 * mobile/desktop layout off `(hover: none) and (pointer: coarse)`.
 */
function setTouchDevice(isTouch) {
    window.matchMedia = (query) => ({
        matches: isTouch && /pointer:\s*coarse/.test(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    });
}

let tracker;

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    // startTimeUpdater() runs a setInterval; clear it so no handle leaks between tests.
    if (tracker?.timeIntervalId) {
        clearInterval(tracker.timeIntervalId);
        tracker.timeIntervalId = null;
    }
    tracker = undefined;
    document.body.innerHTML = '';
});

describe('ProgressTracker — mobile (touch) full-screen modal', () => {
    beforeEach(() => setTouchDevice(true));

    it('renders a full-screen modal with its own close button', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');

        expect(tracker.isModal).toBe(true);

        const panel = document.getElementById('VectFox_progress_panel');
        expect(panel).not.toBeNull();
        // Full-screen modal layout (mirrors the Text Cleaning modal), not the
        // floating corner panel.
        expect(panel.classList.contains('vectfox-modal')).toBe(true);
        expect(panel.classList.contains('vectfox-progress-modal')).toBe(true);
        expect(panel.querySelector('.vectfox-modal-overlay')).not.toBeNull();

        // Self-contained dismissal — its own close button, no dependency on any
        // other modal being open.
        expect(document.getElementById('VectFox_progress_close')).not.toBeNull();

        expect(tracker.isVisible).toBe(true);
        expect(panel.style.display).toBe('block');
    });

    it('complete() leaves the panel visible (user closes manually)', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');
        tracker.complete(true, 'extracted 75 events from 26 windows');

        const panel = document.getElementById('VectFox_progress_panel');
        expect(tracker.isComplete).toBe(true);
        // Deliberately NOT auto-hidden — the headless catch-up relies on the user
        // dismissing the full-screen panel themselves.
        expect(panel.style.display).toBe('block');
        expect(tracker.isVisible).toBe(true);
    });

    it('the close button tears the panel down (hide)', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');

        document.getElementById('VectFox_progress_close').click();

        const panel = document.getElementById('VectFox_progress_panel');
        expect(panel.style.display).toBe('none');
        expect(tracker.isVisible).toBe(false);
    });

    it('never touches the content-vectorizer modal (headless catch-up cannot strand on it)', () => {
        // Simulate the auto-sync enable flow: the vectorizer modal is NOT open.
        // A stray, hidden modal element shouldn't be revealed/removed by the tracker.
        const stray = document.createElement('div');
        stray.id = 'vectfox_content_vectorizer_modal';
        stray.style.display = 'none';
        document.body.appendChild(stray);

        tracker = new ProgressTracker();
        tracker.show('EventBase Catch-Up', 26, 'Windows');
        tracker.complete(true, 'done');
        document.getElementById('VectFox_progress_close').click();

        const after = document.getElementById('vectfox_content_vectorizer_modal');
        expect(after).not.toBeNull();
        expect(after.style.display).toBe('none'); // untouched
    });
});

describe('ProgressTracker — desktop (non-touch) floating panel', () => {
    beforeEach(() => setTouchDevice(false));

    it('renders the floating corner panel, not a modal', () => {
        tracker = new ProgressTracker();
        tracker.show('EventBase Extraction', 10, 'Windows');

        expect(tracker.isModal).toBe(false);

        const panel = document.getElementById('VectFox_progress_panel');
        expect(panel).not.toBeNull();
        expect(panel.classList.contains('vectfox-progress-panel')).toBe(true);
        expect(panel.classList.contains('vectfox-modal')).toBe(false);
        expect(panel.querySelector('.vectfox-modal-overlay')).toBeNull();
        // Close button exists on both layouts (shared header).
        expect(document.getElementById('VectFox_progress_close')).not.toBeNull();
    });
});
