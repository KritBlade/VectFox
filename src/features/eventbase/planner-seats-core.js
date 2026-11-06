/**
 * ============================================================================
 * PLANNER SEATS
 * ============================================================================
 * The seats Agent Mode's planner adds beside the pre-search's. A query's best hits
 * are mostly events the pre-search already found, so its seats go only to events
 * from outside the pre-search's results, and the pre-search loses none of its own.
 * ============================================================================
 */

/** Seats the planner's searches add beside the pre-search's. */
const PLANNER_ADDED_SEATS = 5;

const identityOf = event => event.event_id ?? event._hash;

/**
 * The events the planner's searches add. The queries take turns, in their order, each
 * seating its best hit the pre-search did not find. A hit that may not take a seat, or
 * that repeats a seated event, costs its query nothing, and the query moves on.
 *
 * @param {object} params
 * @param {object[][]} params.hitLists - Each query's hits, closest first
 * @param {object[]} params.poolEvents - Everything the pre-search found, before its top-K trim
 * @param {object[]} params.seatedEvents - The events the pre-search kept
 * @param {(event: object) => boolean} params.canTakeSeat - Whether a retrieval's filters allow the event
 * @param {(candidate: object, seated: object) => boolean} params.isDuplicate - Whether a candidate repeats a seated event
 * @returns {object[]} the added events, in the order they were seated
 */
export function seatPlannerHits({ hitLists, poolEvents, seatedEvents, canTakeSeat, isDuplicate }) {
    const seen = new Set([...poolEvents, ...seatedEvents].map(identityOf));
    const seated = [...seatedEvents];
    const added = [];
    const nextHitOfList = hitLists.map(() => 0);
    let didAnyQuerySeat = true;
    while (added.length < PLANNER_ADDED_SEATS && didAnyQuerySeat) {
        didAnyQuerySeat = false;
        for (let listPlace = 0; listPlace < hitLists.length && added.length < PLANNER_ADDED_SEATS; listPlace++) {
            while (nextHitOfList[listPlace] < hitLists[listPlace].length) {
                const hit = hitLists[listPlace][nextHitOfList[listPlace]++];
                if (seen.has(identityOf(hit))) continue;
                seen.add(identityOf(hit));
                if (!canTakeSeat(hit) || seated.some(other => isDuplicate(hit, other))) continue;
                seated.push(hit);
                added.push(hit);
                didAnyQuerySeat = true;
                break;
            }
        }
    }
    return added;
}
