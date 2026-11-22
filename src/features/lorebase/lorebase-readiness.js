/**
 * Whether an entry is ready (§4.4 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): its keys are stored, and
 * Qdrant holds every part of its vectors from the embedding model set now, as this session last read or wrote them.
 * The one test of it: a reply sends only ready entries, and turning LoreBase on, the WorldInfo page's counts, the
 * selection screen's rows, summary, filter and footer count them by it. An entry being written anew stays ready on what
 * it has; its row says it is being written.
 */
import { hasStoredKeys } from './lorebase-keys.js';
import { hasStoredCurrentVectors } from './lorebase-vectors.js';

/**
 * Whether an entry is ready: read its book's keys and vectors first (readBookKeys, bookVectors or readBookVectors).
 * @param {string} bookName
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @param {object} settings - VectFox settings
 * @returns {boolean}
 */
export function isEntryReady(bookName, entry, settings) {
    return hasStoredKeys(bookName, entry.uid) && hasStoredCurrentVectors(bookName, entry, settings);
}
