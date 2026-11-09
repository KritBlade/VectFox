/**
 * ============================================================================
 * SETTINGS PANEL SHELL
 * ============================================================================
 * The settings panel's GUI-DNA shell (mvu-helper/devdoc/gui-dna.md): the rail that
 * switches pages, the theme switch, the behaviours every page shares (a field's (?)
 * detail, collapsing a card, a slider following its number box), and the dialog the
 * panel opens in. Each page's content is painted by its own code; the tab table
 * (which pages exist and what runs as one shows or hides) is handed in through
 * wireSettingsPanel.
 *
 * THE DIALOG. The extensions drawer gives an extension about half the window, so the
 * drawer holds only a launcher and the panel opens in a near-fullscreen dialog. The
 * panel is MOVED into it, never cloned: listeners belong to the node, so every handler
 * bound at startup keeps working inside the dialog, and on close the panel moves back
 * to its hidden holder.
 *
 * THE THEME. The rail's foot switches the palette between Night Slate (dark, the
 * default) and Soft Silver (light). The choice is `panel_theme`, written as
 * data-vfx-theme on <html>, which palette.css reads, so one write themes the panel
 * and every dialog VectFox opens.
 * ============================================================================
 */

import { openPanelPopup } from '../../sillytavern/popup.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { log } from '../../sillytavern/log.js';
import { panelThemeOf } from '../../shared/gui-dna/gui-dna-core.js';
import { FIRST_PANEL_TAB, panelPageId, panelTabId } from './panel-shell-markup.js';

const PANEL_ROOT_ID = 'VectFox_settings';
const PANEL_HOLDER_ID = 'VectFox_panel_holder';
const PANEL_LAUNCHER_ID = 'VectFox_open_panel';

/**
 * A page of the panel and what runs as it shows or hides. onOpen runs when the page shows
 * in the open panel, onClose when another page replaces it or the panel closes.
 *
 * @typedef {{name: string, onOpen?: () => unknown, onClose?: () => unknown}} PanelTab
 */

/** @type {PanelTab[]} */
let panelTabs = [];
let shownTabName = FIRST_PANEL_TAB;
let isPanelOpen = false;

// The modals a page opens over the panel (Database Browser, Vectorize Content, Diagnostics, ...). Each sits on the
// panel's dialog while open (sillytavern/popup.js placeOnTopmostModalLayer), and Escape belongs to it.
const MODAL_SELECTOR = '.vectfox-modal, .vectfox-visualizer-modal';

/** Whether a modal is open over the panel, so Escape or Close leaves the panel open under it. */
function isModalOpenOverPanel(panel) {
    const dialog = panel.closest('dialog');
    if (!dialog) return false;
    return [...dialog.children].some(child => child.matches(MODAL_SELECTOR) && getComputedStyle(child).display !== 'none');
}

/** Run one of a page's hooks. A hook that fails is logged, and the panel carries on. */
function runTabHook(name, hookName) {
    const tab = panelTabs.find(each => each.name === name);
    if (!tab?.[hookName]) return;
    try {
        Promise.resolve(tab[hookName]()).catch(error => log.error(`VectFox UI: the ${name} page's ${hookName} failed:`, error));
    } catch (error) {
        log.error(`VectFox UI: the ${name} page's ${hookName} failed:`, error);
    }
}

/**
 * Show one page and mark its nav item. In the open panel, the page it replaces closes
 * and the new one opens.
 *
 * @param {string} name - A page in the tab table
 */
export function showPanelTab(name) {
    const previousName = shownTabName;
    shownTabName = name;
    for (const tab of panelTabs) {
        const isShown = tab.name === name;
        $(`#${panelPageId(tab.name)}`).toggle(isShown);
        $(`#${panelTabId(tab.name)}`).toggleClass('is-active', isShown).attr('aria-current', isShown ? 'page' : null);
    }
    if (!isPanelOpen || previousName === name) return;
    runTabHook(previousName, 'onClose');
    runTabHook(name, 'onOpen');
}

/**
 * Open the panel in its dialog on a page, or show that page if the panel is open, and wait
 * until the dialog closes. Never throws.
 *
 * @param {string} [name] - The page to show; the last one shown when omitted
 * @returns {Promise<void>}
 */
export async function openSettingsPanel(name = shownTabName) {
    const panel = document.getElementById(PANEL_ROOT_ID);
    const holder = document.getElementById(PANEL_HOLDER_ID);
    if (!panel || !holder) {
        log.error('VectFox UI: the settings panel or its holder is missing, so it cannot open');
        return;
    }
    if (isPanelOpen) {
        showPanelTab(name);
        return;
    }
    showPanelTab(name);
    isPanelOpen = true;
    // Opened first, so the page is in the dialog and has its size when its hook runs.
    const closed = openPanelPopup(panel, { canClose: () => !isModalOpenOverPanel(panel) });
    runTabHook(shownTabName, 'onOpen');
    try {
        await closed;   // logs its own failure and resolves; never throws
    } finally {
        // ALWAYS first: SillyTavern removes a closed dialog with everything in it, and a panel
        // left inside one would leave the launcher opening an empty dialog from then on.
        holder.appendChild(panel);
        isPanelOpen = false;
        runTabHook(shownTabName, 'onClose');
    }
}

/**
 * Write the saved theme onto <html> and mark its option on the rail. Runs once the rail
 * exists, before any dialog opens, and on every pick.
 */
export function applyPanelTheme() {
    const theme = panelThemeOf(extension_settings.vectfox?.panel_theme);
    document.documentElement.dataset.vfxTheme = theme;
    $(`#${PANEL_ROOT_ID} [data-vfx-theme-option]`).each(function () {
        const isChosen = this.dataset.vfxThemeOption === theme;
        $(this).toggleClass('is-active', isChosen).attr('aria-pressed', String(isChosen));
    });
}

/**
 * Bind the shell once, at startup. Each page's nav item and page are found by id, from
 * the tab table.
 *
 * @param {PanelTab[]} tabs
 * @param {object} settings - The settings object the panel's other handlers write
 */
export function wireSettingsPanel(tabs, settings) {
    panelTabs = tabs;
    for (const tab of panelTabs) {
        $(`#${panelTabId(tab.name)}`).on('click', () => showPanelTab(tab.name));
    }
    // SillyTavern's own look, so a div acting as a button: Enter and Space open it too.
    $(`#${PANEL_LAUNCHER_ID}`).on('click', () => void openSettingsPanel())
        .on('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            void openSettingsPanel();
        });
    $(`#${PANEL_ROOT_ID} [data-vfx-theme-option]`).on('click', function () {
        settings.panel_theme = panelThemeOf(this.dataset.vfxThemeOption);
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        applyPanelTheme();
    });
    applyPanelTheme();

    // Delegated, so a field or card a page paints later behaves the same way.
    // The (?) beside a label opens its field's longer explanation in place: a tap, never a hover.
    $(`#${PANEL_ROOT_ID}`).on('click', '.vfx-help-toggle', function () {
        const $field = $(this).closest('.vfx-field');
        const isOpen = !$field.hasClass('is-help-open');
        $field.toggleClass('is-help-open', isOpen);
        $(this).attr('aria-expanded', String(isOpen));
    });
    $(`#${PANEL_ROOT_ID}`).on('click', '.vfx-collapse', function () {
        const $box = $(this).closest('.vfx-card, .vfx-record');
        const isCollapsed = !$box.hasClass('is-collapsed');
        $box.toggleClass('is-collapsed', isCollapsed);
        $(this).attr('aria-expanded', String(!isCollapsed));
    });
    // Dragging a slider writes its number box and fires the box's own input and change, so the box's handler saves
    // exactly as if the number had been typed; typing a number moves its slider.
    $(`#${PANEL_ROOT_ID}`).on('input', '.vfx-range[data-vfx-slider-for]', function () {
        $(document.getElementById(this.dataset.vfxSliderFor)).val(this.value).trigger('input').trigger('change');
    });
    $(`#${PANEL_ROOT_ID}`).on('input change', 'input[type="number"]', function () {
        $(`#${PANEL_ROOT_ID} .vfx-range[data-vfx-slider-for="${this.id}"]`).val(this.value);
    });
    syncSliders();
}

/**
 * Move every slider to its number box, which owns the value. Setting a number with .val() fires no event, so code
 * that sets numbers after the panel is wired calls this.
 */
export function syncSliders() {
    $(`#${PANEL_ROOT_ID} .vfx-range[data-vfx-slider-for]`).each(function () {
        const number = document.getElementById(this.dataset.vfxSliderFor);
        if (number) this.value = number.value;
    });
}
