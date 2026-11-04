/**
 * ============================================================================
 * STORY ARC RETRIEVAL
 * ============================================================================
 * Runs a StoryArc recipe against Qdrant. A recipe owns its order and size, so
 * its events skip the shared rerank and the top-K trim, whose recency bonus and
 * size work against a thread that spans the whole chat.
 *
 * Needs no plugin support beyond what VectFox already uses: a wide pool is a
 * larger query, and a subject's earliest events come from listing the collection.
 * ============================================================================
 */

import { listChunks, queryCollection } from '../vector-backend/index.js';
import { dedupeEventsByIdentity, removeEventsVisibleInContext } from './eventbase-retrieval.js';
import {
    FIRST_TIME_POOL_SIZE,
    FIRST_TIME_RECIPE,
    THREAD_SHAPE,
    TIME_ORDERED_EVENT_LIMIT,
    inTimelineOrder,
    recipeForShape,
    selectFirstTimeEvents,
} from './story-arc-core.js';
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
        return (hashes || []).map((hash, i) => ({ ...(metadata?.[i] || {}), _hash: hash, _sortFrame: collectionId }));
    } catch (err) {
        log.warn(`[VectFox-StoryArc] Query failed (${collectionId}):`, err);
        return [];
    }
}

/** Every event stored in one collection, in the same shape as a query hit. */
async function _listStoredEvents(collectionId, settings, boundQuery) {
    try {
        const result = await boundQuery(listChunks(collectionId, settings, LIST_WHOLE_COLLECTION));
        const items = Array.isArray(result?.items) ? result.items : [];
        return items
            .filter(item => item?.metadata?.eventbase === true)
            .map(item => ({ ...item.metadata, text: item.text ?? item.metadata.text, _hash: item.hash, _sortFrame: collectionId }));
    } catch (err) {
        log.warn(`[VectFox-StoryArc] Could not list events (${collectionId}):`, err);
        return [];
    }
}

/**
 * Fetch a recipe's events, in time order. Returns no events when the shape has
 * no recipe or nothing was found, and the caller then keeps today's path.
 *
 * @param {{shape: string, subject: string}} route
 * @param {object} params - The retrieval params (see retrieveEvents)
 * @param {(promise: Promise) => Promise} params.boundQuery - Limits how long one Qdrant call may take
 * @returns {Promise<{events: object[], blockShape: string}>} blockShape says which block the events suit
 */
export async function retrieveStoryRecipeEvents(route, params) {
    const { keywordQuery, searchText, chatLength, settings, liveCollectionIds, additionalCandidates, skipLiveQuery, skipContextDedup, boundQuery } = params;
    const recipe = recipeForShape(route.shape);
    const queryText = keywordQuery || searchText;
    if (!recipe || skipLiveQuery || !liveCollectionIds?.length || !queryText) {
        return { events: [], blockShape: route.shape };
    }

    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
    const usesFirstTimeRecipe = recipe === FIRST_TIME_RECIPE;
    const poolSize = usesFirstTimeRecipe ? FIRST_TIME_POOL_SIZE : TIME_ORDERED_EVENT_LIMIT;
    const pools = await Promise.all(liveCollectionIds.map(collectionId => _queryPool(collectionId, queryText, poolSize, ebSettings, boundQuery)));
    const poolEvents = [...pools.flat(), ...(additionalCandidates || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    let chosen = [];
    if (usesFirstTimeRecipe && route.subject) {
        const stored = await Promise.all(liveCollectionIds.map(collectionId => _listStoredEvents(collectionId, ebSettings, boundQuery)));
        chosen = selectFirstTimeEvents({ storedEvents: stored.flat(), poolEvents, subject: route.subject });
    }
    // A first-time question whose subject is empty or named nowhere still gets the closest events in time order.
    const blockShape = usesFirstTimeRecipe && !chosen.length ? THREAD_SHAPE : route.shape;
    if (!chosen.length) {
        chosen = poolEvents.slice(0, TIME_ORDERED_EVENT_LIMIT);
    }

    const minImportance = settings.eventbase_retrieval_min_importance || 1;
    const important = dedupeEventsByIdentity(chosen).filter(event => event.importance == null || event.importance >= minImportance);
    const notInContext = removeEventsVisibleInContext(important, { chatLength, settings, skipContextDedup });
    return { events: inTimelineOrder(notInContext), blockShape };
}
