/**
 * LoreBase's selection screen (plan §5.2 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * a dialog of its own where the user chooses a lorebook's entries for LoreBase to decide, reads any entry whole in a
 * dialog over it, locks the book to the open chat or its character (D11), and pins section names (D10). Every control
 * saves as it changes, as GUI-DNA asks.
 * Opening a book keeps the uids it holds, so an entry added later shows as new, and drops the uids of deleted entries
 * from its selection.
 */
import { log } from '../../sillytavern/log.js';
import { noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { loadWorldInfo, world_names } from '../../sillytavern/world-info.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSeenEntries, setLoreBookSelection } from './lorebase-books.js';
import { chatBookNames, lockTarget } from './lorebase-chat-books.js';
import {
    bookChoices, categoryList, entrySectionNames, filterRows, invertTicks, liveSelection, pinnableSections, selectionAfterBulk,
    selectionAfterCategory, selectionFooter, selectionRows, seenUidsOf, tickAllMatching, tickRange, BADGES,
} from './lorebase-selection-core.js';
import {
    NEWNESS_CHOICES, SELECTION_IDS as ids, bookFailedMarkup, bookOptions, categoryRowsMarkup, entriesFooterMarkup, entryDetailLines,
    entryRowMarkup, entryTextMarkup, lockNoticeMarkup, noLorebookMarkup, noMatchingEntriesMarkup, noTitleNoticeMarkup, pinsMarkup,
    selectionScreenMarkup, summaryText,
} from './lorebase-selection-markup.js';

const PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 200;

const byId = (root, id) => root.querySelector(`#${id}`);
const entryElementOf = (root, uid) => [...root.querySelectorAll('[data-lorebase-entry]')].find(element => element.dataset.lorebaseEntry === uid);
const recordsOf = names => Object.fromEntries(names.map(name => [name, getLoreBook(name)]).filter(([, record]) => record));
const selectedUidsOf = session => session.rows.filter(row => row.isSelected).map(row => row.uid);

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
    for (const name of ['turn-on', 'turn-off']) root.querySelector(`[data-lorebase-action="${name}"]`).disabled = tickedCount === 0;
    root.querySelector('[data-lorebase-selected-count]').textContent = `${selectedUidsOf(session).length} selected`;
}

function renderEntries(root, session) {
    const matching = matchingRows(root, session);
    const shown = matching.slice(0, session.shownLimit);
    byId(root, ids.entries).innerHTML = shown.length
        ? shown.map(row => entryRowMarkup(row, { isTicked: session.ticked.has(row.uid) })).join('')
        : noMatchingEntriesMarkup();
    byId(root, ids.entriesNotice).innerHTML = shown.some(row => row.badges.includes(BADGES.noTitle)) ? noTitleNoticeMarkup() : '';
    byId(root, ids.entriesFooter).innerHTML = entriesFooterMarkup({ shownCount: shown.length, matchCount: matching.length, hasMore: matching.length > shown.length });
    renderCounts(root, session);
}

function renderCategories(root, session) {
    byId(root, ids.categories).innerHTML = categoryRowsMarkup(categoryList(session.rows), { shownCategory: session.shownCategory, entryCount: session.rows.length });
}

function renderSelectionSummary(root, session) {
    const record = getLoreBook(session.bookName);
    byId(root, ids.pins).innerHTML = pinsMarkup(pinnableSections(session.book, record, session.sectionNamesOf));
    byId(root, ids.summary).textContent = summaryText(selectionFooter(session.book, record));
    byId(root, ids.book).innerHTML = bookOptions(currentChoices(), session.bookName).join('');
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
    const selected = new Set(selectedUids);
    for (const row of session.rows) row.isSelected = selected.has(row.uid);
    renderCategories(root, session);
    renderEntries(root, session);
    renderSelectionSummary(root, session);
}

/** Turn one entry on or off, redrawing only its row so the keyboard stays on its toggle. */
function toggleEntry(root, session, uid) {
    const row = session.rows.find(candidate => candidate.uid === uid);
    if (!row || (row.keptBySillyTavern && !row.isSelected)) return;
    row.isSelected = !row.isSelected;
    setLoreBookSelection(session.bookName, selectedUidsOf(session));
    const element = entryElementOf(root, uid);
    if (element) {
        element.outerHTML = entryRowMarkup(row, { isTicked: session.ticked.has(uid) });
        entryElementOf(root, uid)?.querySelector('[data-lorebase-action="toggle-entry"]')?.focus();
    }
    renderCategories(root, session);
    renderCounts(root, session);
    renderSelectionSummary(root, session);
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

/** Read a book and show it: its entries, categories, pins, locks and footer. */
async function showBook(root, session, bookName) {
    Object.assign(session, { bookName, book: null, rows: [], ticked: new Set(), anchorUid: null, shownCategory: null, shownLimit: PAGE_SIZE });
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
    } else if (name === 'tick-all' || name === 'untick-all' || name === 'invert') {
        if (name === 'tick-all') session.ticked = tickAllMatching(session.ticked, matching());
        else if (name === 'invert') session.ticked = invertTicks(session.ticked, matching());
        else session.ticked = new Set();
        renderEntries(root, session);
    } else if (name === 'turn-on' || name === 'turn-off') {
        saveSelection(root, session, selectionAfterBulk(selectedUidsOf(session), session.rows, session.ticked, name === 'turn-on'));
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
 * Open the selection screen on a book: the one named, else the open chat's first, else the first by name.
 * @param {{bookName?: string}} [options]
 * @returns {Promise<void>} Once the screen is closed
 */
export async function openLoreBaseSelection({ bookName = '' } = {}) {
    const choices = currentChoices();
    const first = choices.some(choice => choice.bookName === bookName) ? bookName : choices[0]?.bookName ?? '';
    const template = document.createElement('template');
    template.innerHTML = selectionScreenMarkup({ choices, bookName: first });
    const root = template.content.firstElementChild;
    const session = { bookName: first, book: null, rows: [], ticked: new Set(), anchorUid: null, shownCategory: null, shownLimit: PAGE_SIZE, searchTimer: null, sectionNamesOf: entrySectionNames };
    bindGeneBehaviours(root);
    bindScreen(root, session);
    const closed = openPanelPopup(root, { canClose: () => true });
    if (first) void showBook(root, session, first);
    else byId(root, ids.entries).innerHTML = noLorebookMarkup();
    await closed;
    clearTimeout(session.searchTimer);
}
