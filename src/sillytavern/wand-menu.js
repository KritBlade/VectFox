/**
 * SillyTavern's wand menu, the Extensions menu by the send box: where an extension adds its rows. SillyTavern builds it
 * before extensions load, shows the wand button once the menu holds a row, and closes the menu on any click whose
 * bubbling reaches the page, so a row that opens more rows stops its click there.
 */
import { log } from './log.js';

const WAND_MENU_ID = 'extensionsMenu';

/**
 * Add a row to the wand menu.
 * @param {HTMLElement} row
 * @returns {boolean} Whether it was added: false when SillyTavern has no wand menu, which the console says
 */
export function addWandMenuRow(row) {
    const menu = document.getElementById(WAND_MENU_ID);
    if (!menu) {
        log.warn(`VectFox: SillyTavern's wand menu (#${WAND_MENU_ID}) is missing, so VectFox adds no row to it`);
        return false;
    }
    menu.append(row);
    return true;
}
