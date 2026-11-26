/**
 * Tests for Entity-Lore's pure rules (src/features/entity-lore/entity-lore-core.js, plan §4.2, §4.4, §4.5, §5, §6 of
 * InternalProject/Vectfox/plans/entity-lore.md).
 *
 * Guards that:
 *   - the switch is off unless turned on, and Write at and Rewrite every read as whole numbers in their ranges,
 *   - the record reads back only what it can use, finds a kept name in any case, and each change gives a new record,
 *   - a missing book starts the record over: its written entries are due again, the user's and the name check's answers kept,
 *   - an entry's hash ignores line endings and the ends of its text, so SillyTavern's own save is not the user's edit,
 *   - a character is excluded by any of its names, in any case: the chat's character, the persona, another lorebook's
 *     entry, or the card's description,
 *   - each character's state follows the record first, then the exclusions and Write at, and a rewrite falls due at
 *     the count it was written at plus Rewrite every,
 *   - what keeps Entity-Lore from running is named first by LoreBase, then StoryArc mode, then LoreBase's model, each
 *     with its fix and where the panel makes it,
 *   - a run writes new entries before rewrites, most events first, at most its limit; a row's button writes its own
 *     character's entry, new or again, an edited one only as accepted,
 *   - an entry's keys are its names, then the keys it already had, each once in any case,
 *   - a character's events are cut into slices that fit, oldest first.
 *
 * Names are made up and match no story.
 */

import { describe, it, expect } from 'vitest';
import {
    ENTITY_LORE_FIX_AT, ENTITY_LORE_NEED, ENTITY_STATE, ENTRIES_PER_AUTOMATIC_RUN, EVENT_SLICE_TOKENS, EXCLUSION, RECORD_STATE,
    REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS, dueCounts, entityLoreBlocker, entityLoreStates, entriesForName, entriesForRun, entryContentHash,
    entryKeysOf, exclusionOf, isEntityLoreOn,
    readEntityLoreRecord, recordOfName, rewriteEveryEventsOf, sliceEventLines, withBookName, withBookStartedOver, withEntryForgotten,
    withMissingEntriesDeleted, withNameCheckAnswer, withWrittenEntry, writeAtEventsOf,
} from '../src/features/entity-lore/entity-lore-core.js';

const row = (name, eventCount, otherNames = []) => ({ name, otherNames, eventCount });
const emptyRecord = () => readEntityLoreRecord(undefined);

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
    it('reads back only the book name and the entries it can use', () => {
        expect(emptyRecord()).toEqual({ bookName: '', entries: {} });
        expect(readEntityLoreRecord({ bookName: 7, entries: [] })).toEqual({ bookName: '', entries: {} });
        const stored = {
            bookName: 'VectFox NPCs - Harbor',
            entries: { Mira: { state: 'written', uid: '4', writtenAtEvents: 12, contentHash: '9' }, Corin: { state: 'lost' }, Tess: 'written' },
        };
        expect(readEntityLoreRecord(stored)).toEqual({ bookName: 'VectFox NPCs - Harbor', entries: { Mira: stored.entries.Mira } });
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
        expect(withEntryForgotten(record, 'BRAM').entries).toEqual({ Tess: { state: 'not_named' } });
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
        const after = withBookStartedOver(record);
        expect(after.bookName).toBe('');
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
        loreNames: ['Harbor Watch', 'Tidewardens'],
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

    it('gives the same states for the same names and counts, and keeps each row as it was', () => {
        const rows = [row('Mira', 10, ['Mirabel']), row('Corin', 3)];
        const first = entityLoreStates(rows, { record: emptyRecord(), ...options });
        expect(entityLoreStates(rows, { record: emptyRecord(), ...options })).toEqual(first);
        expect(first[0]).toMatchObject(rows[0]);
        expect(rows[0]).toEqual(row('Mira', 10, ['Mirabel']));
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
