/**
 * ============================================================================
 * EVENTBASE SEARCH
 * ============================================================================
 * How every EventBase search queries an event collection: with EventBase's own
 * keyword scoring and similarity threshold, never ChunkBase's. Standard applies
 * the threshold inside its query. Qdrant's query keeps every score, so the events
 * it returns below the threshold are dropped here, by the same similarity the
 * re-rank's cosine weight reads.
 * ============================================================================
 */

import { queryCollection } from '../vector-backend/index.js';
import { resolveBackendForCollection } from '../../shared/collection-ids.js';
import { log } from '../../sillytavern/log.js';

/**
 * The settings an EventBase search runs with: EventBase's keyword scoring and
 * similarity threshold in place of ChunkBase's.
 *
 * @param {object} settings - VectFox settings
 * @param {number} [threshold] - The similarity threshold, the EventBase page's when absent
 * @returns {object}
 */
export function eventSearchSettings(settings, threshold = settings.eventbase_score_threshold ?? 0) {
    return {
        ...settings,
        keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25',
        score_threshold: threshold,
    };
}

/**
 * An event hit's similarity to the query, 0 to 1. A fused or formula score can
 * hold `score`, so the raw similarity in `vectorScore` comes first.
 *
 * @param {object} hit
 * @returns {number}
 */
export function eventSimilarityOf(hit) {
    if (typeof hit.vectorScore === 'number') return hit.vectorScore;
    return typeof hit.score === 'number' ? hit.score : 0;
}

/** Whether VectFox drops this collection's hits below the threshold itself: Qdrant's query keeps every score. */
function shouldApplyThresholdAfterSearch(collectionId, settings) {
    return (resolveBackendForCollection(collectionId).backend || settings.vector_backend || 'standard') === 'qdrant';
}

/**
 * Search one event collection.
 *
 * @param {string} collectionId - Registry key or bare ID
 * @param {string} queryText
 * @param {number} topK
 * @param {object} settings - VectFox settings
 * @param {object} [options]
 * @param {number[]|null} [options.queryVector] - The query's embedding, when the caller has it
 * @param {number} [options.threshold] - The similarity threshold, the EventBase page's when absent
 * @returns {Promise<{hashes: number[], metadata: object[]}>}
 */
export async function searchEventCollection(collectionId, queryText, topK, settings, { queryVector = null, threshold } = {}) {
    const searchSettings = eventSearchSettings(settings, threshold);
    const result = await queryCollection(collectionId, queryText, topK, searchSettings, queryVector);
    const floor = searchSettings.score_threshold;
    if (!(floor > 0) || !shouldApplyThresholdAfterSearch(collectionId, settings)) return result;
    const hits = (result.hashes || []).map((hash, i) => ({ hash, hit: result.metadata?.[i] || {} }));
    const kept = hits.filter(({ hit }) => eventSimilarityOf(hit) >= floor);
    if (kept.length < hits.length) {
        log.verbose(`[EventBase] Similarity threshold ${floor} dropped ${hits.length - kept.length} of ${hits.length} events (${collectionId})`);
    }
    return { hashes: kept.map(({ hash }) => hash), metadata: kept.map(({ hit }) => hit) };
}

/**
 * Re-ranked events at or above the threshold. Qdrant's re-rank scores by a formula
 * that holds no similarity, so each event takes its similarity from a plain search of
 * the same query, as wide as the re-rank's own similarity leg. An event outside it
 * matched by keywords alone, and is dropped.
 *
 * @param {object[]} events - Re-ranked events, each with `_hash`
 * @param {{hashes: number[], metadata: object[]}} similaritySearch - The plain search's result
 * @param {number} threshold
 * @returns {object[]} the events kept, each with its similarity in `vectorScore`
 */
export function keepRerankedEventsAtThreshold(events, similaritySearch, threshold) {
    const similarityByHash = new Map((similaritySearch.hashes || []).map((hash, i) => [String(hash), eventSimilarityOf(similaritySearch.metadata?.[i] || {})]));
    const kept = events
        .map(event => ({ ...event, vectorScore: similarityByHash.get(String(event._hash)) ?? 0 }))
        .filter(event => event.vectorScore >= threshold);
    if (kept.length < events.length) {
        log.verbose(`[EventBase] Similarity threshold ${threshold} dropped ${events.length - kept.length} of ${events.length} re-ranked events`);
    }
    return kept;
}
