/**
 * @vitest-environment jsdom
 *
 * The settings panel's Action page (src/features/settings-panel/action-page.js), on its real markup: the master switch
 * saves, paints its pill and the other pages' notice, and redoes the startup work when it turns back on; each button
 * opens its tool; each debug switch saves its own domain or setting; Purge and Clean up delete nothing until the user
 * confirms, and a Purge whose delete fails resets nothing; the summarizer preview shows the block or why there is none.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    saveSettingsDebounced: vi.fn(),
    confirmPopup: vi.fn(),
    noticePopup: vi.fn(),
    logError: vi.fn(),
    reopenProgress: vi.fn(),
    clearInterceptorPrompts: vi.fn(),
    openContentVectorizer: vi.fn(),
    syncOpenChat: vi.fn(async () => ({ ran: true })),
    cleanupCorruptedCollections: vi.fn(),
    deleteVectorsFolder: vi.fn(),
    openDatabaseBrowser: vi.fn(),
    openDiagnostics: vi.fn(),
    refreshHealthPill: vi.fn(),
    buildSummarizerInjection: vi.fn(),
    refreshWorldInfoEntryDepthCache: vi.fn(),
    openTextCleaningDialog: vi.fn(),
    clearLorebookPrompt: vi.fn(),
}));

vi.mock('../src/sillytavern/settings.js', () => ({
    extension_settings: host.extensionSettings,
    saveSettingsDebounced: host.saveSettingsDebounced,
}));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: host.confirmPopup, noticePopup: host.noticePopup }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: host.logError, warn: () => {}, lifecycle: () => {} } }));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { reopen: host.reopenProgress } }));
vi.mock('../src/features/chunkbase/index.js', () => ({ clearInterceptorPrompts: host.clearInterceptorPrompts, openContentVectorizer: host.openContentVectorizer, syncOpenChat: host.syncOpenChat }));
vi.mock('../src/features/collections/index.js', () => ({ cleanupCorruptedCollections: host.cleanupCorruptedCollections, deleteVectorsFolder: host.deleteVectorsFolder }));
vi.mock('../src/features/database-browser/index.js', () => ({ openDatabaseBrowser: host.openDatabaseBrowser }));
vi.mock('../src/features/diagnostics/index.js', () => ({ openDiagnostics: host.openDiagnostics, refreshHealthPill: host.refreshHealthPill }));
vi.mock('../src/features/eventbase/index.js', () => ({ buildSummarizerInjection: host.buildSummarizerInjection, refreshWorldInfoEntryDepthCache: host.refreshWorldInfoEntryDepthCache }));
vi.mock('../src/features/text-cleaning/index.js', () => ({ openTextCleaningDialog: host.openTextCleaningDialog }));
vi.mock('../src/features/world-info/index.js', () => ({ clearLorebookPrompt: host.clearLorebookPrompt }));

const { ACTION_PAGE_ELEMENT_ID: ID, DEBUG_SWITCHES, actionPageMarkup, masterSwitchPillsMarkup } = await import('../src/features/settings-panel/action-page-markup.js');
const { panelPageMarkup } = await import('../src/features/settings-panel/panel-shell-markup.js');

const toastr = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const isShown = selector => $(selector).css('display') !== 'none';

describe('Action page', () => {
    let wireActionPage;
    let settings;
    let actions;

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('$', $);
        vi.stubGlobal('toastr', toastr);
        for (const mock of [...Object.values(host).filter(value => typeof value === 'function'), ...Object.values(toastr)]) mock.mockReset();
        host.openDatabaseBrowser.mockResolvedValue(undefined);
        document.body.innerHTML = `<div id="VectFox_settings">
            ${panelPageMarkup('action', actionPageMarkup(), { status: masterSwitchPillsMarkup() })}
            ${panelPageMarkup('core', '<section class="vfx-card"></section>')}
        </div>`;
        settings = { enabled: true, embedding_provider: 'openrouter', debug_domain: { story_arc: true } };
        host.extensionSettings.vectfox = settings;
        actions = { refreshAutoSyncCheckbox: vi.fn(), runNetworkStartup: vi.fn() };
        ({ wireActionPage } = await import('../src/features/settings-panel/action-page.js'));
    });

    it('puts the master switch first and the danger zone last, and gives every control its own id', () => {
        const page = document.getElementById('VectFox_panel_action');
        const blocks = [...page.children].filter(child => !child.matches('header'));
        expect(blocks[0].querySelector(`#${ID.masterSwitch}`)).not.toBeNull();
        expect(blocks.at(-1).classList.contains('vfx-danger-zone')).toBe(true);
        for (const id of [...Object.values(ID), ...DEBUG_SWITCHES.map(({ id: switchId }) => switchId)]) {
            expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
        }
        expect(page.querySelector('[data-vectfox-off-notice]')).toBeNull();
        expect(document.querySelector('#VectFox_panel_core [data-vectfox-off-notice]')).not.toBeNull();
    });

    it('shows the master switch as on, with no notice on the other pages', () => {
        wireActionPage(settings, actions);
        expect($(`#${ID.masterSwitch}`).prop('checked')).toBe(true);
        expect(isShown(`#${ID.masterOnPill}`)).toBe(true);
        expect(isShown(`#${ID.masterOffPill}`)).toBe(false);
        expect(isShown('#VectFox_panel_core [data-vectfox-off-notice]')).toBe(false);
    });

    it('turns VectFox off: saves it, empties the prompt blocks, and shows the pill and the notice', async () => {
        wireActionPage(settings, actions);
        $(`#${ID.masterSwitch}`).prop('checked', false).trigger('change');
        await settle();
        expect(host.extensionSettings.vectfox.enabled).toBe(false);
        expect(host.saveSettingsDebounced).toHaveBeenCalled();
        expect(host.clearInterceptorPrompts).toHaveBeenCalledWith(settings);
        expect(host.clearLorebookPrompt).toHaveBeenCalledWith(settings);
        expect(actions.refreshAutoSyncCheckbox).toHaveBeenCalledWith(settings);
        expect(actions.runNetworkStartup).not.toHaveBeenCalled();
        expect(isShown(`#${ID.masterOffPill}`)).toBe(true);
        expect(isShown(`#${ID.masterOnPill}`)).toBe(false);
        expect(isShown('#VectFox_panel_core [data-vectfox-off-notice]')).toBe(true);
        expect(toastr.info).not.toHaveBeenCalled();
    });

    it('turns VectFox back on from a page\'s notice, and redoes the startup work skipped while off', async () => {
        settings.enabled = false;
        wireActionPage(settings, actions);
        expect(isShown('#VectFox_panel_core [data-vectfox-off-notice]')).toBe(true);
        $('#VectFox_panel_core [data-vectfox-turn-on]').trigger('click');
        await vi.waitFor(() => expect(host.refreshHealthPill).toHaveBeenCalled());
        expect($(`#${ID.masterSwitch}`).prop('checked')).toBe(true);
        expect(settings.enabled).toBe(true);
        expect(host.refreshWorldInfoEntryDepthCache).toHaveBeenCalledWith(settings);
        expect(actions.runNetworkStartup).toHaveBeenCalledWith(settings);
        expect(actions.refreshAutoSyncCheckbox).toHaveBeenCalledWith(settings);
        expect(isShown('#VectFox_panel_core [data-vectfox-off-notice]')).toBe(false);
    });

    it('opens each tool from its button', () => {
        wireActionPage(settings, actions);
        const opened = [
            [ID.vectorizeContent, host.openContentVectorizer, []],
            [ID.syncChat, host.syncOpenChat, []],
            [ID.databaseBrowser, host.openDatabaseBrowser, []],
            [ID.textCleaning, host.openTextCleaningDialog, []],
            [ID.openChecks, host.openDiagnostics, ['checks']],
            [ID.openBackendHealth, host.openDiagnostics, ['health']],
            [ID.openQueryTester, host.openDiagnostics, ['query']],
        ];
        for (const [id, opener, args] of opened) {
            opener.mockClear();
            $(`#${id}`).trigger('click');
            expect(opener, id).toHaveBeenCalledTimes(1);
            expect(opener, id).toHaveBeenCalledWith(...args);
        }
    });

    it('logs a Sync chat that fails', async () => {
        host.syncOpenChat.mockRejectedValueOnce(new Error('backend gone'));
        wireActionPage(settings, actions);
        $(`#${ID.syncChat}`).trigger('click');
        await vi.waitFor(() => expect(host.logError).toHaveBeenCalledWith(expect.stringContaining('Sync chat'), expect.any(Error)));
    });

    it('logs a Database Browser that fails to open', async () => {
        host.openDatabaseBrowser.mockRejectedValue(new Error('no plugin'));
        wireActionPage(settings, actions);
        $(`#${ID.databaseBrowser}`).trigger('click');
        await vi.waitFor(() => expect(host.logError).toHaveBeenCalledWith(expect.stringContaining('Database Browser'), expect.any(Error)));
    });

    it('says so when there is no progress to show', () => {
        host.reopenProgress.mockReturnValue(false);
        wireActionPage(settings, actions);
        $(`#${ID.reopenProgress}`).trigger('click');
        expect(toastr.info).toHaveBeenCalledTimes(1);
    });

    it('saves the console verbosity, each debug domain, and each debug setting of its own', () => {
        settings.debug_verbosity = 'verbose';
        settings.debug_domain.agent = true;
        wireActionPage(settings, actions);
        expect($(`#${ID.debugVerbosity}`).val()).toBe('verbose');
        expect($('#VectFox_agentic_debug').prop('checked')).toBe(true);
        expect($('#VectFox_injection_debug_logging').prop('checked')).toBe(false);

        $(`#${ID.debugVerbosity}`).val('trace').trigger('change');
        expect(host.extensionSettings.vectfox.debug_verbosity).toBe('trace');
        for (const { id, domain, setting } of DEBUG_SWITCHES) {
            $(`#${id}`).prop('checked', true).trigger('change');
            if (domain) expect(host.extensionSettings.vectfox.debug_domain[domain], id).toBe(true);
            else expect(host.extensionSettings.vectfox[setting], id).toBe(true);
        }
        expect(host.extensionSettings.vectfox.debug_domain.story_arc).toBe(true);
        $('#VectFox_debug_domain_raw_llm').prop('checked', false).trigger('change');
        expect(host.extensionSettings.vectfox.debug_domain.raw_llm).toBe(false);
    });

    it('purges nothing when the user cancels', async () => {
        host.confirmPopup.mockResolvedValue(false);
        wireActionPage(settings, actions);
        $(`#${ID.purge}`).trigger('click');
        await settle();
        expect(host.confirmPopup).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ okButton: 'Purge everything', isDestructive: true }));
        expect(host.deleteVectorsFolder).not.toHaveBeenCalled();
        expect(host.extensionSettings.vectfox.embedding_provider).toBe('openrouter');
    });

    it('purges the vectors, then resets every setting but the master switch', async () => {
        host.confirmPopup.mockResolvedValue(true);
        host.deleteVectorsFolder.mockResolvedValue(undefined);
        wireActionPage(settings, actions);
        $(`#${ID.purge}`).trigger('click');
        await vi.waitFor(() => expect(toastr.success).toHaveBeenCalled());
        expect(host.deleteVectorsFolder).toHaveBeenCalledTimes(1);
        expect(host.extensionSettings.vectfox).toEqual({ enabled: true });
        expect(host.saveSettingsDebounced).toHaveBeenCalled();
    });

    it('resets no setting when the vectors could not be deleted, and says the purge failed', async () => {
        host.confirmPopup.mockResolvedValue(true);
        host.deleteVectorsFolder.mockRejectedValue(new Error('Similharity\'s purge-all returned 404'));
        wireActionPage(settings, actions);
        $(`#${ID.purge}`).trigger('click');
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith(expect.stringContaining('404'), 'VectFox'));
        expect(host.extensionSettings.vectfox.embedding_provider).toBe('openrouter');
        expect(host.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(toastr.success).not.toHaveBeenCalled();
    });

    it('cleans up nothing when the user cancels, and the corrupted collections once they confirm', async () => {
        host.confirmPopup.mockResolvedValue(false);
        wireActionPage(settings, actions);
        $(`#${ID.cleanupCorrupted}`).trigger('click');
        await settle();
        expect(host.confirmPopup).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ okButton: 'Clean up', isDestructive: true }));
        expect(host.cleanupCorruptedCollections).not.toHaveBeenCalled();

        host.confirmPopup.mockResolvedValue(true);
        host.cleanupCorruptedCollections.mockResolvedValue({ total: 2, corruption: 1, stFile: 1, purged: [{ ok: true }, { ok: false }] });
        $(`#${ID.cleanupCorrupted}`).trigger('click');
        await vi.waitFor(() => expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining('Purged 1/2'), 'Cleanup partial'));
    });

    it('previews the summarizer block in a read-only box, and says when the injection is off', async () => {
        host.buildSummarizerInjection.mockResolvedValue({ text: '<VectFoxSummarizer>\nA met B.\n</VectFoxSummarizer>', count: 1, requested: 20 });
        wireActionPage(settings, actions);
        $(`#${ID.previewSummarizer}`).trigger('click');
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalled());
        const [lines, { body, isWide }] = host.noticePopup.mock.calls[0];
        expect(lines).toContainEqual({ text: 'Events this turn would inject:', name: '1' });
        expect(lines).toContainEqual(expect.objectContaining({ text: 'Summarizer Injection is off. This is what turning it on would inject.' }));
        expect(body.tagName).toBe('TEXTAREA');
        expect(body.readOnly).toBe(true);
        expect(body.value).toContain('A met B.');
        expect(isWide).toBe(true);
    });

    it('says why the summarizer preview has nothing, the backend\'s error included', async () => {
        settings.summarizer_injection_enabled = true;
        host.buildSummarizerInjection.mockResolvedValue({ text: '', count: 0, reason: 'backend-error', error: 'ECONNREFUSED' });
        wireActionPage(settings, actions);
        $(`#${ID.previewSummarizer}`).trigger('click');
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalled());
        const [lines, options] = host.noticePopup.mock.calls[0];
        expect(lines).toContainEqual({ text: 'Nothing would be injected this turn.' });
        expect(lines).toContainEqual({ text: 'The vector backend did not answer:', name: 'ECONNREFUSED' });
        expect(lines.some(line => line.icon)).toBe(false);
        expect(options).toBeUndefined();
    });
});
