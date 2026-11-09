/**
 * @vitest-environment jsdom
 *
 * The settings panel's GUI-DNA shell (src/features/settings-panel/panel-shell.js), on its real markup: the rail shows
 * one page at a time, each page's hooks run as it shows and hides in the open panel, the panel moves into its dialog
 * and back to its holder on every close, and the theme switch writes the saved theme onto <html>.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    closeDialog: null,
    openPanelPopup: vi.fn(),
    saveSettingsDebounced: vi.fn(),
    extensionSettings: { vectfox: {} },
    logError: vi.fn(),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: host.logError, warn: () => {} } }));
vi.mock('../src/sillytavern/popup.js', () => ({ openPanelPopup: host.openPanelPopup }));
vi.mock('../src/sillytavern/settings.js', () => ({
    extension_settings: host.extensionSettings,
    saveSettingsDebounced: host.saveSettingsDebounced,
}));

const { PANEL_TABS, panelNavMarkup, panelPageMarkup, panelPageId } = await import('../src/features/settings-panel/panel-shell-markup.js');

const panelMarkup = () => `
    <div id="VectFox_open_panel" role="button" tabindex="0">Open VectFox</div>
    <div id="VectFox_panel_holder">
        <div id="VectFox_settings" class="vfx-ui vfx-shell">
            ${panelNavMarkup()}
            <main class="vfx-main">
                ${PANEL_TABS.map(tab => panelPageMarkup(tab.name, `<section class="vfx-card"><button type="button" class="vfx-collapse" aria-expanded="true"></button></section>`)).join('')}
            </main>
        </div>
    </div>`;

const isShown = name => document.getElementById(panelPageId(name)).style.display !== 'none';

describe('settings panel shell', () => {
    let shell;
    let hooks;

    const tabsWithHooks = () => PANEL_TABS.map(tab => ({ name: tab.name, onOpen: () => hooks.push(`open ${tab.name}`), onClose: () => hooks.push(`close ${tab.name}`) }));

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('$', $);
        hooks = [];
        host.extensionSettings.vectfox = {};
        host.saveSettingsDebounced.mockReset();
        host.logError.mockReset();
        host.openPanelPopup.mockReset();
        host.openPanelPopup.mockImplementation(panel => new Promise((resolve) => {
            const dialog = document.createElement('dialog');
            dialog.append(panel);
            document.body.append(dialog);
            host.closeDialog = () => {
                dialog.remove();
                resolve();
            };
        }));
        document.body.innerHTML = panelMarkup();
        delete document.documentElement.dataset.vfxTheme;
        shell = await import('../src/features/settings-panel/panel-shell.js');
    });

    it('shows only the first page until another is picked', () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        expect(PANEL_TABS.filter(tab => isShown(tab.name)).map(tab => tab.name)).toEqual(['action']);
        $('#VectFox_tab_core').trigger('click');
        expect(PANEL_TABS.filter(tab => isShown(tab.name)).map(tab => tab.name)).toEqual(['core']);
        expect($('#VectFox_tab_core').hasClass('is-active')).toBe(true);
        expect($('#VectFox_tab_core').attr('aria-current')).toBe('page');
        expect($('#VectFox_tab_action').attr('aria-current')).toBeUndefined();
    });

    it('runs no page hook while the panel is closed', () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        $('#VectFox_tab_core').trigger('click');
        expect(hooks).toEqual([]);
    });

    it('moves the panel into its dialog, opens the shown page, and on close closes it and moves the panel back', async () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        const panel = document.getElementById('VectFox_settings');
        const closed = shell.openSettingsPanel();
        expect(panel.closest('dialog')).not.toBeNull();
        expect(hooks).toEqual(['open action']);

        $('#VectFox_tab_storyarc').trigger('click');
        expect(hooks).toEqual(['open action', 'close action', 'open storyarc']);

        host.closeDialog();
        await closed;
        expect(document.getElementById('VectFox_panel_holder').contains(panel)).toBe(true);
        expect(hooks.at(-1)).toBe('close storyarc');
    });

    it('opens again after it is closed, on the page last shown', async () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        const firstOpen = shell.openSettingsPanel('rag');
        host.closeDialog();
        await firstOpen;

        const secondOpen = shell.openSettingsPanel();
        expect(host.openPanelPopup).toHaveBeenCalledTimes(2);
        expect(isShown('rag')).toBe(true);
        expect(hooks).toEqual(['open rag', 'close rag', 'open rag']);
        host.closeDialog();
        await secondOpen;
    });

    it('opens from its launcher, by click and by Enter', async () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        $('#VectFox_open_panel').trigger('click');
        expect(host.openPanelPopup).toHaveBeenCalledTimes(1);
        host.closeDialog();
        await vi.waitFor(() => expect(document.getElementById('VectFox_panel_holder').contains(document.getElementById('VectFox_settings'))).toBe(true));

        $('#VectFox_open_panel').trigger($.Event('keydown', { key: 'Enter' }));
        expect(host.openPanelPopup).toHaveBeenCalledTimes(2);
        host.closeDialog();
    });

    it('stays open while a modal is open over it, so Escape closes only the modal', async () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        const closed = shell.openSettingsPanel();
        const [, { canClose }] = host.openPanelPopup.mock.calls[0];
        expect(canClose()).toBe(true);

        const dialog = document.querySelector('dialog');
        dialog.insertAdjacentHTML('beforeend', '<div class="vectfox-modal" id="a_modal"></div>');
        expect(canClose()).toBe(false);
        document.getElementById('a_modal').style.display = 'none';
        expect(canClose()).toBe(true);

        host.closeDialog();
        await closed;
    });

    it('moves the panel back and logs it when a page\'s close hook fails', async () => {
        const tabs = PANEL_TABS.map(tab => ({ name: tab.name, onClose: () => { throw new Error('the web could not close'); } }));
        shell.wireSettingsPanel(tabs, {});
        const panel = document.getElementById('VectFox_settings');
        const closed = shell.openSettingsPanel();
        host.closeDialog();
        await closed;
        expect(document.getElementById('VectFox_panel_holder').contains(panel)).toBe(true);
        expect(host.logError).toHaveBeenCalledWith(expect.stringContaining('the action page\'s onClose failed'), expect.any(Error));
    });

    it('writes the saved theme onto <html>, dark when none is saved, and saves a pick', () => {
        const settings = {};
        shell.wireSettingsPanel(tabsWithHooks(), settings);
        expect(document.documentElement.dataset.vfxTheme).toBe('dark');
        expect($('[data-vfx-theme-option="dark"]').attr('aria-pressed')).toBe('true');

        $('[data-vfx-theme-option="light"]').trigger('click');
        expect(document.documentElement.dataset.vfxTheme).toBe('light');
        expect(settings.panel_theme).toBe('light');
        expect(host.extensionSettings.vectfox.panel_theme).toBe('light');
        expect(host.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect($('[data-vfx-theme-option="light"]').hasClass('is-active')).toBe(true);
        expect($('[data-vfx-theme-option="dark"]').attr('aria-pressed')).toBe('false');
    });

    it('opens a field\'s detail from its (?), and closes it again', () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        $(`#${panelPageId('core')}`).append('<div class="vfx-field" id="a_field"><button type="button" class="vfx-help-toggle" aria-expanded="false"></button><p class="vfx-detail">More.</p></div>');
        $('#a_field .vfx-help-toggle').trigger('click');
        expect($('#a_field').hasClass('is-help-open')).toBe(true);
        expect($('#a_field .vfx-help-toggle').attr('aria-expanded')).toBe('true');
        $('#a_field .vfx-help-toggle').trigger('click');
        expect($('#a_field').hasClass('is-help-open')).toBe(false);
    });

    it('collapses a card from its chevron, a card painted later too', () => {
        shell.wireSettingsPanel(tabsWithHooks(), {});
        $(`#${panelPageId('core')}`).append('<section class="vfx-card" id="late_card"><button type="button" class="vfx-collapse" aria-expanded="true"></button></section>');
        $('#late_card .vfx-collapse').trigger('click');
        expect($('#late_card').hasClass('is-collapsed')).toBe(true);
        expect($('#late_card .vfx-collapse').attr('aria-expanded')).toBe('false');
    });
});
