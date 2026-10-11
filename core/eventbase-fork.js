/**
 * ============================================================================
 * EVENTBASE FORK
 * ============================================================================
 * Gives a branch or checkpoint chat its own EventBase collection by copying the
 * parent chat's events for the messages both chats share — stored vectors and
 * all, so no LLM extraction and no re-embedding. Auto-sync then extracts only
 * the messages after the split point.
 *
 * Offered from the auto-sync checkbox when the chat has no collection of its
 * own (ui-manager.js). Matching and selection rules live in
 * eventbase-fork-core.js.
 * ============================================================================
 */

import { getCurrentChatId } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getChatUUID, buildEventBaseCollectionId, buildRegistryKey, getRegistryBackend, parseRegistryKey, COLLECTION_PREFIXES } from './collection-ids.js';
import { registerCollection } from './collection-loader.js';
import { getChatLockedCollections, removeCollectionLock, setCollectionLock, setCollectionMeta } from './collection-metadata.js';
import { fetchPortableChunks, insertChunksWithVectors } from './collection-export.js';
import { purgeVectorIndex } from './core-vector-api.js';
import { getModelFromSettings } from './providers.js';
import { resolveActiveEventBaseCollection, markWindowExtracted, setVectorizationTip, getLastUsedWindowSize, setLastUsedWindowSize } from './eventbase-store.js';
import { hashSourceMessage } from './eventbase-message-hash.js';
import {
    measureSharedPrefix,
    rankForkSourcesFromWindowRecord,
    collectSourceMessageHashes,
    selectChunksBeforeSplit,
    toBranchChunk,
    findEmbeddingMismatch,
    summarizeCopiedWindows,
} from './eventbase-fork-core.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { log } from './log.js';

/**
 * @typedef {object} EventBaseForkSource
 * @property {'window-record'|'locked-collection'} origin - How the parent was identified
 * @property {string} collectionId - The parent's EventBase collection (bare ID)
 * @property {string} registryKey - Same collection, "backend:id" form
 * @property {string|null} sourceChatUUID - The parent chat's UUID (window-record origin only)
 * @property {number} sharedPrefixLength - Split point: messages shared with the parent
 * @property {number} chatMessageCount - Messages in this chat
 * @property {Array|null} chunks - The parent's chunks when already read (locked-collection origin)
 */

/**
 * Find the collection this chat can fork its EventBase from.
 *
 * Only branches and checkpoints qualify — SillyTavern sets `main_chat` in their
 * metadata. The parent is identified from the local window record first (no
 * backend reads); when that finds nothing, each EventBase collection of another
 * chat that is locked to this chat is read and matched by its events' stored
 * source hashes.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<EventBaseForkSource|null>} null when nothing can be forked
 */
export async function findEventBaseForkSource(settings) {
    const context = getContext();
    if (!context?.chatMetadata?.main_chat) return null;

    const chatUUID = getChatUUID();
    const chatId = getCurrentChatId();
    if (!chatUUID || !chatId) return null;

    const messages = (Array.isArray(context.chat) ? context.chat : [])
        .filter(m => m.mes && m.mes.trim().length > 0);
    const branchHashes = messages.map(hashSourceMessage);
    const backend = getRegistryBackend(settings?.vector_backend);

    const ranked = rankForkSourcesFromWindowRecord(
        extension_settings?.vectfox?.eventbase_extracted_windows, branchHashes, chatUUID);
    for (const candidate of ranked) {
        const collection = resolveActiveEventBaseCollection(settings, candidate.chatUUID, { shouldLogResolution: false });
        if (!collection || parseRegistryKey(collection.registryKey).backend !== backend) continue;
        log.lifecycle(`[EventBase][fork] source from window record: chat ${candidate.chatUUID} → ${collection.collectionId}, shares ${candidate.sharedPrefixLength}/${messages.length} messages (${candidate.coveredWindowCount} windows)`);
        return {
            origin: 'window-record',
            collectionId: collection.collectionId,
            registryKey: collection.registryKey,
            sourceChatUUID: candidate.chatUUID,
            sharedPrefixLength: candidate.sharedPrefixLength,
            chatMessageCount: messages.length,
            chunks: null,
        };
    }

    for (const lockKey of getChatLockedCollections(chatId)) {
        const { backend: lockBackend, collectionId } = parseRegistryKey(lockKey);
        if (!collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) || collectionId.endsWith(chatUUID)) continue;
        if (lockBackend && lockBackend !== backend) continue;
        const chunks = await fetchPortableChunks(collectionId, settings);
        const sharedPrefixLength = measureSharedPrefix(branchHashes, collectSourceMessageHashes(chunks));
        const copyableCount = selectChunksBeforeSplit(chunks, sharedPrefixLength).length;
        log.lifecycle(`[EventBase][fork] locked collection ${collectionId}: shares ${sharedPrefixLength}/${messages.length} messages, ${copyableCount}/${chunks.length} events before the split`);
        if (copyableCount === 0) continue;
        return {
            origin: 'locked-collection',
            collectionId,
            registryKey: buildRegistryKey(collectionId, backend),
            sourceChatUUID: null,
            sharedPrefixLength,
            chatMessageCount: messages.length,
            chunks,
        };
    }

    log.lifecycle(`[EventBase][fork] no fork source for chat ${chatUUID} (${ranked.length} window-record candidate(s), none with a usable collection on ${backend})`);
    return null;
}

/**
 * Copy the source's events for the shared messages into this chat's own
 * EventBase collection, then make that collection the chat's active one: locked
 * here, the source unlocked here (its later events belong to the parent's story),
 * and the tip, window record and window size carried over so auto-sync resumes
 * at the split point.
 *
 * Shows the progress panel and can be stopped from it. On failure or stop during
 * the copy, the partially written collection is purged.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {EventBaseForkSource} source - From findEventBaseForkSource
 * @returns {Promise<{ collectionId: string, registryKey: string, eventCount: number, tip: number }>}
 * @throws {Error} When nothing can be copied, vectors are missing, the embedding
 *   model differs, the backend write fails, or the user stops it (AbortError).
 */
export async function forkEventBaseFromSource(settings, source) {
    const chatUUID = getChatUUID();
    const chatId = getCurrentChatId();
    if (!chatUUID || !chatId) throw new Error('No chat is open');

    const targetCollectionId = buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    const targetRegistryKey = buildRegistryKey(targetCollectionId, settings);

    const abortController = new AbortController();
    const throwIfStopped = () => {
        if (abortController.signal.aborted) {
            throw Object.assign(new Error('Fork stopped by user'), { name: 'AbortError' });
        }
    };
    progressTracker.show('Forking EventBase', 3, 'Steps');
    progressTracker.updateCurrentItem(targetCollectionId);
    progressTracker.setCancelHandler(() => abortController.abort('user-stop'));

    let isCopyInProgress = false;
    try {
        progressTracker.updateProgress(1, 'Reading parent events...');
        const sourceChunks = source.chunks ?? await fetchPortableChunks(source.collectionId, settings);
        const copiedChunks = selectChunksBeforeSplit(sourceChunks, source.sharedPrefixLength)
            .map(chunk => toBranchChunk(chunk, chatUUID));
        if (copiedChunks.length === 0) {
            throw new Error(`${source.collectionId} has no events before message ${source.sharedPrefixLength}`);
        }
        const missingVectorCount = copiedChunks.filter(c => !Array.isArray(c.vector) || c.vector.length === 0).length;
        if (missingVectorCount > 0) {
            throw new Error(`${missingVectorCount} of ${copiedChunks.length} parent events came back without vectors — cannot copy them without re-embedding`);
        }
        const embeddingMismatch = findEmbeddingMismatch(copiedChunks, {
            source: settings.embedding_provider,
            model: getModelFromSettings(settings),
        });
        if (embeddingMismatch) {
            throw new Error(`Parent events were embedded with ${embeddingMismatch.embeddingSource || '?'} / ${embeddingMismatch.embeddingModel || '?'}, but the current embedding is ${settings.embedding_provider} / ${getModelFromSettings(settings)}. Switch the embedding back, or vectorize this chat from scratch.`);
        }
        throwIfStopped();

        progressTracker.updateChunks(copiedChunks.length);
        progressTracker.updateProgress(2, `Copying ${copiedChunks.length} events...`);
        isCopyInProgress = true;
        await insertChunksWithVectors(targetCollectionId, copiedChunks, settings, (done, total) => {
            progressTracker.updateEmbeddingProgress(done, total);
        }, abortController.signal);
        isCopyInProgress = false;

        progressTracker.updateProgress(3, 'Activating for this chat...');
        registerCollection(targetRegistryKey);
        setCollectionMeta(targetRegistryKey, { scope: 'chat' });
        setCollectionLock(targetRegistryKey, chatId);
        for (const lockKey of getChatLockedCollections(chatId)) {
            if (parseRegistryKey(lockKey).collectionId === source.collectionId) removeCollectionLock(lockKey, chatId);
        }

        const { tip, sourceHashLists } = summarizeCopiedWindows(copiedChunks);
        for (const sourceHashes of sourceHashLists) markWindowExtracted(sourceHashes, chatUUID);
        setVectorizationTip(chatUUID, tip);
        const sourceWindowSize = source.sourceChatUUID ? getLastUsedWindowSize(source.sourceChatUUID) : undefined;
        if (typeof sourceWindowSize === 'number') setLastUsedWindowSize(chatUUID, sourceWindowSize);

        log.lifecycle(`[EventBase][fork] copied ${copiedChunks.length} event(s) from ${source.collectionId} into ${targetCollectionId}; tip=${tip}, split=${source.sharedPrefixLength}`);
        progressTracker.complete(true, `Forked ${copiedChunks.length} events from the parent chat`);
        return { collectionId: targetCollectionId, registryKey: targetRegistryKey, eventCount: copiedChunks.length, tip };
    } catch (error) {
        if (isCopyInProgress) {
            try {
                await purgeVectorIndex(targetCollectionId, settings);
            } catch (purgeError) {
                log.warn(`[EventBase][fork] purge of partially copied ${targetCollectionId} failed:`, purgeError);
            }
        }
        const isStopped = error?.name === 'AbortError';
        if (!isStopped) progressTracker.addError(error.message);
        progressTracker.complete(false, isStopped ? 'Fork stopped' : 'Fork failed');
        throw error;
    } finally {
        progressTracker.clearCancelHandler();
    }
}
