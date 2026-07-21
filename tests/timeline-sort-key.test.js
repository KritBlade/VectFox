/**
 * Tests for the whole-timeline chunk ordering key.
 *
 * `timeline_sort_key` = source_window_start * STRIDE + window_event_order packs a
 * window's first-message id and an event's order within that window into one
 * sortable integer. It exists so the Database Browser (and a future Qdrant
 * order_by) can render chunks in true chat-history order even when:
 *   - a big extraction window holds several events (same window_end, so
 *     source_window_end alone can't tell them apart), and
 *   - the parallel concurrency pool finishes windows out of order.
 *
 * The browser's sort falls back to packTimelineSortKey(messageNumber, 0) for
 * older chunks that predate the field, so a database holding a MIX of old and
 * new chunks stays one coherent sequence instead of splitting into two blocks.
 * That fallback selector is mirrored here (chunkTimelineSortValue lives in
 * ui/chunk-visualizer.js, which pulls SillyTavern host modules and can't be
 * imported under vitest) — it uses the SAME exported packTimelineSortKey, so the
 * packing math itself is covered directly.
 */

import { describe, it, expect } from 'vitest';
import { packTimelineSortKey, TIMELINE_SORT_KEY_WINDOW_STRIDE } from '../core/eventbase-schema.js';

// Mirror of ui/chunk-visualizer.js chunkTimelineSortValue().
const sortValue = (meta) => {
    if (typeof meta.timeline_sort_key === 'number') return meta.timeline_sort_key;
    const messageNumber = meta.source_window_start ?? meta.source_window_end ?? meta.index ?? 0;
    return packTimelineSortKey(messageNumber, 0);
};

describe('packTimelineSortKey', () => {
    it('packs (window_start, event_order) into window_start * STRIDE + order', () => {
        expect(packTimelineSortKey(2527, 0)).toBe(25270000);
        expect(packTimelineSortKey(2527, 2)).toBe(25270002);
        expect(packTimelineSortKey(2532, 1)).toBe(25320001);
    });

    it('coalesces non-numeric inputs to 0 (never NaN)', () => {
        expect(packTimelineSortKey(undefined, undefined)).toBe(0);
        expect(packTimelineSortKey(null, 3)).toBe(3);
        expect(packTimelineSortKey(5, null)).toBe(5 * TIMELINE_SORT_KEY_WINDOW_STRIDE);
    });

    it('keeps every event of an earlier window ahead of any event of a later window', () => {
        // Window A (start 2527) with 3 events, Window B (start 2532) with 2.
        const a = [0, 1, 2].map(o => packTimelineSortKey(2527, o));
        const b = [0, 1].map(o => packTimelineSortKey(2532, o));
        expect(Math.max(...a)).toBeLessThan(Math.min(...b)); // no bleed across windows
    });
});

describe('database-browser timeline sort', () => {
    it('orders several events from one big window by their intra-window order', () => {
        // All share source_window_end (2531) — only window_event_order separates them.
        const chunks = [
            { summary: 'third', source_window_start: 2527, source_window_end: 2531, window_event_order: 2, timeline_sort_key: packTimelineSortKey(2527, 2) },
            { summary: 'first', source_window_start: 2527, source_window_end: 2531, window_event_order: 0, timeline_sort_key: packTimelineSortKey(2527, 0) },
            { summary: 'second', source_window_start: 2527, source_window_end: 2531, window_event_order: 1, timeline_sort_key: packTimelineSortKey(2527, 1) },
        ];
        const ordered = [...chunks].sort((x, y) => sortValue(x) - sortValue(y)).map(c => c.summary);
        expect(ordered).toEqual(['first', 'second', 'third']);
    });

    it('interleaves old (no fields) and new chunks into one message-order sequence', () => {
        // Edge case the user flagged: existing user upgrades; DB now mixes chunks
        // that HAVE the new fields with older ones that DON'T. They must sort as
        // one timeline, not old-block-then-new-block.
        const legacyMsg2530 = { summary: 'legacy@2530', index: 2530 };                       // no window fields
        const legacyEventbase2540 = { summary: 'legacyEB@2540', source_window_end: 2540 };    // pre-key EventBase
        const newWin2527ev0 = { summary: 'new@2527#0', source_window_start: 2527, window_event_order: 0, timeline_sort_key: packTimelineSortKey(2527, 0) };
        const newWin2527ev1 = { summary: 'new@2527#1', source_window_start: 2527, window_event_order: 1, timeline_sort_key: packTimelineSortKey(2527, 1) };

        const ordered = [legacyEventbase2540, newWin2527ev1, legacyMsg2530, newWin2527ev0]
            .sort((x, y) => sortValue(x) - sortValue(y))
            .map(c => c.summary);

        // 2527#0, 2527#1 (new) < 2530 (legacy) < 2540 (legacy EventBase) — one coherent sequence.
        expect(ordered).toEqual(['new@2527#0', 'new@2527#1', 'legacy@2530', 'legacyEB@2540']);
    });

    it('leaves collections with no order signal at all unshuffled among themselves (all key to 0)', () => {
        const chunks = [{ summary: 'a' }, { summary: 'b' }, { summary: 'c' }];
        expect(chunks.every(c => sortValue(c) === 0)).toBe(true);
    });
});
