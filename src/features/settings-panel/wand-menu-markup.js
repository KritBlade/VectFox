// wand-menu-markup.js — VectFox's row in SillyTavern's wand menu, by the send box, and the two rows it opens: Menu,
// which opens VectFox's panel, and Last reply's lore, the lorebook entries in the latest reply's prompt. It keeps
// SillyTavern's look, as the menu around it does, so guard G6 leaves this file out. All three are rows of the menu
// itself, so SillyTavern stacks and styles them as it does its own rows.

/** The VectFox row, with its two options folded under it. */
export function wandMenuMarkup() {
    return `<div id="VectFox_wand" class="extension_container">
    <div id="VectFox_wand_toggle" class="list-group-item flex-container flexGap5" aria-expanded="false">
        <div class="fa-solid fa-sliders extensionsMenuExtensionButton"></div>
        <span>VectFox</span>
        <i class="fa-solid fa-chevron-right vfx-wand-chevron"></i>
    </div>
    <div class="list-group-item flex-container flexGap5 vfx-wand-option" data-vectfox-wand="menu" hidden>
        <div class="fa-solid fa-bars extensionsMenuExtensionButton"></div>
        <span>Menu</span>
    </div>
    <div class="list-group-item flex-container flexGap5 vfx-wand-option" data-vectfox-wand="last-reply-lore" hidden>
        <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
        <span>Last reply's lore</span>
    </div>
</div>`;
}
