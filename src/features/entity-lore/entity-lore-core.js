/**
 * ============================================================================
 * ENTITY-LORE, PURE
 * ============================================================================
 * Which named characters get a lorebook entry, and when one is written again
 * (InternalProject/Vectfox/plans/entity-lore.md §4.2, §4.4, §4.5, §5, §6): the
 * switch and the two counts, read from settings and kept in their ranges; what
 * else keeps it from running; the names a chat already has a place for, and
 * the entry of another book that names each; where each counted character
 * stands, which the Entity-Lore tab's rows and a run both read, so the two
 * never disagree; the entries a run writes, and the one a row's button writes;
 * an entry's keys; the record kept in the collection's metadata, the
 * characters the user locked in it, the names Allow again kept apart, the
 * names the name check linked to an entry of another book, and what a merge of
 * names on StoryArc's Entity tab, a split, or Allow again makes of it; an event
 * with one time, as an entry's call reads it; the cut of a character's events
 * into slices one call can read; and what a run names: its book, the titles
 * the name check is shown and the author keys its second ask shows under them,
 * the names matched to an entry, the links that hold, Run now's question and
 * the run's outcome.
 *
 * Pure: no host or feature imports. What another feature knows, such as
 * whether the card's description holds a name or how many tokens a text is,
 * comes in as a function.
 * ============================================================================
 */

import { counted } from '../../shared/counted.js';
import { cyrb53 } from '../../shared/point-ids.js';

/** The settings Entity-Lore reads (§8). A missing key reads as its default. */
export const ENTITY_LORE_SETTING = Object.freeze({
    enabled: 'entity_lore_enabled',
    writeAtEvents: 'entity_lore_write_at_events',
    rewriteEveryEvents: 'entity_lore_rewrite_every_events',
});
/** Write at: a named character gets an entry once this many events name them (D3). */
export const WRITE_AT_EVENTS = Object.freeze({ default: 10, min: 3, max: 50 });
/** Rewrite every: an entry is written again after this many more events (D3). */
export const REWRITE_EVERY_EVENTS = Object.freeze({ default: 30, min: 10, max: 100 });

/** The most entries a run after an EventBase run writes (D7); Run now writes every entry that is due. */
export const ENTRIES_PER_AUTOMATIC_RUN = 5;
/** The most tokens of events one call reads; more go in slices, each read by a notes call (§4.4). */
export const EVENT_SLICE_TOKENS = 30000;

/**
 * What the record says of a kept name (§6): an entry written for it; not a named character; another name of an entry
 * Entity-Lore wrote, or of another candidate; deleted by the user; or another name of the character of an entry in
 * another book the chat loads, which the name check linked it to (E2 of entity-lore-names-across-languages.md).
 */
export const RECORD_STATE = Object.freeze({ written: 'written', notNamed: 'not_named', sameAs: 'same_as', deleted: 'deleted', inLorebook: 'in_lorebook' });
const RECORD_STATES = new Set(Object.values(RECORD_STATE));
/**
 * How a written entry's character changed its names since the entry was written, which makes it due again (D17): a
 * merge on StoryArc's Entity tab, rewritten from the entry as it stands; a split there, or Allow again on a name the
 * name check matched to it, each written afresh (isWrittenAfreshAfter).
 */
export const NAMES_CHANGED_BY = Object.freeze({ merge: 'merge', split: 'split', allowAgain: 'allow_again' });

/** Why a counted character gets no entry (§4.2). */
export const EXCLUSION = Object.freeze({
    chatCharacter: 'chat_character',
    persona: 'persona',
    lorebook: 'lorebook',
    cardDescription: 'card_description',
});

/** Where a counted character stands (§3's states). */
export const ENTITY_STATE = Object.freeze({
    waiting: 'waiting',
    due: 'due',
    written: 'written',
    rewriteDue: 'rewrite_due',
    editedByUser: 'edited_by_user',
    deletedByUser: 'deleted_by_user',
    notNamed: 'not_named',
    sameAs: 'same_as',
    inLorebook: 'in_lorebook',
    excluded: 'excluded',
    locked: 'locked',
});

/**
 * An entry of a book the chat loads that Entity-Lore did not write, as the exclusions, the name check and a link read
 * it: its book, uid and title, the names it holds (its title and keys), its author's keys alone, which the name check's
 * second ask shows, whether LoreBase decides it in the chat, so Jev reads its LoreBase keys there, and whether
 * SillyTavern always sends it.
 * @typedef {{bookName: string, uid: string, title: string, names: string[], keys: string[], isDecidedHere: boolean, isConstant: boolean}} LoreEntry
 */

/** Whether two names are one, trimmed and in any case: how the record, the exclusions, the keys and the name check match names. */
export const isSameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNameText = value => typeof value === 'string' && Boolean(value.trim());
/** A counted character's names: its kept name, then its other names. */
const namesOf = row => [row.name, ...(row.otherNames ?? [])];

function wholeNumberIn(value, { default: fallback, min, max }) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/**
 * Whether the user turned Entity-Lore on. Off by default.
 *
 * @param {object} settings
 * @returns {boolean}
 */
export function isEntityLoreOn(settings) {
    return settings?.[ENTITY_LORE_SETTING.enabled] === true;
}

/**
 * Write at, from its saved value: a whole number in its range, or the default for a value that holds no number.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function writeAtEventsOf(value) {
    return wholeNumberIn(value, WRITE_AT_EVENTS);
}

/**
 * Rewrite every, from its saved value: a whole number in its range, or the default for a value that holds no number.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function rewriteEveryEventsOf(value) {
    return wholeNumberIn(value, REWRITE_EVERY_EVENTS);
}

/** What Entity-Lore runs on (D8): LoreBase, StoryArc mode, and LoreBase's model. */
export const ENTITY_LORE_NEED = Object.freeze({ loreBase: 'lorebase', storyArc: 'story_arc', loreBaseModel: 'lorebase_model' });
/** Where the user fixes what Entity-Lore needs: the StoryArc page, or the WorldInfo page's Main tab. */
export const ENTITY_LORE_FIX_AT = Object.freeze({ storyArcPage: 'story_arc_page', worldInfoMain: 'worldinfo_main' });
const THROUGH_LOREBASE = "Entity-Lore's entries go through LoreBase.";

/**
 * What keeps Entity-Lore from running, its own switch aside (§3, D8), the first of: LoreBase not acting, StoryArc mode
 * off, LoreBase's model not set; null when nothing does. LoreBase comes first, as its reason names what StoryArc needs
 * too (VectFox on, the Qdrant backend). `reason` says what is off, `fix` what to do, and `fixAt` where, when one place
 * of the panel does it.
 *
 * @param {object} standing
 * @param {string|null} standing.loreBaseReason - From loreBaseInactiveReason
 * @param {boolean} standing.isLoreBaseSwitchedOn - Use LoreBase
 * @param {boolean} standing.isStoryArcActive
 * @param {string|null} standing.modelProblem - Why LoreBase's model cannot be called, null when it can
 * @returns {{need: string, reason: string, fix: string, fixAt: string|null}|null}
 */
export function entityLoreBlocker({ loreBaseReason, isLoreBaseSwitchedOn, isStoryArcActive, modelProblem }) {
    if (loreBaseReason && !isLoreBaseSwitchedOn) {
        return {
            need: ENTITY_LORE_NEED.loreBase, reason: loreBaseReason, fix: `Turn on Use LoreBase on the Main tab first. ${THROUGH_LOREBASE}`,
            fixAt: ENTITY_LORE_FIX_AT.worldInfoMain,
        };
    }
    if (loreBaseReason) return { need: ENTITY_LORE_NEED.loreBase, reason: loreBaseReason, fix: `${loreBaseReason} ${THROUGH_LOREBASE}`, fixAt: null };
    if (!isStoryArcActive) {
        return {
            need: ENTITY_LORE_NEED.storyArc, reason: 'StoryArc mode is off.', fix: 'Turn on StoryArc mode first. Entity-Lore counts characters in its events.',
            fixAt: ENTITY_LORE_FIX_AT.storyArcPage,
        };
    }
    if (modelProblem) return { need: ENTITY_LORE_NEED.loreBaseModel, reason: modelProblem, fix: modelProblem, fixAt: ENTITY_LORE_FIX_AT.worldInfoMain };
    return null;
}

// ---------------------------------------------------------------------------- The record (§6)

/**
 * A collection's Entity-Lore record, from its metadata's `entityLore`: the book it writes into, what it knows of each
 * kept name, the names of the characters the user locked (T3), and the pairs of names Allow again kept apart (D18). A
 * kept name whose record is not one of RECORD_STATE's reads as having none, and a locked name or a pair that holds no
 * text is left out.
 *
 * @param {unknown} stored
 * @returns {{bookName: string, entries: Record<string, object>, lockedNames: string[],
 *   keptApart: Array<{name: string, from: string}>}} a new object
 */
export function readEntityLoreRecord(stored) {
    const storedEntries = isPlainObject(stored) && isPlainObject(stored.entries) ? stored.entries : {};
    const entries = Object.fromEntries(Object.entries(storedEntries)
        .filter(([, entry]) => isPlainObject(entry) && RECORD_STATES.has(entry.state))
        .map(([name, entry]) => [name, { ...entry }]));
    const listOf = key => (isPlainObject(stored) && Array.isArray(stored[key]) ? stored[key] : []);
    return {
        bookName: isPlainObject(stored) && typeof stored.bookName === 'string' ? stored.bookName : '',
        entries,
        lockedNames: listOf('lockedNames').filter(isNameText),
        keptApart: listOf('keptApart').filter(pair => isPlainObject(pair) && isNameText(pair.name) && isNameText(pair.from))
            .map(({ name, from }) => ({ name, from })),
    };
}

/**
 * Whether the user locked a counted character (T3): one of its names, in any case, is a locked name, so a name merged
 * into a locked character is locked with it.
 *
 * @param {{lockedNames: string[]}} record
 * @param {{name: string, otherNames?: string[]}} row
 * @returns {boolean}
 */
export function isCharacterLocked(record, row) {
    const names = [row.name, ...(row.otherNames ?? [])];
    return record.lockedNames.some(locked => names.some(name => isSameName(name, locked)));
}

/**
 * The record with a counted character locked under its kept name, so Entity-Lore leaves its entry as it is (T3), or
 * unlocked, every one of its names taken out.
 *
 * @param {object} record
 * @param {{name: string, otherNames?: string[]}} row
 * @param {boolean} isLocked
 * @returns {object} a new record
 */
export function withCharacterLocked(record, row, isLocked) {
    const names = [row.name, ...(row.otherNames ?? [])];
    const others = record.lockedNames.filter(locked => !names.some(name => isSameName(name, locked)));
    return { ...record, lockedNames: isLocked ? [...others, row.name] : others };
}

/**
 * A kept name's record, in any case: a row shows the spelling most events tag, which can change as events are added.
 *
 * @param {{entries: Record<string, object>}} record
 * @param {string} name
 * @returns {object|null}
 */
export function recordOfName(record, name) {
    const key = Object.keys(record.entries).find(each => isSameName(each, name));
    return key === undefined ? null : record.entries[key];
}

/** The record with a kept name's entry put under that spelling, any other case of it replaced. */
function withEntry(record, name, entry) {
    const others = Object.entries(record.entries).filter(([key]) => !isSameName(key, name));
    return { ...record, entries: { ...Object.fromEntries(others), [name]: entry } };
}

/**
 * An entry's text as its hash records it, line endings as \n and its ends trimmed, so the text SillyTavern saves back
 * never reads as the user's edit (D4).
 *
 * @param {string} content
 * @returns {string}
 */
export function entryContentHash(content) {
    return String(cyrb53(String(content ?? '').replace(/\r\n?/g, '\n').trim()));
}

/**
 * The record with an entry written for a kept name: its uid, the count it was written at, and its text's hash, no
 * longer due for a change of its names (D17).
 *
 * @param {object} record
 * @param {string} name
 * @param {{uid: string|number, writtenAtEvents: number, content: string}} entry
 * @returns {object} a new record
 */
export function withWrittenEntry(record, name, { uid, writtenAtEvents, content }) {
    return withEntry(record, name, { state: RECORD_STATE.written, uid: String(uid), writtenAtEvents, contentHash: entryContentHash(content) });
}

/**
 * The record with the name check's answer for a kept name that gets no entry of its own: not a named character, or
 * another name of the entry titled `sameAs` (§4.3).
 *
 * @param {object} record
 * @param {string} name
 * @param {{state: string, sameAs?: string}} answer - state: RECORD_STATE.notNamed or RECORD_STATE.sameAs
 * @returns {object} a new record
 */
export function withNameCheckAnswer(record, name, { state, sameAs = '' }) {
    return withEntry(record, name, state === RECORD_STATE.sameAs ? { state, sameAs } : { state: RECORD_STATE.notNamed });
}

/**
 * The record with the name check's link of a kept name to an entry in another book the chat loads (E2 of
 * entity-lore-names-across-languages.md): another name of that entry's character, which gets no entry of its own, and
 * which joins that entry's LoreBase keys. The entry is kept by its book, uid and title, by which the link holds
 * (heldLinkOf).
 *
 * @param {object} record
 * @param {string} name
 * @param {{bookName: string, uid: string|number, title: string}} lorebookEntry
 * @returns {object} a new record
 */
export function withNameInLorebook(record, name, { bookName, uid, title }) {
    return withEntry(record, name, { state: RECORD_STATE.inLorebook, bookName, uid: String(uid), title });
}

/**
 * The entry a link names while it holds (E2): the chat still loads its book, and the book holds an entry at its uid
 * under the title it was linked by, in any case. A link whose entry is gone, renamed or another entry's now reads as no
 * record, so the name is counted as if new and asked about again.
 *
 * @param {{bookName: string, uid: string, title: string}} link - A record entry in RECORD_STATE.inLorebook
 * @param {LoreEntry[]} loreEntries
 * @returns {LoreEntry|null}
 */
function heldLinkOf(link, loreEntries) {
    return loreEntries.find(each => each.bookName === link.bookName && each.uid === String(link.uid) && isSameName(each.title, link.title)) ?? null;
}

/**
 * The record's links that hold (E2), each kept name with the entry it is linked to: the names a run adds to those
 * entries' LoreBase keys again, as a Regenerate keys rewrites every key.
 *
 * @param {{entries: Record<string, object>}} record
 * @param {LoreEntry[]} loreEntries
 * @returns {Array<{name: string, lorebookEntry: LoreEntry}>}
 */
export function heldLinks(record, loreEntries) {
    return Object.entries(record.entries)
        .filter(([, entry]) => entry.state === RECORD_STATE.inLorebook)
        .map(([name, entry]) => ({ name, lorebookEntry: heldLinkOf(entry, loreEntries) }))
        .filter(link => link.lorebookEntry);
}

/**
 * The record without a kept name's entry, in any case: Allow again forgets the name (withNameAllowedAgain), and a merge
 * moves its entry to the kept name (withMergedEntry).
 */
function withEntryForgotten(record, name) {
    return { ...record, entries: Object.fromEntries(Object.entries(record.entries).filter(([key]) => !isSameName(key, name))) };
}

/**
 * The record with every written entry whose uid the book no longer holds marked deleted, so it is never written again
 * until Allow again (§6).
 *
 * @param {object} record
 * @param {Array<string|number>} bookUids - The uids of the entries the book holds now
 * @returns {object} a new record
 */
export function withMissingEntriesDeleted(record, bookUids) {
    const held = new Set(bookUids.map(String));
    const entries = Object.fromEntries(Object.entries(record.entries).map(([name, entry]) => [
        name,
        entry.state === RECORD_STATE.written && !held.has(String(entry.uid)) ? { ...entry, state: RECORD_STATE.deleted } : entry,
    ]));
    return { ...record, entries };
}

/** A name's entry, in any case, while it is written and its book holds its uid; null otherwise. */
function heldWrittenEntry(record, name, heldUids) {
    const entry = recordOfName(record, name);
    return entry?.state === RECORD_STATE.written && heldUids.has(String(entry.uid)) ? entry : null;
}

/**
 * Whether an entry due again for a change of its character's names is written afresh, without the entry as it stands:
 * after a split, or Allow again on a name matched to it, its text holds the events of a name it no longer reads (D17).
 *
 * @param {string} [namesChangedBy] - One of NAMES_CHANGED_BY
 * @returns {boolean}
 */
export function isWrittenAfreshAfter(namesChangedBy) {
    return namesChangedBy === NAMES_CHANGED_BY.split || namesChangedBy === NAMES_CHANGED_BY.allowAgain;
}

/** An entry due again for a change of its character's names (D17). One to be written afresh stays so, as its text holds those events still. */
function withNamesChanged(entry, changedBy) {
    return { ...entry, namesChangedBy: isWrittenAfreshAfter(entry.namesChangedBy) ? entry.namesChangedBy : changedBy };
}

/**
 * The record with a name's entry, written and held by the book still, due again for a change of names (D17), under the
 * spelling the record holds it by; null when the name has no such entry.
 * @returns {{record: object, uid: string, title: string}|null}
 */
function withEntryNamesChanged(record, name, changedBy, bookUids) {
    const entry = heldWrittenEntry(record, name, new Set(bookUids.map(String)));
    if (!entry) return null;
    const title = Object.keys(record.entries).find(each => isSameName(each, name));
    return { record: withEntry(record, title, withNamesChanged(entry, changedBy)), uid: entry.uid, title };
}

/**
 * The record after StoryArc's Entity tab merged names into one entity (D14): the entity's entry is the kept name's, or
 * else the first of its other names', written and held by the book still; one written under another name moves to the
 * kept name, and the names the name check matched to it follow it. The entry is due again (D17), so its text takes in
 * every name's events. Null when none of the names has one. Another name's entry stays as it is, `alsoWritten` naming
 * it.
 *
 * @param {object} record
 * @param {{keptName: string, otherNames: string[]}} merge - The merged entity's names, as StoryArc keeps them
 * @param {Array<string|number>} bookUids - The uids of the entries the book holds now
 * @returns {{record: object, uid: string, movedFrom: string|null, alsoWritten: string[]}|null} record: a new record;
 *   movedFrom: the name the entry was written under, null when it was the kept name's
 */
export function withMergedEntry(record, { keptName, otherNames }, bookUids) {
    const heldUids = new Set(bookUids.map(String));
    const [chosen, ...alsoWritten] = [keptName, ...otherNames].filter(name => heldWrittenEntry(record, name, heldUids));
    if (chosen === undefined) return null;
    const entry = withNamesChanged(heldWrittenEntry(record, chosen, heldUids), NAMES_CHANGED_BY.merge);
    if (isSameName(chosen, keptName)) return { record: withEntry(record, keptName, entry), uid: entry.uid, movedFrom: null, alsoWritten };
    const moved = withEntry(withEntryForgotten(record, chosen), keptName, entry);
    const entries = Object.fromEntries(Object.entries(moved.entries).map(([name, each]) => [
        name,
        each.state === RECORD_STATE.sameAs && isSameName(each.sameAs ?? '', chosen) ? { ...each, sameAs: keptName } : each,
    ]));
    return { record: { ...moved, entries }, uid: entry.uid, movedFrom: chosen, alsoWritten };
}

/**
 * The record after StoryArc's Entity tab split a name off an entity (D17): the kept name's entry, written and held by
 * the book still, is due again and written afresh from the events of the names it keeps, as its text holds the split
 * name's too. Null when the kept name has no such entry, or when the name check matched the split name to it (§4.3),
 * as the entry reads that name's events still.
 *
 * @param {object} record
 * @param {{keptName: string, splitName: string}} split - The entity's kept name, and the name split off it
 * @param {Array<string|number>} bookUids - The uids of the entries the book holds now
 * Its caller saves the record only when the user has the entry written again, as the split asks (D21); the uid keys the
 * entry without the split name either way.
 * @returns {{record: object, uid: string, title: string}|null} record: a new record; title: the entry's kept name, as
 *   the record spells it
 */
export function withSplitName(record, { keptName, splitName }, bookUids) {
    if (namesMatchedTo(record, keptName).some(name => isSameName(name, splitName))) return null;
    return withEntryNamesChanged(record, keptName, NAMES_CHANGED_BY.split, bookUids);
}

/**
 * The record after Allow again (§3, §6): it forgets a kept name, which is counted as if new, due at Write at and asked
 * about by the next name check. A name the name check matched to an entry (§4.3) no longer reads as that entry's: the
 * two are kept apart (D18), so the name check never matches them again, and the entry, written and held by the book
 * still, is due again and written afresh (D17), as its text holds the name's events. A name it linked to an entry in
 * another book (E2) is kept apart from that entry's title, and its caller takes the name off that entry's LoreBase keys.
 *
 * @param {object} record
 * @param {string} name - The row's kept name
 * @param {Array<string|number>} bookUids - The uids of the entries the book holds now
 * @returns {{record: object, keptApartFrom: string|null, matchedEntryUid: string|null,
 *   lorebookEntry: {bookName: string, uid: string}|null}} record: a new record; keptApartFrom: the title the name was
 *   matched or linked to, now kept apart from it; matchedEntryUid: the uid of that title's entry, when it is marked to be
 *   written afresh; lorebookEntry: the entry of another book the name was linked to
 */
export function withNameAllowedAgain(record, name, bookUids) {
    const entry = recordOfName(record, name);
    const forgotten = withEntryForgotten(record, name);
    if (entry?.state === RECORD_STATE.inLorebook) {
        return {
            record: withKeptApart(forgotten, { name, from: entry.title }), keptApartFrom: entry.title, matchedEntryUid: null,
            lorebookEntry: { bookName: entry.bookName, uid: entry.uid },
        };
    }
    if (entry?.state !== RECORD_STATE.sameAs || !entry.sameAs) return { record: forgotten, keptApartFrom: null, matchedEntryUid: null, lorebookEntry: null };
    const changed = withEntryNamesChanged(forgotten, entry.sameAs, NAMES_CHANGED_BY.allowAgain, bookUids);
    const keptApartFrom = changed?.title ?? entry.sameAs;
    return {
        record: withKeptApart(changed?.record ?? forgotten, { name, from: keptApartFrom }), keptApartFrom, matchedEntryUid: changed?.uid ?? null,
        lorebookEntry: null,
    };
}

/** The record with two names kept apart (D18), each pair once, in either order and any case. */
function withKeptApart(record, pair) {
    const isPair = each => (isSameName(each.name, pair.name) && isSameName(each.from, pair.from))
        || (isSameName(each.name, pair.from) && isSameName(each.from, pair.name));
    return record.keptApart.some(isPair) ? record : { ...record, keptApart: [...record.keptApart, pair] };
}

/**
 * The names a counted character is kept apart from (D18): Allow again on a Same as row, or on a row the name check
 * linked to an entry of another book, said the two are not one character, so the name check never matches either to
 * the other (§4.3). From each pair the row holds one side of, by any of its names, the other side with every name of
 * its character as StoryArc's merges make it; none from a pair the row holds both sides of, as merging the two names
 * counts them as one.
 *
 * @returns {string[]} each name once, in any case
 */
function namesKeptApartFrom(record, row, rows) {
    const holds = (each, name) => namesOf(each).some(other => isSameName(other, name));
    const others = record.keptApart.flatMap(({ name, from }) => (holds(row, name) === holds(row, from) ? [] : [holds(row, name) ? from : name]));
    const apart = [];
    for (const other of others) {
        const owner = rows.find(each => holds(each, other));
        for (const each of owner ? namesOf(owner) : [other]) {
            if (!apart.some(kept => isSameName(kept, each))) apart.push(each);
        }
    }
    return apart;
}

/**
 * The record starting over after its book went missing, as when the user deleted it (§6): it names no book, so the
 * next entry makes one, and its written entries are forgotten, so each is due again. What the user and the name check
 * decided about a name stays: deleted, not a named character, another name of an entry, and a link to an entry of
 * another book.
 *
 * @param {object} record
 * @returns {object} a new record
 */
export function withBookStartedOver(record) {
    const entries = Object.entries(record.entries).filter(([, entry]) => entry.state !== RECORD_STATE.written);
    return { ...record, bookName: '', entries: Object.fromEntries(entries) };
}

/**
 * The record naming the book it writes into.
 *
 * @param {object} record
 * @param {string} bookName
 * @returns {object} a new record
 */
export function withBookName(record, bookName) {
    return { ...record, bookName };
}

// ---------------------------------------------------------------------------- Who gets an entry (§4.2, §5.1)

/**
 * Why a counted character gets no entry: one of its names, in any case, is the chat's character or a group chat's
 * member, the persona, a title or key of an entry in a book the chat loads that Entity-Lore did not write, or held as
 * a word in the character card's description. Null when none is.
 *
 * @param {{name: string, otherNames?: string[]}} row - From listEntities
 * @param {object} chat
 * @param {string[]} [chat.characterNames] - The chat's character, or a group chat's members
 * @param {string} [chat.personaName]
 * @param {LoreEntry[]} [chat.loreEntries] - The entries of the chat's books that Entity-Lore did not write
 * @param {(name: string) => boolean} [chat.isInCardDescription] - Whether the card's description holds a name as a word
 * @returns {string|null} one of EXCLUSION, or null
 */
export function exclusionOf(row, { characterNames = [], personaName = '', loreEntries = [], isInCardDescription = () => false } = {}) {
    const names = namesOf(row);
    const isAmong = list => list.some(other => String(other).trim() && names.some(name => isSameName(name, other)));
    if (isAmong(characterNames)) return EXCLUSION.chatCharacter;
    if (isAmong([personaName])) return EXCLUSION.persona;
    if (loreEntryNaming(row, loreEntries)) return EXCLUSION.lorebook;
    if (names.some(name => isInCardDescription(name))) return EXCLUSION.cardDescription;
    return null;
}

/**
 * The first entry of the chat's other books, in their order, whose title or a key is one of a counted character's
 * names, in any case: the entry an "Already in a lorebook" row names (E3 of entity-lore-names-across-languages.md).
 *
 * @param {{name: string, otherNames?: string[]}} row
 * @param {LoreEntry[]} loreEntries
 * @returns {LoreEntry|null}
 */
function loreEntryNaming(row, loreEntries) {
    const names = namesOf(row);
    return loreEntries.find(entry => entry.names.some(other => String(other).trim() && names.some(name => isSameName(name, other)))) ?? null;
}

/**
 * Where each counted character stands. The Entity-Lore tab's rows and every run read this one answer, and the same
 * names, counts and record always give the same one, so a row never flickers. What the record says comes first; a
 * name with no record is excluded, locked, waiting below Write at, or due.
 *
 * - A written entry is deleted by the user once its uid is gone from the book, locked while the user locked its
 *   character (T3), edited by the user once its text no longer matches the hash of its last write (D4), due again once
 *   its character's names changed, on StoryArc's Entity tab or by Allow again (D17, `namesChangedBy`), or its count
 *   reaches the count it was written at plus Rewrite every (§5.1), and written otherwise.
 * - A locked character is never due, so no run writes or rewrites it; one deleted, not named, another name of an
 *   entry or excluded stays so.
 * - A name the name check linked to an entry of another book reads as in that book while the link holds (E2,
 *   heldLinkOf), `lorebookEntry` naming the entry; one whose entry the chat no longer holds so reads as no record. A
 *   row excluded for a lorebook names the entry its name is in the same way (E3).
 * - A character Allow again kept apart from others carries their names (`keptApartFrom`, D18), which the name check
 *   reads (§4.3), whatever its state.
 *
 * @param {Array<{name: string, otherNames: string[], eventCount: number}>} rows - From listEntities, people
 * @param {object} options
 * @param {object} options.record - From readEntityLoreRecord
 * @param {number} options.writeAt - From writeAtEventsOf
 * @param {number} options.rewriteEvery - From rewriteEveryEventsOf
 * @param {object} [options.chat] - What exclusionOf reads
 * @param {Array<{uid: string|number, content: string}>} [options.bookEntries] - The entries Entity-Lore's book holds now
 * @returns {object[]} each row with its `state`, and as it applies `writeAt`, `uid`, `writtenAtEvents`, `namesChangedBy`,
 *   `sameAs`, `exclusion`, `lorebookEntry` or `keptApartFrom`
 */
export function entityLoreStates(rows, { record, writeAt, rewriteEvery, chat = {}, bookEntries = [] }) {
    const hashByUid = new Map(bookEntries.map(entry => [String(entry.uid), entryContentHash(entry.content)]));
    const loreEntries = chat.loreEntries ?? [];
    return rows.map((counted) => {
        const keptApartFrom = namesKeptApartFrom(record, counted, rows);
        const row = keptApartFrom.length ? { ...counted, keptApartFrom } : counted;
        const entry = recordOfName(record, row.name);
        if (entry?.state === RECORD_STATE.deleted) return { ...row, state: ENTITY_STATE.deletedByUser };
        if (entry?.state === RECORD_STATE.notNamed) return { ...row, state: ENTITY_STATE.notNamed };
        if (entry?.state === RECORD_STATE.sameAs) return { ...row, state: ENTITY_STATE.sameAs, sameAs: entry.sameAs };
        const linked = entry?.state === RECORD_STATE.inLorebook ? heldLinkOf(entry, loreEntries) : null;
        if (linked) return { ...row, state: ENTITY_STATE.inLorebook, lorebookEntry: linked };
        const isLocked = isCharacterLocked(record, row);
        if (entry?.state === RECORD_STATE.written) {
            const written = { uid: entry.uid, writtenAtEvents: entry.writtenAtEvents };
            if (!hashByUid.has(String(entry.uid))) return { ...row, ...written, state: ENTITY_STATE.deletedByUser };
            if (isLocked) return { ...row, ...written, state: ENTITY_STATE.locked };
            if (hashByUid.get(String(entry.uid)) !== entry.contentHash) return { ...row, ...written, state: ENTITY_STATE.editedByUser };
            if (entry.namesChangedBy) return { ...row, ...written, state: ENTITY_STATE.rewriteDue, namesChangedBy: entry.namesChangedBy };
            const isDueAgain = row.eventCount >= entry.writtenAtEvents + rewriteEvery;
            return { ...row, ...written, state: isDueAgain ? ENTITY_STATE.rewriteDue : ENTITY_STATE.written };
        }
        const exclusion = exclusionOf(row, chat);
        if (exclusion === EXCLUSION.lorebook) return { ...row, state: ENTITY_STATE.excluded, exclusion, lorebookEntry: loreEntryNaming(row, loreEntries) };
        if (exclusion) return { ...row, state: ENTITY_STATE.excluded, exclusion };
        if (isLocked) return { ...row, state: ENTITY_STATE.locked };
        if (row.eventCount < writeAt) return { ...row, state: ENTITY_STATE.waiting, writeAt };
        return { ...row, state: ENTITY_STATE.due };
    });
}

/**
 * The entries a run writes, from entityLoreStates: new entries before rewrites, each most events first, then by name;
 * at most `limit` of them (§4.1).
 *
 * @param {object[]} states
 * @param {number} [limit] - ENTRIES_PER_AUTOMATIC_RUN after an EventBase run; none for Run now
 * @returns {object[]}
 */
export function entriesForRun(states, limit = Number.POSITIVE_INFINITY) {
    const byMostEvents = (a, b) => (b.eventCount - a.eventCount) || a.name.localeCompare(b.name);
    const inState = state => states.filter(each => each.state === state).sort(byMostEvents);
    return [...inState(ENTITY_STATE.due), ...inState(ENTITY_STATE.rewriteDue)].slice(0, limit);
}

/**
 * The entry a row's button writes now (§3): a due character's, new; a written one's, again, due or not (Rewrite now);
 * and one the user edited, again from the entry as they left it (Rewrite anyway, D4), marked `isEditAccepted`. None
 * for a row in any other state, or a name no row has.
 *
 * @param {object[]} states - From entityLoreStates
 * @param {string} name - The row's kept name, in any case
 * @returns {object[]} no entry, or one, its state due or rewrite_due
 */
export function entriesForName(states, name) {
    const row = states.find(each => isSameName(each.name, name));
    if (row?.state === ENTITY_STATE.due) return [row];
    if (row?.state === ENTITY_STATE.written || row?.state === ENTITY_STATE.rewriteDue) return [{ ...row, state: ENTITY_STATE.rewriteDue }];
    if (row?.state === ENTITY_STATE.editedByUser) return [{ ...row, state: ENTITY_STATE.rewriteDue, isEditAccepted: true }];
    return [];
}

/**
 * How many entries are due, new and again, which Run now's question names (§4.1).
 *
 * @param {object[]} states - From entityLoreStates
 * @returns {{newCount: number, rewriteCount: number}}
 */
export function dueCounts(states) {
    return {
        newCount: states.filter(each => each.state === ENTITY_STATE.due).length,
        rewriteCount: states.filter(each => each.state === ENTITY_STATE.rewriteDue).length,
    };
}

/**
 * An entry's keys (§4.5): its kept name and other names, then every key the entry already has that is none of them,
 * in any case, which keeps the keys the user added and the names the name check matched to it. Each name once.
 *
 * @param {{name: string, otherNames?: string[]}} row
 * @param {string[]} [currentKeys] - The entry's keys now, on a rewrite
 * @returns {string[]}
 */
export function entryKeysOf(row, currentKeys = []) {
    const keys = [];
    for (const key of [row.name, ...(row.otherNames ?? []), ...currentKeys].map(each => String(each).trim())) {
        if (key && !keys.some(kept => isSameName(kept, key))) keys.push(key);
    }
    return keys;
}

// ---------------------------------------------------------------------------- The input cut (§4.4)

// A DateTime as EventBase stores it, ISO 8601 from toISOString: its date, and its hour and minute.
const STORED_DATE_TIME = /^([+-]?\d{4,6}-\d{2}-\d{2})T(\d{2}:\d{2})/u;

/**
 * An event as an entry's call reads it (§4.4): with one time, so the entries of a chat give their times one way. Its
 * DateTime, ISO 8601 in every chat, as "2026-04-08 18:58"; its scene_time, as the story wrote it, only where it has no
 * DateTime, as on a calendar of the story's own. The event given stays as it is.
 *
 * @param {object} event - A stored event
 * @returns {object}
 */
export function withOneEventTime(event) {
    if (!event.DateTime) return event;
    const parts = STORED_DATE_TIME.exec(String(event.DateTime));
    return { ...event, DateTime: parts ? `${parts[1]} ${parts[2]}` : event.DateTime, scene_time: '' };
}

/**
 * A character's events, one line each and oldest first, cut into the slices a call reads: one slice while they fit in
 * `maxTokens`, else slices of up to `maxTokens` each, oldest first, each read by a notes call. A line longer than that
 * is a slice of its own.
 *
 * @param {string[]} lines
 * @param {(text: string) => number} estimateTokens
 * @param {number} [maxTokens]
 * @returns {string[][]}
 */
export function sliceEventLines(lines, estimateTokens, maxTokens = EVENT_SLICE_TOKENS) {
    const slices = [];
    let slice = [];
    let sliceTokens = 0;
    for (const line of lines) {
        const lineTokens = estimateTokens(line);
        if (slice.length && sliceTokens + lineTokens > maxTokens) {
            slices.push(slice);
            slice = [];
            sliceTokens = 0;
        }
        slice.push(line);
        sliceTokens += lineTokens;
    }
    if (slice.length) slices.push(slice);
    return slices;
}

// ---------------------------------------------------------------------------- A run (§4.1, §4.3, §4.6)

/**
 * The book Entity-Lore writes a chat's entries into (D1), before SillyTavern makes it a file name and numbers it.
 *
 * @param {string} chatName
 * @returns {string}
 */
export function npcBookName(chatName) {
    return `VectFox NPCs - ${chatName}`;
}

/**
 * The titles of the entries a record says Entity-Lore wrote, each a kept name: the first titles the name check is shown
 * and matches a same_as against (nameCheckTitles).
 *
 * @param {{entries: Record<string, object>}} record
 * @returns {string[]}
 */
function writtenEntryTitles(record) {
    return Object.entries(record.entries).filter(([, entry]) => entry.state === RECORD_STATE.written).map(([name]) => name);
}

// A title bare (E1 of entity-lore-names-across-languages.md): its leading bracketed tags and a trailing note in
// parentheses taken off, in any case, as a book's titles carry tags and notes a model leaves off: "Orla" for
// "[👤] Orla". LoreBase's entryTitle takes off one category prefix only, so "[DLC][角色][Orla]" keeps "[角色][Orla]".
const LEADING_TAGS = /^(?:\s*(?:\[[^\]]*\]|【[^】]*】))+/u;
const TRAILING_NOTE = /[(（][^()（）]*[)）]\s*$/u;
export const bareTitle = title => String(title).replace(LEADING_TAGS, '').replace(TRAILING_NOTE, '').trim().toLowerCase();

// The name check's second ask (E5 of entity-lore-names-across-languages.md) shows under a title at most this many of
// its entries' author keys; a word of a bare title this long or longer makes a key holding it a form of the title.
const KEYS_SHOWN_PER_TITLE = 8;
const SHORTEST_TITLE_WORD = 3;

/**
 * The author keys the name check's second ask shows under a title (E5): in the author's order, each once in any case,
 * at most KEYS_SHOWN_PER_TITLE, and none that is a form of the title, inside its bare title or holding a word of it, or
 * a form of a key shown before it, inside that key or holding it. So "Wren" shows under "[NPC] Orla Vance", and "Orla"
 * and "Lady Orla" do not.
 *
 * @param {string} title
 * @param {string[]} keys - The author's keys of every entry the title names, in book order
 * @returns {string[]}
 */
function keysShownUnderTitle(title, keys) {
    const bare = bareTitle(title);
    const titleWords = bare.split(/\s+/u).filter(word => word.length >= SHORTEST_TITLE_WORD);
    const shown = [];
    for (const key of keys.map(each => String(each).trim()).filter(Boolean)) {
        if (shown.length === KEYS_SHOWN_PER_TITLE) break;
        const folded = key.toLowerCase();
        const isTitleForm = bare.includes(folded) || titleWords.some(word => folded.includes(word));
        const isShownForm = shown.some(each => each.toLowerCase().includes(folded) || folded.includes(each.toLowerCase()));
        if (!isTitleForm && !isShownForm) shown.push(key);
    }
    return shown;
}

/**
 * The titles the name check is shown (§4.3, E1 of entity-lore-names-across-languages.md): those of the entries
 * Entity-Lore wrote, then those of the entries of every other book the chat loads, in their order, each once in any
 * case, so a name the chat writes in another language than a book can be linked to its character's entry there; those
 * of them that title more than one entry, which a same_as links to none; and the author keys the second ask shows under
 * each title of another book's entries that has any (keysShownUnderTitle, E5), the keys of every entry it titles merged.
 *
 * @param {{entries: Record<string, object>}} record
 * @param {LoreEntry[]} loreEntries
 * @returns {{entryTitles: string[], sharedTitles: string[], keysByTitle: Map<string, string[]>}} keysByTitle by the
 *   title as entryTitles spells it
 */
export function nameCheckTitles(record, loreEntries) {
    const byTitle = new Map();
    const add = (title, keys) => {
        const shown = String(title).trim();
        if (!shown) return;
        const known = byTitle.get(shown.toLowerCase());
        if (known) {
            known.count += 1;
            known.keys.push(...keys);
        } else {
            byTitle.set(shown.toLowerCase(), { title: shown, count: 1, keys: [...keys] });
        }
    };
    for (const title of writtenEntryTitles(record)) add(title, []);
    for (const entry of loreEntries) add(entry.title, entry.keys);
    const titles = [...byTitle.values()];
    const keysByTitle = new Map();
    for (const { title, keys } of titles) {
        const shownKeys = keysShownUnderTitle(title, keys);
        if (shownKeys.length) keysByTitle.set(title, shownKeys);
    }
    return { entryTitles: titles.map(each => each.title), sharedTitles: titles.filter(each => each.count > 1).map(each => each.title), keysByTitle };
}

/**
 * The names the name check matched to a kept name, same_as it in any case: its entry reads their events too and is
 * keyed by them (§4.3, §4.4).
 *
 * @param {{entries: Record<string, object>}} record
 * @param {string} name
 * @returns {string[]}
 */
export function namesMatchedTo(record, name) {
    return Object.entries(record.entries)
        .filter(([, entry]) => entry.state === RECORD_STATE.sameAs && isSameName(entry.sameAs ?? '', name))
        .map(([other]) => other);
}

/**
 * Run now's question (§4.1), in plain words: what it writes, into which lorebook, and the requests it makes on
 * LoreBase's model. The name check comes first only when there are new entries. Lines for confirmPopup, each count
 * and the book's name a value, never part of a fixed sentence.
 *
 * @param {object} run
 * @param {number} run.newCount - From dueCounts; with rewriteCount, at least one above 0
 * @param {number} run.rewriteCount
 * @param {string} run.bookName - The chat's book, or the one its first entry makes
 * @param {boolean} run.isBookMade - Whether that book is made yet
 * @returns {object[]} confirmPopup's lines (src/sillytavern/popup-core.js)
 */
export function runNowQuestion({ newCount, rewriteCount, bookName, isBookMade }) {
    const countOf = number => ({ name: String(number) });
    const book = { name: bookName };
    if (!newCount) {
        return [
            { icon: 'fa-users-viewfinder', parts: [{ text: 'Rewrite ' }, countOf(rewriteCount), { text: rewriteCount === 1 ? ' lorebook entry?' : ' lorebook entries?' }] },
            { parts: [{ text: "Each is written again from the character's whole story so far, in this chat's lorebook " }, book, { text: '.' }] },
            { text: "Each takes one request to LoreBase's model, a few for a very long story, and LoreBase writes their keys and vectors again." },
        ];
    }
    const rewrites = rewriteCount
        ? [{ text: ', and rewrite ' }, countOf(rewriteCount), { text: rewriteCount === 1 ? ' existing one?' : ' existing ones?' }]
        : [{ text: '?' }];
    return [
        {
            icon: 'fa-users-viewfinder',
            parts: [
                { text: newCount === 1 ? 'Write a lorebook entry for ' : 'Write lorebook entries for ' }, countOf(newCount),
                { text: newCount === 1 ? ' character' : ' characters' }, ...rewrites,
            ],
        },
        {
            parts: [
                { text: isBookMade ? "One entry per character, from the story's events about them, into this chat's lorebook "
                    : "One entry per character, from the story's events about them, into a new lorebook for this chat, " },
                book, { text: '.' },
            ],
        },
        {
            text: "First, one request to LoreBase's model checks which names are named characters: a job or a title gets no entry, "
                + "and another name of a character joins that character's entry. A second request looks for the named ones among the "
                + "keys of the chat's other lorebooks, when they have keys. Each entry then takes one more request, a few for a very "
                + 'long story, and LoreBase writes their keys and vectors.',
        },
        ...(rewriteCount ? [{ text: "A rewrite writes an existing entry again from the character's whole story so far, one request each." }] : []),
    ];
}

/**
 * The question a split on StoryArc's Entity tab asks at once (D21), when it splits a name off a character whose entry
 * Entity-Lore wrote: whether the next run writes the entry again from scratch, without the split name's events, or
 * leaves its text as it stands. Either way the split name comes off the entry's keys. Lines for confirmPopup, each name
 * a value, never part of a fixed sentence.
 *
 * @param {{title: string, splitName: string}} split - title: the entry's, as the record spells it
 * @returns {object[]} confirmPopup's lines (src/sillytavern/popup-core.js)
 */
export function splitQuestion({ title, splitName }) {
    return [
        { icon: 'fa-code-branch', parts: [{ text: 'Write the lorebook entry for ' }, { name: title }, { text: ' again from scratch?' }] },
        { parts: [{ text: 'It was written with the events of ' }, { name: splitName }, { text: ' too, the name just split off.' }] },
        {
            text: "Write again: the next run writes it from the events of the names it keeps, with requests to LoreBase's model. "
                + 'Keep as it is: its text stays as it stands.',
        },
        { parts: [{ text: 'Either way, ' }, { name: splitName }, { text: ' comes off its keys.' }] },
    ];
}

/**
 * What a run did, for the progress panel and the console (§3's status line): the entries written and rewritten, and how
 * many failed, whose reasons are in the console.
 *
 * @param {{written: number, rewritten: number, failed: number}} outcome
 * @returns {string}
 */
export function runOutcomeText({ written, rewritten, failed }) {
    const parts = [`${counted(written, 'entry', 'entries')} written`];
    if (rewritten) parts.push(`${rewritten} rewritten`);
    if (failed) parts.push(`${failed} failed (see the console)`);
    return parts.join(', ');
}
