/**
 * ============================================================================
 * EVENTBASE COMPACTION
 * ============================================================================
 * Compact collection, a Database Browser button: it reads an EventBase
 * collection, plans what to remove (eventbase-compaction-core.js), and removes
 * it, with no LLM call. StoryArc links move off the events it removes before
 * any event goes, so a stopped or failed move removes nothing, and pressing
 * Compact collection again finishes it.
 * ============================================================================
 */

import { deleteVectorItems } from '../vector-backend/index.js';
import { log } from '../../sillytavern/log.js';
import { announceEventsRemoved } from './eventbase-announcements.js';
import { planCompaction } from './eventbase-compaction-core.js';
import { moveStoryLinks } from './story-arc-links.js';
import { listStoryEvents } from './story-arc-retrieval.js';

/**
 * What Compact collection would change in a collection, without changing it.
 *
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<object>} the plan, from planCompaction
 * @throws When the collection's events cannot be read
 */
export async function planCollectionCompaction(collectionId, settings) {
    const events = await listStoryEvents(collectionId, settings);
    if (!events) throw new Error('Could not read this collection\'s events. See the console.');
    return planCompaction(events);
}

/**
 * Carry out a compaction plan: move the StoryArc links first, then remove the repeated events, whose IDs go to
 * EventBase's listener (announceEventsRemoved).
 *
 * @param {{repeats: object[], repeatWindowCount: number, linkMoves: object[]}} plan - From planCollectionCompaction
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<{removedCount: number, linkMoves: {writtenCount: number, failedCount: number, isStopped: boolean}}>}
 *   removedCount 0 when the links did not all move, which the progress panel reports
 * @throws When the events cannot be removed, after the links moved
 */
export async function compactCollection(plan, collectionId, settings) {
    const linkMoves = plan.linkMoves.length > 0
        ? await moveStoryLinks(plan.linkMoves, collectionId, settings)
        : { writtenCount: 0, failedCount: 0, isStopped: false };
    if (linkMoves.failedCount > 0 || linkMoves.isStopped) return { removedCount: 0, linkMoves };

    await deleteVectorItems(collectionId, plan.repeats.map(event => event._hash), settings);
    announceEventsRemoved(collectionId, plan.repeats.map(event => event.event_id));
    log.lifecycle(`[EventBase] Compacted ${collectionId}: removed ${plan.repeats.length} repeated event(s) in ${plan.repeatWindowCount} window(s), and moved the links of ${linkMoves.writtenCount} event(s)`);
    return { removedCount: plan.repeats.length, linkMoves };
}
