/**
 * What Compact collection removes from an EventBase collection (src/features/eventbase/eventbase-compaction-core.js):
 * each window keeps its newest extraction, the events of earlier ones go, and StoryArc links that pointed at them move
 * to the event that stays.
 */

import { describe, it, expect } from 'vitest';
import { describeCompaction, planCompaction } from '../src/features/eventbase/eventbase-compaction-core.js';

/** An event of the two-message window starting at windowStart, extracted at `time`; its messages hash to start×10 and start×10+1 unless told otherwise. */
const eventOf = (eventId, windowStart, { time = 1000, hashes, order = 0, links } = {}) => ({
    event_id: eventId,
    created_at: time,
    source_window_start: windowStart,
    source_window_end: windowStart + 1,
    source_message_hashes: hashes ?? [windowStart * 10, windowStart * 10 + 1],
    window_event_order: order,
    ...(links ? { story_links: links } : {}),
});

/** An event that records no created_at: only its event_id says when it was extracted, event by event. */
const eventWithoutCreatedAt = (name, windowStart, idTime, order = 0) => ({
    event_id: `eb_${idTime}_${windowStart}_${order}_${name}`,
    source_window_start: windowStart,
    source_window_end: windowStart + 1,
    source_message_hashes: [windowStart * 10, windowStart * 10 + 1],
    window_event_order: order,
});

const idsOf = events => events.map(event => event.event_id).sort();

describe('planCompaction', () => {
    it('keeps each window\'s newest extraction and removes the events of earlier ones', () => {
        const plan = planCompaction([
            eventOf('first', 0, { time: 1000 }),
            eventOf('first-second-event', 0, { time: 1000, order: 1 }),
            eventOf('newest', 0, { time: 2000 }),
            eventOf('only-reading', 2, { time: 1500 }),
        ]);
        expect(idsOf(plan.repeats)).toEqual(['first', 'first-second-event']);
        expect(plan.repeatWindowCount).toBe(1);
    });

    it('keeps every event of the newest extraction', () => {
        const plan = planCompaction([
            eventOf('older', 0, { time: 1000 }),
            eventOf('newest-first', 0, { time: 2000 }),
            eventOf('newest-second', 0, { time: 2000, order: 1 }),
        ]);
        expect(idsOf(plan.repeats)).toEqual(['older']);
    });

    it('removes nothing from a window holding no event that records when it was extracted', () => {
        // Two events of one extraction whose event_id times differ by a millisecond.
        const plan = planCompaction([eventWithoutCreatedAt('a', 0, 1000, 0), eventWithoutCreatedAt('b', 0, 1001, 1)]);
        expect(plan.repeats).toEqual([]);
    });

    it('removes an event without created_at from a window whose newest extraction records it', () => {
        const older = eventWithoutCreatedAt('older', 0, 900);
        expect(planCompaction([older, eventOf('newest', 0, { time: 2000 })]).repeats).toEqual([older]);
    });

    it('keeps an earlier event that shares no message with the newest extraction', () => {
        const plan = planCompaction([eventOf('other-messages', 0, { time: 1000, hashes: [7, 8] }), eventOf('newest', 0, { time: 2000 })]);
        expect(plan.repeats).toEqual([]);
    });

    it('compares only windows with the same first and last message', () => {
        const fourMessages = { ...eventOf('four-messages', 0, { time: 1000 }), source_window_end: 3 };
        expect(planCompaction([fourMessages, eventOf('two-messages', 0, { time: 2000 })]).repeats).toEqual([]);
    });

    it('moves the links that pointed at removed events to the first event of each window\'s newest extraction', () => {
        const linker = eventOf('later', 6, { time: 3000, links: [
            { event_id: 'older-0', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'older-2', type: 'caused_by', thread: '' },
            { event_id: 'kept', type: 'reveals', thread: '' },
        ] });
        const plan = planCompaction([
            eventOf('older-0', 0, { time: 1000 }),
            eventOf('newest-0-second', 0, { time: 2000, order: 1 }),
            eventOf('newest-0-first', 0, { time: 2000 }),
            eventOf('older-2', 2, { time: 1000 }),
            eventOf('newest-2', 2, { time: 2000 }),
            eventOf('kept', 4, { time: 1000 }),
            linker,
        ]);
        expect(plan.linkMoves).toEqual([{ event: linker, links: [
            { event_id: 'newest-0-first', type: 'continues', thread: 'The harbour debt' },
            { event_id: 'newest-2', type: 'caused_by', thread: '' },
            { event_id: 'kept', type: 'reveals', thread: '' },
        ] }]);
        expect(plan.movedLinkCount).toBe(2);
    });

    it('plans nothing for a collection without repeats', () => {
        expect(planCompaction([eventOf('a', 0), eventOf('b', 2)])).toEqual({ repeats: [], repeatWindowCount: 0, linkMoves: [], movedLinkCount: 0 });
    });
});

describe('describeCompaction', () => {
    it('counts the repeated events, their windows, and the links that move', () => {
        expect(describeCompaction({ repeats: new Array(116), repeatWindowCount: 76, movedLinkCount: 52 })).toEqual([
            'It removes 116 repeated events in 76 windows. Each window keeps the events of its newest reading.',
            '52 StoryArc links point at a repeated event, so they move to the event that stays in its window.',
        ]);
    });

    it('speaks of one in the singular, and of no links when none move', () => {
        expect(describeCompaction({ repeats: [{}], repeatWindowCount: 1, movedLinkCount: 0 })).toEqual([
            'It removes 1 repeated event in 1 window. Each window keeps the events of its newest reading.',
        ]);
        expect(describeCompaction({ repeats: [{}], repeatWindowCount: 1, movedLinkCount: 1 })[1])
            .toBe('1 StoryArc link points at a repeated event, so it moves to the event that stays in its window.');
    });
});
