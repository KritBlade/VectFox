/**
 * Tests for chronological presentation ordering in
 * formatEventsForInjectionDetailed() (src/features/eventbase/eventbase-injection.js).
 *
 * Retrieval decides WHICH events are injected (relevance/score); the injector
 * decides DISPLAY order. These guard that:
 *   - within one conversation frame, events render oldest → newest by
 *     `source_window_end` (a place's first event before its second),
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
import { formatEventsForInjectionDetailed, formatStoryArcForInjection } from '../src/features/eventbase/eventbase-injection.js';

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
        const [a, b, c] = order(res.text, 'summary: a', 'summary: b', 'summary: c');
        expect(b).toBeGreaterThan(-1);
        expect(b).toBeLessThan(c);
        expect(c).toBeLessThan(a);
    });
});

describe('formatStoryArcForInjection', () => {
    const line = (o) => ev({ source_window_start: o.source_window_end - 1, ...o });

    it('writes one line per event: position, cause, summary, result', () => {
        const { text, includedCount } = formatStoryArcForInjection([
            line({ summary: 'the blockade', cause: 'the church moved', result: 'refugees fled', source_window_end: 459 }),
        ], 'chain');
        expect(text.split('\n')[1]).toBe('- #458: the church moved the blockade refugees fled');
        expect(includedCount).toBe(1);
    });

    it('leaves out a missing cause or result without stray spaces', () => {
        const { text } = formatStoryArcForInjection([line({ summary: 'alone', source_window_end: 11 })], 'chain');
        expect(text.split('\n')[1]).toBe('- #10: alone');
    });

    it('ends a line with when and where the event happened, as it records them, on every shape', () => {
        const event = line({ summary: 'the blockade', source_window_end: 459, DateTime: '1203-04-02T18:00', scene_time: 'the second evening of the siege', locations: ['Old Mill', 'East Gate'] });
        for (const shape of ['first_time', 'last_time', 'chain', 'why', 'bigger_plot', 'current', 'scene']) {
            expect(formatStoryArcForInjection([event], shape).text.split('\n')[1], shape)
                .toBe('- #458: the blockade (when: 1203-04-02T18:00, the second evening of the siege; where: Old Mill, East Gate)');
        }
    });

    it('gives only what the event records, and a time once when both fields hold it', () => {
        const at = o => formatStoryArcForInjection([line({ summary: 'the blockade', source_window_end: 459, ...o })], 'chain').text.split('\n')[1];
        expect(at({ scene_time: 'dawn' })).toBe('- #458: the blockade (when: dawn)');
        expect(at({ locations: ['Old Mill'] })).toBe('- #458: the blockade (where: Old Mill)');
        expect(at({ DateTime: '1203-04-02', scene_time: '1203-04-02' })).toBe('- #458: the blockade (when: 1203-04-02)');
        expect(at({ DateTime: null, scene_time: '', locations: [''] })).toBe('- #458: the blockade');
    });

    it('keeps one window\'s events in the order they are given, and sorts windows oldest → newest', () => {
        const { text } = formatStoryArcForInjection([
            line({ summary: 'first_of_window', source_window_end: 101 }),
            line({ summary: 'second_of_window', source_window_end: 101 }),
            line({ summary: 'older', source_window_end: 51 }),
        ], 'chain');
        const [older, first, second] = order(text, 'older', 'first_of_window', 'second_of_window');
        expect(older).toBeLessThan(first);
        expect(first).toBeLessThan(second);
    });

    it('reads a current-state block newest first', () => {
        const { text } = formatStoryArcForInjection([
            line({ summary: 'older', source_window_end: 51 }),
            line({ summary: 'newer', source_window_end: 101 }),
        ], 'current');
        const [older, newer] = order(text, 'older', 'newer');
        expect(newer).toBeLessThan(older);
    });

    it('keeps each conversation together', () => {
        const { text } = formatStoryArcForInjection([
            line({ summary: 'live_old', source_window_end: 11, _sortFrame: 'live', real_world_date: '2026-06-01T00:00:00Z' }),
            line({ summary: 'archive_late', source_window_end: 901, _sortFrame: 'archive', real_world_date: '2025-01-01T00:00:00Z' }),
        ], 'chain');
        const [archive, live] = order(text, 'archive_late', 'live_old');
        expect(archive).toBeLessThan(live);
    });

    it('says what the block is for each shape, and tells the reader how to read it', () => {
        const events = [line({ summary: 'a', source_window_end: 2 })];
        const headers = ['first_time', 'chain', 'why', 'bigger_plot', 'current', 'last_time', 'scene'].map(shape => formatStoryArcForInjection(events, shape).text.split('\n')[0]);
        expect(new Set(headers).size).toBe(7);
        for (const header of headers) {
            expect(header).toContain(header === headers[4] ? 'newest → oldest' : 'oldest → newest');
            expect(header).toContain('smaller # happened earlier');
        }
        expect(headers[0]).toContain('earliest');
        expect(headers[5]).toContain('latest');
    });

    // An ordinary turn asks about nothing, so its block names no thread or question.
    it('gives an ordinary turn\'s block a header that names no thread or question', () => {
        const header = formatStoryArcForInjection([line({ summary: 'a', source_window_end: 2 })], 'scene').text.split('\n')[0];
        expect(header).toContain('this moment');
        expect(header).not.toMatch(/thread|asked/);
    });

    it('stays near the size of the normal block at 50 events', () => {
        const summary = '一'.repeat(90);
        const events = Array.from({ length: 50 }, (_, i) => line({ summary, cause: '因'.repeat(20), result: '果'.repeat(20), source_window_end: i * 2 + 1 }));
        expect(formatStoryArcForInjection(events, 'chain').text.length).toBeLessThan(8000);
    });

    it('returns an empty block for no events', () => {
        expect(formatStoryArcForInjection([], 'chain')).toEqual({ text: '', includedCount: 0, requestedCount: 0 });
        expect(formatStoryArcForInjection(null, 'chain').text).toBe('');
    });
});
