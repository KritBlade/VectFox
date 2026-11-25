/**
 * ============================================================================
 * SUMMARIZER INJECTION (Feature B)
 * ============================================================================
 * Injects the most recent N EventBase events into the prompt every turn,
 * independent of the semantic-retrieval injection. Sorted by source_window_end
 * descending, sliced to N, rendered chronologically, and wrapped in
 * <VectFoxSummarizer> tags. Provides "word-for-word-ish" memory of the last few
 * turns to complement (not replace) semantic retrieval.
 *
 * Only meaningful when auto-sync is active (otherwise the EventBase collection
 * goes stale and "recent N" injects old data) — hence it lives on the AutoSync
 * tab and forces the auto-sync window to 1 turn while enabled.
 *
 * Uses its OWN extension-prompt tag so it stacks cleanly with the semantic
 * EventBase injection (`*_eventbase`) instead of clobbering it.
 *
 * It and ghosting read the chat's collection in use, from the one route every reader
 * asks (collectionInUse); with none in use, or the one in use paused, they read nothing
 * (D18 of vectfox-multi-collection-per-chat.md).
 * ============================================================================
 */

import { setExtensionPrompt } from '../../sillytavern/prompt-injection.js';
import { getContext } from '../../sillytavern/chat.js';
import { getWorldInfoSettings, getSortedEntries } from '../../sillytavern/world-info.js';
import { chatMessages, openChatStoryOrder } from '../../shared/chat-messages.js';
import { getBackend, UNBOUNDED_RUN } from '../vector-backend/index.js';
import { NOT_IN_USE_REASON, collectionInUse, noCollectionInUseText } from './eventbase-chat-collections.js';
import { getVectorizationTip } from './eventbase-store.js';
import { SUMMARIZER_PROMPT_TAG } from '../../shared/constants.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { log } from '../../sillytavern/log.js';

/**
 * Resolve recent events, format them, and inject (or clear) the summarizer slot.
 * Self-clears when disabled / no chat / no collection / no events, so calling it
 * unconditionally every turn is safe and keeps stale injections from lingering.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {object|null} [inUse] - The chat's collection in use (collectionInUse), as the reply step resolved it
 * @param {{isCurrent: () => boolean}} [boundedRun] - The reply step's bounded run (runBoundedRetrieval): a build that
 *   settles once its bound has passed leaves the slot as the reply step emptied it, as the reply went without it
 * @returns {Promise<{ injected: number, error?: string }>}
 */
export async function runSummarizerInjection(settings, inUse = null, boundedRun = UNBOUNDED_RUN) {
    const clear = () => setExtensionPrompt(SUMMARIZER_PROMPT_TAG, '', settings.position, settings.depth, false);

    if (!settings?.summarizer_injection_enabled) { clear(); return { injected: 0 }; }

    const { text, count } = await buildSummarizerInjection(settings, inUse);
    if (!boundedRun.isCurrent()) {
        log.lifecycle(`[Summarizer] The injection settled past its bound with ${count} event(s): the reply went without them, so nothing is injected`);
        return { injected: 0 };
    }
    setExtensionPrompt(SUMMARIZER_PROMPT_TAG, text, settings.position, settings.depth, false);
    if (count > 0) log.domain('injection', 'trace', `[Summarizer] Injected ${count} event(s) under ${SUMMARIZER_PROMPT_TAG}`);
    return { injected: count };
}

// Deepest per-entry WI `scanDepth` across the active world books. Entries can override the
// global scan window with a deeper fixed depth, so the keep-raw floor must cover them too.
// Computed OFF the hot path (getSortedEntries loads lore = async) and refreshed on WI/chat
// changes via refreshWorldInfoEntryDepthCache(); read synchronously by worldInfoScanFloor.
let _maxEntryScanDepth = 0;

/**
 * Recompute _maxEntryScanDepth from the active world books. Async (loads lore) — wire it to
 * CHAT_CHANGED / WORLDINFO_UPDATED / WORLDINFO_SETTINGS_UPDATED, NOT to per-generation code.
 * Does nothing while VectFox is disabled (ghosting is off, so nothing reads the value); the
 * master switch calls it again when VectFox is turned back on.
 * On failure it logs a warning and keeps the previous cached value. Disabled entries are
 * ignored (ST skips them during the scan), matching ST's own behavior.
 *
 * @param {object} [settings] - extension_settings.vectfox (defaults to the live store)
 */
export async function refreshWorldInfoEntryDepthCache(settings) {
    if (!isVectFoxEnabled(settings)) return;
    try {
        const entries = await getSortedEntries();
        let max = 0;
        for (const e of entries) {
            if (!e || e.disable) continue;           // ST skips disabled entries when scanning
            const d = Number(e.scanDepth);           // null/undefined = use global depth (skip)
            if (Number.isFinite(d) && d > max) max = d;
        }
        _maxEntryScanDepth = max;
    } catch (error) {
        log.warn('[Ghost] World Info scan-depth refresh failed — keeping the previous value:', error);
    }
}

/**
 * How many of the most-recent messages World Info will scan — i.e. how many MUST stay raw
 * for keyword triggers to keep firing. Ghosting takes messages out of `coreChat` BEFORE ST
 * scans WI from that same array, so any message WI would look at must stay.
 *
 *   - Base = global `world_info_depth` (the standard scan window, default 2).
 *   - Per-entry `scanDepth` overrides: an entry can scan deeper than the global window, so we
 *     fold in the cached deepest override (_maxEntryScanDepth, refreshed on WI/chat changes).
 *   - If `min_activations` is on, the scan advances deeper until the minimum is met, capped
 *     by `min_activations_depth_max` — or by the END OF CHAT when that cap is 0. So an
 *     uncapped min-activations scan can reach the whole chat → return Infinity, which makes
 *     ghosting back off entirely (take nothing out) rather than risk breaking WI.
 *
 * @returns {number} message count that must remain raw for WI (may be Infinity)
 */
function worldInfoScanFloor() {
    try {
        const wi = getWorldInfoSettings();
        let floor = Math.max(0, Number(wi.world_info_depth) || 0, _maxEntryScanDepth || 0);
        if ((Number(wi.world_info_min_activations) || 0) > 0) {
            const cap = Number(wi.world_info_min_activations_depth_max) || 0;
            floor = cap > 0 ? Math.max(floor, cap) : Number.POSITIVE_INFINITY; // 0 cap = whole chat
        }
        return floor;
    } catch (error) {
        // WI settings unavailable — still honor the cached per-entry depth.
        log.warn('[Ghost] World Info settings unavailable — keeping only the cached entry scan depth raw:', error);
        return _maxEntryScanDepth || 0;
    }
}

/**
 * How many of the chat's messages, from its first, are in memory for ghosting: each up to the last one whose places in
 * story order all lie below the tip. A message with no text takes no place, so it counts only below one that is in
 * memory. A summary whose originals all lie below the tip is in memory too, and ghosting keeps it (applyGhosting).
 * @param {Array<{isSummary: boolean, start: number, end: number}>} places - Each chat message's places in story order
 *   (openChatStoryOrder)
 * @param {number} tip - The story's messages EventBase has read, from its first
 * @returns {number}
 */
function chatMessagesInMemory(places, tip) {
    let count = 0;
    for (const [index, place] of places.entries()) {
        if (place.end > tip) break;
        if (place.end > place.start) count = index + 1;
    }
    return count;
}

/**
 * The chat message each message of the prompt copies, as its index in the chat, or -1 for one that copies none.
 * SillyTavern builds the prompt from the chat less its hidden messages, keeping a hidden one with tool calls while tool
 * calling is on, and numbers each copy by its place in that list (`index`). The interceptors that run before VectFox's
 * may take copies out or add their own, as Vector Storage and other memory extensions do, so a copy is found by its
 * number, never by its place in the prompt. A copy whose sender, name or date differ from the message its number points
 * to copies none.
 * @param {object[]} prompt - The interceptor's chat array (coreChat)
 * @param {object[]} chat - The chat as SillyTavern holds it (chatMessages)
 * @param {boolean} isToolCallingOn - Whether SillyTavern keeps a hidden message with tool calls in the prompt
 * @returns {number[]}
 */
function chatIndicesOfPrompt(prompt, chat, isToolCallingOn) {
    const promptSources = [];
    for (const [index, message] of chat.entries()) {
        if (!message.is_system || (isToolCallingOn && Array.isArray(message.extra?.tool_invocations))) promptSources.push(index);
    }
    return prompt.map((copy) => {
        const chatIndex = Number.isInteger(copy?.index) ? promptSources[copy.index] : undefined;
        const message = chatIndex === undefined ? undefined : chat[chatIndex];
        const isCopy = message !== undefined && copy.is_user === message.is_user && copy.name === message.name
            && copy.send_date === message.send_date;
        return isCopy ? chatIndex : -1;
    });
}

/**
 * Ephemeral "ghosting": keep the most recent N messages verbatim and take ALL older
 * already-vectorized messages out of the OUTGOING prompt only. The chat array we get is
 * ST's interceptor working copy, so the saved chat + UI never change and the whole effect
 * resets on the next generation (nothing to un-ghost, branch-safe).
 *
 * Boundary `cutoff`: `rollingCutoff = min(inMemoryInPrompt, chat.length - keepFloor)`,
 * snapped DOWN to a multiple of the batch size (`eventbase_ghost_batch_size`):
 *   - `inMemoryInPrompt` — the prompt's messages, from its first, that copy a chat message in
 *     memory: the vectorization tip counts the story's messages in story order, mapped back to
 *     the chat's messages (chatMessagesInMemory), and each prompt message to the chat message it
 *     copies (chatIndicesOfPrompt). Nothing above the tip (not yet vectorized) is ever taken out.
 *   - `chat.length - keepFloor` — keeps the last `keepRecent` messages raw, with a hard
 *     floor of 1 so the current outgoing turn is NEVER taken out (even at keepRecent=0).
 *   - the snap — at a batch size above 1 the boundary moves only once a whole batch can
 *     go, so the prompt's opening stays byte-identical between moves and a provider's
 *     prompt cache can reuse it. The raw window then spans keepFloor to keepFloor +
 *     batch size - 1 messages. Snapping down only takes out fewer, so both bounds above hold.
 * The messages before the boundary are taken out, all but two kinds, which stay where they are: a summary a message
 * source answers for (D6 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md), and a message that copies none of the
 * chat's, as another extension's interceptor adds. "Keep last N" auto-scales to any chat length.
 *
 * Taken out, not flagged: a message taken out of the array leaves no empty turn, which some chat-completion APIs
 * reject, and SillyTavern builds the prompt from whatever the interceptors leave, as Vector Storage takes messages out
 * of the same array. SillyTavern's ignore flag would not do: Chat Completion's message list (setOpenAIMessages) leaves
 * a hole for a flagged message after a sent one, so flagged messages must run from the first, and a summary that stays
 * would end the run.
 *
 * Gated to Summarizer Injection (forces auto-sync window=1 → the tip stays current). A tip past the story's end, as
 * after messages are deleted, or a summary no message source answers for replaces some, takes nothing out.
 *
 * World Info safety: ST scans WI from this same chat array AFTER us, so the boundary is floored
 * to keep WI's full scan window raw (see worldInfoScanFloor) — keyword triggers keep firing
 * at any slider value, and ghosting auto-pauses if WI could scan the whole chat.
 *
 * @param {Array} chat - ST interceptor chat array (coreChat; the messages taken out are spliced from it)
 * @param {object} settings - extension_settings.vectfox
 * @param {object|null} [inUse] - The chat's collection in use (collectionInUse), as the reply step resolved it
 * @returns {{ takenOutCount: number, charsRemoved: number }}
 */
export function applyGhosting(chat, settings, inUse = null) {
    if (!settings?.eventbase_ghost_enabled || !settings?.summarizer_injection_enabled) {
        return { takenOutCount: 0, charsRemoved: 0 };
    }
    let takenOutCount = 0;
    let charsRemoved = 0;
    // The batch readout: set only on a turn that ghosts at a batch size above 1, null otherwise.
    let keptVerbatimCount = null;
    let messagesUntilNextBatch = null;

    const keepRecent = Math.max(0, Math.floor(Number(settings.eventbase_ghost_keep_recent) || 0));
    // A missing or unreadable batch size moves the boundary every turn, as 1 does.
    const batchSize = Math.max(1, Math.floor(Number(settings.eventbase_ghost_batch_size) || 1));
    // tip = the tip of the chat's collection in use, unless it is paused, as no reply then reads its events. A
    // collection of another chat locked in here counts that chat's messages, so it never sets the tip.
    const { collection } = inUse ?? collectionInUse(settings);
    const ownCollection = collection && !collection.isPaused ? collection : null;
    const tip = ownCollection ? getVectorizationTip(ownCollection.registryKey) : undefined;
    // The tip counts the story's messages in story order (storyMessages), so it is mapped back to the chat below.
    const storyOrder = typeof tip === 'number' ? openChatStoryOrder() : null;
    const storyLength = storyOrder?.messages.length ?? 0;
    // A tip past the story's end was read on a longer chat (messages deleted, or a summary no message source answers
    // for replacing some), so it cannot say which messages here are in memory: nothing is taken out until the chat
    // passes it again.
    const isTipPastChatEnd = typeof tip === 'number' && tip > storyLength;
    if (isTipPastChatEnd) {
        log.domain('injection', 'verbose', `[Ghost] Taking nothing out: the tip (${tip}) is past the chat's ${storyLength} messages in story order`);
    }

    if (!isTipPastChatEnd && Array.isArray(chat) && chat.length > 0 && typeof tip === 'number' && tip > 0) {
        const inMemoryCount = chatMessagesInMemory(storyOrder.places, tip);
        const chatIndices = chatIndicesOfPrompt(chat, chatMessages(), getContext()?.isToolCallingSupported?.() === true);
        const uncopiedCount = chatIndices.filter(chatIndex => chatIndex < 0).length;
        if (uncopiedCount > 0) {
            log.domain('injection', 'verbose', `[Ghost] ${uncopiedCount} prompt message(s) copy no chat message, so they stay`);
        }
        // The prompt's messages in memory, from its first; one that copies no chat message is passed, and stays.
        let inMemoryInPrompt = 0;
        while (inMemoryInPrompt < chat.length && chatIndices[inMemoryInPrompt] < inMemoryCount) inMemoryInPrompt++;

        // keepFloor = how many recent messages stay raw no matter the slider:
        //   - >= 1      → never take out the current outgoing turn (prompt is never left empty).
        //   - >= WI reach → never take out a message World Info will scan, so ghosting can't
        //                   break keyword triggers at ANY slider value. If WI may scan the
        //                   whole chat (uncapped min-activations), the floor is Infinity →
        //                   cutoff clamps to 0 → ghosting takes nothing out this turn.
        const keepFloor = Math.max(keepRecent, 1, worldInfoScanFloor());
        const rollingCutoff = Math.max(0, Math.min(inMemoryInPrompt, chat.length - keepFloor));
        // Snap down to the batch grid; at batch size 1 the boundary stays where it is.
        const cutoff = Math.floor(rollingCutoff / batchSize) * batchSize;
        // No readout while World Info could scan the whole chat: ghosting is paused, so no batch is coming.
        if (batchSize > 1 && Number.isFinite(keepFloor)) {
            keptVerbatimCount = chat.length - cutoff;
            messagesUntilNextBatch = cutoff + batchSize - rollingCutoff;
        }

        // Before the boundary every message in memory goes, empty ones and hidden ones with tool calls too, but for a
        // summary and a message that copies none of the chat's, which stay where they are.
        const staying = [];
        for (let index = 0; index < cutoff; index++) {
            const chatIndex = chatIndices[index];
            if (chatIndex < 0 || storyOrder.places[chatIndex].isSummary) {
                staying.push(chat[index]);
                continue;
            }
            // Only messages with text count for the readout: an empty one saves nothing.
            const text = chat[index].mes;
            if (typeof text === 'string' && text.trim()) {
                charsRemoved += text.length;
                takenOutCount++;
            }
        }
        chat.splice(0, cutoff, ...staying);
    }

    // Always publish the latest outcome while the feature is enabled — so the on-screen
    // readout reflects "0 saved this turn" (e.g. tip hasn't advanced yet) instead of a
    // stale value from an earlier generation.
    const approxTokens = Math.round(charsRemoved / 4); // rough 4-chars/token heuristic
    window.VectFox_LastGhost = { takenOutCount, charsRemoved, approxTokens, at: Date.now(), batchSize, keptVerbatimCount, messagesUntilNextBatch };
    if (takenOutCount > 0) {
        const batchNote = keptVerbatimCount === null
            ? ''
            : `; batches of ${batchSize}: ${keptVerbatimCount} message(s) kept verbatim, ${messagesUntilNextBatch} message(s) until the next batch`;
        log.domain('injection', 'lifecycle', `[Ghost] Took ${takenOutCount} vectorized message(s) out of the prompt — ~${charsRemoved} chars (~${approxTokens} tokens) saved${batchNote}`);
    }
    return { takenOutCount, charsRemoved };
}

/**
 * Compute the would-be summarizer injection content WITHOUT injecting it. This is
 * the exact path runSummarizerInjection uses (resolve → listChunks → filter → sort
 * → slice → format) minus the `setExtensionPrompt` and the `enabled` gate, so the
 * Action page's Summarizer preview shows the real result even while the feature is off.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {object|null} [inUse] - The chat's collection in use (collectionInUse), as the reply step resolved it
 * @returns {Promise<{ text: string, count: number, reason?: string, problem?: string, collectionId?: string, requested?: number, error?: string }>}
 *   `reason` is set on a 0-count outcome (disabled handled by the caller): `no-chat`, a reason collectionInUse gives
 *   (`no-collection`, `none-in-use`, `several-in-use`, `other-backend`, the last three with `problem` saying why),
 *   `paused`, or a read that failed.
 */
export async function buildSummarizerInjection(settings, inUse = null) {
    const n = Math.max(1, Math.min(50, settings.summarizer_injection_count ?? 15));
    // The chat's collection in use, from the one route the auto-sync marker and status read too.
    const route = inUse ?? collectionInUse(settings);
    if (route.reason === NOT_IN_USE_REASON.NO_CHAT) return { text: '', count: 0, reason: 'no-chat', requested: n };
    const active = route.collection;
    if (!active) {
        const problem = noCollectionInUseText(route, 'Summarizer Injection reads nothing') ?? undefined;
        return { text: '', count: 0, reason: route.reason, problem, requested: n };
    }
    if (active.isPaused) return { text: '', count: 0, reason: 'paused', collectionId: active.collectionId, requested: n };

    let backendInstance;
    try {
        backendInstance = await getBackend(settings);
    } catch (err) {
        log.warn('[Summarizer] Backend init failed:', err?.message || err);
        return { text: '', count: 0, reason: 'backend-error', error: err?.message, collectionId: active.collectionId, requested: n };
    }

    let items = [];
    try {
        // Fetch the WHOLE collection, then sort client-side for the true most-recent N.
        // listChunks applies its limit at the Qdrant-scroll level (point-ID order, i.e.
        // random vs recency) BEFORE the plugin sorts the page by index — so any limit
        // SMALLER than the collection returns an arbitrary sample and "sort + top-N"
        // misses recent events (the database browser sidesteps this by fetching with
        // NO limit, see src/features/database-browser/database-browser.js doLoad(null)). 50000 is a ceiling that
        // never truncates a realistic per-chat EventBase collection (O(hundreds–low
        // thousands)). Cost scales with ACTUAL collection size, not this ceiling.
        // Without the Similharity plugin the Standard backend returns hashes only
        // (metadata: {}) → filter yields 0, which is why the UI hides this on
        // standard+no-plugin.
        const result = await backendInstance.listChunks(active.collectionId, settings, { limit: 50000 });
        items = Array.isArray(result?.items) ? result.items : [];
    } catch (err) {
        log.warn('[Summarizer] listChunks failed:', err?.message || err);
        return { text: '', count: 0, reason: 'listchunks-error', error: err?.message, collectionId: active.collectionId, requested: n };
    }

    const events = items
        .filter(it => it?.metadata?.eventbase === true)
        .sort((a, b) => (b.metadata.source_window_end ?? 0) - (a.metadata.source_window_end ?? 0))
        .slice(0, n);

    if (!events.length) return { text: '', count: 0, reason: 'no-events', collectionId: active.collectionId, requested: n };

    const fullDetail = settings.summarizer_injection_full_detail !== false; // default on
    const maxChars = Number.isFinite(settings.summarizer_injection_max_chars) ? settings.summarizer_injection_max_chars : 10000;
    const { text, count } = _format(events, fullDetail, maxChars);
    if (count < events.length) {
        log.domain('injection', 'trace', `[Summarizer] Char budget (${maxChars}) trimmed ${events.length - count} oldest of ${events.length} events`);
    }
    return { text, count, collectionId: active.collectionId, requested: n };
}

/**
 * Render events oldest→newest inside <VectFoxSummarizer> tags, one summary per
 * line, each tagged with its recency so the model knows how far back it is:
 * the most recent extracted turn is "(latest turn)", older ones "(N turns ago)".
 * When `fullDetail` is on, each event's structured fields are listed (indented)
 * beneath its summary — only the fields that actually have content.
 * @param {Array<{text?: string, metadata?: object}>} events - newest-first (sorted desc)
 * @param {boolean} [fullDetail=false]
 * @returns {string}
 */
function _format(events, fullDetail = false, maxChars = 0) {
    // Recency rank by DISTINCT source_window_end (events is newest-first). A turn /
    // window can yield multiple events (Max Events per Window), all sharing one
    // source_window_end — they must share one label ("latest turn"), not be split
    // into "latest", "2 turns ago", … by array position.
    const rankByEvent = new Map();
    let rank = 0;
    let prevSwe;
    for (const evt of events) { // newest-first
        const swe = evt.metadata?.source_window_end;
        if (rank === 0 || swe !== prevSwe) { rank++; prevSwe = swe; }
        rankByEvent.set(evt, rank);
    }

    // Build per-event blocks newest-first so the character budget keeps the MOST
    // recent events and drops the oldest overflow. The latest event is always
    // included (even if it alone exceeds the cap) so the block is never empty.
    const blocksNewestFirst = [];
    let used = 0;
    for (const evt of events) { // newest-first
        const summary = _stripEventTypePrefix(evt.text || evt.metadata?.summary || '');
        if (!summary) continue;
        const r = rankByEvent.get(evt);
        const label = r === 1 ? 'latest turn' : `${r} turns ago`;
        const blockLines = [`(${label}) ${summary}`];
        if (fullDetail) {
            for (const d of _detailLines(evt.metadata || {})) blockLines.push(`  ${d}`);
        }
        const block = blockLines.join('\n');
        if (maxChars > 0 && blocksNewestFirst.length > 0 && used + 1 + block.length > maxChars) break;
        blocksNewestFirst.push(block);
        used += block.length + 1;
    }

    const body = blocksNewestFirst.slice().reverse().join('\n'); // render oldest→newest
    return { text: `<VectFoxSummarizer>\n${body}\n</VectFoxSummarizer>`, count: blocksNewestFirst.length };
}

/**
 * Build the indented structured-field lines for one event's metadata. Only fields
 * with content are emitted, so sparse events stay compact. `summary` is omitted
 * (already the headline line) and lives in the embed text, not metadata.
 * @param {object} meta
 * @returns {string[]}
 */
function _detailLines(meta) {
    const out = [];
    const arr = (v) => (Array.isArray(v) ? v.filter(x => x != null && String(x).trim() !== '') : []);
    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    if (str(meta.cause)) out.push(`Cause: ${str(meta.cause)}`);
    if (str(meta.result)) out.push(`Result: ${str(meta.result)}`);
    if (arr(meta.characters).length) out.push(`Characters: ${arr(meta.characters).join(', ')}`);
    if (arr(meta.locations).length) out.push(`Locations: ${arr(meta.locations).join(', ')}`);
    if (arr(meta.items).length) out.push(`Items: ${arr(meta.items).join(', ')}`);
    if (str(meta.DateTime)) out.push(`When: ${str(meta.DateTime)}`);
    if (str(meta.scene_time)) out.push(`Scene time: ${str(meta.scene_time)}`);
    // Real-world send-time fallback: surface ONLY when no in-story date/time was
    // captured, so the event still carries a temporal anchor without injecting the
    // out-of-character send timestamp on events that already have an in-story time.
    if (!str(meta.DateTime) && !str(meta.scene_time) && str(meta.real_world_date)) {
        out.push(`Real-world date: ${str(meta.real_world_date)}`);
    }
    if (arr(meta.concepts).length) out.push(`Concepts: ${arr(meta.concepts).join(', ')}`);
    if (arr(meta.keywords).length) out.push(`Keywords: ${arr(meta.keywords).join(', ')}`);
    if (arr(meta.open_threads).length) out.push(`Open threads: ${arr(meta.open_threads).join(', ')}`);
    if (meta.source_window_end != null) out.push(`Message index: ${meta.source_window_end}`);
    return out;
}

/** Strip a leading "[EVENT_TYPE] " prefix from the first line of an event's text. */
function _stripEventTypePrefix(text) {
    const first = String(text).split('\n')[0];
    const m = first.match(/^\[[^\]]+\]\s*(.*)$/);
    return m ? m[1] : first;
}
