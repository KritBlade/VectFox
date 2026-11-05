/**
 * ============================================================================
 * STORY ARC RETRIEVAL
 * ============================================================================
 * Runs a StoryArc recipe against Qdrant. A recipe owns its order and size, so
 * its events skip the shared rerank and the top-K trim, whose recency bonus and
 * size work against a thread that spans the whole chat. A long block is then cut
 * to the lines that answer the question.
 *
 * Needs no plugin support beyond what VectFox already uses: a wide pool is a
 * larger query, and the links to walk come from listing the collection.
 * ============================================================================
 */

import { listChunks, queryCollection } from '../vector-backend/index.js';
import { dedupeEventsByIdentity, removeEventsVisibleInContext } from './eventbase-retrieval.js';
import { STORY_POOL_SIZE, STORY_ROUTE_RULE, cutBlockToSeats, hasRecipe, hasThreadPick, isBlockCutNeeded, selectStoryRecipeEvents } from './story-arc-core.js';
import { inTimelineOrder, measureStoryLinkCoverage } from './story-arc-links-core.js';
import { log } from '../../sillytavern/log.js';

/** Lists the whole collection: a limit below its size would return an arbitrary sample. */
const LIST_WHOLE_COLLECTION = { limit: 50000 };

/**
 * One collection's hybrid hits, closest first. A failed query counts as no hits,
 * so the other collections still count.
 */
async function _queryPool(collectionId, queryText, poolSize, settings, boundQuery) {
    try {
        const { hashes, metadata } = await boundQuery(queryCollection(collectionId, queryText, poolSize, settings, {}));
        return (hashes || []).map((hash, i) => ({ ...(metadata?.[i] || {}), _hash: Number(hash), _sortFrame: collectionId }));
    } catch (err) {
        log.warn(`[VectFox-StoryArc] Query failed (${collectionId}):`, err);
        return [];
    }
}

/**
 * Every event stored in one collection, in the same shape as a query hit.
 *
 * @param {string} collectionId
 * @param {object} settings
 * @param {(promise: Promise) => Promise} [boundQuery] - Limits how long the call may take
 * @returns {Promise<object[]|null>} null when the collection could not be read, which is reported
 */
export async function listStoryEvents(collectionId, settings, boundQuery = promise => promise) {
    try {
        const result = await boundQuery(listChunks(collectionId, settings, LIST_WHOLE_COLLECTION));
        const items = Array.isArray(result?.items) ? result.items : [];
        return items
            .filter(item => item?.metadata?.eventbase === true)
            .map(item => ({ ...item.metadata, text: item.text ?? item.metadata.text, _hash: Number(item.hash), _sortFrame: collectionId }));
    } catch (err) {
        log.warn(`[VectFox-StoryArc] Could not list events (${collectionId}):`, err);
        return null;
    }
}

/**
 * Hits from several searches, closest first: each search's first hits, then their
 * second, and so on. A hit's place is its search's fusion order, which says more
 * than its `score`, a cosine that leaves out the keyword match.
 */
function _mergeHitsByPlace(hitLists) {
    return hitLists
        .flatMap(hits => hits.map((hit, place) => ({ hit, place })))
        .sort((a, b) => a.place - b.place)
        .map(({ hit }) => hit);
}

/**
 * Cut a long block, after the filters every retrieval applies, so a filtered event
 * takes no seat. `cutRuleName` is empty when the block needed no cut.
 */
async function _cutLongBlock(route, events, poolEvents, chooseBlockEvents) {
    if (!chooseBlockEvents || !isBlockCutNeeded(route.shape, events.length)) return { events, cutRuleName: '' };
    const chosenEvents = await chooseBlockEvents(events);
    return {
        events: cutBlockToSeats({ shape: route.shape, subject: route.subject, events, poolEvents, chosenEvents }),
        cutRuleName: chosenEvents ? STORY_ROUTE_RULE.BLOCK_CUT : STORY_ROUTE_RULE.BLOCK_CUT_FAILED,
    };
}

/**
 * Fetch a recipe's events, in time order. Returns no events when the turn should
 * keep today's path, and `ruleName` says which Route rule decided that.
 *
 * @param {{shape: string, subject: string}} route
 * @param {object} params - The retrieval params (see retrieveEvents)
 * @param {(promise: Promise) => Promise} params.boundQuery - Limits how long one Qdrant call may take
 * @param {(storedEvents: object[]) => Promise<string[]|null>} [params.pickThreads] - Asks an LLM which threads could hold the answer; null when that failed
 * @param {(events: object[]) => Promise<object[]|null>} [params.chooseBlockEvents] - Asks an LLM which of a long block's events answer the question; null when that failed. Without it, no block is cut
 * @returns {Promise<{events: object[], blockShape: string, ruleName: string, cutRuleName: string, pickedThreadCount: number}>} blockShape says which block the events suit
 */
export async function retrieveStoryRecipeEvents(route, params) {
    const { keywordQuery, searchText, chatLength, settings, liveCollectionIds, additionalCandidates, skipLiveQuery, skipContextDedup, boundQuery, pickThreads = async () => [], chooseBlockEvents } = params;
    const queryText = keywordQuery || searchText;
    if (!hasRecipe(route.shape) || skipLiveQuery || !liveCollectionIds?.length || !queryText) {
        return { events: [], blockShape: route.shape, ruleName: STORY_ROUTE_RULE.RECIPE_FOUND_NOTHING, cutRuleName: '', pickedThreadCount: 0 };
    }

    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
    const [pools, stored] = await Promise.all([
        Promise.all(liveCollectionIds.map(collectionId => _queryPool(collectionId, queryText, STORY_POOL_SIZE, ebSettings, boundQuery))),
        Promise.all(liveCollectionIds.map(collectionId => listStoryEvents(collectionId, ebSettings, boundQuery))),
    ]);
    if (stored.includes(null)) {
        return { events: [], blockShape: route.shape, ruleName: STORY_ROUTE_RULE.LISTING_FAILED, cutRuleName: '', pickedThreadCount: 0 };
    }
    const poolEvents = _mergeHitsByPlace([...pools, additionalCandidates || []]);
    const storedEvents = stored.flat();
    const pickedThreads = hasThreadPick(route.shape) && measureStoryLinkCoverage(storedEvents).hasUsableLinks ? await pickThreads(storedEvents) : [];
    const selection = selectStoryRecipeEvents({ shape: route.shape, subject: route.subject, storedEvents, poolEvents, pickedThreads: pickedThreads ?? [] });

    const minImportance = settings.eventbase_retrieval_min_importance || 1;
    const important = dedupeEventsByIdentity(selection.events).filter(event => event.importance == null || event.importance >= minImportance);
    const block = inTimelineOrder(removeEventsVisibleInContext(important, { chatLength, settings, skipContextDedup }));
    const { events, cutRuleName } = await _cutLongBlock(route, block, poolEvents, chooseBlockEvents);
    // A current-state question has no recipe without links, which is a different reason from finding nothing.
    const isWaitingForLinks = route.shape === 'current' && selection.ruleName === STORY_ROUTE_RULE.LINKS_NOT_GENERATED;
    const ruleName = pickedThreads === null ? STORY_ROUTE_RULE.THREAD_PICK_FAILED : selection.ruleName;
    return {
        events,
        blockShape: selection.blockShape,
        ruleName: events.length || isWaitingForLinks ? ruleName : STORY_ROUTE_RULE.RECIPE_FOUND_NOTHING,
        cutRuleName,
        pickedThreadCount: pickedThreads?.length ?? 0,
    };
}
