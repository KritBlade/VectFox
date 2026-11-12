/**
 * ============================================================================
 * ACTION PAGE
 * ============================================================================
 * Wires the settings panel's Action page (action-page-markup.js): the master switch and
 * its pills, the notice the other pages show while VectFox is off, the buttons that open
 * VectFox's tools, the console's debug switches, and the danger zone's Purge and Clean up,
 * each behind a confirm dialog.
 * ============================================================================
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { confirmPopup, noticePopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { textarea } from '../../shared/gui-dna/gui-dna-core.js';
import { clearInterceptorPrompts, openContentVectorizer, syncOpenChat } from '../chunkbase/index.js';
import { cleanupCorruptedCollections, deleteVectorsFolder } from '../collections/index.js';
import { openDatabaseBrowser } from '../database-browser/index.js';
import { openDiagnostics, refreshHealthPill } from '../diagnostics/index.js';
import { buildSummarizerInjection, refreshWorldInfoEntryDepthCache } from '../eventbase/index.js';
import { openTextCleaningDialog } from '../text-cleaning/index.js';
import { clearLorebookPrompt } from '../world-info/index.js';
import { ACTION_PAGE_ELEMENT_ID as ID, DEBUG_SWITCHES } from './action-page-markup.js';
import { VECTFOX_OFF_NOTICE_HOOK, VECTFOX_TURN_ON_HOOK } from './panel-shell-markup.js';

const TOAST_TITLE = 'VectFox';

/** Why the summarizer preview has nothing to show, by the reason buildSummarizerInjection gives. */
const SUMMARIZER_EMPTY_REASONS = {
    'no-chat': { text: 'No chat is open.' },
    'no-collection': { text: 'This chat has no EventBase collection yet. Vectorize it first.' },
    'no-events': { text: 'Its collection holds no events yet.' },
    'backend-error': { text: 'The vector backend did not answer:' },
    'listchunks-error': { text: 'Its collection could not be read:' },
    error: { text: 'The preview failed:' },
};

/**
 * Show the master switch's state: its pill on this page, and the notice on every other page.
 *
 * @param {boolean} isOn
 */
function paintMasterSwitch(isOn) {
    $(`#${ID.masterOnPill}`).toggle(isOn);
    $(`#${ID.masterOffPill}`).toggle(!isOn);
    $(`[${VECTFOX_OFF_NOTICE_HOOK}]`).toggle(!isOn);
}

/**
 * Delete every local vector and reset every VectFox setting but the master switch, once the user confirms. Nothing
 * is reset when the vectors could not be deleted.
 */
async function purgeEverything() {
    const isConfirmed = await confirmPopup([
        { text: 'Delete every local vector and reset VectFox?' },
        { text: 'Lost: every collection in SillyTavern\'s vectors folder, SillyTavern\'s own Vector Storage included.' },
        { text: 'Lost: every VectFox setting but the master switch. A reload brings back the defaults.' },
        { text: 'A Qdrant server keeps its data.' },
        { text: 'Purge everything deletes them. Cancel keeps them.' },
    ], { okButton: 'Purge everything', isDestructive: true });
    if (!isConfirmed) return;

    try {
        await deleteVectorsFolder();
    } catch (error) {
        log.error('VectFox: Purge failed, so no setting was reset:', error);
        toastr.error(`Purge failed: ${error.message}`, TOAST_TITLE);
        return;
    }
    for (const key of Object.keys(extension_settings.vectfox)) {
        if (key !== 'enabled') delete extension_settings.vectfox[key];
    }
    saveSettingsDebounced();
    toastr.success('Every local vector is deleted and the settings are reset. Reload the page to start from the defaults.', 'Purge complete');
}

/** Delete the collections VectFox cannot read and SillyTavern's own file_* collections, once the user confirms. */
async function cleanUpCorruptedCollections() {
    const isConfirmed = await confirmPopup([
        { text: 'Delete the collections VectFox cannot read?' },
        { text: 'Lost: collections whose id starts with a backend\'s name, which VectFox never reads.' },
        { text: 'Lost: SillyTavern\'s own file_* collections, which hold its Data Bank attachments.' },
        { text: 'Clean up deletes them. Cancel keeps them.' },
    ], { okButton: 'Clean up', isDestructive: true });
    if (!isConfirmed) return;

    try {
        const result = await cleanupCorruptedCollections();
        if (result.total === 0) {
            toastr.info('No corrupted or ST-native file collections found', TOAST_TITLE);
            return;
        }
        saveSettingsDebounced();
        const failed = result.purged.filter(purged => !purged.ok).length;
        const succeeded = result.purged.length - failed;
        const summary = `Purged ${succeeded}/${result.total} (${result.corruption} corrupted, ${result.stFile} ST-native file). ${failed > 0 ? `${failed} failed.` : ''}`;
        if (failed === 0) {
            toastr.success(summary, 'Cleanup complete');
        } else {
            toastr.warning(summary, 'Cleanup partial');
        }
    } catch (error) {
        log.error('VectFox: Cleanup failed:', error);
        toastr.error(`Cleanup failed: ${error.message}`, TOAST_TITLE);
    }
}

/**
 * Show the <VectFoxSummarizer> block that the summarizer injection would put into the prompt this turn, without
 * injecting it. Runs the injection's own path (buildSummarizerInjection), which ignores only the on/off setting, so the
 * preview works while the injection is off.
 *
 * @param {object} settings - extension_settings.vectfox
 */
async function previewSummarizerInjection(settings) {
    let result;
    try {
        result = await buildSummarizerInjection(settings);
    } catch (error) {
        log.error('VectFox: Summarizer preview failed:', error);
        result = { text: '', count: 0, reason: 'error', error: error?.message || String(error) };
    }

    const offLine = settings.summarizer_injection_enabled
        ? []
        : [{ icon: 'fa-circle-info', text: 'Summarizer Injection is off. This is what turning it on would inject.' }];
    if (result.count > 0) {
        const block = document.createElement('div');
        block.innerHTML = textarea({ id: 'VectFox_summarizer_preview_text', value: result.text, rows: 16, isCode: true, title: 'Summarizer block' });
        block.firstElementChild.readOnly = true;
        await noticePopup([
            { text: 'Summarizer preview' },
            { text: 'Events this turn would inject:', name: String(result.count) },
            ...(result.requested ? [{ text: 'At most:', name: String(result.requested) }] : []),
            ...offLine,
        ], { body: block.firstElementChild, isWide: true });
        return;
    }
    const reason = SUMMARIZER_EMPTY_REASONS[result.reason];
    await noticePopup([
        { text: 'Summarizer preview' },
        { text: 'Nothing would be injected this turn.' },
        reason ? { text: reason.text, name: result.error } : { text: 'Reason:', name: result.reason },
        ...offLine,
    ]);
}

/**
 * Wire the Action page. Every control is found by its id (action-page-markup.js).
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {object} actions
 * @param {(settings: object) => Promise<void>} actions.refreshAutoSyncCheckbox - Paints the AutoSync page's switch for the open chat
 * @param {(settings: object) => Promise<void>} actions.runNetworkStartup - Re-runs the off-box startup work (src/app/network-startup.js)
 *     when the master switch turns back on
 */
export function wireActionPage(settings, { refreshAutoSyncCheckbox, runNetworkStartup }) {
    const save = () => {
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    };

    // The master switch: the runtime gates read src/shared/feature-gate.js, as this does.
    $(`#${ID.masterSwitch}`)
        .prop('checked', isVectFoxEnabled(settings))
        .on('change', async function () {
            const isOn = $(this).prop('checked');
            settings.enabled = isOn;
            save();
            paintMasterSwitch(isOn);
            log.lifecycle(`VectFox: master switch ${isOn ? 'ON' : 'OFF'}`);

            if (!isOn) {
                // Take every VectFox block out of the prompt now. ST keeps extension prompts until they are
                // overwritten, and quiet generations skip the interceptor that would otherwise clear them.
                clearInterceptorPrompts(settings);
                clearLorebookPrompt(settings);
                await refreshAutoSyncCheckbox(settings);
                return;
            }

            // Back on: redo the work skipped while off, so VectFox works without a page reload. The ghosting WI-scan
            // floor goes first, as the next generation may read it. Two steps of the off-box startup work do not heal
            // on demand: the EventBase payload-index backfill runs once per install, and collection discovery
            // refreshes the registry the Database Browser, cross-chat retrieval and the auto-sync status read.
            await refreshWorldInfoEntryDepthCache(settings);
            try {
                await runNetworkStartup(settings);
            } catch (error) {
                log.warn('VectFox: backend/network startup after re-enable failed:', error?.message || error);
            }
            await refreshAutoSyncCheckbox(settings);
            await refreshHealthPill(); // its load-time probe is skipped while off
        });
    paintMasterSwitch(isVectFoxEnabled(settings));
    $('#VectFox_settings').on('click', `[${VECTFOX_TURN_ON_HOOK}]`, () => {
        $(`#${ID.masterSwitch}`).prop('checked', true).trigger('change');
    });

    $(`#${ID.vectorizeContent}`).on('click', () => openContentVectorizer());
    // Reads what EventBase has not read of this chat once the user confirms, as Resume does, without the dialog.
    $(`#${ID.syncChat}`).on('click', () => {
        syncOpenChat().catch(error => log.error('VectFox: Sync chat failed:', error));
    });
    $(`#${ID.databaseBrowser}`).on('click', () => {
        openDatabaseBrowser().catch(error => log.error('VectFox: the Database Browser failed to open:', error));
    });
    $(`#${ID.textCleaning}`).on('click', () => openTextCleaningDialog());
    $(`#${ID.reopenProgress}`).on('click', () => {
        if (!progressTracker.reopen()) toastr.info('No active progress to show', TOAST_TITLE);
    });
    // Diagnostics is one dialog of three pages; each button opens its page.
    $(`#${ID.openChecks}`).on('click', () => openDiagnostics('checks'));
    $(`#${ID.openBackendHealth}`).on('click', () => openDiagnostics('health'));
    $(`#${ID.openQueryTester}`).on('click', () => openDiagnostics('query'));
    $(`#${ID.previewSummarizer}`).on('click', () => previewSummarizerInjection(settings));

    $(`#${ID.debugVerbosity}`)
        .val(settings.debug_verbosity || 'off')
        .on('change', function () {
            settings.debug_verbosity = $(this).val();
            save();
        });
    for (const { id, domain, setting } of DEBUG_SWITCHES) {
        const isOn = domain ? settings.debug_domain?.[domain] === true : !!settings[setting];
        $(`#${id}`)
            .prop('checked', isOn)
            .on('change', function () {
                const isChecked = $(this).prop('checked');
                if (domain) {
                    settings.debug_domain = { ...settings.debug_domain, [domain]: isChecked };
                } else {
                    settings[setting] = isChecked;
                }
                save();
            });
    }

    $(`#${ID.purge}`).on('click', () => purgeEverything());
    $(`#${ID.cleanupCorrupted}`).on('click', () => cleanUpCorruptedCollections());
}
