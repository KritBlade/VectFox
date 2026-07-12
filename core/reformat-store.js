/**
 * ============================================================================
 * AUTO-REFORMAT STORE
 * ============================================================================
 * The "freeze" mechanism for Auto-Reformat: once a user accepts a reformatted
 * document, the result is cached here keyed by source-content hash so a
 * later "Vectorize Content" run on the same source reuses it instead of
 * re-invoking the LLM (non-deterministic output would otherwise silently
 * re-cost money/time and could drift from what the user actually reviewed).
 *
 * Genuinely new — nothing like this exists for non-chat content today. Chat's
 * fingerprint/dedup cache (core/eventbase-store.js) is chat-UUID-keyed and
 * unrelated. Kept as its OWN top-level bucket
 * (extension_settings.vectfox.reformat_cache), separate from
 * collection-metadata.js's per-collection object — that store is framed as a
 * lean settings layer, and a full document's original text plus its
 * structured output is a materially different size class than anything else
 * that lives there (see the storage-growth note in the accept-time UI flow).
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { log } from './log.js';

/**
 * @typedef {object} ReformatCacheEntry
 * @property {object[]} chunks - Accepted, validated reformatted chunks
 * @property {string} originalText - Raw pre-reformat source text (retained for audit/revert)
 * @property {string} contentType - 'document' | 'url' | 'wiki'
 * @property {string} sourceName
 * @property {number} acceptedAt - Date.now() at accept time
 * @property {string} providerModel - e.g. "openrouter:openai/gpt-4o-mini"
 * @property {number} schemaVersion
 * @property {string} runId - `${sourceHash}_${acceptedAt}` — stamped onto every
 *        chunk's metadata so a later "Re-run Auto-Reformat" can purge exactly
 *        this generation's chunks from a live collection without touching
 *        anything from a different generation.
 */

function _ensureReformatCacheObject() {
    if (!extension_settings) {
        log.error('VectFox: extension_settings is null/undefined - cannot access reformat_cache');
        return false;
    }
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.reformat_cache) {
        extension_settings.vectfox.reformat_cache = {};
    }
    return true;
}

/**
 * @param {string} sourceHash
 * @returns {ReformatCacheEntry|null}
 */
export function getReformatCache(sourceHash) {
    if (!sourceHash || !_ensureReformatCacheObject()) return null;
    return extension_settings.vectfox.reformat_cache[sourceHash] || null;
}

/**
 * Stores an accepted Auto-Reformat result. Overwrites any prior generation
 * for the same sourceHash (callers wanting to purge the previous
 * generation's live chunk hashes should read the old entry via
 * getReformatCache() BEFORE calling this).
 *
 * @param {string} sourceHash
 * @param {Omit<ReformatCacheEntry, 'runId' | 'acceptedAt'> & {acceptedAt?: number}} data
 * @returns {ReformatCacheEntry}
 */
export function saveReformatCache(sourceHash, data) {
    if (!sourceHash) {
        log.warn('VectFox: saveReformatCache called with null/undefined sourceHash');
        return null;
    }
    _ensureReformatCacheObject();

    const acceptedAt = data.acceptedAt || Date.now();
    const entry = {
        chunks: data.chunks || [],
        originalText: data.originalText || '',
        contentType: data.contentType || '',
        sourceName: data.sourceName || '',
        acceptedAt,
        providerModel: data.providerModel || '',
        schemaVersion: data.schemaVersion || 1,
        runId: `${sourceHash}_${acceptedAt}`,
    };

    extension_settings.vectfox.reformat_cache[sourceHash] = entry;
    saveSettingsDebounced();
    log.lifecycle(`VectFox: Saved Auto-Reformat cache for source ${sourceHash} (${entry.chunks.length} chunks, runId=${entry.runId})`);
    return entry;
}

/**
 * @param {string} sourceHash
 */
export function deleteReformatCache(sourceHash) {
    if (!sourceHash || !_ensureReformatCacheObject()) return;
    if (extension_settings.vectfox.reformat_cache[sourceHash]) {
        delete extension_settings.vectfox.reformat_cache[sourceHash];
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Deleted Auto-Reformat cache for source ${sourceHash}`);
    }
}

/**
 * Lists all cached entries with their storage footprint, for the Database
 * Browser's "Clear Auto-Reformat originals" maintenance action.
 * @returns {Array<{sourceHash: string, sourceName: string, contentType: string, acceptedAt: number, originalTextBytes: number, chunkCount: number}>}
 */
export function listReformatCacheEntries() {
    if (!_ensureReformatCacheObject()) return [];
    return Object.entries(extension_settings.vectfox.reformat_cache).map(([sourceHash, entry]) => ({
        sourceHash,
        sourceName: entry.sourceName,
        contentType: entry.contentType,
        acceptedAt: entry.acceptedAt,
        originalTextBytes: entry.originalText ? entry.originalText.length : 0,
        chunkCount: Array.isArray(entry.chunks) ? entry.chunks.length : 0,
    }));
}

/**
 * Clears the retained `originalText` for every cached entry (keeps the
 * accepted chunks/runId intact — only the audit copy of the raw source is
 * dropped). Used by the Database Browser maintenance action to reclaim
 * settings.json space without breaking the freeze/dedup mechanism, which
 * only depends on sourceHash + chunks, not originalText.
 * @returns {number} Number of entries cleared
 */
export function clearAllReformatOriginals() {
    if (!_ensureReformatCacheObject()) return 0;
    let cleared = 0;
    for (const entry of Object.values(extension_settings.vectfox.reformat_cache)) {
        if (entry.originalText) {
            entry.originalText = '';
            cleared++;
        }
    }
    if (cleared > 0) {
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Cleared retained original text for ${cleared} Auto-Reformat cache entries`);
    }
    return cleared;
}
