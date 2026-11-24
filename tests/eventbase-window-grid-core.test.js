/**
 * The windows EventBase reads a chat in (src/features/eventbase/eventbase-window-grid-core.js): full windows on the
 * chat's grid, a short tail left for later, and a stretch snapped outward to the windows that hold its ends.
 */

import { describe, it, expect } from 'vitest';
import { chatWindowsOf, windowsInStretch } from '../src/features/eventbase/eventbase-window-grid-core.js';

describe('chatWindowsOf', () => {
    it('cuts a chat into full windows from its first message, leaving a tail shorter than a window', () => {
        expect(chatWindowsOf({ messageCount: 7, windowSize: 2, step: 2 })).toEqual([
            { start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 },
        ]);
    });

    it('repeats the overlap, each window starting a step after the last', () => {
        expect(chatWindowsOf({ messageCount: 6, windowSize: 3, step: 2 })).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    });

    it('starts at a later first window and stops at a boundary before the chat\'s end', () => {
        expect(chatWindowsOf({ messageCount: 12, windowSize: 2, step: 2, firstWindowStart: 3, boundary: 9 })).toEqual([
            { start: 3, end: 4 }, { start: 5, end: 6 }, { start: 7, end: 8 },
        ]);
    });
});

describe('windowsInStretch', () => {
    const windows = chatWindowsOf({ messageCount: 12, windowSize: 2, step: 2 });

    it('snaps outward to the window that holds each end, counting messages from 1', () => {
        expect(windowsInStretch(windows, { startFromMessage: 4, endAtMessage: 7 })).toEqual([
            { start: 2, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 7 },
        ]);
    });

    it('reaches the chat\'s end with no end, and starts at its first window from message 1', () => {
        expect(windowsInStretch(windows, { startFromMessage: 1, endAtMessage: null })).toEqual(windows);
    });

    it('takes every window holding an end where windows overlap', () => {
        const overlapping = chatWindowsOf({ messageCount: 8, windowSize: 3, step: 2 });
        expect(windowsInStretch(overlapping, { startFromMessage: 3, endAtMessage: 3 })).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    });

    it('holds no window when the end comes before the start', () => {
        expect(windowsInStretch(windows, { startFromMessage: 9, endAtMessage: 4 })).toEqual([]);
    });
});
