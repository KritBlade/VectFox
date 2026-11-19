/**
 * LoreBase's selection screen (plan §5.2 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * a dialog of its own where the user chooses a lorebook's entries for LoreBase to decide, reads any entry whole in a
 * dialog over it, locks the book to the open chat or its character (D11), and pins section names (D10). Every control
 * saves as it changes, as GUI-DNA asks. Turning entries on only selects them: once the screen closes while LoreBase is
 * on, it asks to write the keys and vectors the selected entries lack (D17, §4.3 of InternalProject/Vectfox/plans/
 * lorebook-multi-vector.md), under the progress panel, and turns LoreBase off when they are not written and no entry is
 * ready, by the question turning LoreBase on asks (lorebase-keys-question.js). The books that writing keys lock to the
 * open chat, but for those whose lock the user set while the screen was open, which stay as the user set them (§6.1).
 * While LoreBase is off, turning it on asks. Closing counts what the selection lacks either way, for the books card's
 * line, and deletes the vectors of the entries turned off in each book whose selection changed. Each selected row shows
 * where its keys stand. Regenerate keys writes the ticked entries' keys anew under the progress panel, brought in front
 * of the screen with its Stop; a selected row's pencil edits its keys in a dialog, where Regenerate fills the box from
 * the model for the user to read before saving.
 * Opening a book keeps the uids it holds, so an entry added later shows as new, drops the uids of deleted entries from
 * its selection, and reads its vectors from Qdrant again, so edits made while SillyTavern was closed are found.
 */
import { log } from '../../sillytavern/log.js';
import { formPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { loadWorldInfo, world_names } from '../../sillytavern/world-info.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection } from './lorebase-books.js';
import { chatBookNames, lockTarget } from './lorebase-chat-books.js';
import { editedKeys } from './lorebase-keys-core.js';
import { keyStateOf, keyWritingProblem, onKeyStateChange, readBookKeys, regenerateKeys, saveEditedKeys } from './lorebase-keys.js';
import { askToWriteMissingKeysAndVectors, writeMissingKeysAndVectors } from './lorebase-keys-question.js';
import { regenerateKeysOfEntries, selectedEntriesNotReady } from './lorebase-storage.js';
import { missingCountsOf } from './lorebase-storage-core.js';
import { entryTitle } from './lorebase-splitter.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn, turnLoreBaseOff } from './lorebase-switch.js';
import { pruneBookVectors, readBookVectors } from './lorebase-vectors.js';
import {
    bookChoices, categoryList, entrySectionNames, filterRows, invertTicks, liveSelection, pinnableSections, selectionAfterBulk,
    selectionAfterCategory, selectionFooter, selectionRows, seenUidsOf, tickAllMatching, tickRange, BADGES,
} from './lorebase-selection-core.js';
import {
    NEWNESS_CHOICES, SELECTION_IDS as ids, bookFailedMarkup, bookOptions, categoryRowsMarkup, entriesFooterMarkup, entryDetailLines,
    entryRowMarkup, entryTextMarkup, keySummaryText, keysEditorLines, keysEditorMarkup, lockNoticeMarkup, noLorebookMarkup,
    noMatchingEntriesMarkup, noTitleNoticeMarkup, pinsMarkup, selectionScreenMarkup, summaryText,
} from './lorebase-selection-markup.js';

const PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 200;

const byId = (root, id) => root.querySelector(`#${id}`);
const entryElementOf = (root, uid) => [...root.querySelectorAll('[data-lorebase-entry]')].find(element => element.dataset.lorebaseEntry === uid);
const recordsOf = names => Object.fromEntries(names.map(name => [name, getLoreBook(name)]).filter(([, record]) => record));
const selectedUidsOf = session => session.rows.filter(row => row.isSelected).map(row => row.uid);
// A selected row's keys, as the key store knows them; an unselected row shows none.
const keyStateFor = (session, row) => (row.isSelected ? keyStateOf(session.bookName, row.uid) : null);
const keyStateText = state => (state ? JSON.stringify(state) : '');

/** A row's markup, noting the key state it shows so a later change to it redraws the row. */
function rowMarkup(session, row) {
    const keyState = keyStateFor(session, row);
    session.shownKeyStates.set(row.uid, keyStateText(keyState));
    return entryRowMarkup(row, { isTicked: session.ticked.has(row.uid), keyState });
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

function currentChoices() {
    const names = [...world_names];
    return bookChoices(names, chatBookNames(), recordsOf(names));
}

/** The rows the filters in the controls card and the category shown let through, drawn on the screen yet or not. */
function matchingRows(root, session) {
    return filterRows(session.rows, {
        text: byId(root, ids.search).value,
        category: session.shownCategory,
        minimumTokens: Number(byId(root, ids.size).value) || 0,
        keys: byId(root, ids.keys).value,
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

/** The footer's summary: what the pick reads from the book, and where the selected entries' keys stand. */
function renderSummaryText(root, session) {
    const counts = { ready: 0, writing: 0, failed: 0, missing: 0 };
    for (const row of session.rows) {
        if (row.isSelected && !row.undecidableReason) counts[keyStateOf(session.bookName, row.uid).status] += 1;
    }
    const keyLine = session.keyReadProblem
        ? `The keys could not be read: ${session.keyReadProblem}`
        : keySummaryText(counts, { isLoreBaseOn: isLoreBaseSwitchedOn() });
    const keysOf = uid => {
        const state = keyStateOf(session.bookName, uid);
        return state.status === 'ready' ? state.keys : [];
    };
    byId(root, ids.summary).textContent = [summaryText(selectionFooter(session.book, getLoreBook(session.bookName), keysOf)), keyLine].filter(Boolean).join(' ');
}

function renderSelectionSummary(root, session) {
    const record = getLoreBook(session.bookName);
    byId(root, ids.pins).innerHTML = pinsMarkup(pinnableSections(session.book, record, session.sectionNamesOf));
    renderSummaryText(root, session);
    byId(root, ids.book).innerHTML = bookOptions(currentChoices(), session.bookName).join('');
}

/** Redraw the rows shown whose keys changed, keeping the keyboard where it was, and the summary. */
function renderKeyStates(root, session) {
    const focused = document.activeElement;
    const focusedUid = focused?.closest?.('[data-lorebase-entry]')?.dataset.lorebaseEntry;
    const focusedAction = focused?.dataset?.lorebaseAction;
    for (const element of root.querySelectorAll('[data-lorebase-entry]')) {
        const row = session.rows.find(candidate => candidate.uid === element.dataset.lorebaseEntry);
        if (!row || session.shownKeyStates.get(row.uid) === keyStateText(keyStateFor(session, row))) continue;
        element.outerHTML = rowMarkup(session, row);
        if (row.uid === focusedUid && focusedAction) entryElementOf(root, row.uid)?.querySelector(`[data-lorebase-action="${focusedAction}"]`)?.focus();
    }
    renderSummaryText(root, session);
}

function renderLocks(root, session) {
    const target = lockTarget();
    const chatSwitch = byId(root, ids.lockChat);
    const characterSwitch = byId(root, ids.lockCharacter);
    chatSwitch.disabled = !target.chatId;
    characterSwitch.disabled = !target.characterAvatar;
    chatSwitch.checked = Boolean(target.chatId) && isLoreBookLocked(session.bookName, { chatId: target.chatId });
    characterSwitch.checked = Boolean(target.characterAvatar) && isLoreBookLocked(session.bookName, { characterAvatar: target.characterAvatar });
    byId(root, ids.lockNotice).innerHTML = lockNoticeMarkup({ hasChat: Boolean(target.chatId), hasCharacter: Boolean(target.characterAvatar) });
}

/** Save a book's selection, noting the book, so the vectors of the entries turned off go as the screen closes. */
function saveBookSelection(session, bookName, selectedUids) {
    setLoreBookSelection(bookName, selectedUids);
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
    if (!row || (row.undecidableReason && !row.isSelected)) return;
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
 * Regenerate keys: write the keys of the ticked entries that are turned on anew (D17), under the progress panel, which
 * shows in front of the screen with its Stop. While another run is on the panel, a notice says so.
 */
function regenerateTickedKeys(session) {
    const uids = new Set(session.rows.filter(row => row.isSelected && !row.undecidableReason && session.ticked.has(row.uid)).map(row => row.uid));
    if (!uids.size) {
        void noticePopup([{ icon: 'fa-key', text: 'None of the ticked entries is turned on. LoreBase writes keys only for entries it decides.' }]);
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
        return pending && { missingCount: pending.count, ...missingCountsOf(pending), decidedCount: pending.decidedCount, isWriting };
    }
    try {
        const pending = await selectedEntriesNotReady(settings);
        return { missingCount: pending.count, ...missingCountsOf(pending), decidedCount: pending.decidedCount, isWriting: false };
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
            await saveEditedKeys(session.bookName, uid, edited.keys);
            return;
        } catch (error) {
            log.warn(`LoreBase: the keys edited for "${row.title}" in lorebook "${session.bookName}" could not be saved:`, error);
            status.textContent = `Not saved: ${String(error?.message || error)}`;
        }
    }
}

/** Read a book and show it: its entries, categories, pins, locks and footer. */
async function showBook(root, session, bookName) {
    Object.assign(session, { bookName, book: null, rows: [], ticked: new Set(), anchorUid: null, shownCategory: null, shownLimit: PAGE_SIZE, keyReadProblem: '' });
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
    if (session.bookName !== bookName) return;
    // The record as it stood says which entries are new; then it keeps the uids the book holds now.
    const record = getLoreBook(bookName);
    session.book = book;
    session.rows = selectionRows(book, record);
    const sectionNames = new Map();
    session.sectionNamesOf = entry => {
        const key = `${entry.uid}\u0000${entry.content ?? ''}`;
        if (!sectionNames.has(key)) sectionNames.set(key, entrySectionNames(entry));
        return sectionNames.get(key);
    };
    const live = liveSelection(book, record);
    if (record && live.length !== record.selectedUids.length) saveBookSelection(session, bookName, live);
    setLoreBookSeenEntries(bookName, seenUidsOf(book));
    renderLocks(root, session);
    renderCategories(root, session);
    renderEntries(root, session);
    renderSelectionSummary(root, session);
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
        } else if (target.id === ids.lockChat || target.id === ids.lockCharacter) {
            const { chatId, characterAvatar } = lockTarget();
            setLoreBookLock(session.bookName, target.id === ids.lockChat ? { chatId } : { characterAvatar }, target.checked);
            session.booksWithChosenLocks.add(session.bookName);
            renderLocks(root, session);
        } else if (target.matches('[data-lorebase-pin]')) {
            const pinned = [...root.querySelectorAll('[data-lorebase-pin]')].filter(pin => pin.checked).map(pin => pin.dataset.lorebasePin);
            setLoreBookPins(session.bookName, pinned);
        } else if ([ids.size, ids.keys, ids.badge, ids.newness].includes(target.id) && session.book) {
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
 * Open the selection screen on a book: the one named, else the open chat's first, else the first by name. Once it
 * closes, delete the vectors of the entries turned off and count what the selection lacks; while LoreBase is on, ask to
 * write the missing keys and vectors, turning LoreBase off on no when no entry is ready, and keep the locks the user
 * set on the screen as set (settleSelectionOnClose).
 * @param {{bookName?: string}} [options]
 * @returns {Promise<{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number,
 *   isWriting: boolean}|null>} Once the screen is closed and any question answered: what the selection lacks, or null
 *   when its keys and vectors could not be read
 */
export async function openLoreBaseSelection({ bookName = '' } = {}) {
    const choices = currentChoices();
    const first = choices.some(choice => choice.bookName === bookName) ? bookName : choices[0]?.bookName ?? '';
    const template = document.createElement('template');
    template.innerHTML = selectionScreenMarkup({ choices, bookName: first });
    const root = template.content.firstElementChild;
    const session = {
        bookName: first, book: null, rows: [], ticked: new Set(), anchorUid: null, shownCategory: null, shownLimit: PAGE_SIZE, searchTimer: null,
        sectionNamesOf: entrySectionNames, shownKeyStates: new Map(), keyReadProblem: '', booksWithChosenLocks: new Set(),
        booksWithChangedSelection: new Set(),
    };
    bindGeneBehaviours(root);
    bindScreen(root, session);
    const stopKeyUpdates = onKeyStateChange(bookName => {
        if (bookName === session.bookName && session.book) renderKeyStates(root, session);
    });
    const closed = openPanelPopup(root, { canClose: () => true });
    if (first) void showBook(root, session, first);
    else byId(root, ids.entries).innerHTML = noLorebookMarkup();
    await closed;
    stopKeyUpdates();
    clearTimeout(session.searchTimer);
    return settleSelectionOnClose(session);
}
