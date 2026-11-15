/**
 * LoreBase's selection screen, the pure rules (plan §5.2 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): each entry of a book as a row, with its badges and, for an entry
 * SillyTavern keeps its own, why; the books the screen offers; the categories the comment prefixes make; the filters;
 * the ticks the bulk bar acts on; what the bar and a category's toggle select; the entries new since the book was last
 * opened; the footer's count and title tokens; and the section names a book can pin. Pure: no SillyTavern, no DOM.
 */
import { decidedEntries } from './lorebase-reply-core.js';
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
export const KEY_CHOICES = Object.freeze({ any: 'any', withKeys: 'with', withoutKeys: 'without' });

const keysOf = entry => (Array.isArray(entry.key) ? entry.key : []).map(key => String(key).trim()).filter(Boolean);

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

/** Why SillyTavern keeps an entry its own, so it cannot be selected (§5.2), or null. */
function keptBySillyTavernOf(entry) {
    if (entry.constant) return 'constant';
    if (Number(entry.sticky) > 0) return 'sticky';
    if (Number(entry.cooldown) > 0) return 'cooldown';
    return null;
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
 * @property {string|null} keptBySillyTavern - 'constant', 'sticky' or 'cooldown' when it cannot be selected
 * @property {boolean} isDisabled - SillyTavern never sends it while it is disabled
 * @property {boolean} isNew - Added since the book was last opened on the screen
 * @property {boolean} isSelected
 * @property {string} searchText - Its title, comment, keys and text, lowercased, for the text filter
 */

/**
 * The screen's rows for a book, in the book's own order.
 * @param {{entries?: object}|null} book - As loadWorldInfo returns it
 * @param {{selectedUids: string[], seenUids?: string[]}|null} record - The book's record, from getLoreBook
 * @returns {SelectionRow[]}
 */
export function selectionRows(book, record) {
    const selected = new Set(record?.selectedUids ?? []);
    // A book never opened on the screen has no record of what was there, so nothing in it counts as new.
    const seen = Array.isArray(record?.seenUids) ? new Set(record.seenUids) : null;
    return Object.values(book?.entries ?? {}).map(entry => {
        const uid = String(entry.uid);
        const content = String(entry.content ?? '');
        const tokens = estimatedTokens(content);
        const keys = keysOf(entry);
        const secondaryKeys = (Array.isArray(entry.keysecondary) ? entry.keysecondary : []).map(String);
        const title = entryTitle(entry);
        return {
            uid,
            title,
            category: entryCategory(entry),
            tokens,
            keyCount: keys.length,
            badges: badgesOf(entry, { content, tokens, keys }),
            keptBySillyTavern: keptBySillyTavernOf(entry),
            isDisabled: Boolean(entry.disable),
            isNew: seen !== null && !seen.has(uid),
            isSelected: selected.has(uid),
            searchText: [title, entry.comment || '', ...keys, ...secondaryKeys, content].join('\n').toLowerCase(),
        };
    });
}

/**
 * The books the screen offers: those SillyTavern loads for the open chat first, in its order, then every other book
 * by name, each with how many entries it has selected.
 * @param {string[]} bookNames - Every lorebook SillyTavern has
 * @param {string[]} activeNames - The books it loads for the open chat (activeBookNames)
 * @param {Record<string, {selectedUids: string[]}>} records - The book records, by name
 * @returns {Array<{bookName: string, isActive: boolean, selectedCount: number}>}
 */
export function bookChoices(bookNames, activeNames, records) {
    const known = new Set(bookNames);
    const active = activeNames.filter(name => known.has(name));
    const others = bookNames.filter(name => !active.includes(name)).sort((first, second) => first.localeCompare(second));
    return [...active, ...others].map(bookName => ({
        bookName, isActive: active.includes(bookName), selectedCount: records?.[bookName]?.selectedUids?.length ?? 0,
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
 * @param {{text?: string, category?: string|null, minimumTokens?: number, keys?: string, badge?: string,
 *   isNewOnly?: boolean}} filters - category null for every category; badge '' for any
 * @returns {SelectionRow[]}
 */
export function filterRows(rows, { text = '', category = null, minimumTokens = 0, keys = KEY_CHOICES.any, badge = '', isNewOnly = false } = {}) {
    const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
    return rows.filter(row => (category === null || row.category === category)
        && row.tokens >= minimumTokens
        && (keys === KEY_CHOICES.any || (keys === KEY_CHOICES.withKeys) === (row.keyCount > 0))
        && (!badge || row.badges.includes(badge))
        && (!isNewOnly || row.isNew)
        && words.every(word => row.searchText.includes(word)));
}

const canBeOn = row => !row.keptBySillyTavern;
const canBeTickedInBulk = row => canBeOn(row) && !isEngineLike(row);

/**
 * The ticks after "Tick all shown": every shown row LoreBase can decide, but engine-like ones, which are ticked one
 * by one (§5.2). Ticks on rows the filters hide stay.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} shownRows
 * @returns {Set<string>}
 */
export function tickAllShown(ticked, shownRows) {
    return new Set([...ticked, ...shownRows.filter(canBeTickedInBulk).map(row => row.uid)]);
}

/**
 * The ticks after "Invert": each shown row's tick flips, but an engine-like row or one SillyTavern keeps is never
 * ticked by it. Ticks on rows the filters hide stay.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} shownRows
 * @returns {Set<string>}
 */
export function invertTicks(ticked, shownRows) {
    const next = new Set(ticked);
    for (const row of shownRows) {
        if (next.has(row.uid)) next.delete(row.uid);
        else if (canBeTickedInBulk(row)) next.add(row.uid);
    }
    return next;
}

/**
 * The ticks after a shift-click: every shown row from the last row clicked to this one takes this row's new tick,
 * but a row SillyTavern keeps, which is never ticked.
 * @param {Set<string>} ticked
 * @param {SelectionRow[]} shownRows
 * @param {string} anchorUid - The row clicked before
 * @param {string} uid - The row shift-clicked
 * @param {boolean} isTicked - Its new tick
 * @returns {Set<string>}
 */
export function tickRange(ticked, shownRows, anchorUid, uid, isTicked) {
    const next = new Set(ticked);
    const from = shownRows.findIndex(row => row.uid === anchorUid);
    const to = shownRows.findIndex(row => row.uid === uid);
    if (from < 0 || to < 0) {
        if (isTicked) next.add(uid);
        else next.delete(uid);
        return next;
    }
    for (const row of shownRows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (isTicked && canBeOn(row)) next.add(row.uid);
        else next.delete(row.uid);
    }
    return next;
}

/**
 * The selection after the bulk bar turns LoreBase on or off for the ticked rows. It never turns on an entry
 * SillyTavern keeps.
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
 * The selection without the uids of entries the book no longer holds.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[]}|null} record
 * @returns {string[]}
 */
export function liveSelection(book, record) {
    const held = new Set(Object.values(book?.entries ?? {}).map(entry => String(entry.uid)));
    return (record?.selectedUids ?? []).filter(uid => held.has(uid));
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
 * The footer: how many entries the pick reads from this book, and about how many tokens their lines add to the
 * table of contents of every pick.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[]}|null} record
 * @returns {{entryCount: number, titleTokens: number}}
 */
export function selectionFooter(book, record) {
    const entries = decidedEntries(book, record);
    const titleTokens = entries.reduce((total, entry, index) => total + estimatedTokens(`${index + 1}. ${entryTitle(entry)}`), 0);
    return { entryCount: entries.length, titleTokens };
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
 * The section names a book can pin (D10): those in the entries the pick reads, each with how many of them hold it,
 * most held first, and any name already pinned.
 * @param {{entries?: object}|null} book
 * @param {{selectedUids: string[], pinnedSections?: string[]}|null} record
 * @param {(entry: object) => string[]} [sectionNamesOf] - entrySectionNames, or a copy that remembers each entry's
 * @returns {Array<{name: string, entryCount: number, isPinned: boolean}>}
 */
export function pinnableSections(book, record, sectionNamesOf = entrySectionNames) {
    const pinned = new Set(record?.pinnedSections ?? []);
    const counts = new Map();
    for (const entry of decidedEntries(book, record)) {
        for (const name of sectionNamesOf(entry)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const name of pinned) if (!counts.has(name)) counts.set(name, 0);
    return [...counts].map(([name, entryCount]) => ({ name, entryCount, isPinned: pinned.has(name) }))
        .sort((first, second) => second.entryCount - first.entryCount || first.name.localeCompare(second.name));
}
