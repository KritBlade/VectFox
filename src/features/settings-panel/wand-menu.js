/**
 * VectFox's row in SillyTavern's wand menu. Clicking it opens two rows under it, and keeps the menu open: Menu opens
 * VectFox's panel, and Last reply's lore shows the lorebook entries in the latest reply's prompt, LoreBase's picks in
 * blue and SillyTavern's own in green (features/reply-lore). Either closes the menu as SillyTavern's own rows do, and
 * any click elsewhere folds the two rows again.
 */
import { addWandMenuRow } from '../../sillytavern/wand-menu.js';
import { openReplyLore } from '../reply-lore/index.js';
import { openSettingsPanel } from './panel-shell.js';
import { wandMenuMarkup } from './wand-menu-markup.js';

// VectFox's row follows MVU Helper's, ranked 90, at the end of the wand menu.
const WAND_MENU_RANK = 91;

/** Add VectFox's row to the wand menu. Called once, at start-up. */
export function mountWandMenu() {
    const template = document.createElement('template');
    template.innerHTML = wandMenuMarkup();
    const root = template.content.firstElementChild;
    if (!addWandMenuRow(root, WAND_MENU_RANK)) return;
    const toggle = root.querySelector('#VectFox_wand_toggle');
    const options = [...root.querySelectorAll('.vfx-wand-option')];
    const chevron = root.querySelector('.vfx-wand-chevron');
    const showOptions = isShown => {
        for (const option of options) option.hidden = !isShown;
        toggle.setAttribute('aria-expanded', String(isShown));
        chevron.classList.toggle('fa-chevron-down', isShown);
        chevron.classList.toggle('fa-chevron-right', !isShown);
    };
    toggle.addEventListener('click', event => {
        // SillyTavern closes the menu on a click that reaches the page; this one only opens or folds the two rows.
        event.stopPropagation();
        showOptions(toggle.getAttribute('aria-expanded') !== 'true');
    });
    root.querySelector('[data-vectfox-wand="menu"]').addEventListener('click', () => void openSettingsPanel());
    root.querySelector('[data-vectfox-wand="last-reply-lore"]').addEventListener('click', () => void openReplyLore());
    document.addEventListener('click', () => showOptions(false));
}
