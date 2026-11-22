/**
 * LoreBase's selection screen, the pure rules (plan §5.2 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): each entry of a book as a row, with its badges and, for an entry
 * LoreBase cannot decide (SillyTavern keeps it its own, or it is empty), why; the books the screen offers; the categories the comment prefixes make; the filters;
 * where a selected entry stands with its keys and vectors;
 * the ticks the bulk bar acts on; what the bar and a category's toggle select; the entries new since the book was last
 * opened; the footer's count and title tokens; and the section names a book can pin. Pure: no SillyTavern, no DOM.
 */
import { contentsLine } from './lorebase-pick-core.js';
import { decidedEntries, undecidableReasonOf } from './lorebase-reply-core.js';
import { hasTemplateCode } from './lorebase-review-core.js';
import { INTRO_SECTION, entryCategory, entryTitle, estimatedTokens, splitEntry } from './lorebase-splitter.js';

/** The badges a row can carry, in the order the screen lists them. */
export const BADGES = Object.freeze({
    templateCode: 'template_code',
    mostlyCode: 'mostly_code',
    enginePrefix: 'engine_prefix',
    machineKey: 'machine_key',
    keyless: 'keyless',
    long: 'long',
    noTitle: 'no_title',
});

// Badges of an entry that drives a game rather than holding lore: bulk selection leaves it to be selected one by one.
const ENGINE_LIKE_BADGES = new Set([BADGES.enginePrefix, BADGES.machineKey, BADGES.mostlyCode]);

// An engine's comment: mvu-helper's state entries, and its call blocks, prompts for its own calls that World Info never sends.
const ENGINE_PREFIX = /^\s*\[(?:mvu_|initvar)/i;
const MVU_HELPER_CALL_BLOCK = /\[(?:PRE|POST|llmshare)\]/;
const TEMPLATE_BLOCK = /<%[\s\S]*?%>/g;
// An entry this size is cut into several parts, and its review leaves out the most.
const LONG_ENTRY_TOKENS = 1000;
// An entry at least this share template code is a template, not lore.
const MOSTLY_CODE_SHARE = 0.5;

/** The filters' size choices: an entry at least this many tokens, 0 for any size. */
export const SIZE_CHOICES = Object.freeze([0, 300, 1000, 3000]);
/**
 * The readiness filter's choices (§7.3 of lorebook-multi-vector.md): every entry; the selected entries that are ready,
 * with their keys and vectors; or those not ready yet, without keys or vectors.
 */
export const READINESS_CHOICES = Object.freeze({ any: 'any', ready: 'ready', notReady: 'not-ready' });

/** A key list as SillyTavern stores it (`key`, `keysecondary`): each key trimmed, empty ones dropped. */
export const keyListOf = list => (Array.isArray(list) ? list : []).map(key => String(key).trim()).filter(Boolean);

/** A key that reads as a code, not a word, such as the barcode #0765792: no spaces, and at least half digits. */
function isCodeKey(key) {
    if (/\s/u.test(key)) return false;
    const characters = key.match(/[\p{L}\p{N}]/gu) ?? [];
    const digits = key.match(/\p{N}/gu) ?? [];
    return digits.length > 0 && digits.length * 2 >= characters.length;
}

function templateCodeShare(content) {
    const codeLength = (content.match(TEMPLATE_BLOCK) ?? []).reduce((total, block) => total + block.length, 0);
    return content.length ? codeLength / content.length : 0;
}

function badgesOf(entry, { content, tokens, keys }) {
    const badges = [];
    if (hasTemplateCode(content)) badges.push(templateCodeShare(content) >= MOSTLY_CODE_SHARE ? BADGES.mostlyCode : BADGES.templateCode);
    const comment = entry.comment || '';
    if (ENGINE_PREFIX.test(comment) || MVU_HELPER_CALL_BLOCK.test(comment)) badges.push(BADGES.enginePrefix);
    if (keys.length && keys.every(isCodeKey)) badges.push(BADGES.machineKey);
    if (!keys.length) badges.push(BADGES.keyless);
    if (tokens >= LONG_ENTRY_TOKENS) badges.push(BADGES.long);
    if (!comment.trim()) badges.push(BADGES.noTitle);
    return badges;
}

/**
 * Whether LoreBase decides a row's entry: isDecidedEntry on the row, selected, enabled in SillyTavern and with no
 * undecidableReason. What every row's keys, vectors, pencil and Regenerate keys go by.
 * @param {{isSelected: boolean, undecidableReason: string|null, isDisabled: boolean}} row
 * @returns {boolean}
 */
export function isDecidedRow(row) {
    return row.isSelected && !row.isDisabled && !row.undecidableReason;
}

/**
 * Whether a row's switch can be pressed: an entry LoreBase can decide turns on and off; one it cannot decide only turns
 * off, when it was selected before.
 * @param {{isSelected: boolean, undecidableReason: string|null}} row
 * @returns {boolean}
 */
export function canToggleRow(row) {
    return !row.undecidableReason || row.isSelected;
}

/** Whether a row drives a game rather than holding lore, so bulk selection leaves it out. */
export function isEngineLike(row) {
    return row.badges.some(badge => ENGINE_LIKE_BADGES.has(badge));
}

/**
 * @typedef {object} SelectionRow
 * @property {string} uid
 * @property {string} title - What the pick reads (entryTitle)
 * @property {string} category - The comment's prefix, '' for none
 * @property {number} tokens - The entry's size
 * @property {number} keyCount
 * @property {string[]} badges - From BADGES
 * @property {string|null} undecidableReason - 'constant', 'sticky', 'cooldown', 'activate_decorator',
 *   'dont_activate_decorator' or 'empty' when it cannot be selected
 * @property {boolean} isDisabled - SillyTavern never sends it while it is disabled
 * @property {boolean} isNew - Added since the book was last opened on the screen
 * @property {boolean} isSelected
 * @property {string} searchText - Its title, comment, keys and text, lowercased, for the text filter
 */

/**
 * The screen's rows for a book, in the book's own order.
 * @param {{entries?: object}|null} book - As loadWorldInfo returns it
 * @param {{selectedUids: string[], seenUids?: string[]}|null} shown - The selection shown's entries, and the entries the
 *   book's record saw it hold when the screen last opened it
 * @returns {SelectionRow[]}
 */
export function selectionRows(book, shown) {
    const selected = new Set(shown?.selectedUids ?? []);
    // A book never opened on the screen has no record of what was there, so nothing in it counts as new.
    const seen = Array.isArray(shown?.seenUids) ? new Set(shown.seenUids) : null;
    return Object.values(book?.entries ?? {}).map(entry => {
        const uid = String(entry.uid);
        const content = String(entry.content ?? '');
        const tokens = estimatedTokens(content);
        const keys = keyListOf(entry.key);
        const secondaryKeys = keyListOf(entry.keysecondary);
        const title = entryTitle(entry);
        return {
            uid,
            title,
            category: entryCategory(entry),
            tokens,
            keyCount: keys.length,
            badges: badgesOf(entry, { content, tokens, keys }),
            undecidableReason: undecidableReasonOf(entry),
            isDisabled: Boolean(entry.disable),
            isNew: seen !== null && !seen.has(uid),
            isSelected: selected.has(uid),
            searchText: [title, entry.comment || '', ...keys, ...secondaryKeys, content].join('\n').toLowerCase(),
        };
    });
}

/**
 * The books the screen offers: those SillyTavern loads for the open chat first, in its order, then every other book
 * by name, each with how many entries its selections hold together.
 * @param {string[]} bookNames - Every lorebook SillyTavern has
 * @param {string[]} activeNames - The books it loads for the open chat (activeBookNames)
 * @param {Record<string, number>} selectedCounts - How many entries each book's selections hold, by book name
 * @returns {Array<{bookName: string, isActive: boolean, selectedCount: number}>}
 */
export function bookChoices(bookNames, activeNames, selectedCounts) {
    const known = new Set(bookNames);
    const active = activeNames.filter(name => known.has(name));
    const others = bookNames.filter(name => !active.includes(name)).sort((first, second) => first.localeCompare(second));
    return [...active, ...others].map(bookName => ({
        bookName, isActive: active.includes(bookName), selectedCount: selectedCounts?.[bookName] ?? 0,
    }));
}

/**
 * The categories of a book's rows, in the order they first appear, entries without one last. A category's state is
 * on once every entry its toggle selects is selected (`bulkCount` of them: those LoreBase can decide, but engine-like
 * ones), off while none of its entries is, and mixed otherwise; `selectedCount` counts every selected entry in it.
 * @param {SelectionRow[]} rows
 * @returns {Array<{category: string, rowCount: number, selectedCount: number, bulkCount: number, state: 'on'|'off'|'mixed'}>}
 */
export function categoryList(rows) {
    const categories = new Map();
    for (const row of rows) {
        const tally = categories.get(row.category) ?? { category: row.category, rowCount: 0, selectedCount: 0, bulkCount: 0, bulkSelectedCount: 0 };
        tally.rowCount += 1;
        if (row.isSelected && canBeOn(row)) tally.selectedCount += 1;
        if (canBeTickedInBulk(row)) {
            tally.bulkCount += 1;
            if (row.isSelected) tally.bulkSelectedCount += 1;
        }
        categories.set(row.category, tally);
    }
    const listed = [...categories.values()].sort((first, second) => (first.category === '') - (second.category === ''));
    return listed.map(({ category, rowCount, selectedCount, bulkCount, bulkSelectedCount }) => ({
        category, rowCount, selectedCount, bulkCount,
        state: selectedCount === 0 ? 'off' : bulkCount > 0 && bulkSelectedCount === bulkCount ? 'on' : 'mixed',
    }));
}

/**
 * The rows the filters let through, in order. Text matches the title, comment, keys and text, case ignored.
 * @param {SelectionRow[]} rows
 * @param {{text?: string, category?: string|null, minimumTokens?: number, readiness?: string, readinessOf?:
 *   (row: SelectionRow) => {isReady: boolean}|null, badge?: string, isNewOnly?: boolean}} filters - category null for
 *   every category; readiness one of READINESS_CHOICES, read through readinessOf, which gives a selected entry's state
 *   (entryReadiness, its isReady) and null for any other; badge '' for any
 * @returns {SelectionRow[]}
 */
export function filterRows(rows, {
    text = '', category = null, minimumTokens = 0, readiness = READINESS_CHOICES.any, readinessOf = () => null, badge = '', isNewOnly = false,
} = {}) {
    const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
    const isReadinessShown = row => {
        if (readiness === READINESS_CHOICES.any) return true;
        const state = readinessOf(row);
        return Boolean(state) && state.isReady === (readiness === READINESS_CHOICES.ready);
    };
    return rows.filter(row => (category === null || row.category === category)
        && row.tokens >= minimumTokens
        && (!badge || row.badges.includes(badge))
        && (!isNewOnly || row.isNew)
        && words.every(word => row.searchText.includes(word))
        && isReadinessShown(row));
}

/**
 * Where a selected entry stands with its keys and vectors, as its row says it (§7.3 of lorebook-multi-vector.md), one
 * state: its keys being written; its vectors being written; its keys failed, or else its vectors, with the reason;
 * ready; its keys stored and its vectors not read in this session ('unknown', so the row claims nothing of them); or
 * what it still lacks. Each but the first carries the keys it has, for the row to show. `isReady` rides along on every
 * state: whether it is ready (isEntryReady in lorebase-readiness.js), which the summary and the readiness filter count,
 * so an entry whose keys are written anew stays ready on the keys it has.
 * @param {{status: string, keys?: string[], detail?: string}} keyState - From keyStateOf in lorebase-keys.js
 * @param {{status: string, detail?: string}} vectorState - From vectorStateOf in lorebase-vectors.js
 * @param {boolean} isReady - From isEntryReady
 * @returns {{status: string, isReady: boolean, keys?: string[]|null, detail?: string, lacksKeys?: boolean,
 *   lacksVectors?: boolean, isOtherModel?: boolean}} status: 'writing-keys', 'vectorizing', 'keys-failed', 'vectors-failed',
 *   'ready', 'unknown' or 'missing'
 */
export function entryReadiness(keyState, vectorState, isReady) {
    if (keyState.status === 'writing') return { status: 'writing-keys', isReady };
    const keys = keyState.status === 'ready' ? keyState.keys : null;
    if (vectorState.status === 'writing') return { status: 'vectorizing', keys, isReady };
    if (keyState.status === 'failed') return { status: 'keys-failed', detail: keyState.detail, isReady };
    if (vectorState.status === 'failed') return { status: 'vectors-failed', detail: vectorState.detail, keys, isReady };
    if (isReady) return { status: 'ready', keys, isReady };
    if (keys && vectorState.status === 'unknown') return { status: 'unknown', keys, isReady };
    const lacksVectors = vectorState.status !== 'ready' && vectorState.status !== 'unknown';
    return { status: 'missing', lacksKeys: !keys, lacksVectors, isOtherModel: vectorState.status === 'other-model', keys, isReady };
}

const canBeOn = row => !row.undecidableReason;
const canBeTickedInBulk = row => canBeOn(row) && !isEngineLike(row);

/**
 * The ticks after "Tick all matching": every row the filters let through that LoreBase can decide, drawn on the screen
 * yet or not, but engine-like ones, which are ticked one by one (§5.2). Ticks on rows the filters hide stay.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} matchingRows
 * @returns {Set<string>}
 */
export function tickAllMatching(ticked, matchingRows) {
    return new Set([...ticked, ...matchingRows.filter(canBeTickedInBulk).map(row => row.uid)]);
}

/**
 * The ticks after "Invert": the tick of each row the filters let through flips, drawn on the screen yet or not, but an
 * engine-like row or one LoreBase cannot decide is never ticked by it. Ticks on rows the filters hide stay.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} matchingRows
 * @returns {Set<string>}
 */
export function invertTicks(ticked, matchingRows) {
    const next = new Set(ticked);
    for (const row of matchingRows) {
        if (next.has(row.uid)) next.delete(row.uid);
        else if (canBeTickedInBulk(row)) next.add(row.uid);
    }
    return next;
}

/**
 * The ticks after a shift-click: every row the filters let through, from the last row clicked to this one, takes this
 * row's new tick, but a row LoreBase cannot decide, which is never ticked.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} matchingRows
 * @param {string} anchorUid - The row clicked before
 * @param {string} uid - The row shift-clicked
 * @param {boolean} isTicked - Its new tick
 * @returns {Set<string>}
 */
export function tickRange(ticked, matchingRows, anchorUid, uid, isTicked) {
    const next = new Set(ticked);
    const from = matchingRows.findIndex(row => row.uid === anchorUid);
    const to = matchingRows.findIndex(row => row.uid === uid);
    if (from < 0 || to < 0) {
        if (isTicked) next.add(uid);
        else next.delete(uid);
        return next;
    }
    for (const row of matchingRows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (isTicked && canBeOn(row)) next.add(row.uid);
        else next.delete(row.uid);
    }
    return next;
}

/**
 * The selection after the bulk bar turns LoreBase on or off for the ticked rows. It never turns on an entry
 * LoreBase cannot decide.
 * @param {string[]} selectedUids
 * @param {SelectionRow[]} rows
 * @param {Set<string>} ticked
 * @param {boolean} isOn
 * @returns {string[]}
 */
export function selectionAfterBulk(selectedUids, rows, ticked, isOn) {
    const next = new Set(selectedUids);
    for (const row of rows) {
        if (!ticked.has(row.uid)) continue;
        if (!isOn) next.delete(row.uid);
        else if (canBeOn(row)) next.add(row.uid);
    }
    return [...next];
}

/**
 * The selection after a category's toggle: on selects every entry of the category LoreBase can decide, but
 * engine-like ones, which are selected one by one; off clears the whole category. Nothing is stored per category.
 * @param {string[]} selectedUids
 * @param {SelectionRow[]} rows
 * @param {string} category
 * @param {boolean} isOn
 * @returns {string[]}
 */
export function selectionAfterCategory(selectedUids, rows, category, isOn) {
    const next = new Set(selectedUids);
    for (const row of rows) {
        if (row.category !== category) continue;
        if (!isOn) next.delete(row.uid);
        else if (canBeTickedInBulk(row)) next.add(row.uid);
    }
    return [...next];
}

/**
 * A selection's entries without the uids of those the book no longer holds.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[]}|null} selection
 * @returns {string[]}
 */
export function liveSelection(book, selection) {
    const held = new Set(Object.values(book?.entries ?? {}).map(entry => String(entry.uid)));
    return (selection?.selectedUids ?? []).filter(uid => held.has(uid));
}

/**
 * The uids a book holds now, which the record keeps when the screen opens it, so later entries show as new.
 * @param {{entries?: object}|null} book
 * @returns {string[]}
 */
export function seenUidsOf(book) {
    return Object.values(book?.entries ?? {}).map(entry => String(entry.uid));
}

/**
 * The footer: how many entries LoreBase decides in the selection; of them, how many a reply sends now, the ready ones,
 * which the pick reads from this book while the selection is in use; and about how many tokens their lines, each a
 * title and its keys, add to the table of contents of every pick.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[]}|null} selection
 * @param {{keysOf?: (uid: string) => string[], isReady?: (entry: object) => boolean}} [readers] - keysOf: an entry's keys,
 *   none when not written; isReady: whether it is ready (isEntryReady in lorebase-readiness.js), none by default
 * @returns {{decidedCount: number, entryCount: number, titleTokens: number}}
 */
export function selectionFooter(book, selection, { keysOf = () => [], isReady = () => false } = {}) {
    const decided = decidedEntries(book, selection);
    const entries = decided.filter(isReady);
    const titleTokens = entries.reduce((total, entry, index) => total
        + estimatedTokens(`${index + 1}. ${contentsLine({ title: entryTitle(entry), keys: keysOf(String(entry.uid)) })}`), 0);
    return { decidedCount: decided.length, entryCount: entries.length, titleTokens };
}

/**
 * The section names an entry's parts fall under, each once, the intro left out.
 * @param {{content?: string}} entry
 * @returns {string[]}
 */
export function entrySectionNames(entry) {
    return [...new Set(splitEntry(entry.content).passages.map(passage => passage.section).filter(name => name !== INTRO_SECTION))];
}

/**
 * The section names a selection can pin (D10): those in the entries the pick reads while it is in use, each with how
 * many of them hold it, most held first, and any name already pinned.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[], pinnedSections?: string[]}|null} selection
 * @param {(entry: object) => string[]} [sectionNamesOf] - entrySectionNames, or a copy that remembers each entry's
 * @returns {Array<{name: string, entryCount: number, isPinned: boolean}>}
 */
export function pinnableSections(book, selection, sectionNamesOf = entrySectionNames) {
    const pinned = new Set(selection?.pinnedSections ?? []);
    const counts = new Map();
    for (const entry of decidedEntries(book, selection)) {
        for (const name of sectionNamesOf(entry)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const name of pinned) if (!counts.has(name)) counts.set(name, 0);
    return [...counts].map(([name, entryCount]) => ({ name, entryCount, isPinned: pinned.has(name) }))
        .sort((first, second) => second.entryCount - first.entryCount || first.name.localeCompare(second.name));
}
