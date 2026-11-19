/**
 * The WorldInfo page's LoreBase controls (plan §5.2 and §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md, §4.3 of InternalProject/Vectfox/plans/lorebook-multi-vector.md, §3.4 of
 * InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md). LoreBase's switch: turning it on asks first
 * about the keys and vectors the selected entries lack and Vector Storage's World Info search, and with nothing
 * selected says to choose entries. While it is off, the user still chooses entries and sets its model, and a notice
 * says to do that before turning it on; only the Generate buttons wait, since turning LoreBase on asks to write them.
 * The books card: it draws the open chat's books with their selected counts and locks, then how many of each book's
 * selected entries have keys and vectors, and opens LoreBase's selection screen on the book a row names, or on the
 * chat's first book from the card's own button, drawing the list again once the screen closes and saying what the
 * selection lacks of each kind, LoreBase on or off. Generate keys and Generate vectors write what the selected entries
 * of every book lack of their kind, and Generate all both; Delete all, once confirmed, deletes every key and vector the
 * user has and turns LoreBase off (D17). Each goes through LoreBase's storage module. The card's status line says how
 * each went, and shows every writing run on the progress panel, whichever started it: the entries being written, then
 * what was written and the books the run locked to its chat (§6.1 of lorebook-multi-vector.md), a line that goes once
 * another chat is open.
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import {
    BOTH_KINDS, KEYS, VECTORS, chatBookLocks, deleteStored, isLoreBaseSwitchedOn, onLoreBaseSwitchChange, onWritingRunChange,
    openLoreBaseSelection, selectedLoreBookNames, storedCountsOfBooks, turnLoreBaseOff, turnLoreBaseOn, writeMissing, writingProblem,
} from '../lorebase/index.js';
import { loreBaseBooksMarkup } from './worldinfo-page-markup.js';

const SWITCH_ID = 'VectFox_lorebase_enabled';
// Each Generate button, the kinds it writes, and its name in the console.
const GENERATE_BUTTONS = [
    { id: 'VectFox_lorebase_generate_keys', kinds: [KEYS], name: 'Generate keys' },
    { id: 'VectFox_lorebase_generate_vectors', kinds: [VECTORS], name: 'Generate vectors' },
    { id: 'VectFox_lorebase_generate_all', kinds: BOTH_KINDS, name: 'Generate all' },
];
const DELETE_ALL_ID = 'VectFox_lorebase_delete_all';
const BOOKS_STATUS_ID = 'VectFox_lorebase_books_status';
const NOTHING_SELECTED_TEXT = 'LoreBase is on, with nothing selected yet. Choose entries: each one you turn on has its keys and vectors written then.';
let isGenerating = false;
// Counts the card's refreshes, so a refresh whose books loaded after a newer one began draws nothing.
let refreshCount = 0;
// The chat the status line says books were locked to as "this chat", so the line goes once another chat is open.
let statusLockChatId = null;
// The settings the card was bound with, which counting the books' keys and vectors reads.
let cardSettings = null;

/**
 * Show LoreBase's switch as saved; while it is off, show the notice and disable the Generate buttons, as while one of
 * them runs. The status line's call to choose entries goes once it no longer holds: LoreBase is off, or something is
 * selected.
 */
function paintLoreBaseSwitch() {
    const isOn = isLoreBaseSwitchedOn();
    const toggle = document.getElementById(SWITCH_ID);
    if (toggle) toggle.checked = isOn;
    for (const { id } of GENERATE_BUTTONS) {
        const generate = document.getElementById(id);
        if (generate) generate.disabled = !isOn || isGenerating;
    }
    const offNotice = document.getElementById('VectFox_lorebase_off_notice');
    if (offNotice) offNotice.hidden = isOn;
    const isNothingSelectedShown = document.getElementById(BOOKS_STATUS_ID)?.textContent === NOTHING_SELECTED_TEXT;
    if (isNothingSelectedShown && (!isOn || selectedLoreBookNames().length)) showBooksStatus('');
}

function drawBooks(status) {
    const list = document.getElementById('VectFox_lorebase_books');
    if (list) list.innerHTML = loreBaseBooksMarkup(status);
}

/**
 * Draw the open chat's LoreBase books, once the panel is mounted, under the switch as saved: each row counts the
 * selected entries LoreBase decides, as the keys line does, once the books are loaded, then how many of them have keys
 * and vectors, once those are read. Only the newest refresh draws, so a slow load never draws a chat left since. A
 * status line saying books were locked to this chat goes once another chat is open.
 * @returns {Promise<void>}
 */
export async function refreshLoreBaseBooks() {
    const refresh = ++refreshCount;
    if (statusLockChatId !== null && statusLockChatId !== (getCurrentChatId() ?? null)) showBooksStatus('');
    paintLoreBaseSwitch();
    let status;
    try {
        status = await chatBookLocks();
        if (refresh !== refreshCount) return;
        drawBooks(status);
    } catch (error) {
        log.warn("LoreBase: the WorldInfo page's book list could not be drawn:", error);
        return;
    }
    const selectedBookNames = status.books.filter(book => book.selectedCount).map(book => book.bookName);
    if (!selectedBookNames.length || !cardSettings) return;
    let counts;
    try {
        counts = await storedCountsOfBooks(selectedBookNames, cardSettings);
    } catch (error) {
        log.warn("LoreBase: the keys and vectors of the WorldInfo page's books could not be counted:", error);
        return;
    }
    if (refresh !== refreshCount || !counts.size) return;
    drawBooks({ ...status, books: status.books.map(book => ({ ...book, ...counts.get(book.bookName) })) });
}

/**
 * Show a line on the status line, or hide it when empty.
 * @param {string} text
 * @param {{lockChatId?: string|null}} [options] - lockChatId: the chat the line says books were locked to as "this chat"
 */
function showBooksStatus(text, { lockChatId = null } = {}) {
    statusLockChatId = lockChatId;
    const status = document.getElementById(BOOKS_STATUS_ID);
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
}

const counted = (count, one, many) => `${Number(count).toLocaleString('en-US')} ${count === 1 ? one : many}`;
const bookList = new Intl.ListFormat('en', { type: 'conjunction' });
// What a run of these kinds writes, in words: "keys", "vectors", or "keys or vectors".
const kindsText = kinds => kinds.join(' or ');

/**
 * What a writing run did, in a line: the keys and the vectors written, the entries that failed or were stopped, the
 * books that could not be read, and the books it locked to its chat, "this chat" while that chat is open.
 * @param {object} outcome - The run's outcome (WritingRunOutcome in lorebase-storage.js)
 * @param {boolean} isLockChatOpen - Whether the chat the run locked books to is the open one
 */
function writtenText({ keysWritten, vectorsWritten, failed, stopped, unreadBooks, chatLock }, isLockChatOpen) {
    const written = [
        keysWritten ? `the keys of ${counted(keysWritten, 'entry', 'entries')}` : '',
        vectorsWritten ? `the vectors of ${counted(vectorsWritten, 'entry', 'entries')}` : '',
    ].filter(Boolean);
    const lines = [written.length ? `Wrote ${written.join(' and ')}.` : 'Wrote no keys or vectors.'];
    if (failed) lines.push(`${counted(failed, 'entry', 'entries')} failed, as the toast says.`);
    if (stopped) lines.push(`Stopped before ${counted(stopped, 'entry', 'entries')}.`);
    if (unreadBooks) lines.push(`${counted(unreadBooks, 'lorebook', 'lorebooks')} could not be read; the console says why.`);
    if (chatLock) {
        const where = isLockChatOpen ? 'this chat' : 'the chat open when the writing began';
        lines.push(`Locked ${bookList.format(chatLock.bookNames.map(bookName => `"${bookName}"`))} to ${where}.`);
    }
    return lines.join(' ');
}

/**
 * What a writing run did, on the status line, which notes the chat it locked books to while that chat is open; a run
 * that locked books draws the list again, so their rows show the lock. A run with nothing missing of its kinds says so.
 * @param {object} outcome - The run's outcome (WritingRunOutcome in lorebase-storage.js)
 * @param {readonly string[]} [kinds] - What the run wrote
 */
function showRunOutcome(outcome, kinds = BOTH_KINDS) {
    const isLockChatOpen = Boolean(outcome.chatLock) && outcome.chatLock.chatId === (getCurrentChatId() ?? null);
    const hasDoneAnything = outcome.keysWritten || outcome.vectorsWritten || outcome.failed || outcome.stopped;
    const text = hasDoneAnything || outcome.unreadBooks ? writtenText(outcome, isLockChatOpen) : `No selected entry was missing ${kindsText(kinds)}.`;
    showBooksStatus(text, { lockChatId: isLockChatOpen ? outcome.chatLock.chatId : null });
    if (outcome.chatLock) void refreshLoreBaseBooks();
}

/**
 * A writing run on the progress panel, whichever started it (a Generate button, turning LoreBase on, closing the
 * selection screen, Regenerate keys): what it writes, then what it did.
 */
function showWritingRun({ count, outcome }) {
    if (outcome) showRunOutcome(outcome);
    else showBooksStatus(`Writing what ${counted(count, 'selected entry lacks', 'selected entries lack')}; the progress panel counts them.`);
}

/**
 * A Generate button: write what every selected entry, in every book, lacks of the button's kinds; a run that writes
 * keys locks the books it writes keys for to the open chat (§6.1 of lorebook-multi-vector.md). The Generate buttons
 * wait until it ends.
 * @param {object} settings - VectFox settings
 * @param {{kinds: readonly string[], name: string}} button - One of GENERATE_BUTTONS
 */
async function generate(settings, { kinds, name }) {
    const problem = writingProblem(settings, kinds);
    if (problem) {
        showBooksStatus(`Not written: ${problem}`);
        return;
    }
    isGenerating = true;
    paintLoreBaseSwitch();
    showBooksStatus(`Counting the selected entries without ${kindsText(kinds)}.`);
    try {
        showRunOutcome(await writeMissing(settings, kinds), kinds);
    } catch (error) {
        log.error(`LoreBase: ${name} failed:`, error);
        showBooksStatus(`Not written: ${error?.message || error}`);
    } finally {
        isGenerating = false;
        paintLoreBaseSwitch();
    }
}

/** Turn LoreBase on from its switch; with nothing selected anywhere, the status line says to choose entries next. */
async function switchLoreBaseOn() {
    if (await turnLoreBaseOn() && !selectedLoreBookNames().length) showBooksStatus(NOTHING_SELECTED_TEXT);
}

/**
 * Delete all, once the user confirms: every LoreBase key and vector they have, in every book. Once deleted, LoreBase
 * turns off, since its selected entries would send nothing; turning it on again asks to write them.
 */
async function deleteAll(settings, button) {
    const isConfirmed = await confirmPopup([
        { text: 'Delete every LoreBase key and vector you have, in every lorebook?' },
        { text: 'Use LoreBase turns off, and selections are kept; turning it on asks to write them again.' },
        { text: 'Keys you edited by hand are lost.' },
    ], { okButton: 'Delete all', isDestructive: true });
    if (!isConfirmed) return;
    button.disabled = true;
    try {
        const deleted = await deleteStored(BOTH_KINDS, settings);
        if (isLoreBaseSwitchedOn()) turnLoreBaseOff();
        showBooksStatus(`Deleted the keys of ${counted(deleted, 'entry', 'entries')} and every vector: no entry has either now, `
            + 'and Use LoreBase is off. Turn it on to write them again.');
    } catch (error) {
        log.warn('LoreBase: Delete all failed:', error);
        showBooksStatus(`Not deleted: ${error?.message || error}`);
    } finally {
        button.disabled = false;
    }
}

/**
 * Wire LoreBase's switch, open the selection screen from the card's buttons, and run the Generate buttons and Delete
 * all. Called once, as the panel is mounted.
 * @param {object} settings - VectFox settings
 */
export function bindLoreBaseBooksCard(settings) {
    cardSettings = settings;
    for (const button of GENERATE_BUTTONS) {
        document.getElementById(button.id)?.addEventListener('click', () => void generate(settings, button));
    }
    document.getElementById(DELETE_ALL_ID)?.addEventListener('click', event => void deleteAll(settings, event.currentTarget));
    document.getElementById(SWITCH_ID)?.addEventListener('change', async event => {
        if (event.currentTarget.checked) await switchLoreBaseOn();
        else turnLoreBaseOff();
        // Turning on can end off, when the user keeps Vector Storage's World Info search.
        paintLoreBaseSwitch();
    });
    // A reply's question can turn LoreBase off while the page is shown.
    onLoreBaseSwitchChange(paintLoreBaseSwitch);
    // Every writing run on the progress panel, a Generate button's or another's, shows on the status line.
    onWritingRunChange(showWritingRun);
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('click', async event => {
        const opener = event.target.closest('[data-lorebase-choose]');
        if (!opener) return;
        let chosen = null;
        try {
            chosen = await openLoreBaseSelection({ bookName: opener.dataset.lorebaseChoose });
        } catch (error) {
            log.error('LoreBase: the selection screen failed:', error);
        }
        void refreshLoreBaseBooks();
        showChosenSelection(chosen);
    });
}

/**
 * How many selected entries lack each kind, in a line: those without keys and those without vectors, an entry lacking
 * both counted in each.
 * @param {{missingKeyCount: number, missingVectorCount: number}} chosen - From openLoreBaseSelection
 * @returns {string}
 */
function missingText({ missingKeyCount, missingVectorCount }) {
    const haveNo = count => counted(count, 'selected entry has', 'selected entries have');
    if (missingKeyCount && missingVectorCount) {
        return `${haveNo(missingKeyCount)} no keys, and ${counted(missingVectorCount, 'entry has', 'entries have')} no vectors yet.`;
    }
    return missingKeyCount ? `${haveNo(missingKeyCount)} no keys yet.` : `${haveNo(missingVectorCount)} no vectors yet.`;
}

/**
 * What the selection lacks once the selection screen closed, LoreBase on or off: nothing, or how many entries have no
 * keys and how many no vectors yet, which wait while LoreBase is on and are written by turning it on while it is off;
 * with nothing selected, the line goes, or calls to choose entries while LoreBase is on; with the keys and vectors
 * unread, the line goes. A run started on the screen's question writes its own lines (showWritingRun).
 * @param {{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number,
 *   isWriting: boolean}|null} chosen - From openLoreBaseSelection
 */
function showChosenSelection(chosen) {
    if (chosen?.isWriting) return;
    if (!chosen?.decidedCount) {
        showBooksStatus(chosen && isLoreBaseSwitchedOn() && !selectedLoreBookNames().length ? NOTHING_SELECTED_TEXT : '');
    } else if (chosen.missingCount) {
        const missing = missingText(chosen);
        showBooksStatus(isLoreBaseSwitchedOn()
            ? `${missing} LoreBase leaves them out until Generate all writes them.`
            : `${missing} Turn on Use LoreBase to write them.`);
    } else {
        showBooksStatus(chosen.decidedCount === 1
            ? 'The selected entry has its keys and vectors.'
            : `All ${counted(chosen.decidedCount, 'selected entry', 'selected entries')} have keys and vectors.`);
    }
}
