/**
 * ============================================================================
 * LOREBASE SELECTION SCREEN, MARKUP
 * ============================================================================
 * The screen where the user picks the entries LoreBase decides (plan §5.2 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md), on
 * GUI-DNA (mvu-helper/devdoc/gui-dna.md): a top-bar shell holding one workbench
 * page, the book, its locks and the filters in a compact card above a split. The
 * start pane holds the categories and the pinned sections; the end pane the
 * entries, each with a tick box for the bulk bar, a button that shows the entry
 * in a dialog of its own, and its own LoreBase toggle.
 * lorebase-selection-screen.js finds each control by its id in SELECTION_IDS and
 * each action by `data-lorebase-action`; a row and its tick box carry the
 * entry's uid, a category row its category, and a pin its section name. Every
 * value is escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
    button,
    checkList,
    controlRow,
    emptyState,
    groupTitle,
    iconButton,
    input,
    listRow,
    notice,
    select,
    selectOption,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { counted } from '../../shared/counted.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import { BADGES, KEY_CHOICES, SIZE_CHOICES, isEngineLike, keyListOf } from './lorebase-selection-core.js';

/** The ids lorebase-selection-screen.js finds the screen's controls by. */
export const SELECTION_IDS = Object.freeze({
    root: 'vectfox_lorebase_selection',
    split: 'vectfox_lorebase_split',
    book: 'vectfox_lorebase_book',
    lockChat: 'vectfox_lorebase_lock_chat',
    lockCharacter: 'vectfox_lorebase_lock_character',
    lockNotice: 'vectfox_lorebase_lock_notice',
    search: 'vectfox_lorebase_search',
    size: 'vectfox_lorebase_size',
    keys: 'vectfox_lorebase_keys',
    badge: 'vectfox_lorebase_badge',
    newness: 'vectfox_lorebase_newness',
    categories: 'vectfox_lorebase_categories',
    pins: 'vectfox_lorebase_pins',
    entries: 'vectfox_lorebase_entries',
    entriesNotice: 'vectfox_lorebase_entries_notice',
    entriesFooter: 'vectfox_lorebase_entries_footer',
    summary: 'vectfox_lorebase_summary',
    entryText: 'vectfox_lorebase_entry_text',
});

/** The newness filter's choices. */
export const NEWNESS_CHOICES = Object.freeze({ all: 'all', newOnly: 'new' });

const ids = SELECTION_IDS;
const action = (name, extra = {}) => ({ 'lorebase-action': name, ...extra });
const formatCount = count => Number(count).toLocaleString('en-US');
const SPLIT_DIVIDER = '<div class="vfx-split-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize the panes"></div>';

/** What each badge says, and its icon. */
export const BADGE_LABELS = Object.freeze({
    [BADGES.templateCode]: { text: 'Template code', icon: 'fa-code' },
    [BADGES.mostlyCode]: { text: 'Mostly code', icon: 'fa-code' },
    [BADGES.enginePrefix]: { text: 'Engine', icon: 'fa-gears' },
    [BADGES.machineKey]: { text: 'Code keys', icon: 'fa-barcode' },
    [BADGES.keyless]: { text: 'No keys', icon: 'fa-key' },
    [BADGES.long]: { text: 'Long', icon: 'fa-ruler-horizontal' },
    [BADGES.noTitle]: { text: 'No title', icon: 'fa-heading' },
});

const KEPT_LABELS = { constant: 'Constant', sticky: 'Sticky', cooldown: 'Cooldown' };

// What each badge and each reason SillyTavern keeps an entry means, as the entry's dialog says it.
const BADGE_NOTES = {
    [BADGES.templateCode]: 'Template code: when Luna picks it, LoreBase sends it whole, never trimmed.',
    [BADGES.mostlyCode]: 'Mostly code: template code fills at least half of it. When Luna picks it, LoreBase sends it whole.',
    [BADGES.enginePrefix]: "Engine: its comment marks it as a game engine's entry, not lore.",
    [BADGES.machineKey]: 'Code keys: every key reads as a code, not a word.',
    [BADGES.keyless]: 'No keys: Luna picks by title, so it needs none.',
    [BADGES.long]: "Long: Luna's review saves the most tokens on an entry this size.",
    [BADGES.noTitle]: 'No title: Luna picks by title alone, so it is never picked.',
};
const KEPT_NOTES = {
    constant: 'Constant: SillyTavern sends it on every reply, so LoreBase cannot decide it.',
    sticky: 'Sticky: SillyTavern would lose its timer on an entry LoreBase sends, so LoreBase cannot decide it.',
    cooldown: 'Cooldown: SillyTavern would lose its timer on an entry LoreBase sends, so LoreBase cannot decide it.',
};

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The book dropdown's options: the open chat's books first, each with its selected count.
 * @param {Array<{bookName: string, isActive: boolean, selectedCount: number}>} choices - From bookChoices
 * @param {string} bookName - The book shown
 * @returns {string[]}
 */
export function bookOptions(choices, bookName) {
    return choices.map(choice => selectOption({
        value: choice.bookName,
        name: `${choice.bookName}${choice.isActive ? ' (this chat)' : ''}${choice.selectedCount ? `, ${choice.selectedCount} selected` : ''}`,
        isSelected: choice.bookName === bookName,
    }));
}

function controlsCard(choices, bookName) {
    const sizeNames = { 0: 'Any size', 300: '300+ tokens', 1000: '1,000+ tokens', 3000: '3,000+ tokens' };
    return `<section class="vfx-card">
        <div class="vfx-card-body vfx-stack">
            ${controlRow([select({ id: ids.book, title: 'Lorebook', options: bookOptions(choices, bookName) })])}
            <div class="vfx-grid">
                ${switchRow({ id: ids.lockChat, title: 'Lock to this chat', description: "LoreBase decides this book's selected entries in this chat." })}
                ${switchRow({ id: ids.lockCharacter, title: 'Lock to this character', description: 'The same in every chat with this character.' })}
            </div>
            <div id="${ids.lockNotice}"></div>
            ${controlRow([
                input({ id: ids.search, placeholder: 'Search titles, keys and text', title: 'Search the entries' }),
                select({ id: ids.size, title: 'Size', options: SIZE_CHOICES.map(size => selectOption({ value: String(size), text: sizeNames[size] })) }),
                select({ id: ids.keys, title: 'Keys', options: [
                    selectOption({ value: KEY_CHOICES.any, text: 'Any keys' }),
                    selectOption({ value: KEY_CHOICES.withKeys, text: 'With keys' }),
                    selectOption({ value: KEY_CHOICES.withoutKeys, text: 'Without keys' }),
                ] }),
                select({ id: ids.badge, title: 'Badge', options: [
                    selectOption({ value: '', text: 'Any badge' }),
                    ...Object.values(BADGES).map(badge => selectOption({ value: badge, text: BADGE_LABELS[badge].text })),
                ] }),
                select({ id: ids.newness, title: 'New entries', options: [
                    selectOption({ value: NEWNESS_CHOICES.all, text: 'All entries' }),
                    selectOption({ value: NEWNESS_CHOICES.newOnly, text: 'New since last opened' }),
                ] }),
            ])}
        </div>
    </section>`;
}

function categoriesPane() {
    return `<section class="vfx-card is-pane">
        ${cardHeader({ icon: 'fa-folder-tree', title: 'Categories', description: 'Turn LoreBase on or off for a whole category.', isCollapsible: false })}
        <div class="vfx-card-body vfx-stack">
            <div id="${ids.categories}" class="vfx-list"></div>
            ${groupTitle({ icon: 'fa-thumbtack', text: 'Pinned sections' })}
            <p class="vfx-hint">A pinned section's parts are kept whenever their entry is picked.</p>
            <div id="${ids.pins}"></div>
        </div>
    </section>`;
}

/**
 * The bulk bar: a row that ticks and a row that acts on the ticked. Untick all with Invert, and Turn on with Turn off,
 * each sit in a row of their own inside it, which wraps to the next line whole, so on a phone neither pair splits.
 */
function bulkBar() {
    const bulkButton = (name, text, icon) => button({ text, icon, isDisabled: true, data: action(name) });
    return controlRow([
        button({ text: 'Tick all matching', icon: 'fa-check-double', data: action('tick-all') }),
        controlRow([
            button({ text: 'Untick all', icon: 'fa-square', data: action('untick-all') }),
            button({ text: 'Invert', icon: 'fa-right-left', data: action('invert') }),
        ]),
    ]) + controlRow([
        statusPill({ name: '0 ticked', data: { 'lorebase-ticked-count': '' } }),
        controlRow([bulkButton('turn-on', 'Turn on', 'fa-toggle-on'), bulkButton('turn-off', 'Turn off', 'fa-toggle-off')]),
    ]);
}

function entriesPane() {
    return `<section class="vfx-card is-pane">
        ${cardHeader({ icon: 'fa-list-check', title: 'Entries', description: 'Tick entries to turn LoreBase on or off for several at once.', isCollapsible: false })}
        <div class="vfx-card-body vfx-stack">
            ${bulkBar()}
            <div id="${ids.entriesNotice}"></div>
            <div id="${ids.entries}" class="vfx-list">${emptyState({ icon: 'fa-spinner', text: 'Loading the lorebook…' })}</div>
            <div id="${ids.entriesFooter}"></div>
            <p id="${ids.summary}" class="vfx-hint"></p>
        </div>
    </section>`;
}

/**
 * The whole screen for a book.
 * @param {{choices: Array<{bookName: string, isActive: boolean, selectedCount: number}>, bookName: string}} view
 * @returns {string}
 */
export function selectionScreenMarkup({ choices, bookName }) {
    const status = statusPill({ name: '', data: { 'lorebase-selected-count': '' } });
    return `<div id="${ids.root}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('LoreBase entries')}</div></nav>`
        + '<main class="vfx-main"><div class="vfx-page is-workbench">'
        + pageHeader({ icon: 'fa-book-open', eyebrow: 'WorldInfo / LoreBase', title: 'Choose entries', subtitle: "Choose the entries LoreBase decides. Every other entry stays SillyTavern's.", status })
        + controlsCard(choices, bookName)
        + `<div id="${ids.split}" class="vfx-split">`
        + categoriesPane()
        + SPLIT_DIVIDER
        + entriesPane()
        + '</div></div></main></div>';
}

/** The screen when SillyTavern has no lorebook to choose. */
export function noLorebookMarkup() {
    return emptyState({ icon: 'fa-book', text: 'SillyTavern has no lorebook yet. Make one in World Info first.' });
}

/** The entries pane when the book could not be read. */
export function bookFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'This lorebook could not be read', name: reason });
}

/** Why a lock switch cannot act now, or '' when both can. */
export function lockNoticeMarkup({ hasChat, hasCharacter }) {
    if (!hasChat) return notice({ status: 'info', text: 'Open a chat to lock this book to it or to its character.' });
    if (!hasCharacter) return notice({ status: 'info', text: 'A group chat has no one character to lock this book to.' });
    return '';
}

// ── Categories and pins ───────────────────────────────────────────────────────────────────────────────

const CATEGORY_STATES = {
    on: { text: 'All on', status: 'success' },
    mixed: { text: 'Some on', status: 'accent' },
    off: { text: 'Off', status: 'neutral' },
};

/**
 * The categories pane's rows: every category first, then each category with its state, the button that shows only
 * its entries, and its LoreBase toggle, which cannot act on a category whose entries are all engine-like or kept by
 * SillyTavern.
 * @param {Array<{category: string, rowCount: number, selectedCount: number, bulkCount: number, state: string}>} categories - From categoryList
 * @param {{shownCategory: string|null, entryCount: number}} view - The category the list shows, null for all
 * @returns {string}
 */
export function categoryRowsMarkup(categories, { shownCategory, entryCount }) {
    const all = listRow({
        icon: 'fa-layer-group',
        text: 'All categories',
        sub: { name: counted(entryCount, 'entry', 'entries') },
        actions: [iconButton({ icon: 'fa-filter', title: 'Show every entry', isPressed: shownCategory === null, data: action('show-all-categories') })],
    });
    const rows = categories.map(({ category, rowCount, selectedCount, bulkCount, state }) => listRow({
        icon: 'fa-folder',
        ...(category ? { name: category } : { text: 'No category' }),
        sub: { name: `${counted(rowCount, 'entry', 'entries')}, ${selectedCount} on` },
        pills: [statusPill({ text: CATEGORY_STATES[state].text, status: CATEGORY_STATES[state].status })],
        actions: [
            iconButton({ icon: 'fa-filter', title: 'Show only this category', isPressed: shownCategory === category, data: action('show-category', { 'lorebase-category': category }) }),
            iconButton({ icon: 'fa-wand-magic-sparkles', title: 'LoreBase decides this category', isPressed: state === 'on', isDisabled: bulkCount === 0, data: action('toggle-category', { 'lorebase-category': category }) }),
        ],
    }));
    return [all, ...rows].join('');
}

/**
 * The pinned sections: the section names of the entries the pick reads, each with a check box.
 * @param {Array<{name: string, entryCount: number, isPinned: boolean}>} sections - From pinnableSections
 * @returns {string}
 */
export function pinsMarkup(sections) {
    if (!sections.length) return '<p class="vfx-hint">Select entries with sections to pin one.</p>';
    return checkList({ items: sections.map(({ name, entryCount, isPinned }) => ({
        name: `${name} (${counted(entryCount, 'entry', 'entries')})`, isChecked: isPinned, data: { 'lorebase-pin': name },
    })) });
}

// ── Entries ───────────────────────────────────────────────────────────────────────────────────────────

function entryPills(row) {
    const pills = [];
    if (row.keptBySillyTavern) pills.push(statusPill({ text: KEPT_LABELS[row.keptBySillyTavern], status: 'warning', icon: 'fa-lock' }));
    if (row.isDisabled) pills.push(statusPill({ text: 'Disabled', icon: 'fa-power-off' }));
    if (row.isNew) pills.push(statusPill({ text: 'New', status: 'accent', icon: 'fa-star' }));
    const engineLike = isEngineLike(row);
    for (const badge of row.badges) {
        pills.push(statusPill({ text: BADGE_LABELS[badge].text, status: engineLike && badge !== BADGES.templateCode ? 'warning' : 'neutral', icon: BADGE_LABELS[badge].icon }));
    }
    return pills;
}

/**
 * One entry: its tick box, then its row (title, category, size and keys, its pills) with the button that shows the
 * entry and its LoreBase toggle. An entry SillyTavern keeps cannot be turned on, only off when it was selected before
 * it became one.
 * @param {import('./lorebase-selection-core.js').SelectionRow} row
 * @param {{isTicked: boolean}} view
 * @returns {string}
 */
export function entryRowMarkup(row, { isTicked }) {
    const canToggle = !row.keptBySillyTavern || row.isSelected;
    const body = listRow({
        icon: 'fa-file-lines',
        name: row.title,
        sub: [
            row.category ? { name: row.category } : null,
            { name: `${formatCount(row.tokens)} tokens, ${counted(row.keyCount, 'key')}` },
        ],
        pills: entryPills(row),
        actions: [
            iconButton({ icon: 'fa-eye', title: 'Show this entry', data: action('show-entry', { 'lorebase-uid': row.uid }) }),
            iconButton({
                icon: 'fa-wand-magic-sparkles',
                title: row.keptBySillyTavern ? 'SillyTavern keeps this entry' : 'LoreBase decides this entry',
                isPressed: row.isSelected,
                isDisabled: !canToggle,
                data: action('toggle-entry', { 'lorebase-uid': row.uid }),
            }),
        ],
        data: { 'lorebase-uid': row.uid },
    });
    return `<div class="vfx-pick-row" data-lorebase-entry="${escape(row.uid)}">`
        + '<label class="vfx-pick-check" title="Tick">'
        + `<input type="checkbox" class="vfx-check" aria-label="Tick ${escape(row.title)}"${isTicked ? ' checked' : ''}${row.keptBySillyTavern ? ' disabled' : ''} data-lorebase-tick="${escape(row.uid)}">`
        + '</label>'
        + `<div class="vfx-pick-body">${body}</div>`
        + '</div>';
}

/**
 * The entry's dialog, its lines (sillytavern/popup-core.js): its title, category, keys and size; then why SillyTavern
 * keeps it or never sends it, what each badge means, and, for an engine-like entry LoreBase can decide, that bulk
 * selection skips it.
 * @param {import('./lorebase-selection-core.js').SelectionRow} row
 * @param {{key?: string[], keysecondary?: string[]}} entry - The book's entry, as loadWorldInfo returns it
 * @returns {object[]}
 */
export function entryDetailLines(row, entry) {
    const keys = keyListOf(entry.key);
    const secondaryKeys = keyListOf(entry.keysecondary);
    return [
        { icon: 'fa-file-lines', name: row.title },
        row.category ? { text: 'Category:', name: row.category } : null,
        keys.length ? { text: 'Keys:', name: keys.join(', ') } : null,
        secondaryKeys.length ? { text: 'Secondary keys:', name: secondaryKeys.join(', ') } : null,
        { text: 'Tokens:', name: formatCount(row.tokens) },
        row.keptBySillyTavern ? { icon: 'fa-lock', text: KEPT_NOTES[row.keptBySillyTavern] } : null,
        row.keptBySillyTavern && row.isSelected ? { icon: 'fa-lock', text: 'It was selected before, but SillyTavern still decides it.' } : null,
        row.isDisabled ? { icon: 'fa-power-off', text: 'Disabled in SillyTavern: it is never sent, and Luna never picks it.' } : null,
        ...row.badges.map(badge => ({ icon: BADGE_LABELS[badge].icon, text: BADGE_NOTES[badge] })),
        isEngineLike(row) && !row.keptBySillyTavern
            ? { icon: 'fa-circle-info', text: "Tick all matching and a category's toggle skip it: turn it on with its own toggle." }
            : null,
    ].filter(Boolean);
}

/**
 * The entry's text in its dialog, a box the screen makes read-only.
 * @param {{content?: string}} entry
 * @returns {string}
 */
export function entryTextMarkup(entry) {
    return textarea({ id: ids.entryText, value: String(entry.content ?? ''), rows: 16, title: 'Entry text' });
}

/** The entries pane when no entry matches the filters. */
export function noMatchingEntriesMarkup() {
    return emptyState({ icon: 'fa-filter-circle-xmark', text: 'No entry matches these filters.' });
}

/** The note shown while the list holds an entry with no title. */
export function noTitleNoticeMarkup() {
    return notice({ status: 'info', text: 'Luna picks by title alone, so an entry with no title is never picked.' });
}

/**
 * Under the list: how many rows it shows of those that match, and the button that shows more.
 * @param {{shownCount: number, matchCount: number, hasMore: boolean}} view
 * @returns {string}
 */
export function entriesFooterMarkup({ shownCount, matchCount, hasMore }) {
    if (matchCount === 0) return '';
    return controlRow([
        `<p class="vfx-hint">${escape(`Showing ${formatCount(shownCount)} of ${counted(matchCount, 'entry', 'entries')}.`)}</p>`,
        hasMore ? button({ text: 'Show more', icon: 'fa-angles-down', data: action('show-more') }) : '',
    ]);
}

/**
 * The footer line: how many titles the pick reads from the book, and what they add to every pick.
 * @param {{entryCount: number, titleTokens: number}} footer - From selectionFooter
 * @returns {string}
 */
export function summaryText({ entryCount, titleTokens }) {
    if (!entryCount) return 'LoreBase decides no entry of this book: SillyTavern\'s keys decide them all.';
    return `Luna reads ${counted(entryCount, 'title')} from this book, about ${formatCount(titleTokens)} tokens on every pick.`;
}
