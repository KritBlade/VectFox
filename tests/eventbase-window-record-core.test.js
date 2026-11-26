/**
 * The pure parts of EventBase's window record (src/features/eventbase/eventbase-window-record-core.js, §2 and §3 of
 * InternalProject/Vectfox/plans/eventbase-window-record.md): a window's fingerprint, the windows a listing's events
 * show, whether a listing holds the events' payload, what a record keeps once trimmed, and the windows an export writes.
 */
import { describe, it, expect } from 'vitest';
import {
    eventWindowsOf,
    everyWindowRead,
    isListingWithPayload,
    windowFingerprint,
    windowsOnlyOnTheRecord,
    windowsReadForExport,
} from '../src/features/eventbase/eventbase-window-record-core.js';

describe("a window's fingerprint", () => {
    it('is its message hashes as strings, sorted and joined, whatever order or type they come in', () => {
        expect(windowFingerprint([22, 11])).toBe('11,22');
        expect(windowFingerprint(['22', 11])).toBe('11,22');
    });
});

describe('the windows events show', () => {
    it('takes each event window once, by fingerprint, with every message hash it holds', () => {
        const shown = eventWindowsOf([
            { source_message_hashes: [2, 1] },
            { source_message_hashes: [1, 2] },
            { source_message_hashes: [3, 4] },
        ]);

        expect(shown.fingerprints).toEqual(new Set(['1,2', '3,4']));
        expect(shown.messageHashes).toEqual(new Set(['1', '2', '3', '4']));
    });

    it('shows no window for an event without its window\'s message hashes', () => {
        const shown = eventWindowsOf([{}, { source_message_hashes: [] }, { source_message_hashes: 'nope' }, null]);

        expect(shown.fingerprints.size).toBe(0);
        expect(shown.messageHashes.size).toBe(0);
    });
});

describe("a listing's payload", () => {
    it('is there when the listing holds an event, or lists nothing', () => {
        expect(isListingWithPayload([])).toBe(true);
        expect(isListingWithPayload([{ hash: 1, metadata: { eventbase: true } }])).toBe(true);
        expect(isListingWithPayload([{ hash: 1, metadata: { source_message_hashes: [1, 2] } }])).toBe(true);
    });

    it("is missing when the points carry their hashes only, as Standard lists them without Similharity", () => {
        expect(isListingWithPayload([{ hash: 1, text: '', metadata: {} }, { hash: 2, text: '', metadata: {} }])).toBe(false);
    });
});

describe('a trimmed record', () => {
    it('keeps only the windows no event shows by fingerprint', () => {
        expect(windowsOnlyOnTheRecord(['1,2', '3,4', '5,6'], new Set(['1,2', '5,6']))).toEqual(['3,4']);
    });

    it('keeps a window read at another size, though the events show each of its messages', () => {
        expect(windowsOnlyOnTheRecord(['1,2,3,4'], new Set(['1,2', '3,4']))).toEqual(['1,2,3,4']);
    });
});

describe('every window read', () => {
    it("lists the record's windows, then those the events show that it lacks, once each", () => {
        expect(everyWindowRead(['3,4', '1,2'], new Set(['1,2', '5,6']))).toEqual(['3,4', '1,2', '5,6']);
    });

    it("is what an export writes: the record's and those its exported events show", () => {
        const chunks = [
            { metadata: { eventbase: true, source_message_hashes: [6, 5] } },
            { metadata: { eventbase: true, source_message_hashes: [1, 2] } },
            { text: 'a point with no metadata' },
        ];

        expect(windowsReadForExport(['1,2'], chunks)).toEqual(['1,2', '5,6']);
    });
});
