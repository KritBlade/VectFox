/**
 * The WorldInfo page's LoreBase controls (plan §5.2 and §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). LoreBase's switch: turning it on asks first about Vector Storage's
 * World Info search when that is on, and while it is off every other LoreBase control on the page is disabled, with a
 * notice saying why, but Delete all keys. The books card: it draws the open chat's books with their selected counts and
 * locks, and opens LoreBase's selection screen on the book a row names, or on the chat's first book from the card's own
 * button, drawing the list again once the screen closes. Generate all keys writes the keys of every selected entry, in
 * every book, that has none; Delete all keys, once confirmed, deletes every key the user has (D17); the card's status
 * line says how each went.
 */
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import {
    chatBookLocks, deleteAllKeys, isLoreBaseSwitchedOn, keyWritingProblem, onLoreBaseSwitchChange, openLoreBaseSelection,
    turnLoreBaseOff, turnLoreBaseOn, writeKeysOfSelections,
} from '../lorebase/index.js';
import { loreBaseBooksMarkup } from './worldinfo-page-markup.js';

const SWITCH_ID = 'VectFox_lorebase_enabled';
const GENERATE_KEYS_ID = 'VectFox_lorebase_generate_keys';
const DELETE_KEYS_ID = 'VectFox_lorebase_delete_keys';
const KEYS_STATUS_ID = 'VectFox_lorebase_keys_status';
// Controls that work while the switch is off: the switch, and Delete all keys, since turning LoreBase on writes keys.
const SWITCH_FREE_IDS = new Set([SWITCH_ID, DELETE_KEYS_ID]);
const LOREBASE_CARD_IDS = ['VectFox_lorebase_books_card', 'VectFox_lorebase_model_card'];
// The cards' own collapse and help buttons, which keep working while the switch is off.
const CARD_CHROME = '.vfx-collapse, .vfx-help-toggle';

/** The page's LoreBase controls that wait for the switch: every one on its two cards but SWITCH_FREE_IDS and card chrome. */
function waitingControls() {
    return LOREBASE_CARD_IDS
        .flatMap(id => [...(document.getElementById(id)?.querySelectorAll('button, input, select, textarea') ?? [])])
        .filter(control => !SWITCH_FREE_IDS.has(control.id) && !control.matches(CARD_CHROME));
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

function showKeysStatus(text) {
    const status = document.getElementById(KEYS_STATUS_ID);
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
}

const counted = (count, one, many) => `${Number(count).toLocaleString('en-US')} ${count === 1 ? one : many}`;

/**
 * What Generate all keys did, in a line: the keys written, the entries that failed or were stopped, the books that
 * could not be read.
 */
function generatedText({ written, failed, stopped, unreadBooks }) {
    const lines = [written || failed || stopped ? `Wrote the keys of ${counted(written, 'entry', 'entries')}.` : 'No selected entry was missing keys.'];
    if (failed) lines.push(`${counted(failed, 'entry', 'entries')} failed, as the toast says.`);
    if (stopped) lines.push(`Stopped before ${counted(stopped, 'entry', 'entries')}.`);
    if (unreadBooks) lines.push(`${counted(unreadBooks, 'lorebook', 'lorebooks')} could not be read; the console says why.`);
    return lines.join(' ');
}

/** Generate all keys: write the keys of every selected entry, in every book, that has none. */
async function generateAllKeys(settings, button) {
    const problem = keyWritingProblem(settings);
    if (problem) {
        showKeysStatus(`Not written: ${problem}`);
        return;
    }
    button.disabled = true;
    showKeysStatus('Writing the keys of selected entries that have none; the progress panel counts them.');
    try {
        showKeysStatus(generatedText(await writeKeysOfSelections(settings)));
    } catch (error) {
        log.error('LoreBase: Generate all keys failed:', error);
        showKeysStatus(`Not written: ${error?.message || error}`);
    } finally {
        button.disabled = !isLoreBaseSwitchedOn();
    }
}

/** Delete all keys, once the user confirms: every LoreBase key they have, in every book. */
async function deleteKeys(button) {
    const isConfirmed = await confirmPopup([
        { text: 'Delete every LoreBase key you have, in every lorebook?' },
        { text: 'Selected entries stay selected, but send nothing until Generate all keys writes their keys again.' },
        { text: 'Keys you edited by hand are lost.' },
    ], { okButton: 'Delete all keys', isDestructive: true });
    if (!isConfirmed) return;
    button.disabled = true;
    try {
        const deleted = await deleteAllKeys();
        showKeysStatus(`Deleted the keys of ${counted(deleted, 'entry', 'entries')}. Selected entries send nothing until Generate all keys.`);
    } catch (error) {
        log.warn('LoreBase: Delete all keys failed:', error);
        showKeysStatus(`Not deleted: ${error?.message || error}`);
    } finally {
        button.disabled = false;
    }
}

/**
 * Wire LoreBase's switch, open the selection screen from the card's buttons, and run Generate all keys and Delete all
 * keys. Called once, as the panel is mounted.
 * @param {object} settings - VectFox settings
 */
export function bindLoreBaseBooksCard(settings) {
    document.getElementById(GENERATE_KEYS_ID)?.addEventListener('click', event => void generateAllKeys(settings, event.currentTarget));
    document.getElementById(DELETE_KEYS_ID)?.addEventListener('click', event => void deleteKeys(event.currentTarget));
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
