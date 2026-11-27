/**
 * Tests for Entity-Lore's pure rules (src/features/entity-lore/entity-lore-core.js, plan §4.2, §4.4, §4.5, §5, §6 of
 * InternalProject/Vectfox/plans/entity-lore.md).
 *
 * Guards that:
 *   - the switch is off unless turned on, and Write at and Rewrite every read as whole numbers in their ranges,
 *   - the record reads back only what it can use, finds a kept name in any case, and each change gives a new record,
 *   - a character is locked by any of its names and unlocked by all of them; a locked one is never due, its entry kept,
 *   - a missing book starts the record over: its written entries are due again, the user's and the name check's answers kept,
 *   - names merged into one entity make its entry the kept name's, or else the first other name's the book holds, moved
 *     to the kept name with the names matched to it, and due again; another name's entry is named; a name split off one
 *     makes the kept name's entry due again, written afresh, which a later merge leaves so, unless the name check
 *     matched the name to it; Allow again on a name the name check matched does so to the entry it was matched to,
 *     and keeps the two apart, each pair once,
 *   - a character kept apart from others names them, on both sides and with every merged name, whatever its state,
 *     but none once the two are merged,
 *   - an entry's hash ignores line endings and the ends of its text, so SillyTavern's own save is not the user's edit,
 *   - a character is excluded by any of its names, in any case: the chat's character, the persona, another lorebook's
 *     entry, or the card's description; a row excluded for a lorebook names the entry whose title, bare, is its name,
 *     else the first entry its name is in, while only an entry's title as written or a key leaves the name out,
 *   - a name the name check linked to an entry of another book reads as in that book while the chat holds the entry
 *     under its title, and as no record once it does not; the links that hold are listed for their keys; Allow again
 *     on one keeps the name apart from that title and names the entry to take it off; a missing book keeps them,
 *   - the name check is shown Entity-Lore's titles, then the other books', each once in any case, the titles of more
 *     than one entry named; its second ask, each other book's title with at most 8 of its author keys, in order, each
 *     once, none a form of the title or of a key shown before it, the keys of entries sharing a title merged,
 *   - each character's state follows the record first, then the exclusions and Write at, and a rewrite falls due at
 *     the count it was written at plus Rewrite every, or at once when its names changed, on StoryArc's Entity tab or by
 *     Allow again,
 *   - what keeps Entity-Lore from running is named first by LoreBase, then StoryArc mode, then LoreBase's model, each
 *     with its fix and where the panel makes it,
 *   - a run writes new entries before rewrites, most events first, at most its limit; a row's button writes its own
 *     character's entry, new or again, an edited one only as accepted,
 *   - an entry's keys are its names, then the keys it already had, each once in any case,
 *   - an event as an entry's call reads it has one time: its DateTime to the minute, or else its scene_time,
 *   - a character's events are cut into slices that fit, oldest first,
 *   - Run now's question says in plain words what it writes, into which lorebook, and the requests it makes, each
 *     count and the book's name a value,
 *   - a split asks whether the entry is written again from scratch, or kept as it is, the names values.
 *
 * Names are made up and match no story.
 */

import { describe, it, expect } from 'vitest';
import {
    ENTITY_LORE_FIX_AT, ENTITY_LORE_NEED, ENTITY_STATE, ENTRIES_PER_AUTOMATIC_RUN, EVENT_SLICE_TOKENS, EXCLUSION, NAMES_CHANGED_BY, RECORD_STATE,
    REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS, dueCounts, entityLoreBlocker, entityLoreStates, entriesForName, entriesForRun, entryContentHash,
    entryKeysOf, exclusionOf, heldLinks, isEntityLoreOn,
    isCharacterLocked, isWrittenAfreshAfter, nameCheckTitles, readEntityLoreRecord, recordOfName, rewriteEveryEventsOf, runNowQuestion,
    sliceEventLines, splitQuestion, withBookName,
    withBookStartedOver, withCharacterLocked, withMergedEntry, withMissingEntriesDeleted, withNameAllowedAgain, withNameCheckAnswer,
    withNameInLorebook, withOneEventTime, withSplitName, withWrittenEntry,
    writeAtEventsOf,
} from '../src/features/entity-lore/entity-lore-core.js';

const row = (name, eventCount, otherNames = []) => ({ name, otherNames, eventCount });
const emptyRecord = () => readEntityLoreRecord(undefined);
// An entry of another book the chat loads, as chatExclusions in entity-lore.js reads it.
const loreEntry = (bookName, uid, title, keys = [], standing = {}) => ({
    bookName, uid: String(uid), title, names: [title, ...keys].filter(Boolean), keys: [...keys], isDecidedHere: false, isConstant: false, ...standing,
});

describe('the settings', () => {
    it('keep Entity-Lore off unless it was turned on', () => {
        expect(isEntityLoreOn({})).toBe(false);
        expect(isEntityLoreOn({ entity_lore_enabled: 'true' })).toBe(false);
        expect(isEntityLoreOn({ entity_lore_enabled: true })).toBe(true);
        expect(isEntityLoreOn(undefined)).toBe(false);
    });

    it('read Write at and Rewrite every as whole numbers in their ranges, or their defaults', () => {
        expect([writeAtEventsOf(undefined), writeAtEventsOf('x'), writeAtEventsOf('12'), writeAtEventsOf(2), writeAtEventsOf(99)])
            .toEqual([WRITE_AT_EVENTS.default, WRITE_AT_EVENTS.default, 12, WRITE_AT_EVENTS.min, WRITE_AT_EVENTS.max]);
        expect([rewriteEveryEventsOf(null), rewriteEveryEventsOf(45.7), rewriteEveryEventsOf(5), rewriteEveryEventsOf(500)])
            .toEqual([REWRITE_EVERY_EVENTS.default, 45, REWRITE_EVERY_EVENTS.min, REWRITE_EVERY_EVENTS.max]);
        expect([WRITE_AT_EVENTS, REWRITE_EVERY_EVENTS]).toEqual([{ default: 10, min: 3, max: 50 }, { default: 30, min: 10, max: 100 }]);
    });
});

describe('the record', () => {
    it('reads back only the book name, the entries, the locked names and the names kept apart it can use', () => {
        expect(emptyRecord()).toEqual({ bookName: '', entries: {}, lockedNames: [], keptApart: [] });
        expect(readEntityLoreRecord({ bookName: 7, entries: [], lockedNames: 'Mira', keptApart: {} }))
            .toEqual({ bookName: '', entries: {}, lockedNames: [], keptApart: [] });
        const stored = {
            bookName: 'VectFox NPCs - Harbor',
            entries: { Mira: { state: 'written', uid: '4', writtenAtEvents: 12, contentHash: '9' }, Corin: { state: 'lost' }, Tess: 'written' },
            lockedNames: ['Corin', ' ', 7, 'Bram'],
            keptApart: [{ name: 'Corrie', from: 'Corin', note: 'x' }, { name: 'Bram' }, 'Tess', { name: ' ', from: 'Mira' }, null],
        };
        expect(readEntityLoreRecord(stored)).toEqual({
            bookName: 'VectFox NPCs - Harbor', entries: { Mira: stored.entries.Mira }, lockedNames: ['Corin', 'Bram'], keptApart: [{ name: 'Corrie', from: 'Corin' }],
        });
        expect(readEntityLoreRecord(stored).entries.Mira).not.toBe(stored.entries.Mira);
    });

    it('records a written entry under its kept name, replacing the same name in another case, in a new record', () => {
        const before = withNameCheckAnswer(emptyRecord(), 'MIRA', { state: RECORD_STATE.notNamed });
        const after = withWrittenEntry(before, 'Mira', { uid: 4, writtenAtEvents: 12, content: 'Text' });
        expect(after.entries).toEqual({ Mira: { state: 'written', uid: '4', writtenAtEvents: 12, contentHash: entryContentHash('Text') } });
        expect(before.entries).toEqual({ MIRA: { state: 'not_named' } });
        expect(recordOfName(after, 'mira')).toBe(after.entries.Mira);
        expect(recordOfName(after, 'Corin')).toBeNull();
    });

    it("records the name check's answer: not a named character, or another name of an entry", () => {
        let record = withNameCheckAnswer(emptyRecord(), 'the bus driver', { state: RECORD_STATE.notNamed, sameAs: 'ignored' });
        record = withNameCheckAnswer(record, 'Corrie', { state: RECORD_STATE.sameAs, sameAs: 'Corin' });
        expect(record.entries).toEqual({ 'the bus driver': { state: 'not_named' }, Corrie: { state: 'same_as', sameAs: 'Corin' } });
    });

    it('forgets a kept name in any case on Allow again', () => {
        const record = withNameCheckAnswer(withNameCheckAnswer(emptyRecord(), 'Bram', { state: RECORD_STATE.notNamed }), 'Tess', { state: RECORD_STATE.notNamed });
        expect(withNameAllowedAgain(record, 'BRAM', []))
            .toEqual({ record: { ...record, entries: { Tess: { state: 'not_named' } } }, keptApartFrom: null, matchedEntryUid: null, lorebookEntry: null });
    });

    it('marks deleted only the written entries whose uid the book no longer holds', () => {
        let record = withWrittenEntry(emptyRecord(), 'Mira', { uid: 4, writtenAtEvents: 12, content: 'a' });
        record = withWrittenEntry(record, 'Corin', { uid: 9, writtenAtEvents: 20, content: 'b' });
        record = withNameCheckAnswer(record, 'Tess', { state: RECORD_STATE.notNamed });
        const after = withMissingEntriesDeleted(record, [9, 11]);
        expect(Object.fromEntries(Object.entries(after.entries).map(([name, entry]) => [name, entry.state])))
            .toEqual({ Mira: 'deleted', Corin: 'written', Tess: 'not_named' });
        expect(after.entries.Mira.uid).toBe('4');
        expect(record.entries.Mira.state).toBe('written');
    });

    it('starts over when its book is missing: no book named, written entries due again, the other answers kept', () => {
        let record = withBookName(emptyRecord(), 'VectFox NPCs - Harbor');
        record = withWrittenEntry(record, 'Mira', { uid: 4, writtenAtEvents: 12, content: 'a' });
        record = withMissingEntriesDeleted(withWrittenEntry(record, 'Bram', { uid: 5, writtenAtEvents: 12, content: 'b' }), [4]);
        record = withNameCheckAnswer(record, 'the bus driver', { state: RECORD_STATE.notNamed });
        record = withNameCheckAnswer(record, 'Corrie', { state: RECORD_STATE.sameAs, sameAs: 'Corin' });
        const after = withBookStartedOver(withCharacterLocked(record, row('Bram', 12), true));
        expect(after.bookName).toBe('');
        expect(after.lockedNames).toEqual(['Bram']);
        expect(Object.keys(after.entries)).toEqual(['Bram', 'the bus driver', 'Corrie']);
        expect(entityLoreStates([row('Mira', 40)], { record: after, writeAt: 10, rewriteEvery: 30 })[0].state).toBe(ENTITY_STATE.due);
        expect(record.entries.Mira.state).toBe('written');
    });

    it('names its book', () => {
        expect(withBookName(emptyRecord(), 'VectFox NPCs - Harbor (2)').bookName).toBe('VectFox NPCs - Harbor (2)');
    });

    it("hashes an entry's text the same whatever its line endings and the space at its ends, and different text differently", () => {
        expect(entryContentHash('[Identity]\r\nMira\r\n')).toBe(entryContentHash('  [Identity]\nMira'));
        expect(entryContentHash('[Identity]\nMira')).not.toBe(entryContentHash('[Identity]\nMira, a sailor'));
        expect(entryContentHash(undefined)).toBe(entryContentHash(''));
    });
});

describe('exclusionOf', () => {
    const chat = {
        characterNames: ['Captain Oswin', 'Wren'],
        personaName: 'Ash',
        loreEntries: [loreEntry('Harbor Atlas', 1, 'Harbor Watch'), loreEntry('Harbor Atlas', 2, '', ['Tidewardens'])],
        isInCardDescription: name => ['Gull'].includes(name),
    };

    it('excludes the chat\'s character or a group member, the persona, another lorebook\'s entry and the card\'s description, in that order', () => {
        expect(exclusionOf(row('wren', 30), chat)).toBe(EXCLUSION.chatCharacter);
        expect(exclusionOf(row('ASH ', 30), chat)).toBe(EXCLUSION.persona);
        expect(exclusionOf(row('Tidewardens', 30), chat)).toBe(EXCLUSION.lorebook);
        expect(exclusionOf(row('Gull', 30), chat)).toBe(EXCLUSION.cardDescription);
        expect(exclusionOf(row('Wren', 30, ['Ash']), chat)).toBe(EXCLUSION.chatCharacter);
    });

    it('excludes by an other name too, and nothing else', () => {
        expect(exclusionOf(row('The Captain', 30, ['captain oswin']), chat)).toBe(EXCLUSION.chatCharacter);
        expect(exclusionOf(row('Mira', 30, ['Mirabel']), chat)).toBeNull();
        expect(exclusionOf(row('Mira', 30), {})).toBeNull();
        expect(exclusionOf(row('Mira', 30), { personaName: '', characterNames: ['  '] })).toBeNull();
    });
});

describe('entityLoreStates', () => {
    const options = { writeAt: 10, rewriteEvery: 30 };
    const stateOf = (rows, extra = {}) => entityLoreStates(rows, { record: emptyRecord(), ...options, ...extra })
        .map(each => [each.name, each.state, each.writeAt ?? each.writtenAtEvents ?? each.sameAs ?? each.exclusion ?? null]);

    it('makes a name with no record due at Write at, waiting below it, and excluded whatever its count', () => {
        expect(stateOf([row('Mira', 10), row('Corin', 9), row('Wren', 40)], { chat: { characterNames: ['Wren'] } })).toEqual([
            ['Mira', ENTITY_STATE.due, null],
            ['Corin', ENTITY_STATE.waiting, 10],
            ['Wren', ENTITY_STATE.excluded, EXCLUSION.chatCharacter],
        ]);
    });

    it('follows a written entry: written, due again at its count plus Rewrite every, edited by the user, or deleted', () => {
        let record = withWrittenEntry(emptyRecord(), 'Mira', { uid: 1, writtenAtEvents: 12, content: 'Mira text' });
        record = withWrittenEntry(record, 'Corin', { uid: 2, writtenAtEvents: 12, content: 'Corin text' });
        record = withWrittenEntry(record, 'Tess', { uid: 3, writtenAtEvents: 12, content: 'Tess text' });
        record = withWrittenEntry(record, 'Bram', { uid: 4, writtenAtEvents: 12, content: 'Bram text' });
        const bookEntries = [
            { uid: 1, content: 'Mira text' },
            { uid: '2', content: 'Corin text\r\n' },
            { uid: 3, content: 'Tess text, changed by hand' },
        ];
        expect(stateOf([row('Mira', 41), row('Corin', 42), row('Tess', 80), row('Bram', 50)], { record, bookEntries })).toEqual([
            ['Mira', ENTITY_STATE.written, 12],
            ['Corin', ENTITY_STATE.rewriteDue, 12],
            ['Tess', ENTITY_STATE.editedByUser, 12],
            ['Bram', ENTITY_STATE.deletedByUser, 12],
        ]);
    });

    it("puts the record first, found in any case, over the exclusions and Write at", () => {
        let record = withNameCheckAnswer(emptyRecord(), 'the bus driver', { state: RECORD_STATE.notNamed });
        record = withNameCheckAnswer(record, 'Corrie', { state: RECORD_STATE.sameAs, sameAs: 'Corin' });
        record = withMissingEntriesDeleted(withWrittenEntry(record, 'Tess', { uid: 3, writtenAtEvents: 12, content: 'a' }), []);
        const chat = { characterNames: ['Tess'] };
        expect(stateOf([row('The Bus Driver', 30), row('corrie', 2), row('Tess', 50)], { record, chat })).toEqual([
            ['The Bus Driver', ENTITY_STATE.notNamed, null],
            ['corrie', ENTITY_STATE.sameAs, 'Corin'],
            ['Tess', ENTITY_STATE.deletedByUser, null],
        ]);
    });

    it('makes an entry due again at once when its names changed on StoryArc (D17), unless the user edited or locked it', () => {
        const uids = [0, 1, 2, 3];
        let record = emptyRecord();
        for (const [uid, name] of ['Mira', 'Corin', 'Tess', 'Bram'].entries()) record = withWrittenEntry(record, name, { uid, writtenAtEvents: 12, content: name });
        record = withSplitName(record, { keptName: 'Mira', splitName: 'Mirabel' }, uids).record;
        for (const name of ['Corin', 'Tess', 'Bram']) record = withMergedEntry(record, { keptName: name, otherNames: [`${name} Vale`] }, uids).record;
        record = withCharacterLocked(record, row('Bram', 13), true);
        const bookEntries = [{ uid: 0, content: 'Mira' }, { uid: 1, content: 'Corin' }, { uid: 2, content: 'Tess, changed by hand' }, { uid: 3, content: 'Bram' }];
        const states = entityLoreStates([row('Mira', 13), row('Corin', 13), row('Tess', 13), row('Bram', 13)], { record, ...options, bookEntries });
        expect(states.map(({ name, state, namesChangedBy = null }) => [name, state, namesChangedBy])).toEqual([
            ['Mira', ENTITY_STATE.rewriteDue, NAMES_CHANGED_BY.split],
            ['Corin', ENTITY_STATE.rewriteDue, NAMES_CHANGED_BY.merge],
            ['Tess', ENTITY_STATE.editedByUser, null],
            ['Bram', ENTITY_STATE.locked, null],
        ]);
        expect(entriesForName(states, 'Mira')).toEqual([expect.objectContaining({ state: ENTITY_STATE.rewriteDue, namesChangedBy: NAMES_CHANGED_BY.split })]);
        const rewritten = withWrittenEntry(record, 'Mira', { uid: 0, writtenAtEvents: 13, content: 'Mira again' });
        expect(entityLoreStates([row('Mira', 13)], { record: rewritten, ...options, bookEntries: [{ uid: 0, content: 'Mira again' }] })[0].state)
            .toBe(ENTITY_STATE.written);
    });

    it('names the characters Allow again kept a row apart from, on both sides and with every merged name, whatever its state, but none once the two are merged (D18)', () => {
        const rows = [row('Corin', 30, ['Corin Vale']), row('corrie', 12), row('Tess', 12)];
        const record = withCharacterLocked({ ...emptyRecord(), keptApart: [{ name: 'Corrie', from: 'Corin' }] }, rows[0], true);
        expect(entityLoreStates(rows, { record, ...options }).map(({ name, state, keptApartFrom = [] }) => [name, state, keptApartFrom])).toEqual([
            ['Corin', ENTITY_STATE.locked, ['corrie']], ['corrie', ENTITY_STATE.due, ['Corin', 'Corin Vale']], ['Tess', ENTITY_STATE.due, []],
        ]);
        expect(entityLoreStates([row('Corin', 30, ['Corrie'])], { record, ...options })[0]).not.toHaveProperty('keptApartFrom');
    });

    it('gives the same states for the same names and counts, and keeps each row as it was', () => {
        const rows = [row('Mira', 10, ['Mirabel']), row('Corin', 3)];
        const first = entityLoreStates(rows, { record: emptyRecord(), ...options });
        expect(entityLoreStates(rows, { record: emptyRecord(), ...options })).toEqual(first);
        expect(first[0]).toMatchObject(rows[0]);
        expect(rows[0]).toEqual(row('Mira', 10, ['Mirabel']));
    });
});

describe('names in another book the chat loads (E1 to E3 of entity-lore-names-across-languages.md)', () => {
    const options = { writeAt: 10, rewriteEvery: 30 };
    const ysolde = loreEntry('Harbor Atlas', 7, '[NPC] Ysolde', ['Ysolde Marr'], { isDecidedHere: true });
    const loreEntries = [loreEntry('Harbor Atlas', 3, 'Harbor Watch', ['Tidewardens']), ysolde, loreEntry('Tide Tables', 2, 'Tidewardens')];
    const linkedRecord = () => withNameInLorebook(emptyRecord(), 'Isolde', { bookName: 'Harbor Atlas', uid: 7, title: '[NPC] Ysolde' });

    it('names the first entry, in book order, whose title or key holds an excluded name, when no title is that name bare (E3)', () => {
        const charts = loreEntry('Tide Tables', 4, 'Harbor Charts', ['Tidewardens']);
        const [excluded] = entityLoreStates([row('Corrie', 30, ['tidewardens'])], { record: emptyRecord(), ...options, chat: { loreEntries: [loreEntries[0], ysolde, charts] } });
        expect(excluded).toMatchObject({ state: ENTITY_STATE.excluded, exclusion: EXCLUSION.lorebook, lorebookEntry: loreEntries[0] });
        expect(entityLoreStates([row('Corrie', 30)], { record: emptyRecord(), ...options, chat: { characterNames: ['Corrie'], loreEntries } })[0])
            .not.toHaveProperty('lorebookEntry');
    });

    it('names first the entry whose title, bare of its tags and note, is one of the names, before an entry whose key holds it (E4)', () => {
        const [titled] = entityLoreStates([row('Corrie', 30, ['tidewardens'])], { record: emptyRecord(), ...options, chat: { loreEntries } });
        expect(titled).toMatchObject({ state: ENTITY_STATE.excluded, exclusion: EXCLUSION.lorebook, lorebookEntry: loreEntries[2] });

        const hillFolk = loreEntry('Harbor Atlas', 4, '[Race] Hill Folk', ['Orla Vance', 'Bram']);
        const orla = loreEntry('Harbor Atlas', 8, '[NPC] Orla Vance (pilot)', ['Wren']);
        const bram = loreEntry('Tide Tables', 9, '【NPC】Bram', []);
        const rows = [row('Orla Vance', 30), row('Wren', 30, ['Bram']), row('Bram', 31, ['Orla Vance'])];
        const states = entityLoreStates(rows, { record: emptyRecord(), ...options, chat: { loreEntries: [hillFolk, orla, bram] } });
        // A title bare of its tag and its note; one of a row's other names; of two titles, the first in book order.
        expect(states.map(each => each.lorebookEntry)).toEqual([orla, bram, orla]);
    });

    it('leaves out a character only for an entry whose title as written or a key holds its name: one a title holds only bare goes to the name check (E4)', () => {
        const orla = loreEntry('Harbor Atlas', 8, '[NPC] Orla Vance (pilot)', ['Wren']);
        expect(exclusionOf(row('Orla Vance', 30), { loreEntries: [orla] })).toBeNull();
        expect(entityLoreStates([row('Orla Vance', 30)], { record: emptyRecord(), ...options, chat: { loreEntries: [orla] } })[0])
            .toMatchObject({ state: ENTITY_STATE.due });
        expect(exclusionOf(row('Wren', 30), { loreEntries: [orla] })).toBe(EXCLUSION.lorebook);
        expect(exclusionOf(row('[npc] orla vance (pilot)', 30), { loreEntries: [orla] })).toBe(EXCLUSION.lorebook);
    });

    it("records a link to an entry of another book, which reads as in that book while the chat holds the entry under its title, in any case (E2)", () => {
        const record = linkedRecord();
        expect(record.entries).toEqual({ Isolde: { state: 'in_lorebook', bookName: 'Harbor Atlas', uid: '7', title: '[NPC] Ysolde' } });
        expect(readEntityLoreRecord(record).entries).toEqual(record.entries);
        const [linked] = entityLoreStates([row('Isolde', 30)], { record, ...options, chat: { loreEntries } });
        expect(linked).toMatchObject({ state: ENTITY_STATE.inLorebook, lorebookEntry: ysolde });
        expect(entriesForName([linked], 'Isolde')).toEqual([]);
        expect(dueCounts([linked])).toEqual({ newCount: 0, rewriteCount: 0 });
        expect(heldLinks(record, loreEntries)).toEqual([{ name: 'Isolde', lorebookEntry: ysolde }]);
        const otherCase = [{ ...ysolde, title: '[npc] YSOLDE' }];
        expect(entityLoreStates([row('Isolde', 30)], { record, ...options, chat: { loreEntries: otherCase } })[0].state).toBe(ENTITY_STATE.inLorebook);
    });

    it('reads a link as no record once the chat no longer loads its book, or the book holds no entry at its uid under its title', () => {
        const record = linkedRecord();
        for (const held of [[], [{ ...ysolde, uid: '8' }], [{ ...ysolde, title: '[NPC] Ysolde the Elder' }], [{ ...ysolde, bookName: 'Tide Tables' }]]) {
            expect(entityLoreStates([row('Isolde', 30), row('Bram', 3)], { record, ...options, chat: { loreEntries: held } }).map(each => each.state))
                .toEqual([ENTITY_STATE.due, ENTITY_STATE.waiting]);
            expect(heldLinks(record, held)).toEqual([]);
        }
    });

    it("keeps a linked name apart from its entry's title once Allow again forgets it, and names the entry to take it off (D18)", () => {
        const record = linkedRecord();
        const allowed = withNameAllowedAgain(record, 'ISOLDE', []);
        expect(allowed).toEqual({
            record: { ...record, entries: {}, keptApart: [{ name: 'ISOLDE', from: '[NPC] Ysolde' }] }, keptApartFrom: '[NPC] Ysolde', matchedEntryUid: null,
            lorebookEntry: { bookName: 'Harbor Atlas', uid: '7' },
        });
        expect(entityLoreStates([row('Isolde', 30)], { record: allowed.record, ...options, chat: { loreEntries } })[0])
            .toMatchObject({ state: ENTITY_STATE.due, keptApartFrom: ['[NPC] Ysolde'] });
    });

    it('keeps a link when the record starts over for a missing book', () => {
        const record = withWrittenEntry(linkedRecord(), 'Mira', { uid: 1, writtenAtEvents: 12, content: 'a' });
        expect(withBookStartedOver(record).entries).toEqual({ Isolde: record.entries.Isolde });
    });

    it("shows the name check Entity-Lore's titles, then the other books', each once in any case, and names those of more than one entry (E1)", () => {
        let record = withWrittenEntry(emptyRecord(), 'Mira', { uid: 1, writtenAtEvents: 12, content: 'a' });
        record = withNameCheckAnswer(record, 'Corrie', { state: RECORD_STATE.sameAs, sameAs: 'Mira' });
        const entries = [loreEntry('Harbor Atlas', 3, 'Harbor Watch'), loreEntry('Harbor Atlas', 4, ''), loreEntry('Tide Tables', 2, 'harbor watch'),
            loreEntry('Tide Tables', 5, ' MIRA '), ysolde];
        expect(nameCheckTitles(record, entries)).toEqual({
            entryTitles: ['Mira', 'Harbor Watch', '[NPC] Ysolde'], sharedTitles: ['Mira', 'Harbor Watch'], keysByTitle: new Map(),
        });
        expect(nameCheckTitles(emptyRecord(), [])).toEqual({ entryTitles: [], sharedTitles: [], keysByTitle: new Map() });
    });

    it("gives the second ask each other book's title with at most 8 of its author keys, in order, each once, none a form of the title or of a key before it (E5)", () => {
        const orla = loreEntry('Harbor Atlas', 8, '[NPC] Orla Vance (harbor)', [
            'Orla', 'orla vance', 'Lady Orla', 'Wren', 'WREN', 'Silent Wren', 'The Gray Gull', 'オルラ', 'Lantern Keeper', 'Gull', 'Tide Witch',
            'Saltmarsh Heir', 'Ninth Bell', 'Tenth Bell', 'Eleventh Bell',
        ]);
        const { keysByTitle } = nameCheckTitles(emptyRecord(), [orla, loreEntry('Harbor Atlas', 9, 'Bo Lin', ['Bo the Fair', 'Lin Hollow'])]);
        expect(keysByTitle).toEqual(new Map([
            ['[NPC] Orla Vance (harbor)', ['Wren', 'The Gray Gull', 'オルラ', 'Lantern Keeper', 'Tide Witch', 'Saltmarsh Heir', 'Ninth Bell', 'Tenth Bell']],
            // A title's word shorter than 3 letters, as "Bo", leaves a key holding it shown.
            ['Bo Lin', ['Bo the Fair']],
        ]));
    });

    it("merges the keys of the entries one title names, and shows none under Entity-Lore's own titles (E5)", () => {
        const record = withWrittenEntry(emptyRecord(), 'Tamsin', { uid: 1, writtenAtEvents: 12, content: 'a' });
        const entries = [loreEntry('Harbor Atlas', 9, 'Gull Rock', ['Rookery']), loreEntry('Tide Tables', 3, 'gull rock', ['Nesting Ledge', 'rookery'])];
        expect(nameCheckTitles(record, entries)).toEqual({
            entryTitles: ['Tamsin', 'Gull Rock'], sharedTitles: ['Gull Rock'], keysByTitle: new Map([['Gull Rock', ['Rookery', 'Nesting Ledge']]]),
        });
    });
});

describe('a run', () => {
    const states = [
        { name: 'Bram', eventCount: 70, state: ENTITY_STATE.rewriteDue },
        { name: 'Mira', eventCount: 12, state: ENTITY_STATE.due },
        { name: 'Corin', eventCount: 30, state: ENTITY_STATE.due },
        { name: 'Ada', eventCount: 12, state: ENTITY_STATE.due },
        { name: 'Tess', eventCount: 45, state: ENTITY_STATE.rewriteDue },
        { name: 'Wren', eventCount: 90, state: ENTITY_STATE.waiting },
        { name: 'Oswin', eventCount: 90, state: ENTITY_STATE.editedByUser },
    ];

    it('writes new entries before rewrites, each most events first, then by name, up to its limit', () => {
        expect(entriesForRun(states).map(each => each.name)).toEqual(['Corin', 'Ada', 'Mira', 'Bram', 'Tess']);
        expect(entriesForRun(states, 4).map(each => each.name)).toEqual(['Corin', 'Ada', 'Mira', 'Bram']);
        expect(ENTRIES_PER_AUTOMATIC_RUN).toBe(5);
    });

    it('counts what is due, new and again', () => {
        expect(dueCounts(states)).toEqual({ newCount: 3, rewriteCount: 2 });
        expect(dueCounts([])).toEqual({ newCount: 0, rewriteCount: 0 });
    });

    it("writes a row's own character from its button: due new, written or due again, edited only as accepted, any other none", () => {
        const rows = [...states, { name: 'Pell', eventCount: 20, state: ENTITY_STATE.written }, { name: 'Quill', eventCount: 20, state: ENTITY_STATE.deletedByUser }];
        expect(entriesForName(rows, 'mira')).toEqual([states[1]]);
        expect(entriesForName(rows, 'Pell')).toEqual([{ name: 'Pell', eventCount: 20, state: ENTITY_STATE.rewriteDue }]);
        expect(entriesForName(rows, 'Bram')).toEqual([states[0]]);
        expect(entriesForName(rows, 'Oswin')).toEqual([{ name: 'Oswin', eventCount: 90, state: ENTITY_STATE.rewriteDue, isEditAccepted: true }]);
        for (const name of ['Wren', 'Quill', 'Nobody']) expect(entriesForName(rows, name)).toEqual([]);
    });
});

describe('entityLoreBlocker', () => {
    const running = { loreBaseReason: null, isLoreBaseSwitchedOn: true, isStoryArcActive: true, modelProblem: null };

    it('names nothing while LoreBase acts, StoryArc mode is on and the model is set', () => {
        expect(entityLoreBlocker(running)).toBeNull();
    });

    it('names LoreBase first, as its reason holds what StoryArc needs too, then StoryArc mode, then the model', () => {
        const everythingOff = { loreBaseReason: 'Use LoreBase is off.', isLoreBaseSwitchedOn: false, isStoryArcActive: false, modelProblem: 'No model.' };
        expect(entityLoreBlocker(everythingOff)).toEqual({
            need: ENTITY_LORE_NEED.loreBase, reason: 'Use LoreBase is off.',
            fix: "Turn on Use LoreBase on the Main tab first. Entity-Lore's entries go through LoreBase.", fixAt: ENTITY_LORE_FIX_AT.worldInfoMain,
        });
        expect(entityLoreBlocker({ ...running, loreBaseReason: 'LoreBase runs on the Qdrant backend only.' })).toEqual({
            need: ENTITY_LORE_NEED.loreBase, reason: 'LoreBase runs on the Qdrant backend only.',
            fix: "LoreBase runs on the Qdrant backend only. Entity-Lore's entries go through LoreBase.", fixAt: null,
        });
        expect(entityLoreBlocker({ ...running, isStoryArcActive: false, modelProblem: 'No model.' })).toEqual({
            need: ENTITY_LORE_NEED.storyArc, reason: 'StoryArc mode is off.',
            fix: 'Turn on StoryArc mode first. Entity-Lore counts characters in its events.', fixAt: ENTITY_LORE_FIX_AT.storyArcPage,
        });
        expect(entityLoreBlocker({ ...running, modelProblem: "Set LoreBase's model on the Main tab first." })).toEqual({
            need: ENTITY_LORE_NEED.loreBaseModel, reason: "Set LoreBase's model on the Main tab first.",
            fix: "Set LoreBase's model on the Main tab first.", fixAt: ENTITY_LORE_FIX_AT.worldInfoMain,
        });
    });
});

describe('entryKeysOf', () => {
    it("keys an entry by its kept name and other names, then the keys it had, each once in any case", () => {
        expect(entryKeysOf(row('Mira', 12, ['Mirabel', 'mira']))).toEqual(['Mira', 'Mirabel']);
        expect(entryKeysOf(row('Mira', 12, ['Mirabel']), ['mirabel', 'the lighthouse girl', ' ', 'Corrie', 'MIRA']))
            .toEqual(['Mira', 'Mirabel', 'the lighthouse girl', 'Corrie']);
    });
});

describe('a lock (T3)', () => {
    it('locks a character under its kept name, finds it by any of its names in any case, and unlocks every one of them', () => {
        const locked = withCharacterLocked(emptyRecord(), row('Mira', 12), true);
        expect(locked.lockedNames).toEqual(['Mira']);
        expect(isCharacterLocked(locked, row('mira', 12))).toBe(true);
        expect(isCharacterLocked(locked, row('Mirabel', 12, ['MIRA']))).toBe(true);
        expect(isCharacterLocked(locked, row('Corin', 12))).toBe(false);
        expect(withCharacterLocked(withCharacterLocked(locked, row('Corin', 12), true), row('Mirabel', 12, ['Mira']), false).lockedNames).toEqual(['Corin']);
        expect(emptyRecord().lockedNames).toEqual([]);
    });

    it('makes a locked character never due, its entry kept, while one deleted, not named, matched or excluded stays so', () => {
        let record = withWrittenEntry(emptyRecord(), 'Mira', { uid: 4, writtenAtEvents: 12, content: 'a' });
        record = withWrittenEntry(record, 'Corin', { uid: 5, writtenAtEvents: 12, content: 'b' });
        record = withNameCheckAnswer(record, 'the bus driver', { state: RECORD_STATE.notNamed });
        for (const name of ['Mira', 'Corin', 'Tess', 'Bram', 'the bus driver', 'Keeper Orrin']) record = withCharacterLocked(record, row(name, 1), true);
        const rows = [row('Mira', 90), row('Corin', 90), row('Tess', 40), row('Bram', 3), row('the bus driver', 40), row('Keeper Orrin', 40)];
        const states = entityLoreStates(rows, {
            record, writeAt: 10, rewriteEvery: 30, chat: { characterNames: ['Keeper Orrin'] }, bookEntries: [{ uid: 4, content: 'a' }, { uid: 5, content: 'edited' }],
        });
        expect(states.map(({ name, state }) => [name, state])).toEqual([
            ['Mira', ENTITY_STATE.locked], ['Corin', ENTITY_STATE.locked], ['Tess', ENTITY_STATE.locked], ['Bram', ENTITY_STATE.locked],
            ['the bus driver', ENTITY_STATE.notNamed], ['Keeper Orrin', ENTITY_STATE.excluded],
        ]);
        expect(states[0]).toMatchObject({ uid: '4', writtenAtEvents: 12 });
        expect(entriesForRun(states)).toEqual([]);
        expect(dueCounts(states)).toEqual({ newCount: 0, rewriteCount: 0 });
        expect(entriesForName(states, 'Mira')).toEqual([]);
        expect(entityLoreStates([row('Mira', 90)], { record: withMissingEntriesDeleted(record, []), writeAt: 10, rewriteEvery: 30 })[0].state)
            .toBe(ENTITY_STATE.deletedByUser);
    });
});

describe("names merged or split on StoryArc's Entity tab, and a matched name allowed again (D14, D17)", () => {
    const written = (record, name, uid) => withWrittenEntry(record, name, { uid, writtenAtEvents: 12, content: `${name} keeps the ferry.` });

    it("moves an entry written under a merged name to the kept name, with the names matched to it, due again", () => {
        let record = written(emptyRecord(), 'Marrow', 4);
        record = withNameCheckAnswer(withNameCheckAnswer(record, 'the ferry witch', { state: RECORD_STATE.sameAs, sameAs: 'Marrow' }), 'Tamsin', { state: RECORD_STATE.notNamed });
        const merged = withMergedEntry(record, { keptName: 'Tamsin', otherNames: ['Marrow'] }, [4, 7]);
        expect(merged).toEqual({
            record: {
                bookName: '',
                entries: {
                    'the ferry witch': { state: RECORD_STATE.sameAs, sameAs: 'Tamsin' },
                    Tamsin: { ...recordOfName(record, 'Marrow'), namesChangedBy: NAMES_CHANGED_BY.merge },
                },
                lockedNames: [],
                keptApart: [],
            },
            uid: '4', movedFrom: 'Marrow', alsoWritten: [],
        });
        expect(recordOfName(record, 'Marrow').state).toBe(RECORD_STATE.written);
    });

    it("keeps the kept name's own entry and names another name's, and finds none the book no longer holds", () => {
        const record = written(written(emptyRecord(), 'Tamsin', 2), 'marrow', 4);
        expect(withMergedEntry(record, { keptName: 'Tamsin', otherNames: ['Marrow'] }, [2, 4])).toEqual({
            record: { ...record, entries: { ...record.entries, Tamsin: { ...record.entries.Tamsin, namesChangedBy: NAMES_CHANGED_BY.merge } } },
            uid: '2', movedFrom: null, alsoWritten: ['Marrow'],
        });
        expect(withMergedEntry(record, { keptName: 'Tamsin', otherNames: ['Marrow'] }, [4]).movedFrom).toBe('Marrow');
        expect(withMergedEntry(record, { keptName: 'Tamsin', otherNames: ['Marrow'] }, [])).toBeNull();
        expect(withMergedEntry(withNameCheckAnswer(emptyRecord(), 'Marrow', { state: RECORD_STATE.notNamed }), { keptName: 'Tamsin', otherNames: ['Marrow'] }, [4])).toBeNull();
    });

    it("marks the kept name's entry to be written afresh once a name is split off, which a later merge leaves so", () => {
        const record = written(emptyRecord(), 'Tamsin', 2);
        const split = withSplitName(record, { keptName: 'Tamsin', splitName: 'Marrow' }, [2]);
        expect(split).toEqual({ record: { ...record, entries: { Tamsin: { ...record.entries.Tamsin, namesChangedBy: NAMES_CHANGED_BY.split } } }, uid: '2', title: 'Tamsin' });
        expect(record.entries.Tamsin.namesChangedBy).toBeUndefined();
        const mergedAgain = withMergedEntry(split.record, { keptName: 'Tamsin', otherNames: ['Marrow'] }, [2]);
        expect(recordOfName(mergedAgain.record, 'Tamsin').namesChangedBy).toBe(NAMES_CHANGED_BY.split);
    });

    it('marks nothing on a split with no entry of the kept name the book holds, or of a name the name check matched to it', () => {
        const record = written(emptyRecord(), 'Tamsin', 2);
        expect(withSplitName(record, { keptName: 'Tamsin', splitName: 'Marrow' }, [])).toBeNull();
        expect(withSplitName(written(emptyRecord(), 'Marrow', 4), { keptName: 'Tamsin', splitName: 'Marrow' }, [4])).toBeNull();
        const matched = withNameCheckAnswer(record, 'marrow', { state: RECORD_STATE.sameAs, sameAs: 'Tamsin' });
        expect(withSplitName(matched, { keptName: 'Tamsin', splitName: 'Marrow' }, [2])).toBeNull();
    });

    it('keeps a name the name check matched apart from its entry once Allow again forgets it, and marks the entry to be written afresh, which a later merge leaves so', () => {
        const record = withNameCheckAnswer(written(emptyRecord(), 'Tamsin', 2), 'Marrow', { state: RECORD_STATE.sameAs, sameAs: 'tamsin' });
        const allowed = withNameAllowedAgain(record, 'MARROW', [2]);
        expect(allowed).toEqual({
            record: { ...record, entries: { Tamsin: { ...record.entries.Tamsin, namesChangedBy: NAMES_CHANGED_BY.allowAgain } }, keptApart: [{ name: 'MARROW', from: 'Tamsin' }] },
            keptApartFrom: 'Tamsin', matchedEntryUid: '2', lorebookEntry: null,
        });
        const mergedAgain = withMergedEntry(allowed.record, { keptName: 'Tamsin', otherNames: ['Corin'] }, [2]);
        expect(recordOfName(mergedAgain.record, 'Tamsin').namesChangedBy).toBe(NAMES_CHANGED_BY.allowAgain);
        expect(withNameAllowedAgain(record, 'Marrow', [])).toEqual({
            record: { ...record, entries: { Tamsin: record.entries.Tamsin }, keptApart: [{ name: 'Marrow', from: 'tamsin' }] }, keptApartFrom: 'tamsin', matchedEntryUid: null,
            lorebookEntry: null,
        });
        const matchedAgain = withNameCheckAnswer(allowed.record, 'Marrow', { state: RECORD_STATE.sameAs, sameAs: 'Tamsin' });
        expect(withNameAllowedAgain(matchedAgain, 'marrow', [2]).record.keptApart).toEqual([{ name: 'MARROW', from: 'Tamsin' }]);
        expect([NAMES_CHANGED_BY.merge, NAMES_CHANGED_BY.split, NAMES_CHANGED_BY.allowAgain, undefined].map(isWrittenAfreshAfter)).toEqual([false, true, true, false]);
    });
});

describe('withOneEventTime', () => {
    it("gives an event one time: its DateTime to the minute, or its scene_time where it has none, the event given left as it was", () => {
        const event = { text: 'Tamsin signs the ledger.', DateTime: '2026-04-08T18:58:00.000Z', scene_time: 'April 8th, six to seven' };
        expect(withOneEventTime(event)).toEqual({ ...event, DateTime: '2026-04-08 18:58', scene_time: '' });
        expect(event.DateTime).toBe('2026-04-08T18:58:00.000Z');
        const ownCalendar = { text: 'The tide turns.', DateTime: null, scene_time: 'Day 3 of the Long Tide, dusk' };
        expect(withOneEventTime(ownCalendar)).toBe(ownCalendar);
        expect(withOneEventTime({ DateTime: '0947-11-02T06:05:00.000Z' }).DateTime).toBe('0947-11-02 06:05');
    });
});

describe('sliceEventLines', () => {
    const tokensOf = text => text.length;

    it('keeps every line in one slice while they fit', () => {
        expect(sliceEventLines(['aaaa', 'bbbb'], tokensOf, 8)).toEqual([['aaaa', 'bbbb']]);
        expect(sliceEventLines([], tokensOf, 8)).toEqual([]);
    });

    it('cuts the lines into slices that fit, oldest first, with a line too long for any slice alone', () => {
        expect(sliceEventLines(['aaaa', 'bbbb', 'cc', 'dddddddddd', 'e'], tokensOf, 8)).toEqual([['aaaa', 'bbbb'], ['cc'], ['dddddddddd'], ['e']]);
        expect(EVENT_SLICE_TOKENS).toBe(30000);
    });
});

describe("Run now's question (§4.1)", () => {
    const linesText = lines => lines.map(line => (line.parts ?? [line]).map(part => part.text ?? part.name).join(''));
    const CHECK_LINE = "First, one request to LoreBase's model checks which names are named characters: a job or a title gets no entry, and "
        + "another name of a character joins that character's entry. A second request looks for the named ones among the keys of the "
        + "chat's other lorebooks, when they have keys. Each entry then takes one more request, a few for a very long story, and LoreBase "
        + 'writes their keys and vectors.';

    it('says in plain words what it writes, into which lorebook, and the requests it makes, each count and the book a value', () => {
        const lines = runNowQuestion({ newCount: 25, rewriteCount: 0, bookName: 'VectFox NPCs - Harbor', isBookMade: true });
        expect(linesText(lines)).toEqual([
            'Write lorebook entries for 25 characters?',
            "One entry per character, from the story's events about them, into this chat's lorebook VectFox NPCs - Harbor.",
            CHECK_LINE,
        ]);
        expect(lines[0]).toEqual({ icon: 'fa-users-viewfinder', parts: [{ text: 'Write lorebook entries for ' }, { name: '25' }, { text: ' characters' }, { text: '?' }] });
        expect(lines[1].parts[1]).toEqual({ name: 'VectFox NPCs - Harbor' });
        expect(lines[2]).toEqual({ text: CHECK_LINE });
    });

    it('names the new lorebook the first entry makes, says one character in the singular, and adds the rewrites', () => {
        expect(linesText(runNowQuestion({ newCount: 1, rewriteCount: 1, bookName: 'VectFox NPCs - Harbor', isBookMade: false }))).toEqual([
            'Write a lorebook entry for 1 character, and rewrite 1 existing one?',
            "One entry per character, from the story's events about them, into a new lorebook for this chat, VectFox NPCs - Harbor.",
            CHECK_LINE,
            "A rewrite writes an existing entry again from the character's whole story so far, one request each.",
        ]);
        expect(linesText(runNowQuestion({ newCount: 3, rewriteCount: 4, bookName: 'VectFox NPCs - Harbor', isBookMade: true }))[0])
            .toBe('Write lorebook entries for 3 characters, and rewrite 4 existing ones?');
    });

    it('asks about the rewrites alone when no new entry is due, with no name check', () => {
        expect(linesText(runNowQuestion({ newCount: 0, rewriteCount: 4, bookName: 'VectFox NPCs - Harbor', isBookMade: true }))).toEqual([
            'Rewrite 4 lorebook entries?',
            "Each is written again from the character's whole story so far, in this chat's lorebook VectFox NPCs - Harbor.",
            "Each takes one request to LoreBase's model, a few for a very long story, and LoreBase writes their keys and vectors again.",
        ]);
        expect(linesText(runNowQuestion({ newCount: 0, rewriteCount: 1, bookName: 'VectFox NPCs - Harbor', isBookMade: true }))[0]).toBe('Rewrite 1 lorebook entry?');
    });
});

describe('the question a split asks (D21)', () => {
    it('asks whether the entry is written again from scratch or kept as it is, the split name coming off its keys either way', () => {
        const lines = splitQuestion({ title: 'Tamsin', splitName: 'Marrow' });
        expect(lines.map(line => (line.parts ?? [line]).map(part => part.text ?? part.name).join(''))).toEqual([
            'Write the lorebook entry for Tamsin again from scratch?',
            'It was written with the events of Marrow too, the name just split off.',
            "Write again: the next run writes it from the events of the names it keeps, with requests to LoreBase's model. Keep as it is: its text stays as it stands.",
            'Either way, Marrow comes off its keys.',
        ]);
        expect(lines[0]).toEqual({ icon: 'fa-code-branch', parts: [{ text: 'Write the lorebook entry for ' }, { name: 'Tamsin' }, { text: ' again from scratch?' }] });
        expect(lines[1].parts[1]).toEqual({ name: 'Marrow' });
        expect(lines[3].parts[1]).toEqual({ name: 'Marrow' });
    });
});
