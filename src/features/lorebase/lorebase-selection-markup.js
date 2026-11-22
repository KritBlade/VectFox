/**
 * ============================================================================
 * LOREBASE SELECTION SCREEN, MARKUP
 * ============================================================================
 * The screen where the user picks the entries LoreBase decides (plan §5.2 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md), on
 * GUI-DNA (mvu-helper/devdoc/gui-dna.md): a top-bar shell holding one workbench
 * page, the book, the selection of it shown (the book's selections in a list,
 * with New selection, Rename and Delete), that selection's locks and the
 * filters in a compact card above a split. The
 * start pane holds the categories and the pinned sections; the end pane the
 * entries, each with a tick box for the bulk bar, a button that shows the entry
 * in a dialog of its own, a selected entry's button that edits its LoreBase
 * keys in another, and its own LoreBase toggle.
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
    stack,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { counted } from '../../shared/counted.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import { POOL_SEATS } from './lorebase-jev-core.js';
import { BADGES, READINESS_CHOICES, SIZE_CHOICES, canToggleRow, isDecidedRow, isEngineLike, keyListOf } from './lorebase-selection-core.js';

/** The ids lorebase-selection-screen.js finds the screen's controls by. */
export const SELECTION_IDS = Object.freeze({
    root: 'vectfox_lorebase_selection',
    split: 'vectfox_lorebase_split',
    book: 'vectfox_lorebase_book',
    selectionList: 'vectfox_lorebase_selection_list',
    renameSelection: 'vectfox_lorebase_rename_selection',
    lockChat: 'vectfox_lorebase_lock_chat',
    lockCharacter: 'vectfox_lorebase_lock_character',
    lockNotice: 'vectfox_lorebase_lock_notice',
    search: 'vectfox_lorebase_search',
    size: 'vectfox_lorebase_size',
    readiness: 'vectfox_lorebase_readiness',
    badge: 'vectfox_lorebase_badge',
    newness: 'vectfox_lorebase_newness',
    categories: 'vectfox_lorebase_categories',
    pins: 'vectfox_lorebase_pins',
    entries: 'vectfox_lorebase_entries',
    entriesNotice: 'vectfox_lorebase_entries_notice',
    entriesFooter: 'vectfox_lorebase_entries_footer',
    summary: 'vectfox_lorebase_summary',
    entryText: 'vectfox_lorebase_entry_text',
    keysEditor: 'vectfox_lorebase_keys_editor',
    keysEditorStatus: 'vectfox_lorebase_keys_editor_status',
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

const UNDECIDABLE_LABELS = {
    constant: 'Constant', sticky: 'Sticky', cooldown: 'Cooldown', activate_decorator: '@@activate', dont_activate_decorator: '@@dont_activate', empty: 'Empty',
};

// What each badge and each reason LoreBase cannot decide an entry means, as the entry's dialog says it.
const BADGE_NOTES = {
    [BADGES.templateCode]: 'Template code: when it is picked, LoreBase sends it whole, never trimmed.',
    [BADGES.mostlyCode]: 'Mostly code: template code fills at least half of it. When it is picked, LoreBase sends it whole.',
    [BADGES.enginePrefix]: "Engine: its comment marks it as a game engine's entry, not lore.",
    [BADGES.machineKey]: 'Code keys: every key reads as a code, not a word.',
    [BADGES.keyless]: 'No keys: LoreBase needs none, as it reads the title and the keys its own model writes.',
    [BADGES.long]: 'Long: on High Accuracy, the review saves the most tokens on an entry this size. Fast and Cheap [Jev] sends it whole, within the lore budget.',
    [BADGES.noTitle]: 'No title: the pick sees it only as "entry" and its UID, with its keys. Give it a title in World Info.',
};
const UNDECIDABLE_NOTES = {
    constant: 'Constant: SillyTavern sends it on every reply, so LoreBase cannot decide it.',
    sticky: 'Sticky: SillyTavern would lose its timer on an entry LoreBase sends, so LoreBase cannot decide it.',
    cooldown: 'Cooldown: SillyTavern would lose its timer on an entry LoreBase sends, so LoreBase cannot decide it.',
    activate_decorator: '@@activate: this line at its top has SillyTavern send it on every reply, so LoreBase cannot decide it.',
    dont_activate_decorator: '@@dont_activate: this line at its top keeps SillyTavern from ever sending it, so LoreBase cannot decide it.',
    empty: 'Empty: it has no text, so LoreBase has nothing to key, pick or send, and cannot decide it.',
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

/**
 * The selection list's options: each of the book's selections by its name, the one in use in the open chat saying so.
 * @param {Array<{id: string, name: string}>} selections - The book's selections
 * @param {{selectionId: string, inUseId: string|null}} shown - The selection shown, and the one in use here
 * @returns {string[]}
 */
export function selectionOptions(selections, { selectionId, inUseId }) {
    return selections.map(selection => selectOption({
        value: selection.id,
        name: `${selection.name}${selection.id === inUseId ? ' (in use here)' : ''}`,
        isSelected: selection.id === selectionId,
    }));
}

function controlsCard(choices, bookName) {
    const sizeNames = { 0: 'Any size', 300: '300+ tokens', 1000: '1,000+ tokens', 3000: '3,000+ tokens' };
    return `<section class="vfx-card">
        <div class="vfx-card-body vfx-stack">
            ${controlRow([select({ id: ids.book, title: 'Lorebook', options: bookOptions(choices, bookName) })])}
            ${controlRow([
                select({ id: ids.selectionList, title: 'Selection' }),
                button({ text: 'New selection', icon: 'fa-plus', data: action('new-selection') }),
                button({ text: 'Rename', icon: 'fa-pen', data: action('rename-selection') }),
                button({ text: 'Delete', icon: 'fa-trash-can', kind: 'danger', data: action('delete-selection') }),
            ])}
            <div class="vfx-grid">
                ${switchRow({ id: ids.lockChat, title: 'Lock to this chat', description: "LoreBase decides this selection's entries in this chat, not the book's others." })}
                ${switchRow({ id: ids.lockCharacter, title: 'Lock to this character', description: 'The same in every chat with this character, unless a chat locks another selection.' })}
            </div>
            <div id="${ids.lockNotice}"></div>
            ${controlRow([
                input({ id: ids.search, placeholder: 'Search titles, keys and text', title: 'Search the entries' }),
                select({ id: ids.size, title: 'Size', options: SIZE_CHOICES.map(size => selectOption({ value: String(size), text: sizeNames[size] })) }),
                select({ id: ids.readiness, title: 'Keys and vectors', options: [
                    selectOption({ value: READINESS_CHOICES.any, text: 'Ready or not' }),
                    selectOption({ value: READINESS_CHOICES.ready, text: 'Ready' }),
                    selectOption({ value: READINESS_CHOICES.notReady, text: 'Without keys or vectors' }),
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
        bulkButton('regenerate-keys', 'Regenerate keys', 'fa-key'),
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

/**
 * Rename's form: the selection's name, in a box.
 * @param {string} currentName
 * @returns {string}
 */
export function renameSelectionFormMarkup(currentName) {
    return stack([`<div class="vfx-field">${input({ id: ids.renameSelection, value: currentName, title: 'Name' })}</div>`]);
}

/**
 * The confirm of deleting one selection, Choose entries' Delete and the WorldInfo row's trash on one of several
 * selections alike (deleteLoreSelectionAfterConfirm): what goes with it, and what the chats using it do then.
 * @param {string} selectionName
 * @returns {object[]} confirmPopup's lines
 */
export function deleteSelectionLines(selectionName) {
    return [
        { text: 'Delete this selection?' },
        { text: 'Selection:', name: selectionName },
        { text: 'Its selected entries, pinned sections and locks go, with the vectors of entries no other selection holds.' },
        { text: 'Where it was in use, LoreBase uses the selection locked to the character instead, or with none, the lorebook fires by its keys there.' },
    ];
}

/** The screen when SillyTavern has no lorebook to choose. */
export function noLorebookMarkup() {
    return emptyState({ icon: 'fa-book', text: 'SillyTavern has no lorebook yet. Make one in World Info first.' });
}

/** The entries pane when the book could not be read. */
export function bookFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'This lorebook could not be read', name: reason });
}

/**
 * Why a lock switch cannot act now, or which character Lock to this character means in a group chat, the member whose
 * lorebook this is; '' in a chat of one character.
 * @param {{hasChat: boolean, hasCharacter: boolean, groupMemberName?: string}} where
 * @returns {string}
 */
export function lockNoticeMarkup({ hasChat, hasCharacter, groupMemberName = '' }) {
    if (!hasChat) return notice({ status: 'info', text: 'Open a chat to lock this selection to it or to its character.' });
    if (!hasCharacter) return notice({ status: 'info', text: 'In this group chat no one member loads this lorebook, so lock this selection to the chat.' });
    if (groupMemberName) {
        return notice({
            status: 'info',
            parts: [{ text: 'In this group chat this is the lorebook of ' }, { name: groupMemberName }, { text: ': Lock to this character locks it to that member, in every chat with that member.' }],
        });
    }
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
    if (row.undecidableReason) pills.push(statusPill({ text: UNDECIDABLE_LABELS[row.undecidableReason], status: 'warning', icon: 'fa-lock' }));
    if (row.isDisabled) pills.push(statusPill({ text: 'Disabled', icon: 'fa-power-off' }));
    if (row.isNew) pills.push(statusPill({ text: 'New', status: 'accent', icon: 'fa-star' }));
    const engineLike = isEngineLike(row);
    for (const badge of row.badges) {
        pills.push(statusPill({ text: BADGE_LABELS[badge].text, status: engineLike && badge !== BADGES.templateCode ? 'warning' : 'neutral', icon: BADGE_LABELS[badge].icon }));
    }
    return pills;
}

// A selected entry's keys and vectors (D17, §7.3 of lorebook-multi-vector.md): its keys or its vectors being written or
// failed, what it still lacks, or keys written as none when the model found nothing in the entry to key.
const READINESS_PILLS = {
    writingKeys: { text: 'Writing keys', status: 'accent', icon: 'fa-pen-nib' },
    vectorizing: { text: 'Vectorizing', status: 'accent', icon: 'fa-vector-square' },
    keysFailed: { text: 'Keys failed', status: 'danger', icon: 'fa-triangle-exclamation' },
    vectorsFailed: { text: 'Vectors failed', status: 'danger', icon: 'fa-triangle-exclamation' },
    missingBoth: { text: 'No keys or vectors yet', status: 'warning', icon: 'fa-key' },
    missingKeys: { text: 'No keys yet', status: 'warning', icon: 'fa-key' },
    missingVectors: { text: 'No vectors yet', status: 'warning', icon: 'fa-vector-square' },
    otherModel: { text: 'Vectors from another model', status: 'warning', icon: 'fa-vector-square' },
    noKeysFound: { text: 'No keys found', status: 'neutral', icon: 'fa-key' },
};
// Room for a failure's own text on the row.
const FAILURE_CHARACTERS = 200;

// The pill for a selected entry's state, or null for a ready entry with keys, whose keys show instead.
function readinessPill(readiness) {
    switch (readiness?.status) {
        case 'writing-keys': return READINESS_PILLS.writingKeys;
        case 'vectorizing': return READINESS_PILLS.vectorizing;
        case 'keys-failed': return READINESS_PILLS.keysFailed;
        case 'vectors-failed': return READINESS_PILLS.vectorsFailed;
        case 'missing':
            if (readiness.lacksKeys && readiness.lacksVectors) return READINESS_PILLS.missingBoth;
            if (readiness.lacksKeys) return READINESS_PILLS.missingKeys;
            return readiness.isOtherModel ? READINESS_PILLS.otherModel : READINESS_PILLS.missingVectors;
        case 'ready': return readiness.keys.length ? null : READINESS_PILLS.noKeysFound;
        default: return null;
    }
}

// What failed for a selected entry, with the reason, or null.
function failureLine(readiness) {
    if (readiness?.status === 'keys-failed') return { text: 'Keys failed', name: String(readiness.detail ?? '').slice(0, FAILURE_CHARACTERS) };
    if (readiness?.status === 'vectors-failed') return { text: 'Vectors failed', name: String(readiness.detail ?? '').slice(0, FAILURE_CHARACTERS) };
    return null;
}

/**
 * One entry: its tick box, then its row (title, category, size and keys, the keys LoreBase's model wrote for it when
 * selected, its pills, where its keys and vectors stand among them) with the button that shows the entry and its
 * LoreBase toggle. An entry LoreBase cannot decide (SillyTavern keeps it, or it is empty) cannot be turned on, only off
 * when it was selected before it became one.
 * @param {import('./lorebase-selection-core.js').SelectionRow} row
 * @param {{isTicked: boolean, readiness?: ReturnType<typeof import('./lorebase-selection-core.js').entryReadiness>|null}}
 *   view - readiness is the entry's state, for a selected entry LoreBase decides only
 * @returns {string}
 */
export function entryRowMarkup(row, { isTicked, readiness = null }) {
    const canToggle = canToggleRow(row);
    const pill = readinessPill(readiness);
    const body = listRow({
        icon: 'fa-file-lines',
        name: row.title,
        sub: [
            row.category ? { name: row.category } : null,
            { name: `${formatCount(row.tokens)} tokens, ${counted(row.keyCount, 'key')}` },
            readiness?.keys?.length ? { text: 'LoreBase keys', name: readiness.keys.join(', ') } : null,
            failureLine(readiness),
        ],
        pills: pill ? [...entryPills(row), statusPill(pill)] : entryPills(row),
        actions: [
            iconButton({ icon: 'fa-eye', title: 'Show this entry', data: action('show-entry', { 'lorebase-uid': row.uid }) }),
            // An entry LoreBase decides has keys to edit; not while its keys are being written.
            isDecidedRow(row) ? iconButton({
                icon: 'fa-pen',
                title: 'Edit LoreBase keys',
                isDisabled: readiness?.status === 'writing-keys',
                data: action('edit-keys', { 'lorebase-uid': row.uid }),
            }) : '',
            iconButton({
                icon: 'fa-wand-magic-sparkles',
                title: row.undecidableReason ? 'LoreBase cannot decide this entry' : 'LoreBase decides this entry',
                isPressed: row.isSelected,
                isDisabled: !canToggle,
                data: action('toggle-entry', { 'lorebase-uid': row.uid }),
            }),
        ],
        data: { 'lorebase-uid': row.uid },
    });
    return `<div class="vfx-pick-row" data-lorebase-entry="${escape(row.uid)}">`
        + '<label class="vfx-pick-check" title="Tick">'
        + `<input type="checkbox" class="vfx-check" aria-label="Tick ${escape(row.title)}"${isTicked ? ' checked' : ''}${row.undecidableReason ? ' disabled' : ''} data-lorebase-tick="${escape(row.uid)}">`
        + '</label>'
        + `<div class="vfx-pick-body">${body}</div>`
        + '</div>';
}

/**
 * The entry's dialog, its lines (sillytavern/popup-core.js): its title, category, keys and size; then why LoreBase
 * cannot decide it or SillyTavern never sends it, what each badge means, and, for an engine-like entry LoreBase can decide, that bulk
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
        row.undecidableReason ? { icon: 'fa-lock', text: UNDECIDABLE_NOTES[row.undecidableReason] } : null,
        row.undecidableReason && row.isSelected ? { icon: 'fa-lock', text: 'It was selected before, but SillyTavern still decides it.' } : null,
        row.isDisabled ? { icon: 'fa-power-off', text: 'Disabled in SillyTavern: it is never sent, and LoreBase never picks it.' } : null,
        ...row.badges.map(badge => ({ icon: BADGE_LABELS[badge].icon, text: BADGE_NOTES[badge] })),
        isEngineLike(row) && !row.undecidableReason
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

/**
 * The lines of an entry's keys dialog: the entry, then how its keys are read and kept.
 * @param {string} title
 * @returns {object[]}
 */
export function keysEditorLines(title) {
    return [
        { icon: 'fa-key', text: 'LoreBase keys:', name: title },
        { text: "One key per line. The pick reads them beside the entry's title, and on Fast and Cheap [Jev], Jev's question names them." },
        { text: "Regenerate asks LoreBase's model for new ones and puts them in the box; nothing is kept until Save keys." },
    ];
}

/**
 * The form of an entry's keys dialog: its keys, one per line, Regenerate, and the line that says how Regenerate went.
 * @param {string[]} keys - The entry's keys now, or none
 * @returns {string}
 */
export function keysEditorMarkup(keys) {
    return stack([
        textarea({ id: ids.keysEditor, value: keys.join('\n'), rows: 12, title: 'LoreBase keys, one per line' }),
        controlRow([button({ text: 'Regenerate', icon: 'fa-rotate', data: { 'lorebase-keys-regenerate': '' } })]),
        `<p id="${ids.keysEditorStatus}" class="vfx-hint" aria-live="polite"></p>`,
    ]);
}

/** The entries pane when no entry matches the filters. */
export function noMatchingEntriesMarkup() {
    return emptyState({ icon: 'fa-filter-circle-xmark', text: 'No entry matches these filters.' });
}

/** The note shown while the list holds an entry with no title. */
export function noTitleNoticeMarkup() {
    return notice({ status: 'info', text: 'The pick sees an entry with no title only as "entry" and its UID, with its keys. Give it a title in World Info.' });
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
 * The footer line, of the ready entries a reply sends (isEntryReady in lorebase-readiness.js). On High Accuracy: how
 * many titles the pick reads from the book, and what they add to every pick. On Fast and Cheap [Jev] (§7.3 of
 * lorebook-multi-vector.md): how many ready entries Jev is asked about on every reply, every one up to POOL_SEATS, else
 * the search's best POOL_SEATS, counted over the books taking part in the open chat, or that none is ready yet; that the
 * selection shown takes no part there; or the rule alone while the count is not known. With nothing LoreBase decides
 * selected, that it decides none.
 * @param {{decidedCount: number, entryCount: number, titleTokens: number}} footer - From selectionFooter
 * @param {{isFastAndCheap?: boolean, takingPart?: {count: number, isSelectionTakingPart: boolean}|null}} [choice] -
 *   isFastAndCheap: LoreBase's Accuracy is Fast and Cheap [Jev]; takingPart: the ready entries in the books taking part
 *   in the open chat, the selection shown's among them, and whether it takes part, or null while not known
 * @returns {string}
 */
export function summaryText({ decidedCount, entryCount, titleTokens }, { isFastAndCheap = false, takingPart = null } = {}) {
    if (!decidedCount) return 'LoreBase decides no entry in this selection: where it is in use, SillyTavern\'s keys decide them all.';
    if (!isFastAndCheap) {
        return `The pick reads ${counted(entryCount, 'title')} and their keys from this book, about ${formatCount(titleTokens)} tokens on every pick.`;
    }
    if (!takingPart) {
        return `Jev is asked about every ready entry of the books a chat locks, up to ${formatCount(POOL_SEATS)} in all, `
            + `and above that about the ${formatCount(POOL_SEATS)} a search finds best, on every reply.`;
    }
    if (!takingPart.isSelectionTakingPart) return 'This selection takes no part in this chat, so Jev is never asked about its entries here.';
    if (!takingPart.count) return 'No entry taking part in this chat is ready yet, so Jev is asked about none until their keys and vectors are written.';
    const entries = `${counted(takingPart.count, 'ready entry', 'ready entries')} taking part in this chat`;
    return takingPart.count > POOL_SEATS
        ? `Jev is asked about the ${formatCount(POOL_SEATS)} a search finds best of the ${entries}, on every reply.`
        : `Jev is asked about every one of the ${entries}, on every reply.`;
}

/**
 * Where the selected entries' keys and vectors stand (D17, §4.4 of lorebook-multi-vector.md): how many are ready, being
 * written, failed or not written yet; '' when none is selected. An entry sends nothing until both are written; the
 * ones without them are asked about once the screen closes while LoreBase is on, or when LoreBase is turned on.
 * @param {{ready: number, writing: number, failed: number, missing: number}} counts
 * @param {{isLoreBaseOn?: boolean}} [options] - isLoreBaseOn: Use LoreBase's switch
 * @returns {string}
 */
export function readinessSummaryText({ ready, writing, failed, missing }, { isLoreBaseOn = true } = {}) {
    if (!ready && !writing && !failed && !missing) return '';
    const parts = [`${formatCount(ready)} ready`];
    if (writing) parts.push(`${formatCount(writing)} being written`);
    if (failed) parts.push(`${formatCount(failed)} failed`);
    if (missing) parts.push(`${formatCount(missing)} not written yet`);
    const waiting = writing + failed + missing;
    const line = `Keys and vectors: ${parts.join(', ')}.`;
    if (!waiting) return line;
    if (!isLoreBaseOn) return `${line} Turning on Use LoreBase asks to write them.`;
    const wait = waiting === 1 ? 'sends nothing until its keys and vectors are written' : 'send nothing until their keys and vectors are written';
    const ask = failed + missing ? ' Closing this screen asks to write the missing ones.' : '';
    return `${line} ${counted(waiting, 'selected entry', 'selected entries')} ${wait}.${ask}`;
}
