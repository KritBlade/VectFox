// drawer-launcher-markup.js — VectFox's entry in SillyTavern's Extensions drawer: SillyTavern's own drawer frame, the
// launcher that opens the panel, and the holder the panel waits in while its dialog is closed (panel-shell.js moves it
// in and out). It keeps SillyTavern's look, as the drawer around it does, so guard G6 leaves this file out.

/**
 * The drawer entry, with the panel's markup in its holder.
 *
 * @param {string} panelMarkup - The GUI-DNA shell (settings-panel.js)
 * @returns {string}
 */
export function drawerLauncherMarkup(panelMarkup) {
    return `<div id="VectFox_drawer">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>VectFox - Advanced RAG</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="VectFox_open_panel" class="menu_button" role="button" tabindex="0">
                <i class="fa-solid fa-sliders"></i>
                <span>Open VectFox</span>
            </div>
            <div id="VectFox_panel_holder">${panelMarkup}</div>
        </div>
    </div>
</div>`;
}
