/**
 * ============================================================================
 * STORY ARC ENTITIES, SAVED
 * ============================================================================
 * Where a collection's entity merges live: its metadata, which Export and Import
 * carry. What a merge means is in story-arc-entity-core.js.
 * ============================================================================
 */

import { getCollectionMeta, setCollectionMeta } from '../collections/index.js';

/**
 * The merges of the collections a turn reads. A chat normally has one; with more, a
 * later collection's kept name wins.
 *
 * @param {string[]} collectionKeys - Registry keys
 * @returns {Record<string, string[]>}
 */
export function readEntityMerges(collectionKeys) {
    return Object.assign({}, ...collectionKeys.map(key => getCollectionMeta(key).storyEntityMerges));
}

/**
 * @param {string} collectionKey - Registry key
 * @param {Record<string, string[]>} merges
 */
export function saveEntityMerges(collectionKey, merges) {
    setCollectionMeta(collectionKey, { storyEntityMerges: merges });
}
