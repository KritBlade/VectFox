// wand-menu-markup.js — VectFox's row in SillyTavern's wand menu, by the send box, and the two rows it opens: Menu,
// which opens VectFox's panel, and Selected lorebook, the lorebook entries in the latest reply's prompt. It keeps
// SillyTavern's look, as the menu around it does, so guard G6 leaves this file out.

/** The VectFox row, with its two options folded under it. */
export function wandMenuMarkup() {
    return `<div id="VectFox_wand" class="extension_container">
    <div id="VectFox_wand_toggle" class="list-group-item flex-container flexGap5" aria-expanded="false">
        <div class="fa-solid fa-sliders extensionsMenuExtensionButton"></div>
        <span>VectFox</span>
        <i class="fa-solid fa-chevron-right vfx-wand-chevron"></i>
    </div>
    <div id="VectFox_wand_options" hidden>
        <div class="list-group-item flex-container flexGap5 vfx-wand-option" data-vectfox-wand="menu">
            <div class="fa-solid fa-bars extensionsMenuExtensionButton"></div>
            <span>Menu</span>
        </div>
        <div class="list-group-item flex-container flexGap5 vfx-wand-option" data-vectfox-wand="selected-lorebook">
            <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
            <span>Selected lorebook</span>
        </div>
    </div>
</div>`;
}
