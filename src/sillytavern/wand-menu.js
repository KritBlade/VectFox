/**
 * SillyTavern's wand menu, the Extensions menu by the send box: where an extension adds its rows. SillyTavern builds it
 * before extensions load, opening it with one slot per built-in extension, which those fill; other extensions append
 * their rows as each loads. It shows the wand button once the menu holds a row, and closes the menu on any click whose
 * bubbling reaches the page, so a row that opens more rows stops its click there.
 *
 * The rows of the extensions that rank theirs end the menu, in rank order, whichever loaded first: MVU Helper ranks 90
 * and VectFox 91, and each places its row with this same rule. A row another extension adds after them lands below.
 */
import { log } from './log.js';

const WAND_MENU_ID = 'extensionsMenu';

/**
 * Add a ranked row to the wand menu: every ranked row moves to the menu's end, lowest rank first, rows of one rank in
 * the order they came. Moving keeps each row's handlers.
 * @param {HTMLElement} row
 * @param {number} rank Its place among the ranked rows: MVU Helper's is 90, VectFox's 91
 * @returns {boolean} Whether it was added: false when SillyTavern has no wand menu, which the console says
 */
export function addWandMenuRow(row, rank) {
    const menu = document.getElementById(WAND_MENU_ID);
    if (!menu) {
        log.warn(`VectFox: SillyTavern's wand menu (#${WAND_MENU_ID}) is missing, so VectFox adds no row to it`);
        return false;
    }
    row.dataset.wandMenuRank = String(rank);
    const rankedRows = [...menu.querySelectorAll(':scope > [data-wand-menu-rank]'), row];
    menu.append(...rankedRows.sort((first, second) => Number(first.dataset.wandMenuRank) - Number(second.dataset.wandMenuRank)));
    return true;
}
