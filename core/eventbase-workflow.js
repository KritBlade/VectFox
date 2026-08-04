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

import { setExtensionPrompt, extension_prompts, getCurrentChatId, substituteParams } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getChatUUID, parseRegistryKey, COLLECTION_PREFIXES, buildRegistryKey } from './collection-ids.js';
import { getCollectionRegistry } from './collection-loader.js';
import { queryCollection } from './core-vector-api.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';
import { EventBaseFatalError, EventBaseExtractionError } from './eventbase-schema.js';
import { extractEvents } from './eventbase-extractor.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { insertEvents, isWindowAlreadyExtracted, markWindowExtracted, clearExtractionCachesForChat, buildEventBaseCollectionId, isLastWindowExtracted, setVectorizationTip, ensureVectorizationTip, shouldUseTipFallback, resolveActiveEventBaseCollection } from './eventbase-store.js';
import { getSavedHashes } from './core-vector-api.js';
import { retrieveEvents } from './eventbase-retrieval.js';
import { retrieveEventsWithAgent } from './agentic-retrieval.js';
import { formatEventsForInjectionDetailed } from './eventbase-injection.js';
import { isCollectionEnabled, isCollectionActiveForContextAnyKey, setCollectionLock, setCollectionMeta } from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { log } from './log.js';

/** Extension prompt tag for EventBase (distinct from legacy chunks tag) */
const EVENTBASE_PROMPT_TAG = `${EXTENSION_PROMPT_TAG}_eventbase`;

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
 * source of truth shared by the window-builder, the quick-exit, and the LED /
 * counter so "fully synced" means "all committed windows done", not "the active
 * turn done". See plans/autosync-settle-lag.md.
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
 * Run the EventBase ingestion pipeline over a slice of chat messages.
 *
 * Sliding window approach:
 *   - Window size:    settings.eventbase_window_size    (default 2; may be overridden via windowSizeOverride param)
 *   - Overlap:        settings.eventbase_window_overlap (default 0; may be overridden via windowOverlapOverride param)
 * Each window is sent to the LLM for structured event extraction.
 * Already-extracted windows are skipped (dedup by source hashes).
 *
 * Auto-sync callers pass *Override params (derived from
 * settings.eventbase_autosync_window_turns) so they don't read the settings
 * keys at all. One-off Vectorize Content and backfill callers omit the
 * overrides and read the settings keys directly.
 *
 * @param {object} params
 * @param {object[]} params.messages    - Chat messages to process (array of ST message objects)
 * @param {string}  [params.chatUUID]   - Override chat UUID
 * @param {object}   params.settings    - VectFox settings
 * @param {AbortSignal|null} [params.abortSignal]
 * @param {{ strategy?: string, batchSize?: number, totalChunks?: number }|null} [params.progressPlan]
 * @returns {Promise<{ eventsExtracted: number, windowsProcessed: number, windowsSkipped: number, windowsTimedOut?: number, windowsFailed?: number }>}
 */
/**
 * How many windows this run left unfinished — they produced no events, were not
 * marked extracted, and will be retried next run.
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

export async function runEventBaseIngestion({ messages, chatUUID, settings, abortSignal = null, progressPlan = null, collectionIdOverride = null, parallelWindows = 3, isAutoSync = false, suppressAutoSyncPopup = false, skipTipFallback = false, windowSizeOverride = undefined, windowOverlapOverride = undefined }) {
    const uuid = chatUUID || getChatUUID();

    // Resolve the write target. Precedence:
    //   1. Explicit override (archive uploads pass a fixed ID; auto-sync passes the
    //      collection it already resolved for its gate).
    //   2. The chat's ACTIVE collection from the registry — the source of truth.
    //   3. A freshly-built ID, ONLY for first-time ingestion when no collection
    //      exists yet (resolve returns null).
    //
    // Step 2 is load-bearing for group chats. buildEventBaseCollectionId derives the
    // ID's char segment from the LIVE context.name2, which in a group chat is whoever
    // is speaking on this trigger. Recomputing it per call would manufacture and lock
    // a NEW per-character EventBase collection for the same chat every time a
    // different character speaks, scattering events across siblings that the
    // summarizer (which reads only resolveActiveEventBaseCollection) never sees.
    // Trusting the registry instead of recomputing the ID is the rule in
    // Doc/collection_helper.md — the registry is the source of truth for which
    // collection holds a chat's data.
    const collectionId = collectionIdOverride
        || resolveActiveEventBaseCollection(settings, uuid)?.collectionId
        || buildEventBaseCollectionId(uuid, settings?.vector_backend);

    // Lock to current chat at start so the index is populated even if vectorization is interrupted.
    // Archive collections are excluded — they are locked manually by the user.
    // Stamping scope='chat' is required for isCollectionActiveForContext() to return true:
    // it gates on scope first, so a lock without scope leaves the collection inert.
    //
    // Metadata writes go to the registry-key form ("backend:id") to match the
    // import path, loader, and cleanupOrphanedMeta. Bare-ID writes would land in
    // a different bucket and get nuked by the orphan-cleanup pass.
    const _startChatId = getCurrentChatId();
    if (_startChatId && !collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT)) {
        const _startRegistryKey = buildRegistryKey(collectionId, settings);
        setCollectionLock(_startRegistryKey, _startChatId);
        setCollectionMeta(_startRegistryKey, { scope: 'chat' });
    }

    const candidateKeys = [
        buildRegistryKey(collectionId, settings),
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

    // Coordinator mode: pipelined (default) vs serial (opt-in via "Serial
    // extract→insert" checkbox in the EventBase tab).
    //
    // - DEFAULT: pipelined — batch N's insert overlaps batch N+1's extract.
    //   ~35% faster wall time. An earlier 2026-05-30 A/B showed pipelined
    //   producing ~44% fewer events/window than serial (0.98 vs 1.74) and
    //   the gap was originally blamed on per-key concurrency contention,
    //   but it was actually a hedge bug: hedge timers fired during
    //   in-flight inserts that were still progressing, wiping events out
    //   of the queue. Bug fixed; pipelined is the safe default now.
    //
    // - SERIAL opt-in (checkbox): each batch finishes embedding before
    //   the next batch starts extracting. Safer if a future regression
    //   reintroduces the queue-wipe class of bug. Anything except explicit
    //   `false` is treated as the new pipelined default; only an explicit
    //   `true` enables serial mode.
    const disablePipeline = settings?.eventbase_disable_pipeline === true;

    if (!messages?.length) return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };

    // If the fingerprint cache says windows were extracted but Qdrant has no data
    // (e.g. collection was deleted externally), reset the cache so we start fresh.
    const cacheEntries = extension_settings?.vectfox?.eventbase_extracted_windows?.[uuid];
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
                clearExtractionCachesForChat(uuid);
            }
        } catch {
            // Non-fatal — proceed without resetting.
        }
    }

    // Build list of windows — skip tail windows that haven't accumulated a full
    // windowSize of messages yet. This prevents the same partial tail from being
    // re-extracted (and potentially duplicating events) on every auto-sync fire.
    // A tail window becomes eligible once it reaches windowSize messages, at which
    // point the next step boundary also produces a fresh overlap window correctly.
    // Quick-exit: check only the LAST complete window fingerprint against the Set cache.
    // If it's already extracted, all prior windows are done too (processed in order).
    // Avoids building O(n/step) window objects on every auto-sync fire when nothing is new.
    // Note: edits to messages deep in history bypass this check — acceptable limitation.
    // Settle/commit lag: on auto-sync, hold back the active (still-swipeable) last
    // turn — only extract messages up to the commit boundary. Manual Vectorize
    // Content / backfill (isAutoSync=false) covers the whole chat. The boundary is
    // the SINGLE source of truth for "what is eligible", reused by the LED/counter
    // (see getChatAutoSyncStatus) so "fully synced" tracks committed windows, not
    // the active turn. See plans/autosync-settle-lag.md.
    const commitBoundary = isAutoSync ? getCommitBoundary(messages, settings) : messages.length;
    const committedMessages = commitBoundary < messages.length ? messages.slice(0, commitBoundary) : messages;

    const _msgHash = m => { const t = (m.mes || '').trim(); return m.hash ?? _djb2(`${m.name || ''}:${t}`); };
    if (isLastWindowExtracted(committedMessages, windowSize, step, uuid, _msgHash)) {
        log.lifecycle(`[EventBase] Quick-exit: last committed window already extracted, nothing new`);
        return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
    }

    // Past the quick-exit: at least the last window is new, so real work will happen.
    // Fire the auto-sync popup here so it shows once per ingestion call regardless of
    // whether older windows turn out to be dedup-skipped in the loop below.
    // suppressAutoSyncPopup is set by synchronizeChat when the trigger was MESSAGE_SENT
    // (user-send mid-generation) — extraction still runs, only the toast is hidden.
    const popupAllowed = isAutoSync && !suppressAutoSyncPopup && settings.eventbase_autosync_popup !== false;
    log.verbose(`[EventBase Popup] auto-sync gate: isAutoSync=${isAutoSync}, suppressAutoSyncPopup=${suppressAutoSyncPopup}, eventbase_autosync_popup=${settings.eventbase_autosync_popup} → fire=${popupAllowed}`);
    if (popupAllowed) {
        try { toastr.info('Auto-Sync: extracting events...', 'VectFox', { timeOut: 3000 }); } catch (_) {}
    }

    // Always-on trace so the user can confirm auto-sync ran without enabling debug logging.
    // popupShown=false here means popup was suppressed (e.g. MESSAGE_SENT) — extraction still runs.
    if (isAutoSync) log.lifecycle(`[VectFox AutoSync] running — messages=${messages.length}, popupShown=${popupAllowed}`);

    let windows = [];
    for (let start = 0; start < commitBoundary; start += step) {
        const end = Math.min(start + windowSize - 1, commitBoundary - 1);
        const msgs = messages.slice(start, end + 1);
        if (msgs.length < windowSize) break; // tail is incomplete — wait for more messages
        windows.push({ start, end, msgs });
    }

    // AutoSync start-marker gate. The marker says "everything before this
    // message index is considered covered by some prior extraction; auto-sync
    // should only process windows whose start >= marker." This prevents the
    // windowFingerprint cache from triggering a full chat re-extraction when
    // the user changes window_size before enabling auto-sync (the fingerprints
    // are window-size-dependent and silently miss after a size change).
    //
    // Marker is stamped by ui-manager.js when auto-sync is enabled. See
    // stampAutoSyncMarker in eventbase-store.js for the placement logic.
    // Only applies to auto-sync runs; manual Vectorize Content / backfill
    // intentionally ignores the marker so the user can refill historical gaps.
    //
    // ⚠️ Regression coverage: TEST 014 (fingerprint cache, same window size) +
    // TEST 015 (this marker filter, window-size-change protection) in
    // tests/Eventbase-test.spec.js together cover the two-layer auto-sync
    // safety story. Doc/collection_helper.md → "Chat Auto-Sync" explains the
    // contract. Any change here — guard, operator (>= vs >), or filter shape
    // — must be reviewed against both tests and the doc. The boundary `>=`
    // is load-bearing: stampAutoSyncMarker uses max(source_window_end)+1,
    // so the next legitimate window starts exactly AT marker. `>` would
    // skip the first new window (extraction gap).
    if (isAutoSync) {
        const { getAutoSyncMarker } = await import('./eventbase-store.js');
        const marker = getAutoSyncMarker(uuid);
        if (typeof marker === 'number') {
            const before = windows.length;
            windows = windows.filter(w => w.start >= marker);
            if (before !== windows.length) {
                log.lifecycle(`[EventBase] AutoSync marker filter: ${before} → ${windows.length} windows (marker=${marker})`);
            }
        }
    }

    log.lifecycle(`[EventBase] Ingestion: ${messages.length} messages → ${windows.length} windows (size=${windowSize}, overlap=${windowOverlap})`);

    const showProgressModal = !isAutoSync || settings.autosync_show_progress_modal === true;
    if (showProgressModal) {
        progressTracker.show('EventBase Extraction', windows.length, 'Windows');
    }

    const totalLegacyChunks = Number(progressPlan?.totalChunks) || 0;
    const legacyStrategy = progressPlan?.strategy || 'per_message';
    const legacyBatchSize = Math.max(1, Number(progressPlan?.batchSize) || 1);
    if (totalLegacyChunks > 0) {
        // Keep the CHUNKS card on legacy math (total + remaining), like standard vectorization.
        progressTracker.updateEmbeddingProgress(0, totalLegacyChunks);
    }

    let eventsExtracted = 0;
    let windowsProcessed = 0;
    let windowsSkipped = 0;
    let windowsTimedOut = 0;
    let windowsFailed = 0;
    let firstFailureDetail = null;

    // First-timeout toast — fire once per run, the moment a window times out,
    // instead of leaving the user staring at a silent "0 vectors" at the end
    // (the #2 bug). A per-call timeout almost always means the model/endpoint is
    // too slow or unreachable, so it's actionable. Shown regardless of the
    // auto-sync popup/progress-modal settings because it's an error, not progress.
    let _timeoutToastShown = false;
    const _notifyFirstTimeout = () => {
        if (_timeoutToastShown) return;
        _timeoutToastShown = true;
        const secs = Math.round((settings.eventbase_timeout_ms || 60000) / 1000);
        try {
            toastr.error(
                `EventBase extraction timed out after ${secs}s. Raise "Extraction Timeout" in the EventBase settings, or check that your model/endpoint is responding. Events from timed-out windows were not stored.`,
                'VectFox — EventBase timeout',
                { timeOut: 0, extendedTimeOut: 0 },
            );
        } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
    };

    // Smart fast-forward: windows are processed in order, so already-extracted ones
    // cluster at the front. Linear-scan past them with cheap Set.has() lookups instead
    // of spinning up Promise.allSettled batches that do the same check 3-at-a-time.
    // The per-window inner check at line ~210 stays as a safety net for edit-in-middle
    // cases (where an old message's hash changes and breaks the contiguity assumption).
    let fastForwardSkipped = 0;
    while (fastForwardSkipped < windows.length) {
        const win = windows[fastForwardSkipped];
        const hashes = win.msgs.map(m => {
            const text = (m.mes || '').trim();
            return m.hash ?? _djb2(`${m.name || ''}:${text}`);
        });
        const isDone = await isWindowAlreadyExtracted(hashes, null, settings, uuid);
        if (!isDone) break;
        fastForwardSkipped++;
    }
    // Tip-based fallback: if the fingerprint cache gave 0 skips (cache empty/stale)
    // and a collection exists, probe Qdrant for the highest source_window_end stored
    // and use that as a fast-forward boundary. Handles the case where the local
    // fingerprint cache was lost (page reload after re-importing an exported Qdrant
    // collection).
    //
    // The decision rule lives in shouldUseTipFallback() — DO NOT inline the condition
    // here. Two bugs on 2026-05-30 (Reset & Vectorize, window-size-change popups) came
    // from callers inlining incompatible "should I bypass the fallback?" logic. Now
    // there's one source of truth in eventbase-store.js.
    const useTipFallback = shouldUseTipFallback({
        skipTipFallback,
        fastForwardSkipped,
        hasCollection: !!collectionId,
    });
    if (!useTipFallback && skipTipFallback) {
        log.lifecycle('[EventBase] shouldUseTipFallback=false — caller explicitly opted out (skipTipFallback=true)');
    }
    if (useTipFallback) {
        try {
            const tip = await ensureVectorizationTip(uuid, collectionId, settings);
            if (typeof tip === 'number' && tip > 0) {
                let i = 0;
                while (i < windows.length && windows[i].end < tip) {
                    const win = windows[i];
                    const hashes = win.msgs.map(_msgHash);
                    markWindowExtracted(hashes, uuid);
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
    // -----------------------------------------------------------------------
    // Pipelined extract/insert loop (see plans/eventbase-extract-insert-pipeline.md).
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
    // -----------------------------------------------------------------------

    /**
     * Per-batch extractor — moved verbatim from the original loop. Runs N
     * windows in parallel via Promise.allSettled, builds the {events, hashes,
     * ends} packet the finalizer needs. Throws EventBaseFatalError only when
     * the underlying LLM call surfaces one (auth/config errors).
     *
     * @param {object[]} windowsSlice
     * @param {number}   batchFirstIdx  Absolute index of this batch's first window
     * @returns {Promise<object>} ExtractResult
     */
    async function _runOneExtractBatch(windowsSlice, batchFirstIdx) {
        const batchStartedAt = performance.now();
        const batchLastIdx = batchFirstIdx + windowsSlice.length - 1;
        log.verbose(`[EventBase concurrency] Dispatching batch: windows ${batchFirstIdx}-${batchLastIdx} (size=${windowsSlice.length}, CONCURRENCY=${CONCURRENCY}) at t=${batchStartedAt.toFixed(1)}ms`);

        const batchResults = await Promise.allSettled(
            windowsSlice.map(async (win, batchOffset) => {
                const wIdx = batchFirstIdx + batchOffset;
                const winStartedAt = performance.now();
                log.verbose(`[EventBase concurrency] Window ${wIdx}: dispatched at +${(winStartedAt - batchStartedAt).toFixed(1)}ms`);

                if (abortSignal?.aborted) return { skipped: true };

                // Compute source hashes for dedup check
                const sourceHashes = win.msgs.map(m => {
                    const text = (m.mes || '').trim();
                    return m.hash ?? _djb2(`${m.name || ''}:${text}`);
                });

                // Skip if already extracted
                const alreadyDone = await isWindowAlreadyExtracted(
                    sourceHashes,
                    win.msgs.map((_, i) => win.start + i),
                    settings,
                    uuid,
                );
                if (alreadyDone) {
                    // Per-window skip log removed — the "Ingestion complete: skipped=N"
                    // summary at the end already conveys this. For a 720-message chat
                    // with windowSize=2, this used to spam ~360 lines per AI reply.
                    return { skipped: true };
                }

                // LLM extraction
                let rawEvents;
                const extractStart = performance.now();
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
                    // it (same test as agentic-retrieval.js), warn loudly, fire the
                    // one-shot toast, and mark the window timedOut so the run reports it.
                    const isTimeout = err?.name === 'TimeoutError'
                        || err?.name === 'AbortError'
                        || /aborted|timeout|timed out/i.test(err?.message || '');
                    if (isTimeout) {
                        const secs = Math.round((settings.eventbase_timeout_ms || 60000) / 1000);
                        log.warn(`[EventBase] Window ${wIdx}: extraction TIMED OUT after ${secs}s (skipped). Raise "Extraction Timeout" in EventBase settings, or check your model/endpoint is responding.`);
                        _notifyFirstTimeout();
                        return { skipped: false, events: [], timedOut: true };
                    }
                    // `failed: true` keeps an errored window out of the processed
                    // tally. Counting it as processed is what let a run where EVERY
                    // window failed still finish green with "extracted 0 event(s)
                    // from N window(s)" — indistinguishable from a chat that
                    // genuinely held no events (issue #14).
                    if (err instanceof EventBaseExtractionError) {
                        log.warn(`[EventBase] Window ${wIdx}: extraction error (skipped) — ${err.message}`);
                        return { skipped: false, events: [], failed: true, failureDetail: err.message };
                    }
                    log.warn(`[EventBase] Window ${wIdx}: unexpected error (skipped) — ${err.message}`);
                    return { skipped: false, events: [], failed: true, failureDetail: err.message };
                }

                // Attach chat_uuid to each event
                const annotated = rawEvents.map(e => ({ ...e, chat_uuid: uuid }));

                // Filter by minimum importance
                const toStore = annotated.filter(e => e.importance >= minImportanceStore);
                if (toStore.length < annotated.length) {
                    log.verbose(`[EventBase] Window ${wIdx}: dropped ${annotated.length - toStore.length} event(s) below minImportance=${minImportanceStore}`);
                }

                return { skipped: false, events: toStore, sourceHashes, windowEnd: win.end };
            }),
        );

        const extractPhaseEndedAt = performance.now();
        log.verbose(`[EventBase concurrency] Batch extract phase complete: ${(extractPhaseEndedAt - batchStartedAt).toFixed(0)}ms wall (${windowsSlice.length} window(s))`);

        // Reduce per-window results into the {events, hashes, ends} packet the
        // finalizer needs to write. Same coalescing as the original loop.
        const allEvents = [];
        const hashesToMark = [];
        const endsExtracted = [];
        for (const r of batchResults) {
            if (r.status !== 'fulfilled' || r.value?.skipped) continue;
            const { events: winEvents, sourceHashes: winHashes, windowEnd } = r.value;
            if (!winHashes) continue; // extraction failed — do not mark
            if (winEvents?.length > 0) {
                allEvents.push(...winEvents);
            }
            hashesToMark.push(winHashes);
            if (typeof windowEnd === 'number') endsExtracted.push(windowEnd);
        }

        return {
            batchFirstIdx,
            batchLastIdx,
            batchResults,
            allEvents,
            hashesToMark,
            endsExtracted,
            batchStartedAt,
            extractPhaseEndedAt,
        };
    }

    /**
     * Wraps insertEvents with up to 3 attempts. Backoff between attempts is
     * short (500ms / 1000ms) — these retries exist for transient Qdrant
     * hiccups, not for sustained outages. On exhaustion, throws an
     * EventBaseFatalError tagged "insert_failed_max_retries" so the UI can
     * popup the underlying Qdrant message (which is what the user actually
     * needs to debug). Pre-flight abort check before each attempt avoids
     * pointless retries when the user already pressed Stop.
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
                // If we got here after a retry, signal recovery to the user so the
                // earlier toast ("retrying...") gets a closing parenthesis.
                if (attempt > 1) {
                    try { toastr.success(`Insert recovered on attempt ${attempt}/3`, 'VectFox', { timeOut: 4000 }); } catch (_) {}
                }
                return; // success
            } catch (err) {
                if (err?.name === 'AbortError' || abortSignal?.aborted) throw err;
                // Hedge-fatal bypass: the inner hedge already burned ~60s on 4 fresh-connection
                // attempts in parallel. Outer retry would just trigger another 60s of identical
                // hedging — same upstream, same routing pool, no new information. Throw up to
                // the coordinator so user can press Continue later when conditions improve.
                // See plans/embedding-resilience-hedge-and-diagnostics.md §6.5.
                if (err?.isHedgeFatal === true) throw err;
                lastErr = err;
                log.warn(`[EventBase] Insert batch starting at window ${batchFirstIdx} attempt ${attempt}/3 failed: ${err?.message || err}`);
                if (attempt < 3) {
                    // Backoff bumped from 500/1000ms to 5s/10s. The shorter delays
                    // were too aggressive for the common failure mode we hit in
                    // practice: Qdrant under transient load returning truncated
                    // JSON. 5-10s gives the server time to settle instead of
                    // pounding it again immediately. See Doc/log.txt 2026-05-30
                    // 01:18:34 incident — Similharity threw "Unexpected end of
                    // JSON input" which is a truncated-response symptom.
                    const backoffMs = attempt === 1 ? 5000 : 10000;
                    // Visibility: tell the user this is a retry, not a hang.
                    // Without this signal, retry attempts look identical to a
                    // stall and users press Stop unnecessarily (which throws
                    // away an in-flight retry that probably would have worked).
                    try {
                        toastr.warning(
                            `Insert failed (attempt ${attempt}/3), retrying in ${backoffMs/1000}s. Server said: ${(err?.message || '').slice(0, 120)}`,
                            'VectFox — retrying',
                            { timeOut: backoffMs + 500 },
                        );
                    } catch (_) {}
                    progressTracker.updateProgress(
                        nextBatchFirstIdx,
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
     * Per-batch finalizer — calls _insertWithRetry, then marks windows
     * extracted + bumps tip + updates progress, IN THAT ORDER. The order is
     * the "no corrupted state" invariant: we never mark a window as covered
     * before its events are durable in Qdrant.
     *
     * Returns a tally the coordinator merges into the run totals. Fatal
     * insert errors bubble (Promise.race in the coordinator surfaces them).
     */
    async function _finalizeBatch(extractResult) {
        const { batchFirstIdx, batchResults, allEvents, hashesToMark, endsExtracted, batchStartedAt, extractPhaseEndedAt } = extractResult;

        if (!abortSignal?.aborted && allEvents.length > 0) {
            await _insertWithRetry(allEvents, batchFirstIdx);
        }
        // Mark windows only after insert succeeded (or there was nothing to
        // insert — in which case we still mark zero-event windows so we don't
        // re-extract them next run). Same rule as the pre-pipeline loop.
        if (!abortSignal?.aborted) {
            for (const winHashes of hashesToMark) {
                markWindowExtracted(winHashes, uuid);
            }
            for (const end of endsExtracted) {
                setVectorizationTip(uuid, end + 1);
            }
        }

        const batchEndedAt = performance.now();
        const insertPhaseMs = batchEndedAt - extractPhaseEndedAt;
        const extractPhaseMs = extractPhaseEndedAt - batchStartedAt;
        log.lifecycle(`[EventBase concurrency] Batch DONE: total=${(batchEndedAt - batchStartedAt).toFixed(0)}ms (extract=${extractPhaseMs.toFixed(0)}ms parallel, insert=${insertPhaseMs.toFixed(0)}ms — 1 batched POST with ${allEvents.length} event(s))`);

        // Tally results, watch for fatal LLM errors (extract-side fatals
        // arrive as rejected promises in batchResults).
        const tally = { eventsAdded: 0, windowsProcessed: 0, windowsSkipped: 0, windowsTimedOut: 0, windowsFailed: 0, failureDetail: null, fatalError: null };
        for (const result of batchResults) {
            if (result.status === 'rejected') {
                const err = result.reason;
                if (err instanceof EventBaseFatalError) {
                    tally.fatalError = err;
                    return tally; // coordinator handles the fatal
                }
                log.warn('[EventBase] Batch window error:', err?.message || err);
                tally.windowsFailed++;
                tally.failureDetail ??= err?.message || String(err);
            } else {
                if (result.value?.skipped) {
                    tally.windowsSkipped++;
                } else if (result.value?.timedOut) {
                    // Counted separately — NOT as "processed" (it produced no events
                    // and wasn't marked extracted, so it retries next run).
                    tally.windowsTimedOut++;
                } else if (result.value?.failed) {
                    // Same reasoning as timedOut: no events, not marked extracted,
                    // so it must not inflate the processed count that the final
                    // success message reports.
                    tally.windowsFailed++;
                    tally.failureDetail ??= result.value.failureDetail || null;
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
     * inserts, not extracts.
     */
    function _updateProgressAfterFinalize(extractResult) {
        if (totalLegacyChunks > 0) {
            const advancedWindowIdx = extractResult.batchLastIdx + 1;
            const coveredMessages = Math.min(messages.length, (advancedWindowIdx * step) + windowOverlap);
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
            extractResult.batchLastIdx + 1,
            `${eventsExtracted} event(s) found, processing windows...`,
        );
    }

    // -----------------------------------------------------------------------
    // Coordinator — single-slot pipelined loop.
    // -----------------------------------------------------------------------
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
            return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed };
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
        //                                 inserts stack up. See 2026-05-30
        //                                 investigation in conversation logs.
        //   (c) !insertBarrier         — pipelined opt-out (serial mode)
        //                                 additionally blocks on in-flight
        //                                 insert. Used purely as a diagnostic
        //                                 fallback now that (b) is correct.
        // The first if (insert-start) above will consume queuedResult if it can.
        // So if queuedResult is still non-null here, it means insert IS in
        // flight — we MUST NOT start a new extract because there's nowhere to
        // put its result. Correct single-slot behavior: at most one extract
        // + one insert in flight + one queued result.
        const insertBarrier = disablePipeline && pendingInsert !== null;
        if (!pendingExtract && queuedResult === null && !insertBarrier && nextBatchFirstIdx < windows.length) {
            const slice = windows.slice(nextBatchFirstIdx, nextBatchFirstIdx + CONCURRENCY);
            const sliceFirstIdx = nextBatchFirstIdx;
            nextBatchFirstIdx += slice.length;
            pendingExtract = _runOneExtractBatch(slice, sliceFirstIdx);
            extractKey = pendingExtract.then(
                r => ({ kind: 'extract', result: r }),
                e => ({ kind: 'extract', error: e }),
            );
        }

        // Terminal state: nothing pending, nothing queued, no more windows.
        if (!pendingExtract && !pendingInsert) break;

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
                // _insertWithRetry threw — either max-retries fatal (already
                // an EventBaseFatalError) or an AbortError. Drain in-flight
                // extract before surfacing.
                if (pendingExtract) {
                    try { await pendingExtract; } catch (_) { /* swallow */ }
                }
                if (winner.error?.name === 'AbortError') {
                    progressTracker.complete(false, 'Stopped by user');
                    return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed };
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
            _updateProgressAfterFinalize(winner.extractResult);
        }
    }

    // End-of-run silent-loss check. The per-batch hash uniqueness assertion in
    // eventbase-store.js insertEvents() catches intra-batch collisions; this
    // catches CROSS-batch collisions or any other loss mechanism in the layers
    // beneath us (Similharity plugin silently dropping items, payload validation
    // rejecting fields, Qdrant accepting but not persisting, etc.).
    //
    // History: in May 2026 we discovered a 32-bit djb2 hash collision bug that
    // silently dropped ~40% of events from a 2382-message backfill. The plugin
    // logged "Inserted N", Qdrant returned 200, the events were just gone.
    // The hash was widened to 53 bits — but a "rare" silent-loss bug is worse
    // than a loud one, so we now actively verify what landed at the end of
    // every run.
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

    // A timed-out window is a real failure (the immediate toast already told the
    // user). Reflect it in the progress modal too rather than a misleading green
    // "success" — especially when timeouts swallowed the whole run (0 events).
    if (windowsTimedOut > 0) {
        progressTracker.complete(false,
            `EventBase: ${windowsTimedOut} window(s) timed out — ${eventsExtracted} event(s) extracted. See the timeout notice; raise "Extraction Timeout" or check your endpoint.`);
    } else if (windowsFailed > 0) {
        // A window that errored stored nothing and was never marked extracted, so
        // reporting the run green told the user "this chat has no events" when the
        // truth was "every request failed" (issue #14). Name the first reason —
        // these failures are near-always the same cause repeated.
        progressTracker.complete(false,
            `EventBase: ${windowsFailed} window(s) failed — ${eventsExtracted} event(s) extracted.`
            + (firstFailureDetail ? ` First error: ${firstFailureDetail}` : ' See the console for details.'));
    } else {
        progressTracker.complete(true, `EventBase: extracted ${eventsExtracted} event(s) from ${windowsProcessed} window(s)`);
    }

    log.lifecycle(`[EventBase] Ingestion complete: extracted=${eventsExtracted}, processed=${windowsProcessed}, skipped=${windowsSkipped}, timedOut=${windowsTimedOut}, failed=${windowsFailed}`);

    // Record the window size used for this successful run. Vectorize Content →
    // Continue compares against this on the next click to detect window-size
    // changes that would trigger a full re-extraction, and warns the user.
    // Stamp only when extraction actually ran — pure-skip runs don't reset it.
    if (uuid && windowsProcessed > 0) {
        const { setLastUsedWindowSize } = await import('./eventbase-store.js');
        setLastUsedWindowSize(uuid, windowSize);
    }

    // Notify the UI so the Chat Auto-Sync LED can flip from yellow → green.
    // Cheap signal; listeners just re-evaluate state, they don't read this payload.
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('vectfox:eventbase-synced', {
            detail: { collectionId, eventsExtracted, windowsProcessed }
        }));
    }

    return { eventsExtracted, windowsProcessed, windowsSkipped, windowsTimedOut, windowsFailed };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Scan the registry for archive event collections (VectFox_archiveevent_*) that are
 * enabled and locked to the current chat. These are included in Phase A retrieval.
 *
 * Uses direct enabled + lock checks (not shouldCollectionActivate) because archive
 * collections have no triggers/conditions and would be BLOCKED by the activation filter.
 *
 * @param {string} currentChatId
 * @returns {{ collectionId: string, registryKey: string }[]}
 */
function _gatherArchiveEventCollections(currentChatId) {
    if (!currentChatId) return [];
    const registry = getCollectionRegistry();
    const results = [];
    for (const registryKey of registry) {
        const parsed = parseRegistryKey(registryKey);
        const colId = parsed.collectionId;
        if (!colId?.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT)) continue;

        // Pause and lock metadata can live under either the registry key (backend:collectionId)
        // or the bare collectionId — the DB Browser pause toggle uses registry key while the
        // "Active for current chat" checkbox uses bare collectionId. Check both for safety.
        const candidateKeys = [registryKey, colId].filter(Boolean);

        const pausedKey = candidateKeys.find(key => !isCollectionEnabled(key));
        if (pausedKey) {
            log.trace(`[EventBase] Archive event collection skipped (paused: "${pausedKey}")`);
            continue;
        }

        const isLocked = isCollectionActiveForContextAnyKey(candidateKeys, { chatId: currentChatId });
        if (!isLocked) {
            log.trace(`[EventBase] Archive event collection skipped (not locked to chat): ${colId}`);
            continue;
        }

        results.push({ collectionId: colId, registryKey });
    }
    return results;
}

/**
 * Scan the registry for live EventBase collections (VectFox_eventbase_*) that
 * are enabled and locked to the current chat.
 *
 * The chat UUID embedded in the ID is only used for write-side collision
 * avoidance. For reads, the lock is the activation gate — a user can lock
 * another chat's EventBase to the current chat to share its data (e.g. after
 * branching/duplicating a chat).
 *
 * @param {string} currentChatId
 * @returns {{ collectionId: string, registryKey: string }[]}
 */
function _gatherLockedEventBaseCollections(currentChatId) {
    if (!currentChatId) return [];
    const registry = getCollectionRegistry();
    const results = [];
    const seenIds = new Set();
    for (const registryKey of registry) {
        const parsed = parseRegistryKey(registryKey);
        const colId = parsed.collectionId;
        if (!colId?.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) continue;
        if (seenIds.has(colId)) continue;

        const candidateKeys = [registryKey, colId].filter(Boolean);

        const pausedKey = candidateKeys.find(key => !isCollectionEnabled(key));
        if (pausedKey) {
            log.trace(`[EventBase] Live collection skipped (paused: "${pausedKey}")`);
            continue;
        }

        const isLocked = isCollectionActiveForContextAnyKey(candidateKeys, { chatId: currentChatId });
        if (!isLocked) {
            log.trace(`[EventBase] Live collection skipped (not locked to chat): ${colId}`);
            continue;
        }

        seenIds.add(colId);
        results.push({ collectionId: colId, registryKey });
    }
    return results;
}

/**
 * Run the EventBase retrieval pipeline and inject the result into the prompt.
 *
 * @param {object} params
 * @param {object[]} params.chat       - Full ST chat array
 * @param {string}   params.searchText - Query text (from buildSearchQuery)
 * @param {object}   params.settings   - VectFox settings
 * @param {string}  [params.chatUUID]  - Override chat UUID
 * @returns {Promise<void>}
 */
export async function runEventBaseRetrieval({ chat, searchText, settings, chatUUID, dryRun = false, testMessage = null }) {
    const uuid = chatUUID || getChatUUID();
    const currentChatId = getCurrentChatId();

    // --- Gather all live EventBase collections locked to the current chat ---
    // The lock — not the chat UUID — is the activation gate. The UUID embedded
    // in the collection ID exists for write-side collision avoidance, not for
    // read-time activation. A user can lock any EventBase collection to the
    // current chat (e.g. after branching) and we should query it.
    const lockedLiveCollections = _gatherLockedEventBaseCollections(currentChatId);
    const queryEventbase = lockedLiveCollections.length > 0;

    log.lifecycle(`[EventBase] Live retrieval: uuid=${uuid}, lockedLiveCollections=${lockedLiveCollections.length}, ids=${JSON.stringify(lockedLiveCollections.map(c => c.collectionId))}`);

    // --- Find archive event collections locked to this chat ---
    const archiveCollections = _gatherArchiveEventCollections(currentChatId);

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
    // Archive events are stored with the same schema as live EventBase events so we
    // query them via queryCollection directly and attach _hash (same as queryEvents does).
    const topK = (settings.eventbase_retrieval_top_k || 8) * 2;
    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
    const archiveEventPromises = archiveCollections.map(async ({ registryKey: archKey, collectionId: archColId }) => {
        try {
            // Canonical routing (Doc/collection_helper.md): pass registry-key
            // form so queryCollection routes per-collection-backend. Previously
            // passed the bare `archColId` which silently sent every archive
            // query through settings.vector_backend.
            const { hashes, metadata } = await queryCollection(archKey, effectiveSearchText, topK, ebSettings);
            if (!hashes?.length) return [];
            // _sortFrame tags each archive event with its source collection so the
            // injector groups by conversation before the chronological sort
            // (source_window_end is only comparable within one conversation).
            return metadata.map((meta, i) => ({ ...meta, _hash: hashes[i], _sortFrame: archColId }));
        } catch (err) {
            log.error(`[EventBase] Archive event collection query failed (${archColId}):`, err);
            return [];
        }
    });

    const archiveResults = await Promise.all(archiveEventPromises);
    const additionalCandidates = archiveResults.flat();

    if (additionalCandidates.length > 0) {
        log.verbose(`[EventBase] Queried ${archiveCollections.length} archive event collection(s) → ${additionalCandidates.length} event(s)`);
    }

    // Cross-chat lock: collection UUID embedded in the ID differs from the current chat UUID.
    // When locked cross-chat, source_window_end values belong to a different conversation and
    // cannot be compared to the current chat length — skip the context-dedup step entirely.
    const isCrossChat = lockedLiveCollections.some(c => !c.collectionId.includes(uuid));

    // When `agentic_retrieval_enabled` is true and backend is Qdrant, route through
    // retrieveEventsWithAgent — it runs the pre-search itself, calls the planner,
    // fans out parallel queries, and re-feeds everything through retrieveEvents'
    // canonical re-ranker. Otherwise it returns the pre-search output unchanged,
    // making it a safe drop-in replacement.
    const retrieveFn = settings.agentic_retrieval_enabled ? retrieveEventsWithAgent : retrieveEvents;
    const { events, debug } = await retrieveFn({
        searchText: effectiveSearchText,
        keywordQuery,
        chatLength: getContext().chat?.length || chat?.length || 0,
        settings,
        // Canonical routing (Doc/collection_helper.md): pass registry-key form
        // ("backend:id") so queryCollection's resolveBackendForCollection picks the right
        // backend per-collection. Previously passing the bare collectionId
        // here silently routed EVERY locked collection through
        // settings.vector_backend, breaking mixed-backend users (e.g. a
        // standard EventBase locked + a qdrant EventBase locked at the same
        // time would both query whichever backend was the default).
        liveCollectionIds: lockedLiveCollections.map(c => c.registryKey),
        additionalCandidates,
        skipLiveQuery: !queryEventbase,
        skipContextDedup: isCrossChat,
    });

    log.trace('[EventBase] Retrieval debug:', debug);

    if (!events?.length) {
        log.lifecycle('[EventBase] No events to inject');
        log.verbose(`[EventBase Popup] no-events branch gate: retrieval_popup_on_result=${settings.retrieval_popup_on_result} → fire=${!!settings.retrieval_popup_on_result}`);
        if (settings.retrieval_popup_on_result) {
            const rawCount = debug?.rawCount ?? 0;
            const msg = rawCount > 0
                ? `EventBase: ${rawCount} event(s) already in context`
                : 'EventBase: no events matched';
            toastr.info(msg, 'VectFox Retrieval');
        }
        if (dryRun) return { injectionText: null, eventCount: 0, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    const injectionResult = formatEventsForInjectionDetailed(events, settings);
    let injectionText = injectionResult.text;
    const injectedCount = injectionResult.includedCount;
    if (!injectionText) {
        log.verbose('[EventBase] Injection text empty after formatting');
        if (dryRun) return { injectionText: null, eventCount: 0, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    log.verbose(`[EventBase Popup] success gate: retrieval_popup_on_result=${settings.retrieval_popup_on_result}, dryRun=${dryRun}, injectedCount=${injectedCount} → fire=${!!settings.retrieval_popup_on_result}`);
    if (settings.retrieval_popup_on_result) {
        toastr.success(`EventBase: ${injectedCount} event(s) injected`, 'VectFox Retrieval');
    }

    // Apply global RAG context if configured (same as legacy chunk path)
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    if (globalContext) {
        injectionText = `${globalContext}\n\n${injectionText}`;
    }

    // Wrap with XML tag if configured (same as legacy path)
    const xmlTag = settings.rag_xml_tag || '';
    if (xmlTag) {
        injectionText = `<${xmlTag}>\n${injectionText}\n</${xmlTag}>`;
    }

    // Dry-run: return text without touching the extension prompt slot
    if (dryRun) {
        return { injectionText, eventCount: injectedCount, lockedCollectionsCount: lockedLiveCollections.length, archiveCollectionsCount: archiveCollections.length };
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
 * Minimal djb2 hash (matches eventbase-extractor.js — kept local to avoid circular dep).
 * @param {string} str
 * @returns {number}
 */
function _djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}

/**
 * Returns true if every complete window of the given messages has already been
 * extracted for this chat. Uses the same hash + window parameters as the main
 * ingestion loop so the result is authoritative.
 *
 * Returns false when messages.length < windowSize (nothing extractable yet).
 *
 * @param {object[]} messages  - Filtered chat messages (non-empty)
 * @param {object}   settings  - VectFox settings
 * @param {string}   chatUUID  - Current chat UUID
 * @returns {boolean}
 */
export function isChatFullyVectorized(messages, settings, chatUUID, windowSizeOverride = undefined, windowOverlapOverride = undefined) {
    const windowSize = windowSizeOverride != null
        ? Math.max(2, windowSizeOverride)
        : Math.max(2, settings.eventbase_window_size || 6);
    const windowOverlap = windowOverlapOverride != null
        ? Math.max(0, Math.min(windowSize - 1, windowOverlapOverride))
        : Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 0));
    const step = windowSize - windowOverlap;
    const msgHash = m => { const t = (m.mes || '').trim(); return m.hash ?? _djb2(`${m.name || ''}:${t}`); };
    return isLastWindowExtracted(messages, windowSize, step, chatUUID, msgHash);
}

/**
 * In-memory evaluation of chat auto-sync state for the current chat.
 * No backend probes — uses the registry, the eventbase window cache, and
 * extension_settings only. Used by the Chat Auto-Sync checkbox + LED.
 *
 * Returns one of:
 *   { state: 'no-chat' }                                              — no chat is open
 *   { state: 'no-collection' }                                        — chat has no eventbase collection yet
 *   { state: 'vectorization-ahead', collectionId, registryKey,
 *     chatMessageCount, markerValue }                                  — collection exists, but its auto-sync marker
 *                                                                       is past the current chat tail (user bound a
 *                                                                       collection vectorized on a longer chat, or
 *                                                                       deleted messages after vectorizing). NOTHING
 *                                                                       should sync — we wait for chat to catch up.
 *   { state: 'partial',          collectionId, registryKey,
 *     chatMessageCount, markerValue? }                                 — collection exists, last window not extracted;
 *                                                                       counts let the UI show the backfill gap
 *   { state: 'fully-vectorized', collectionId, registryKey,
 *     chatMessageCount, markerValue? }                                 — collection exists, last window already extracted
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {object}
 */
export async function getChatAutoSyncStatus(settings) {
    const chatId = getCurrentChatId();
    if (!chatId) return { state: 'no-chat' };

    const uuid = getChatUUID();
    if (!uuid) return { state: 'no-chat' };

    // Resolve THE active EventBase collection for this chat — ownership-filtered
    // and lock-aware (matches the DB Browser's "Active here only" and the
    // auto-sync write target). See resolveActiveEventBaseCollection.
    const match = resolveActiveEventBaseCollection(settings, uuid);

    if (!match) return { state: 'no-collection' };

    const ctx = getContext();
    const messages = Array.isArray(ctx?.chat)
        ? ctx.chat.filter(m => m.mes && m.mes.trim().length > 0)
        : [];
    const chatMessageCount = messages.length;

    // Read the auto-sync marker (per-chat message-index threshold). When this
    // is past the chat tail, the marker filter in runEventBaseIngestion will
    // reject every window — extraction is effectively frozen until the chat
    // catches up. Surface that as a distinct UI state so the user understands
    // why "auto-sync enabled" produces no work (they probably bound a chat
    // vectorization that ran on a longer version of this chat).
    //
    // The marker may be undefined when auto-sync was never enabled — in that
    // case we don't have enough info to detect the ahead-of-chat condition,
    // so fall through to the existing partial / fully-vectorized branch.
    const markerValue = extension_settings?.vectfox?.eventbase_autosync_start_marker?.[uuid];
    if (typeof markerValue === 'number' && markerValue > chatMessageCount) {
        return {
            state: 'vectorization-ahead',
            collectionId: match.collectionId,
            registryKey: match.registryKey,
            chatMessageCount,
            markerValue,
        };
    }

    // Evaluate auto-sync "fully vectorized" against the AUTO-SYNC window (turns*2,
    // overlap 0), not the one-off Vectorize Content window — otherwise the LED
    // would read "partial" forever whenever the two window sizes differ.
    //
    // Settle/commit lag: evaluate against the COMMITTED slice (chat minus the
    // active, still-swipeable last turn), matching what runEventBaseIngestion
    // actually extracts. Without this, the deliberately-unextracted active turn
    // would pin the LED on "partial" forever. After a manual full vectorize the
    // committed slice's last window is also extracted, so the LED is still green —
    // both modes stay consistent. See plans/autosync-settle-lag.md.
    const commitBoundary = getCommitBoundary(messages, settings);
    const committedMessages = commitBoundary < messages.length ? messages.slice(0, commitBoundary) : messages;
    const fullyVectorized = isChatFullyVectorized(committedMessages, settings, uuid, getAutoSyncWindowSize(settings), 0);

    // Cache-first read; one-time probe on cold cache populates from Qdrant.
    // After first session-warmup, the ingestion loop keeps this up-to-date
    // via setVectorizationTip after each window. See eventbase-store.js for
    // the cache lifecycle docs.
    const vectorizationTip = await ensureVectorizationTip(uuid, match.collectionId, settings);

    return {
        state: fullyVectorized ? 'fully-vectorized' : 'partial',
        collectionId: match.collectionId,
        registryKey: match.registryKey,
        chatMessageCount,
        commitBoundary,
        markerValue: typeof markerValue === 'number' ? markerValue : undefined,
        vectorizationTip: typeof vectorizationTip === 'number' ? vectorizationTip : undefined,
    };
}
