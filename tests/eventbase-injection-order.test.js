/**
 * Tests for chronological presentation ordering in
 * formatEventsForInjectionDetailed() (core/eventbase-injection.js).
 *
 * Retrieval decides WHICH events are injected (relevance/score); the injector
 * decides DISPLAY order. These guard that:
 *   - within one conversation frame, events render oldest → newest by
 *     `source_window_end` (the Bluewatch-#1-before-#2 case),
 *   - events lacking a window key sink to the end without disturbing others,
 *   - ties keep their incoming (relevance) order (stable sort),
 *   - across frames (archive vs live), events never interleave — whole frames
 *     are ordered by their real-world recency, live chat last,
 *   - the ordering header is emitted exactly once.
 *
 * eventbase-injection.js is self-contained (no SillyTavern host imports), so no
 * module mocks are needed.
 */

import { describe, it, expect } from 'vitest';
import { formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';

/** Minimal event factory. `text` drives the injected summary line. */
const ev = (o) => ({
    event_type: 'combat',
    importance: 5,
    text: `[combat] ${o.summary}`,
    characters: [], locations: [], factions: [], items: [],
    concepts: [], keywords: [], open_threads: [],
    ...o,
});

// summaryonly keeps output compact and includes message_order + summary.
const settings = { eventbase_injection_format: 'summaryonly' };
const order = (text, ...labels) => labels.map(l => text.indexOf(l));

describe('formatEventsForInjectionDetailed — presentation ordering', () => {
    it('sorts a single frame oldest → newest by source_window_end', () => {
        const { text } = formatEventsForInjectionDetailed([
            ev({ summary: 'attack_two', source_window_end: 400 }),
            ev({ summary: 'attack_one', source_window_end: 200 }),
        ], settings);
        const [one, two] = order(text, 'attack_one', 'attack_two');
        expect(one).toBeGreaterThan(-1);
        expect(one).toBeLessThan(two);
    });

    it('sinks events with no source_window_end to the end', () => {
        const { text } = formatEventsForInjectionDetailed([
            ev({ summary: 'undated' }),                       // no window key
            ev({ summary: 'dated', source_window_end: 100 }),
        ], settings);
        const [dated, undated] = order(text, 'dated', 'undated');
        expect(dated).toBeLessThan(undated);
    });

    it('preserves incoming (relevance) order on window ties — stable sort', () => {
        const { text } = formatEventsForInjectionDetailed([
            ev({ summary: 'first', source_window_end: 50 }),
            ev({ summary: 'second', source_window_end: 50 }),
        ], settings);
        const [first, second] = order(text, 'first', 'second');
        expect(first).toBeLessThan(second);
    });

    it('groups by frame and never interleaves — older real-world frame first, live last', () => {
        const events = [
            ev({ summary: 'liveEarly', source_window_end: 10, _sortFrame: 'live', real_world_date: '2026-07-05T10:00:00Z' }),
            ev({ summary: 'archLate', source_window_end: 900, _sortFrame: 'arch', real_world_date: '2026-06-01T10:00:00Z' }),
            ev({ summary: 'archEarly', source_window_end: 100, _sortFrame: 'arch', real_world_date: '2026-06-01T09:00:00Z' }),
            ev({ summary: 'liveLate', source_window_end: 20, _sortFrame: 'live', real_world_date: '2026-07-05T11:00:00Z' }),
        ];
        const { text } = formatEventsForInjectionDetailed(events, settings);
        const [archEarly, archLate, liveEarly, liveLate] =
            order(text, 'archEarly', 'archLate', 'liveEarly', 'liveLate');
        // within archive frame: window 100 before 900
        expect(archEarly).toBeLessThan(archLate);
        // whole archive frame (older real-world date) before the live frame — no interleave
        expect(archLate).toBeLessThan(liveEarly);
        // within live frame: window 10 before 20
        expect(liveEarly).toBeLessThan(liveLate);
    });

    it('emits the ordering header exactly once, and only when events exist', () => {
        const { text } = formatEventsForInjectionDetailed(
            [ev({ summary: 'x', source_window_end: 1 })], settings);
        expect(text.split('oldest → newest').length - 1).toBe(1);
        expect(text.startsWith('Past events')).toBe(true);

        const empty = formatEventsForInjectionDetailed([], settings);
        expect(empty.text).toBe('');
    });

    it('stamps context_relevance_rank in score order, surviving the chronological re-sort', () => {
        // Incoming order = score-descending (strongest match first). The strongest
        // match here is chronologically LATER (window 400), so after the sort it
        // renders second — but its rank must still read 1 of 2.
        const { text } = formatEventsForInjectionDetailed([
            ev({ summary: 'strongMatch', source_window_end: 400 }),  // relevance rank 1
            ev({ summary: 'weakMatch', source_window_end: 200 }),    // relevance rank 2
        ], settings);

        // Display order is chronological: weakMatch(200) before strongMatch(400).
        const [weak, strong] = order(text, 'weakMatch', 'strongMatch');
        expect(weak).toBeLessThan(strong);

        // But the rank reflects relevance, not display position.
        const blockFor = (s) => text.split('# Event').find(b => b.includes(`summary: ${s}`)) || '';
        expect(blockFor('strongMatch')).toContain('context_relevance_rank: 1 of 2');
        expect(blockFor('weakMatch')).toContain('context_relevance_rank: 2 of 2');
    });

    it('does not add or drop events (includedCount preserved)', () => {
        const events = [
            ev({ summary: 'a', source_window_end: 3 }),
            ev({ summary: 'b', source_window_end: 1 }),
            ev({ summary: 'c', source_window_end: 2 }),
        ];
        const res = formatEventsForInjectionDetailed(events, settings);
        expect(res.includedCount).toBe(3);
        expect(res.requestedCount).toBe(3);
        // and they came out sorted b(1) → c(2) → a(3)
        const [a, b, c] = order(res.text, '[combat] a', 'summary: b', 'summary: c');
        expect(b).toBeGreaterThan(-1);
    });
});
