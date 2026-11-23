/**
 * ============================================================================
 * WORLDINFO PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's WorldInfo page on GUI-DNA: LoreBase's switch, its books
 * for the open chat, each with its state, with the door to its selection
 * screen and Add a lorebook; LoreBase's model with its setup notice, its
 * Accuracy and the embedding model that writes its vectors; and its tester.
 * Every control keeps the id settings-panel.js, lorebase-books-card.js,
 * lorebase-model-card.js, lorebase-tester-card.js or connection-rows.js wires
 * it by. The LoreBase book list and the tester's reports are built here as
 * well. Pure: builds strings.
 * ============================================================================
 */

import { chatProviderOptions, connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';
import {
    button, controlRow, detail, emptyState, field, fieldLabel, groupTitle, hint, iconButton, listRow, notice, recordCard, resultList,
    select, selectOption, stack, statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { buttonWithId, cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { inUseSwitcherMarkup } from './in-use-switcher-markup.js';

const formatCount = count => Number(count).toLocaleString('en-US');
const formatSeconds = seconds => `${Number(seconds).toFixed(1)} s`;
// Room for a failure's own text on a book's row.
const FAILURE_CHARACTERS = 200;

// LoreBase's switch (plan §5.9), off until the user turns it on, and its books (§5.2): the list loreBaseBooksMarkup
// draws for the open chat, the selection screen's door, and the keys and vectors of every selected entry (D17, §4.3
// of lorebook-multi-vector.md, §3.4 of vectfox-multi-collection-per-chat.md): Entries at once, how many entries' keys
// are written at once (1 to 8, KEY_CALLS_AT_ONCE_MAX in lorebase-keys-core.js); Generate keys and Generate vectors
// write the missing ones of their kind, Generate all both, and Delete all deletes them all, its status line saying
// how each went. While the switch is off, lorebase-books-card.js disables the Generate buttons, since turning
// LoreBase on asks to write them, and shows the notice saying what to do first.
function loreBaseBooksCard() {
    return `<section id="VectFox_lorebase_books_card" class="vfx-card">
        ${cardHeader({ icon: 'fa-book-open', title: 'LoreBase books', description: 'The lorebooks this chat loads. LoreBase decides selected entries in books locked here.' })}
        <div class="vfx-card-body vfx-stack">
            ${switchRow({ id: 'VectFox_lorebase_enabled', title: 'Use LoreBase', description: 'Off: every entry fires by its keys, as SillyTavern does. Selections are kept.' })}
            <div id="VectFox_lorebase_off_notice">${notice({ status: 'info', text: 'Choose entries and set up the LoreBase model card, then turn on Use LoreBase: it asks before writing their keys and vectors.' })}</div>
            <div id="VectFox_lorebase_books" aria-live="polite"></div>
            ${controlRow([button({ text: 'Choose entries', icon: 'fa-list-check', kind: 'primary', data: { 'lorebase-choose': '' } })])}
            ${hint({ text: "Choose lorebook entries for LoreBase, and lock the selection to this chat or character." })}
            ${field([
                fieldLabel({ text: 'Entries at once', forId: 'VectFox_lorebase_key_calls_at_once' }),
                sliderNumber({ id: 'VectFox_lorebase_key_calls_at_once', min: 1, max: 8, step: 1, title: 'Entries' }),
                hint({ text: "How many entries' keys are written at once. More is faster but risks rate limits." }),
            ])}
            ${controlRow([
                buttonWithId({ id: 'VectFox_lorebase_generate_keys', text: 'Generate keys', icon: 'fa-key' }),
                buttonWithId({ id: 'VectFox_lorebase_generate_vectors', text: 'Generate vectors', icon: 'fa-vector-square' }),
                buttonWithId({ id: 'VectFox_lorebase_generate_all', text: 'Generate all', icon: 'fa-layer-group' }),
                buttonWithId({ id: 'VectFox_lorebase_delete_all', text: 'Delete all', icon: 'fa-trash' }),
            ])}
            ${hint({ text: 'Each Generate writes what is missing. Delete all removes both and turns LoreBase off.' })}
            <p id="VectFox_lorebase_books_status" class="vfx-hint" aria-live="polite" hidden></p>
        </div>
    </section>`;
}

// LoreBase's model card (plan §5.6, and §2 and §7.2 of lorebook-multi-vector.md). The setup notice comes first, naming
// the first thing LoreBase lacks, which lorebase-model-card.js fills and hides while nothing is missing. Accuracy comes
// next, since it decides what each model does: LoreBase's own model writes each entry's keys on every choice (D17) and,
// on High Accuracy, also picks and reviews (D6); on Fast and Cheap [Jev], the default, Jev picks, on a profile of its
// own (D16), its picks sent within the Lore budget (§5 and Q4 of lorebook-multi-vector.md: 4,000 tokens by default,
// 1,000 to 12,000, LORE_BUDGET_DEFAULT, LORE_BUDGET_MIN and LORE_BUDGET_MAX in lorebase-jev-core.js). connection-rows.js
// shows the title of the own model's role and Jev's group, which shows on Fast and Cheap [Jev] only. Last, the Vectors
// line names VectFox's embedding model, which writes every selected entry's vectors on either choice, with the button
// to the Core page that sets it; lorebase-model-card.js fills it. The option values are FAST_AND_CHEAP and High
// Accuracy's in lorebase-reply-core.js.
function loreBaseModelCard() {
    const accuracy = select({
        id: 'VectFox_lorebase_accuracy',
        options: [
            selectOption({ value: 'fast', text: 'Fast and Cheap [Jev]' }),
            selectOption({ value: 'high', text: 'High Accuracy' }),
        ],
    });
    return `<section id="VectFox_lorebase_model_card" class="vfx-card">
        ${cardHeader({ icon: 'fa-plug', title: 'LoreBase model', description: 'Writes each entry\'s keys, and picks and trims each reply\'s lore unless Jev does.' })}
        <div class="vfx-card-body vfx-grid">
            <div id="VectFox_lorebase_setup_notice" class="vfx-span" hidden></div>
            ${field([
                fieldLabel({ text: 'Accuracy', forId: 'VectFox_lorebase_accuracy' }),
                accuracy,
                hint({ text: 'Fast and Cheap [Jev] is quickest and cheapest. High Accuracy sends only the parts needed.' }),
                detail({ text: 'Fast and Cheap [Jev] asks Jev, a decisions model: it answers in under a second for a fraction of the cost, and sends the entries it rates above 0.25 whole, best first, within the Lore budget. Above 100 selected entries, a search of their vectors first finds the 100 Jev is asked about. High Accuracy has LoreBase\'s own model pick the entries, then reviews each picked entry of more than one part at low reasoning effort and sends only the parts the reply needs. On both, LoreBase\'s own model writes each entry\'s keys when it is turned on, since the pick and Jev\'s questions read them.' }),
            ], { isSpan: true })}
            <div id="VectFox_lorebase_role_picks" class="vfx-span">${groupTitle({ icon: 'fa-key', text: 'Keys and picks' })}${hint({ text: 'Writes each entry\'s keys when you turn it on, and picks each reply\'s lore.' })}</div>
            <div id="VectFox_lorebase_role_keys" class="vfx-span" style="display:none;">${groupTitle({ icon: 'fa-key', text: 'Keys' })}${hint({ text: 'Writes each entry\'s keys once, when you turn it on. Replies use Jev.' })}</div>
            ${field([fieldLabel({ text: 'Provider', forId: 'VectFox_lorebase_provider' }), select({ id: 'VectFox_lorebase_provider', options: chatProviderOptions() })])}
            ${field([
                fieldLabel({ text: 'Model', forId: 'VectFox_lorebase_model' }),
                '<input type="text" id="VectFox_lorebase_model" class="vfx-input" placeholder="openai/gpt-6-luna">',
                hint({ text: 'LoreBase was tested on GPT-6 Luna.' }),
            ])}
            ${connectionProfileRows('VectFox_lorebase', { hintText: 'LoreBase was tested on GPT-6 Luna. The profile\'s model, URL and key are used.' })}
            ${testConnectionButton('VectFox_lorebase', { hintText: 'Sends one short fixed message, never your chat, and shows the reply.' })}
            <div id="VectFox_lorebase_jev_group" class="vfx-grid vfx-span" style="display:none;">
                ${groupTitle({ icon: 'fa-bolt', text: 'Jev' })}
                ${connectionProfileRows('VectFox_lorebase_jev', { hintText: 'An OpenRouter or Custom profile whose model is Jev. Its key stays in SillyTavern.' })}
                ${testConnectionButton('VectFox_lorebase_jev', { hintText: 'Asks Jev one made-up question, never your chat.' })}
                ${field([
                    fieldLabel({ text: 'Lore budget', forId: 'VectFox_lorebase_lore_budget_tokens' }),
                    sliderNumber({ id: 'VectFox_lorebase_lore_budget_tokens', min: 1000, max: 12000, step: 500, title: 'Tokens' }),
                    hint({ text: "The most tokens Jev's picks send a reply. More keeps more lore and costs more." }),
                ])}
            </div>
            ${field([
                fieldLabel({ text: 'Vectors' }),
                controlRow([
                    '<p id="VectFox_lorebase_vectors_model" class="vfx-hint"></p>',
                    buttonWithId({ id: 'VectFox_lorebase_vectors_link', text: 'Set on the Core page', icon: 'fa-arrow-right' }),
                ]),
                hint({ text: "VectFox's embedding model writes each selected entry's vectors, on both choices." }),
            ], { isSpan: true })}
        </div>
    </section>`;
}

/**
 * The model card's setup notice: the first thing LoreBase lacks, from loreBaseSetupProblem, or nothing.
 * @param {string} problem - '' when nothing is missing
 * @returns {string}
 */
export function loreBaseSetupNoticeMarkup(problem) {
    return problem ? notice({ status: 'warning', text: problem }) : '';
}

/**
 * The model card's Vectors line: VectFox's embedding model, from embeddingModelName.
 * @param {string} modelName - '' when no known provider is set
 * @returns {string}
 */
export function loreBaseVectorsLineText(modelName) {
    return modelName ? `${modelName}, VectFox's embedding model.` : 'No embedding model is set.';
}

// LoreBase's tester (plan §5.10): Try a pick, and this session's reports for the open chat, picked in the Reply list,
// which lorebase-tester-card.js fills and hides while there is none.
function loreBaseTesterCard() {
    return `<section id="VectFox_lorebase_tester_card" class="vfx-card">
        ${cardHeader({ icon: 'fa-flask', title: 'LoreBase tester', description: "What LoreBase did on this session's replies in the open chat." })}
        <div class="vfx-card-body vfx-stack">
            ${field([
                controlRow([buttonWithId({ id: 'VectFox_lorebase_try_pick', text: 'Try a pick', icon: 'fa-play' })]),
                hint({ text: "Picks for the open chat's next reply on your Accuracy and connections. Sends no reply." }),
            ])}
            <div id="VectFox_lorebase_report_field">${field([fieldLabel({ text: 'Reply', forId: 'VectFox_lorebase_report' }), select({ id: 'VectFox_lorebase_report' })])}</div>
            <div id="VectFox_lorebase_report_body"></div>
            ${hint({ text: "Kept until the page reloads. Tokens are counted as SillyTavern's itemization counts them." })}
        </div>
    </section>`;
}

/**
 * The WorldInfo page's cards: LoreBase books, LoreBase model, then the tester.
 *
 * @returns {string}
 */
export function worldInfoPageMarkup() {
    return loreBaseBooksCard() + loreBaseModelCard() + loreBaseTesterCard();
}

const LOCK_PILLS = {
    chat: statusPill({ text: 'Locked to this chat', icon: 'fa-lock', status: 'success' }),
    character: statusPill({ text: 'Locked to this character', icon: 'fa-lock', status: 'success' }),
    none: statusPill({ text: 'Not locked', icon: 'fa-lock-open' }),
};

// A book's selected entries, and once read how many of them have keys and vectors: each count with its unit, so no two
// numbers stand side by side.
function selectedLine(selectedCount, keyCount, vectorCount) {
    const line = `${formatCount(selectedCount)} selected`;
    if (keyCount === undefined || vectorCount === undefined) return line;
    return `${line}, ${formatCount(keyCount)} with keys, ${formatCount(vectorCount)} with vectors`;
}

// What the entries LoreBase decides lack, as one state: each lacking entry once, by the kinds they lack.
function needLine({ readyCount, decidedCount, missingKeyCount, missingVectorCount }) {
    const lacking = decidedCount - readyCount;
    let kinds = 'keys or vectors';
    if (missingKeyCount === lacking && missingVectorCount === lacking) kinds = 'keys and vectors';
    else if (!missingVectorCount) kinds = 'keys';
    else if (!missingKeyCount) kinds = 'vectors';
    return `${formatCount(lacking)} need ${kinds}`;
}

/**
 * A book's one state (§7.1 of lorebook-multi-vector.md), once its keys and vectors are read: the run writing its keys
 * or vectors now, with its entries done of those it writes; the entries that failed; vectors another embedding model
 * made; what the rest lack; or ready. Each counts the entries LoreBase decides, so a selected entry it skips, as a
 * disabled one, never keeps a book from ready.
 */
function bookStatePill(book) {
    const { writing, readyCount, decidedCount, failedCount, otherModelCount } = book;
    if (writing) {
        const step = writing.isKeys ? 'Writing keys' : 'Vectorizing';
        return statusPill({ name: `${step}, ${formatCount(writing.done)} of ${formatCount(writing.total)}`, icon: writing.isKeys ? 'fa-pen-nib' : 'fa-vector-square', status: 'accent' });
    }
    if (failedCount) return statusPill({ name: `${formatCount(failedCount)} failed`, icon: 'fa-triangle-exclamation', status: 'danger' });
    if (readyCount === decidedCount) return statusPill({ text: 'Ready', icon: 'fa-check', status: 'success' });
    if (otherModelCount) return statusPill({ text: 'Vectors from another embedding model', icon: 'fa-vector-square', status: 'warning' });
    return statusPill({ name: needLine(book), icon: 'fa-key', status: 'warning' });
}

/**
 * One book's row in the LoreBase books card's list, as loreBaseBooksMarkup draws it, for the card to draw again alone
 * as a writing run moves through the book.
 * @param {object} book - One of loreBaseBooksMarkup's books
 * @returns {string}
 */
export function loreBaseBookRow(book) {
    const { bookName, selectedCount, isLockedToChat, isLockedToCharacter, keyCount, vectorCount, readyCount, failedCount, firstFailure } = book;
    const locks = [isLockedToChat ? LOCK_PILLS.chat : '', isLockedToCharacter ? LOCK_PILLS.character : ''].filter(Boolean);
    const isStateShown = Boolean(selectedCount) && (Boolean(book.writing) || readyCount !== undefined);
    const sub = selectedCount ? [{ name: selectedLine(selectedCount, keyCount, vectorCount) }] : [{ text: 'Nothing selected' }];
    if (isStateShown && failedCount && !book.writing) sub.push({ text: 'First failure', name: String(firstFailure ?? '').slice(0, FAILURE_CHARACTERS) });
    return listRow({
        icon: 'fa-book',
        name: bookName,
        sub,
        pills: [isStateShown ? bookStatePill(book) : '', ...(locks.length ? locks : [LOCK_PILLS.none])].filter(Boolean),
        actions: [
            inUseSwitcherMarkup({
                id: `VectFox_lorebase_in_use_${encodeURIComponent(bookName)}`,
                title: 'Selection in use here',
                members: book.selections,
                inUseId: book.selectionInUseId,
                newText: 'New selection',
                data: { 'lorebase-in-use': bookName },
            }),
            iconButton({ icon: 'fa-list-check', title: 'Choose entries', data: { 'lorebase-choose': bookName } }),
            book.canUnlink
                ? iconButton({ icon: 'fa-link-slash', title: 'Unlink from this chat, and remove from LoreBase', isDanger: true, data: { 'lorebase-unlink': bookName } })
                : '',
            bookTrashButton(book),
        ].filter(Boolean),
    });
}

/**
 * A book row's trash (§3.6 and §3.7 of vectfox-multi-collection-per-chat.md, the user, 2026-11-21): on a book of 2 or
 * more selections, one of them in use here and so shown in its dropdown, the delete of that selection alone; else, on a
 * book LoreBase has a record of, Remove from LoreBase, the whole book.
 */
function bookTrashButton({ bookName, selections, selectionInUseId, canRemove }) {
    const shown = selections.length > 1 ? selections.find(selection => selection.id === selectionInUseId) : null;
    if (shown) {
        return iconButton({
            icon: 'fa-trash-can', title: `Delete the selection "${shown.name}"`, isDanger: true,
            data: { 'lorebase-delete-selection': bookName, 'lorebase-selection': shown.id },
        });
    }
    return canRemove ? iconButton({ icon: 'fa-trash-can', title: 'Remove from LoreBase', isDanger: true, data: { 'lorebase-remove': bookName } }) : '';
}

/**
 * The line under the book list (§7.1): the ready entries of the books taking part in this chat, those with a selection
 * in use here, and those LoreBase decides still waiting for keys or vectors, so a book that waits shows while LoreBase
 * goes on with the rest; or that no book with selected entries is locked here. Nothing before the counts are read.
 */
function readyLine(books) {
    const selected = books.filter(book => book.selectedCount && book.readyCount !== undefined);
    if (!selected.length) return '';
    const takingPart = selected.filter(book => Boolean(book.selectionInUseId));
    if (!takingPart.length) return hint({ text: 'No book with selected entries is locked here, so LoreBase sends none of them.' });
    const ready = takingPart.reduce((sum, book) => sum + book.readyCount, 0);
    const waiting = takingPart.reduce((sum, book) => sum + book.decidedCount - book.readyCount, 0);
    const lockedBooks = `${formatCount(takingPart.length)} ${takingPart.length === 1 ? 'book' : 'books'} locked here`;
    const entries = count => `${formatCount(count)} ${count === 1 ? 'entry' : 'entries'}`;
    return hint({ text: `${lockedBooks}: ${entries(ready)} ready${waiting ? `, ${entries(waiting)} waiting for keys or vectors` : ''}.` });
}

// Add a lorebook (§6 and §7.1 of lorebook-multi-vector.md): the books the chat does not load, then a button for each
// place, Add to this chat, as its Chat Lorebook, and Add to this character, which a group chat with no one character
// lacks. Each button carries the place addLoreBookToChat takes (ADD_TO_CHAT and ADD_TO_CHARACTER in
// lorebase-chat-books.js).
function addBookMarkup({ bookNames, canAddToCharacter }) {
    if (!bookNames.length) return hint({ text: 'This chat loads every lorebook you have.' });
    const options = [selectOption({ value: '', text: 'Choose a lorebook' }), ...bookNames.map(bookName => selectOption({ value: bookName, name: bookName }))];
    return field([
        fieldLabel({ text: 'Add a lorebook', forId: 'VectFox_lorebase_add_book' }),
        controlRow([
            select({ id: 'VectFox_lorebase_add_book', title: 'Lorebook to add', options }),
            button({ text: 'Add to this chat', icon: 'fa-comment', data: { 'lorebase-add': 'chat' } }),
            canAddToCharacter ? button({ text: 'Add to this character', icon: 'fa-user-plus', data: { 'lorebase-add': 'character' } }) : '',
        ]),
        hint({
            text: canAddToCharacter
                ? 'This chat: as its Chat Lorebook, locked here. This character: its chats, locked to it.'
                : 'A group chat has no one character, so a book goes to this chat, locked here.',
        }),
    ]);
}

/**
 * The LoreBase books card's list for the open chat: each book SillyTavern loads here, how many entries are selected
 * in it and, once read, how many of those have keys and vectors and its one state (§7.1 of lorebook-multi-vector.md),
 * and whether it is locked to this chat or its character, where LoreBase decides them (D11), each row with Selection in
 * use here (inUseSwitcherMarkup, §1.2 of vectfox-multi-collection-per-chat.md), None in use here and New selection
 * alone on a book with no selection, Choose entries, Unlink on a book a list Unlink takes books out of loads here, and
 * the trash (bookTrashButton): the selection in use here on a book of several, else Remove from LoreBase on a book
 * LoreBase has a record of; the counts and locks are those of the selection in use here,
 * or with none, the counts of every entry the book's selections hold; under the list, the ready entries of the books
 * locked here and those waiting; then, given what to add, Add a lorebook.
 *
 * @param {{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean, selections: Array<{id: string, name: string}>, selectionInUseId: string|null,
 *   canRemove?: boolean, canUnlink?: boolean, keyCount?: number, vectorCount?: number, readyCount?: number,
 *   missingKeyCount?: number, missingVectorCount?: number, otherModelCount?: number, failedCount?: number,
 *   firstFailure?: string|null, writing?: {isKeys: boolean, done: number, total: number}|null}>,
 *   add?: {bookNames: string[], canAddToCharacter: boolean}|null}} status - LoreBase's chatBookLocks, with
 *   storedCountsOfBooks's counts, the writing run's place in the book it writes now, and booksToAdd's books
 * @returns {string}
 */
export function loreBaseBooksMarkup({ hasChat, books, add = null }) {
    if (!hasChat) return emptyState({ icon: 'fa-comments', text: 'Open a chat to see the lorebooks it loads.' });
    const list = books.length
        ? `<div class="vfx-list">${books.map(loreBaseBookRow).join('')}</div>${readyLine(books)}`
        : emptyState({ icon: 'fa-book', text: 'This chat loads no lorebook.' });
    return add ? list + addBookMarkup(add) : list;
}

const REPLY_KINDS = { normal: 'send', swipe: 'swipe', regenerate: 'regenerate', continue: 'continue', quiet: 'quiet-to-loud', try: 'try' };

function reportLabel(report) {
    const time = new Date(report.madeAt).toLocaleTimeString('en-GB', { hour12: false });
    let where = 'no message';
    if (report.isTry) where = 'no reply';
    else if (report.isUnderWay) where = 'under way';
    else if (report.messageIndex !== null) where = `message #${report.messageIndex}${report.swipeId > 0 ? `, swipe ${report.swipeId + 1}` : ''}`;
    return `${time} · ${REPLY_KINDS[report.type] ?? report.type} · ${where}`;
}

/**
 * The tester's Reply list: this session's reports for the open chat, newest first, each by its time, its kind of
 * reply and the message it went to.
 *
 * @param {Array<object>} reports - LoreBase's loreBaseReports
 * @param {number|null} shownId - The report drawn
 * @returns {string}
 */
export function loreBaseReportOptions(reports, shownId) {
    return reports.map(report => selectOption({ value: report.id, name: reportLabel(report), isSelected: report.id === shownId })).join('');
}

function timeLine({ search = null, pick, slowestReview, total }) {
    const parts = [];
    if (search !== null) parts.push(`search ${formatSeconds(search)}`);
    if (pick !== null) parts.push(`pick ${formatSeconds(pick)}`);
    if (slowestReview !== null) parts.push(`slowest review ${formatSeconds(slowestReview)}`);
    parts.push(`${formatSeconds(total)} in all`);
    return parts.join(', ');
}

const KEYS_STATE_LINES = {
    unmeasured: { icon: 'fa-hourglass-half', text: "Measuring what SillyTavern's keys would send…" },
    waiting: { icon: 'fa-hourglass-half', text: "What SillyTavern's keys would send is measured when no reply is under way." },
    unavailable: { icon: 'fa-key', text: "What SillyTavern's keys would send was not measured for this reply." },
};
// A try's: SillyTavern's keys are measured on a reply's World Info scan, and a try has none.
const TRY_KEYS_LINE = { icon: 'fa-key', text: "A try sends no reply, so what SillyTavern's keys would send is not measured." };

// The reply's tokens against what SillyTavern's keys would send, as SillyTavern's prompt itemization counts them.
function tokenLines(report) {
    if (report.measureFailure) return [{ status: 'warning', text: 'Tokens not counted', name: report.measureFailure }];
    if (!report.tokens) return [{ icon: 'fa-hourglass-half', text: report.isUnderWay ? 'Tokens are counted once the reply ends.' : 'Counting tokens…' }];
    const { tokens, keys } = report;
    const lines = [{ icon: 'fa-paper-plane', text: 'LoreBase sent', name: `${formatCount(tokens.sent)} tokens, from ${formatCount(tokens.pickedWhole)} in the same entries whole` }];
    let keysLine = report.isTry ? TRY_KEYS_LINE : KEYS_STATE_LINES[report.keysState];
    if (keys) keysLine = { icon: 'fa-key', text: "SillyTavern's keys", name: `${formatCount(keys.entries)} selected entries, ${formatCount(keys.tokens)} tokens` };
    lines.push(keysLine);
    const alone = keys ? `SillyTavern alone ${formatCount(keys.worldInfo)} tokens` : '';
    if (tokens.promptWorldInfo !== null) {
        lines.push({ icon: 'fa-book-atlas', text: 'World Info in the prompt', name: [`${formatCount(tokens.promptWorldInfo)} tokens`, alone].filter(Boolean).join('; ') });
    } else if (keys) {
        lines.push({ icon: 'fa-book-atlas', text: 'World Info with SillyTavern alone', name: `${formatCount(keys.worldInfo)} tokens` });
    }
    return lines;
}

// Fast and Cheap [Jev]'s search before Jev: how many entries it kept of how many, or that the entries were few enough
// for Jev to be asked about every one. A search that failed says so in the failure's line instead.
function searchLines({ search, contentCount }) {
    if (!search) return [];
    if (search.poolCount !== null) {
        return [{ icon: 'fa-magnifying-glass', text: 'Searched', name: `Jev was asked about the ${formatCount(search.poolCount)} best of ${formatCount(contentCount)} entries` }];
    }
    if (contentCount > search.seats) return [];
    return [{ icon: 'fa-magnifying-glass', text: 'No search', name: `Jev was asked about all ${formatCount(contentCount)} entries, as a search runs above ${formatCount(search.seats)}` }];
}

// High Accuracy's pick: of its prompt's tokens, those the provider read from its cache, which holds the entry list from
// reply to reply while the selection and the keys stay (§3 and §7.5 of lorebook-multi-vector.md). A pick that failed
// says so in the failure's line instead.
function pickCacheLines({ accuracy, pickTokens, failures }) {
    if (accuracy === 'fast' || failures.some(failure => failure.step === 'pick')) return [];
    const text = 'Pick read from the cache';
    if (!pickTokens || pickTokens.prompt === null) return [{ icon: 'fa-database', text, name: 'not reported by the provider' }];
    if (pickTokens.cached === null) {
        return [{ icon: 'fa-database', text, name: `not reported by the provider, of the pick's ${formatCount(pickTokens.prompt)} prompt tokens` }];
    }
    return [{ icon: 'fa-database', text, name: `${formatCount(pickTokens.cached)} of the pick's ${formatCount(pickTokens.prompt)} prompt tokens` }];
}

function failureLine(failure) {
    return failure.step === 'pick'
        ? { status: 'danger', text: 'The pick failed', name: failure.detail }
        : { status: 'warning', text: 'A review failed', name: `${failure.title}: ${failure.detail}` };
}

const USES_PILLS = {
    most: { text: 'Uses most', status: 'success' },
    some: { text: 'Uses some', status: 'accent' },
    none: { text: 'Uses none', status: 'neutral' },
    // One part or template code: sent whole, with no review (T20's one_part_whole).
    whole: { text: 'Sent whole, not reviewed', status: 'neutral' },
};

function pickPills(pick) {
    const pills = [];
    if (pick.certain === true) pills.push(statusPill({ text: 'Certain', status: 'success' }));
    if (pick.certain === false) pills.push(statusPill({ text: 'Might', status: 'neutral' }));
    pills.push(pick.review ? statusPill(USES_PILLS[pick.review.uses] ?? { name: pick.review.uses }) : statusPill({ text: 'Review failed', status: 'danger' }));
    if (pick.isInPrompt === false) pills.push(statusPill({ text: "Cut by SillyTavern's budget", icon: 'fa-scissors', status: 'warning' }));
    return pills;
}

// A reviewed pick's parts, kept and left out, folded until opened.
function partsRecord(review, index) {
    const keptCount = review.parts.filter(part => part.isSent).length;
    return recordCard({
        icon: 'fa-scissors', text: 'Parts', isCollapsible: true, data: { 'lorebase-parts': index },
        pills: [statusPill({ name: `${formatCount(keptCount)} of ${formatCount(review.parts.length)} kept` })],
        body: resultList({ lines: review.parts.map(part => (part.isSent ? { status: 'success', name: part.text } : { icon: 'fa-minus', name: part.text })) }),
    });
}

function pickRecord(pick, index, report) {
    const counts = report.tokens?.picks[index] ?? null;
    let sends = { status: 'danger', text: 'Review failed', name: pick.failure };
    if (pick.review) {
        const keptCount = pick.review.parts.filter(part => part.isSent).length;
        const tokens = counts ? `, ${formatCount(counts.sent)} of ${formatCount(counts.whole)} tokens` : '';
        const review = pick.review.seconds === null ? 'not reviewed' : `reviewed in ${formatSeconds(pick.review.seconds)}`;
        sends = { text: 'Sends', name: `${formatCount(keptCount)} of ${formatCount(pick.review.parts.length)} parts${tokens}, ${review}` };
    }
    return recordCard({
        icon: 'fa-book', name: pick.title, pills: pickPills(pick),
        body: resultList({ lines: [
            { text: 'Book', name: pick.bookName },
            { text: 'Jev rated it', name: Number.isFinite(pick.yes) ? pick.yes.toFixed(2) : null },
            { text: 'Basis', name: pick.basis },
            { text: 'Why', name: pick.why },
            { text: 'Wants', name: pick.needs },
            sends,
        ] }) + (pick.review ? partsRecord(pick.review, index) : ''),
    });
}

// What a report with no pick says: Fast and Cheap [Jev]'s picks are Jev's, High Accuracy's Luna's.
const NO_PICK_TEXT = {
    jev: 'Jev rated no entry above 0.25 for this reply.',
    luna: 'Luna picked no entry for this reply.',
};

// The selected entries the pick left out, folded until opened; each names its book when the reply read several.
function skippedRecord(report) {
    const bookCount = new Set([...report.picks, ...report.skipped].map(entry => entry.bookName)).size;
    return recordCard({
        icon: 'fa-eye-slash', text: 'Not picked', isCollapsible: true, data: { 'lorebase-skipped': '' },
        pills: [statusPill({ name: formatCount(report.skipped.length) })],
        body: resultList({ lines: report.skipped.map(entry => ({ name: bookCount > 1 ? `${entry.title} · ${entry.bookName}` : entry.title })) }),
    });
}

/**
 * One of the tester's reports in full: what was picked, on Fast and Cheap [Jev] the search before Jev, on High Accuracy
 * the pick's prompt tokens read from the provider's cache, the time, the tokens against what SillyTavern's keys would
 * send, and any failure; each pick with Luna's reasons or Jev's rating,
 * its review and its parts, kept and left out; then the selected entries the pick left out. An empty state when the
 * open chat has no report.
 *
 * @param {object|null} report - LoreBase's report, from loreBaseReports
 * @returns {string}
 */
export function loreBaseReportMarkup(report) {
    if (!report) return emptyState({ icon: 'fa-flask', text: 'No reply in this chat used LoreBase since the page loaded. Send a message, or Try a pick.' });
    const summary = [
        { icon: 'fa-list-check', text: 'Picked', name: `${formatCount(report.picks.length)} of ${formatCount(report.contentCount)} selected entries` },
        ...searchLines(report),
        ...pickCacheLines(report),
        { icon: 'fa-stopwatch', text: 'Time', name: timeLine(report.seconds) },
        ...tokenLines(report),
        ...report.failures.map(failureLine),
    ];
    if (report.unreadItemCount) summary.push({ status: 'warning', text: 'Answer items naming no entry', name: formatCount(report.unreadItemCount) });
    const isPickFailed = report.failures.some(failure => failure.step === 'pick');
    const picks = report.picks.length
        ? report.picks.map((pick, index) => pickRecord(pick, index, report))
        : [emptyState({ icon: 'fa-hand', text: isPickFailed ? 'The pick failed, so no entry went in.' : NO_PICK_TEXT[report.accuracy === 'fast' ? 'jev' : 'luna'] })];
    return stack([
        resultList({ lines: summary }),
        groupTitle({ icon: 'fa-hand-pointer', text: 'Picks' }),
        ...picks,
        report.skipped.length ? skippedRecord(report) : '',
    ]);
}
