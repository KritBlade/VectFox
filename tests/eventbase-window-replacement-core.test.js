/**
 * Which stored events a window extracted again replaces, and where their StoryArc links go; a window a stretch read
 * again reads with no event found replaces its events with none, and the links to them are dropped.
 */

import { describe, it, expect } from 'vitest';
import {
    extractionTimeOf,
    findReplacedEvents,
    linksMovedToReplacements,
    mayHoldEarlierEvents,
    replacementIdsOf,
    windowSpanOf,
} from '../src/features/eventbase/eventbase-window-replacement-core.js';

/** An event of the two-message window starting at windowStart, whose messages hash to start×10 and start×10+1 unless told otherwise. */
const eventOf = (eventId, windowStart, { time = 1000, hashes, order = 0, links } = {}) => ({
    event_id: eventId,
    source_window_start: windowStart,
    source_window_end: windowStart + 1,
    created_at: time,
    source_message_hashes: hashes ?? [windowStart * 10, windowStart * 10 + 1],
    window_event_order: order,
    ...(links ? { story_links: links } : {}),
});

const idsOf = events => events.map(event => event.event_id);

describe('windowSpanOf', () => {
    it('names a window by its first and last message', () => {
        expect(windowSpanOf(eventOf('a', 4))).toBe('4-5');
    });
});

describe('extractionTimeOf', () => {
    it('reads created_at', () => {
        expect(extractionTimeOf({ created_at: 500, event_id: 'eb_900_0_0_x' })).toBe(500);
    });

    it('reads the time an event_id begins with when created_at is missing', () => {
        expect(extractionTimeOf({ event_id: 'eb_1700000000000_4_1_ab3cd' })).toBe(1700000000000);
    });

    it('is null when the event records neither', () => {
        expect(extractionTimeOf({ event_id: 'imported-7' })).toBeNull();
    });
});

describe('mayHoldEarlierEvents', () => {
    it('is false for one window at the tip, which is what an ordinary turn extracts', () => {
        expect(mayHoldEarlierEvents([eventOf('a', 10), eventOf('b', 10, { order: 1 })], 10)).toBe(false);
    });

    it('is true for a window before the tip', () => {
        expect(mayHoldEarlierEvents([eventOf('a', 4)], 10)).toBe(true);
    });

    it('is true for more than one window, since an older settings file can put back an older tip', () => {
        expect(mayHoldEarlierEvents([eventOf('a', 10), eventOf('b', 12)], 10)).toBe(true);
    });

    it('is true with no tip known', () => {
        expect(mayHoldEarlierEvents([eventOf('a', 10)], undefined)).toBe(true);
        expect(mayHoldEarlierEvents([eventOf('a', 10)], null)).toBe(true);
    });
});

describe('findReplacedEvents', () => {
    // The window's first message was rewritten (40 became 99); its second message (41) is the same.
    const newEvent = eventOf('new-a', 4, { time: 2000, hashes: [99, 41] });
    const findWith = (storedEvents, runEventIds = ['new-a']) => idsOf(findReplacedEvents([...storedEvents, newEvent], [newEvent], new Set(runEventIds)));

    it('replaces the events an earlier extraction of the window wrote', () => {
        expect(findWith([eventOf('old-a', 4), eventOf('old-b', 4, { order: 1 })])).toEqual(['old-a', 'old-b']);
    });

    it('replaces every earlier extraction of the window', () => {
        expect(findWith([eventOf('first', 4, { time: 500 }), eventOf('second', 4, { time: 1000, hashes: [77, 41] })])).toEqual(['first', 'second']);
    });

    it('keeps the events of other windows', () => {
        expect(findWith([eventOf('other', 6)])).toEqual([]);
    });

    it('keeps a window that only has the same numbers, sharing no message with it', () => {
        expect(findWith([eventOf('elsewhere', 4, { hashes: [500, 501] })])).toEqual([]);
    });

    it('keeps events written after it, as another session extracting the window at once writes them', () => {
        expect(findWith([eventOf('later', 4, { time: 3000 })])).toEqual([]);
    });

    it('keeps the run\'s own events', () => {
        expect(findWith([eventOf('own', 4)], ['new-a', 'own'])).toEqual([]);
    });

    it('counts an event that records no time as written before', () => {
        const untimed = { event_id: 'untimed', source_window_start: 4, source_window_end: 5, source_message_hashes: [40, 41] };
        expect(findWith([untimed])).toEqual(['untimed']);
    });

    it('matches message hashes stored as text against numbers', () => {
        expect(findWith([eventOf('text-hashes', 4, { hashes: ['40', '41'] })])).toEqual(['text-hashes']);
    });

    it('replaces the earlier events of a window a stretch read again read with no event found, and only those written before its read', () => {
        const readEmpty = { source_window_start: 6, source_window_end: 7, source_message_hashes: [60, 61], created_at: 2000 };
        const stored = [eventOf('empty-old', 6), eventOf('empty-later', 6, { time: 3000 }), eventOf('other', 8)];
        expect(idsOf(findReplacedEvents([...stored, newEvent], [newEvent], new Set(['new-a']), [readEmpty]))).toEqual(['empty-old']);
    });
});

describe('replacementIdsOf', () => {
    it('hands each replaced event to the first new event of its window', () => {
        const newEvents = [eventOf('new-b', 4, { time: 2000, order: 1 }), eventOf('new-a', 4, { time: 2000 }), eventOf('new-c', 6, { time: 2000 })];
        const replaced = [eventOf('old-a', 4), eventOf('old-b', 4, { order: 1 }), eventOf('old-c', 6)];
        expect(replacementIdsOf(replaced, newEvents)).toEqual(new Map([['old-a', 'new-a'], ['old-b', 'new-a'], ['old-c', 'new-c']]));
    });

    it('hands an event of a window whose new read found none to no event', () => {
        expect(replacementIdsOf([eventOf('old-a', 4), eventOf('emptied', 6)], [eventOf('new-a', 4, { time: 2000 })]))
            .toEqual(new Map([['old-a', 'new-a'], ['emptied', null]]));
    });
});

describe('linksMovedToReplacements', () => {
    const replacementById = new Map([['old-a', 'new-a'], ['old-b', 'new-a']]);

    it('points a link at the event that replaced its target, keeping its type and thread', () => {
        const linker = eventOf('later', 10, { links: [
            { event_id: 'old-a', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'kept', type: 'caused_by', thread: '' },
        ] });
        expect(linksMovedToReplacements([linker], replacementById)).toEqual([{ event: linker, links: [
            { event_id: 'new-a', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'kept', type: 'caused_by', thread: '' },
        ] }]);
    });

    it('makes two links to earlier versions of one window into one, unless their types differ', () => {
        const sameType = eventOf('same-type', 10, { links: [{ event_id: 'old-a', type: 'continues', thread: '' }, { event_id: 'old-b', type: 'continues', thread: '' }] });
        const twoTypes = eventOf('two-types', 12, { links: [{ event_id: 'old-a', type: 'continues', thread: '' }, { event_id: 'old-b', type: 'caused_by', thread: '' }] });
        expect(linksMovedToReplacements([sameType, twoTypes], replacementById).map(write => write.links)).toEqual([
            [{ event_id: 'new-a', type: 'continues', thread: '' }],
            [{ event_id: 'new-a', type: 'continues', thread: '' }, { event_id: 'new-a', type: 'caused_by', thread: '' }],
        ]);
    });

    it('makes a moved link and one the event already had to that event, of the same type, into one', () => {
        const linker = eventOf('already-linked', 10, { links: [
            { event_id: 'old-a', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'new-a', type: 'continues', thread: '' },
            { event_id: 'new-a', type: 'caused_by', thread: '' },
        ] });
        expect(linksMovedToReplacements([linker], replacementById)[0].links).toEqual([
            { event_id: 'new-a', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'new-a', type: 'caused_by', thread: '' },
        ]);
    });

    it('drops a link to a replaced event with no replacement, keeping the others', () => {
        const linker = eventOf('later', 10, { links: [
            { event_id: 'emptied', type: 'continues', thread: '' },
            { event_id: 'old-a', type: 'caused_by', thread: '' },
        ] });
        expect(linksMovedToReplacements([linker], new Map([['emptied', null], ['old-a', 'new-a']]))).toEqual([{ event: linker, links: [
            { event_id: 'new-a', type: 'caused_by', thread: '' },
        ] }]);
    });

    it('leaves out events with no link to a replaced event, and the replaced events themselves', () => {
        const events = [
            eventOf('untouched', 8, { links: [{ event_id: 'kept', type: 'continues', thread: '' }] }),
            eventOf('undecided', 9),
            eventOf('old-a', 4, { links: [{ event_id: 'old-b', type: 'continues', thread: '' }] }),
        ];
        expect(linksMovedToReplacements(events, replacementById)).toEqual([]);
    });
});
