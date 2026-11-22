/**
 * LoreBase's selection screen (plan §5.2 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md):
 * a dialog of its own where the user chooses a lorebook's entries for LoreBase to decide, reads any entry whole in a
 * dialog over it, locks the selection it shows to the open chat or its character (D11), and pins section names (D10). It
 * edits one of the book's selections (§3.7 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): the
 * one named, else the one in use here, else the book's first, made when it has none. Its list changes which one it edits, not which is
 * in use; New selection copies the one shown and puts the copy in use here, Rename renames it, and Delete, once
 * confirmed, deletes it with the vectors no other selection holds, the WorldInfo row's trash's one delete
 * (deleteLoreSelectionAfterConfirm), a book's last selection staying. Its lock switches and pins are the shown selection's. Every
 * control saves as it changes, as GUI-DNA asks. Turning entries on only selects them: once the screen closes while LoreBase is
 * on, it asks to write the keys and vectors the selected entries lack (D17, §4.3 of InternalProject/Vectfox/plans/
 * executed/lorebook-multi-vector.md), under the progress panel, and turns LoreBase off when they are not written and no entry is
 * ready, by the question turning LoreBase on asks (lorebase-keys-question.js). The books that writing keys lock to the
 * open chat, but for those whose lock the user set while the screen was open, which stay as the user set them (§6.1).
 * While LoreBase is off, turning it on asks. Closing counts what the selection lacks either way, for the books card's
 * line, and in each book whose selections changed deletes the vectors of the entries no selection holds now. Each selected row shows
 * where its keys and vectors stand, redrawn as they are written or fail, and a filter shows the ready entries or those
 * without keys or vectors (§7.3 of lorebook-multi-vector.md). The footer says, on High Accuracy, what the pick reads
 * from the book, and on Fast and Cheap [Jev], how many of the selected entries taking part in the open chat Jev is asked
 * about on every reply. Regenerate keys writes the ticked entries' keys anew under the progress panel, brought in front
 * of the screen with its Stop; a selected row's pencil edits its keys in a dialog, where Regenerate fills the box from
 * the model for the user to read before saving.
 * Opening a book keeps the uids it holds, so an entry added later shows as new, drops the uids of deleted entries from
 * each of its selections, and reads its vectors from Qdrant again, so edits made while SillyTavern was closed are found.
 */
import { log } from '../../sillytavern/log.js';
import { formPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { loadWorldInfo, world_names } from '../../sillytavern/world-info.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import {
    decidedCountOf, ensureLoreSelection, getLoreBook, getLoreSelection, loreBookRecordCounts, loreSelectionsOf, renameLoreSelection,
    setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection, setLoreSelectionLock,
} from './lorebase-books.js';
import { chatBookLocks, chatBookNames, lockTarget, newLoreSelectionHere, selectionInUseHere, whereFor } from './lorebase-chat-books.js';
import { deleteLoreSelectionAfterConfirm } from './lorebase-removal.js';
import { editedKeys } from './lorebase-keys-core.js';
import { keyStateOf, onKeyStateChange, readBookKeys, regenerateKeys, saveEditedKeys } from './lorebase-keys.js';
import { keyWritingProblem } from './lorebase-setup.js';
import { askToWriteMissingKeysAndVectors, writeMissingKeysAndVectors } from './lorebase-keys-question.js';
import { FAST_AND_CHEAP, decidedEntries, loreBaseAccuracyOf } from './lorebase-reply-core.js';
import { isEntryReady } from './lorebase-readiness.js';
import { regenerateKeysOfEntries, selectedEntriesNotReady, storedCountsOfBooks } from './lorebase-storage.js';
import { missingSummaryOf } from './lorebase-storage-core.js';
import { entryTitle } from './lorebase-splitter.js';
import { isSelectionLockedTo, unionOfSelections } from './lorebase-selections-core.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn, turnLoreBaseOff } from './lorebase-switch.js';
import { onVectorStateChange, pruneBookVectors, readBookVectors, vectorStateOf } from './lorebase-vectors.js';
import {
    bookChoices, canToggleRow, categoryList, entryReadiness, entrySectionNames, filterRows, invertTicks, isDecidedRow, liveSelection,
    pinnableSections, selectionAfterBulk, selectionAfterCategory, selectionFooter, selectionRows, seenUidsOf, tickAllMatching, tickRange,
    BADGES,
} from './lorebase-selection-core.js';
import {
    NEWNESS_CHOICES, SELECTION_IDS as ids, bookFailedMarkup, bookOptions, categoryRowsMarkup, entriesFooterMarkup,
    entryDetailLines, entryRowMarkup, entryTextMarkup, keysEditorLines, keysEditorMarkup, lockNoticeMarkup, noLorebookMarkup,
    noMatchingEntriesMarkup, noTitleNoticeMarkup, pinsMarkup, readinessSummaryText, renameSelectionFormMarkup, selectionOptions,
    selectionScreenMarkup, summaryText,
} from './lorebase-selection-markup.js';

const PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 200;

const byId = (root, id) => root.querySelector(`#${id}`);
const entryElementOf = (root, uid) => [...root.querySelectorAll('[data-lorebase-entry]')].find(element => element.dataset.lorebaseEntry === uid);
const selectedUidsOf = session => session.rows.filter(row => row.isSelected).map(row => row.uid);
// The selection the screen shows, of the book shown.
const shownSelectionOf = session => getLoreSelection(session.bookName, session.selectionId);
// The selection a book opens on with none named: the one in use here, else the book's first, made when it has none.
const selectionShownFor = bookName => selectionInUseHere(bookName) ?? ensureLoreSelection(bookName);

/**
 * A selected row's keys and vectors as this session knows them (entryReadiness); a row LoreBase does not decide shows
 * neither.
 */
function readinessFor(session, row) {
    const entry = session.entryByUid.get(row.uid);
    if (!isDecidedRow(row) || !entry) return null;
    const settings = extension_settings.vectfox;
    return entryReadiness(keyStateOf(session.bookName, row.uid), vectorStateOf(session.bookName, entry, settings), isEntryReady(session.bookName, entry, settings));
}
const readinessText = readiness => (readiness ? JSON.stringify(readiness) : '');

/** A row's markup, noting the state it shows so a later change to it redraws the row. */
function rowMarkup(session, row) {
    const readiness = readinessFor(session, row);
    session.shownReadiness.set(row.uid, readinessText(readiness));
    return entryRowMarkup(row, { isTicked: session.ticked.has(row.uid), readiness });
}

/** The entries of the book shown with these uids, as loadWorldInfo returned them. */
function bookEntriesOf(session, uids) {
    return Object.values(session.book?.entries ?? {}).filter(entry => uids.has(String(entry.uid)));
}

/**
 * Whether keys cannot be written now (D15, D17); when they cannot, a notice says why, under `heading`, and the caller
 * does nothing.
 * @param {string} heading
 * @returns {boolean}
 */
function isKeyWritingBlocked(heading) {
    const problem = keyWritingProblem(extension_settings.vectfox);
    if (problem) void noticePopup([{ icon: 'fa-key', text: heading }, { text: problem }]);
    return Boolean(problem);
}

/**
 * How many entries LoreBase decides in each book with a record (decidedCountOf), for the book list, read as the screen
 * opens.
 * @returns {Promise<Map<string, number>>}
 */
async function decidedCountsOfRecordedBooks() {
    const bookNames = Object.keys(loreBookRecordCounts());
    return new Map(await Promise.all(bookNames.map(async bookName => [bookName, await decidedCountOf(bookName)])));
}

/**
 * The book list's choices, each book with how many entries LoreBase decides in it: the book shown counted from its
 * selections as they stand now, the others as the screen read them.
 * @param {{decidedCounts: Map<string, number>, book: object|null, bookName?: string}} session
 */
function currentChoices(session) {
    if (session.book) session.decidedCounts.set(session.bookName, decidedEntries(session.book, unionOfSelections(getLoreBook(session.bookName))).length);
    return bookChoices([...world_names], chatBookNames(), Object.fromEntries(session.decidedCounts));
}

/** The rows the filters in the controls card and the category shown let through, drawn on the screen yet or not. */
function matchingRows(root, session) {
    return filterRows(session.rows, {
        text: byId(root, ids.search).value,
        category: session.shownCategory,
        minimumTokens: Number(byId(root, ids.size).value) || 0,
        readiness: byId(root, ids.readiness).value,
        readinessOf: row => readinessFor(session, row),
        badge: byId(root, ids.badge).value,
        isNewOnly: byId(root, ids.newness).value === NEWNESS_CHOICES.newOnly,
    });
}

function renderCounts(root, session) {
    const tickedCount = session.ticked.size;
    root.querySelector('[data-lorebase-ticked-count]').textContent = `${tickedCount} ticked`;
    for (const name of ['turn-on', 'turn-off', 'regenerate-keys']) root.querySelector(`[data-lorebase-action="${name}"]`).disabled = tickedCount === 0;
    root.querySelector('[data-lorebase-selected-count]').textContent = `${selectedUidsOf(session).length} selected`;
}

function renderEntries(root, session) {
    const matching = matchingRows(root, session);
    const shown = matching.slice(0, session.shownLimit);
    byId(root, ids.entries).innerHTML = shown.length
        ? shown.map(row => rowMarkup(session, row)).join('')
        : noMatchingEntriesMarkup();
    byId(root, ids.entriesNotice).innerHTML = shown.some(row => row.badges.includes(BADGES.noTitle)) ? noTitleNoticeMarkup() : '';
    byId(root, ids.entriesFooter).innerHTML = entriesFooterMarkup({ shownCount: shown.length, matchCount: matching.length, hasMore: matching.length > shown.length });
    renderCounts(root, session);
}

function renderCategories(root, session) {
    byId(root, ids.categories).innerHTML = categoryRowsMarkup(categoryList(session.rows), { shownCategory: session.shownCategory, entryCount: session.rows.length });
}

// Where a selected entry that is not ready counts in the summary, by the state its row shows; a ready one counts as
// ready whatever its row shows, and one whose vectors this session has not read counts nowhere.
const SUMMARY_COUNT_OF = Object.freeze({
    'writing-keys': 'writing', vectorizing: 'writing', 'keys-failed': 'failed', 'vectors-failed': 'failed', missing: 'missing',
});

/**
 * The ready entries in the books taking part in the open chat, the selection shown's among them while the chat loads its
 * book and it is the one in use here, and whether it takes part; null while the other books' are not counted.
 * @param {object} session
 * @param {number} entryCount - This book's ready entries, from selectionFooter
 * @returns {{count: number, isSelectionTakingPart: boolean}|null}
 */
function takingPartOf(session, entryCount) {
    if (session.otherTakingPartCount === null) return null;
    const isInUseHere = selectionInUseHere(session.bookName)?.id === session.selectionId;
    const isSelectionTakingPart = isInUseHere && chatBookNames().includes(session.bookName);
    return { count: session.otherTakingPartCount + (isSelectionTakingPart ? entryCount : 0), isSelectionTakingPart };
}

/**
 * Count the ready entries of the open chat's other books with a selection in use here, as the WorldInfo page counts
 * them (chatBookLocks, then storedCountsOfBooks), for the footer on Fast and Cheap [Jev]; with no chat open, or when they
 * cannot be counted, they stay unknown.
 * @param {object} session
 * @param {string} bookName - The book shown
 * @returns {Promise<void>}
 */
async function countOtherBooksTakingPart(session, bookName) {
    try {
        const { hasChat, books } = await chatBookLocks();
        const inUse = books.filter(book => book.bookName !== bookName && book.selectionInUseId !== null)
            .map(book => ({ bookName: book.bookName, selectionId: book.selectionInUseId }));
        const counts = hasChat ? await storedCountsOfBooks(inUse, extension_settings.vectfox) : null;
        if (session.bookName !== bookName) return;
        session.otherTakingPartCount = counts ? [...counts.values()].reduce((sum, count) => sum + count.readyCount, 0) : null;
    } catch (error) {
        log.warn("LoreBase: the selection screen could not count the ready entries of the chat's other books:", error);
    }
}

/**
 * The footer's summary: on High Accuracy what the pick reads from the book, on Fast and Cheap [Jev] how many ready
 * entries Jev is asked about on every reply; then where the selected entries' keys and vectors stand.
 */
function renderSummaryText(root, session) {
    const counts = { ready: 0, writing: 0, failed: 0, missing: 0 };
    for (const row of session.rows) {
        const readiness = readinessFor(session, row);
        const count = readiness?.isReady ? 'ready' : SUMMARY_COUNT_OF[readiness?.status];
        if (count) counts[count] += 1;
    }
    const readinessLine = session.keyReadProblem
        ? `The keys could not be read: ${session.keyReadProblem}`
        : readinessSummaryText(counts, { isLoreBaseOn: isLoreBaseSwitchedOn() });
    const keysOf = uid => {
        const state = keyStateOf(session.bookName, uid);
        return state.status === 'ready' ? state.keys : [];
    };
    const footer = selectionFooter(session.book, shownSelectionOf(session), {
        keysOf, isReady: entry => isEntryReady(session.bookName, entry, extension_settings.vectfox),
    });
    const choice = {
        isFastAndCheap: loreBaseAccuracyOf(extension_settings.vectfox?.lorebase_accuracy) === FAST_AND_CHEAP,
        takingPart: takingPartOf(session, footer.entryCount),
    };
    byId(root, ids.summary).textContent = [summaryText(footer, choice), readinessLine].filter(Boolean).join(' ');
}

/** The book's selections in the list, the one shown chosen; Delete waits while the book has only one. */
function renderSelectionList(root, session) {
    const selections = loreSelectionsOf(session.bookName);
    const inUseId = selectionInUseHere(session.bookName)?.id ?? null;
    byId(root, ids.selectionList).innerHTML = selectionOptions(selections, { selectionId: session.selectionId, inUseId }).join('');
    root.querySelector('[data-lorebase-action="delete-selection"]').disabled = selections.length < 2;
}

function renderSelectionSummary(root, session) {
    byId(root, ids.pins).innerHTML = pinsMarkup(pinnableSections(session.book, shownSelectionOf(session), session.sectionNamesOf));
    renderSummaryText(root, session);
    byId(root, ids.book).innerHTML = bookOptions(currentChoices(session), session.bookName).join('');
    renderSelectionList(root, session);
}

/** Redraw the rows shown whose keys or vectors changed, keeping the keyboard where it was, and the summary. */
function renderReadiness(root, session) {
    const focused = document.activeElement;
    const focusedUid = focused?.closest?.('[data-lorebase-entry]')?.dataset.lorebaseEntry;
    const focusedAction = focused?.dataset?.lorebaseAction;
    for (const element of root.querySelectorAll('[data-lorebase-entry]')) {
        const row = session.rows.find(candidate => candidate.uid === element.dataset.lorebaseEntry);
        if (!row || session.shownReadiness.get(row.uid) === readinessText(readinessFor(session, row))) continue;
        element.outerHTML = rowMarkup(session, row);
        if (row.uid === focusedUid && focusedAction) entryElementOf(root, row.uid)?.querySelector(`[data-lorebase-action="${focusedAction}"]`)?.focus();
    }
    renderSummaryText(root, session);
}

/**
 * The lock switches of the selection shown, for where the book's selection is in use here (whereFor): the chat, and the
 * character the chat loads the book through, in a group chat the member whose lorebook it is, named in the notice.
 */
function renderLocks(root, session) {
    const target = whereFor(session.bookName);
    const chatSwitch = byId(root, ids.lockChat);
    const characterSwitch = byId(root, ids.lockCharacter);
    chatSwitch.disabled = !target.chatId;
    characterSwitch.disabled = !target.characterAvatar;
    const selection = shownSelectionOf(session);
    chatSwitch.checked = Boolean(target.chatId && selection) && isSelectionLockedTo(selection, { chatId: target.chatId });
    characterSwitch.checked = Boolean(target.characterAvatar && selection) && isSelectionLockedTo(selection, { characterAvatar: target.characterAvatar });
    const groupMemberName = target.characterAvatar && !lockTarget().characterAvatar ? target.characterName : '';
    byId(root, ids.lockNotice).innerHTML = lockNoticeMarkup({ hasChat: Boolean(target.chatId), hasCharacter: Boolean(target.characterAvatar), groupMemberName });
}

/** Save the selection shown, noting its book, so the vectors of the entries turned off go as the screen closes. */
function saveBookSelection(session, bookName, selectedUids) {
    setLoreBookSelection(bookName, session.selectionId, selectedUids);
    session.booksWithChangedSelection.add(bookName);
}

/** Save a new selection for the book shown, and redraw what it changes. */
function saveSelection(root, session, selectedUids) {
    saveBookSelection(session, session.bookName, selectedUids);
    const selected = new Set(selectedUids.map(String));
    for (const row of session.rows) row.isSelected = selected.has(row.uid);
    renderCategories(root, session);
    renderEntries(root, session);
    renderSelectionSummary(root, session);
}

/** Turn one entry on or off, redrawing only its row so the keyboard stays on its toggle. */
function toggleEntry(root, session, uid) {
    const row = session.rows.find(candidate => candidate.uid === uid);
    if (!row || !canToggleRow(row)) return;
    row.isSelected = !row.isSelected;
    saveBookSelection(session, session.bookName, selectedUidsOf(session));
    const element = entryElementOf(root, uid);
    if (element) {
        element.outerHTML = rowMarkup(session, row);
        entryElementOf(root, uid)?.querySelector('[data-lorebase-action="toggle-entry"]')?.focus();
    }
    renderCategories(root, session);
    renderCounts(root, session);
    renderSelectionSummary(root, session);
}

/**
 * Regenerate keys: write the keys of the ticked entries LoreBase decides (isDecidedRow) anew (D17), under the progress
 * panel, which shows in front of the screen with its Stop. While another run is on the panel, a notice says so.
 */
function regenerateTickedKeys(session) {
    const uids = new Set(session.rows.filter(row => isDecidedRow(row) && session.ticked.has(row.uid)).map(row => row.uid));
    if (!uids.size) {
        void noticePopup([{ icon: 'fa-key', text: 'None of the ticked entries is turned on and enabled in SillyTavern. LoreBase writes keys only for entries it decides.' }]);
        return;
    }
    if (isKeyWritingBlocked('LoreBase cannot write keys yet.')) return;
    regenerateKeysOfEntries(session.bookName, bookEntriesOf(session, uids), extension_settings.vectfox).catch(error => {
        log.warn('LoreBase: Regenerate keys did not run:', error);
        void noticePopup([{ icon: 'fa-key', text: String(error?.message || error) }]);
    });
}

/**
 * Once the screen closes: delete the vectors of the entries turned off in each book whose selection changed (§4.3 of
 * lorebook-multi-vector.md), in the background; then say what the selection lacks, for the books card's line. While
 * LoreBase is on, ask to write the keys and vectors the selected entries lack (askToWriteMissingKeysAndVectors, the
 * question turning LoreBase on asks), write them under the progress panel on yes, the books whose lock the user set
 * here keeping it as set, and turn LoreBase off when no entry is ready and none will be written; while it is off, only
 * count them.
 * @param {{booksWithChosenLocks: Set<string>, booksWithChangedSelection: Set<string>}} session - The books whose lock
 *   and whose selection the user changed while the screen was open
 * @returns {Promise<{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number,
 *   isWriting: boolean}|null>} What the selection lacks: every entry missing either, each once, and those missing
 *   each kind; or null when its keys and vectors could not be read
 */
async function settleSelectionOnClose({ booksWithChosenLocks, booksWithChangedSelection }) {
    const settings = extension_settings.vectfox;
    if (isLoreBaseBackend(settings)) {
        for (const bookName of booksWithChangedSelection) void pruneBookVectors(bookName, settings);
    }
    if (isLoreBaseSwitchedOn()) {
        const { canBeOn, shouldWrite, pending } = await askToWriteMissingKeysAndVectors({ isTurningOn: false });
        if (!canBeOn) turnLoreBaseOff();
        const isWriting = shouldWrite && writeMissingKeysAndVectors(pending, { booksWithChosenLocks: [...booksWithChosenLocks] });
        return pending && missingSummaryOf(pending, isWriting);
    }
    try {
        return missingSummaryOf(await selectedEntriesNotReady(settings), false);
    } catch (error) {
        log.warn("LoreBase: the selected entries' keys and vectors could not be counted once the selection screen closed:", error);
        return null;
    }
}

/** Show one entry of the book shown in a dialog over the screen: what it is, why it can or cannot be chosen, its text. */
async function showEntry(session, uid) {
    const row = session.rows.find(candidate => candidate.uid === uid);
    const entry = Object.values(session.book.entries ?? {}).find(candidate => String(candidate.uid) === uid);
    if (!row || !entry) {
        log.warn(`LoreBase: the selection screen has no entry ${uid} in lorebook "${session.bookName}" to show`);
        return;
    }
    const holder = document.createElement('div');
    holder.innerHTML = entryTextMarkup(entry);
    const text = holder.firstElementChild;
    text.readOnly = true;
    await noticePopup(entryDetailLines(row, entry), { body: text, isWide: true });
}

/** Fill the keys dialog's box with the keys LoreBase's model writes for the entry now, saying how it went. */
async function regenerateInto(form, entry) {
    const button = form.querySelector('[data-lorebase-keys-regenerate]');
    const status = form.querySelector(`#${ids.keysEditorStatus}`);
    button.disabled = true;
    status.textContent = "LoreBase's model is writing keys…";
    try {
        const keys = await regenerateKeys(entry, extension_settings.vectfox);
        if (!keys.length) {
            status.textContent = "LoreBase's model found nothing in this entry to key. Type keys to save, or Cancel to keep the old ones.";
            return;
        }
        form.querySelector(`#${ids.keysEditor}`).value = keys.join('\n');
        status.textContent = `${keys.length} keys from LoreBase's model. Read them, then Save keys, or Cancel to keep the old ones.`;
    } catch (error) {
        log.warn(`LoreBase: the model could not write keys for "${entryTitle(entry)}":`, error);
        if (error?.kind === 'model_config') notifyInvalidModel(error.message);
        status.textContent = `No new keys: ${String(error?.message || error)}`;
    } finally {
        button.disabled = false;
    }
}

/**
 * Edit one selected entry's keys in a dialog over the screen (D17): the box holds its keys, one per line, and
 * Regenerate fills it from LoreBase's model. Save keys stores them; keys Similharity would not store, or a save that
 * failed, keep the dialog open with the user's text and the reason.
 */
async function editKeys(session, uid) {
    const row = session.rows.find(candidate => candidate.uid === uid);
    const entry = Object.values(session.book.entries ?? {}).find(candidate => String(candidate.uid) === uid);
    if (!row?.isSelected || !entry) {
        log.warn(`LoreBase: the selection screen has no selected entry ${uid} in lorebook "${session.bookName}" to edit the keys of`);
        return;
    }
    const holder = document.createElement('div');
    holder.innerHTML = keysEditorMarkup(keyStateOf(session.bookName, uid).keys ?? []);
    const form = holder.firstElementChild;
    const status = form.querySelector(`#${ids.keysEditorStatus}`);
    form.querySelector('[data-lorebase-keys-regenerate]').addEventListener('click', () => { void regenerateInto(form, entry); });
    for (;;) {
        const isSaved = await formPopup(keysEditorLines(row.title), form, { okButton: 'Save keys', isWide: true, focusSelector: `#${ids.keysEditor}` });
        if (!isSaved) return;
        const edited = editedKeys(form.querySelector(`#${ids.keysEditor}`).value);
        if (edited.problem) {
            status.textContent = edited.problem;
            continue;
        }
        try {
            await saveEditedKeys(session.bookName, entry, edited.keys);
            return;
        } catch (error) {
            log.warn(`LoreBase: the keys edited for "${row.title}" in lorebook "${session.bookName}" could not be saved:`, error);
            status.textContent = `Not saved: ${String(error?.message || error)}`;
        }
    }
}

/**
 * Read a book and show it on one of its selections: the one named, else the one in use here, else its first, made when
 * it has none; its entries, categories, pins, locks and footer.
 * @param {HTMLElement} root
 * @param {object} session
 * @param {string} bookName
 * @param {string|null} [selectionId]
 * @returns {Promise<void>}
 */
async function showBook(root, session, bookName, selectionId = null) {
    Object.assign(session, {
        bookName, selectionId: null, book: null, rows: [], entryByUid: new Map(), ticked: new Set(), anchorUid: null, shownCategory: null,
        shownLimit: PAGE_SIZE, keyReadProblem: '', otherTakingPartCount: null,
    });
    let book;
    try {
        book = await loadWorldInfo(bookName);
    } catch (error) {
        log.warn(`LoreBase: the selection screen could not read lorebook "${bookName}":`, error);
        byId(root, ids.entries).innerHTML = bookFailedMarkup(String(error?.message || error));
        return;
    }
    // Another book was chosen while this one loaded.
    if (session.bookName !== bookName) return;
    if (!book) {
        byId(root, ids.entries).innerHTML = bookFailedMarkup('SillyTavern found no lorebook by that name');
        return;
    }
    try {
        await readBookKeys([bookName]);
    } catch (error) {
        log.warn(`LoreBase: the selection screen could not read the keys of lorebook "${bookName}":`, error);
        session.keyReadProblem = String(error?.message || error);
    }
    const settings = extension_settings.vectfox;
    if (isLoreBaseBackend(settings)) {
        try {
            await readBookVectors([bookName], settings);
        } catch (error) {
            log.warn(`LoreBase: the selection screen could not read the vectors of lorebook "${bookName}":`, error);
        }
    }
    await countOtherBooksTakingPart(session, bookName);
    if (session.bookName !== bookName) return;
    // The record as it stood says which entries are new; then it keeps the uids the book holds now.
    const seenUids = getLoreBook(bookName)?.seenUids;
    for (const selection of loreSelectionsOf(bookName)) {
        const live = liveSelection(book, selection);
        if (live.length === selection.selectedUids.length) continue;
        setLoreBookSelection(bookName, selection.id, live);
        session.booksWithChangedSelection.add(bookName);
    }
    const selection = selectionId ? getLoreSelection(bookName, selectionId) : selectionShownFor(bookName);
    session.selectionId = selection.id;
    session.book = book;
    session.entryByUid = new Map(Object.values(book.entries ?? {}).map(entry => [String(entry.uid), entry]));
    session.rows = selectionRows(book, { selectedUids: selection.selectedUids, seenUids });
    const sectionNames = new Map();
    session.sectionNamesOf = entry => {
        const key = `${entry.uid}\u0000${entry.content ?? ''}`;
        if (!sectionNames.has(key)) sectionNames.set(key, entrySectionNames(entry));
        return sectionNames.get(key);
    };
    setLoreBookSeenEntries(bookName, seenUidsOf(book));
    renderLocks(root, session);
    renderCategories(root, session);
    renderEntries(root, session);
    renderSelectionSummary(root, session);
}

/** Show another selection of the book shown, its entries' rows turned on and off as it selects them. */
function showSelection(root, session, selectionId) {
    const selection = getLoreSelection(session.bookName, selectionId);
    session.selectionId = selection.id;
    const selected = new Set(selection.selectedUids);
    for (const row of session.rows) row.isSelected = selected.has(row.uid);
    renderLocks(root, session);
    renderCategories(root, session);
    renderEntries(root, session);
    renderSelectionSummary(root, session);
}

/** New selection: a copy of the selection shown, put in use in the open chat, then shown. */
function newSelection(root, session) {
    showSelection(root, session, newLoreSelectionHere(session.bookName, session.selectionId).id);
}

/** Rename the selection shown; a name left empty or as it was saves nothing. */
async function renameSelection(root, session) {
    const selection = shownSelectionOf(session);
    if (!selection) return;
    const holder = document.createElement('div');
    holder.innerHTML = renameSelectionFormMarkup(selection.name);
    const form = holder.firstElementChild;
    const isSubmitted = await formPopup([{ text: 'Rename the selection' }, { text: 'Now:', name: selection.name }], form,
        { okButton: 'Rename', focusSelector: `#${ids.renameSelection}`, isSubmittedOnEnter: true });
    const name = form.querySelector(`#${ids.renameSelection}`).value.trim();
    if (!isSubmitted || !name || name === selection.name) return;
    renameLoreSelection(session.bookName, selection.id, name);
    renderSelectionList(root, session);
}

/**
 * Delete the selection shown through the one selection delete, the WorldInfo row's trash's too
 * (deleteLoreSelectionAfterConfirm), which asks first and prunes the vectors of the entries no other selection holds;
 * then show the one in use here or the book's first.
 */
async function deleteSelection(root, session) {
    const selection = shownSelectionOf(session);
    if (!selection || loreSelectionsOf(session.bookName).length < 2) return;
    if (!await deleteLoreSelectionAfterConfirm(session.bookName, selection.id, extension_settings.vectfox)) return;
    showSelection(root, session, selectionShownFor(session.bookName).id);
}

function onAction(root, session, element, event) {
    const name = element.dataset.lorebaseAction;
    const matching = () => matchingRows(root, session);
    if (name === 'show-all-categories' || name === 'show-category') {
        session.shownCategory = name === 'show-category' ? element.dataset.lorebaseCategory : null;
        session.shownLimit = PAGE_SIZE;
        renderCategories(root, session);
        renderEntries(root, session);
    } else if (name === 'toggle-category') {
        const category = element.dataset.lorebaseCategory;
        const state = categoryList(session.rows).find(item => item.category === category)?.state;
        saveSelection(root, session, selectionAfterCategory(selectedUidsOf(session), session.rows, category, state !== 'on'));
    } else if (name === 'toggle-entry') {
        toggleEntry(root, session, element.dataset.lorebaseUid);
    } else if (name === 'show-entry') {
        void showEntry(session, element.dataset.lorebaseUid);
    } else if (name === 'edit-keys') {
        void editKeys(session, element.dataset.lorebaseUid);
    } else if (name === 'tick-all' || name === 'untick-all' || name === 'invert') {
        if (name === 'tick-all') session.ticked = tickAllMatching(session.ticked, matching());
        else if (name === 'invert') session.ticked = invertTicks(session.ticked, matching());
        else session.ticked = new Set();
        renderEntries(root, session);
    } else if (name === 'turn-on' || name === 'turn-off') {
        saveSelection(root, session, selectionAfterBulk(selectedUidsOf(session), session.rows, session.ticked, name === 'turn-on'));
    } else if (name === 'regenerate-keys') {
        regenerateTickedKeys(session);
    } else if (name === 'show-more') {
        session.shownLimit += PAGE_SIZE;
        renderEntries(root, session);
    } else if (name === 'new-selection') {
        newSelection(root, session);
    } else if (name === 'rename-selection') {
        void renameSelection(root, session);
    } else if (name === 'delete-selection') {
        void deleteSelection(root, session);
    } else {
        log.warn(`LoreBase: the selection screen has no action "${name}"`, event.type);
    }
}

function onTick(root, session, checkbox, event) {
    const uid = checkbox.dataset.lorebaseTick;
    if (event.shiftKey && session.anchorUid) {
        session.ticked = tickRange(session.ticked, matchingRows(root, session), session.anchorUid, uid, checkbox.checked);
    } else {
        session.ticked = new Set(session.ticked);
        if (checkbox.checked) session.ticked.add(uid);
        else session.ticked.delete(uid);
    }
    session.anchorUid = uid;
    if (event.shiftKey) renderEntries(root, session);
    else renderCounts(root, session);
}

function bindScreen(root, session) {
    root.addEventListener('click', event => {
        const tick = event.target.closest('[data-lorebase-tick]');
        if (tick) {
            onTick(root, session, tick, event);
            return;
        }
        const element = event.target.closest('[data-lorebase-action]');
        if (element && !element.disabled && session.book) onAction(root, session, element, event);
    });
    root.addEventListener('change', event => {
        const target = event.target;
        if (target.id === ids.book) {
            void showBook(root, session, target.value);
        } else if (target.id === ids.selectionList && session.book) {
            showSelection(root, session, target.value);
        } else if ((target.id === ids.lockChat || target.id === ids.lockCharacter) && session.selectionId) {
            const { chatId, characterAvatar } = whereFor(session.bookName);
            setLoreSelectionLock(session.bookName, session.selectionId, target.id === ids.lockChat ? { chatId } : { characterAvatar }, target.checked);
            session.booksWithChosenLocks.add(session.bookName);
            renderLocks(root, session);
            renderSummaryText(root, session);
            renderSelectionList(root, session);
        } else if (target.matches('[data-lorebase-pin]') && session.selectionId) {
            const pinned = [...root.querySelectorAll('[data-lorebase-pin]')].filter(pin => pin.checked).map(pin => pin.dataset.lorebasePin);
            setLoreBookPins(session.bookName, session.selectionId, pinned);
        } else if ([ids.size, ids.readiness, ids.badge, ids.newness].includes(target.id) && session.book) {
            session.shownLimit = PAGE_SIZE;
            renderEntries(root, session);
        }
    });
    root.addEventListener('input', event => {
        if (event.target.id !== ids.search || !session.book) return;
        clearTimeout(session.searchTimer);
        session.searchTimer = setTimeout(() => {
            session.shownLimit = PAGE_SIZE;
            renderEntries(root, session);
        }, SEARCH_DELAY_MS);
    });
}

/**
 * Open the selection screen on a book: the one named, else the open chat's first, else the first by name; on the
 * selection named, else the one in use here, else the book's first. Once it closes, delete the vectors of the entries
 * no selection holds now and count what the selections lack; while LoreBase is on, ask to write the missing keys and
 * vectors, turning LoreBase off on no when no entry is ready, and keep the locks the user set on the screen as set
 * (settleSelectionOnClose).
 * @param {{bookName?: string, selectionId?: string|null}} [options]
 * @returns {Promise<{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number,
 *   isWriting: boolean}|null>} Once the screen is closed and any question answered: what the selection lacks, or null
 *   when its keys and vectors could not be read
 */
export async function openLoreBaseSelection({ bookName = '', selectionId = null } = {}) {
    const decidedCounts = await decidedCountsOfRecordedBooks();
    const choices = currentChoices({ decidedCounts, book: null });
    const first = choices.some(choice => choice.bookName === bookName) ? bookName : choices[0]?.bookName ?? '';
    const template = document.createElement('template');
    template.innerHTML = selectionScreenMarkup({ choices, bookName: first });
    const root = template.content.firstElementChild;
    const session = {
        decidedCounts,
        bookName: first, selectionId: null, book: null, rows: [], entryByUid: new Map(), ticked: new Set(), anchorUid: null, shownCategory: null,
        shownLimit: PAGE_SIZE,
        searchTimer: null, sectionNamesOf: entrySectionNames, shownReadiness: new Map(), keyReadProblem: '', otherTakingPartCount: null,
        booksWithChosenLocks: new Set(), booksWithChangedSelection: new Set(),
    };
    bindGeneBehaviours(root);
    bindScreen(root, session);
    const onBookStateChange = bookName => {
        if (bookName === session.bookName && session.book) renderReadiness(root, session);
    };
    const stopKeyUpdates = onKeyStateChange(onBookStateChange);
    const stopVectorUpdates = onVectorStateChange(onBookStateChange);
    const closed = openPanelPopup(root, { canClose: () => true });
    if (first) void showBook(root, session, first, first === bookName ? selectionId : null);
    else byId(root, ids.entries).innerHTML = noLorebookMarkup();
    await closed;
    stopKeyUpdates();
    stopVectorUpdates();
    clearTimeout(session.searchTimer);
    return settleSelectionOnClose(session);
}
