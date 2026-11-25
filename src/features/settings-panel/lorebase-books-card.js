/**
 * The WorldInfo page's LoreBase controls (plan §5.2 and §5.9 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md, §4.3 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md, §3.4 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md). LoreBase's switch: turning it on asks first
 * about the keys and vectors the selected entries lack and Vector Storage's World Info search, then whatever the answer
 * says what the selection lacks, and with nothing selected to choose entries. While it is off, the user still chooses entries and sets its model, and a notice
 * says to do that before turning it on; only the Generate buttons wait, since turning LoreBase on asks to write them.
 * The books card: it draws the open chat's books with their selected counts and locks, then how many of each book's
 * selected entries have keys and vectors, and each book's state (§7.1 of lorebook-multi-vector.md): ready, what its
 * entries need, how many failed, vectors another embedding model made, or the writing run's place in it as the run
 * goes; under them, the ready and waiting entries of the books locked here. It opens LoreBase's selection screen on the book a row names, or on the
 * chat's first book from the card's own button, drawing the list again once the screen closes and saying what the
 * selection lacks of each kind, LoreBase on or off, and while it is on which Generate button writes it. Add a lorebook
 * (§6 of lorebook-multi-vector.md) adds the book chosen in its list to this chat or to this character, locked there,
 * and opens the selection screen on it, the status line saying where it went or why it was not added. Generate keys
 * and Generate vectors write what the selected entries of every book lack of their kind, and Generate all both; Delete
 * all, once confirmed, deletes every key and vector the user has and turns LoreBase off (D17); a book row's trash, on
 * one of 2 or more selections in use here, runs LoreBase's one selection delete on it alone
 * (deleteLoreSelectionAfterConfirm), and else Remove from LoreBase, LoreBase's one confirm and removal of the book
 * (removeLoreBookAfterConfirm), its record, keys and vectors, leaving the book in the chat; Unlink, on the row of a book
 * the chat loads through its added books, its Chat Lorebook, the character's Additional Lorebooks or the global list,
 * confirms and removes it the same, then takes it out of those lists. Selection in use here, leading a book's row, puts the
 * selection chosen in use in this chat, or makes a new one and opens the selection screen on it (§1.2 and §3.7 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md). Each goes through LoreBase's storage module. The card's status line says how each went, and shows every writing run on the progress panel,
 * whichever started it: the entries being written, then what was written and the books the run locked to its chat
 * (§6.1 of lorebook-multi-vector.md), a line that goes once another chat is open.
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import {
    BOTH_KINDS, KEYS, VECTORS, addLoreBookToChat, booksToAdd, chatBookLocks, deleteLoreSelectionAfterConfirm, deleteStored,
    describeRemovedLoreBook, isLoreBaseSwitchedOn, kindsLacking, newLoreSelectionHere, onLoreBaseSwitchChange, onLoreBookChatLocksMoved,
    onWritingProgress, onWritingRunChange,
    openLoreBaseSelection, removableLoreBookNames, removeLoreBookAfterConfirm, selectedLoreBookNames, storedCountsOfBooks, turnLoreBaseOff, turnLoreBaseOn,
    useLoreSelectionHere, writeMissing, writingProblem,
} from '../lorebase/index.js';
import { IN_USE_NEW } from './in-use-switcher-markup.js';
import { loreBaseBookRow, loreBaseBooksMarkup } from './worldinfo-page-markup.js';

const SWITCH_ID = 'VectFox_lorebase_enabled';
// Each Generate button, the kinds it writes, and its name, which the console and the status line give it.
const GENERATE_BUTTONS = [
    { id: 'VectFox_lorebase_generate_keys', kinds: [KEYS], name: 'Generate keys' },
    { id: 'VectFox_lorebase_generate_vectors', kinds: [VECTORS], name: 'Generate vectors' },
    { id: 'VectFox_lorebase_generate_all', kinds: BOTH_KINDS, name: 'Generate all' },
];
const DELETE_ALL_ID = 'VectFox_lorebase_delete_all';
const BOOKS_STATUS_ID = 'VectFox_lorebase_books_status';
// Add a lorebook's list of the books the chat does not load, drawn with the books (loreBaseBooksMarkup).
const ADD_BOOK_SELECT_ID = 'VectFox_lorebase_add_book';
const NOTHING_SELECTED_TEXT = 'LoreBase is on, with nothing selected yet. Choose entries: when you close the selection screen, LoreBase asks to write the keys and vectors of the entries you turned on.';
let isGenerating = false;
// Counts the card's refreshes, so a refresh whose books loaded after a newer one began draws nothing.
let refreshCount = 0;
// The chat the status line says books were locked to as "this chat", so the line goes once another chat is open.
let statusLockChatId = null;
// The settings the card was bound with, which counting the books' keys and vectors reads.
let cardSettings = null;
// The list last drawn, with its chat, so a writing run's place redraws it and a refresh of the same chat keeps its
// counts until new ones are read.
let shownStatus = null;
let shownChatId = null;
// Where the writing run on the progress panel is: the book it writes now, the kind, and its entries done of those to do.
let writingProgress = null;

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

// The writing run's place in a book, while it writes that book.
const writingOf = bookName => (writingProgress?.bookName === bookName
    ? { isKeys: writingProgress.kind === KEYS, done: writingProgress.done, total: writingProgress.total }
    : null);

/**
 * Draw the list, the writing run's place shown on the row of the book it writes now (§7.1 of lorebook-multi-vector.md).
 * @param {object} status - What loreBaseBooksMarkup takes, without the run's place
 */
function drawBooks(status) {
    shownStatus = status;
    shownChatId = getCurrentChatId() ?? null;
    const list = document.getElementById('VectFox_lorebase_books');
    if (list) list.innerHTML = loreBaseBooksMarkup({ ...status, books: status.books.map(book => ({ ...book, writing: writingOf(book.bookName) })) });
}

/**
 * Draw one book's row again with the writing run's place, leaving the rest of the list, Add a lorebook's choice among
 * it, as it is. A book the list does not show is left alone.
 * @param {string} bookName
 */
function drawBookRow(bookName) {
    const book = shownStatus?.books.find(candidate => candidate.bookName === bookName);
    const opener = [...document.querySelectorAll('#VectFox_lorebase_books [data-lorebase-choose]')].find(element => element.dataset.lorebaseChoose === bookName);
    const row = opener?.closest('.vfx-row');
    if (book && row) row.outerHTML = loreBaseBookRow({ ...book, writing: writingOf(bookName) });
}

/**
 * The books of a list about to be drawn, each with the counts the list last drawn for the same chat held for it, while
 * the selection it shows and that selection's count are the same, so its state stays shown until the new counts are read.
 * @param {Array<{bookName: string, selectedCount: number, selectionInUseId: string|null}>} books
 */
function withLastCounts(books) {
    if (!shownStatus || shownChatId !== (getCurrentChatId() ?? null)) return books;
    return books.map(book => {
        const shown = shownStatus.books.find(candidate => candidate.bookName === book.bookName && candidate.selectedCount === book.selectedCount
            && candidate.selectionInUseId === book.selectionInUseId);
        return shown ? { ...shown, ...book } : book;
    });
}

/**
 * Draw the open chat's LoreBase books, once the panel is mounted, under the switch as saved: each row counts the
 * selected entries LoreBase decides, as the keys line does, once the books are loaded, then how many of them have keys
 * and vectors and the book's state, and whether LoreBase holds anything of it to remove (removableLoreBookNames, the
 * Database Browser's rule), once those are read, a row of the same chat keeping what it showed until then; under them,
 * Add a lorebook with the books the chat does not load. Only the newest refresh draws, so a slow load never draws a
 * chat left since. A status line that says "this chat" goes once another chat is open.
 * @returns {Promise<void>}
 */
export async function refreshLoreBaseBooks() {
    const refresh = ++refreshCount;
    if (statusLockChatId !== null && statusLockChatId !== (getCurrentChatId() ?? null)) showBooksStatus('');
    paintLoreBaseSwitch();
    let status;
    try {
        status = { ...await chatBookLocks(), add: booksToAdd() };
        if (refresh !== refreshCount) return;
        drawBooks({ ...status, books: withLastCounts(status.books) });
    } catch (error) {
        log.warn("LoreBase: the WorldInfo page's book list could not be drawn:", error);
        return;
    }
    if (!status.books.length || !cardSettings) return;
    const selectedBooks = status.books.filter(book => book.selectedCount)
        .map(({ bookName, selectionInUseId }) => ({ bookName, selectionId: selectionInUseId }));
    const [counts, removable] = await Promise.all([
        selectedBooks.length ? storedCountsOfBooks(selectedBooks, cardSettings).catch(error => {
            log.warn("LoreBase: the keys and vectors of the WorldInfo page's books could not be counted:", error);
            return new Map();
        }) : new Map(),
        removableLoreBookNames(status.books.map(book => book.bookName), cardSettings).catch(error => {
            log.warn("LoreBase: what LoreBase holds of the WorldInfo page's books could not be listed, so no row offers Remove from LoreBase:", error);
            return new Set();
        }),
    ]);
    if (refresh !== refreshCount) return;
    // Drawn again whatever was read, so counts kept from the last list never stay in place of ones that could not be read.
    drawBooks({ ...status, books: status.books.map(book => ({ ...book, ...counts.get(book.bookName), canRemove: removable.has(book.bookName) })) });
}

/**
 * Show a line on the status line, or hide it when empty.
 * @param {string} text
 * @param {{lockChatId?: string|null}} [options] - lockChatId: the chat a line saying where books or selections were
 *   locked or put in use was written in, as "this chat" or "this character", so the line goes once another chat is open
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
 * that wrote or locked anything draws the list again, so its rows show their counts, states and locks. A run with
 * nothing missing of its kinds says so.
 * @param {object} outcome - The run's outcome (WritingRunOutcome in lorebase-storage.js)
 * @param {readonly string[]} [kinds] - What the run wrote
 */
function showRunOutcome(outcome, kinds = BOTH_KINDS) {
    const isLockChatOpen = Boolean(outcome.chatLock) && outcome.chatLock.chatId === (getCurrentChatId() ?? null);
    const hasDoneAnything = outcome.keysWritten || outcome.vectorsWritten || outcome.failed || outcome.stopped;
    const text = hasDoneAnything || outcome.unreadBooks ? writtenText(outcome, isLockChatOpen) : `No selected entry was missing ${kindsText(kinds)}.`;
    showBooksStatus(text, { lockChatId: isLockChatOpen ? outcome.chatLock.chatId : null });
    if (hasDoneAnything || outcome.chatLock) void refreshLoreBaseBooks();
}

/**
 * A writing run on the progress panel, whichever started it (a Generate button, turning LoreBase on, closing the
 * selection screen, Regenerate keys): what it writes, then what it did.
 */
function showWritingRun({ count, outcome }) {
    if (outcome) showRunOutcome(outcome);
    else showBooksStatus(`Writing what ${counted(count, 'selected entry lacks', 'selected entries lack')}; the progress panel counts ${count === 1 ? 'it' : 'them'}.`);
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

/**
 * Turn LoreBase on from its switch; whatever the answer, the status line then says what the selection lacks, as once
 * the selection screen closes (showWhatSelectionLacks), with nothing selected anywhere that LoreBase is on and entries
 * are chosen next.
 */
async function switchLoreBaseOn() {
    const { missing } = await turnLoreBaseOn();
    showWhatSelectionLacks(missing);
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
 * Remove from LoreBase or Unlink on a book's row (removeLoreBookAfterConfirm): Remove deletes what LoreBase holds of the
 * book and leaves it in the chat; Unlink deletes that too, then takes the book out of the open chat's lists Add a
 * lorebook links books through, and the global list. Once confirmed and done, the status line says what went, and what
 * still loads the book in this chat, and the list is drawn again. Cancel says nothing; a refusal says why. The button
 * waits while it runs.
 * @param {HTMLButtonElement} button - The row's Remove from LoreBase or Unlink, naming its book
 * @returns {Promise<void>}
 */
async function removeBook(button) {
    const shouldUnlink = button.dataset.lorebaseUnlink !== undefined;
    const bookName = shouldUnlink ? button.dataset.lorebaseUnlink : button.dataset.lorebaseRemove;
    button.disabled = true;
    try {
        const removed = await removeLoreBookAfterConfirm(bookName, cardSettings, { shouldUnlink });
        if (!removed) return;
        showBooksStatus(describeRemovedLoreBook(removed));
        void refreshLoreBaseBooks();
    } catch (error) {
        log.warn(`LoreBase: lorebook "${bookName}" could not be ${shouldUnlink ? 'unlinked' : 'removed'}:`, error);
        showBooksStatus(`${shouldUnlink ? 'Not unlinked' : 'Not removed'}: ${error?.message || error}`);
    } finally {
        button.disabled = false;
    }
}

/**
 * The trash on a book's row while its dropdown shows one of its 2 or more selections in use here: LoreBase's one
 * selection delete on that one alone (deleteLoreSelectionAfterConfirm), the book and its other selections staying.
 * Once confirmed and done, the status line says what went and the list is drawn again; Cancel says nothing; a refusal
 * says why. The button waits while it runs.
 * @param {HTMLButtonElement} button - The row's trash, naming its book and the selection
 * @returns {Promise<void>}
 */
async function deleteRowSelection(button) {
    const bookName = button.dataset.lorebaseDeleteSelection;
    button.disabled = true;
    try {
        const deleted = await deleteLoreSelectionAfterConfirm(bookName, button.dataset.lorebaseSelection, cardSettings);
        if (!deleted) return;
        showBooksStatus(`Deleted the selection "${deleted.selectionName}" of "${bookName}". Its other selections stay.`);
        void refreshLoreBaseBooks();
    } catch (error) {
        log.warn(`LoreBase: a selection of lorebook "${bookName}" could not be deleted:`, error);
        showBooksStatus(`Not deleted: ${error?.message || error}`);
    } finally {
        button.disabled = false;
    }
}

/**
 * Selection in use here, on a book's row (§1.2 of vectfox-multi-collection-per-chat.md): a selection chosen is put in
 * use in this chat; New selection copies the one in use, or on a book with none makes its first, puts it in use here
 * and opens the selection screen on it (newLoreSelectionHere). The status line says what changed, a line that goes once
 * another chat is open, or why nothing did, and the list is drawn again.
 * @param {HTMLSelectElement} switcher - The row's switcher, naming its book
 * @returns {Promise<void>}
 */
async function switchSelection(switcher) {
    const bookName = switcher.dataset.lorebaseInUse;
    const choice = switcher.value;
    if (!choice) return;
    const lockChatId = getCurrentChatId() ?? null;
    try {
        if (choice === IN_USE_NEW) {
            const selection = newLoreSelectionHere(bookName);
            showBooksStatus(`Made "${selection.name}" and put it in use in this chat.`, { lockChatId });
            void refreshLoreBaseBooks();
            await chooseEntries(bookName, selection.id);
            return;
        }
        useLoreSelectionHere(bookName, choice);
        showBooksStatus(`"${switcher.selectedOptions[0].textContent}" is in use in this chat now.`, { lockChatId });
    } catch (error) {
        log.warn(`LoreBase: the selection in use of lorebook "${bookName}" was not changed:`, error);
        showBooksStatus(`Not changed: ${error?.message || error}`);
    }
    void refreshLoreBaseBooks();
}

/**
 * Wire LoreBase's switch, open the selection screen from the card's buttons, and run the Generate buttons, Delete all,
 * each book's Selection in use here, its Unlink and its trash. Called once, as the panel is mounted.
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
    // A chat's rename moves its locks after SillyTavern opened the renamed chat, which drew the list with the old ones.
    onLoreBookChatLocksMoved(() => void refreshLoreBaseBooks());
    // Every writing run on the progress panel, a Generate button's or another's, shows on the status line, and its place
    // on the row of the book it writes now.
    onWritingRunChange(showWritingRun);
    onWritingProgress(progress => {
        const bookNames = new Set([writingProgress?.bookName, progress?.bookName].filter(Boolean));
        writingProgress = progress;
        for (const bookName of bookNames) drawBookRow(bookName);
    });
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('click', event => {
        const opener = event.target.closest('[data-lorebase-choose]');
        if (opener) void chooseEntries(opener.dataset.lorebaseChoose);
        const adder = event.target.closest('[data-lorebase-add]');
        if (adder) void addBook(adder);
        const remover = event.target.closest('[data-lorebase-remove], [data-lorebase-unlink]');
        if (remover) void removeBook(remover);
        const selectionDeleter = event.target.closest('[data-lorebase-delete-selection]');
        if (selectionDeleter) void deleteRowSelection(selectionDeleter);
    });
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('change', event => {
        const switcher = event.target.closest('[data-lorebase-in-use]');
        if (switcher) void switchSelection(switcher);
    });
}

/**
 * Open the selection screen on a book, or on the chat's first with none named, and on a selection of it, or the one in
 * use here with none named; once it closes, draw the list again, a screen that failed included, and say what the
 * selection lacks (showWhatSelectionLacks).
 * @param {string} bookName
 * @param {string|null} [selectionId]
 * @returns {Promise<void>}
 */
async function chooseEntries(bookName, selectionId = null) {
    let chosen = null;
    try {
        chosen = await openLoreBaseSelection({ bookName, selectionId });
    } catch (error) {
        log.error('LoreBase: the selection screen failed:', error);
    }
    void refreshLoreBaseBooks();
    showWhatSelectionLacks(chosen);
}

/**
 * Add a lorebook (§6 of lorebook-multi-vector.md, L1 of InternalProject/Vectfox/plans/entity-lore.md): the book chosen
 * in the card's list, to this chat on LoreBase's own list of its books or to this character as the button pressed
 * says, locked there; then draw the list again, so its row shows, and open the selection screen on it. The status line says where it went, a line that stays when the screen closes
 * with nothing to say of the selection, or that no book was chosen, or why it was not added. The Add buttons wait while
 * it is added.
 * @param {HTMLElement} button - The Add button pressed, carrying the place addLoreBookToChat takes
 * @returns {Promise<void>}
 */
async function addBook(button) {
    const bookName = document.getElementById(ADD_BOOK_SELECT_ID)?.value ?? '';
    if (!bookName) {
        showBooksStatus('Choose a lorebook to add first.');
        return;
    }
    const chatId = getCurrentChatId() ?? null;
    const addButtons = [...document.querySelectorAll('[data-lorebase-add]')];
    for (const addButton of addButtons) addButton.disabled = true;
    let lock;
    try {
        lock = await addLoreBookToChat(bookName, button.dataset.lorebaseAdd);
    } catch (error) {
        log.warn(`LoreBase: lorebook "${bookName}" was not added:`, error);
        showBooksStatus(`Not added: ${error?.message || error}`);
        return;
    } finally {
        for (const addButton of addButtons) addButton.disabled = false;
    }
    const addedText = lock.characterAvatar
        ? `Added "${bookName}" to this character, and locked it to the character.`
        : `Added "${bookName}" to this chat, and locked it to this chat. It loads while LoreBase is on.`;
    showBooksStatus(addedText, { lockChatId: chatId });
    void refreshLoreBaseBooks();
    await chooseEntries(bookName);
    if (document.getElementById(BOOKS_STATUS_ID)?.hidden) showBooksStatus(addedText, { lockChatId: chatId });
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
 * The Generate button that writes what the selection lacks: Generate keys or Generate vectors when it lacks one kind,
 * Generate all when it lacks both.
 * @param {{missingKeyCount: number, missingVectorCount: number}} chosen - From openLoreBaseSelection, lacking either
 * @returns {string} The button's name
 */
function generateButtonNameFor(chosen) {
    const lacked = kindsLacking(chosen);
    return GENERATE_BUTTONS.find(button => button.kinds.join() === lacked.join()).name;
}

/**
 * What the selection lacks once the selection screen closed or LoreBase's switch was turned on, LoreBase on or off:
 * nothing, or how many entries have no keys and how many no vectors yet, which LoreBase leaves out while it is on,
 * until the Generate button for what they lack writes it (generateButtonNameFor), and which turning it on writes while
 * it is off; with nothing selected, the line goes, or calls to choose entries while LoreBase is on; with the keys and
 * vectors unread, the line goes. A run started on the question writes its own lines (showWritingRun).
 * @param {{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number,
 *   isWriting: boolean}|null} chosen - From openLoreBaseSelection or turnLoreBaseOn (missingSummaryOf)
 */
function showWhatSelectionLacks(chosen) {
    if (chosen?.isWriting) return;
    if (!chosen?.decidedCount) {
        showBooksStatus(chosen && isLoreBaseSwitchedOn() && !selectedLoreBookNames().length ? NOTHING_SELECTED_TEXT : '');
    } else if (chosen.missingCount) {
        const missing = missingText(chosen);
        const leftOut = chosen.missingCount === 1 ? 'it' : 'them';
        showBooksStatus(isLoreBaseSwitchedOn()
            ? `${missing} LoreBase leaves ${leftOut} out until ${generateButtonNameFor(chosen)} writes them.`
            : `${missing} Turn on Use LoreBase to write them.`);
    } else {
        showBooksStatus(chosen.decidedCount === 1
            ? 'The selected entry has its keys and vectors.'
            : `All ${counted(chosen.decidedCount, 'selected entry', 'selected entries')} have keys and vectors.`);
    }
}
