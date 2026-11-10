/**
 * ============================================================================
 * AUTOSYNC PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's AutoSync page on GUI-DNA: auto-sync for the open chat,
 * Summarizer Injection, and the ghosting that leans on it. Every control keeps the
 * id settings-panel.js wires it by, and a row or card the wiring shows and hides
 * keeps its id too. The status line under the auto-sync switch is built here as
 * well. Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, input, notice, resultList, stack } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

function autoSyncCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-arrows-rotate', title: 'Auto-sync', description: 'Keeps this chat\'s events current as the chat grows.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_autosync_enabled', title: 'Auto-sync this chat', description: 'Extracts events from new messages. The chat must be vectorized once first.', isSpan: true })}
            <div id="VectFox_autosync_status" class="vfx-span" aria-live="polite"></div>
            ${field([
                fieldLabel({ text: 'Auto-sync window', forId: 'VectFox_eventbase_autosync_window_turns' }),
                sliderNumber({ id: 'VectFox_eventbase_autosync_window_turns', min: 1, max: 20, step: 1, title: 'Turns' }),
                hint({ text: 'Turns of new chat per extraction. A turn is your message and its reply.' }),
                `<p id="VectFox_autosync_window_lock_hint" class="vfx-hint"${HIDDEN}>Held at 1 turn while Summarizer Injection is on.</p>`,
            ])}
            ${stack([
                switchRow({ id: 'VectFox_autosync_popup', title: 'Toast on extraction', description: 'Shows a toast each time auto-sync starts a new window.' }),
                switchRow({ id: 'VectFox_autosync_show_progress_modal', title: 'Progress window', description: 'Shows progress while auto-sync runs. Vectorize Content always shows it.' }),
            ])}
        </div>
    </section>`;
}

function summarizerCard() {
    return `<section id="VectFox_summarizer_injection_group" class="vfx-card">
        ${cardHeader({ icon: 'fa-clock-rotate-left', title: 'Summarizer Injection', description: 'Puts the newest events into every prompt, beside retrieval.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_summarizer_injection_enabled', title: 'Inject recent events', description: 'Turns auto-sync on and holds its window at 1 turn while on.', isSpan: true })}
            ${field([
                fieldLabel({ text: 'Events to inject', forId: 'VectFox_summarizer_injection_count' }),
                sliderNumber({ id: 'VectFox_summarizer_injection_count', min: 1, max: 50, step: 1, title: 'Events' }),
                hint({ text: 'The newest events, in story order, each marked with how many turns ago.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Max size (chars)', forId: 'VectFox_summarizer_injection_max_chars', hasHelp: true }),
                input({ id: 'VectFox_summarizer_injection_max_chars', type: 'number', min: 0, max: 100000, step: 500 }),
                hint({ text: '0 means no cap. Over it, the oldest events are left out.' }),
                detail({ text: 'A cap keeps a long recap from overflowing the model\'s context. The newest event always goes in, even when it alone is over the cap.' }),
            ])}
            ${switchRow({ id: 'VectFox_summarizer_injection_full_detail', title: 'Full event detail', description: 'Adds each event\'s cause, result, cast, places and other fields under it.', isSpan: true })}
        </div>
    </section>`;
}

function ghostingCard() {
    return `<section id="VectFox_eventbase_ghost_group" class="vfx-card">
        ${cardHeader({ icon: 'fa-ghost', title: 'Ghosting', description: 'Saves tokens: old vectorized messages leave the prompt, their events stand in.' })}
        <div class="vfx-card-body vfx-grid">
            <div id="VectFox_eventbase_ghost_needs_summarizer" class="vfx-span"${HIDDEN}>${notice({ status: 'warning', text: 'Ghosting needs Summarizer Injection on.' })}</div>
            ${switchRow({ id: 'VectFox_eventbase_ghost_enabled', title: 'Ghost vectorized messages', description: 'Blanks them from the prompt sent. The chat and its saved file stay untouched.', isSpan: true })}
            ${field([
                fieldLabel({ text: 'Messages kept verbatim', forId: 'VectFox_eventbase_ghost_keep_recent', hasHelp: true }),
                sliderNumber({ id: 'VectFox_eventbase_ghost_keep_recent', min: 1, max: 50, step: 1, title: 'Messages' }),
                hint({ text: 'Older vectorized messages are blanked. Lower saves more tokens.' }),
                detail({ text: 'Every message World Info scans is kept as well, so keyword triggers still fire. The blanked turns live on only as events, so check recall as you lower it.' }),
            ])}
            <div id="VectFox_eventbase_ghost_readout">${notice({ status: 'info', text: 'Last turn: no reply yet.' })}</div>
        </div>
    </section>`;
}

/**
 * The AutoSync page's cards: Auto-sync, Summarizer Injection and Ghosting.
 *
 * @returns {string}
 */
export function autoSyncPageMarkup() {
    return autoSyncCard() + summarizerCard() + ghostingCard();
}

/**
 * The counts behind a status: the chat's messages and how far vectorization reaches.
 */
function countsLine({ chatMessageCount, vectorizedCount, isLatestTurnSettling }) {
    if (typeof chatMessageCount !== 'number') return null;
    const vectorized = typeof vectorizedCount === 'number' ? ` · vectorized: ${vectorizedCount} messages` : '';
    const settling = isLatestTurnSettling ? ' · the latest turn waits to settle' : '';
    return { name: `Chat: ${chatMessageCount} messages${vectorized}${settling}` };
}

/**
 * What auto-sync is doing for the open chat, as a line with its tone: success, warning,
 * or a plain line while it is off.
 */
function stateLine({ state, isVectFoxOn, isOnForChat, unfinishedWindowCount }) {
    if (state === 'no-chat') return { status: 'warning', text: 'No chat open.' };
    if (state === 'no-collection') return { status: 'warning', text: 'Not vectorized yet. Turning auto-sync on starts it.' };
    if (!isVectFoxOn) return { icon: 'fa-circle', text: 'Paused while VectFox is off.' };
    if (!isOnForChat) return { icon: 'fa-circle', text: 'Off for this chat.' };
    if (state === 'fully-vectorized') return { status: 'success', text: 'Up to date.' };
    if (unfinishedWindowCount > 0) {
        const failed = unfinishedWindowCount === 1 ? '1 window failed and holds no events.' : `${unfinishedWindowCount} windows failed and hold no events.`;
        return { status: 'warning', name: `${failed} Resume in Vectorize Content sends them again.` };
    }
    return { status: 'warning', text: 'Behind. The next auto-sync catches up.' };
}

/**
 * The auto-sync status for the open chat: what auto-sync is doing, then the counts behind it.
 *
 * @param {object} status
 * @param {string} status.state - getChatAutoSyncStatus's state
 * @param {boolean} status.isVectFoxOn
 * @param {boolean} [status.isOnForChat] - Auto-sync is on and the collection is locked to this chat
 * @param {number|null} [status.chatMessageCount]
 * @param {number|null} [status.vectorizedCount] - Messages vectorization covers
 * @param {boolean} [status.isLatestTurnSettling] - Up to date but for the newest turn, held back until it settles
 * @param {number} [status.markerValue] - Where the auto-sync marker sits, read while vectorization is ahead of the chat
 * @param {number} [status.unfinishedWindowCount] - Windows that failed and hold no events
 * @returns {string}
 */
export function autoSyncStatusMarkup({ state, isVectFoxOn, isOnForChat = false, chatMessageCount = null, vectorizedCount = null, isLatestTurnSettling = false, markerValue = 0, unfinishedWindowCount = 0 }) {
    if (isVectFoxOn && isOnForChat && state === 'vectorization-ahead') {
        const gap = markerValue - chatMessageCount;
        return resultList({ lines: [
            { status: 'warning', text: 'Vectorization reaches past this chat\'s end, so there is nothing to sync.' },
            { name: `Chat: ${chatMessageCount} messages · vectorized: ${markerValue} messages (${gap} ahead)` },
            { name: `Messages may have been deleted, or the events came from a longer copy of this chat. Auto-sync resumes once the chat reaches ${markerValue} messages.` },
        ] });
    }
    const line = stateLine({ state, isVectFoxOn, isOnForChat, unfinishedWindowCount });
    return resultList({ lines: [line, countsLine({ chatMessageCount, vectorizedCount, isLatestTurnSettling })] });
}
