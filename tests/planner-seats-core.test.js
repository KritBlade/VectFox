/**
 * Tests for the seats Agent Mode's planner adds beside pre-search's own
 * (src/features/eventbase/planner-seats-core.js).
 *
 * Guards that:
 *   - the queries take turns, each seating its best event pre-search did not find,
 *   - no more than 5 seats are added, and pre-search loses none,
 *   - a filtered event or a duplicate of a seated one takes no seat, and its query moves on,
 *   - a query with nothing left gives its turn away.
 */

import { describe, it, expect } from 'vitest';

import { seatPlannerHits } from '../src/features/eventbase/planner-seats-core.js';

const event = (id, extra = {}) => ({ event_id: id, ...extra });
const ids = events => events.map(item => item.event_id);
const seat = ({ hitLists, poolEvents = [], seatedEvents = [], canTakeSeat = () => true, isDuplicate = () => false }) => ids(seatPlannerHits({ hitLists, poolEvents, seatedEvents, canTakeSeat, isDuplicate }));

describe('seatPlannerHits', () => {
    it('lets the queries take turns, in their order', () => {
        const hitLists = [[event('a1'), event('a2'), event('a3')], [event('b1'), event('b2'), event('b3')]];
        expect(seat({ hitLists })).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    });

    it('adds at most 5 seats', () => {
        const hitLists = [Array.from({ length: 12 }, (_, place) => event(`hit${place}`))];
        expect(seat({ hitLists })).toEqual(['hit0', 'hit1', 'hit2', 'hit3', 'hit4']);
    });

    it('skips what pre-search found, kept or not', () => {
        const hitLists = [[event('kept'), event('trimmed'), event('new')]];
        expect(seat({ hitLists, poolEvents: [event('kept'), event('trimmed')], seatedEvents: [event('kept')] })).toEqual(['new']);
    });

    it('seats an event two queries found once', () => {
        const hitLists = [[event('shared'), event('a')], [event('shared'), event('b')]];
        expect(seat({ hitLists })).toEqual(['shared', 'b', 'a']);
    });

    it('tells events apart by hash when they have no event id', () => {
        const hitLists = [[{ _hash: 1 }, { _hash: 2 }]];
        const added = seatPlannerHits({ hitLists, poolEvents: [{ _hash: 1 }], seatedEvents: [], canTakeSeat: () => true, isDuplicate: () => false });
        expect(added).toEqual([{ _hash: 2 }]);
    });

    it('gives a filtered event no seat, and moves that query on', () => {
        const hitLists = [[event('low'), event('fine')]];
        expect(seat({ hitLists, canTakeSeat: item => item.event_id !== 'low' })).toEqual(['fine']);
    });

    it('gives a duplicate of a pre-search seat no seat', () => {
        const hitLists = [[event('twin', { group: 1 }), event('other', { group: 2 })]];
        const isDuplicate = (candidate, seated) => candidate.group === seated.group;
        expect(seat({ hitLists, seatedEvents: [event('kept', { group: 1 })], isDuplicate })).toEqual(['other']);
    });

    it('gives a duplicate of an added seat no seat', () => {
        const hitLists = [[event('first', { group: 1 })], [event('twin', { group: 1 }), event('other', { group: 2 })]];
        const isDuplicate = (candidate, seated) => candidate.group === seated.group;
        expect(seat({ hitLists, isDuplicate })).toEqual(['first', 'other']);
    });

    it('lets the other queries take the turns of one with nothing left', () => {
        const hitLists = [[], [event('a')], [event('b1'), event('b2'), event('b3')]];
        expect(seat({ hitLists })).toEqual(['a', 'b1', 'b2', 'b3']);
    });

    it('adds nothing when no query found anything new', () => {
        expect(seat({ hitLists: [] })).toEqual([]);
        expect(seat({ hitLists: [[event('kept')]], poolEvents: [event('kept')] })).toEqual([]);
    });
});
