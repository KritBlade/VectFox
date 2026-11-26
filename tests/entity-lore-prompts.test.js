/**
 * Tests for Entity-Lore's prompts and the reading of their answers (src/features/entity-lore/entity-lore-prompts.js,
 * plan §4.3, §4.4 and §5.2 of InternalProject/Vectfox/plans/entity-lore.md).
 *
 * Guards that:
 *   - the name check lists the entries already written and each candidate with its count and one event, and says what
 *     each answer means, names in the list that are one character answered as one,
 *   - its answers are read by the candidate's own name in any case, each once, a same_as only when it names an entry's
 *     title or another candidate the same answer calls named, and a candidate with no answer read is left out,
 *   - the entry is asked for in five sections under their headings, from the events or the notes on them, in the
 *     story's language, and a rewrite also reads the entry as it stands and keeps what it holds,
 *   - a slice's notes are asked for with its place in the arc,
 *   - an entry is read from its first heading, each heading alone on its line as the splitter reads it, and an answer
 *     with fewer than three headings or too short is not one; notes are read without their fences.
 *
 * Names are made up and match no story.
 */
import { describe, expect, it } from 'vitest';
import {
    NAME_CHECK_ANSWER, entryMessages, nameCheckMessages, notesMessages, readEntryAnswer, readNameCheck, readNotesAnswer,
} from '../src/features/entity-lore/entity-lore-prompts.js';
import { RECORD_STATE } from '../src/features/entity-lore/entity-lore-core.js';

const userText = messages => messages[1].content;

describe('the name check (§4.3)', () => {
    const candidates = [
        { name: 'Tamsin', eventCount: 112, eventLine: 'Day 3 | Tamsin crosses the\nsalt flats | cause: the well ran dry | result: she finds the old road' },
        { name: 'the ferryman', eventCount: 14, eventLine: 'Day 4 | the ferryman takes Tamsin over the river' },
        { name: 'Tamsin Vale', eventCount: 28, eventLine: 'Day 9 | Tamsin Vale signs the guild ledger' },
        { name: 'Hollis', eventCount: 1, eventLine: 'Day 2 | Hollis sells a map' },
    ];
    const check = { candidates, entryTitles: ['Captain Brannoc'] };

    it('lists the entries already written, then each name with its count and one event on one line, and says what each answer means', () => {
        const messages = nameCheckMessages(check);
        expect(messages[0]).toEqual({ role: 'system', content: expect.stringContaining('Return JSON only.') });
        const prompt = userText(messages);
        expect(prompt).toContain('Entries already written for this story, by title:\n- Captain Brannoc\n');
        expect(prompt).toContain('1. Tamsin: 112 events. One of them: Day 3 | Tamsin crosses the salt flats | cause: the well ran dry | result: she finds the old road\n');
        expect(prompt).toContain('4. Hollis: 1 event. One of them: Day 2 | Hollis sells a map\n');
        expect(prompt).toContain('- named: a personal name, a family name with a title (Lord Ashford, Captain Reyes, Mrs. Hale), or a nickname used as a name.\n');
        expect(prompt).toContain('- not_named: a job, a title with no name in it, a role or a description (a waitress, the bus driver, the boss, the captain, the old man, the protagonist), ');
        expect(prompt).toContain('When names in this list are one character, answer named for the one with the most events, and same_as with that name for each of the others.');
        expect(prompt.endsWith('Return {"names": [{"name": "...", "answer": "named" | "not_named" | "same_as", "same_as": "<title or name>"}, ...]}')).toBe(true);
    });

    it('says when no entry is written yet', () => {
        expect(userText(nameCheckMessages({ candidates, entryTitles: [] }))).toMatch(/^Entries already written for this story: none\.\n/u);
    });

    it("reads each candidate's answer by its own name in any case, in the candidates' order, and leaves out one with no answer", () => {
        const { answers, unreadItemCount } = readNameCheck([
            { name: ' THE FERRYMAN ', answer: 'Not_Named' },
            { name: 'tamsin', answer: 'named' },
        ], check);
        expect(answers).toEqual([
            { name: 'Tamsin', answer: NAME_CHECK_ANSWER.named },
            { name: 'the ferryman', answer: NAME_CHECK_ANSWER.notNamed },
        ]);
        expect(unreadItemCount).toBe(0);
        expect([NAME_CHECK_ANSWER.notNamed, NAME_CHECK_ANSWER.sameAs]).toEqual([RECORD_STATE.notNamed, RECORD_STATE.sameAs]);
    });

    it('counts the items it cannot read: a name not asked, an answer not offered, a second answer for a name', () => {
        const { answers, unreadItemCount } = readNameCheck([
            { name: 'Orla', answer: 'named' },
            { name: 'Hollis', answer: 'maybe' },
            { name: 'Hollis', answer: 'named' },
            { name: 'Hollis', answer: 'not_named' },
            null,
            { answer: 'named' },
        ], check);
        expect(answers).toEqual([{ name: 'Hollis', answer: NAME_CHECK_ANSWER.named }]);
        expect(unreadItemCount).toBe(5);
    });

    it("reads a same_as naming an entry's title, in any case, as that title", () => {
        const { answers } = readNameCheck([{ name: 'Hollis', answer: 'same_as', same_as: 'captain brannoc' }], check);
        expect(answers).toEqual([{ name: 'Hollis', answer: NAME_CHECK_ANSWER.sameAs, sameAs: 'Captain Brannoc' }]);
    });

    it('reads a same_as naming another candidate the same answer calls named, so two names of one character get one entry', () => {
        const { answers, unreadItemCount } = readNameCheck([
            { name: 'Tamsin Vale', answer: 'same_as', same_as: 'TAMSIN' },
            { name: 'Tamsin', answer: 'named' },
        ], check);
        expect(answers).toEqual([
            { name: 'Tamsin', answer: NAME_CHECK_ANSWER.named },
            { name: 'Tamsin Vale', answer: NAME_CHECK_ANSWER.sameAs, sameAs: 'Tamsin' },
        ]);
        expect(unreadItemCount).toBe(0);
    });

    it('leaves out a same_as naming itself, nothing asked, a candidate not called named, or one that is itself a same_as', () => {
        const { answers, unreadItemCount } = readNameCheck([
            { name: 'Tamsin', answer: 'same_as', same_as: 'Tamsin' },
            { name: 'Hollis', answer: 'same_as', same_as: 'Orla' },
            { name: 'Tamsin Vale', answer: 'same_as', same_as: 'the ferryman' },
            { name: 'the ferryman', answer: 'same_as', same_as: 'Tamsin' },
        ], check);
        expect(answers).toEqual([]);
        expect(unreadItemCount).toBe(4);
        expect(readNameCheck([{ name: 'Hollis', answer: 'same_as' }], check)).toEqual({ answers: [], unreadItemCount: 1 });
    });

    it('reads an answer that is no list as no answers', () => {
        expect(readNameCheck(undefined, check)).toEqual({ answers: [], unreadItemCount: 0 });
    });
});

describe('the entry (§4.4, §5.2)', () => {
    const events = ['Day 3 | Tamsin crosses the salt flats', 'Day 9 | Tamsin signs the guild ledger'].join('\n');
    const headings = ['[Identity]', '[Personality]', '[History]', '[Key events]', '[Relationships]'];

    it('asks for a new entry from the events, in five sections under their headings, in the story\'s language, at most 600 words', () => {
        const messages = entryMessages({ name: 'Tamsin', otherNames: ['Tamsin Vale'], storyText: events, languageName: '繁體中文 (Traditional Chinese)' });
        expect(messages[0]).toEqual({ role: 'system', content: expect.stringContaining('Write the entry only') });
        const prompt = userText(messages);
        expect(prompt.startsWith(`The story's events naming Tamsin, oldest first, one per line:\n\n${events}\n\n`)).toBe(true);
        expect(prompt).toContain('Write one lorebook entry about Tamsin, a character in this story, also called Tamsin Vale.');
        const at = headings.map(heading => prompt.indexOf(`\n${heading}: `));
        expect(at.every(index => index > 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        expect(prompt).toContain('- Write only what the events say or plainly show. Never invent.');
        expect(prompt).toContain('where Tamsin is now, what they wear, how they look, how they feel at the moment');
        expect(prompt).toContain('- Give a time as an event\'s "when" gives it. Never write an event\'s # number, which only places it in the chat.');
        expect(prompt).toContain('- Write in the language the events are written in: 繁體中文 (Traditional Chinese). Keep the headings in English, as written.');
        expect(prompt).toContain('- At most 600 words. [Key events] at most 15 lines.');
        expect(prompt).not.toContain('as it stands');
    });

    it('names no language where none is given, and no other name for a character with none', () => {
        const prompt = userText(entryMessages({ name: 'Hollis', storyText: 'Day 2 | Hollis sells a map' }));
        expect(prompt).toContain('- Write in the language the events are written in. Keep the headings in English, as written.');
        expect(prompt).toContain('about Hollis, a character in this story. The model');
    });

    it('writes the entry from the notes of a long arc', () => {
        const prompt = userText(entryMessages({ name: 'Tamsin', storyText: 'Tamsin leaves home.\nTamsin joins the guild.', isFromNotes: true }));
        expect(prompt.startsWith("Notes on the story's events that matter to Tamsin, oldest first:\n\nTamsin leaves home.")).toBe(true);
        expect(prompt).toContain('- Write only what the notes say or plainly show. Never invent.');
    });

    it('writes an entry again from the events and the entry as it stands, keeping what it holds', () => {
        const standing = '[Identity]\nTamsin is a salt trader.\n[Key events]\nDay 3: she crossed the salt flats.';
        const prompt = userText(entryMessages({ name: 'Tamsin', storyText: events, standingEntry: standing }));
        expect(prompt).toContain(`${events}\n\nTamsin's entry as it stands:\n\n${standing}\n\nWrite one lorebook entry`);
        expect(prompt).toContain("Write Tamsin's entry again, whole, from the events and the entry as it stands:");
        expect(prompt).toContain('- Keep every key event and relationship the entry holds, unless the events show it was wrong.');
        expect(prompt).toContain('- When [Key events] would pass 15 lines, merge lines from one stretch of the story into one line that keeps their outcome. Never drop an event that changed Tamsin or the story.');
        expect(prompt).toContain('say in a few words how it changed.');
    });
});

describe("a slice's notes (§5.2)", () => {
    it('asks for every event of the slice that matters to the character, when it happened as its "when" gives it, with its place in the arc', () => {
        const prompt = userText(notesMessages({ name: 'Tamsin', eventLines: ['Day 3 | a', 'Day 4 | b'], sliceNumber: 2, sliceCount: 3 }));
        expect(prompt.startsWith("Part 2 of 3 of the story's events naming Tamsin, oldest first, one per line:\n\nDay 3 | a\nDay 4 | b\n\n")).toBe(true);
        expect(prompt).toContain('List, oldest first, every event above that matters to Tamsin: when it happened, what happened, their part, the outcome, and what it shows about them.');
        expect(prompt).toContain('\nGive a time as an event\'s "when" gives it. Never write an event\'s # number, which only places it in the chat.\n');
        expect(prompt.endsWith('Write in the language the events are written in.')).toBe(true);
    });
});

describe('reading the answers', () => {
    const body = {
        identity: 'Tamsin is a salt trader from the river towns.',
        personality: 'Stubborn and patient; she keeps her word.',
        history: 'She grew up on the ferries and left after the drought.',
        keyEvents: 'Day 3: she crossed the salt flats and found the old road.',
        relationships: 'Captain Brannoc: her first employer, now a rival.',
    };
    const clean = [
        '[Identity]', body.identity, '', '[Personality]', body.personality, '', '[History]', body.history, '',
        '[Key events]', body.keyEvents, '', '[Relationships]', body.relationships,
    ].join('\n');

    it('reads a clean answer as it is', () => {
        expect(readEntryAnswer(clean)).toEqual({ entry: clean });
    });

    it('removes the fences and the text before the first heading, and makes plain line ends', () => {
        const answer = `Here is the entry for Tamsin.\r\n\r\n\`\`\`text\r\n${clean.replace(/\n/g, '\r\n')}\r\n\`\`\`\r\n`;
        expect(readEntryAnswer(answer)).toEqual({ entry: clean });
    });

    it('puts each heading alone on its line, as the prompt writes it, whatever its case, bold or Markdown mark', () => {
        const answer = [
            `**[IDENTITY]**: ${body.identity}`, `## [personality] ${body.personality}`, '[History]：', body.history,
            '[key events]', body.keyEvents, '[Relationships]', body.relationships,
        ].join('\n');
        expect(readEntryAnswer(answer)).toEqual({
            entry: ['[Identity]', body.identity, '[Personality]', body.personality, '[History]', body.history,
                '[Key events]', body.keyEvents, '[Relationships]', body.relationships].join('\n'),
        });
    });

    it('reads an answer of three sections, and keeps a section the prompt did not ask for', () => {
        const answer = ['[Identity]', body.identity, '[Appearance]', 'Tall.', '[History]', body.history, '[Key events]', body.keyEvents].join('\n');
        expect(readEntryAnswer(answer)).toEqual({ entry: answer });
    });

    it('refuses an answer with fewer than three of the headings, or shorter than 100 characters', () => {
        expect(readEntryAnswer(`[Identity]\n${body.identity}\n[History]\n${body.history}`)).toEqual({ problem: "its answer holds 2 of the entry's 5 section headings" });
        expect(readEntryAnswer('Tamsin is a salt trader.')).toEqual({ problem: "its answer holds 0 of the entry's 5 section headings" });
        expect(readEntryAnswer('[Identity]\nA trader.\n[History]\nThe ferries.\n[Key events]\nDay 3.')).toEqual({ problem: 'its answer holds only 63 characters' });
    });

    it('reads notes without their fences, and an empty answer as no notes', () => {
        expect(readNotesAnswer('```\nDay 3: Tamsin crosses the salt flats.\r\nDay 9: she signs the ledger.\n```')).toEqual({ notes: 'Day 3: Tamsin crosses the salt flats.\nDay 9: she signs the ledger.' });
        expect(readNotesAnswer('```\n\n```')).toEqual({ problem: 'its answer was empty' });
        expect(readNotesAnswer(undefined)).toEqual({ problem: 'its answer was empty' });
    });
});
