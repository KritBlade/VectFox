/**
 * The WorldInfo page's LoreBase controls (plan §5.2 and §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). LoreBase's switch: turning it on asks first about Vector Storage's
 * World Info search when that is on, and while it is off every other LoreBase control on the page is disabled, with a
 * notice saying why. The books card: it draws the open chat's books with their selected counts and locks, and opens
 * LoreBase's selection screen on the book a row names, or on the chat's first book from the card's own button,
 * drawing the list again once the screen closes.
 */
import { log } from '../../sillytavern/log.js';
import {
    chatBookLocks, isLoreBaseSwitchedOn, onLoreBaseSwitchChange, openLoreBaseSelection, turnLoreBaseOff, turnLoreBaseOn,
} from '../lorebase/index.js';
import { loreBaseBooksMarkup } from './worldinfo-page-markup.js';

const SWITCH_ID = 'VectFox_lorebase_enabled';
const LOREBASE_CARD_IDS = ['VectFox_lorebase_books_card', 'VectFox_lorebase_model_card'];
// The cards' own collapse and help buttons, which keep working while the switch is off.
const CARD_CHROME = '.vfx-collapse, .vfx-help-toggle';

/** The page's LoreBase controls that wait for the switch: every one on its two cards but the switch and card chrome. */
function waitingControls() {
    return LOREBASE_CARD_IDS
        .flatMap(id => [...(document.getElementById(id)?.querySelectorAll('button, input, select, textarea') ?? [])])
        .filter(control => control.id !== SWITCH_ID && !control.matches(CARD_CHROME));
}

/** Show LoreBase's switch as saved, and while it is off disable the page's other LoreBase controls, saying why. */
function paintLoreBaseSwitch() {
    const isOn = isLoreBaseSwitchedOn();
    const toggle = document.getElementById(SWITCH_ID);
    if (toggle) toggle.checked = isOn;
    for (const control of waitingControls()) control.disabled = !isOn;
    const offNotice = document.getElementById('VectFox_lorebase_off_notice');
    if (offNotice) offNotice.hidden = isOn;
}

/** Draw the open chat's LoreBase books, once the panel is mounted, under the switch as saved. */
export function refreshLoreBaseBooks() {
    const list = document.getElementById('VectFox_lorebase_books');
    if (list) list.innerHTML = loreBaseBooksMarkup(chatBookLocks());
    paintLoreBaseSwitch();
}

/** Wire LoreBase's switch, and open the selection screen from the card's buttons. Called once, as the panel is mounted. */
export function bindLoreBaseBooksCard() {
    document.getElementById(SWITCH_ID)?.addEventListener('change', async event => {
        if (event.currentTarget.checked) await turnLoreBaseOn();
        else turnLoreBaseOff();
        // Turning on can end off, when the user keeps Vector Storage's World Info search.
        paintLoreBaseSwitch();
    });
    // A reply's question can turn LoreBase off while the page is shown.
    onLoreBaseSwitchChange(paintLoreBaseSwitch);
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('click', async event => {
        const opener = event.target.closest('[data-lorebase-choose]');
        if (!opener || opener.disabled) return;
        try {
            await openLoreBaseSelection({ bookName: opener.dataset.lorebaseChoose });
        } catch (error) {
            log.error('LoreBase: the selection screen failed:', error);
        }
        refreshLoreBaseBooks();
    });
}
