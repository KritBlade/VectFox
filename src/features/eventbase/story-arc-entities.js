/**
 * ============================================================================
 * STORY ARC ENTITIES, SAVED
 * ============================================================================
 * Where a collection's entity merges and the names the Entity tab hides live: its
 * metadata, which Export and Import carry. What a merge means is in
 * story-arc-entity-core.js. Hidden names are read by the Entity tab only.
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

/**
 * The kept names the Entity tab keeps off its list. StoryArc still reads every one of them.
 *
 * @param {string} collectionKey - Registry key
 * @returns {string[]}
 */
export function readHiddenEntityNames(collectionKey) {
    const hiddenNames = getCollectionMeta(collectionKey).storyEntityHiddenNames;
    return Array.isArray(hiddenNames) ? hiddenNames : [];
}

/**
 * @param {string} collectionKey - Registry key
 * @param {string[]} hiddenNames
 */
export function saveHiddenEntityNames(collectionKey, hiddenNames) {
    setCollectionMeta(collectionKey, { storyEntityHiddenNames: hiddenNames });
}
