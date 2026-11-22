/**
 * How SillyTavern's World Info scan activated each entry, read while a reply's scan runs (world-info-activations-core.js):
 * the lines SillyTavern prints through console.debug, and its WORLDINFO_SCAN_DONE event at the end of each loop.
 * VectFox's reader goes on top of console.debug at each start, again whenever another extension wrapped it since, and
 * passes every call on as it came; it reads only from startReadingActivations to stopReadingActivations, so the rest
 * of the time it costs one check a call. A reader that reads no line, such as one under another extension's wrapper
 * that holds back SillyTavern's lines, leaves every entry with no keyword, and the console says so once.
 */
import { eventSource, event_types } from './events.js';
import { log } from './log.js';
import { activationKey, noteScanLoop, readWorldInfoLine, unreadScan } from './world-info-activations-core.js';

// The reader on top of console.debug, or null before the first start. A reader another extension wrapped over, and
// that a later start replaced on top, passes calls on and reads none.
let reader = null;
let isReading = false;
let scan = unreadScan();
// Whether a loop of a scan ended while reading: SillyTavern scanned, whatever its lines said.
let hasScanLoopEnded = false;
let isFollowingLoops = false;
let hasWarnedOfUnreadLines = false;
let hasWarnedOfReadFailure = false;

function putReaderOnTop() {
    if (console.debug === reader) return;
    const next = console.debug;
    const wrapper = function readWorldInfoLines(...args) {
        if (isReading && wrapper === reader) {
            try {
                scan = readWorldInfoLine(scan, args);
            } catch (error) {
                // EXPECTED after the first: a line that fails to read fails at every scan, for each of its lines, so the
                // console says it once.
                if (!hasWarnedOfReadFailure) {
                    hasWarnedOfReadFailure = true;
                    log.warn("VectFox: a line of SillyTavern's World Info scan could not be read, so Last reply's lore may show no keyword:", error);
                }
            }
        }
        return next.apply(console, args);
    };
    reader = wrapper;
    console.debug = wrapper;
}

function noteLoop(scanDone) {
    if (!isReading || scan.isDryRun) return;
    hasScanLoopEnded = true;
    noteScanLoop(scan, scanDone?.state?.loopCount, scanDone?.new?.successful);
}

/**
 * Read the next scan's lines and loops from now on, the reader put back on top of console.debug if another extension
 * wrapped it since. What the last read held is dropped.
 */
export function startReadingActivations() {
    if (!isFollowingLoops) {
        eventSource.on(event_types.WORLDINFO_SCAN_DONE, noteLoop);
        isFollowingLoops = true;
    }
    putReaderOnTop();
    scan = unreadScan();
    hasScanLoopEnded = false;
    isReading = true;
}

/**
 * Stop reading; what was read stays until the next start. A scan that ran with no line of it read is said in the
 * console, once.
 */
export function stopReadingActivations() {
    if (!isReading) return;
    isReading = false;
    if (hasScanLoopEnded && scan.isDryRun === null && !hasWarnedOfUnreadLines) {
        hasWarnedOfUnreadLines = true;
        log.warn("VectFox: no line of SillyTavern's World Info scan was read, so Last reply's lore shows no keyword. "
            + 'Another extension may hold back console.debug, or SillyTavern may have changed what it prints there.');
    }
}

/**
 * What fired an entry in the last scan read, and the loop it went in; null when nothing of it was read.
 * @param {{world: string, uid: number|string}} entry - One of WORLD_INFO_ACTIVATED's entries
 * @returns {import('./world-info-activations-core.js').EntryActivation|null}
 */
export function activationOf(entry) {
    if (scan.isDryRun) return null;
    return scan.activations.get(activationKey(entry?.world, entry?.uid)) ?? null;
}
