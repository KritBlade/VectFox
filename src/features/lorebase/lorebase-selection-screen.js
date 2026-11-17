/**
 * LoreBase's selection screen (plan §5.2 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * a dialog of its own where the user chooses a lorebook's entries for LoreBase to decide, reads any entry whole in a
 * dialog over it, locks the book to the open chat or its character (D11), and pins section names (D10). Every control
 * saves as it changes, as GUI-DNA asks. Turning entries on only selects them: once the screen closes while LoreBase is
 * on, it asks to write the keys of the selected entries that have none (D17), under the progress panel; while LoreBase
 * is off, turning it on asks. Each selected row shows where its keys stand. Regenerate keys writes the ticked entries'
 * keys anew under the progress panel, brought in front of the screen with its Stop; a selected row's pencil edits its
 * keys in a dialog, where Regenerate fills the box from the model for the user to read before saving.
 * Opening a book keeps the uids it holds, so an entry added later shows as new, and drops the uids of deleted entries
 * from its selection.
 */
import { log } from '../../sillytavern/log.js';
import { confirmPopup, formPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { loadWorldInfo, world_names } from '../../sillytavern/world-info.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection } from './lorebase-books.js';
import { chatBookNames, lockTarget } from './lorebase-chat-books.js';
import { editedKeys, missingKeysLines } from './lorebase-keys-core.js';
import {
    keyStateOf, keyWritingProblem, onKeyStateChange, readBookKeys, regenerateKeys, regenerateKeysOfEntries, saveEditedKeys,
    selectedEntriesWithoutKeys, writeKeysOfSelections,
} from './lorebase-keys.js';
import { entryTitle } from './lorebase-splitter.js';
import { isLoreBaseSwitchedOn } from './lorebase-switch.js';
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

/** Save a new selection for the book shown, and redraw what it changes. */
function saveSelection(root, session, selectedUids) {
    setLoreBookSelection(session.bookName, selectedUids);
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
    setLoreBookSelection(session.bookName, selectedUidsOf(session));
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
 * Once the screen closes while LoreBase is on: ask to write the keys of the selected entries that have none, in every
 * book, and write them under the progress panel on yes (D17). Says why when the keys cannot be read or written.
 * @returns {Promise<{missingCount: number, decidedCount: number, isWriting: boolean}|null>} What the selection's keys
 *   came to, or null while LoreBase is off or when the keys could not be read
 */
async function offerMissingKeys() {
    if (!isLoreBaseSwitchedOn()) return null;
    let pending;
    try {
        pending = await selectedEntriesWithoutKeys();
    } catch (error) {
        log.warn('LoreBase: the selected entries\' keys could not be read once the selection screen closed:', error);
        await noticePopup([{ icon: 'fa-key', text: 'LoreBase could not read the keys of its selected entries.' }, { name: String(error?.message || error) }]);
        return null;
    }
    const outcome = { missingCount: pending.count, decidedCount: pending.decidedCount, isWriting: false };
    if (!pending.count) return outcome;
    const problem = keyWritingProblem(extension_settings.vectfox);
    if (problem) {
        await noticePopup([...missingKeysLines(pending.count), { text: "LoreBase's model cannot write them yet." }, { name: problem }]);
        return outcome;
    }
    const isAgreed = await confirmPopup([
        ...missingKeysLines(pending.count),
        { text: 'Write them now? A progress panel shows the writing. Not now leaves them without keys until Generate all keys.' },
    ], { okButton: 'Write keys', cancelButton: 'Not now' });
    if (!isAgreed) return outcome;
    outcome.isWriting = true;
    writeKeysOfSelections(extension_settings.vectfox, pending).catch(error => {
        log.warn('LoreBase: the selected entries\' keys were not written:', error);
        void noticePopup([{ icon: 'fa-key', text: String(error?.message || error) }]);
    });
    return outcome;
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
    if (record && live.length !== record.selectedUids.length) setLoreBookSelection(bookName, live);
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
 * closes while LoreBase is on, ask to write the selected entries' missing keys (offerMissingKeys).
 * @param {{bookName?: string}} [options]
 * @returns {Promise<{missingCount: number, decidedCount: number, isWriting: boolean}|null>} Once the screen is closed
 *   and the question answered: what the selection's keys came to, or null while LoreBase is off or the keys were unread
 */
export async function openLoreBaseSelection({ bookName = '' } = {}) {
    const choices = currentChoices();
    const first = choices.some(choice => choice.bookName === bookName) ? bookName : choices[0]?.bookName ?? '';
    const template = document.createElement('template');
    template.innerHTML = selectionScreenMarkup({ choices, bookName: first });
    const root = template.content.firstElementChild;
    const session = {
        bookName: first, book: null, rows: [], ticked: new Set(), anchorUid: null, shownCategory: null, shownLimit: PAGE_SIZE, searchTimer: null,
        sectionNamesOf: entrySectionNames, shownKeyStates: new Map(), keyReadProblem: '',
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
    return offerMissingKeys();
}
