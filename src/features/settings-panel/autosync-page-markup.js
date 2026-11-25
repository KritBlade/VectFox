/**
 * ============================================================================
 * AUTOSYNC PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's AutoSync page on GUI-DNA: auto-sync for the open chat,
 * Summarizer Injection, and the ghosting that leans on it. Every control keeps the
 * id settings-panel.js wires it by, and a row or card the wiring shows and hides
 * keeps its id too. Collection in use here, over the open chat's own collections
 * (§1.2 of vectfox-multi-collection-per-chat.md), and the status line under the
 * auto-sync switch are built here as well. Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, input, notice, resultList, stack } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { inUseSwitcherMarkup } from './in-use-switcher-markup.js';

const HIDDEN = ' style="display:none;"';

/** Collection in use here's dropdown, by its id. */
export const AUTOSYNC_IN_USE_ID = 'VectFox_autosync_in_use';

function autoSyncCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-arrows-rotate', title: 'Auto-sync', description: 'Keeps this chat\'s events current as the chat grows.' })}
        <div class="vfx-card-body vfx-grid">
            <div id="VectFox_autosync_collection" class="vfx-span"></div>
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
            ${switchRow({ id: 'VectFox_eventbase_ghost_enabled', title: 'Ghost vectorized messages', description: 'Takes them out of the prompt sent. The chat and its saved file stay untouched.', isSpan: true })}
            ${field([
                fieldLabel({ text: 'Messages kept verbatim', forId: 'VectFox_eventbase_ghost_keep_recent', hasHelp: true }),
                sliderNumber({ id: 'VectFox_eventbase_ghost_keep_recent', min: 1, max: 50, step: 1, title: 'Messages' }),
                hint({ text: 'Older vectorized messages are taken out. Lower saves more tokens.' }),
                detail({ text: 'Every message World Info scans is kept as well, so keyword triggers still fire. The turns taken out live on only as events, so check recall as you lower it.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Take out in batches of', forId: 'VectFox_eventbase_ghost_batch_size', hasHelp: true }),
                sliderNumber({ id: 'VectFox_eventbase_ghost_batch_size', min: 1, max: 100, step: 1, title: 'Messages' }),
                hint({ text: 'Above 1, the prompt\'s start holds for a few turns, so a prompt cache can reuse it.' }),
                detail({ text: 'At 1, ghosting takes messages out every turn. At 10, it waits until 10 more messages can go and takes them out together, so up to 9 more messages stay verbatim until then. Raise it on a provider that caches prompts, such as DeepSeek or OpenAI. Elsewhere the extra messages only cost tokens.' }),
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
function stateLine({ state, isVectFoxOn, isOnForChat, unfinishedWindowCount, noneInUseText }) {
    if (state === 'no-chat') return { status: 'warning', text: 'No chat open.' };
    if (state === 'no-collection') return { status: 'warning', text: 'Not vectorized yet. Turning auto-sync on starts it.' };
    if (state === 'none-locked') return { status: 'warning', text: `${noneInUseText} Choose one above.` };
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
 * Collection in use here (§1.2 of vectfox-multi-collection-per-chat.md): the open chat's own collections in the in-use
 * switcher, the one in use chosen as the one route gives it (collectionInUse, D18); "None in use here" while none is,
 * as with several locked to the chat, so that each of them can be chosen; then New collection, which opens Vectorize
 * Content on it; nothing for a chat with no collection, which keeps "Not vectorized yet.".
 * @param {Array<{registryKey: string, name: string}>} collections - chatOwnCollections
 * @param {string|null} [inUseKey] - The registry key of the collection in use, from getChatAutoSyncStatus; none while
 *   none is in use
 * @returns {string}
 */
export function autoSyncCollectionMarkup(collections, inUseKey = null) {
    if (!collections.length) return '';
    return field([
        fieldLabel({ text: 'Collection in use here', forId: AUTOSYNC_IN_USE_ID }),
        inUseSwitcherMarkup({
            id: AUTOSYNC_IN_USE_ID,
            title: 'Collection in use here',
            members: collections.map(collection => ({ id: collection.registryKey, name: collection.name })),
            inUseId: inUseKey,
            newText: 'New collection',
        }),
        hint({ text: 'The one EventBase reads and writes in this chat. The others stay as they are.' }),
    ]);
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
 * @param {number} [status.unfinishedWindowCount] - Windows that failed and hold no events
 * @param {string} [status.noneInUseText] - With collections and none in use: why EventBase reads and writes nothing here
 * @returns {string}
 */
export function autoSyncStatusMarkup({ state, isVectFoxOn, isOnForChat = false, chatMessageCount = null, vectorizedCount = null, isLatestTurnSettling = false, unfinishedWindowCount = 0, noneInUseText = '' }) {
    if (isVectFoxOn && isOnForChat && state === 'vectorization-ahead') {
        return resultList({ lines: [
            { status: 'warning', text: 'This chat is shorter than what EventBase read.' },
            { name: `Chat: ${chatMessageCount} messages · read: ${vectorizedCount} messages` },
            { name: `Messages were deleted, a summary replaced some, or the events came from a longer copy of this chat. Auto-sync goes on with the chat's new messages, and ghosting takes nothing out until the chat passes ${vectorizedCount} messages. Sync chat on the Action page reads what EventBase has not read.` },
        ] });
    }
    const line = stateLine({ state, isVectFoxOn, isOnForChat, unfinishedWindowCount, noneInUseText });
    return resultList({ lines: [line, countsLine({ chatMessageCount, vectorizedCount, isLatestTurnSettling })] });
}
