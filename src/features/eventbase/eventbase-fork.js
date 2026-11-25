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
 * own (settings-panel.js). Matching and selection rules live in
 * eventbase-fork-core.js.
 * ============================================================================
 */

import { getCurrentChatId, getContext } from '../../sillytavern/chat.js';
import { storyMessages } from '../../shared/chat-messages.js';
import { getChatUUID, buildEventBaseCollectionId, buildRegistryKey, getRegistryBackend, parseCollectionId, parseRegistryKey, COLLECTION_PREFIXES } from '../../shared/collection-ids.js';
import {
    getCollectionListing,
    getCollectionMeta,
    registerCollection,
    isCollectionActiveForContextAnyKey,
    removeCollectionLock,
    setCollectionMeta,
    fetchPortableChunks,
    insertChunksWithVectors,
} from '../collections/index.js';
import { purgeVectorIndex } from '../vector-backend/index.js';
import { getModelFromSettings } from '../embedding/index.js';
import { sharedCollectionsLockedHere, useChatCollection } from './eventbase-chat-collections.js';
import { markWindowExtracted, readEventBaseProgress, setVectorizationTip, getCollectionWindowSize, setCollectionWindowSize } from './eventbase-store.js';
import { hashSourceMessage } from './eventbase-message-hash.js';
import {
    measureSharedPrefix,
    rankForkSourcesFromWindowRecords,
    collectSourceMessageHashes,
    selectChunksBeforeSplit,
    toBranchChunk,
    findEmbeddingMismatch,
    summarizeCopiedWindows,
} from './eventbase-fork-core.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { log } from '../../sillytavern/log.js';

/**
 * @typedef {object} EventBaseForkSource
 * @property {'window-record'|'locked-collection'} origin - How the parent was identified
 * @property {string} collectionId - The parent's EventBase collection (bare ID)
 * @property {string} registryKey - Same collection, "backend:id" form
 * @property {number} sharedPrefixLength - Split point: messages shared with the parent
 * @property {number} chatMessageCount - Messages in this chat
 * @property {Array|null} chunks - The parent's chunks when already read (locked-collection origin)
 */

/**
 * Find the collection this chat can fork its EventBase from.
 *
 * Only branches and checkpoints qualify — SillyTavern sets `main_chat` in their
 * metadata. Only a collection in use is read (D18 of vectfox-multi-collection-per-chat.md):
 * first, of the current persona's EventBase collections of other chats on the current
 * backend locked to the parent chat (`main_chat`), the one whose window records share the
 * most of this chat's messages (no backend reads); when that finds nothing, each EventBase
 * collection of another chat locked to this chat, read and matched by its events' stored
 * source hashes. Collections holding the shared messages that are not in use in the parent
 * chat are never read, and `problem` says so.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<{source: EventBaseForkSource|null, problem: string|null}>} source null when nothing can be forked;
 *   problem: why, when the parent's collections hold the shared messages but none is in use there
 */
export async function findEventBaseForkSource(settings) {
    const nothing = { source: null, problem: null };
    const context = getContext();
    if (!context?.chatMetadata?.main_chat) return nothing;

    const chatUUID = getChatUUID();
    const chatId = getCurrentChatId();
    if (!chatUUID || !chatId) return nothing;

    const messages = storyMessages();
    const branchHashes = messages.map(hashSourceMessage);
    const backend = getRegistryBackend(settings?.vector_backend);
    // An EventBase collection of a chat other than this one, its first or a later one.
    const isOtherChatsEventBase = collectionId => collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)
        && parseCollectionId(collectionId).chatUUID !== chatUUID;

    const parentChatId = context.chatMetadata.main_chat;
    const candidates = getCollectionListing(settings)
        .filter(entry => entry.isOwn && entry.backend === backend && isOtherChatsEventBase(entry.collectionId))
        .map(entry => ({
            registryKey: entry.registryKey,
            collectionId: entry.collectionId,
            windowFingerprints: readEventBaseProgress(entry.registryKey).extractedWindows ?? [],
            isLockedToParentChat: isCollectionActiveForContextAnyKey([entry.registryKey, entry.collectionId], { chatId: parentChatId }),
        }));
    const [best] = rankForkSourcesFromWindowRecords(candidates.filter(candidate => candidate.isLockedToParentChat), branchHashes);
    if (best) {
        log.lifecycle(`[EventBase][fork] source from window record: ${best.collectionId}, shares ${best.sharedPrefixLength}/${messages.length} messages (${best.coveredWindowCount} windows)`);
        return {
            source: {
                origin: 'window-record',
                collectionId: best.collectionId,
                registryKey: best.registryKey,
                sharedPrefixLength: best.sharedPrefixLength,
                chatMessageCount: messages.length,
                chunks: null,
            },
            problem: null,
        };
    }

    for (const shared of sharedCollectionsLockedHere({ chatUUID, chatId }).otherChats) {
        const { backend: lockBackend, collectionId } = parseRegistryKey(shared.registryKey);
        if (lockBackend && lockBackend !== backend) continue;
        const chunks = await fetchPortableChunks(collectionId, settings);
        const sharedPrefixLength = measureSharedPrefix(branchHashes, collectSourceMessageHashes(chunks));
        const copyableCount = selectChunksBeforeSplit(chunks, sharedPrefixLength).length;
        log.lifecycle(`[EventBase][fork] locked collection ${collectionId}: shares ${sharedPrefixLength}/${messages.length} messages, ${copyableCount}/${chunks.length} events before the split`);
        if (copyableCount === 0) continue;
        return {
            source: {
                origin: 'locked-collection',
                collectionId,
                registryKey: buildRegistryKey(collectionId, backend),
                sharedPrefixLength,
                chatMessageCount: messages.length,
                chunks,
            },
            problem: null,
        };
    }

    log.lifecycle(`[EventBase][fork] no fork source for chat ${chatUUID} (${candidates.length} collection(s) on ${backend} searched by window record)`);
    // The parent's collections may hold this chat's history while none is in use there: that is not read, but said.
    const [notInUse] = rankForkSourcesFromWindowRecords(candidates, branchHashes);
    if (!notInUse) return nothing;
    return {
        source: null,
        problem: `Collections of another chat hold the first ${notInUse.sharedPrefixLength} messages of this branch, but none `
            + 'is in use in its parent chat, so nothing is forked. Open the parent chat and choose one in Collection in use here, '
            + 'on the AutoSync page, then turn auto-sync on here again.',
    };
}

/**
 * Copy the source's events for the shared messages into this chat's own
 * EventBase collection, then make that collection the chat's active one: locked
 * here, the source unlocked here (its later events belong to the parent's story),
 * and its pointer set from what was copied — the copied windows and their tip —
 * with the source collection's window size, so auto-sync resumes at the split point.
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
    progressTracker.show('Forking EventBase', 3, 'Steps', { unitLabel: 'Events' });
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
        const { storyEntityMerges, storyEntityHiddenNames } = getCollectionMeta(source.registryKey);
        setCollectionMeta(targetRegistryKey, { scope: 'chat', storyEntityMerges, storyEntityHiddenNames });
        // In use in the branch, its other own collections unlocked there; the parent's collection it copied is a
        // collection of another chat, unlocked below.
        useChatCollection(targetRegistryKey, { chatId });
        for (const shared of sharedCollectionsLockedHere({ chatUUID, chatId }).otherChats) {
            if (shared.collectionId !== source.collectionId) continue;
            for (const lockKey of [shared.registryKey, shared.collectionId]) removeCollectionLock(lockKey, chatId);
        }

        const { tip, sourceHashLists } = summarizeCopiedWindows(copiedChunks);
        for (const sourceHashes of sourceHashLists) markWindowExtracted(sourceHashes, targetRegistryKey);
        setVectorizationTip(targetRegistryKey, tip);
        const sourceWindowSize = getCollectionWindowSize(source.registryKey);
        if (typeof sourceWindowSize === 'number') setCollectionWindowSize(targetRegistryKey, sourceWindowSize);

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
