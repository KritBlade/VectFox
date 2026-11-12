/**
 * ============================================================================
 * VectFox SETTINGS PANEL
 * ============================================================================
 * Mounts the settings panel in SillyTavern's Extensions drawer and binds every
 * page's controls and action buttons
 *
 * @author Kritblade
 * ============================================================================
 */

import { saveSettingsDebounced, extension_settings } from '../../sillytavern/settings.js';
import { getCurrentChatId, getContext } from '../../sillytavern/chat.js';
import { eventSource, event_types } from '../../sillytavern/events.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { clearKeyBox, OPENROUTER_KEY_BOX, QDRANT_KEY_BOX, VLLM_KEY_BOX, wireKeyBox } from './api-key-boxes.js';
import {
    getOpenRouterApiKey,
    getCustomApiKey,
    fetchQdrantApiKeyPresence,
} from '../../shared/api-keys.js';
import { openDatabaseBrowser } from '../database-browser/index.js';
import { openContentVectorizer } from '../chunkbase/index.js';
import { resetBackendHealth } from '../vector-backend/index.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { describeStoryLinkPass, hideStoryArcPage, readStoryLinkCoverage, runStoryLinkPass, showStoryArcPage, storyArcPageMarkup, wireStoryArcPage } from '../eventbase/index.js';
import { getHealthPillHtml, refreshHealthPill } from '../diagnostics/index.js';
import { PANEL_TABS, panelNavMarkup, panelPageMarkup, vectfoxOffNoticeMarkup } from './panel-shell-markup.js';
import { wireSettingsPanel } from './panel-shell.js';
import { drawerLauncherMarkup } from './drawer-launcher-markup.js';
import { actionPageMarkup, masterSwitchPillsMarkup } from './action-page-markup.js';
import { agentModePageMarkup } from './agentmode-page-markup.js';
import { autoSyncPageMarkup, autoSyncStatusMarkup } from './autosync-page-markup.js';
import { chunkBasePageMarkup } from './chunkbase-page-markup.js';
import { corePageMarkup } from './core-page-markup.js';
import { eventBasePageMarkup } from './eventbase-page-markup.js';
import { ragPageMarkup } from './rag-page-markup.js';
import { worldInfoPageMarkup, worldInfoStatusMarkup } from './worldinfo-page-markup.js';
import { bindNumberSetting } from './number-setting.js';
import { wireConnectionRows } from './connection-rows.js';
import { wireActionPage } from './action-page.js';
import { getCollectionListing, getCollectionMeta } from '../collections/index.js';
import { checkPluginAvailable } from '../../shared/similharity-plugin.js';
import {
    CJK_TOKENIZER_MODES,
    setCjkTokenizerMode,
    ensureJiebaTokenizerLoaded,
    ensureJiebaTwLoaded,
    LANGUAGE_MODES,
} from '../keyword-search/index.js';
import {
    CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT,
    RETRIEVAL_TIMEOUT_DEFAULT_MS,
    RETRIEVAL_TIMEOUT_MIN_MS,
    RETRIEVAL_TIMEOUT_MAX_MS,
} from '../../shared/constants.js';
import {
    resolveRetrievalTimeoutMs,
    resolveAgenticPlannerTimeoutMs,
    resolveAgenticQueryTimeoutMs,
    resolveAgenticMaxTokens,
} from '../../shared/retrieval-budget.js';
import { log } from '../../sillytavern/log.js';

/**
 * The GUI-DNA shell: the rail and every page, each built by its own markup file.
 *
 * @returns {string}
 */
function panelMarkup() {
    const pages = [
        panelPageMarkup('core', corePageMarkup({
            languageModes: LANGUAGE_MODES,
            retrievalTimeout: { minMs: RETRIEVAL_TIMEOUT_MIN_MS, maxMs: RETRIEVAL_TIMEOUT_MAX_MS, defaultMs: RETRIEVAL_TIMEOUT_DEFAULT_MS },
        })),
        panelPageMarkup('chunkbase', chunkBasePageMarkup()),
        panelPageMarkup('rag', ragPageMarkup()),
        panelPageMarkup('worldinfo', worldInfoPageMarkup()),
        panelPageMarkup('autosync', autoSyncPageMarkup()),
        panelPageMarkup('action', actionPageMarkup(), { status: `${masterSwitchPillsMarkup()}${getHealthPillHtml()}` }),
        panelPageMarkup('eventbase', eventBasePageMarkup()),
        storyArcPageMarkup({ notice: vectfoxOffNoticeMarkup() }),
        panelPageMarkup('agentmode', agentModePageMarkup()),
    ];
    return `<div id="VectFox_settings" class="vfx-ui vfx-shell">${panelNavMarkup()}<main class="vfx-main">${pages.join('')}</main></div>`;
}

/**
 * Put VectFox's launcher in SillyTavern's Extensions drawer, with the panel closed in its holder, and wire every page
 * and the shell.
 *
 * @param {string} containerId - The drawer column the launcher joins
 * @param {object} settings - VectFox settings object
 * @param {object} callbacks - Object containing callback functions
 * @param {Function} callbacks.runNetworkStartup - Re-runs the off-box startup work (src/app/network-startup.js) when
 *     the master switch turns back on
 */
export function mountSettingsPanel(containerId, settings, callbacks) {
    // Ensure extension_settings.vectfox exists before any UI event handlers fire
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }

    $(`#${containerId}`).append(drawerLauncherMarkup(panelMarkup()));

    bindSettingsEvents(settings, callbacks);

    // The shell: the rail, the theme switch, and the dialog the panel opens in
    wireSettingsPanel(panelTabsWithHooks(), settings);

    // The Action page's health pill answers once at load; while VectFox is off, switching it on probes.
    if (isVectFoxEnabled()) void refreshHealthPill();

    log.lifecycle('VectFox UI: settings panel mounted');
}

/** Every page of the panel, with what runs as it shows or hides (panel-shell.js). */
function panelTabsWithHooks() {
    const hooks = {
        action: { onOpen: refreshHealthPill },
        autosync: { onOpen: () => refreshAutoSyncCheckbox(extension_settings.vectfox) },
        worldinfo: { onOpen: refreshWIStatus },
        storyarc: {
            onOpen: () => {
                refreshStoryLinkStatus(extension_settings.vectfox);
                return showStoryArcPage();
            },
            onClose: hideStoryArcPage,
        },
    };
    return PANEL_TABS.map(tab => ({ name: tab.name, ...hooks[tab.name] }));
}

/**
 * Paint the WorldInfo page's switch and status for the open chat. The switch is on iff at least
 * one own-persona lorebook is active for this chat, and enabled_world_info is kept in step with it.
 */
export async function refreshWIStatus() {
    const $status = $('#VectFox_wi_status');
    if (!$status.length) return;

    const settings = extension_settings.vectfox || {};
    const $wiCheckbox = $('#VectFox_enabled_world_info');

    // One helper keeps the setting and the switch identical across the three exit paths below.
    const _setWIEnabled = (enabled) => {
        if (settings.enabled_world_info !== enabled) {
            settings.enabled_world_info = enabled;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        }
        if ($wiCheckbox.length && $wiCheckbox.prop('checked') !== enabled) {
            $wiCheckbox.prop('checked', enabled);
            $('#VectFox_world_info_settings').toggle(enabled);
        }
    };

    // Single source of truth for ownership AND isActive — getCollectionListing
    // encodes the superadmin bypass + creatorHandle check + lock-state check.
    const ownLorebookEntries = getCollectionListing(settings)
        .filter(e => e.isOwn && e.collectionId.startsWith('vf_lorebook_'));

    if (ownLorebookEntries.length === 0) {
        $status.html(worldInfoStatusMarkup({ state: 'no-lorebooks' }));
        _setWIEnabled(false);
        return;
    }

    const activeIds = ownLorebookEntries
        .filter(e => e.isActive)
        .map(e => e.collectionId);

    if (activeIds.length === 0) {
        $status.html(worldInfoStatusMarkup({ state: 'none-active' }));
        _setWIEnabled(false);
        return;
    }

    $status.html(worldInfoStatusMarkup({ state: 'active', names: activeIds.map(id => getCollectionMeta(id)?.sourceName || id) }));
    _setWIEnabled(true);
}

/** Show how far this chat's link pass has got, in the StoryArc tab. */
async function refreshStoryLinkStatus(settings) {
    const $status = $('#VectFox_story_arc_link_status');
    let coverage;
    try {
        coverage = await readStoryLinkCoverage(settings);
    } catch (err) {
        log.warn('VectFox StoryArc: could not read link status:', err);
        $status.text('Could not read this chat\'s links. See the console.');
        return;
    }
    if (coverage.problem) {
        $status.text(coverage.problem);
        return;
    }
    const usability = coverage.hasUsableLinks
        ? 'StoryArc follows threads through these links.'
        : 'StoryArc searches without links until this pass is mostly done.';
    $status.text(`${coverage.decidedCount} of ${coverage.totalCount} events decided, ${coverage.linkedCount} with links. ${usability}`);
    $('#VectFox_story_arc_link_pill').text(`${coverage.linkedCount} of ${coverage.totalCount} linked`).show();
}

/** One line of what a link pass would likely cost. */
function _describeLinkEstimate({ eventCount, inputTokens, outputTokens, minutes, costUsd }) {
    const cost = costUsd === null ? 'price unknown' : `about $${costUsd.toFixed(2)}`;
    return `${eventCount} events: ${cost}, about ${minutes} minutes, about ${Math.round(inputTokens / 1000)}k input and ${Math.round(outputTokens / 1000)}k output tokens`;
}

/** Show a link pass's cost, and run it if the player accepts. */
async function _runStoryLinkButton(settings) {
    const pass = await describeStoryLinkPass(settings);
    if (pass.problem) {
        toastr.warning(pass.problem, 'VectFox StoryArc');
        return;
    }
    const { collectionId, coverage, allEstimate, undecidedEstimate, model } = pass;
    const hasUndecided = undecidedEstimate.eventCount > 0;
    const hasDecided = coverage.decidedCount > 0;
    const { choicePopup } = await import('../../sillytavern/popup.js');
    const choice = await choicePopup([
        { icon: 'fa-diagram-project', text: 'Regenerate StoryArc links?' },
        { parts: [{ text: "Each event's text goes to " }, { name: model }, { text: ' once, along with up to 13 earlier events.' }] },
        ...(hasUndecided ? [{ text: 'Events with no decision yet:', name: _describeLinkEstimate(undecidedEstimate) }] : []),
        ...(hasDecided ? [{ text: 'All events, replacing their links:', name: _describeLinkEstimate(allEstimate) }] : []),
        { text: 'Estimated from one chat on GPT-6 Luna, and a model that thinks more costs more. You can stop at any time, and finished events keep their links.' },
    ], {
        choices: [
            ...(hasUndecided ? [{ text: `Link ${undecidedEstimate.eventCount} events`, value: 'undecided' }] : []),
            ...(hasDecided || !hasUndecided ? [{ text: `Relink all ${allEstimate.eventCount} events`, value: 'all' }] : []),
        ],
    });
    if (!choice) return;
    await runStoryLinkPass({ collectionId, settings, shouldRelinkDecided: choice === 'all' });
}

/**
 * Offer to fork a branch or checkpoint chat's EventBase from its parent, for the
 * auto-sync enable flow when the chat has no collection of its own yet.
 *
 * @param {object} settings
 * @returns {Promise<'forked'|'vectorize'|'cancel'>}
 *   'forked' — this chat now has its own collection; continue enabling.
 *   'vectorize' — no parent to fork from, or the user chose to start over.
 *   'cancel' — the user closed the popup, stopped the fork, or it failed.
 */
async function _offerEventBaseFork(settings) {
    const { findEventBaseForkSource, forkEventBaseFromSource } = await import('../eventbase/index.js');

    let source;
    try {
        source = await findEventBaseForkSource(settings);
    } catch (err) {
        log.error('[AutoSync][fork] looking for a parent EventBase failed:', err);
        toastr.error(err?.message || String(err), 'Could not check for a parent chat');
        return 'cancel';
    }
    if (!source) return 'vectorize';

    const remainingCount = Math.max(0, source.chatMessageCount - source.sharedPrefixLength);
    const { choicePopup } = await import('../../sillytavern/popup.js');
    const choice = await choicePopup([
        { icon: 'fa-code-branch', text: 'This chat is a branch or checkpoint.' },
        { text: 'Messages it shares with its parent:', name: String(source.sharedPrefixLength) },
        { text: "The parent's EventBase:", name: source.collectionId },
        { text: "Fork from parent copies the events for those messages into this chat's own EventBase, with no LLM calls and no embedding." },
        ...(remainingCount > 0 ? [{ text: 'Messages after them, still to read:', name: String(remainingCount) }] : []),
        { text: "If the parent's EventBase is locked to this chat, it is unlocked, as its later events belong to the parent's story." },
        { text: "Vectorize from scratch reads this chat's whole history again." },
    ], { choices: [{ text: 'Fork from parent', value: 'fork' }, { text: 'Vectorize from scratch', value: 'vectorize' }] });

    if (choice === 'vectorize') return 'vectorize';
    if (choice !== 'fork') return 'cancel';

    try {
        const result = await forkEventBaseFromSource(settings, source);
        log.lifecycle(`[AutoSync][fork] copied ${result.eventCount} events from the parent chat`);
        return 'forked';
    } catch (err) {
        if (err?.name === 'AbortError') {
            log.lifecycle('[AutoSync][fork] stopped by the user');
            return 'cancel';
        }
        log.error('[AutoSync][fork] fork failed:', err);
        toastr.error(err?.message || String(err), 'EventBase fork failed');
        return 'cancel';
    }
}

export async function refreshAutoSyncCheckbox(settings) {
    const $checkbox = $('#VectFox_autosync_enabled');
    const $status = $('#VectFox_autosync_status');

    const { getChatAutoSyncStatus } = await import('../eventbase/index.js');
    const { isCollectionAutoSyncEnabled, isCollectionActiveForContextAnyKey } = await import('../collections/index.js');

    // While VectFox is disabled this refresh only reads cached state: no backend call,
    // no diagnostics. It still runs so the checkbox matches the current chat — the
    // Summarizer Injection toggle reads it. The master switch refreshes again when
    // VectFox is turned back on.
    const isVectFoxOn = isVectFoxEnabled(settings);
    const status = await getChatAutoSyncStatus(settings, {
        shouldProbeBackend: isVectFoxOn,
        shouldLogResolution: isVectFoxOn,
    });
    const chatId = getCurrentChatId();

    // No chat, or a chat with no EventBase collection yet: nothing auto-sync could run on.
    if (status.state === 'no-chat' || status.state === 'no-collection') {
        $checkbox.prop('checked', false);
        $status.html(autoSyncStatusMarkup({ state: status.state, isVectFoxOn }));
        return;
    }

    // Collection exists. The switch shows the per-collection autoSync flag, for a
    // collection locked to this chat. Metadata is keyed by registry-key form ("backend:id").
    const lookupKey = status.registryKey || status.collectionId;
    const isOnForChat = Boolean(isCollectionAutoSyncEnabled(lookupKey)
        && chatId && isCollectionActiveForContextAnyKey([status.registryKey, status.collectionId], { chatId }));
    $checkbox.prop('checked', isOnForChat);

    // How far vectorization reaches: the live tip (max source_window_end + 1, kept current by
    // the ingestion loop) before the marker, which stays where auto-sync was turned on. The
    // marker stands in only while the tip cache is empty and the probe found no events.
    const vectorizedCount = (typeof status.vectorizationTip === 'number')
        ? status.vectorizationTip
        : (typeof status.markerValue === 'number' ? status.markerValue : null);
    // Settle/commit lag: when fully synced, the active last turn is held back (it is already in
    // live context), so vectorization can sit one turn behind the chat without being a backlog.
    // See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
    const settleGap = (typeof status.chatMessageCount === 'number' && vectorizedCount !== null)
        ? status.chatMessageCount - vectorizedCount
        : 0;
    $status.html(autoSyncStatusMarkup({
        state: status.state,
        isVectFoxOn,
        isOnForChat,
        chatMessageCount: typeof status.chatMessageCount === 'number' ? status.chatMessageCount : null,
        vectorizedCount,
        isLatestTurnSettling: status.state === 'fully-vectorized' && settleGap > 0,
        markerValue: status.markerValue,
        unfinishedWindowCount: status.unfinishedWindowCount,
    }));
}

/**
 * Binds event handlers to UI elements
 * @param {object} settings - VectFox settings object
 * @param {object} callbacks - Callback functions
 */
function bindSettingsEvents(settings, callbacks) {
    // Forward-declared so the vector-backend change handler can call it; the
    // real implementation is assigned later when the EventBase weight inputs
    // are wired up. The optional-call `?.()` at the call site guards against
    // any backend-change event that fires before assignment.
    let _refreshCosineWeightAvailability = null;
    // Forward-declared like the cosine helper above. Hides the Summarizer Injection
    // and Ghosting cards on standard+no-plugin (its listChunks returns no metadata).
    let _refreshSummarizerInjectionAvailability = null;

    // The Action page: the master switch, its tools, the debug switches and the danger zone.
    wireActionPage(settings, { refreshAutoSyncCheckbox, runNetworkStartup: callbacks.runNetworkStartup });

    /**
     * Chat id whose auto-sync the user asked to turn on, but which had no
     * collection yet — so they were sent to Vectorize Content first. Consumed
     * when that vectorization succeeds, cleared if they close the panel instead.
     *
     * Needed because the redirect is where the user's intent would otherwise be
     * lost: they turned the switch on, got taken somewhere else, finished the work
     * the switch required, and came back to it still off.
     *
     * Chat-scoped so an intent from one chat can never enable auto-sync on
     * another; null when nothing is pending.
     * @type {string|null}
     */
    let _autoSyncEnableAwaitingVectorizeForChat = null;

    /**
     * Turn Summarizer Injection off, because auto-sync — its data source — is not
     * running. Without auto-sync the collection stops tracking the chat, so
     * "the most recent N events" silently becomes some older N: the injection
     * keeps firing and feeds the model information that is simply wrong. Off is
     * the only safe state.
     *
     * Called from every path that leaves auto-sync off, including the two that
     * refuse to turn it on (no chat / no collection), which return early before
     * the off branch of the auto-sync switch.
     *
     * @param {string} reason - why auto-sync is off, for the console
     */
    const _disableSummarizerInjectionBecauseAutoSyncIsOff = (reason) => {
        if (!settings.summarizer_injection_enabled) return;
        settings.summarizer_injection_enabled = false;
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        $('#VectFox_summarizer_injection_enabled').prop('checked', false);
        _applySummarizerLock();
        log.lifecycle(`[AutoSync] Summarizer Injection turned off: ${reason}`);
    };

    // Auto-sync on or off for the open chat's collection.
    // Initial state is set by refreshAutoSyncCheckbox() after chat loads
    $('#VectFox_autosync_enabled')
        .on('input', async function() {
            const enabling = $(this).prop('checked');
            const $checkbox = $(this);

            const { getChatAutoSyncStatus } = await import('../eventbase/index.js');
            const { setCollectionAutoSync, setCollectionLock } = await import('../collections/index.js');
            let status = await getChatAutoSyncStatus(settings);
            const chatId = getCurrentChatId();
            log.lifecycle(`[AutoSync][checkbox] ${enabling ? 'CHECK' : 'UNCHECK'} → status.state=${status.state}, chatId=${chatId || '(none)'}, collection=${status.registryKey || status.collectionId || '(none)'}`);

            if (status.state === 'no-chat') {
                toastr.warning('Open a chat first before enabling auto-sync');
                $checkbox.prop('checked', false);
                _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync');
                await refreshAutoSyncCheckbox(settings);
                return;
            }

            if (enabling) {
                if (status.state === 'no-collection') {
                    // A branch or checkpoint can take its parent's events instead of
                    // re-extracting the shared history.
                    const forkChoice = await _offerEventBaseFork(settings);
                    if (forkChoice === 'cancel') {
                        $checkbox.prop('checked', false);
                        _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync');
                        await refreshAutoSyncCheckbox(settings);
                        return;
                    }
                    if (forkChoice === 'forked') {
                        status = await getChatAutoSyncStatus(settings);
                        log.lifecycle(`[AutoSync][checkbox] forked → status.state=${status.state}, collection=${status.registryKey || status.collectionId || '(none)'}`);
                        if (status.state === 'no-collection') {
                            log.error('[AutoSync][checkbox] fork finished but resolveEventBaseWriteTarget still finds no collection — see [EventBase][resolve] log above');
                            toastr.error('The forked EventBase is not recognized as this chat\'s collection. Check the console log.', 'Auto-sync not enabled');
                            $checkbox.prop('checked', false);
                            _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync');
                            await refreshAutoSyncCheckbox(settings);
                            return;
                        }
                    }
                }
                if (status.state === 'no-collection') {
                    // No collection for this chat yet — send the user to vectorize first.
                    log.lifecycle('[AutoSync][checkbox] state=no-collection → redirecting to Vectorize Content (resolveEventBaseWriteTarget found no eligible collection — see [EventBase][resolve] log above)');
                    $checkbox.prop('checked', false);
                    toastr.info('Vectorize your chat history first — auto-sync will turn on when it finishes');
                    _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync, which needs a vectorized chat');
                    // Remember the intent across the redirect so a finished
                    // vectorization resumes the enable the user actually asked for.
                    _autoSyncEnableAwaitingVectorizeForChat = chatId;
                    openContentVectorizer('chat');
                    return;
                }
                // Collection exists (partial or fully-vectorized).
                // Use registry-key form ("backend:id") so metadata writes land in the
                // same bucket as the loader/import path.
                const lockKey = status.registryKey || status.collectionId;

                // --- Backlog catch-up gate ---
                // Auto-sync backfills the whole gap (tip → now) on its next trigger —
                // for a large gap that's a surprise burst of LLM calls. So for a big
                // gap, confirm first: run the catch-up now (with progress) or skip it
                // ("just keep up from here"). Small gaps catch up silently as before.
                // See InternalProject/Vectfox/plans/executed/autosync-backlog-catchup-on-enable.md.
                let markerFloorOverride; // undefined → smart placement (catch up to tip)
                try {
                    const { FAR_BEHIND_WINDOW_COUNT, countWindowsBehind, getAutoSyncWindowSize, getVectorizationTip } = await import('../eventbase/index.js');
                    const { getChatUUID } = await import('../../shared/collection-ids.js');
                    const uuid = getChatUUID();
                    const chatMsgCount = typeof status.chatMessageCount === 'number'
                        ? status.chatMessageCount
                        : (getContext()?.chat || []).filter(m => m.mes && m.mes.trim().length > 0).length;
                    const tip = getVectorizationTip(uuid) ?? 0;
                    const windowSize = Math.max(1, getAutoSyncWindowSize(settings));
                    // Clamp the backlog to the commit boundary — the active last turn is
                    // held back by the settle-lag and settles on its own, so it isn't
                    // "pending backlog". See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
                    const boundary = typeof status.commitBoundary === 'number' ? status.commitBoundary : chatMsgCount;
                    const pendingMsgs = Math.max(0, boundary - tip);
                    const pendingWindows = countWindowsBehind(boundary, tip, windowSize);

                    if (pendingWindows >= FAR_BEHIND_WINDOW_COUNT) {
                        const { choicePopup } = await import('../../sillytavern/popup.js');
                        const choice = await choicePopup([
                            { icon: 'fa-clock-rotate-left', text: 'Messages not vectorized yet:', name: String(pendingMsgs) },
                            { text: 'Extraction calls, about:', name: String(pendingWindows) },
                            { text: 'Catch up now reads them with a progress bar you can stop. Keep up from here skips them. Cancel leaves auto-sync off.' },
                        ], { choices: [{ text: 'Catch up now', value: 'catch-up' }, { text: 'Keep up from here', value: 'keep-up' }] });
                        if (choice === 'catch-up') {
                            // Run the backfill now with the progress panel. Resolves at
                            // extraction completion; the marker then lands at the
                            // freshly-advanced tip (smart placement below).
                            const { backfillCurrentChatWithProgress } = await import('../chunkbase/index.js');
                            await backfillCurrentChatWithProgress();
                        } else if (choice === 'keep-up') {
                            // Keep up from here — skip the backlog (floor the marker at "now").
                            markerFloorOverride = 'chatLength';
                        } else {
                            // Cancel or Escape — abort enabling entirely.
                            $checkbox.prop('checked', false);
                            _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync');
                            await refreshAutoSyncCheckbox(settings);
                            return;
                        }
                    }
                } catch (err) {
                    log.warn('[VectFox] auto-sync backlog gate failed (continuing with default placement):', err?.message || err);
                }

                // Lock + enable (every non-revert path).
                setCollectionLock(lockKey, chatId);
                setCollectionAutoSync(lockKey, true);

                // Stamp the auto-sync start marker for this chat. Prevents the
                // window-fingerprint dedup cache from triggering a full chat
                // re-extraction when the user changed window_size before enabling
                // auto-sync. See InternalProject/Vectfox/plans/executed/autosync-independent-window-and-last-n-injection.md §9.
                // Smart placement: stamps at max(source_window_end)+1 when events
                // exist (backfills the gap at the new window size), or at current
                // chat length when collection is empty. markerFloorOverride='chatLength'
                // forces from-now-on when the user chose "just keep up from here".
                try {
                    const { stampAutoSyncMarker } = await import('../eventbase/index.js');
                    const { getChatUUID } = await import('../../shared/collection-ids.js');
                    const uuid = getChatUUID();
                    if (uuid) await stampAutoSyncMarker(uuid, settings, markerFloorOverride ? { floor: markerFloorOverride } : {});
                } catch (err) {
                    log.warn('[VectFox] Failed to stamp auto-sync marker on enable:', err?.message || err);
                }

                log.lifecycle(`VectFox: Chat auto-sync ENABLED for ${lockKey} (state=${status.state})`);
            } else {
                // Reverse of the forward bind in the summarizer checkbox handler; the
                // injection self-clears on its next (now-disabled) turn.
                _disableSummarizerInjectionBecauseAutoSyncIsOff('needs auto-sync');

                // Off clears ONLY the auto-sync flag, never the chat lock: the lock marks
                // the collection active for this chat's retrieval too, and the user may
                // have set it in the DB Browser. Unlocking is the DB Browser's job.
                if (status.state !== 'no-collection') {
                    const lockKey = status.registryKey || status.collectionId;
                    setCollectionAutoSync(lockKey, false);

                    // Clear the marker so re-enabling later re-computes a fresh one
                    // against whatever collection state exists at that time.
                    try {
                        const { clearAutoSyncMarker } = await import('../eventbase/index.js');
                        const { getChatUUID } = await import('../../shared/collection-ids.js');
                        const uuid = getChatUUID();
                        if (uuid) clearAutoSyncMarker(uuid);
                    } catch (err) {
                        log.warn('[VectFox] Failed to clear auto-sync marker on disable:', err?.message || err);
                    }

                    log.lifecycle(`VectFox: Chat auto-sync DISABLED for ${lockKey}`);
                }
            }

            await refreshAutoSyncCheckbox(settings);
            document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
        });

    // The EventBase model's Provider, and its profile rows: connection-rows.js.
    $('#VectFox_summarize_model')
        .val(settings.chat_model || '')
        .on('input change', function() {
            // Bind 'input' too — 'change' alone only fires on blur, so clicking Vectorize
            // immediately after typing would skip the save.
            settings.chat_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Request-shape switches for reasoning models. Global on purpose — they
    // describe the chat endpoint, not one feature, and every LLM path reads them
    // through resolveModelParameterStyle(). See src/features/llm-provider/llm-provider-call.js.
    $('#VectFox_should_send_temperature')
        .prop('checked', settings.should_send_temperature !== false)
        .on('change', function() {
            settings.should_send_temperature = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_should_use_max_completion_tokens')
        .prop('checked', settings.should_use_max_completion_tokens === true)
        .on('change', function() {
            settings.should_use_max_completion_tokens = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_should_disable_thinking')
        .prop('checked', settings.should_disable_thinking !== false)
        .on('change', function() {
            settings.should_disable_thinking = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // "Choose" button — fetches model list from the configured provider and populates a dropdown
    $('#VectFox_summarize_model_choose').on('click', async function() {
        const $btn = $(this);
        const $list = $('#VectFox_summarize_model_list');
        const $input = $('#VectFox_summarize_model');
        const provider = settings.chat_provider || 'openrouter';

        const originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');

        try {
            let models = [];

            if (provider === 'openrouter') {
                // OpenRouter /models is a public endpoint — no auth required for listing
                const resp = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                models = (data?.data || []).map(m => ({ id: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id }));
            } else if (provider === 'vllm') {
                // Send the URL verbatim (trailing slash trimmed only). ST's /status
                // does urlJoin(custom_url, '/models'), appending '/models' to exactly
                // what we pass — it does NOT re-insert a version segment. Stripping a
                // trailing '/v1' here made ST call <host>/models instead of
                // <host>/v1/models, breaking model listing on every standard
                // OpenAI-compatible endpoint (vLLM, OpenRouter, etc.). The summarizer
                // and embedding call sites already pass the user's '/v1' through; this
                // matches them. See GitHub issue #8.
                const baseUrl = (settings.chat_vllm_url || '').trim().replace(/\/+$/, '');
                if (!baseUrl) {
                    toastr.error('Set the vLLM Base URL first.', 'vLLM not configured');
                    return;
                }
                // Route through ST's chat-completions /status endpoint, which
                // fetches ${apiUrl}/models server-side using SECRET_KEYS.CUSTOM.
                // The browser only sees the key masked, so a direct fetch with a
                // Bearer header would 401. Same proxy pattern as the extractors'
                // _callVLLM.
                const resp = await fetch('/api/backends/chat-completions/status', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        chat_completion_source: 'custom',
                        custom_url: baseUrl,
                    }),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                // ST's /status returns `{ error: true, data: <upstreamBody> }`
                // when the upstream endpoint rejects the request (auth, bad
                // URL, etc.). Surface the upstream detail so the user can act
                // on it — generic "fetch failed" hides which side broke.
                if (data?.error === true) {
                    const detail = data.data
                        ? (typeof data.data === 'string' ? data.data : JSON.stringify(data.data))
                        : '(no detail returned)';
                    log.warn('[VectFox] Upstream rejected model-list request:', data.data);
                    // Common cause is the endpoint not exposing /v1/models at all
                    // (siliconflow, some hosted vLLM-compatible providers do this
                    // even when /v1/chat/completions and /v1/embeddings work fine
                    // with the same key). Summarize still works — type the model
                    // name manually instead of using the Choose button.
                    throw new Error(`Upstream /v1/models rejected the request. Detail: ${detail.slice(0, 200)}. If embedding/summarize works with this URL+key, the endpoint probably just doesn't expose model listing — type the model name manually.`);
                }
                // OpenAI standard: `{ data: [...] }`, Cohere: `{ models: [...] }`,
                // some bare endpoints return an array directly.
                const arr = Array.isArray(data) ? data
                          : Array.isArray(data?.data) ? data.data
                          : Array.isArray(data?.models) ? data.models
                          : null;
                if (!arr) {
                    log.warn('[VectFox] Model list response shape unrecognized:', data);
                    throw new Error(`Unrecognized model-list response shape (top-level keys: ${Object.keys(data || {}).join(',') || 'none'})`);
                }
                models = arr
                    .filter(m => m && (m.id || m.name))
                    .map(m => ({ id: m.id || m.name, label: m.id || m.name }));
            } else {
                toastr.warning(`Choose is not supported for provider "${provider}".`);
                return;
            }

            if (!models.length) {
                toastr.warning('Provider returned no models.');
                return;
            }

            models.sort((a, b) => a.id.localeCompare(b.id));

            const currentValue = String($input.val() || '').trim();
            const options = ['<option value="">— Select a model —</option>']
                .concat(models.map(m => {
                    const selected = m.id === currentValue ? ' selected' : '';
                    return `<option value="${$('<div>').text(m.id).html()}"${selected}>${$('<div>').text(m.label).html()}</option>`;
                }));

            $list.html(options.join('')).show();
            log.lifecycle(`VectFox: loaded ${models.length} models from ${provider}.`);
        } catch (err) {
            log.error('[VectFox] Model list fetch failed:', err);
            toastr.error(`Could not fetch model list: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $('#VectFox_summarize_model_list').on('change', function() {
        const value = String($(this).val() || '').trim();
        if (!value) return;
        $('#VectFox_summarize_model').val(value).trigger('change');
        $(this).hide();
    });

    $('#VectFox_summarize_vllm_url')
        .val(settings.chat_vllm_url || '')
        .on('change', function() {
            settings.chat_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM API key (summarize input). One key serves chat and embedding: it is written to
    // SECRET_KEYS.CUSTOM, the slot SillyTavern's Custom (OpenAI-compatible) chat source uses, for the
    // summarize and Agent Mode calls that go through /api/backends/chat-completions/generate with
    // `chat_completion_source: 'custom'`, and to SECRET_KEYS.VLLM for embedding. The key stays
    // server-side, and the input says only "Key saved": SillyTavern's masked value ends with the key's last
    // characters, so no part of it is shown. See src/shared/api-keys.js.
    //
    // Each display function also listens for the `vectfox:vllm-key-changed` event, so saving the key in
    // any of the three inputs updates all three placeholders.
    const updateSummarizeVllmKeyDisplay = () => {
        const savedKey = getCustomApiKey();
        if (savedKey) {
            $('#VectFox_summarize_vllm_apikey').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_summarize_vllm_apikey').attr('placeholder', 'Paste a key to save it');
        }
    };
    updateSummarizeVllmKeyDisplay();
    $(document).on('vectfox:vllm-key-changed', updateSummarizeVllmKeyDisplay);
    wireKeyBox('#VectFox_summarize_vllm_apikey', VLLM_KEY_BOX);

    // OpenRouter API key (summarize input). One key serves embedding, summarize and Agent Mode: it is
    // written to SECRET_KEYS.OPENROUTER, the slot SillyTavern's own connection profiles use. The key
    // stays server-side; the input says only "Key saved", and chat-completion calls go through
    // SillyTavern's /api/backends/chat-completions/generate proxy, which reads it. See
    // src/shared/api-keys.js.
    //
    // Each display function also listens for the `vectfox:openrouter-key-changed` event, so saving the
    // key in any of the three inputs updates all three placeholders.
    const updateSummarizeORKeyDisplay = () => {
        const savedKey = getOpenRouterApiKey();
        if (savedKey) {
            $('#VectFox_summarize_openrouter_apikey').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_summarize_openrouter_apikey').attr('placeholder', 'Paste a key to save it');
        }
    };
    updateSummarizeORKeyDisplay();
    $(document).on('vectfox:openrouter-key-changed', updateSummarizeORKeyDisplay);
    wireKeyBox('#VectFox_summarize_openrouter_apikey', OPENROUTER_KEY_BOX);

    // ─── AgentMode page ────────────────────────────────────────────────────
    // The planner's Provider, which rows it shows, and its profile rows: connection-rows.js.
    $('#VectFox_agentic_retrieval_enabled')
        .prop('checked', !!settings.agentic_retrieval_enabled)
        .on('change', function() {
            settings.agentic_retrieval_enabled = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_story_arc_mode_enabled')
        .prop('checked', !!settings.story_arc_mode_enabled)
        .on('change', function() {
            settings.story_arc_mode_enabled = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_story_arc_link_model')
        .val(settings.story_arc_link_model)
        .on('input change', function() {
            settings.story_arc_link_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    bindNumberSetting(settings, { id: 'VectFox_story_arc_block_scale', key: 'story_arc_block_scale', initial: settings.story_arc_block_scale });

    $('#VectFox_story_arc_debug')
        .prop('checked', settings.debug_domain?.story_arc || false)
        .on('change', function() {
            if (!settings.debug_domain) settings.debug_domain = {};
            settings.debug_domain.story_arc = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    wireStoryArcPage(settings);

    $('#VectFox_story_arc_regenerate_links').on('click', async function() {
        const $button = $(this).prop('disabled', true);
        try {
            await _runStoryLinkButton(settings);
        } catch (err) {
            log.error('VectFox StoryArc: link pass failed:', err);
            toastr.error(`Link pass failed: ${err.message}`, 'VectFox StoryArc');
        } finally {
            $button.prop('disabled', false);
            refreshStoryLinkStatus(settings);
        }
    });

    $('#VectFox_agentic_model')
        .val(settings.agent_model || '')
        .on('input change', function() {
            settings.agent_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Agent Mode OpenRouter input — writes SECRET_KEYS.OPENROUTER, the slot the
    // Embedding and Summarize inputs share: one OpenRouter key everywhere.
    const updateAgenticORKeyDisplay = () => {
        const savedKey = getOpenRouterApiKey();
        if (savedKey) {
            $('#VectFox_agentic_openrouter_apikey').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_agentic_openrouter_apikey').attr('placeholder', 'Paste a key to save it');
        }
    };
    updateAgenticORKeyDisplay();
    $(document).on('vectfox:openrouter-key-changed', updateAgenticORKeyDisplay);
    wireKeyBox('#VectFox_agentic_openrouter_apikey', OPENROUTER_KEY_BOX);

    $('#VectFox_agentic_vllm_url')
        .val(settings.agent_vllm_url || '')
        .on('change', function() {
            settings.agent_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Agent Mode vLLM input — writes SECRET_KEYS.CUSTOM (read by the chat-side
    // proxy, `chat_completion_source: 'custom'`) and SECRET_KEYS.VLLM (read by
    // embedding), the same two slots the Embedding and Summarize vLLM inputs write.
    const updateAgenticVllmKeyDisplay = () => {
        const savedKey = getCustomApiKey();
        if (savedKey) {
            $('#VectFox_agentic_vllm_apikey').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_agentic_vllm_apikey').attr('placeholder', 'Paste a key to save it');
        }
    };
    updateAgenticVllmKeyDisplay();
    $(document).on('vectfox:vllm-key-changed', updateAgenticVllmKeyDisplay);
    wireKeyBox('#VectFox_agentic_vllm_apikey', VLLM_KEY_BOX);

    // The 6 trash buttons (Embedding, Summarize and Agent Mode, for OpenRouter and vLLM) each delete the key their
    // provider uses now in every slot its key box saves in (api-key-boxes.js).
    ['#VectFox_openrouter_apikey_clear', '#VectFox_summarize_openrouter_apikey_clear', '#VectFox_agentic_openrouter_apikey_clear']
        .forEach(sel => $(sel).on('click', () => clearKeyBox(OPENROUTER_KEY_BOX)));
    ['#VectFox_vllm_api_key_clear', '#VectFox_summarize_vllm_apikey_clear', '#VectFox_agentic_vllm_apikey_clear']
        .forEach(sel => $(sel).on('click', () => clearKeyBox(VLLM_KEY_BOX)));

    bindNumberSetting(settings, { id: 'VectFox_agentic_chat_depth', key: 'agentic_retrieval_chat_depth', initial: settings.agentic_retrieval_chat_depth ?? 3, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_agentic_max_queries', key: 'agentic_retrieval_max_queries', initial: settings.agentic_retrieval_max_queries ?? 6, isInteger: true });

    // The two timeouts and the token cap clamp through the same resolvers the retrieval
    // path uses, so what a box accepts and what the budget honors can never drift apart.
    $('#VectFox_agentic_timeout')
        .val(resolveAgenticPlannerTimeoutMs(settings))
        .on('change input', function() {
            settings.agentic_retrieval_timeout_ms = resolveAgenticPlannerTimeoutMs({ agentic_retrieval_timeout_ms: $(this).val() });
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_agentic_query_timeout')
        .val(resolveAgenticQueryTimeoutMs(settings))
        .on('change input', function() {
            settings.agentic_retrieval_query_timeout_ms = resolveAgenticQueryTimeoutMs({ agentic_retrieval_query_timeout_ms: $(this).val() });
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_agentic_max_tokens')
        .val(resolveAgenticMaxTokens(settings))
        .on('change input', function() {
            settings.agentic_retrieval_max_tokens = resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: $(this).val() });
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });


    // ─── Auto-Reformat (Document/URL/Wiki LLM restructuring) ───────────────
    // Same as EventBase model, and a blank model or URL, use the EventBase model's (Core page), as on
    // the AgentMode page (resolveInheritedConnection). No key fields: it uses the shared OpenRouter and vLLM key slots.
    // Its Provider and profile rows: connection-rows.js.
    $('#VectFox_reformat_model')
        .val(settings.reformat_model || '')
        .on('input change', function() {
            settings.reformat_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_reformat_vllm_url')
        .val(settings.reformat_vllm_url || '')
        .on('change', function() {
            settings.reformat_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    bindNumberSetting(settings, { id: 'VectFox_reformat_batch_chars', key: 'reformat_batch_chars', initial: settings.reformat_batch_chars ?? 6000, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_reformat_max_body_chars', key: 'reformat_max_body_chars', initial: settings.reformat_max_body_chars ?? 2000, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_reformat_name_fuzzy_threshold', key: 'reformat_name_fuzzy_threshold', initial: settings.reformat_name_fuzzy_threshold ?? 0.8 });
    bindNumberSetting(settings, { id: 'VectFox_reformat_concurrency', key: 'reformat_concurrency', initial: settings.reformat_concurrency ?? 2, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_reformat_timeout_ms', key: 'reformat_timeout_ms', initial: settings.reformat_timeout_ms ?? 90000, isInteger: true });

    $('#VectFox_reformat_custom_prompt')
        .val(settings.reformat_custom_prompt || '')
        .on('change', function() {
            settings.reformat_custom_prompt = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Helper: update visibility of native-hybrid-dependent UI elements
    function updateNativeHybridUI() {
        const backend       = settings.vector_backend || 'standard';
        const method        = settings.keyword_scoring_method || 'hybrid';
        const supportsNative = backend === 'qdrant';
        const preferNative  = settings.hybrid_native_prefer !== false;
        const nativeActive  = supportsNative && preferNative;        // A3
        const isHybridMode  = !nativeActive && method === 'hybrid';  // A2 (or Qdrant+prefer=false fallback)

        // Keyword scoring method dropdown vs static "native active" notice
        $('#VectFox_keyword_method_section').toggle(!nativeActive);
        $('#VectFox_native_hybrid_info').toggle(nativeActive);

        // BM25 k1/b: visible whenever client-side BM25 logic runs (A1 or A2)
        $('#VectFox_bm25_params').toggle(!nativeActive);

        // Fusion Method + RRF K: visible only for A2 (Standard + Hybrid). A3 (Qdrant) ignores
        // these — Qdrant always runs server-side RRF with its own internal k constant — so the
        // controls would just confuse Qdrant users.
        $('#VectFox_hybrid_params').toggle(isHybridMode);

        // Query keyword budget (ChunkBase page): read by client-side BM25, so A1 and A2
        $('#VectFox_hybrid_keyword_budget_wrapper').toggle(!nativeActive);

        // Native rerank checkbox: Qdrant only
        $('#VectFox_eventbase_native_rerank_wrapper').toggle(supportsNative);
    }

    // Apply backend-specific hybrid defaults when backend changes or on first load.
    // Only rewrites settings that make sense for the new backend — does not touch user-tuned values
    // like rrf_k, vector/text weights, or BM25 k1/b.
    function applyBackendHybridDefaults(backend) {
        const isNative = backend === 'qdrant';
        if (isNative) {
            // Qdrant: prefer native hybrid, RRF fusion
            settings.hybrid_native_prefer = true;
            settings.hybrid_fusion_method = settings.hybrid_fusion_method || 'rrf';
        } else {
            // Standard: no native hybrid, BM25 fast re-rank, RRF fusion
            settings.hybrid_native_prefer = false;
            settings.keyword_scoring_method = settings.keyword_scoring_method || 'hybrid';
            settings.hybrid_fusion_method = settings.hybrid_fusion_method || 'rrf';
        }
        // Sync UI controls
        $('#VectFox_keyword_scoring_method').val(settings.keyword_scoring_method || 'hybrid');
        $('#VectFox_hybrid_fusion_method').val(settings.hybrid_fusion_method || 'rrf');
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    }

    // Helper: gate the Qdrant backend on the Similharity server plugin being
    // installed. Qdrant depends entirely on the plugin's /api/plugins/similharity/...
    // endpoints, so when the plugin is absent we must prevent the user
    // from landing on Qdrant at all. Standard backend can fall back to ST's
    // native Vectors extension, but Qdrant cannot run without the plugin.
    //
    // Enforcement (called on init and after every dropdown change):
    //   1. Disable the <option value="qdrant"> so it can't be picked while the
    //      plugin is missing.
    //   2. If the current selection IS qdrant but the plugin is missing, revert
    //      to standard, persist it, and re-sync the dependent UI.
    //   3. Show/hide the red plugin-missing hint accordingly.
    // Returns true if it forced a revert (caller may need to re-run side effects).
    async function _refreshQdrantPluginAvailability() {
        const $err = $('#VectFox_qdrant_plugin_error');
        const pluginUp = await checkPluginAvailable();

        // 1. Bar selecting Qdrant up front when the plugin is absent.
        $('#VectFox_vector_backend option[value="qdrant"]').prop('disabled', !pluginUp);

        // Persistent "why is Qdrant disabled?" notice (with install link) —
        // visible whenever the plugin is missing, regardless of current backend.
        $('#VectFox_qdrant_plugin_notice').toggle(!pluginUp);

        const backend = settings.vector_backend || 'standard';
        const mustRevert = backend === 'qdrant' && !pluginUp;

        // 3. Red hint visible only while we're (briefly) on qdrant without a plugin.
        if ($err.length) $err.toggle(mustRevert);

        // 2. Force the selection back to Standard.
        if (mustRevert) {
            settings.vector_backend = 'standard';
            $('#VectFox_vector_backend').val('standard');
            $('#VectFox_qdrant_settings').hide();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toastr.warning(
                'Qdrant requires the Similharity server plugin, which is not installed. Switched back to Standard (ST Vectra). Install the plugin to use Qdrant.',
                'VectFox — Qdrant unavailable',
                { timeOut: 8000 }
            );
        }
        return mustRevert;
    }

    // Vector backend selection
    $('#VectFox_vector_backend')
        .val(settings.vector_backend || 'qdrant')
        .on('change', async function() {
            settings.vector_backend = String($(this).val());

            // Show/hide Qdrant settings
            if (settings.vector_backend === 'qdrant') {
                $('#VectFox_qdrant_settings').show();
            } else {
                $('#VectFox_qdrant_settings').hide();
            }

            // Bar Qdrant when the plugin is missing: this shows a red alert and
            // reverts settings.vector_backend to 'standard' in place. Await it so
            // the dependent UI below syncs to the *effective* backend, not the
            // one the user briefly clicked.
            await _refreshQdrantPluginAvailability();

            // No feature is switched off on the standard backend: _vectraWriteQueues in
            // src/features/vector-backend/standard.js serializes inserts per collection, so hedge,
            // parallel-split and pipelined mode stay on. Hedge duplicates queue behind the primary instead
            // of racing it, so a hedge helps less here than on Qdrant.
            applyBackendHybridDefaults(settings.vector_backend);
            updateNativeHybridUI();
            log.lifecycle(`VectFox: Vector backend changed to ${settings.vector_backend}`);
            // Reset health cache so new backend gets properly initialized
            resetBackendHealth();
            // Refresh Cosine weight availability — backend switch may have
            // moved us into or out of the "no vector scoring" state.
            _refreshCosineWeightAvailability?.();
            // Same for Summarizer Injection — hidden on standard+no-plugin.
            _refreshSummarizerInjectionAvailability?.();
        });

    // Qdrant cloud toggle.
    //
    // Visibility and re-initialization are deliberately SEPARATE. This used to be one
    // handler ending in `.trigger('change')`, which meant simply rendering the settings
    // panel reset backend health, eagerly initialized the Qdrant backend, pushed config
    // to the Similharity plugin, and popped a success toast — on every page load, even
    // with the VectFox master switch off. Backend init is already lazy (getBackend →
    // initializeBackend), so nothing needs that eager call. Only a real user-driven
    // mode change should re-initialize.
    const applyQdrantModeVisibility = (useCloud) => {
        $('#VectFox_qdrant_local_settings').toggle(!useCloud);
        $('#VectFox_qdrant_cloud_settings').toggle(!!useCloud);
    };

    $('#VectFox_qdrant_use_cloud')
        .prop('checked', settings.qdrant_use_cloud || false)
        .on('change', async function() {
            settings.qdrant_use_cloud = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();

            applyQdrantModeVisibility(settings.qdrant_use_cloud);

            // Reset backend health to force re-initialization with new config
            log.lifecycle('VectFox: Qdrant mode changed, forcing re-initialization...');
            resetBackendHealth('qdrant');

            // Proactively reinitialize if Qdrant is the current backend
            if (settings.vector_backend === 'qdrant') {
                try {
                    const { initializeBackend } = await import('../vector-backend/index.js');
                    await initializeBackend('qdrant', settings, false);
                    log.lifecycle(`VectFox: Qdrant re-initialized in ${settings.qdrant_use_cloud ? 'cloud' : 'local'} mode.`);
                } catch (e) {
                    log.error('VectFox: Failed to reinitialize Qdrant:', e);
                    toastr.warning('Failed to reinitialize Qdrant: ' + e.message, 'VectFox');
                }
            }
        });

    // Initial state only — no health reset, no backend init, no toast.
    applyQdrantModeVisibility(settings.qdrant_use_cloud || false);

    // Qdrant settings
    $('#VectFox_qdrant_host')
        .val(settings.qdrant_host || '127.0.0.1')
        .on('input', function() {
            settings.qdrant_host = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_qdrant_port')
        .val(settings.qdrant_port || 6333)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.qdrant_port = isNaN(value) ? 6333 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_qdrant_url')
        .val(settings.qdrant_url || '')
        .on('input', function() {
            settings.qdrant_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Qdrant API key — stored in ST's secret_state under the custom slot
    // 'api_key_qdrant'. Client-side secret_state filters non-enum slots, so
    // whether a key is saved comes from the plugin's /qdrant/key-status
    // endpoint, asynchronously. No part of a key is shown.
    const updateQdrantKeyDisplay = async () => {
        try {
            const presence = await fetchQdrantApiKeyPresence();
            if (presence.set) {
                $('#VectFox_qdrant_api_key').attr('placeholder', 'Key saved');
            } else {
                $('#VectFox_qdrant_api_key').attr('placeholder', 'Your Qdrant Cloud API key');
            }
        } catch (err) {
            log.warn('VectFox: Qdrant API key presence check failed:', err);
            $('#VectFox_qdrant_api_key').attr('placeholder', 'Your Qdrant Cloud API key (presence check unavailable)');
        }
    };
    updateQdrantKeyDisplay();
    $(document).on(QDRANT_KEY_BOX.changedEvent, updateQdrantKeyDisplay);
    wireKeyBox('#VectFox_qdrant_api_key', QDRANT_KEY_BOX);

    // Qdrant multitenancy toggle
    $('#VectFox_qdrant_multitenancy')
        .prop('checked', settings.qdrant_multitenancy || false)
        .on('change', function() {
            settings.qdrant_multitenancy = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Show Qdrant settings if backend is qdrant
    if (settings.vector_backend === 'qdrant') {
        $('#VectFox_qdrant_settings').show();
    }

    // On initial load: disable the Qdrant option when the plugin is absent and,
    // if the saved backend was Qdrant, revert to Standard (with a red alert).
    // When it reverts, re-sync the backend-dependent UI to Standard.
    _refreshQdrantPluginAvailability().then((reverted) => {
        if (reverted) {
            applyBackendHybridDefaults('standard');
            updateNativeHybridUI();
            resetBackendHealth();
            _refreshCosineWeightAvailability?.();
            _refreshSummarizerInjectionAvailability?.();
        }
    });

    // Similarity threshold (ChunkBase page). Event searches use EventBase's own (eventbase-search.js).
    bindNumberSetting(settings, { id: 'VectFox_score_threshold', key: 'score_threshold', initial: settings.score_threshold ?? CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT });

    // "Skip Already-Visible Events" (legacy key name: deduplication_depth).
    // Default 0 = filter disabled. See settings comment in index.js — the assumption
    // that the LLM sees the last N messages in raw form is usually wrong (~3-6 in
    // practice), so this is opt-in only.
    bindNumberSetting(settings, { id: 'VectFox_deduplication_depth', key: 'deduplication_depth', initial: settings.deduplication_depth ?? 0, isInteger: true });

    // EventBase Dedup Window Gap — temporal proximity threshold for the
    // dedup gate in eventbase-retrieval.js. See settings comment in index.js.
    // 0 = temporal dedup fully disabled.
    bindNumberSetting(settings, { id: 'VectFox_eventbase_dedup_window_gap', key: 'eventbase_dedup_window_gap', initial: settings.eventbase_dedup_window_gap ?? 10, isInteger: true });

    // EventBase Anchor Boost — flat additive bonus on keyword-anchored events.
    // See settings comment in index.js and the boost code in
    // eventbase-retrieval.js (around the `_finalScore` formula).
    bindNumberSetting(settings, { id: 'VectFox_eventbase_anchor_boost', key: 'eventbase_anchor_boost', initial: settings.eventbase_anchor_boost ?? 0.20 });

    // Keyword scoring method (bm25 = A1 fast re-rank; hybrid = A2 client-side hybrid fusion, ANN-bound ≤100)
    $('#VectFox_keyword_scoring_method')
        .val(settings.keyword_scoring_method || 'hybrid')
        .on('change', function() {
            settings.keyword_scoring_method = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            log.lifecycle(`VectFox: Keyword scoring method changed to ${settings.keyword_scoring_method}`);
            updateNativeHybridUI();
        });

    // Hybrid keyword level
    $('#VectFox_hybrid_keyword_level')
        .val(settings.hybrid_keyword_level || 'balance')
        .on('change', function() {
            settings.hybrid_keyword_level = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            log.lifecycle(`VectFox: Hybrid keyword level changed to ${settings.hybrid_keyword_level}`);
        });

    // BM25 k1 parameter
    bindNumberSetting(settings, { id: 'VectFox_bm25_k1', key: 'bm25_k1', initial: settings.bm25_k1 || 1.5 });

    // BM25 b parameter
    bindNumberSetting(settings, { id: 'VectFox_bm25_b', key: 'bm25_b', initial: settings.bm25_b || 0.75 });

    // BM25 corpus-wide IDF, read by hybrid-search.js and vector-api.js
    $('#VectFox_bm25_use_corpus_idf')
        .prop('checked', settings.bm25_use_corpus_idf === true)
        .on('change', function() {
            settings.bm25_use_corpus_idf = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // ========== Hybrid Search Settings ==========

    // Fusion method selector
    $('#VectFox_hybrid_fusion_method')
        .val(settings.hybrid_fusion_method || 'rrf')
        .on('change', function() {
            settings.hybrid_fusion_method = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            // Show weights only for weighted method, RRF settings for RRF
            const isWeighted = settings.hybrid_fusion_method === 'weighted';
            $('#VectFox_hybrid_weights').toggle(isWeighted);
            $('#VectFox_hybrid_rrf_settings').toggle(!isWeighted);
            log.lifecycle(`VectFox: Hybrid fusion method changed to ${settings.hybrid_fusion_method}`);
        });
    // Initialize visibility based on current method
    const isWeightedMethod = (settings.hybrid_fusion_method || 'rrf') === 'weighted';
    $('#VectFox_hybrid_weights').toggle(isWeightedMethod);
    $('#VectFox_hybrid_rrf_settings').toggle(!isWeightedMethod);

    // Vector weight slider
    bindNumberSetting(settings, { id: 'VectFox_hybrid_vector_weight', key: 'hybrid_vector_weight', initial: settings.hybrid_vector_weight ?? 0.5 });

    // Text weight slider
    bindNumberSetting(settings, { id: 'VectFox_hybrid_text_weight', key: 'hybrid_text_weight', initial: settings.hybrid_text_weight ?? 0.5 });

    // RRF K constant
    bindNumberSetting(settings, { id: 'VectFox_hybrid_rrf_k', key: 'hybrid_rrf_k', initial: settings.hybrid_rrf_k || 60, isInteger: true });

    // Initialize native-hybrid-dependent visibility
    updateNativeHybridUI();

    // Query depth (how many recent messages to include in search query)
    bindNumberSetting(settings, { id: 'VectFox_query_depth', key: 'query', initial: settings.query || 2, isInteger: true });

    // Results per collection (ChunkBase page): the chunk pipeline's top-K
    bindNumberSetting(settings, { id: 'VectFox_topk', key: 'top_k', initial: (settings.top_k ?? settings.insert) || 3, isInteger: true });

    // Auto-sync window (AutoSync page), in turns. A new size re-stamps the chat's auto-sync
    // marker, so auto-sync starts from the current tip instead of re-extracting the chat.
    bindNumberSetting(settings, { id: 'VectFox_eventbase_autosync_window_turns', key: 'eventbase_autosync_window_turns', initial: settings.eventbase_autosync_window_turns ?? 1, isInteger: true });
    let _stampedWindowTurns = settings.eventbase_autosync_window_turns ?? 1;
    $('#VectFox_eventbase_autosync_window_turns').on('change', async () => {
        if (settings.eventbase_autosync_window_turns === _stampedWindowTurns) return;
        _stampedWindowTurns = settings.eventbase_autosync_window_turns;
        try {
            const { stampAutoSyncMarker } = await import('../eventbase/index.js');
            const { getChatUUID } = await import('../../shared/collection-ids.js');
            const uuid = getChatUUID();
            if (uuid) await stampAutoSyncMarker(uuid, extension_settings.vectfox);
        } catch (err) {
            log.warn('[VectFox] Failed to re-stamp marker on auto-sync window change:', err?.message || err);
        }
    });

    // --- Summarizer Injection (AutoSync page) ---
    bindNumberSetting(settings, { id: 'VectFox_summarizer_injection_count', key: 'summarizer_injection_count', initial: settings.summarizer_injection_count ?? 20, isInteger: true });

    // Full event detail toggle (default ON — includes structured fields per event).
    $('#VectFox_summarizer_injection_full_detail')
        .prop('checked', settings.summarizer_injection_full_detail !== false)
        .on('change', function() {
            settings.summarizer_injection_full_detail = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Max injection size (characters). 0 = no cap.
    bindNumberSetting(settings, { id: 'VectFox_summarizer_injection_max_chars', key: 'summarizer_injection_max_chars', initial: settings.summarizer_injection_max_chars ?? 10000, isInteger: true });

    // Per-turn token-saved readout, fed by window.VectFox_LastGhost (set inside
    // applyGhosting on every enabled generation). Refreshed on init, on toggle, and
    // after each AI reply / swipe via the event subscriptions below.
    const _refreshGhostReadout = () => {
        const $el = $('#VectFox_eventbase_ghost_readout .vfx-notice-text');
        if ($el.length === 0) return;
        if (!settings.eventbase_ghost_enabled || !settings.summarizer_injection_enabled) {
            $el.text('Ghosting is off.');
            return;
        }
        const g = window.VectFox_LastGhost;
        if (!g || typeof g.wiped !== 'number') {
            $el.text('Last turn: no reply yet.');
        } else if (g.wiped === 0) {
            $el.text('Last turn: nothing blanked, as no vectorized message is older than those kept.');
        } else {
            const messages = g.wiped === 1 ? '1 message' : `${g.wiped.toLocaleString()} messages`;
            $el.html(`Last turn: <strong>${messages}</strong> blanked, about <strong>${g.approxTokens.toLocaleString()} tokens</strong> (${g.charsRemoved.toLocaleString()} characters) saved.`);
        }
    };

    // Ghosting needs Summarizer Injection on (the wipe checks it too): its controls are
    // disabled while it is off, and the Ghosting card says why.
    const _applyGhostAvailability = () => {
        const summOn = !!settings.summarizer_injection_enabled;
        const ghostOn = !!settings.eventbase_ghost_enabled;
        $('#VectFox_eventbase_ghost_enabled').prop('disabled', !summOn);
        $('#VectFox_eventbase_ghost_keep_recent, [data-vfx-slider-for="VectFox_eventbase_ghost_keep_recent"]').prop('disabled', !summOn || !ghostOn);
        $('#VectFox_eventbase_ghost_needs_summarizer').toggle(!summOn);
        _refreshGhostReadout();
    };

    // Refresh the readout after each generation completes (reply + swipe regenerate).
    eventSource.on(event_types.MESSAGE_RECEIVED, _refreshGhostReadout);
    eventSource.on(event_types.MESSAGE_SWIPED, _refreshGhostReadout);

    $('#VectFox_eventbase_ghost_enabled')
        .prop('checked', !!settings.eventbase_ghost_enabled)
        .on('change', function() {
            settings.eventbase_ghost_enabled = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            _applyGhostAvailability();
        });

    bindNumberSetting(settings, { id: 'VectFox_eventbase_ghost_keep_recent', key: 'eventbase_ghost_keep_recent', initial: settings.eventbase_ghost_keep_recent ?? 10, isInteger: true });

    // While Summarizer Injection is on, the auto-sync window is held at 1 turn, so each reply
    // is extracted before the next injection. The box's own events set it, which saves it and
    // re-stamps the marker, so the hold never sets off a re-extraction.
    const _applySummarizerLock = () => {
        const enabled = !!settings.summarizer_injection_enabled;
        const $window = $('#VectFox_eventbase_autosync_window_turns');
        if (enabled && settings.eventbase_autosync_window_turns !== 1) {
            $window.val(1).trigger('input').trigger('change');
        }
        $window.add('[data-vfx-slider-for="VectFox_eventbase_autosync_window_turns"]').prop('disabled', enabled);
        $('#VectFox_autosync_window_lock_hint').toggle(enabled);
        _applyGhostAvailability(); // ghosting requires summarizer injection — keep in sync
    };

    $('#VectFox_summarizer_injection_enabled')
        .prop('checked', !!settings.summarizer_injection_enabled)
        .on('change', function() {
            const enabling = $(this).prop('checked');
            settings.summarizer_injection_enabled = enabling;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            _applySummarizerLock();

            // "Most recent N events" is only meaningful if the collection stays current,
            // so turning the summarizer ON also turns auto-sync ON — reusing the auto-sync
            // switch's OWN enable flow (backlog catch-up gate, lock, marker stamp) rather
            // than duplicating it. Symmetric with the window hold above: while the
            // summarizer runs, both the window (1 turn) and auto-sync (on) are bound to it.
            //
            // That flow may REFUSE (no chat, or no collection yet), and being async it
            // cannot report back to this handler. It therefore turns the summarizer off
            // itself via _disableSummarizerInjectionBecauseAutoSyncIsOff, so the pair never
            // disagrees: a summarizer on beside auto-sync off would inject stale events as
            // if they were the latest.
            if (enabling) {
                const $autosync = $('#VectFox_autosync_enabled');
                if (!$autosync.prop('checked')) {
                    $autosync.prop('checked', true).trigger('input');
                }

                // Ghosting is the summarizer's main payoff — the wiped turns rely on
                // its injection for recall — so default it ON when the summarizer is
                // enabled. Soft default, NOT a hard lock (unlike the 1-turn window):
                // the ghost checkbox stays editable so the user can uncheck it. Reuses
                // the ghost checkbox's own change handler so the setting + availability
                // stay in sync.
                const $ghost = $('#VectFox_eventbase_ghost_enabled');
                if (!$ghost.prop('checked')) {
                    $ghost.prop('checked', true).trigger('change');
                }
            }
        });

    // Hide the Summarizer Injection and Ghosting cards on Standard without the plugin:
    // listChunks returns no metadata there, so there are no events to inject. Mirror of
    // _refreshCosineWeightAvailability; also called on vector-backend change.
    _refreshSummarizerInjectionAvailability = async function() {
        const $cards = $('#VectFox_summarizer_injection_group, #VectFox_eventbase_ghost_group');
        if ($cards.length === 0) return;
        const backend = settings.vector_backend || 'standard';
        const pluginUp = await checkPluginAvailable();
        $cards.toggle(!(backend === 'standard' && !pluginUp));
    };

    _applySummarizerLock();
    _refreshSummarizerInjectionAvailability();

    // Auto-sync popup toggle
    $('#VectFox_autosync_popup')
        .prop('checked', settings.eventbase_autosync_popup !== false)
        .on('change', function() {
            settings.eventbase_autosync_popup = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Auto-sync progress modal toggle (default: hidden)
    $('#VectFox_autosync_show_progress_modal')
        .prop('checked', settings.autosync_show_progress_modal === true)
        .on('change', function() {
            settings.autosync_show_progress_modal = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Per-turn retrieval budget. Clamped through the same resolver the retrieval
    // path uses, so the field can never accept a value the budget won't honor.
    $('#VectFox_retrieval_timeout_ms')
        .val(resolveRetrievalTimeoutMs(settings))
        .on('change input', function() {
            settings.retrieval_timeout_ms = resolveRetrievalTimeoutMs({ retrieval_timeout_ms: $(this).val() });
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Retrieval popups
    $('#VectFox_retrieval_popup_on_start')
        .prop('checked', settings.retrieval_popup_on_start || false)
        .on('change', function() {
            settings.retrieval_popup_on_start = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_retrieval_popup_on_result')
        .prop('checked', settings.retrieval_popup_on_result || false)
        .on('change', function() {
            settings.retrieval_popup_on_result = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Semantic activation (WorldInfo page). On needs an own-persona lorebook locked to this
    // chat; off removes the lock that makes each active one active.
    $('#VectFox_enabled_world_info')
        .prop('checked', settings.enabled_world_info || false)
        .on('change', async function() {
            const enabled = $(this).prop('checked');
            const $checkbox = $(this);

            // Single source of truth — getCollectionListing handles superadmin
            // bypass + creatorHandle ownership + isActive lock-state check.
            const ownLorebookEntries = getCollectionListing(settings)
                .filter(e => e.isOwn && e.collectionId.startsWith('vf_lorebook_'));

            const chatId = getCurrentChatId();
            const characterId = getContext()?.characterId;
            const { removeCollectionLock, removeCollectionCharacterLock } = await import('../collections/index.js');

            if (enabled) {
                if (ownLorebookEntries.length === 0) {
                    $checkbox.prop('checked', false);
                    toastr.info('Vectorize a lorebook first to use semantic activation');
                    openContentVectorizer('lorebook');
                    return;
                }

                const hasActive = ownLorebookEntries.some(e => e.isActive);
                if (!hasActive) {
                    $checkbox.prop('checked', false);
                    toastr.info('Lock a lorebook to this chat in Database Browser → Collection Settings');
                    openDatabaseBrowser();
                    return;
                }
            } else {
                // Uncheck mirrors Collection Settings uncheck: remove the lock that's making each
                // active own-persona lorebook active. After this, isActive returns false for all
                // of them and the listing badge drops the 🔒.
                let removed = 0;
                for (const e of ownLorebookEntries) {
                    if (!e.isActive) continue;
                    const lockKey = e.registryKey || e.collectionId;
                    if (e.meta.scope === 'chat' && chatId) {
                        removeCollectionLock(lockKey, chatId);
                        removed++;
                    } else if (e.meta.scope === 'character' && characterId) {
                        removeCollectionCharacterLock(lockKey, String(characterId));
                        removed++;
                    }
                }
                if (removed > 0) {
                    document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
                }
            }

            settings.enabled_world_info = enabled;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_world_info_settings').toggle(enabled);
        });

    // Matching (WorldInfo page). The threshold's floor is 0.01: retrieval reads 0 as its 0.3 default.
    bindNumberSetting(settings, { id: 'VectFox_world_info_threshold', key: 'world_info_threshold', initial: settings.world_info_threshold ?? 0.3 });
    bindNumberSetting(settings, { id: 'VectFox_world_info_top_k', key: 'world_info_top_k', initial: settings.world_info_top_k ?? 3, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_world_info_query_depth', key: 'world_info_query_depth', initial: settings.world_info_query_depth ?? 3, isInteger: true });

    $('#VectFox_world_info_retrieval_popup')
        .prop('checked', settings.world_info_retrieval_popup === true)
        .on('change', function() {
            settings.world_info_retrieval_popup = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Custom stopwords
    $('#VectFox_custom_stopwords')
        .val(settings.custom_stopwords || '')
        .on('input', function() {
            settings.custom_stopwords = $(this).val();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // CJK tokenizer mode selector
    $('#VectFox_cjk_tokenizer_mode')
        .val(settings.cjk_tokenizer_mode || CJK_TOKENIZER_MODES.intl)
        .on('change', async function() {
            const mode = String($(this).val());
            settings.cjk_tokenizer_mode = mode;
            setCjkTokenizerMode(mode);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();

            if (mode === CJK_TOKENIZER_MODES.jieba) {
                const ok = await ensureJiebaTokenizerLoaded();
                if (!ok) {
                    toastr.warning('Simplified Chinese Jieba tokenizer failed to load. Falling back to Intl.Segmenter.', 'VectFox CJK');
                }
            }

            if (mode === CJK_TOKENIZER_MODES.jieba_tw) {
                log.lifecycle('VectFox CJK: loading the Traditional Chinese dictionary (about 2–5 MB).');
                const ok = await ensureJiebaTwLoaded();
                if (ok) {
                    log.lifecycle('VectFox CJK: Traditional Chinese Jieba tokenizer ready.');
                } else {
                    toastr.warning('Traditional Chinese Jieba tokenizer failed to load. Falling back to Intl.Segmenter.', 'VectFox CJK');
                }
            }
        });

    // Initialize world info settings visibility based on current setting
    $('#VectFox_world_info_settings').toggle(settings.enabled_world_info || false);
    refreshWIStatus();
    document.addEventListener('vectfox:collections-updated', refreshWIStatus);
    eventSource.on(event_types.CHAT_CHANGED, refreshWIStatus);

    // Chat auto-sync UI also follows the same events: collection list changes
    // (e.g. chat just got vectorized) and chat-changed shift the state.
    const _refreshAutoSync = () => refreshAutoSyncCheckbox(extension_settings.vectfox);
    document.addEventListener('vectfox:collections-updated', _refreshAutoSync);
    // Links imported in the Database Browser change what this line reports.
    document.addEventListener('vectfox:collections-updated', () => {
        if ($('#VectFox_story_arc_link_status').is(':visible')) refreshStoryLinkStatus(extension_settings.vectfox);
    });

    document.addEventListener('vectfox:eventbase-synced', () => {
        // The chat just gained a collection because the user was sent here by
        // turning auto-sync on. Finish what they started: re-run the enable flow,
        // which now finds a collection and takes the normal path (straight on if
        // fully synced, catch-up prompt if not). Refreshing alone would re-read
        // the stored off and leave the switch off.
        const pendingChat = _autoSyncEnableAwaitingVectorizeForChat;
        _autoSyncEnableAwaitingVectorizeForChat = null;
        if (pendingChat && pendingChat === getCurrentChatId()) {
            $('#VectFox_autosync_enabled').prop('checked', true).trigger('input');
            return; // that flow sets the checkbox itself
        }
        _refreshAutoSync();
    });

    // Closed without vectorizing — the user changed their mind, so drop the
    // intent rather than enabling auto-sync off some later unrelated run.
    document.addEventListener('vectfox:content-vectorizer-closed', () => {
        _autoSyncEnableAwaitingVectorizeForChat = null;
    });

    // Injection position (where every VectFox block goes in the prompt)
    $('#VectFox_injection_position')
        .val(settings.position)
        .on('change', function() {
            const value = parseInt($(this).val());
            settings.position = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            // Show/hide depth slider based on position
            $('#VectFox_injection_depth_row').toggle(value === 1);
        });
    // Initialize depth row visibility
    $('#VectFox_injection_depth_row').toggle(settings.position === 1);

    // Injection depth (for in-chat position)
    bindNumberSetting(settings, { id: 'VectFox_injection_depth', key: 'depth', initial: settings.depth ?? 2, isInteger: true });

    // RAG page: the context prompt and the XML tag
    $('#VectFox_rag_context')
        .val(settings.rag_context || '')
        .on('input', function() {
            settings.rag_context = $(this).val();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_rag_xml_tag')
        .val(settings.rag_xml_tag || '')
        .on('input', function() {
            // Sanitize: only allow alphanumeric, underscore, hyphen
            const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
            $(this).val(sanitized);
            settings.rag_xml_tag = sanitized;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Provider-specific settings

    // ElectronHub model
    $('#VectFox_electronhub_model')
        .val(settings.electronhub_model)
        .on('change', function() {
            settings.electronhub_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Ollama alternative endpoint
    $('#VectFox_ollama_use_alt_endpoint')
        .prop('checked', settings.embedding_ollama_url_override)
        .on('input', function() {
            settings.embedding_ollama_url_override = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_ollama_alt_endpoint_row').toggle(settings.embedding_ollama_url_override);
        });
    $('#VectFox_ollama_alt_endpoint_row').toggle(!!settings.embedding_ollama_url_override);

    $('#VectFox_ollama_alt_endpoint_url')
        .val(settings.embedding_ollama_url)
        .on('input', function() {
            settings.embedding_ollama_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // No Ollama API key input: SillyTavern sends no auth header to Ollama (see
    // the Ollama note in src/shared/api-keys.js).

    // vLLM alternative endpoint
    $('#VectFox_vllm_use_alt_endpoint')
        .prop('checked', settings.embedding_vllm_url_override)
        .on('input', function() {
            settings.embedding_vllm_url_override = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_vllm_alt_endpoint_row').toggle(settings.embedding_vllm_url_override);
        });
    $('#VectFox_vllm_alt_endpoint_row').toggle(!!settings.embedding_vllm_url_override);

    $('#VectFox_vllm_alt_endpoint_url')
        .val(settings.embedding_vllm_url)
        .on('input', function() {
            settings.embedding_vllm_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Ollama model
    $('#VectFox_ollama_model')
        .val(settings.embedding_ollama_model)
        .on('input', function() {
            settings.embedding_ollama_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_ollama_keep')
        .prop('checked', settings.ollama_keep)
        .on('input', function() {
            settings.ollama_keep = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Serial / pipelined toggle. Checkbox CHECKED == disable_pipeline == serial.
    // Default to unchecked when the setting is unset (matches the read-site
    // semantics in eventbase-workflow.js: `... === true` means only explicit
    // true is serial). Fresh installs get pipelined mode (the new default).
    $('#VectFox_eventbase_disable_pipeline')
        .prop('checked', settings.eventbase_disable_pipeline ?? false)
        .on('change', function() {
            settings.eventbase_disable_pipeline = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Group embedding-call toggle (default unchecked = parallel-split per item).
    // Checked = legacy batched POST. Path-agnostic — affects both EventBase ingestion
    // and document vectorization via the shared insertVectorItems entry point.
    // UI lives on the Core page → Embedding card (the setting's actual scope).
    // Skipped automatically for local providers (Ollama uses batch=1 per item;
    // rate-limit forces serial via dynamicRateLimiter).
    $('#VectFox_vector_group_embedding_call')
        .prop('checked', !!settings.vector_group_embedding_call)
        .on('change', function() {
            settings.vector_group_embedding_call = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Hedge toggle — boolean UI maps to a millisecond threshold so power users can tune
    // via devtools without code changes. Checked → 15000ms (vetted default). Unchecked → 0
    // (off). The hedge itself is callWithHedge() in src/features/vector-backend/vector-api.js; the
    // gating in insertVectorItems skips local providers regardless of this checkbox. Design:
    // InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.
    const HEDGE_DEFAULT_THRESHOLD_MS = 15000;
    $('#VectFox_vector_hedge_enabled')
        .prop('checked', (Number(settings.vector_hedge_after_ms) || 0) > 0)
        .on('change', function() {
            settings.vector_hedge_after_ms = $(this).prop('checked') ? HEDGE_DEFAULT_THRESHOLD_MS : 0;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // EventBase native rerank toggle (A3 / Qdrant only).
    $('#VectFox_eventbase_native_rerank')
        .prop('checked', !!settings.eventbase_native_rerank)
        .on('change', function() {
            settings.eventbase_native_rerank = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });



    // ── EventBase settings ──────────────────────────────────────────────────

    // Helper: normalize re-rank weights to sum = 1.0
    const _normalizeRerankWeights = () => {
        const keys = ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'];
        const values = keys.map(k => parseFloat(settings[`eventbase_${k}`]) || 0);
        const total = values.reduce((a, b) => a + b, 0);
        if (total === 0) return;
        keys.forEach((k, i) => {
            settings[`eventbase_${k}`] = Math.round((values[i] / total) * 1000) / 1000;
            $(`#VectFox_eventbase_${k}`).val(settings[`eventbase_${k}`]);
        });
    };

    // window_size / window_overlap are bound in the Vectorize Content panel
    // (src/features/chunkbase/content-vectorizer.js).
    bindNumberSetting(settings, { id: 'VectFox_eventbase_min_importance_store', key: 'eventbase_min_importance_store', initial: settings.eventbase_min_importance_store ?? 3, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_max_events_per_window', key: 'eventbase_max_events_per_window', initial: settings.eventbase_max_events_per_window ?? 3, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_temperature', key: 'eventbase_temperature', initial: settings.eventbase_temperature ?? 0.2 });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_max_tokens', key: 'eventbase_max_tokens', initial: settings.eventbase_max_tokens ?? 2048, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_timeout_ms', key: 'eventbase_timeout_ms', initial: settings.eventbase_timeout_ms ?? 60000, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_retrieval_top_k', key: 'eventbase_retrieval_top_k', initial: settings.eventbase_retrieval_top_k ?? 10, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_retrieval_min_importance', key: 'eventbase_retrieval_min_importance', initial: settings.eventbase_retrieval_min_importance ?? 1, isInteger: true });
    bindNumberSetting(settings, { id: 'VectFox_eventbase_score_threshold', key: 'eventbase_score_threshold', initial: settings.eventbase_score_threshold ?? 0 });

    $('#VectFox_eventbase_injection_format')
        .val(settings.eventbase_injection_format || 'densetext')
        .on('change', function() {
            settings.eventbase_injection_format = String($(this).val() || 'densetext').toLowerCase();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Re-rank weights: saved on leaving the box, then all four rescaled to add up to 1.
    ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'].forEach(k => {
        $(`#VectFox_eventbase_${k}`)
            .val(settings[`eventbase_${k}`] ?? '')
            .on('change', function() {
                const v = parseFloat($(this).val());
                if (!isNaN(v) && v >= 0) {
                    settings[`eventbase_${k}`] = v;
                    _normalizeRerankWeights();
                    Object.assign(extension_settings.vectfox, settings);
                    saveSettingsDebounced();
                }
            });
    });

    // Grey out the Cosine weight input when vector scoring is unavailable
    // (Standard backend without the Similharity plugin always returns score=0
    // from the native /api/vector/query path — see StandardBackend.queryCollection in
    // src/features/vector-backend/standard.js).
    // The saved value is preserved so it takes effect again when the plugin
    // is installed or the user switches to a backend with real vector scores.
    // The retrieval pipeline coerces cosine→0 in the same condition so the
    // remaining 3 weights renormalize to a full 1.0 — see eventbase-retrieval.js.
    _refreshCosineWeightAvailability = async function() {
        const $input = $('#VectFox_eventbase_rerank_w_cosine');
        const $warn  = $('#VectFox_eventbase_cosine_plugin_warning');
        if ($input.length === 0) return;
        const backend = settings.vector_backend || 'standard';
        const pluginUp = await checkPluginAvailable();
        const inactive = backend === 'standard' && !pluginUp;
        $input.prop('disabled', inactive);
        $warn.toggle(inactive);
    };
    _refreshCosineWeightAvailability();

    $('#VectFox_eventbase_reset_weights').on('click', function() {
        settings.eventbase_rerank_w_cosine    = 0.55;
        settings.eventbase_rerank_w_importance = 0.20;
        settings.eventbase_rerank_w_persist   = 0.15;
        settings.eventbase_rerank_w_recency   = 0.10;
        ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'].forEach(k => {
            $(`#VectFox_eventbase_${k}`).val(settings[`eventbase_${k}`]);
        });
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        log.lifecycle('VectFox: re-rank weights reset to their defaults.');
    });

    // Custom extraction prompt textarea — pre-fill with default if nothing saved.
    // The "default" is now localized via CJK Tokenizer Mode (intl / jieba /
    // jieba_tw / tiny_segmenter / korean / others). When no custom prompt has
    // been saved, we show the localized built-in so the user sees the variant
    // that will actually be sent at extraction time.
    (async () => {
        const { getEventBaseExtractionPrompt } = await import('../eventbase/index.js');
        const saved = settings.eventbase_custom_prompt || '';
        const mode = settings.cjk_tokenizer_mode || 'intl';
        $('#VectFox_eventbase_custom_prompt').val(saved || getEventBaseExtractionPrompt(mode));
    })();

    $('#VectFox_eventbase_custom_prompt').on('input', function() {
        settings.eventbase_custom_prompt = $(this).val();
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    });

    // Reset prompt to built-in default for the current CJK Tokenizer Mode.
    $('#VectFox_eventbase_prompt_reset').on('click', async function() {
        const { getEventBaseExtractionPrompt } = await import('../eventbase/index.js');
        const mode = settings.cjk_tokenizer_mode || 'intl';
        settings.eventbase_custom_prompt = '';
        $('#VectFox_eventbase_custom_prompt').val(getEventBaseExtractionPrompt(mode));
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        log.lifecycle(`VectFox: extraction prompt reset to the ${mode} default.`);
    });

    // When the user changes CJK Tokenizer Mode AND has no custom prompt saved,
    // re-fill the textarea with the new mode's localized default so the
    // displayed text matches what extraction will actually use. If the user
    // has a custom prompt, leave it alone — they explicitly customized it.
    $('#VectFox_cjk_tokenizer_mode').on('change.eventbasePromptSync', async function() {
        if (settings.eventbase_custom_prompt && settings.eventbase_custom_prompt.trim()) return;
        const { getEventBaseExtractionPrompt } = await import('../eventbase/index.js');
        const mode = $(this).val() || 'intl';
        $('#VectFox_eventbase_custom_prompt').val(getEventBaseExtractionPrompt(mode));
    });

    // ── End EventBase settings ───────────────────────────────────────────────

    // OpenAI model
    $('#VectFox_openai_model')
        .val(settings.openai_model)
        .on('change', function() {
            settings.openai_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Cohere model
    $('#VectFox_cohere_model')
        .val(settings.cohere_model)
        .on('change', function() {
            settings.cohere_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // TogetherAI model
    $('#VectFox_togetherai_model')
        .val(settings.togetherai_model)
        .on('change', function() {
            settings.togetherai_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM model
    $('#VectFox_vllm_model')
        .val(settings.embedding_vllm_model)
        .on('input', function() {
            settings.embedding_vllm_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM API key (embedding input) — dual-write to SECRET_KEYS.CUSTOM
    // (chat-side proxy) + SECRET_KEYS.VLLM (embedding-side proxy). Same
    // pattern as the Summarize and AgentMode inputs above. One shared key,
    // both ST slots. See src/shared/api-keys.js header for the full rationale.
    const updateVllmKeyDisplay = () => {
        const savedKey = getCustomApiKey();
        if (savedKey) {
            $('#VectFox_vllm_api_key').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_vllm_api_key').attr('placeholder', 'Blank for a server that needs none');
        }
    };
    updateVllmKeyDisplay();
    $(document).on('vectfox:vllm-key-changed', updateVllmKeyDisplay);
    wireKeyBox('#VectFox_vllm_api_key', VLLM_KEY_BOX);

    // Google model
    $('#VectFox_google_model')
        .val(settings.google_model)
        .on('change', function() {
            settings.google_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // OpenRouter model
    $('#VectFox_openrouter_model')
        .val(settings.embedding_openrouter_model)
        .on('input', function() {
            settings.embedding_openrouter_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // "Choose" button — fetches OpenRouter model list, filters to embedding-likely models
    // Cached for the session to avoid re-fetching 600+ entries each click
    let _openrouterModelCache = null;
    $('#VectFox_openrouter_model_choose').on('click', async function() {
        const $btn = $(this);
        const $list = $('#VectFox_openrouter_model_list');
        const $input = $('#VectFox_openrouter_model');

        const originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');

        try {
            if (!_openrouterModelCache) {
                // OpenRouter's /models endpoint is public — auth only personalizes
                // the response. getOpenRouterApiKey() returns a MASKED value
                // (see src/shared/api-keys.js docstring), which would 401 if sent as
                // Bearer. Fetch unauthenticated; the global model list is fine
                // for the picker UI.
                const headers = { 'Content-Type': 'application/json' };
                // Embedding models use output_modalities=embeddings — not in the standard list
                const [embResp, allResp] = await Promise.all([
                    fetch('https://openrouter.ai/api/v1/models?output_modalities=embeddings', { method: 'GET', headers }),
                    fetch('https://openrouter.ai/api/v1/models', { method: 'GET', headers }),
                ]);
                const toEntry = m => ({ id: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id });
                const embModels = embResp.ok ? (await embResp.json()).data?.map(toEntry) || [] : [];
                const allModels = allResp.ok ? (await allResp.json()).data?.map(toEntry) || [] : [];
                _openrouterModelCache = { embeddings: embModels, all: [...embModels, ...allModels] };
            }

            const { embeddings, all } = _openrouterModelCache;

            const renderList = (items, showingAll) => {
                if (!items.length) {
                    toastr.warning('No models matched the filter.');
                    return;
                }
                items.sort((a, b) => a.id.localeCompare(b.id));
                const currentValue = String($input.val() || '').trim();
                const toggleLabel = showingAll ? '— Showing all models · click to filter to embedding-only —' : '— Showing embedding models · click to show all —';
                const options = [`<option value="__toggle__">${toggleLabel}</option>`, '<option value="">— Select a model —</option>']
                    .concat(items.map(m => {
                        const selected = m.id === currentValue ? ' selected' : '';
                        const safeId = $('<div>').text(m.id).html();
                        const safeLabel = $('<div>').text(m.label).html();
                        return `<option value="${safeId}"${selected}>${safeLabel}</option>`;
                    }));
                $list.html(options.join('')).data('showing-all', showingAll).show();
            };

            // Default to embedding-only; if zero matches, fall back to all
            if (embeddings.length > 0) {
                renderList(embeddings, false);
                log.lifecycle(`VectFox: loaded ${embeddings.length} embedding models (${all.length} in all).`);
            } else {
                renderList(all, true);
                log.lifecycle(`VectFox: no model is tagged for embedding, so the list shows all ${all.length}.`);
            }
        } catch (err) {
            log.error('[VectFox] OpenRouter model list fetch failed:', err);
            toastr.error(`Could not fetch model list: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $('#VectFox_openrouter_model_list').on('change', function() {
        const $list = $(this);
        const value = String($list.val() || '').trim();

        // "__toggle__" pseudo-option toggles between embedding-only and all
        if (value === '__toggle__') {
            const showingAll = !!$list.data('showing-all');
            const cache = _openrouterModelCache || { embeddings: [], all: [] };
            const items = showingAll ? cache.embeddings : cache.all;
            items.sort((a, b) => a.id.localeCompare(b.id));
            const currentValue = String($('#VectFox_openrouter_model').val() || '').trim();
            const nextShowingAll = !showingAll;
            const toggleLabel = nextShowingAll ? '— Showing all models · click to filter to embedding-only —' : '— Showing embedding models · click to show all —';
            const options = [`<option value="__toggle__">${toggleLabel}</option>`, '<option value="">— Select a model —</option>']
                .concat(items.map(m => {
                    const selected = m.id === currentValue ? ' selected' : '';
                    const safeId = $('<div>').text(m.id).html();
                    const safeLabel = $('<div>').text(m.label).html();
                    return `<option value="${safeId}"${selected}>${safeLabel}</option>`;
                }));
            $list.html(options.join('')).data('showing-all', nextShowingAll);
            return;
        }

        if (!value) return;
        $('#VectFox_openrouter_model').val(value).trigger('input');
        $list.hide();
    });

    // OpenRouter API key (embedding input) — writes to SECRET_KEYS.OPENROUTER,
    // the shared slot used by ST's own Connection Profile and by VectFox's
    // Summarize + AgentMode inputs. See src/shared/api-keys.js for the rationale.
    const updateOpenRouterKeyDisplay = () => {
        const savedKey = getOpenRouterApiKey();
        if (savedKey) {
            $('#VectFox_openrouter_apikey').attr('placeholder', 'Key saved');
        } else {
            $('#VectFox_openrouter_apikey').attr('placeholder', 'Paste a key to save it');
        }
    };
    updateOpenRouterKeyDisplay();
    $(document).on('vectfox:openrouter-key-changed', () => {
        updateOpenRouterKeyDisplay();
        _openrouterModelCache = null; // a new key can see other models, so the model picker lists them again
    });
    wireKeyBox('#VectFox_openrouter_apikey', OPENROUTER_KEY_BOX);

    // Rate Limiting
    $('#VectFox_rate_limit_calls')
        .val(settings.rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_calls = isNaN(value) ? 0 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_rate_limit_interval')
        .val(settings.rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_interval = isNaN(value) ? 60 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Summarizer / Agent Mode (chat-completions) Rate Limiting — shared budget,
    // separate from the embedding limiter above. 0 = disabled.
    $('#VectFox_generation_rate_limit_calls')
        .val(settings.generation_rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.generation_rate_limit_calls = isNaN(value) ? 0 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_generation_rate_limit_interval')
        .val(settings.generation_rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.generation_rate_limit_interval = isNaN(value) ? 60 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });


    // Insert batch size: items per embedding request (vector-api.js insertVectorItems)
    bindNumberSetting(settings, { id: 'VectFox_insert_batch_size', key: 'insert_batch_size', initial: settings.insert_batch_size || 50, isInteger: true });

    // Acronym glossary injection (Documents) — see src/features/chunkbase/glossary-extractor.js
    $('#VectFox_document_glossary_injection')
        .prop('checked', settings.document_glossary_injection !== false)
        .on('change', function() {
            settings.document_glossary_injection = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Minimum chat length before injection starts
    bindNumberSetting(settings, { id: 'VectFox_min_chat_length', key: 'min_chat_length', initial: settings.min_chat_length ?? 0, isInteger: true });

    // The Provider dropdowns of the four LLM consumers and embedding, their profile rows and Test connection buttons.
    wireConnectionRows(settings, {
        onEmbeddingProviderChange: () => {
            log.lifecycle(`VectFox: Embedding provider changed to ${settings.embedding_provider}`);
            // A provider change may change what the backend can reach.
            resetBackendHealth();
        },
    });
}
