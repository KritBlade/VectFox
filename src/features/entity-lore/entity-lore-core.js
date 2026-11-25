/**
 * ============================================================================
 * ENTITY-LORE, PURE
 * ============================================================================
 * Which named characters get a lorebook entry, and when one is written again
 * (InternalProject/Vectfox/plans/entity-lore.md §4.2, §4.4, §4.5, §5, §6): the
 * switch and the two counts, read from settings and kept in their ranges; the
 * names a chat already has a place for; where each counted character stands,
 * which the Entity-Lore tab's rows and a run both read, so the two never
 * disagree; the entries a run writes; an entry's keys; the record kept in the
 * collection's metadata; and the cut of a character's events into slices one
 * call can read.
 *
 * Pure: no host or feature imports. What another feature knows, such as
 * whether the card's description holds a name or how many tokens a text is,
 * comes in as a function.
 * ============================================================================
 */

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
/** The most tokens of events one call reads; more go in slices, each read by a notes call (§4.4). A starting value, tuned in V2. */
export const EVENT_SLICE_TOKENS = 30000;

/** What the record says of a kept name (§6). */
export const RECORD_STATE = Object.freeze({ written: 'written', notNamed: 'not_named', sameAs: 'same_as', deleted: 'deleted' });
const RECORD_STATES = new Set(Object.values(RECORD_STATE));

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
    excluded: 'excluded',
});

/** A name in any case, and with spaces around it, is the same name, as a model writes a name in more than one case. */
const isSameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

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

// ---------------------------------------------------------------------------- The record (§6)

/**
 * A collection's Entity-Lore record, from its metadata's `entityLore`: the book it writes into, and what it knows of
 * each kept name. A kept name whose record is not one of RECORD_STATE's reads as having none.
 *
 * @param {unknown} stored
 * @returns {{bookName: string, entries: Record<string, object>}} a new object
 */
export function readEntityLoreRecord(stored) {
    const storedEntries = isPlainObject(stored) && isPlainObject(stored.entries) ? stored.entries : {};
    const entries = Object.fromEntries(Object.entries(storedEntries)
        .filter(([, entry]) => isPlainObject(entry) && RECORD_STATES.has(entry.state))
        .map(([name, entry]) => [name, { ...entry }]));
    return { bookName: isPlainObject(stored) && typeof stored.bookName === 'string' ? stored.bookName : '', entries };
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
 * The record with an entry written for a kept name: its uid, the count it was written at, and its text's hash.
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
 * The record without a kept name's entry, in any case: Allow again, after which the name is counted as if new.
 *
 * @param {object} record
 * @param {string} name
 * @returns {object} a new record
 */
export function withEntryForgotten(record, name) {
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

/**
 * The record starting over after its book went missing, as when the user deleted it (§6): it names no book, so the
 * next entry makes one, and its written entries are forgotten, so each is due again. What the user and the name check
 * decided about a name stays: deleted, not a named character, and another name of an entry.
 *
 * @param {object} record
 * @returns {object} a new record
 */
export function withBookStartedOver(record) {
    const entries = Object.entries(record.entries).filter(([, entry]) => entry.state !== RECORD_STATE.written);
    return { bookName: '', entries: Object.fromEntries(entries) };
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
 * @param {string[]} [chat.loreNames] - The titles and keys of entries in the chat's books that Entity-Lore did not write
 * @param {(name: string) => boolean} [chat.isInCardDescription] - Whether the card's description holds a name as a word
 * @returns {string|null} one of EXCLUSION, or null
 */
export function exclusionOf(row, { characterNames = [], personaName = '', loreNames = [], isInCardDescription = () => false } = {}) {
    const names = [row.name, ...(row.otherNames ?? [])];
    const isAmong = list => list.some(other => String(other).trim() && names.some(name => isSameName(name, other)));
    if (isAmong(characterNames)) return EXCLUSION.chatCharacter;
    if (isAmong([personaName])) return EXCLUSION.persona;
    if (isAmong(loreNames)) return EXCLUSION.lorebook;
    if (names.some(name => isInCardDescription(name))) return EXCLUSION.cardDescription;
    return null;
}

/**
 * Where each counted character stands. The Entity-Lore tab's rows and every run read this one answer, and the same
 * names, counts and record always give the same one, so a row never flickers. What the record says comes first; a
 * name with no record is excluded, waiting below Write at, or due.
 *
 * - A written entry is deleted by the user once its uid is gone from the book, edited by the user once its text no
 *   longer matches the hash of its last write (D4), due again once its count reaches the count it was written at plus
 *   Rewrite every (§5.1), and written otherwise.
 *
 * @param {Array<{name: string, otherNames: string[], eventCount: number}>} rows - From listEntities, people
 * @param {object} options
 * @param {object} options.record - From readEntityLoreRecord
 * @param {number} options.writeAt - From writeAtEventsOf
 * @param {number} options.rewriteEvery - From rewriteEveryEventsOf
 * @param {object} [options.chat] - What exclusionOf reads
 * @param {Array<{uid: string|number, content: string}>} [options.bookEntries] - The entries Entity-Lore's book holds now
 * @returns {object[]} each row with its `state`, and as it applies `writeAt`, `uid`, `writtenAtEvents`, `sameAs` or `exclusion`
 */
export function entityLoreStates(rows, { record, writeAt, rewriteEvery, chat = {}, bookEntries = [] }) {
    const hashByUid = new Map(bookEntries.map(entry => [String(entry.uid), entryContentHash(entry.content)]));
    return rows.map((row) => {
        const entry = recordOfName(record, row.name);
        if (entry?.state === RECORD_STATE.deleted) return { ...row, state: ENTITY_STATE.deletedByUser };
        if (entry?.state === RECORD_STATE.notNamed) return { ...row, state: ENTITY_STATE.notNamed };
        if (entry?.state === RECORD_STATE.sameAs) return { ...row, state: ENTITY_STATE.sameAs, sameAs: entry.sameAs };
        if (entry?.state === RECORD_STATE.written) {
            const written = { uid: entry.uid, writtenAtEvents: entry.writtenAtEvents };
            if (!hashByUid.has(String(entry.uid))) return { ...row, ...written, state: ENTITY_STATE.deletedByUser };
            if (hashByUid.get(String(entry.uid)) !== entry.contentHash) return { ...row, ...written, state: ENTITY_STATE.editedByUser };
            const isDueAgain = row.eventCount >= entry.writtenAtEvents + rewriteEvery;
            return { ...row, ...written, state: isDueAgain ? ENTITY_STATE.rewriteDue : ENTITY_STATE.written };
        }
        const exclusion = exclusionOf(row, chat);
        if (exclusion) return { ...row, state: ENTITY_STATE.excluded, exclusion };
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
