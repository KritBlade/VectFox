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
 * ============================================================================
 */

import { setExtensionPrompt } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getWorldInfoSettings, getSortedEntries } from '../../../../world-info.js';
import { getBackend } from '../backends/backend-manager.js';
import { getChatUUID } from './collection-ids.js';
import { resolveActiveEventBaseCollection, getVectorizationTip } from './eventbase-store.js';
import { SUMMARIZER_PROMPT_TAG } from './constants.js';
import { isVectFoxEnabled } from './feature-gate.js';
import { log } from './log.js';

/**
 * Resolve recent events, format them, and inject (or clear) the summarizer slot.
 * Self-clears when disabled / no chat / no collection / no events, so calling it
 * unconditionally every turn is safe and keeps stale injections from lingering.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<{ injected: number, error?: string }>}
 */
export async function runSummarizerInjection(settings) {
    const clear = () => setExtensionPrompt(SUMMARIZER_PROMPT_TAG, '', settings.position, settings.depth, false);

    if (!settings?.summarizer_injection_enabled) { clear(); return { injected: 0 }; }

    const { text, count } = await buildSummarizerInjection(settings);
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
 * for keyword triggers to keep firing. Ghosting wipes `coreChat` BEFORE ST scans WI from
 * that same array, so any message WI would look at must not be wiped.
 *
 *   - Base = global `world_info_depth` (the standard scan window, default 2).
 *   - Per-entry `scanDepth` overrides: an entry can scan deeper than the global window, so we
 *     fold in the cached deepest override (_maxEntryScanDepth, refreshed on WI/chat changes).
 *   - If `min_activations` is on, the scan advances deeper until the minimum is met, capped
 *     by `min_activations_depth_max` — or by the END OF CHAT when that cap is 0. So an
 *     uncapped min-activations scan can reach the whole chat → return Infinity, which makes
 *     ghosting back off entirely (wipe nothing) rather than risk breaking WI.
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
 * Build a prompt-only wiped clone of a message: empty text AND stripped of every
 * content-bearing field ST folds into the outgoing prompt independently of `.mes` —
 * images/files (`extra.media`), tool-call args+results (`extra.tool_invocations`), and
 * model reasoning (`extra.reasoning` / `reasoning_signature`). The caller also flags this
 * clone with ST's IGNORE_SYMBOL to drop it entirely; the blank here is the "bulletproof"
 * fallback for any code path that doesn't honor the symbol — and
 * it stops media/reasoning leaking on builds where the symbol is unavailable.
 *
 * We shallow-copy (not structuredClone): we only overwrite top-level `.mes` and a fresh
 * `.extra`, so a shallow spread is sufficient, can't throw on an unclonable nested value,
 * and never touches the LIVE message object — the UI + saved chat keep their media/
 * reasoning intact. (ST already hands the interceptor detached copies, but cloning keeps
 * us correct regardless of ST version.)
 *
 * @param {object} m - source message
 * @returns {object} prompt clone with no recoverable content
 */
function blankPromptClone(m) {
    const clone = { ...m, mes: '' };
    if (m.extra && typeof m.extra === 'object') {
        clone.extra = { ...m.extra };
        delete clone.extra.media;               // images / files (heaviest leak)
        delete clone.extra.tool_invocations;    // tool-call arguments + results
        delete clone.extra.reasoning;           // model reasoning text
        delete clone.extra.reasoning_signature;
    }
    return clone;
}

/**
 * Ephemeral "ghosting": keep the most recent N messages verbatim and blank ALL older
 * already-vectorized messages from the OUTGOING prompt only. The chat array we get is
 * ST's interceptor working copy; we replace each wiped slot with a sanitized clone
 * (see blankPromptClone), so the saved chat + UI never change and the whole effect
 * resets on the next generation (nothing to un-ghost, branch-safe).
 *
 * Wipe boundary `cutoff = min(vectorizedInCore, chat.length - keepFloor)`:
 *   - `vectorizedInCore` — the vectorization tip translated from FULL-chat index space
 *     into the coreChat space we actually receive (see below). Messages below it are in
 *     EventBase; nothing above it (not yet vectorized) is ever wiped.
 *   - `chat.length - keepFloor` — keeps the last `keepRecent` messages raw, with a hard
 *     floor of 1 so the current outgoing turn is NEVER blanked (even at keepRecent=0).
 * Messages [0, cutoff) are wiped. "Keep last N" auto-scales to any chat length.
 *
 * Wipe mechanism : flag each wiped message
 * with ST's IGNORE_SYMBOL (drops it from the prompt entirely — no empty turn left behind,
 * which some chat-completion APIs reject) AND blank its clone as a bulletproof fallback.
 * CONTIGUITY IS MANDATORY: setOpenAIMessages leaves an *unassigned slot* per ignored
 * message — a contiguous ignored block [0, cutoff) just shortens the array (safe), but
 * leaving any message raw INSIDE the span punches an interior `undefined` hole that crashes
 * prompt building ("Message role not set" → `chatPrompt.media` on undefined → "An unknown
 * error occurred while counting tokens"). So we wipe EVERY message in the span — including
 * empty and tool/system ones — and skip only null slots. (This mid-span skip was the
 * original crash: we used to `continue` past empty messages, breaking contiguity.)
 *
 * Gated to Summarizer Injection (forces auto-sync window=1 → the tip stays current).
 *
 * World Info safety: ST scans WI from this same chat array AFTER us, so the wipe is floored
 * to keep WI's full scan window raw (see worldInfoScanFloor) — keyword triggers keep firing
 * at any slider value, and ghosting auto-pauses if WI could scan the whole chat.
 *
 * @param {Array} chat - ST interceptor chat array (coreChat; mutated by slot replacement)
 * @param {object} settings - extension_settings.vectfox
 * @returns {{ wiped: number, charsRemoved: number }}
 */
export function applyGhosting(chat, settings) {
    if (!settings?.eventbase_ghost_enabled || !settings?.summarizer_injection_enabled) {
        return { wiped: 0, charsRemoved: 0 };
    }
    let wiped = 0;
    let charsRemoved = 0;

    const keepRecent = Math.max(0, Math.floor(Number(settings.eventbase_ghost_keep_recent) || 0));
    const uuid = getChatUUID();
    // tip = highest extracted message index + 1, in FULL-chat index space.
    const tip = uuid ? getVectorizationTip(uuid) : undefined;

    if (Array.isArray(chat) && chat.length > 0 && typeof tip === 'number' && tip > 0) {
        // INDEX-SPACE FIX: `tip` indexes the full chat (incl. is_system messages), but the
        // interceptor hands us coreChat — ST filters is_system OUT before calling us. Using
        // `tip` directly as a coreChat cutoff over-reaches whenever system/narrator messages
        // sit below the tip, wiping into the kept-recent tail. Translate by counting how many
        // full-chat messages below the tip survive coreChat's filter (non-system). Conservative:
        // a system message kept only via tool_invocations isn't counted, so we under-wipe rather
        // than risk a not-yet-vectorized message. Falls back to raw `tip` if the live chat is
        // unavailable (the keepFloor below still caps the reach).
        let vectorizedInCore = tip;
        const fullChat = getContext()?.chat;
        if (Array.isArray(fullChat)) {
            vectorizedInCore = 0;
            const end = Math.min(tip, fullChat.length);
            for (let k = 0; k < end; k++) {
                if (fullChat[k] && !fullChat[k].is_system) vectorizedInCore++;
            }
        }

        // keepFloor = how many recent messages stay raw no matter the slider:
        //   - >= 1      → never blank the current outgoing turn (prompt is never left empty).
        //   - >= WI reach → never blank a message World Info will scan, so ghosting can't
        //                   break keyword triggers at ANY slider value. If WI may scan the
        //                   whole chat (uncapped min-activations), the floor is Infinity →
        //                   cutoff clamps to 0 → ghosting wipes nothing this turn.
        const keepFloor = Math.max(keepRecent, 1, worldInfoScanFloor());
        const cutoff = Math.max(0, Math.min(vectorizedInCore, chat.length - keepFloor));

        // ST's ignore flag: drop the message from the prompt entirely. Optional — falls back
        // to the blanked clone alone when this ST build doesn't expose it.
        const ignoreSymbol = getContext()?.symbols?.ignore ?? null;

        for (let i = 0; i < cutoff; i++) {
            const m = chat[i];
            if (!m) continue;                          // null slot: can't wipe (pre-existing ST issue upstream)
            try {
                const hadContent = !!(m.mes && m.mes.trim());
                const clone = blankPromptClone(m);     // never mutate the live message object
                if (ignoreSymbol) {
                    clone.extra = clone.extra || {};
                    clone.extra[ignoreSymbol] = true;
                }
                chat[i] = clone;
                // Count only content-bearing messages for the readout; empty/system ones are
                // still wiped (to preserve contiguity) but represent no real token saving.
                if (hadContent) { charsRemoved += m.mes.length; wiped++; }
            } catch (err) {
                // A failure here leaves this slot raw → breaks contiguity → hole. Shallow-clone
                // of a plain message effectively never throws, but log loudly if it ever does.
                log.domain('injection', 'verbose', `[Ghost] could not wipe idx ${i}: ${err?.message || err}`);
            }
        }
    }

    // Always publish the latest outcome while the feature is enabled — so the on-screen
    // readout reflects "0 saved this turn" (e.g. tip hasn't advanced yet) instead of a
    // stale value from an earlier generation.
    const approxTokens = Math.round(charsRemoved / 4); // rough 4-chars/token heuristic
    window.VectFox_LastGhost = { wiped, charsRemoved, approxTokens, at: Date.now() };
    if (wiped > 0) {
        log.domain('injection', 'lifecycle', `[Ghost] Wiped ${wiped} vectorized message(s) from prompt — ~${charsRemoved} chars (~${approxTokens} tokens) saved`);
    }
    return { wiped, charsRemoved };
}

/**
 * Compute the would-be summarizer injection content WITHOUT injecting it. This is
 * the exact path runSummarizerInjection uses (resolve → listChunks → filter → sort
 * → slice → format) minus the `setExtensionPrompt` and the `enabled` gate, so the
 * "Debug Summarizer" preview shows the real result even while the feature is off.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<{ text: string, count: number, reason?: string, collectionId?: string, requested?: number, error?: string }>}
 *   `reason` is set on a 0-count outcome (disabled handled by the caller).
 */
export async function buildSummarizerInjection(settings) {
    const n = Math.max(1, Math.min(50, settings.summarizer_injection_count ?? 20));
    const uuid = getChatUUID();
    if (!uuid) return { text: '', count: 0, reason: 'no-chat', requested: n };

    // Lock-aware, ownership-filtered active collection (same source of truth as
    // the auto-sync marker and the LED).
    const active = resolveActiveEventBaseCollection(settings, uuid);
    if (!active) return { text: '', count: 0, reason: 'no-collection', requested: n };

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
        // NO limit, see ui/database-browser.js doLoad(null)). 50000 is a ceiling that
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
