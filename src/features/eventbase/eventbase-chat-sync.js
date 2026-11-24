/**
 * Running EventBase over the open chat: auto-sync after chat events (synchronizeChat, which src/index.js runs through
 * SillyTavern's module worker) and the Vectorize Content dialog's runs (runEventBaseOnOpenChat).
 */
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { is_send_press } from '../../sillytavern/generation.js';
import { log } from '../../sillytavern/log.js';
import { getChatUUID } from '../../shared/collection-ids.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { isBackendAvailable } from '../vector-backend/index.js';
import { collectionInUse, showNoCollectionInUse } from './eventbase-chat-collections.js';
import { pauseCollectionAutoSync } from './eventbase-store.js';
import { countUnfinishedWindows, getAutoSyncWindowSize, notifyUnfinishedWindows, runEventBaseIngestion } from './eventbase-workflow.js';

/** Chats already told that auto-sync left windows undone, so a failing provider does not toast on every turn. */
const chatsWarnedOfUnfinishedWindows = new Set();

/**
 * Auto-sync: runs EventBase over the open chat's new windows when the chat's collection in use (collectionInUse) has
 * auto-sync on. With none in use it writes nothing, and while one of the chat's collections has auto-sync on, it says
 * so in red for each message (D18 of vectfox-multi-collection-per-chat.md). A model the provider no longer knows turns
 * auto-sync off for the collection in use, with one notice, so it stops failing on every message.
 *
 * @param {object} settings - VectFox settings
 * @param {string|null} [triggerEvent] - The SillyTavern event that scheduled this sync
 * @returns {Promise<void>}
 */
export async function synchronizeChat(settings, triggerEvent = null) {
    log.lifecycle(`[AutoSync] synchronizeChat: invoked (trigger=${triggerEvent || 'unknown'})`);

    if (!isVectFoxEnabled(settings)) {
        log.lifecycle('[AutoSync] BAIL: VectFox master switch OFF');
        return;
    }

    const chatId = getCurrentChatId();
    if (!chatId) {
        log.lifecycle('[AutoSync] BAIL: no chatId');
        return;
    }

    const uuid = getChatUUID();
    if (!uuid) {
        log.lifecycle('[AutoSync] BAIL: no chatUUID');
        return;
    }

    // Only the collection in use counts, with the auto-sync switch the AutoSync page shows for it: a flag left on
    // another of the chat's collections, from another persona or backend, never writes.
    const inUse = collectionInUse(settings, { chatUUID: uuid, chatId });
    const chatCollections = [...inUse.collections, ...inUse.lockedElsewhere];
    log.lifecycle(`[AutoSync] uuid=${uuid}, in use: ${inUse.collection?.registryKey ?? inUse.reason}, `
        + `autoSyncFlags=[${chatCollections.map(({ registryKey, isAutoSyncOn }) => `${registryKey}=${isAutoSyncOn}`).join(', ')}]`);
    const activeCollection = inUse.collection;
    if (!activeCollection) {
        if (chatCollections.some(collection => collection.isAutoSyncOn)) showNoCollectionInUse(inUse, 'auto-sync wrote nothing for this message');
        log.lifecycle(`[AutoSync] BAIL: no collection in use (${inUse.reason})`);
        return;
    }
    if (!activeCollection.isAutoSyncOn) {
        log.lifecycle(`[AutoSync] BAIL: auto-sync is off for ${activeCollection.registryKey}`);
        return;
    }

    const context = getContext();
    if (!Array.isArray(context.chat)) {
        log.lifecycle('[AutoSync] BAIL: context.chat is not an array');
        return;
    }

    const messages = context.chat.filter(message => message.mes && message.mes.trim().length > 0);
    log.lifecycle(`[AutoSync] calling runEventBaseIngestion: messages=${messages.length}`);
    let result;
    try {
        result = await runEventBaseIngestion({
            messages,
            chatUUID: uuid,
            settings,
            isAutoSync: true,
            // The collection in use, resolved above. Left to itself, ingestion builds the ID from the live character
            // name, which in a group chat is whoever speaks this turn, so each speaker would get a collection of their
            // own that nothing reading the collection in use ever sees (Doc/collection_helper.md, collectionInUse).
            collectionIdOverride: activeCollection.collectionId,
            // No popup when the user's own message triggered the sync: it shows after the reply, never mid-generation.
            suppressAutoSyncPopup: triggerEvent === 'MESSAGE_SENT',
            // Auto-sync reads its own windows (turns × 2) with no overlap, not the dialog's window size.
            windowSizeOverride: getAutoSyncWindowSize(settings),
            windowOverlapOverride: 0,
        });
    } catch (error) {
        // SillyTavern's module worker would swallow the error and fail again on every message.
        if (isInvalidModelConfigError(error)) {
            notifyInvalidModel(error.message);
            pauseCollectionAutoSync(activeCollection.registryKey);
            return;
        }
        throw error;
    }
    log.lifecycle('[AutoSync] runEventBaseIngestion result:', result);

    if (countUnfinishedWindows(result) === 0) {
        chatsWarnedOfUnfinishedWindows.delete(uuid);
    } else if (!chatsWarnedOfUnfinishedWindows.has(uuid)) {
        chatsWarnedOfUnfinishedWindows.add(uuid);
        notifyUnfinishedWindows(result, 'Auto-sync sends them again with the next turn.', { timeOut: 15000 });
    }

}

/**
 * Run EventBase over the open chat from startFromMessage to endAtMessage. The workflow puts its verdict on the progress
 * panel, unless the caller has a next step (shouldCompleteProgress); the caller says the rest, as a failure throws to it.
 *
 * @param {object} settings - VectFox settings
 * @param {AbortSignal|null} abortSignal - Stops the run
 * @param {{startFromMessage?: number, endAtMessage?: number|null, isReadingAgain?: boolean,
 *   shouldCompleteProgress?: boolean, progressTitle?: string, parallelWindows?: number, progressPlan?: object|null,
 *   skipTipFallback?: boolean, collectionIdOverride?: string|null, windowSizeOverride?: number}} [run] -
 *   collectionIdOverride: New collection's collection, else the chat's run target; windowSizeOverride: the collection's
 *   window size; the rest as runEventBaseIngestion takes them
 * @returns {Promise<object|null>} runEventBaseIngestion's result, or null when the run could not start, having said why
 * @throws When the run fails, or the chat changes while it runs
 */
export async function runEventBaseOnOpenChat(settings, abortSignal = null, {
    startFromMessage = 1,
    endAtMessage = null,
    isReadingAgain = false,
    shouldCompleteProgress = true,
    progressTitle = undefined,
    parallelWindows = 1,
    progressPlan = null,
    skipTipFallback = false,
    collectionIdOverride = null,
    windowSizeOverride = undefined,
} = {}) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.info('No chat selected', 'Vectorization aborted');
        return null;
    }

    const backendName = settings.vector_backend || 'standard';
    if (!(await isBackendAvailable(backendName, settings))) {
        toastr.error(
            `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
            'Vectorization aborted',
        );
        log.error(`VectFox: Backend ${backendName} failed health check before vectorization`);
        return null;
    }

    if (abortSignal?.aborted) return null;
    if (is_send_press) {
        toastr.info('Message generation is in progress.', 'Vectorization aborted');
        return null;
    }

    const context = getContext();
    if (!Array.isArray(context.chat)) return null;

    const result = await runEventBaseIngestion({
        messages: context.chat.filter(message => message.mes && message.mes.trim().length > 0),
        startFromMessage,
        endAtMessage,
        isReadingAgain,
        shouldCompleteProgress,
        progressTitle,
        chatUUID: getChatUUID(),
        settings,
        abortSignal,
        isAutoSync: false,
        parallelWindows,
        progressPlan,
        skipTipFallback,
        collectionIdOverride,
        windowSizeOverride,
    });

    if (chatId !== getCurrentChatId()) {
        progressTracker.complete(false, 'Chat changed during vectorization');
        throw new Error('Chat changed during vectorization');
    }
    return result;
}
