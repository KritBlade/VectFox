/**
 * ============================================================================
 * EVENTBASE COMPACTION — pure logic
 * ============================================================================
 * What Compact collection removes from an EventBase collection. It removes
 * repeats: the events a window holds from extractions before its newest one.
 * Each window keeps its newest extraction, and an earlier event goes by the rule
 * a window read again follows (eventbase-window-replacement-core.js): the same
 * first and last message, at least one shared message, written before it.
 * StoryArc links that pointed at a removed event move to the first event of its
 * window's newest extraction.
 *
 * Only an extraction that records when it ran (created_at) counts as a window's
 * newest. An older event carries that time only in its event_id, which can
 * differ by a millisecond between the events of one extraction, so a window
 * holding no event with created_at is left as it is.
 *
 * Another clean-up joins as its own part of the plan, with its own line in
 * describeCompaction. compactCollection (eventbase-compaction.js) reads and
 * writes the collection.
 * ============================================================================
 */

import { counted } from '../../shared/counted.js';
import { findReplacedEvents, linksMovedToReplacements, replacementIdsOf, windowSpanOf } from './eventbase-window-replacement-core.js';

/**
 * The events of each window's newest extraction that records when it ran: those with the window's latest created_at.
 *
 * @param {object[]} events - A collection's stored events
 * @returns {object[]}
 */
function newestExtractionEvents(events) {
    const newestTimeBySpan = new Map();
    for (const event of events) {
        if (typeof event.created_at !== 'number') continue;
        const span = windowSpanOf(event);
        newestTimeBySpan.set(span, Math.max(newestTimeBySpan.get(span) ?? -Infinity, event.created_at));
    }
    return events.filter(event => typeof event.created_at === 'number' && event.created_at === newestTimeBySpan.get(windowSpanOf(event)));
}

/**
 * What Compact collection would change, without changing it.
 *
 * @param {object[]} events - A collection's stored events, each with its point's `_hash`
 * @returns {{repeats: object[], repeatWindowCount: number, linkMoves: {event: object, links: object[]}[], movedLinkCount: number}}
 *   repeats, the events it removes; linkMoves, the events whose links it rewrites first
 */
export function planCompaction(events) {
    const newestEvents = newestExtractionEvents(events);
    // No event of the newest extraction is written before it, so none of them goes.
    const repeats = findReplacedEvents(events, newestEvents, new Set());
    const replacementById = replacementIdsOf(repeats, newestEvents);
    const linkMoves = linksMovedToReplacements(events, replacementById);
    return {
        repeats,
        repeatWindowCount: new Set(repeats.map(windowSpanOf)).size,
        linkMoves,
        movedLinkCount: linkMoves.reduce((sum, { event }) => sum + event.story_links.filter(link => replacementById.has(link?.event_id)).length, 0),
    };
}

/**
 * What a compaction plan does, a sentence each, for its confirmation.
 *
 * @param {{repeats: object[], repeatWindowCount: number, movedLinkCount: number}} plan - From planCompaction
 * @returns {string[]}
 */
export function describeCompaction({ repeats, repeatWindowCount, movedLinkCount }) {
    const lines = [
        `It removes ${counted(repeats.length, 'repeated event')} in ${counted(repeatWindowCount, 'window')}. Each window keeps the events of its newest reading.`,
    ];
    if (movedLinkCount === 1) lines.push('1 StoryArc link points at a repeated event, so it moves to the event that stays in its window.');
    if (movedLinkCount > 1) lines.push(`${movedLinkCount} StoryArc links point at a repeated event, so they move to the event that stays in its window.`);
    return lines;
}
