/**
 * ============================================================================
 * EVENTBASE WINDOW RECORD — the windows a collection's events show
 * ============================================================================
 * A collection's window record (its pointer's extractedWindows, eventbase-store.js) keeps only the windows its events
 * cannot show (InternalProject/Vectfox/plans/eventbase-window-record.md): every event EventBase stores carries its
 * window's message hashes (source_message_hashes), so a window with an event read back from the collection is read.
 * These are the pure parts: a window's fingerprint, the windows a listing's events show, whether a listing holds the
 * events' payload at all, and what a record keeps once trimmed. No host or feature imports.
 * ============================================================================
 */

/**
 * A window's fingerprint, from its messages' hashes: the hashes as strings, sorted, joined by commas.
 *
 * @param {Array<number|string>} sourceHashes
 * @returns {string}
 */
export function windowFingerprint(sourceHashes) {
    return [...sourceHashes].map(String).sort().join(',');
}

/**
 * The windows a collection's events show: each event's window by its fingerprint, and every message hash those windows
 * hold. An event without its window's message hashes shows none.
 *
 * @param {object[]} events - Stored events, as their payloads
 * @returns {{fingerprints: Set<string>, messageHashes: Set<string>}}
 */
export function eventWindowsOf(events) {
    const fingerprints = new Set();
    const messageHashes = new Set();
    for (const event of events) {
        const hashes = event?.source_message_hashes;
        if (!Array.isArray(hashes) || hashes.length === 0) continue;
        fingerprints.add(windowFingerprint(hashes));
        for (const hash of hashes) messageHashes.add(String(hash));
    }
    return { fingerprints, messageHashes };
}

/**
 * Whether a listing of an EventBase collection holds its events' payload: it lists nothing, or at least one event.
 * A listing whose points carry no event gave their hashes only (Standard without Similharity, or Standard's fallback
 * after a plugin error), and shows no window.
 *
 * @param {object[]} items - listChunks' items
 * @returns {boolean}
 */
export function isListingWithPayload(items) {
    return items.length === 0
        || items.some(item => item?.metadata?.eventbase === true || Array.isArray(item?.metadata?.source_message_hashes));
}

/**
 * The windows a record keeps once trimmed: those whose fingerprint no event shows. A window whose messages all sit in
 * windows the events show, but whose own fingerprint none has (one read at another size), stays.
 *
 * @param {string[]} recordWindows - The record's extractedWindows
 * @param {Set<string>} eventFingerprints - eventWindowsOf's fingerprints
 * @returns {string[]}
 */
export function windowsOnlyOnTheRecord(recordWindows, eventFingerprints) {
    return recordWindows.filter(fingerprint => !eventFingerprints.has(fingerprint));
}

/**
 * Every window read, once each: the record's, then those the events show that it lacks.
 *
 * @param {string[]} recordWindows - The record's extractedWindows
 * @param {Iterable<string>} eventFingerprints - eventWindowsOf's fingerprints
 * @returns {string[]}
 */
export function everyWindowRead(recordWindows, eventFingerprints) {
    return [...new Set([...recordWindows, ...eventFingerprints])];
}

/**
 * The windows read an export of a collection writes (§3.7 of InternalProject/Vectfox/plans/eventbase-window-record.md):
 * its record's and those its exported events show, so the file stands on its own on any backend.
 *
 * @param {string[]} recordWindows - The record's extractedWindows
 * @param {Array<{metadata?: object}>} chunks - The exported points
 * @returns {string[]}
 */
export function windowsReadForExport(recordWindows, chunks) {
    return everyWindowRead(recordWindows, eventWindowsOf(chunks.map(chunk => chunk?.metadata ?? {})).fingerprints);
}
