/**
 * ============================================================================
 * WORLDINFO PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's WorldInfo page on GUI-DNA: LoreBase's switch, its books
 * for the open chat, with the door to its selection screen, LoreBase's model
 * with its Accuracy, and its tester. Every control keeps the id
 * settings-panel.js, lorebase-books-card.js, lorebase-tester-card.js or
 * connection-rows.js wires it by. The LoreBase book list and the tester's
 * reports are built here as well. Pure: builds strings.
 * ============================================================================
 */

import { chatProviderOptions, connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';
import {
    button, controlRow, detail, emptyState, field, fieldLabel, groupTitle, hint, iconButton, listRow, notice, recordCard, resultList,
    select, selectOption, stack, statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { buttonWithId, cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const formatCount = count => Number(count).toLocaleString('en-US');
const formatSeconds = seconds => `${Number(seconds).toFixed(1)} s`;

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
            <div id="VectFox_lorebase_off_notice">${notice({ status: 'info', text: "Choose entries and set LoreBase's model, then turn on Use LoreBase: it asks before writing their keys and vectors." })}</div>
            <div id="VectFox_lorebase_books" aria-live="polite"></div>
            ${controlRow([button({ text: 'Choose entries', icon: 'fa-list-check', kind: 'primary', data: { 'lorebase-choose': '' } })])}
            ${hint({ text: "Choose any lorebook's entries for LoreBase, and lock the book to this chat or character." })}
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

// LoreBase's model card (plan §5.6, and §2 of lorebook-multi-vector.md). Accuracy comes first, since it decides what
// each model does: LoreBase's own model writes each entry's keys on every choice (D17) and, on High Accuracy, also
// picks and reviews (D6); on Fast and Cheap [Jev], the default, Jev picks, on a profile of its own (D16).
// connection-rows.js shows the title of the own model's role and Jev's group, which shows on Fast and Cheap [Jev] only.
// The option values are FAST_AND_CHEAP and High Accuracy's in lorebase-reply-core.js.
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
            ${field([
                fieldLabel({ text: 'Accuracy', forId: 'VectFox_lorebase_accuracy' }),
                accuracy,
                hint({ text: 'Fast and Cheap [Jev] is quickest and cheapest. High Accuracy sends only the parts needed.' }),
                detail({ text: 'Fast and Cheap [Jev] asks Jev, a decisions model: it answers in under a second for a fraction of the cost, and sends the entries it rates above 0.25 whole. High Accuracy has LoreBase\'s own model pick the entries, then reviews each picked entry of more than one part at low reasoning effort and sends only the parts the reply needs. On both, LoreBase\'s own model writes each entry\'s keys when it is turned on, since the pick and Jev\'s questions read them.' }),
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
            </div>
        </div>
    </section>`;
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

function loreBaseBookRow({ bookName, selectedCount, isLockedToChat, isLockedToCharacter, keyCount, vectorCount }) {
    const locks = [isLockedToChat ? LOCK_PILLS.chat : '', isLockedToCharacter ? LOCK_PILLS.character : ''].filter(Boolean);
    return listRow({
        icon: 'fa-book',
        name: bookName,
        sub: selectedCount ? { name: selectedLine(selectedCount, keyCount, vectorCount) } : { text: 'Nothing selected' },
        pills: locks.length ? locks : [LOCK_PILLS.none],
        actions: [iconButton({ icon: 'fa-list-check', title: 'Choose entries', data: { 'lorebase-choose': bookName } })],
    });
}

/**
 * The LoreBase books card's list for the open chat: each book SillyTavern loads here, how many entries are selected
 * in it and, once read, how many of those have keys and vectors, and whether it is locked to this chat or its
 * character, where LoreBase decides them (D11).
 *
 * @param {{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean, keyCount?: number, vectorCount?: number}>}} status - LoreBase's chatBookLocks, with
 *   storedCountsOfBooks's counts
 * @returns {string}
 */
export function loreBaseBooksMarkup({ hasChat, books }) {
    if (!hasChat) return emptyState({ icon: 'fa-comments', text: 'Open a chat to see the lorebooks it loads.' });
    if (!books.length) return emptyState({ icon: 'fa-book', text: 'This chat loads no lorebook.' });
    return `<div class="vfx-list">${books.map(loreBaseBookRow).join('')}</div>`;
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

function timeLine({ pick, slowestReview, total }) {
    const parts = [];
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
 * One of the tester's reports in full: what was picked, the time, the tokens against what SillyTavern's keys would
 * send, and any failure; each pick with Luna's reasons, its review and its parts, kept and left out; then the selected
 * entries the pick left out. An empty state when the open chat has no report.
 *
 * @param {object|null} report - LoreBase's report, from loreBaseReports
 * @returns {string}
 */
export function loreBaseReportMarkup(report) {
    if (!report) return emptyState({ icon: 'fa-flask', text: 'No reply in this chat used LoreBase since the page loaded. Send a message, or Try a pick.' });
    const summary = [
        { icon: 'fa-list-check', text: 'Picked', name: `${formatCount(report.picks.length)} of ${formatCount(report.contentCount)} selected entries` },
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
