/**
 * ============================================================================
 * EVENTBASE WORKFLOW
 * ============================================================================
 * Top-level orchestrators for EventBase ingestion and retrieval.
 * These replace the Phase-1 throwing stubs.
 *
 * Exported:
 *   runEventBaseIngestion({ messages, chatUUID, settings, abortSignal })
 *   runEventBaseRetrieval({ chat, searchText, settings })
 * ============================================================================
 */

import { setExtensionPrompt, extension_prompts } from '../../sillytavern/prompt-injection.js';
import { getCurrentChatId, substituteParams, getContext } from '../../sillytavern/chat.js';
import { getChatUUID, COLLECTION_PREFIXES, buildRegistryKey } from '../../shared/collection-ids.js';
import { isCollectionEnabled } from '../collections/index.js';
import { getSavedHashes, UNBOUNDED_RUN } from '../vector-backend/index.js';
import { searchArchiveEvents } from './eventbase-retrieval.js';
import { EVENTBASE_PROMPT_TAG } from '../../shared/constants.js';
import { EventBaseFatalError, EventBaseExtractionError } from './eventbase-schema.js';
import { extractEvents } from './eventbase-extractor.js';
import { readStoryLanguage } from './story-language.js';
import { hashSourceMessage } from './eventbase-message-hash.js';
import { chatWindowsOf, windowsInStretch } from './eventbase-window-grid-core.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { insertEvents, isWindowAlreadyExtracted, markWindowExtracted, markWindowUnfinished, getUnfinishedWindowFingerprints, forgetUnfinishedWindowsNotInChat, windowFingerprint, clearExtractionCaches, isLastWindowExtracted, getVectorizationTip, setVectorizationTip, ensureVectorizationTip, shouldUseTipFallback, createWindowReplacement, readEventBaseProgress, getAutoSyncMarker, capAutoSyncMarker, autoSyncFirstWindowStart } from './eventbase-store.js';
import { retrieveEventsForTurn } from './agentic-retrieval.js';
import { collectionInUse, noCollectionInUseText, resolveEventBaseRunTarget, sharedCollectionsLockedHere, useChatCollection } from './eventbase-chat-collections.js';
import { formatEventsForInjectionDetailed, formatStoryArcForInjection } from './eventbase-injection.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { isInvalidModelConfigError, notifyInvalidModel, notifyMemoryNotInjected } from '../../shared/model-config-notifier.js';
import { log } from '../../sillytavern/log.js';

// The wait before each extra pass over the windows that failed in a run, one entry
// per pass. A window therefore gets three sends in the run where it first fails.
const WINDOW_RESEND_BACKOFF_MS = [5000, 10000];

// A pass that got nothing through, with more failures than one parallel batch, points
// at the provider and not at those windows: repeating it would only repeat the wait.
const MAX_WINDOWS_TO_RESEND_WITHOUT_PROGRESS = 8;

/** A notice that stays until the user closes it. */
const STICKY_TOAST_OPTIONS = { timeOut: 0, extendedTimeOut: 0 };

/**
 * Waits before a re-send pass, ending early when the user presses Stop.
 * @param {number} delayMs
 * @param {AbortSignal|null} abortSignal
 * @returns {Promise<void>}
 */
function _waitBeforeResendPass(delayMs, abortSignal) {
    return new Promise((resolve) => {
        let timer = null;
        abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        timer = setTimeout(resolve, delayMs);
    });
}

/**
 * Resolve the auto-sync extraction window size in MESSAGES from the per-user
 * turns setting (1 turn = 2 messages: 1 user + 1 AI reply). Clamped to 1-20 turns.
 * Auto-sync uses this instead of settings.eventbase_window_size so its cadence is
 * independent of the one-off Vectorize Content window. Single source of truth for
 * the conversion — used by the auto-sync caller AND the auto-sync status check.
 * @param {object} settings - VectFox settings
 * @returns {number} window size in messages
 */
export function getAutoSyncWindowSize(settings) {
    const turns = Math.max(1, Math.min(20, settings?.eventbase_autosync_window_turns ?? 1));
    return turns * 2;
}

/**
 * Settle/commit lag boundary: the number of messages eligible for auto-sync
 * extraction. The last `lag` messages — the active, still-swipeable turn — are
 * held back until a newer message supersedes them, so re-rolls/swipes on the
 * latest turn never produce throwaway embeddings (only the final, superseded
 * turn is extracted).
 *
 * Returns a *count* (an exclusive upper index) so callers can
 * `messages.slice(0, getCommitBoundary(messages, settings))`.
 *
 * Lag is one whole auto-sync window (one turn) so windows tile evenly and the
 * held-back region is exactly the active turn — never a stray incomplete tail.
 * Returns `messages.length` (no lag) when the feature is off. This is the SINGLE
 * source of truth shared by the window-builder, the quick-exit, and the auto-sync
 * status so "fully synced" means "all committed windows done", not "the active
 * turn done". See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
 *
 * @param {object[]} messages - filtered chat messages
 * @param {object}   settings - VectFox settings
 * @returns {number} count of messages eligible for extraction
 */
export function getCommitBoundary(messages, settings) {
    const total = Array.isArray(messages) ? messages.length : 0;
    if (settings?.eventbase_autosync_settle_lag === false) return total; // feature off → no lag
    const lag = getAutoSyncWindowSize(settings);
    return Math.max(0, total - lag);
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * How many windows this run left unfinished — they were sent again and still
 * produced no events, so they are not marked extracted. They stay on the chat's
 * unfinished record until a later run gets them through.
 *
 * Lives here because this module owns the counters, and BOTH callers that report
 * a run to the user need the same answer. Neither used to ask: each ended with an
 * unconditional progressTracker.complete(true, …) + toastr.success(…), which
 * overwrote the complete(false, …) verdict this workflow had just set. So a run
 * where a window timed out or failed still showed the user a green tick — the
 * same silence issue #14 reported, one layer further out.
 *
 * @param {{windowsTimedOut?: number, windowsFailed?: number}|null|undefined} result
 * @returns {number}
 */
export function countUnfinishedWindows(result) {
    return (result?.windowsTimedOut || 0) + (result?.windowsFailed || 0);
}

/**
 * Tells the player what a finished run left undone, which is theirs to act on. Red
 * only when nothing got through, since the run then achieved nothing and the fault
 * lies with the provider or the settings rather than those windows. A window the
 * provider still rejected after its re-sends adds the rejection's causes, and keeps
 * the notice until it is closed whatever the caller asks: a rejection of the user's
 * settings fails the same way on every later run until they change it.
 *
 * @param {{eventsExtracted: number, windowsProcessed: number, windowsTimedOut?: number, windowsFailed?: number, firstFailureDetail?: string|null, rejectionCauses?: string|null}} result
 * @param {string} [nextStep] - What sends the windows again
 * @param {object} [toastOptions] - Sticky unless told otherwise, since a long run may have been left alone
 */
export function notifyUnfinishedWindows(result, nextStep = 'Resume in Vectorize Content sends them again.', toastOptions = STICKY_TOAST_OPTIONS) {
    const unfinishedCount = countUnfinishedWindows(result);
    const timeoutAdvice = result.windowsTimedOut > 0
        ? ` ${result.windowsTimedOut} timed out: raise "Extraction timeout" on the ChatHistory page, or check that your model or endpoint is responding.`
        : '';
    const detail = result.firstFailureDetail;
    const firstError = detail ? ` First error: ${/[.!?]$/.test(detail) ? detail : `${detail}.`}` : '';
    const causes = result.rejectionCauses ? ` ${result.rejectionCauses}` : '';
    const message = `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows, `
        + `but ${unfinishedCount} window(s) kept failing and hold no events.${timeoutAdvice}${firstError}${causes} ${nextStep}`;
    const options = result.rejectionCauses ? STICKY_TOAST_OPTIONS : toastOptions;
    const hasNothingGotThrough = result.windowsProcessed === 0 && unfinishedCount > MAX_WINDOWS_TO_RESEND_WITHOUT_PROGRESS;
    if (hasNothingGotThrough) {
        globalThis.toastr?.error(message, 'VectFox', options);
    } else {
        globalThis.toastr?.warning(message, 'VectFox', options);
    }
}

/**
 * Run EventBase over a chat: cut its messages into windows, send each window not extracted yet to
 * the LLM, and store the events it finds.
 *
 * Windows are numbered from the chat's first message: window k holds messages k * step to
 * k * step + size - 1, where step is size - overlap. A run from a later message keeps that
 * numbering and starts at the window that holds the message, so an event's window is the same in
 * every run, and a window read again replaces its events.
 *
 * The size is windowSizeOverride: Vectorize Content passes the collection's (getCollectionWindowSize in
 * eventbase-store.js), and auto-sync its own, with its overlap (windowOverlapOverride, from
 * settings.eventbase_autosync_window_turns); with none, settings.eventbase_window_size. The overlap is
 * otherwise settings.eventbase_window_overlap. A window is not read again once every message in it has
 * been read, in a window of any size (isWindowAlreadyExtracted), unless the run reads a stretch again
 * (isReadingAgain): then every window from the one holding startFromMessage to the one holding
 * endAtMessage is read, and one whose new read finds no event loses its earlier events too
 * (InternalProject/Vectfox/plans/eventbase-read-range-again.md).
 *
 * @param {object} params
 * @param {object[]} params.messages - The chat's messages from its first: message numbers count in this list
 * @param {number} [params.startFromMessage] - The message the run starts at, from 1; 1 reads the whole chat
 * @param {number|null} [params.endAtMessage] - The message the run ends at, from 1, in the window that holds it; null
 *   reads to the chat's end
 * @param {boolean} [params.isReadingAgain] - Read the windows of the stretch though the record holds them, each
 *   replacing its earlier events; their StoryArc links are left to the caller, as the result names them
 * @param {boolean} [params.shouldCompleteProgress] - false leaves the progress panel open for the caller's next step
 *   when the run ends, as a stop or a failure still ends it
 * @param {string} [params.progressTitle] - The progress panel's title
 * @param {string} [params.chatUUID] - Override chat UUID
 * @param {object} params.settings - VectFox settings
 * @param {AbortSignal|null} [params.abortSignal]
 * @param {{ strategy?: string, batchSize?: number, totalChunks?: number }|null} [params.progressPlan]
 * @returns {Promise<{ eventsExtracted: number, windowsProcessed: number, windowsSkipped: number, windowsTimedOut?: number, windowsFailed?: number, firstFailureDetail?: string|null, rejectionCauses?: string|null, insertedEventIds?: string[], eventIdsWithMovedLinks?: string[] }>}
 *          rejectionCauses: a rejection's causes when a window the provider rejected still failed after its re-sends;
 *          insertedEventIds: event_id of each event the run stored; eventIdsWithMovedLinks: event_id of each event that
 *          held a StoryArc link to an event the run replaced
 */
export async function runEventBaseIngestion({ messages, chatUUID, settings, abortSignal = null, progressPlan = null, collectionIdOverride = null, parallelWindows = 3, isAutoSync = false, suppressAutoSyncPopup = false, skipTipFallback = false, windowSizeOverride = undefined, windowOverlapOverride = undefined, startFromMessage = 1, endAtMessage = null, isReadingAgain = false, shouldCompleteProgress = true, progressTitle = 'EventBase Extraction' }) {
    const uuid = chatUUID || getChatUUID();

    // The collection the run writes. Precedence:
    //   1. Explicit override (archive uploads and New collection pass a fixed ID; auto-sync passes the
    //      collection in use it already resolved for its gate).
    //   2. The chat's collection in use, from the one route every reader and writer asks (collectionInUse).
    //   3. A freshly-built ID, ONLY for a chat's first read, when it has no collection of its own on this
    //      backend. A chat with collections but none in use gets none: nothing is written until the user
    //      chooses one (§2.2 of vectfox-multi-collection-per-chat.md).
    //
    // Step 2 is load-bearing for group chats. buildEventBaseCollectionId derives the ID's char segment from
    // the LIVE context.name2, which in a group chat is whoever is speaking on this trigger. Recomputing it per
    // call would manufacture and lock a NEW per-character EventBase collection for the same chat every time a
    // different character speaks, scattering events across siblings that nothing reading the collection in
    // use ever sees. The route takes only the chat's own collections, so another chat's collection locked in
    // for retrieval never captures this chat's events. Trusting the registry instead of recomputing the ID is
    // the rule in Doc/collection_helper.md: the registry is the source of truth for which collection holds a
    // chat's data.
    const collectionId = collectionIdOverride || resolveEventBaseRunTarget(settings, uuid)?.collectionId;
    if (!collectionId) {
        const why = noCollectionInUseText(collectionInUse(settings, { chatUUID: uuid }), 'EventBase writes nothing here');
        throw new Error(`EventBase: ${why ?? 'No chat is open.'}`);
    }
    // The collection's record holds its locks and its pointer (how far it has read the chat), under this key.
    const registryKey = buildRegistryKey(collectionId, settings);

    // Put it in use in the chat at start, so the lock index is filled even if the run is stopped: locked to the chat,
    // scoped to chats, the chat's other own collections unlocked there (useChatCollection). Archive collections are
    // excluded: the user locks them by hand. Metadata goes under the registry-key form ("backend:id"), as the import
    // path, the loader and cleanupOrphanedMeta key it.
    const _startChatId = getCurrentChatId();
    if (_startChatId && !collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT)) {
        useChatCollection(registryKey, { chatId: _startChatId });
    }

    const candidateKeys = [
        registryKey,
        collectionId,  // fallback for bare-ID entries written by older versions
    ].filter(Boolean);
    const disabledKey = candidateKeys.find(key => key && !isCollectionEnabled(key));
    if (disabledKey) {
        log.lifecycle(`[EventBase] Collection paused (key="${disabledKey}") — skipping ingestion`);
        return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
    }

    const windowSize = windowSizeOverride != null
        ? Math.max(2, windowSizeOverride)
        : Math.max(2, settings.eventbase_window_size || 6);
    const windowOverlap = windowOverlapOverride != null
        ? Math.max(0, Math.min(windowSize - 1, windowOverlapOverride))
        : Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 0));
    const step = windowSize - windowOverlap;
    const minImportanceStore = settings.eventbase_min_importance_store || 1;

    const CONCURRENCY = Math.min(8, Math.max(1, parallelWindows));

    // Coordinator mode: pipelined (default) vs serial (opt-in via the "Wait for
    // each batch" switch on the ChatHistory page).
    //
    // - DEFAULT: pipelined — batch N's insert overlaps batch N+1's extract,
    //   ~35% faster wall time.
    // - SERIAL opt-in: each batch finishes embedding before the next batch
    //   starts extracting — a diagnostic fallback if a pipelined run loses
    //   events. Only an explicit `true` enables it.
    const disablePipeline = settings?.eventbase_disable_pipeline === true;

    if (!messages?.length) return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };

    // Every window of a run writes in the language read once from the story's latest messages.
    const storyLanguage = readStoryLanguage(messages, settings);
    log.lifecycle(`[EventBase] Story language: ${storyLanguage.isCjkStory ? 'CJK' : 'not CJK'}; the "${storyLanguage.promptMode}" extraction prompt (CJK tokenizer mode "${settings.cjk_tokenizer_mode || 'intl'}")`);

    // If the window record says windows were extracted but Qdrant has no data
    // (e.g. collection was deleted externally), reset the record so we start fresh.
    const cacheEntries = readEventBaseProgress(registryKey).extractedWindows;
    if (Array.isArray(cacheEntries) && cacheEntries.length > 0) {
        try {
            const existingHashes = collectionId ? await getSavedHashes(collectionId, settings) : [];
            if (!existingHashes?.length) {
                log.lifecycle('[EventBase] Collection is empty but cache has entries — resetting extraction caches');
                // Clear both window + tip caches. Dropping only the window cache left
                // the tip-based fast-forward reading a stale tip (e.g. 2382 from a
                // deleted collection) and skipping every window — the "0 events,
                // N skipped" re-vectorize bug. ensureVectorizationTip only re-probes
                // the backend on a cache MISS, so the tip has to be evicted here too.
                clearExtractionCaches(registryKey);
            }
        } catch (err) {
            log.warn('[EventBase] Empty-collection check failed — keeping extraction caches:', err);
        }
    }

    // A chat that got shorter than its auto-sync marker, as after messages are deleted or a summarizer replaces some
    // with a summary, has the marker moved back to its unread end before the quick-exit below can end the run, so
    // auto-sync reads its new messages again.
    if (isAutoSync) capAutoSyncMarker(registryKey, messages, { windowSize, step, hashFn: hashSourceMessage });
    // Auto-sync's windows start at its start marker and every step after it, so one starts exactly at the marker
    // whatever window size stamped it; every other run's start at the chat's first message.
    const firstWindowStart = isAutoSync ? autoSyncFirstWindowStart(registryKey, step) : 0;

    // Build list of windows — skip tail windows that haven't accumulated a full
    // windowSize of messages yet. This prevents the same partial tail from being
    // re-extracted (and potentially duplicating events) on every auto-sync fire.
    // A tail window becomes eligible once it reaches windowSize messages, at which
    // point the next step boundary also produces a fresh overlap window correctly.
    // Quick-exit: check only the LAST complete window fingerprint against the Set cache.
    // Avoids building O(n/step) window objects on every auto-sync fire when nothing is new.
    // A manual run does not take this exit while windows are on the unfinished record:
    // a run carries on past a failed window, so the last window being done says nothing
    // about it. Auto-sync keeps the exit and reaches its failed windows when the next
    // turn commits.
    // Note: edits to messages deep in history bypass this check — acceptable limitation.
    // Settle/commit lag: on auto-sync, hold back the active (still-swipeable) last
    // turn — only extract messages up to the commit boundary. Manual Vectorize
    // Content / backfill (isAutoSync=false) covers the whole chat. The boundary is
    // the SINGLE source of truth for "what is eligible", reused by the auto-sync status
    // (see getChatAutoSyncStatus) so "fully synced" tracks committed windows, not
    // the active turn. See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
    const commitBoundary = isAutoSync ? getCommitBoundary(messages, settings) : messages.length;
    const committedMessages = commitBoundary < messages.length ? messages.slice(0, commitBoundary) : messages;

    const unfinishedFingerprints = getUnfinishedWindowFingerprints(registryKey, windowSize);
    const shouldSendUnfinishedWindows = !isAutoSync && unfinishedFingerprints.size > 0;
    if (!isReadingAgain && !shouldSendUnfinishedWindows && isLastWindowExtracted(committedMessages, windowSize, step, registryKey, hashSourceMessage, firstWindowStart)) {
        log.lifecycle(`[EventBase] Quick-exit: last committed window already extracted, nothing new`);
        return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
    }

    let windows = chatWindowsOf({ messageCount: messages.length, windowSize, step, firstWindowStart, boundary: commitBoundary })
        .map(({ start, end }) => ({ start, end, msgs: messages.slice(start, end + 1) }));
    // The messages after the last full window wait for the next one; the run's verdict names them.
    const messagesWaitingForWindow = Math.max(0, commitBoundary - (windows.length > 0 ? windows[windows.length - 1].end + 1 : firstWindowStart));

    if (shouldSendUnfinishedWindows) {
        const chatFingerprints = new Set(windows.map(win => windowFingerprint(win.msgs.map(hashSourceMessage))));
        forgetUnfinishedWindowsNotInChat(registryKey, windowSize, chatFingerprints);
        log.lifecycle(`[EventBase] ${getUnfinishedWindowFingerprints(registryKey, windowSize).size} unfinished window(s) on record for this collection`);
    }

    // A run from a later message starts at the window that holds it, and a run to an earlier message ends at the
    // window that holds that one. Its windows keep the chat's numbering. The record check above reads the whole chat,
    // so the unfinished windows outside the stretch stay on record.
    windows = windowsInStretch(windows, { startFromMessage, endAtMessage });

    // AutoSync start-marker gate. The marker is the first message auto-sync
    // reads: its windows were built to start at the marker and every step after
    // it (firstWindowStart), and this keeps the ones from the marker on. The
    // window record skips a window only once every message in it was read
    // (isWindowAlreadyExtracted), so without the marker a window of auto-sync's
    // size holding messages read before it was turned on, at another size,
    // would read them again.
    //
    // Marker is stamped by settings-panel.js when auto-sync is enabled. See
    // stampAutoSyncMarker in eventbase-store.js for the placement logic.
    // Only applies to auto-sync runs; manual Vectorize Content / backfill
    // intentionally ignores the marker so the user can refill historical gaps.
    //
    // ⚠️ Regression coverage: TEST 014 (fingerprint cache, same window size) +
    // TEST 015 (this marker filter, window-size-change protection) in
    // tests/Eventbase-test.spec.js, with tests/eventbase-autosync-marker.test.js
    // for the windows built from the marker, cover the two-layer auto-sync
    // safety story. Doc/collection_helper.md → "Auto-sync" explains the
    // contract. Any change here — guard, operator (>= vs >), or filter shape
    // — must be reviewed against those tests and the doc. The boundary `>=`
    // is load-bearing: a window starts exactly AT the marker, so `>` would
    // skip it (extraction gap).
    if (isAutoSync) {
        const marker = getAutoSyncMarker(registryKey);
        if (typeof marker === 'number') {
            const before = windows.length;
            windows = windows.filter(w => w.start >= marker);
            if (before !== windows.length) {
                log.lifecycle(`[EventBase] AutoSync marker filter: ${before} → ${windows.length} windows (marker=${marker})`);
            }
        }
    }

    // Each window keeps its place in this list, so a re-send pass still logs the right number.
    windows.forEach((win, index) => { win.index = index; });

    log.lifecycle(`[EventBase] Ingestion: ${messages.length} messages → ${windows.length} windows from message ${startFromMessage} (size=${windowSize}, overlap=${windowOverlap})`);

    const showProgressModal = !isAutoSync || settings.autosync_show_progress_modal === true;
    if (showProgressModal) {
        progressTracker.show(progressTitle, windows.length, 'Windows', { unitLabel: 'Messages', foundLabel: 'Events' });
    }

    const totalLegacyChunks = Number(progressPlan?.totalChunks) || 0;
    const legacyStrategy = progressPlan?.strategy || 'per_message';
    const legacyBatchSize = Math.max(1, Number(progressPlan?.batchSize) || 1);
    if (totalLegacyChunks > 0) {
        // Keep the CHUNKS card on legacy math (total + remaining), like standard vectorization.
        progressTracker.updateEmbeddingProgress(0, totalLegacyChunks);
    }

    let eventsExtracted = 0;
    const insertedEventIds = [];
    let windowsProcessed = 0;
    let windowsSkipped = 0;
    let windowsTimedOut = 0;
    let windowsFailed = 0;
    let firstFailureDetail = null;
    let rejectionCauses = null;

    // Smart fast-forward: windows are processed in order, so already-extracted ones
    // cluster at the front. Linear-scan past them with cheap Set.has() lookups instead
    // of spinning up Promise.allSettled batches that do the same check 3-at-a-time.
    // The per-window check in _runOneExtractBatch stays as a safety net for edit-in-middle
    // cases (where an old message's hash changes and breaks the contiguity assumption).
    // A run reading a stretch again reads every window of it.
    let fastForwardSkipped = 0;
    while (!isReadingAgain && fastForwardSkipped < windows.length) {
        const win = windows[fastForwardSkipped];
        const hashes = win.msgs.map(hashSourceMessage);
        const isDone = isWindowAlreadyExtracted(hashes, registryKey);
        if (!isDone) break;
        fastForwardSkipped++;
    }
    // Tip-based fallback: when the window record holds nothing for a collection that
    // exists, probe Qdrant for the highest source_window_end stored and use that as a
    // fast-forward boundary. Handles the case where the local record was lost (a page
    // reload after re-importing an exported Qdrant collection without its pointer).
    //
    // The decision rule lives in shouldUseTipFallback() in eventbase-store.js — do
    // not inline the condition here.
    const useTipFallback = shouldUseTipFallback({
        skipTipFallback: skipTipFallback || isReadingAgain,
        hasCollection: !!collectionId,
        hasWindowRecord: (readEventBaseProgress(registryKey).extractedWindows?.length ?? 0) > 0
            || getUnfinishedWindowFingerprints(registryKey, windowSize).size > 0,
    });
    if (!useTipFallback && skipTipFallback) {
        log.lifecycle('[EventBase] shouldUseTipFallback=false — caller explicitly opted out (skipTipFallback=true)');
    }
    if (useTipFallback) {
        try {
            const tip = await ensureVectorizationTip(registryKey, settings);
            if (typeof tip === 'number' && tip > messages.length) {
                // Read on a longer chat (messages deleted, or a summary replacing some): which windows it covers here
                // is unknown, so each window is checked against the window record instead of recorded as read.
                log.lifecycle(`[EventBase] Tip-based fast-forward skipped: the tip (${tip}) is past the chat's ${messages.length} messages`);
            } else if (typeof tip === 'number' && tip > 0) {
                let i = 0;
                while (i < windows.length && windows[i].end < tip) {
                    const win = windows[i];
                    const hashes = win.msgs.map(hashSourceMessage);
                    markWindowExtracted(hashes, registryKey);
                    i++;
                }
                if (i > 0) {
                    fastForwardSkipped = i;
                    log.lifecycle(`[EventBase] Tip-based fast-forward: skipped ${i} window(s) already in collection (tip=${tip}), starting at window ${i}`);
                }
            }
        } catch (e) {
            log.warn('[EventBase] Tip-based fast-forward probe failed, will re-extract from start:', e?.message || e);
        }
    }

    if (fastForwardSkipped > 0) {
        windowsSkipped = fastForwardSkipped;
        log.lifecycle(`[EventBase] Fast-forward: skipped ${fastForwardSkipped} already-extracted window(s), starting at window ${fastForwardSkipped}`);
    }

    // A window this run extracts again replaces the events it holds from earlier extractions.
    const windowReplacement = createWindowReplacement({ collectionId, settings, tipAtRunStart: getVectorizationTip(registryKey) });

    // Auto-sync popup: shown once per ingestion call, and only when windows are left
    // to extract. Passing the quick-exit does not guarantee that — the start-marker
    // filter or the fast-forward can still remove every window. suppressAutoSyncPopup
    // is set by synchronizeChat when the trigger was MESSAGE_SENT (user-send
    // mid-generation) — extraction still runs, only the toast is hidden.
    const windowsToExtract = windows.length - fastForwardSkipped;
    const popupAllowed = isAutoSync && windowsToExtract > 0 && !suppressAutoSyncPopup && settings.eventbase_autosync_popup !== false;
    log.verbose(`[EventBase Popup] auto-sync gate: isAutoSync=${isAutoSync}, windowsToExtract=${windowsToExtract}, suppressAutoSyncPopup=${suppressAutoSyncPopup}, eventbase_autosync_popup=${settings.eventbase_autosync_popup} → fire=${popupAllowed}`);
    if (popupAllowed) globalThis.toastr?.info('Auto-Sync: extracting events...', 'VectFox', { timeOut: 3000 });

    // Lifecycle line so the user can confirm auto-sync ran. popupShown=false with
    // windowsToExtract > 0 means the popup was suppressed (e.g. MESSAGE_SENT).
    if (isAutoSync) log.lifecycle(`[VectFox AutoSync] running — messages=${messages.length}, windowsToExtract=${windowsToExtract}, popupShown=${popupAllowed}`);

    // -----------------------------------------------------------------------
    // Pipelined extract/insert loop (see InternalProject/Vectfox/plans/executed/eventbase-extract-insert-pipeline.md).
    //
    // Today's serial barrier was: dispatch 8 extracts → await all → await insert
    // → next 8. The slow tail of the extract phase + the insert phase were
    // additive, leaving the LLM lane idle while Qdrant wrote.
    //
    // The coordinator below runs ONE extract and ONE insert concurrently, with
    // a single-slot queue between them. Steady-state cycle becomes
    // max(extract_phase, insert_phase) instead of extract+insert. Per the
    // user's reference run (10.8s extract, 5.8s insert), ~35% wall-time win.
    //
    // Three helpers, three responsibilities:
    //   _runOneExtractBatch  — the existing per-window extract logic, moved
    //                          intact into a function so the coordinator can
    //                          call it as a black box.
    //   _insertWithRetry     — wraps insertEvents with up to 3 attempts +
    //                          exponential-ish backoff. Per user spec: insert
    //                          failures after 3 retries are fatal — surface
    //                          Qdrant's error to the user and bubble.
    //   _finalizeBatch       — the existing insert + mark + tip + progress
    //                          logic, moved intact. Calls _insertWithRetry.
    //                          State-mutation order preserved (insert →
    //                          markWindowExtracted → setVectorizationTip →
    //                          progress) so "no corrupted state" invariant
    //                          holds even if the user clicks Stop mid-pipeline.
    //
    // The coordinator drives 4 state variables: nextBatchFirstIdx (cursor),
    // pendingExtract (Promise|null), pendingInsert (Promise|null),
    // queuedResult (ExtractResult|null). The single-slot queue means at most
    // ONE batch is extracted-but-not-inserted at any time — deeper queue
    // would not help (slow stage gates throughput) and only adds memory +
    // complicates abort.
    //
    // When all windows are through, the coordinator runs up to
    // WINDOW_RESEND_BACKOFF_MS.length more passes over the windows that failed.
    // -----------------------------------------------------------------------

    /**
     * Per-batch extractor — moved verbatim from the original loop. Runs N
     * windows in parallel via Promise.allSettled, builds the {events, hashes,
     * ends} packet the finalizer needs. Throws EventBaseFatalError only when
     * the underlying LLM call surfaces one (auth/config errors).
     *
     * @param {object[]} windowsSlice
     * @returns {Promise<object>} ExtractResult
     */
    async function _runOneExtractBatch(windowsSlice) {
        const batchStartedAt = performance.now();
        const batchFirstIdx = windowsSlice[0].index;
        const batchLastIdx = windowsSlice[windowsSlice.length - 1].index;
        log.verbose(`[EventBase concurrency] Dispatching batch: windows ${batchFirstIdx}-${batchLastIdx} (size=${windowsSlice.length}, CONCURRENCY=${CONCURRENCY}) at t=${batchStartedAt.toFixed(1)}ms`);

        const batchResults = await Promise.allSettled(
            windowsSlice.map(async (win) => {
                const wIdx = win.index;
                const winStartedAt = performance.now();
                log.verbose(`[EventBase concurrency] Window ${wIdx}: dispatched at +${(winStartedAt - batchStartedAt).toFixed(1)}ms`);

                if (abortSignal?.aborted) return { skipped: true };

                // Compute source hashes for dedup check
                const sourceHashes = win.msgs.map(hashSourceMessage);

                // Skip if already extracted, unless the run reads the stretch again
                const alreadyDone = !isReadingAgain && isWindowAlreadyExtracted(sourceHashes, registryKey);
                if (alreadyDone) {
                    // Per-window skip log removed — the "Ingestion complete: skipped=N"
                    // summary at the end already conveys this. For a 720-message chat
                    // with windowSize=2, this used to spam ~360 lines per AI reply.
                    return { skipped: true };
                }

                // LLM extraction
                let rawEvents;
                const extractStart = performance.now();
                // A window read again with no event found replaces only the events written before this.
                const readStartedAt = Date.now();
                try {
                    // Throttle extraction (summarization LLM) calls. Shares one
                    // budget with Agent Mode via generationRateLimiter. 0 = off.
                    rawEvents = await generationRateLimiter.execute(
                        () => extractEvents({
                            messages: win.msgs,
                            windowStart: win.start,
                            windowEnd: win.end,
                            settings,
                            windowIndex: wIdx,
                            storyLanguage,
                        }),
                        generationRateLimitSettings(settings),
                        'extraction',
                    );
                    const extractMs = performance.now() - extractStart;
                    log.verbose(`[EventBase concurrency] Window ${wIdx}: LLM extract done in ${extractMs.toFixed(0)}ms (finished at +${(performance.now() - batchStartedAt).toFixed(1)}ms from batch start)`);
                } catch (err) {
                    // Genuine user/request cancellation — expected, stay silent.
                    // The user's abortSignal isn't wired into the extractor fetch
                    // (it uses AbortSignal.timeout only), so a user cancel surfaces
                    // here via abortSignal.aborted, not as the timeout below.
                    if (abortSignal?.aborted) {
                        log.verbose(`[EventBase] Window ${wIdx}: request aborted by user`);
                        return { skipped: true };
                    }
                    if (err instanceof EventBaseFatalError) throw err; // propagate
                    // A per-call timeout (AbortSignal.timeout) rejects with a
                    // TimeoutError — NOT a user cancel. Silently skipping it is the
                    // #2 bug: every window times out → "0 vectors, no error". Detect
                    // it (same test as agentic-retrieval.js), log it, and mark the
                    // window timedOut so the end of the run reports it.
                    const isTimeout = err?.name === 'TimeoutError'
                        || err?.name === 'AbortError'
                        || /aborted|timeout|timed out/i.test(err?.message || '');
                    if (isTimeout) {
                        const secs = Math.round((settings.eventbase_timeout_ms || 60000) / 1000);
                        log.warn(`[EventBase] Window ${wIdx}: extraction TIMED OUT after ${secs}s (unfinished). Raise "Extraction timeout" on the ChatHistory page, or check your model/endpoint is responding.`);
                        return { skipped: false, events: [], timedOut: true };
                    }
                    // `failed: true` keeps an errored window out of the processed
                    // tally. Counting it as processed is what let a run where EVERY
                    // window failed still finish green with "extracted 0 event(s)
                    // from N window(s)" — indistinguishable from a chat that
                    // genuinely held no events (issue #14).
                    if (err instanceof EventBaseExtractionError) {
                        log.warn(`[EventBase] Window ${wIdx}: extraction error (unfinished) — ${err.message}`);
                        return { skipped: false, events: [], failed: true, failureDetail: err.message, rejectionCauses: err.rejectionCauses ?? null };
                    }
                    log.warn(`[EventBase] Window ${wIdx}: unexpected error (unfinished) — ${err.message}`);
                    return { skipped: false, events: [], failed: true, failureDetail: err.message };
                }

                // Attach chat_uuid to each event
                const annotated = rawEvents.map(e => ({ ...e, chat_uuid: uuid }));

                // Filter by minimum importance
                const toStore = annotated.filter(e => e.importance >= minImportanceStore);
                if (toStore.length < annotated.length) {
                    log.verbose(`[EventBase] Window ${wIdx}: dropped ${annotated.length - toStore.length} event(s) below minImportance=${minImportanceStore}`);
                }

                return { skipped: false, events: toStore, sourceHashes, windowStart: win.start, windowEnd: win.end, readStartedAt };
            }),
        );

        const extractPhaseEndedAt = performance.now();
        log.verbose(`[EventBase concurrency] Batch extract phase complete: ${(extractPhaseEndedAt - batchStartedAt).toFixed(0)}ms wall (${windowsSlice.length} window(s))`);

        // Reduce per-window results into the {events, hashes, ends} packet the
        // finalizer needs to write. Same coalescing as the original loop.
        const allEvents = [];
        const hashesToMark = [];
        const endsExtracted = [];
        const windowsReadEmpty = [];
        for (const r of batchResults) {
            if (r.status !== 'fulfilled' || r.value?.skipped) continue;
            const { events: winEvents, sourceHashes: winHashes, windowStart, windowEnd, readStartedAt } = r.value;
            if (!winHashes) continue; // extraction failed — do not mark
            if (winEvents?.length > 0) {
                allEvents.push(...winEvents);
            } else if (isReadingAgain) {
                windowsReadEmpty.push({ source_window_start: windowStart, source_window_end: windowEnd, source_message_hashes: winHashes, created_at: readStartedAt });
            }
            hashesToMark.push(winHashes);
            if (typeof windowEnd === 'number') endsExtracted.push(windowEnd);
        }

        return {
            windowsSlice,
            batchFirstIdx,
            batchLastIdx,
            batchResults,
            allEvents,
            hashesToMark,
            endsExtracted,
            windowsReadEmpty,
            batchStartedAt,
            extractPhaseEndedAt,
        };
    }

    /**
     * Wraps insertEvents with up to 3 attempts, 5 then 10 seconds apart, for
     * transient Qdrant hiccups rather than sustained outages. On exhaustion,
     * throws an EventBaseFatalError tagged "insert_failed_max_retries" so the UI
     * can show the underlying Qdrant message. A configuration error, such as a
     * collection holding another vector size, fails the same way every time, so
     * it stops the run at once as an EventBaseFatalError tagged
     * "invalid_model_config", which pauses auto-sync. Pre-flight abort check
     * before each attempt avoids pointless retries when the user already pressed Stop.
     */
    async function _insertWithRetry(events, batchFirstIdx) {
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (abortSignal?.aborted) {
                const err = new Error('Aborted before insert attempt');
                err.name = 'AbortError';
                throw err;
            }
            try {
                await insertEvents(events, settings, abortSignal, collectionId);
                if (attempt > 1) log.lifecycle(`[EventBase] Insert recovered on attempt ${attempt}/3`);
                return; // success
            } catch (err) {
                if (err?.name === 'AbortError' || abortSignal?.aborted) throw err;
                if (isInvalidModelConfigError(err)) throw new EventBaseFatalError(err.message, 'invalid_model_config');
                // Hedge-fatal bypass: the inner hedge already burned up to 60s on 4 fresh-connection
                // attempts in parallel. Outer retry would just trigger another round of identical
                // hedging — same upstream, same routing pool, no new information. Throw up to
                // the coordinator so user can press Continue later when conditions improve.
                // See InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.5.
                if (err?.isHedgeFatal === true) throw err;
                lastErr = err;
                log.warn(`[EventBase] Insert batch starting at window ${batchFirstIdx} attempt ${attempt}/3 failed: ${err?.message || err}`);
                if (attempt < 3) {
                    // 5s then 10s: the common failure here is Qdrant under transient
                    // load returning truncated JSON (Similharity throws "Unexpected
                    // end of JSON input"), and the server needs seconds to settle
                    // before a retry can succeed.
                    const backoffMs = attempt === 1 ? 5000 : 10000;
                    // The progress line says this is a retry, not a hang. Without it,
                    // retry attempts look identical to a stall and users press Stop
                    // unnecessarily (which throws away an in-flight retry that
                    // probably would have worked).
                    progressTracker.updateProgress(
                        resendPassesDone > 0 ? windows.length : nextBatchFirstIdx,
                        `Insert retry ${attempt}/3 — waiting ${backoffMs/1000}s...`,
                    );
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
        }
        throw new EventBaseFatalError(
            `EventBase: insert failed after 3 retries — ${lastErr?.message || lastErr}`,
            'insert_failed_max_retries',
        );
    }

    /**
     * Puts a failed window on the collection's unfinished record and, the first time it
     * fails, queues it for this run's next pass. A window already on the record when
     * the run began gets one send per run, so one that always fails (a refused
     * prompt, say) does not cost three calls on every later run.
     *
     * @param {object}  win
     * @param {boolean} wasTimedOut
     * @param {object}  tally
     */
    function _recordUnfinishedWindow(win, wasTimedOut, tally) {
        const sourceHashes = win.msgs.map(hashSourceMessage);
        markWindowUnfinished(sourceHashes, registryKey);
        if (!unfinishedFingerprints.has(windowFingerprint(sourceHashes))) {
            tally.windowsToResend.push({ win, wasTimedOut });
        }
    }

    /**
     * Per-batch finalizer — calls _insertWithRetry, then marks windows
     * extracted + bumps tip + updates progress, IN THAT ORDER. The order is
     * the "no corrupted state" invariant: we never mark a window as covered
     * before its events are durable in Qdrant.
     *
     * Returns a tally the coordinator merges into the run totals. Fatal
     * insert errors bubble (Promise.race in the coordinator surfaces them).
     */
    async function _finalizeBatch(extractResult) {
        const { windowsSlice, batchFirstIdx, batchResults, allEvents, hashesToMark, endsExtracted, windowsReadEmpty, batchStartedAt, extractPhaseEndedAt } = extractResult;

        let isStored = false;
        if (!abortSignal?.aborted && allEvents.length > 0) {
            await _insertWithRetry(allEvents, batchFirstIdx);
            insertedEventIds.push(...allEvents.map(event => event.event_id));
            isStored = true;
        }
        // Mark windows only after insert succeeded (or there was nothing to
        // insert — in which case we still mark zero-event windows so we don't
        // re-extract them next run). A batch whose events were stored finishes
        // even when Stop came during the insert, so its windows keep one version.
        if (isStored || (allEvents.length === 0 && !abortSignal?.aborted)) {
            for (const winHashes of hashesToMark) {
                markWindowExtracted(winHashes, registryKey);
            }
            for (const end of endsExtracted) {
                setVectorizationTip(registryKey, end + 1);
            }
            if (allEvents.length > 0 || windowsReadEmpty.length > 0) await windowReplacement.replaceEarlierEvents(allEvents, windowsReadEmpty);
        }

        const batchEndedAt = performance.now();
        const insertPhaseMs = batchEndedAt - extractPhaseEndedAt;
        const extractPhaseMs = extractPhaseEndedAt - batchStartedAt;
        log.lifecycle(`[EventBase concurrency] Batch DONE: total=${(batchEndedAt - batchStartedAt).toFixed(0)}ms (extract=${extractPhaseMs.toFixed(0)}ms parallel, insert=${insertPhaseMs.toFixed(0)}ms — 1 batched POST with ${allEvents.length} event(s))`);

        // Tally results, watch for fatal LLM errors (extract-side fatals
        // arrive as rejected promises in batchResults). The loop runs to the end of
        // the batch even after a fatal, so every failed window reaches the record
        // before the coordinator stops the run.
        const tally = { eventsAdded: 0, windowsProcessed: 0, windowsSkipped: 0, windowsTimedOut: 0, windowsFailed: 0, failureDetail: null, rejectionCauses: null, fatalError: null, windowsToResend: [] };
        for (const [position, result] of batchResults.entries()) {
            const win = windowsSlice[position];
            if (result.status === 'rejected') {
                const err = result.reason;
                _recordUnfinishedWindow(win, false, tally);
                if (err instanceof EventBaseFatalError) {
                    tally.fatalError ??= err; // coordinator handles the fatal
                    continue;
                }
                log.warn('[EventBase] Batch window error:', err?.message || err);
                tally.windowsFailed++;
                tally.failureDetail ??= err?.message || String(err);
            } else {
                if (result.value?.skipped) {
                    tally.windowsSkipped++;
                } else if (result.value?.timedOut) {
                    // Counted separately — NOT as "processed" (it produced no events
                    // and wasn't marked extracted).
                    _recordUnfinishedWindow(win, true, tally);
                    tally.windowsTimedOut++;
                } else if (result.value?.failed) {
                    // Same reasoning as timedOut: no events, not marked extracted,
                    // so it must not inflate the processed count that the final
                    // success message reports.
                    _recordUnfinishedWindow(win, false, tally);
                    tally.windowsFailed++;
                    tally.failureDetail ??= result.value.failureDetail || null;
                    tally.rejectionCauses ??= result.value.rejectionCauses ?? null;
                } else {
                    tally.windowsProcessed++;
                    tally.eventsAdded += (result.value?.events?.length || 0);
                }
            }
        }

        return tally;
    }

    /**
     * Update progress display for one finalized batch. Called by the
     * coordinator after each insert resolves — matches the user's "show
     * stored, not extracted" preference (decision #2 in the design chat).
     * The `batchLastIdx + 1` value is the next window to process; passing it
     * to updateProgress keeps the progress bar advancing at the rhythm of
     * inserts, not extracts. A re-send pass works behind that point, so the
     * bar stays at the end.
     */
    function _updateProgressAfterFinalize(extractResult) {
        const advancedWindowIdx = resendPassesDone > 0 ? windows.length : extractResult.batchLastIdx + 1;
        if (totalLegacyChunks > 0) {
            // Counted from the chat's first message, as the planned chunks are.
            const coveredMessages = Math.min(messages.length, (windows[0]?.start ?? 0) + (advancedWindowIdx * step) + windowOverlap);
            const processedLegacyChunks = _estimateProcessedLegacyChunks({
                coveredMessages,
                totalMessages: messages.length,
                totalChunks: totalLegacyChunks,
                strategy: legacyStrategy,
                batchSize: legacyBatchSize,
            });
            progressTracker.updateEmbeddingProgress(processedLegacyChunks, totalLegacyChunks);
        }

        progressTracker.updateChunks(eventsExtracted);
        progressTracker.updateProgress(
            advancedWindowIdx,
            `${eventsExtracted} event(s) found, processing windows...`,
        );
    }

    // -----------------------------------------------------------------------
    // Coordinator — single-slot pipelined loop.
    // -----------------------------------------------------------------------
    let dispatchWindows = windows; // the windows of the current pass
    let windowsToResend = [];      // failed in the current pass: { win, wasTimedOut }
    let resendPassesDone = 0;
    let windowsProcessedBeforePass = 0;
    let nextBatchFirstIdx = fastForwardSkipped;
    let pendingExtract = null;  // Promise<ExtractResult> | null
    let pendingInsert  = null;  // Promise<Tally> | null
    let queuedResult   = null;  // ExtractResult waiting for insert slot | null
    // Race-wrapper promises tagged with kind so Promise.race can tell which
    // side finished. They wrap pendingExtract / pendingInsert respectively;
    // a winner.kind === 'extract' result discharges pendingExtract, and
    // 'insert' discharges pendingInsert.
    let extractKey = null;
    let insertKey  = null;

    while (true) {
        if (abortSignal?.aborted) {
            // Per design: drain in-flight insert so what landed in Qdrant is
            // accompanied by its mark+tip writes. Discard any in-flight
            // extract (its events were never inserted). Discard queuedResult
            // (same reason). On the next run, those windows re-extract from
            // a clean state.
            if (pendingInsert) {
                try { await pendingInsert; } catch (_) { /* swallow — we're stopping */ }
            }
            if (pendingExtract) {
                try { await pendingExtract; } catch (_) { /* swallow */ }
            }
            progressTracker.complete(false, 'Stopped by user');
            // The windows already replaced keep a walk through them.
            const eventIdsWithMovedLinks = await windowReplacement.moveLinksOffReplacedEvents();
            return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed, insertedEventIds, eventIdsWithMovedLinks };
        }

        // Decide what can start this iteration. Order is load-bearing:
        // start the insert FIRST so queuedResult clears, then start the
        // extract against the updated state. Doing extract first would let
        // queuedResult block the new extract in the same tick that the
        // insert was about to consume it — which was the bug the first
        // pipeline iteration shipped with: extract N+1 always waited a
        // full extra cycle for the in-flight insert to finish, instead of
        // running alongside it. Net effect: serial barrier reappeared and
        // wall time matched pre-pipeline.
        if (!pendingInsert && queuedResult !== null) {
            const toInsert = queuedResult;
            queuedResult = null;
            pendingInsert = _finalizeBatch(toInsert);
            insertKey = pendingInsert.then(
                t => ({ kind: 'insert', tally: t, extractResult: toInsert }),
                e => ({ kind: 'insert', error: e, extractResult: toInsert }),
            );
        }

        // Single-slot invariant — three gates on starting a new extract:
        //   (a) !pendingExtract        — no extract currently running
        //   (b) queuedResult === null  — no PRIOR extract result waiting to be
        //                                 inserted. Without this gate, when
        //                                 insert is much slower than extract,
        //                                 each new extract silently overwrites
        //                                 the previously-queued extract result
        //                                 in the race resolver (queuedResult =
        //                                 winner.result), and those events are
        //                                 lost. Symptoms: ~50% recall vs serial
        //                                 mode, no errors logged, pipeline
        //                                 dispatches batches unboundedly while
        //                                 inserts stack up.
        //   (c) !insertBarrier         — pipelined opt-out (serial mode)
        //                                 additionally blocks on in-flight
        //                                 insert, as a diagnostic fallback.
        // The first if (insert-start) above will consume queuedResult if it can.
        // So if queuedResult is still non-null here, it means insert IS in
        // flight — we MUST NOT start a new extract because there's nowhere to
        // put its result. Correct single-slot behavior: at most one extract
        // + one insert in flight + one queued result.
        const insertBarrier = disablePipeline && pendingInsert !== null;
        if (!pendingExtract && queuedResult === null && !insertBarrier && nextBatchFirstIdx < dispatchWindows.length) {
            const slice = dispatchWindows.slice(nextBatchFirstIdx, nextBatchFirstIdx + CONCURRENCY);
            nextBatchFirstIdx += slice.length;
            pendingExtract = _runOneExtractBatch(slice);
            extractKey = pendingExtract.then(
                r => ({ kind: 'extract', result: r }),
                e => ({ kind: 'extract', error: e }),
            );
        }

        // End of a pass: nothing pending, nothing queued, no more windows in it.
        if (!pendingExtract && !pendingInsert) {
            const hasPassLeft = resendPassesDone < WINDOW_RESEND_BACKOFF_MS.length;
            const isPassWithoutProgress = windowsProcessed === windowsProcessedBeforePass
                && windowsToResend.length > MAX_WINDOWS_TO_RESEND_WITHOUT_PROGRESS;
            if (windowsToResend.length === 0 || !hasPassLeft || isPassWithoutProgress) break;

            const pass = resendPassesDone + 1;
            const backoffMs = WINDOW_RESEND_BACKOFF_MS[resendPassesDone];
            log.warn(`[EventBase] Sending ${windowsToResend.length} failed window(s) again in ${backoffMs / 1000}s, pass ${pass}/${WINDOW_RESEND_BACKOFF_MS.length}`);
            progressTracker.updateProgress(windows.length, `Sending ${windowsToResend.length} failed window(s) again, pass ${pass}/${WINDOW_RESEND_BACKOFF_MS.length}...`);
            await _waitBeforeResendPass(backoffMs, abortSignal);
            if (abortSignal?.aborted) continue; // the top of the loop ends the run

            // These windows are in flight again: a tally counts them if they fail again.
            for (const { wasTimedOut } of windowsToResend) {
                if (wasTimedOut) windowsTimedOut--;
                else windowsFailed--;
            }
            firstFailureDetail = null;
            rejectionCauses = null;
            windowsProcessedBeforePass = windowsProcessed;
            dispatchWindows = windowsToResend.map(({ win }) => win);
            windowsToResend = [];
            nextBatchFirstIdx = 0;
            resendPassesDone = pass;
            continue;
        }

        // Race whichever is in flight.
        const inFlight = [];
        if (pendingExtract) inFlight.push(extractKey);
        if (pendingInsert)  inFlight.push(insertKey);

        const winner = await Promise.race(inFlight);

        if (winner.kind === 'extract') {
            pendingExtract = null;
            extractKey = null;
            if (winner.error) {
                // Extract-side fatal (auth/config). Drain any in-flight insert
                // — that data is already on the wire, we must not tear it
                // down. Then surface the fatal.
                if (pendingInsert) {
                    try { await pendingInsert; } catch (_) { /* secondary */ }
                }
                progressTracker.complete(false, `EventBase fatal error: ${winner.error.message}`);
                throw winner.error;
            }
            queuedResult = winner.result;
        } else {
            // insert-side resolution
            pendingInsert = null;
            insertKey = null;
            if (winner.error) {
                // _insertWithRetry threw an EventBaseFatalError (a configuration
                // error at once, anything else after its retries), a hedge-fatal
                // error, or an AbortError. Drain in-flight extract before surfacing.
                if (pendingExtract) {
                    try { await pendingExtract; } catch (_) { /* swallow */ }
                }
                if (winner.error?.name === 'AbortError') {
                    progressTracker.complete(false, 'Stopped by user');
                    const eventIdsWithMovedLinks = await windowReplacement.moveLinksOffReplacedEvents();
                    return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed, insertedEventIds, eventIdsWithMovedLinks };
                }
                // Surface the Qdrant error to the user. EventBaseFatalError
                // is caught at the UI layer and turned into a popup.
                const errMsg = winner.error?.message || String(winner.error);
                progressTracker.complete(false, `Stopped — ${errMsg}`);
                throw winner.error;
            }
            // Insert succeeded — fold tally and update progress.
            const tally = winner.tally;
            if (tally.fatalError) {
                // Extract-side fatal that came through batchResults rather
                // than as a rejected promise. Same handling as above.
                if (pendingExtract) {
                    try { await pendingExtract; } catch (_) { /* swallow */ }
                }
                progressTracker.complete(false, `EventBase fatal error: ${tally.fatalError.message}`);
                throw tally.fatalError;
            }
            eventsExtracted  += tally.eventsAdded;
            windowsProcessed += tally.windowsProcessed;
            windowsSkipped   += tally.windowsSkipped;
            windowsTimedOut  += tally.windowsTimedOut;
            windowsFailed    += tally.windowsFailed;
            firstFailureDetail ??= tally.failureDetail;
            rejectionCauses ??= tally.rejectionCauses;
            windowsToResend.push(...tally.windowsToResend);
            _updateProgressAfterFinalize(winner.extractResult);
        }
    }

    // End-of-run silent-loss check. The per-batch hash uniqueness assertion in
    // eventbase-store.js insertEvents() catches intra-batch collisions; this
    // catches CROSS-batch collisions or any other loss mechanism in the layers
    // beneath us (Similharity plugin silently dropping items, payload validation
    // rejecting fields, Qdrant accepting but not persisting, etc.). Such a loss
    // shows no error anywhere — the plugin logs "Inserted N" and Qdrant returns
    // 200 — so what landed is counted at the end of every run.
    //
    // Cost: one extra HTTP round-trip per ingestion run (not per batch). For a
    // 25-minute backfill, +0.5s is irrelevant. Skipped on the Standard backend
    // since this path only exists for Qdrant collections; the Standard backend
    // has its own atomicity story.
    if (collectionId && eventsExtracted > 0 && settings?.vector_backend === 'qdrant') {
        try {
            const storedHashes = await getSavedHashes(collectionId, settings);
            const storedCount = Array.isArray(storedHashes) ? storedHashes.length : 0;
            // The tip-based marker can include events from earlier runs, so we
            // compare only DELTA: did storedCount grow by AT LEAST eventsExtracted
            // since this run started? We don't have a pre-run snapshot, so the
            // weaker check we can do is "stored >= eventsExtracted from this run
            // plus whatever was there before." If storedCount is LESS than the
            // events we believe we inserted this run alone, something dropped.
            if (storedCount < eventsExtracted) {
                log.warn(
                    `[EventBase] SILENT LOSS DETECTED: this run inserted ${eventsExtracted} events, ` +
                    `but the collection holds only ${storedCount} total points. At least ` +
                    `${eventsExtracted - storedCount} events were dropped between the workflow ` +
                    `and Qdrant. Investigate the Similharity plugin log for the time range ` +
                    `of this run.`,
                );
                progressTracker.complete(false,
                    `Silent loss detected: ${eventsExtracted - storedCount} event(s) inserted but not stored. Check console.`,
                );
                throw Object.assign(
                    new Error(`EventBase: silent insert loss — sent ${eventsExtracted} events, only ${storedCount} stored in collection.`),
                    { code: 'insert_verification_failed', name: 'EventBaseFatalError' },
                );
            }
            log.lifecycle(`[EventBase] Verification: ${eventsExtracted} inserted this run, ${storedCount} total stored.`);
        } catch (verifyErr) {
            // Only re-throw our own verification failure. Network errors on the
            // verification round-trip itself shouldn't kill an otherwise-successful
            // run — they're advisory only.
            if (verifyErr?.code === 'insert_verification_failed') throw verifyErr;
            log.warn('[EventBase] Verification probe failed (advisory, not fatal):', verifyErr?.message || verifyErr);
        }
    }

    // A window still timed out after its re-sends is a real failure. Reflect it in
    // the progress modal rather than a misleading green "success" — especially when
    // timeouts swallowed the whole run (0 events). A caller with a next step gives the verdict itself.
    if (!shouldCompleteProgress) {
        log.verbose('[EventBase] The progress panel stays open for the next step of the run');
    } else if (windowsTimedOut > 0) {
        progressTracker.complete(false,
            `EventBase: ${windowsTimedOut} window(s) timed out — ${eventsExtracted} event(s) extracted. Raise "Extraction timeout" on the ChatHistory page, or check that your model or endpoint is responding.`);
    } else if (windowsFailed > 0) {
        // A window that errored stored nothing and was never marked extracted, so
        // reporting the run green told the user "this chat has no events" when the
        // truth was "every request failed" (issue #14). Name the first reason —
        // these failures are near-always the same cause repeated.
        progressTracker.complete(false,
            `EventBase: ${windowsFailed} window(s) failed — ${eventsExtracted} event(s) extracted.`
            + (firstFailureDetail ? ` First error: ${firstFailureDetail}` : ' See the console for details.'));
    } else {
        const waitingNote = messagesWaitingForWindow > 0
            ? `; ${messagesWaitingForWindow === 1 ? '1 message waits' : `${messagesWaitingForWindow} messages wait`} for the next window`
            : '';
        progressTracker.complete(true, `EventBase: extracted ${eventsExtracted} event(s) from ${windowsProcessed} window(s)${waitingNote}`);
    }

    log.lifecycle(`[EventBase] Ingestion complete: extracted=${eventsExtracted}, processed=${windowsProcessed}, skipped=${windowsSkipped}, timedOut=${windowsTimedOut}, failed=${windowsFailed}`);

    // StoryArc links that went to events this run replaced now point at the events that replaced them.
    const eventIdsWithMovedLinks = await windowReplacement.moveLinksOffReplacedEvents();

    // New events get their StoryArc links in the background, so this run ends now. A run reading a stretch again
    // leaves them to its caller, which links them in the open (D3 of eventbase-read-range-again.md).
    if (!isReadingAgain && settings?.story_arc_mode_enabled && insertedEventIds.length > 0 && !abortSignal?.aborted) {
        const { linkNewStoryEvents } = await import('./story-arc-links.js');
        void linkNewStoryEvents({ collectionId, newEventIds: insertedEventIds, settings });
    }

    // Notify the UI so the AutoSync page's status can turn to Up to date.
    // Cheap signal; listeners just re-evaluate state, they don't read this payload.
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('vectfox:eventbase-synced', {
            detail: { collectionId, eventsExtracted, windowsProcessed }
        }));
    }

    return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed, firstFailureDetail, rejectionCauses, insertedEventIds, eventIdsWithMovedLinks };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Run the EventBase retrieval pipeline and inject the result into the prompt.
 *
 * @param {object} params
 * @param {object[]} params.chat       - Full ST chat array
 * @param {string}   params.searchText - Query text (from buildSearchQuery)
 * @param {object}   params.settings   - VectFox settings
 * @param {string}  [params.chatUUID]  - Override chat UUID
 * @param {object}  [params.inUse]     - The chat's collection in use (collectionInUse), as the reply step resolved it
 *   for the whole reply; resolved here without it
 * @param {{isCurrent: () => boolean}} [params.boundedRun] - The reply step's bounded run (runBoundedRetrieval): once
 *   its bound has passed the reply has gone without this retrieval, so it searches no further and publishes nothing,
 *   no block and no toast of what it found. A preview has none.
 * @returns {Promise<void>}
 */
export async function runEventBaseRetrieval({ chat, searchText, settings, chatUUID, dryRun = false, testMessage = null, inUse = null, boundedRun = UNBOUNDED_RUN }) {
    const uuid = chatUUID || getChatUUID();
    const currentChatId = getCurrentChatId();

    // What a reply reads (§2.2 of vectfox-multi-collection-per-chat.md): the chat's collection in use, unless it is
    // paused, beside the collections of other chats and chat files locked here, each on the backend it was made on.
    // With none in use the chat's own events are read nowhere; the reply step says so in red.
    const ownInUse = (inUse ?? collectionInUse(settings, { chatUUID: uuid })).collection;
    const ownCollection = ownInUse && !ownInUse.isPaused ? ownInUse : null;
    const shared = sharedCollectionsLockedHere({ chatUUID: uuid, chatId: currentChatId });
    const otherChatsCollections = shared.otherChats.filter(collection => !collection.isPaused);
    const lockedLiveCollections = [...(ownCollection ? [ownCollection] : []), ...otherChatsCollections];
    const queryEventbase = lockedLiveCollections.length > 0;

    log.lifecycle(`[EventBase] Live retrieval: uuid=${uuid}, lockedLiveCollections=${lockedLiveCollections.length}, ids=${JSON.stringify(lockedLiveCollections.map(c => c.collectionId))}`);

    const archiveCollections = shared.archives.filter(collection => !collection.isPaused);

    if (!queryEventbase && archiveCollections.length === 0) {
        log.lifecycle('[EventBase] No live collection and no archive collections — skipping Phase A');
        if (dryRun) return { injectionText: null, eventCount: 0, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    log.verbose(`[EventBase] Phase A: live=${queryEventbase}, archiveCollections=${archiveCollections.length}, searchText length=${searchText?.length}`);

    log.verbose(`[EventBase Popup] on-start gate: retrieval_popup_on_start=${settings.retrieval_popup_on_start}, dryRun=${dryRun} → fire=${!!settings.retrieval_popup_on_start}`);
    if (settings.retrieval_popup_on_start) {
        toastr.info('Retrieving context from EventBase...', 'VectFox Retrieval');
    }

    // Extract the user's most recent message for focused keyword extraction.
    // In dryRun / testMessage mode the caller supplies the message directly.
    const lastUserMessage = [...(chat || [])]
        .reverse()
        .find(m => !m.is_system && m.is_user);
    const keywordQuery = testMessage || lastUserMessage?.mes?.trim() || null;
    const effectiveSearchText = testMessage || searchText;

    if (keywordQuery) {
        log.verbose(`[EventBase] Keyword query (user last message, ${keywordQuery.length} chars):`, keywordQuery.slice(0, 120));
    }

    // --- Query archive event collections in parallel ---
    const topK = (settings.eventbase_retrieval_top_k || 8) * 2;
    const additionalCandidates = await searchArchiveEvents(archiveCollections, effectiveSearchText, topK, settings);

    if (additionalCandidates.length > 0) {
        log.verbose(`[EventBase] Queried ${archiveCollections.length} archive event collection(s) → ${additionalCandidates.length} event(s)`);
    }

    if (!boundedRun.isCurrent()) {
        log.lifecycle('[EventBase] The retrieval\'s bound passed during the archive search: the reply went without it, so nothing more is searched');
        return;
    }

    // Another chat's collection locked here: its source_window_end values belong to a different conversation and
    // cannot be compared to the current chat length, so the context-dedup step is skipped.
    const isCrossChat = otherChatsCollections.length > 0;

    // retrieveEventsForTurn decides the turn's path: StoryArc mode, Agent Mode, or the plain search.
    const { events, debug, storyArcShape, storyArcEntityNames } = await retrieveEventsForTurn({
        searchText: effectiveSearchText,
        keywordQuery,
        chatLength: getContext().chat?.length || chat?.length || 0,
        settings,
        // Canonical routing (Doc/collection_helper.md): the registry-key form
        // ("backend:id") searches each locked collection on the backend it was
        // created with, so a Standard and a Qdrant EventBase can be locked together.
        liveCollectionIds: lockedLiveCollections.map(c => c.registryKey),
        // StoryArc reads the collection in use alone, its events and their links (D18).
        storyArcCollectionKey: ownCollection?.registryKey ?? null,
        additionalCandidates,
        skipLiveQuery: !queryEventbase,
        skipContextDedup: isCrossChat,
    });

    log.trace('[EventBase] Retrieval debug:', debug);
    // A search that failed on its setup, such as a deleted embedding profile, fails every turn until the user fixes it,
    // so it is said even past the bound.
    if (debug?.setupFailureMessage) notifyInvalidModel(debug.setupFailureMessage);

    // Nothing below awaits, so this one check keeps a retrieval that settled past its bound from publishing: no block,
    // and no toast of what it found, for a reply that went without it.
    if (!boundedRun.isCurrent()) {
        log.lifecycle(`[EventBase] The retrieval settled past its bound with ${events?.length ?? 0} event(s): the reply went without them, so nothing is injected or shown`);
        return;
    }
    const hasFailedSearch = Boolean(debug?.setupFailureMessage) || debug?.failedSearchCount > 0;
    if (!debug?.setupFailureMessage && debug?.failedSearchCount > 0) notifyMemoryNotInjected(debug.searchFailureMessage, Boolean(events?.length));

    if (!events?.length) {
        log.lifecycle('[EventBase] No events to inject');
        log.verbose(`[EventBase Popup] no-events branch gate: retrieval_popup_on_result=${settings.retrieval_popup_on_result} → fire=${!!settings.retrieval_popup_on_result}`);
        if (settings.retrieval_popup_on_result) {
            const rawCount = debug?.rawCount ?? 0;
            // After a failed search, whose toast above says no memory was injected, "no events matched" would read as a
            // search that worked.
            if (rawCount > 0) toastr.info(`EventBase: ${rawCount} event(s) already in context`, 'VectFox Retrieval');
            else if (!hasFailedSearch) toastr.info('EventBase: no events matched', 'VectFox Retrieval');
        }
        if (dryRun) return { injectionText: null, eventCount: 0, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    const injectionResult = storyArcShape
        ? formatStoryArcForInjection(events, storyArcShape, storyArcEntityNames)
        : formatEventsForInjectionDetailed(events, settings);
    let injectionText = injectionResult.text;
    const injectedCount = injectionResult.includedCount;
    if (!injectionText) {
        log.verbose('[EventBase] Injection text empty after formatting');
        if (dryRun) return { injectionText: null, eventCount: 0, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    // A preview injects nothing, and its tester shows what it found.
    const isInjectedToastShown = Boolean(settings.retrieval_popup_on_result) && !dryRun;
    log.verbose(`[EventBase Popup] success gate: retrieval_popup_on_result=${settings.retrieval_popup_on_result}, dryRun=${dryRun}, injectedCount=${injectedCount} → fire=${isInjectedToastShown}`);
    if (isInjectedToastShown) {
        toastr.success(`EventBase: ${injectedCount} event(s) injected`, 'VectFox Retrieval');
    }

    // The RAG page's context prompt goes before the events, and its XML tag wraps them.
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    if (globalContext) {
        injectionText = `${globalContext}\n\n${injectionText}`;
    }

    const xmlTag = settings.rag_xml_tag || '';
    if (xmlTag) {
        injectionText = `<${xmlTag}>\n${injectionText}\n</${xmlTag}>`;
    }

    // Dry-run: return text without touching the extension prompt slot
    if (dryRun) {
        return { injectionText, eventCount: injectedCount, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length, storyArc: debug?.storyArc ?? null };
    }

    // Clear any previous EventBase injection
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);

    // Inject using the same slot mechanism as legacy chunks
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, injectionText, settings.position, settings.depth, false);

    if (log.domainEnabled('injection')) {
        log.domain('injection', 'trace', `[EventBase] Injected ${injectedCount} event(s) (requested ${events.length}), text length: ${injectionText.length}`);
        log.domain('injection', 'trace', `[EventBase] setExtensionPrompt tag="${EVENTBASE_PROMPT_TAG}" position=${settings.position} depth=${settings.depth}`);
        // Verify the slot is actually populated
        const slotContent = extension_prompts[EVENTBASE_PROMPT_TAG];
        log.domain('injection', 'trace', `[EventBase] Slot verification — key exists: ${EVENTBASE_PROMPT_TAG in extension_prompts}, value type: ${typeof slotContent?.value}, length: ${slotContent?.value?.length ?? slotContent?.length ?? '?'}`);
        log.domain('injection', 'trace', '[EventBase] extension_prompts keys:', Object.keys(extension_prompts));
        log.domain('injection', 'trace', '[EventBase] Injection preview:', injectionText.slice(0, 300));
    }

}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Estimate how many legacy chunks are effectively processed based on covered messages.
 * This keeps EventBase progress aligned with the Vectorize Content chunk semantics.
 *
 * @param {object} params
 * @param {number} params.coveredMessages
 * @param {number} params.totalMessages
 * @param {number} params.totalChunks
 * @param {string} params.strategy
 * @param {number} params.batchSize
 * @returns {number}
 */
function _estimateProcessedLegacyChunks({ coveredMessages, totalMessages, totalChunks, strategy, batchSize }) {
    if (totalChunks <= 0 || totalMessages <= 0) return 0;

    const covered = Math.max(0, Math.min(totalMessages, coveredMessages));
    let processed = 0;

    switch (strategy) {
        case 'per_message':
            processed = covered;
            break;
        case 'conversation_turns':
            processed = Math.ceil(covered / 2);
            break;
        case 'message_batch':
            processed = Math.ceil(covered / Math.max(1, batchSize));
            break;
        default: {
            // Fallback to proportional estimate for size-based strategies.
            const ratio = covered / totalMessages;
            processed = Math.round(totalChunks * ratio);
            break;
        }
    }

    return Math.max(0, Math.min(totalChunks, processed));
}

/**
 * Returns true if the last complete window of the given messages has already been
 * extracted into the collection and no window is on its unfinished record. Uses the same
 * hash + window parameters as the main ingestion loop so the result is authoritative.
 *
 * Returns false when the messages hold no complete window (nothing extractable yet).
 *
 * @param {object[]} messages  - Filtered chat messages (non-empty)
 * @param {object}   settings  - VectFox settings
 * @param {string}   registryKey - The registry key ("backend:id") of the chat's collection
 * @param {number}   [windowSizeOverride]
 * @param {number}   [windowOverlapOverride]
 * @param {number}   [firstWindowStart] - The message the first window starts at: auto-sync's from its start marker
 *   (autoSyncFirstWindowStart), as its runs build them
 * @returns {boolean}
 */
export function isChatFullyVectorized(messages, settings, registryKey, windowSizeOverride = undefined, windowOverlapOverride = undefined, firstWindowStart = 0) {
    const windowSize = windowSizeOverride != null
        ? Math.max(2, windowSizeOverride)
        : Math.max(2, settings.eventbase_window_size || 6);
    const windowOverlap = windowOverlapOverride != null
        ? Math.max(0, Math.min(windowSize - 1, windowOverlapOverride))
        : Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 0));
    const step = windowSize - windowOverlap;
    return getUnfinishedWindowFingerprints(registryKey, windowSize).size === 0
        && isLastWindowExtracted(messages, windowSize, step, registryKey, hashSourceMessage, firstWindowStart);
}

/**
 * Evaluate chat auto-sync state for the current chat. Used by the AutoSync page's
 * switch and status, and by the switch's enable flow.
 *
 * Reads the registry and the collection's pointer, in its record. The one
 * backend call is the vectorization-tip probe (ensureVectorizationTip), which runs
 * when the tip is not cached yet or is far behind the chat. Passive refreshes while VectFox is disabled
 * pass `shouldProbeBackend: false` (report the cached tip alone, never call the backend).
 * The collection is the chat's collection in use, through the one route every reader and writer asks (collectionInUse).
 *
 * Returns one of:
 *   { state: 'no-chat' }                                              — no chat is open
 *   { state: 'no-collection' }                                        — chat has no eventbase collection yet
 *   { state: 'none-locked', collections, noneInUseText }              — chat has collections of its own on this backend
 *                                                                       and none in use (collectionInUse), so nothing reads
 *                                                                       or writes its events; noneInUseText says why
 *   { state: 'vectorization-ahead', collectionId, registryKey,
 *     chatMessageCount, commitBoundary, unfinishedWindowCount,
 *     markerValue?, vectorizationTip }                                  — collection exists, but its tip is past the
 *                                                                       chat's end: messages were deleted, a summary
 *                                                                       replaced some, or the events came from a longer
 *                                                                       copy of the chat. Auto-sync goes on with new
 *                                                                       messages; ghosting blanks nothing until the chat
 *                                                                       passes the tip
 *   { state: 'partial',          collectionId, registryKey,
 *     chatMessageCount, commitBoundary, unfinishedWindowCount,
 *     markerValue?, vectorizationTip? }                                — collection exists, last window not extracted or
 *                                                                       windows on the unfinished record; counts let the
 *                                                                       UI show the backfill gap
 *   { state: 'fully-vectorized', collectionId, registryKey,
 *     chatMessageCount, commitBoundary, unfinishedWindowCount: 0,
 *     markerValue?, vectorizationTip? }                                — collection exists, last window already extracted
 *                                                                       and none on the unfinished record
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {object} [options]
 * @param {boolean} [options.shouldProbeBackend=true] - false = never query the backend for the tip
 * @returns {Promise<object>}
 */
export async function getChatAutoSyncStatus(settings, { shouldProbeBackend = true } = {}) {
    const chatId = getCurrentChatId();
    if (!chatId) return { state: 'no-chat' };

    const uuid = getChatUUID();
    if (!uuid) return { state: 'no-chat' };

    const inUse = collectionInUse(settings, { chatUUID: uuid, chatId });
    const match = inUse.collection;
    if (!match) {
        if (!inUse.collections.length) return { state: 'no-collection' };
        const noneInUseText = noCollectionInUseText(inUse, 'EventBase reads and writes nothing here', { isWhereToChooseSaid: false });
        return { state: 'none-locked', collections: inUse.collections, noneInUseText };
    }

    const ctx = getContext();
    const messages = Array.isArray(ctx?.chat)
        ? ctx.chat.filter(m => m.mes && m.mes.trim().length > 0)
        : [];
    const chatMessageCount = messages.length;

    // The auto-sync marker (the collection's message-index threshold): the count the page shows while no tip is known.
    const markerValue = getAutoSyncMarker(match.registryKey);

    // Evaluate auto-sync "fully vectorized" against the AUTO-SYNC window (turns*2,
    // overlap 0), not the one-off Vectorize Content window — otherwise the status
    // would read "partial" forever whenever the two window sizes differ.
    //
    // Settle/commit lag: evaluate against the COMMITTED slice (chat minus the
    // active, still-swipeable last turn), matching what runEventBaseIngestion
    // actually extracts. Without this, the deliberately-unextracted active turn
    // would pin the status on "partial" forever. After a manual full vectorize the
    // committed slice's last window is also extracted, so the status still reads up to date —
    // both modes stay consistent. See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
    const commitBoundary = getCommitBoundary(messages, settings);
    const committedMessages = commitBoundary < messages.length ? messages.slice(0, commitBoundary) : messages;
    const autoSyncWindowSize = getAutoSyncWindowSize(settings);
    const fullyVectorized = isChatFullyVectorized(committedMessages, settings, match.registryKey, autoSyncWindowSize, 0,
        autoSyncFirstWindowStart(match.registryKey, autoSyncWindowSize));

    // Cache-first read; one-time probe on cold cache populates from Qdrant, and a
    // far-behind tip gets one check per page load. After first session-warmup, the
    // ingestion loop keeps this up-to-date via setVectorizationTip after each window.
    // See eventbase-store.js for the cache lifecycle docs. Without the probe, a cold
    // cache reports no tip.
    const vectorizationTip = shouldProbeBackend
        ? await ensureVectorizationTip(match.registryKey, settings, { commitBoundary, windowSize: getAutoSyncWindowSize(settings) })
        : getVectorizationTip(match.registryKey);

    // A tip past the chat's end was read on a longer chat: messages were deleted, a summary replaced some, or the
    // events came from a longer copy of this chat. The page says so, as it cannot count what is read here.
    const isTipPastChatEnd = typeof vectorizationTip === 'number' && vectorizationTip > chatMessageCount;
    let state = fullyVectorized ? 'fully-vectorized' : 'partial';
    if (isTipPastChatEnd) state = 'vectorization-ahead';

    return {
        state,
        collectionId: match.collectionId,
        registryKey: match.registryKey,
        chatMessageCount,
        commitBoundary,
        unfinishedWindowCount: getUnfinishedWindowFingerprints(match.registryKey, getAutoSyncWindowSize(settings)).size,
        markerValue: typeof markerValue === 'number' ? markerValue : undefined,
        vectorizationTip: typeof vectorizationTip === 'number' ? vectorizationTip : undefined,
    };
}
