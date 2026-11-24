/**
 * ============================================================================
 * EVENTBASE WINDOW GRID — pure logic
 * ============================================================================
 * The windows EventBase reads a chat in. Window k holds messages
 * first + k * step to first + k * step + size - 1, where step is size - overlap,
 * so a window keeps its first and last message from run to run. A tail shorter
 * than a window waits for more messages. A stretch from one message to another
 * takes every window from the one that holds its first message to the one that
 * holds its last, so it snaps outward to whole windows.
 *
 * runEventBaseIngestion reads by these windows, and Vectorize Content counts a
 * stretch it reads again by them (eventbase-read-range-again.md).
 * ============================================================================
 */

/**
 * A chat's full windows, from its first window start up to a boundary.
 *
 * @param {{messageCount: number, windowSize: number, step: number, firstWindowStart?: number, boundary?: number}} grid -
 *   messageCount: the messages read, counted as the run counts them; boundary: the first message no window may hold,
 *   the chat's end unless said
 * @returns {{start: number, end: number}[]} each window's first and last message, counted from 0
 */
export function chatWindowsOf({ messageCount, windowSize, step, firstWindowStart = 0, boundary = messageCount }) {
    const windows = [];
    for (let start = firstWindowStart; start + windowSize <= boundary; start += step) {
        windows.push({ start, end: start + windowSize - 1 });
    }
    return windows;
}

/**
 * The windows of a stretch: from the window that holds its first message to the one that holds its last.
 *
 * @param {{start: number, end: number}[]} windows - From chatWindowsOf, in order
 * @param {{startFromMessage?: number, endAtMessage?: number|null}} stretch - Messages counted from 1; an end of null
 *   reaches the chat's end
 * @returns {{start: number, end: number}[]}
 */
export function windowsInStretch(windows, { startFromMessage = 1, endAtMessage = null }) {
    return windows.filter(window => window.end >= startFromMessage - 1 && (endAtMessage == null || window.start <= endAtMessage - 1));
}
