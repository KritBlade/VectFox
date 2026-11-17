/**
 * The WorldInfo page's LoreBase controls (plan §5.2 and §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). LoreBase's switch: turning it on asks first about the selected entries'
 * missing keys and Vector Storage's World Info search, and with nothing selected says to choose entries. While it is
 * off, the user still chooses entries and sets its model, and a notice says to do that before turning it on; only
 * Generate all keys waits, since turning LoreBase on asks to write them. The books card: it draws the open chat's books
 * with their selected counts and locks, and opens LoreBase's selection screen on the book a row names, or on the chat's
 * first book from the card's own button, drawing the list again once the screen closes and saying where the
 * selection's keys stand. Generate all keys writes the keys of every selected entry, in every book, that has none;
 * Delete all keys, once confirmed, deletes every key the user has and turns LoreBase off (D17). The card's status line
 * says how each went, and shows every key run on the progress panel, whichever started it: the entries being keyed,
 * then what was written.
 */
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import {
    chatBookLocks, deleteAllKeys, isLoreBaseSwitchedOn, keyWritingProblem, onKeyRunChange, onLoreBaseSwitchChange,
    openLoreBaseSelection, selectedLoreBookNames, turnLoreBaseOff, turnLoreBaseOn, writeKeysOfSelections,
} from '../lorebase/index.js';
import { loreBaseBooksMarkup } from './worldinfo-page-markup.js';

const SWITCH_ID = 'VectFox_lorebase_enabled';
const GENERATE_KEYS_ID = 'VectFox_lorebase_generate_keys';
const DELETE_KEYS_ID = 'VectFox_lorebase_delete_keys';
const KEYS_STATUS_ID = 'VectFox_lorebase_keys_status';
const NOTHING_SELECTED_TEXT = 'LoreBase is on, with nothing selected yet. Choose entries: each one you turn on has its keys written then.';
let isGeneratingKeys = false;

/**
 * Show LoreBase's switch as saved; while it is off, show the notice and disable Generate all keys. The status line's
 * call to choose entries goes once it no longer holds: LoreBase is off, or something is selected.
 */
function paintLoreBaseSwitch() {
    const isOn = isLoreBaseSwitchedOn();
    const toggle = document.getElementById(SWITCH_ID);
    if (toggle) toggle.checked = isOn;
    const generate = document.getElementById(GENERATE_KEYS_ID);
    if (generate) generate.disabled = !isOn || isGeneratingKeys;
    const offNotice = document.getElementById('VectFox_lorebase_off_notice');
    if (offNotice) offNotice.hidden = isOn;
    const isNothingSelectedShown = document.getElementById(KEYS_STATUS_ID)?.textContent === NOTHING_SELECTED_TEXT;
    if (isNothingSelectedShown && (!isOn || selectedLoreBookNames().length)) showKeysStatus('');
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

/**
 * A key run on the progress panel, whichever started it (Generate all keys, turning LoreBase on, closing the selection
 * screen, Regenerate keys): what it keys, then what it did.
 */
function showKeyRun({ count, totals }) {
    showKeysStatus(totals ? generatedText(totals)
        : `Writing the keys of ${counted(count, 'selected entry', 'selected entries')} with none; the progress panel counts them.`);
}

/** Generate all keys: write the keys of every selected entry, in every book, that has none. */
async function generateAllKeys(settings, button) {
    const problem = keyWritingProblem(settings);
    if (problem) {
        showKeysStatus(`Not written: ${problem}`);
        return;
    }
    isGeneratingKeys = true;
    button.disabled = true;
    showKeysStatus('Counting the selected entries with no keys.');
    try {
        showKeysStatus(generatedText(await writeKeysOfSelections(settings)));
    } catch (error) {
        log.error('LoreBase: Generate all keys failed:', error);
        showKeysStatus(`Not written: ${error?.message || error}`);
    } finally {
        isGeneratingKeys = false;
        paintLoreBaseSwitch();
    }
}

/** Turn LoreBase on from its switch; with nothing selected anywhere, the status line says to choose entries next. */
async function switchLoreBaseOn() {
    if (await turnLoreBaseOn() && !selectedLoreBookNames().length) showKeysStatus(NOTHING_SELECTED_TEXT);
}

/**
 * Delete all keys, once the user confirms: every LoreBase key they have, in every book. Once deleted, LoreBase turns
 * off, since its selected entries would send nothing; turning it on again asks to write their keys.
 */
async function deleteKeys(button) {
    const isConfirmed = await confirmPopup([
        { text: 'Delete every LoreBase key you have, in every lorebook?' },
        { text: 'Use LoreBase turns off, and selections are kept; turning it on asks to write their keys again.' },
        { text: 'Keys you edited by hand are lost.' },
    ], { okButton: 'Delete all keys', isDestructive: true });
    if (!isConfirmed) return;
    button.disabled = true;
    try {
        const deleted = await deleteAllKeys();
        if (isLoreBaseSwitchedOn()) turnLoreBaseOff();
        showKeysStatus(`Deleted the keys of ${counted(deleted, 'entry', 'entries')}: no entry has keys now, and Use LoreBase `
            + 'is off. Turn it on to write them again.');
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
        if (event.currentTarget.checked) await switchLoreBaseOn();
        else turnLoreBaseOff();
        // Turning on can end off, when the user keeps Vector Storage's World Info search.
        paintLoreBaseSwitch();
    });
    // A reply's question can turn LoreBase off while the page is shown.
    onLoreBaseSwitchChange(paintLoreBaseSwitch);
    // Every key run on the progress panel, Generate all keys' or another's, shows on the status line.
    onKeyRunChange(showKeyRun);
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('click', async event => {
        const opener = event.target.closest('[data-lorebase-choose]');
        if (!opener) return;
        let chosen = null;
        try {
            chosen = await openLoreBaseSelection({ bookName: opener.dataset.lorebaseChoose });
        } catch (error) {
            log.error('LoreBase: the selection screen failed:', error);
        }
        refreshLoreBaseBooks();
        showChosenKeys(chosen);
    });
}

/**
 * Where the selection's keys stand once the selection screen closed while LoreBase is on: all written, or how many have
 * none after the user said Not now. A run started on the screen's question writes its own lines (showKeyRun).
 * @param {{missingCount: number, decidedCount: number, isWriting: boolean}|null} chosen - From openLoreBaseSelection
 */
function showChosenKeys(chosen) {
    if (!chosen || chosen.isWriting || !chosen.decidedCount) return;
    if (chosen.missingCount) {
        showKeysStatus(`${counted(chosen.missingCount, 'selected entry has', 'selected entries have')} no keys, so `
            + `${chosen.missingCount === 1 ? 'it sends' : 'they send'} nothing yet. Generate all keys writes them.`);
    } else {
        showKeysStatus(chosen.decidedCount === 1 ? 'The selected entry has its keys.' : `All ${counted(chosen.decidedCount, 'selected entry', 'selected entries')} have keys.`);
    }
}
