/**
 * ============================================================================
 * EVENTBASE FORK — pure logic
 * ============================================================================
 * A SillyTavern branch or checkpoint starts as a copy of its parent chat's first
 * messages but gets its own chat UUID, so it has no EventBase collection of its
 * own. Forking copies the parent's events for the shared messages into one.
 *
 * The parent is found by message content, not by chat file: every extracted
 * window is recorded as the hashes of its source messages (the window record in
 * each collection's pointer, and `source_message_hashes` on every stored event).
 * The parent is the collection whose recorded hashes match the longest run of this
 * chat's opening messages; that run's length is the split point. Only events whose source
 * window ends before the split point are copied — everything after it belongs to
 * the parent's own continuation.
 *
 * Message hashes come from hashSourceMessage (eventbase-message-hash.js). Chunks
 * use the portable shape from fetchPortableChunks (collection-export.js).
 * ============================================================================
 */

/**
 * Length of the run of leading messages whose hashes are all known.
 *
 * @param {Array<number|string>} branchHashes - This chat's message hashes, in order
 * @param {Set<string>} knownHashes - Hashes recorded for the candidate parent (as strings)
 * @returns {number}
 */
export function measureSharedPrefix(branchHashes, knownHashes) {
    let length = 0;
    while (length < branchHashes.length && knownHashes.has(String(branchHashes[length]))) length++;
    return length;
}

/**
 * Rank collections as fork sources for this chat by their window records: the windows
 * each has read, kept in its pointer.
 *
 * A candidate needs at least one recorded window made entirely of shared
 * messages — otherwise nothing before the split point was ever extracted. This
 * also rules out unrelated chats of the same character, which typically share
 * only the greeting.
 *
 * @param {Array<{ registryKey: string, collectionId: string, windowFingerprints: string[], isLockedToParentChat: boolean }>} candidates -
 *   Collections of other chats, each with its window record (each fingerprint the window's source hashes, sorted,
 *   comma-joined) and whether it is locked to the branch's parent chat
 * @param {Array<number|string>} branchHashes - This chat's message hashes, in order
 * @returns {Array<{ registryKey: string, collectionId: string, sharedPrefixLength: number, coveredWindowCount: number }>}
 *   Longest shared prefix first; of two that share as many messages, the one locked to the parent chat, then the one
 *   with more covered windows.
 */
export function rankForkSourcesFromWindowRecords(candidates, branchHashes) {
    const ranked = [];
    for (const { registryKey, collectionId, windowFingerprints, isLockedToParentChat } of candidates) {
        if (!Array.isArray(windowFingerprints)) continue;
        const windows = windowFingerprints.map(fingerprint => String(fingerprint).split(','));
        const sharedPrefixLength = measureSharedPrefix(branchHashes, new Set(windows.flat()));
        if (sharedPrefixLength === 0) continue;
        const prefixHashes = new Set(branchHashes.slice(0, sharedPrefixLength).map(String));
        const coveredWindowCount = windows.filter(window => window.every(hash => prefixHashes.has(hash))).length;
        if (coveredWindowCount === 0) continue;
        ranked.push({ registryKey, collectionId, sharedPrefixLength, coveredWindowCount, isLockedToParentChat: Boolean(isLockedToParentChat) });
    }
    ranked.sort((a, b) => (b.sharedPrefixLength - a.sharedPrefixLength)
        || (Number(b.isLockedToParentChat) - Number(a.isLockedToParentChat))
        || (b.coveredWindowCount - a.coveredWindowCount));
    return ranked.map(({ registryKey, collectionId, sharedPrefixLength, coveredWindowCount }) =>
        ({ registryKey, collectionId, sharedPrefixLength, coveredWindowCount }));
}

/**
 * Every source message hash stored on a collection's events, as strings — the
 * known-hash set when the parent is identified from a collection rather than the
 * local window record.
 *
 * @param {Array<{ metadata?: object }>} chunks
 * @returns {Set<string>}
 */
export function collectSourceMessageHashes(chunks) {
    const hashes = new Set();
    for (const chunk of chunks) {
        const sourceHashes = chunk.metadata?.source_message_hashes;
        if (!Array.isArray(sourceHashes)) continue;
        for (const hash of sourceHashes) hashes.add(String(hash));
    }
    return hashes;
}

/**
 * Events whose source window ends before the split point. Events edited in the
 * parent after extraction are kept: the parent still uses them for the same
 * messages. Chunks without a numeric `source_window_end` are not events of a
 * chat window and are dropped.
 *
 * @param {Array<{ metadata?: object }>} chunks
 * @param {number} splitPoint - First message index NOT shared with the parent
 * @returns {Array}
 */
export function selectChunksBeforeSplit(chunks, splitPoint) {
    return chunks.filter(chunk => {
        const windowEnd = chunk.metadata?.source_window_end;
        return typeof windowEnd === 'number' && windowEnd < splitPoint;
    });
}

/**
 * The copy of a parent event stored in the branch's collection: the same point
 * (hash, text, vector) with `chat_uuid` set to the branch.
 *
 * @param {{ metadata?: object }} chunk
 * @param {string} branchChatUUID
 * @returns {object}
 */
export function toBranchChunk(chunk, branchChatUUID) {
    return { ...chunk, metadata: { ...chunk.metadata, chat_uuid: branchChatUUID } };
}

/**
 * First chunk embedded with a different provider or model than the current
 * settings, or null. Fields absent from a chunk's payload are not compared.
 *
 * @param {Array<{ metadata?: object }>} chunks
 * @param {{ source?: string, model?: string }} current
 * @returns {{ embeddingSource?: string, embeddingModel?: string } | null}
 */
export function findEmbeddingMismatch(chunks, { source, model }) {
    for (const chunk of chunks) {
        const { embeddingSource, embeddingModel } = chunk.metadata || {};
        const isSourceDifferent = Boolean(embeddingSource && source && embeddingSource !== source);
        const isModelDifferent = Boolean(embeddingModel && model && embeddingModel !== model);
        if (isSourceDifferent || isModelDifferent) return { embeddingSource, embeddingModel };
    }
    return null;
}

/**
 * Extraction bookkeeping the branch inherits from the copied events: the
 * vectorization tip (one past the last covered message) and each copied
 * window's source hashes, for the branch's window record.
 *
 * @param {Array<{ metadata?: object }>} chunks
 * @returns {{ tip: number, sourceHashLists: Array<Array<number|string>> }}
 */
export function summarizeCopiedWindows(chunks) {
    let maxWindowEnd = -1;
    const sourceHashLists = [];
    for (const chunk of chunks) {
        const { source_window_end: windowEnd, source_message_hashes: sourceHashes } = chunk.metadata || {};
        if (typeof windowEnd === 'number' && windowEnd > maxWindowEnd) maxWindowEnd = windowEnd;
        if (Array.isArray(sourceHashes) && sourceHashes.length > 0) sourceHashLists.push(sourceHashes);
    }
    return { tip: maxWindowEnd + 1, sourceHashLists };
}
