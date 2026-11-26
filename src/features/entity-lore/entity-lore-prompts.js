/**
 * ============================================================================
 * ENTITY-LORE, PROMPTS
 * ============================================================================
 * The calls a run makes on LoreBase's model (InternalProject/Vectfox/plans/
 * entity-lore.md §4.3, §4.4, §5.2), and the reading of their answers:
 *
 * - the name check: one call for every candidate of a run, which says of each
 *   name whether it is a named character, not one, or another name of a
 *   character that has an entry or is another candidate of the same check;
 * - the entry: one call per character, written new or again (a rewrite reads
 *   the entry as it stands), from the character's events or from the notes on
 *   them, in five sections under bracket headings, which LoreBase's splitter
 *   makes parts;
 * - the notes on one slice of an arc too long for one call.
 *
 * Every example in a prompt is generic; no prompt names a cast. Pure: no host
 * or feature imports.
 * ============================================================================
 */

import { RECORD_STATE, isSameName } from './entity-lore-core.js';

/** The name check's answers (§4.3). not_named and same_as are the record's own states, which withNameCheckAnswer takes. */
export const NAME_CHECK_ANSWER = Object.freeze({ named: 'named', notNamed: RECORD_STATE.notNamed, sameAs: RECORD_STATE.sameAs });

/** An entry's sections, each under its bracket heading, in this order (§4.4). */
const ENTRY_SECTIONS = Object.freeze([
    { name: 'Identity', holds: 'who they are: full name and other names, role, origin, what they are to the story' },
    { name: 'Personality', holds: 'how they think, act and speak, what they want and fear, as the events show it' },
    { name: 'History', holds: 'their past before and during the story, in time order, in a few sentences' },
    { name: 'Key events', holds: 'the events that changed them or the story, oldest first, one line each: when, what happened, their part, the outcome' },
    { name: 'Relationships', holds: 'each character they are tied to: the tie, how it came about, how it stands' },
]);
// The entry's length (§4.4): starting values, tuned in V2.
const ENTRY_WORDS = 600;
const KEY_EVENT_LINES = 15;
// An answer with fewer of the section headings, or shorter once read, is not an entry (§4.4).
const FEWEST_ENTRY_HEADINGS = 3;
const SHORTEST_ENTRY_CHARACTERS = 100;

const NAME_CHECK_SYSTEM_PROMPT = 'You sort the names a roleplay story\'s events tag as people, so that a lorebook entry is written only '
    + 'for each named character, once. Return JSON only.';
const ENTRY_SYSTEM_PROMPT = 'You write lorebook entries about the characters of a roleplay story, from the story\'s stored events. '
    + 'Write the entry only, with no other text.';
const NOTES_SYSTEM_PROMPT = 'You take notes on a roleplay story\'s stored events, for a lorebook entry about one of its characters. '
    + 'Write the notes only, with no other text.';

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const languageRule = languageName => `Write in the language the events are written in${languageName ? `: ${languageName}` : ''}.`;
// An event's line opens with its # number, which only places it in the chat; its time is in its "when".
const TIME_RULE = 'Give a time as an event\'s "when" gives it. Never write an event\'s # number, which only places it in the chat.';

// ---------------------------------------------------------------------------- The name check (§4.3)

/**
 * The name check's messages: the titles of the entries Entity-Lore wrote in this book, then each candidate with how
 * many events name it and one of those events, then what each answer means. Names in the list that are one character
 * are answered as one: named for the name with the most events, same_as it for the others, so only that name gets an
 * entry.
 *
 * @param {{candidates: Array<{name: string, eventCount: number, eventLine: string}>, entryTitles: string[]}} check -
 *   candidates in the run's order, each with one event naming it as its line reads; entryTitles may be empty
 * @returns {Array<{role: string, content: string}>}
 */
export function nameCheckMessages({ candidates, entryTitles }) {
    const titles = entryTitles.length
        ? `Entries already written for this story, by title:\n${entryTitles.map(title => `- ${title}`).join('\n')}`
        : 'Entries already written for this story: none.';
    const names = candidates.map(({ name, eventCount, eventLine }, index) => `${index + 1}. ${name}: ${eventCount} ${eventCount === 1 ? 'event' : 'events'}. `
        + `One of them: ${oneLine(eventLine)}`).join('\n');
    const prompt = [
        titles,
        '',
        `Names the story's events tag as people, each with how many events name it and one of those events:\n${names}`,
        '',
        'For each name, answer whether it is the proper name of one individual character:',
        '- named: a personal name, a family name with a title (Lord Ashford, Captain Reyes, Mrs. Hale), or a nickname used as a name.',
        '- not_named: a job, a title with no name in it, a role or a description (a waitress, the bus driver, the boss, the captain, '
            + 'the old man, the protagonist), a group (the guards, the villagers), or a pronoun.',
        '- same_as: another name of a character who already has an entry, or of a character another name in this list names. '
            + 'Give that entry\'s title, or that name, exactly as written above. When names in this list are one character, '
            + 'answer named for the one with the most events, and same_as with that name for each of the others.',
        'Answer each name once, writing it exactly as written above.',
        'Return {"names": [{"name": "...", "answer": "named" | "not_named" | "same_as", "same_as": "<title or name>"}, ...]}',
    ].join('\n');
    return [{ role: 'system', content: NAME_CHECK_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
}

const textOf = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The name check's answers, in the candidates' order. An item is read when it names a candidate, in any case, not
 * answered before, with one of the three answers; a same_as when it names an entry's title, or another candidate the
 * same answer calls named, so same_as never chains or points at itself, and names that title or that candidate as
 * written in the list. A candidate with no answer read stays due for the next run.
 *
 * @param {unknown[]} items - The answer's records, as parseJsonArrayFromLlm reads them with `name` marking a record
 * @param {{candidates: Array<{name: string}>, entryTitles: string[]}} check - What nameCheckMessages asked
 * @returns {{answers: Array<{name: string, answer: string, sameAs?: string}>, unreadItemCount: number}} Each answer's
 *   name as the candidate's own
 */
export function readNameCheck(items, { candidates, entryTitles }) {
    const candidateOf = name => candidates.find(candidate => isSameName(candidate.name, name));
    const read = new Map();
    let unreadItemCount = 0;
    for (const item of Array.isArray(items) ? items : []) {
        const candidate = candidateOf(textOf(item?.name));
        const answer = textOf(item?.answer).toLowerCase();
        if (!candidate || read.has(candidate) || !Object.values(NAME_CHECK_ANSWER).includes(answer)) {
            unreadItemCount += 1;
            continue;
        }
        read.set(candidate, { answer, sameAs: textOf(item.same_as) });
    }
    const isNamed = candidate => read.get(candidate)?.answer === NAME_CHECK_ANSWER.named;
    const answers = [];
    for (const candidate of candidates) {
        const found = read.get(candidate);
        if (!found) continue;
        if (found.answer !== NAME_CHECK_ANSWER.sameAs) {
            answers.push({ name: candidate.name, answer: found.answer });
            continue;
        }
        const title = entryTitles.find(each => isSameName(each, found.sameAs));
        const other = candidateOf(found.sameAs);
        const sameAs = title ?? (other && other !== candidate && isNamed(other) ? other.name : '');
        if (sameAs) answers.push({ name: candidate.name, answer: NAME_CHECK_ANSWER.sameAs, sameAs });
        else unreadItemCount += 1;
    }
    return { answers, unreadItemCount };
}

// ---------------------------------------------------------------------------- The entry (§4.4, §5.2)

/**
 * The entry's messages, new or written again: what it is read from (the character's events, one per line, or the
 * notes on them), the entry as it stands for a rewrite, then what to write, the five sections and the rules, and for
 * a rewrite how to keep what the entry holds.
 *
 * @param {object} entry
 * @param {string} entry.name - The character's kept name, the entry's title
 * @param {string[]} [entry.otherNames] - The character's other names: the merges' and those the name check matched to it
 * @param {string} entry.storyText - The events, one line each and oldest first, or the notes on them
 * @param {boolean} [entry.isFromNotes] - Whether storyText is the notes on the events (notesMessages)
 * @param {string|null} [entry.standingEntry] - The entry as it stands, on a rewrite
 * @param {string|null} [entry.languageName] - The story's language, where its events leave it in doubt
 * @returns {Array<{role: string, content: string}>}
 */
export function entryMessages({ name, otherNames = [], storyText, isFromNotes = false, standingEntry = null, languageName = null }) {
    const source = isFromNotes
        ? `Notes on the story's events that matter to ${name}, oldest first:`
        : `The story's events naming ${name}, oldest first, one per line:`;
    const parts = [source, '', String(storyText).trim(), ''];
    if (standingEntry) parts.push(`${name}'s entry as it stands:`, '', String(standingEntry).trim(), '');
    const alsoCalled = otherNames.length ? `, also called ${otherNames.join(', ')}` : '';
    parts.push(
        `Write one lorebook entry about ${name}, a character in this story${alsoCalled}. The model writing the story's next replies reads it `
            + `whenever ${name} comes up, so it must hold what stays true about ${name} and the events that made them who they are.`,
        '',
        'Write these five sections, each under its heading exactly as written, on a line of its own:',
        ...ENTRY_SECTIONS.map(section => `[${section.name}]: ${section.holds}.`),
        '',
        'Rules:',
        `- Write only what the ${isFromNotes ? 'notes' : 'events'} say or plainly show. Never invent.`,
        `- Leave out what changes from scene to scene: where ${name} is now, what they wear, how they look, how they feel at the moment. Another tool tracks those.`,
        '- Use every name exactly as the events write it.',
        `- ${TIME_RULE}`,
        `- ${languageRule(languageName)} Keep the headings in English, as written.`,
        `- At most ${ENTRY_WORDS} words. [Key events] at most ${KEY_EVENT_LINES} lines.`,
    );
    if (standingEntry) {
        parts.push(
            '',
            `Write ${name}'s entry again, whole, from the ${isFromNotes ? 'notes' : 'events'} and the entry as it stands:`,
            '- Keep every key event and relationship the entry holds, unless the events show it was wrong. Add the ones the newer events bring.',
            `- When [Key events] would pass ${KEY_EVENT_LINES} lines, merge lines from one stretch of the story into one line that keeps their outcome. `
                + `Never drop an event that changed ${name} or the story.`,
            '- When the newer events changed a trait or a tie, write it as it stands now and say in a few words how it changed.',
        );
    }
    return [{ role: 'system', content: ENTRY_SYSTEM_PROMPT }, { role: 'user', content: parts.join('\n') }];
}

/**
 * The notes on one slice of a character's events, for an arc too long for one entry call (§4.4, §5.2): every event of
 * the slice that matters to them, oldest first, with the detail an entry keeps.
 *
 * @param {{name: string, eventLines: string[], sliceNumber: number, sliceCount: number, languageName?: string|null}} slice
 * @returns {Array<{role: string, content: string}>}
 */
export function notesMessages({ name, eventLines, sliceNumber, sliceCount, languageName = null }) {
    const prompt = [
        `Part ${sliceNumber} of ${sliceCount} of the story's events naming ${name}, oldest first, one per line:`,
        '',
        eventLines.join('\n'),
        '',
        `List, oldest first, every event above that matters to ${name}: when it happened, what happened, their part, the outcome, and what it shows `
            + 'about them. One line per event. Keep names as written. Leave out where they were, what they wore and how they felt.',
        TIME_RULE,
        languageRule(languageName),
    ].join('\n');
    return [{ role: 'system', content: NOTES_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
}

// A line holding a section heading: the bracket heading, perhaps marked as a Markdown heading or in bold, perhaps with
// a colon and the section's first words after it.
const SECTION_HEADING = new RegExp(String.raw`^\s*(?:#{1,6}\s*)?(?:\*\*)?\[(${ENTRY_SECTIONS.map(section => section.name).join('|')})\](?:\*\*)?\s*[:：]?\s*(.*)$`, 'iu');
const FENCE_LINE = /^\s*```/u;

const answerLines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter(line => !FENCE_LINE.test(line));

/**
 * The entry in an answer (§4.4): from its first section heading on, each heading on a line of its own as the splitter
 * reads it and written as the prompt writes it, with the fences and any text before the first heading removed. An
 * answer holding fewer than three of the five headings, or shorter than 100 characters once read, is not an entry.
 *
 * @param {string} text - The answer, its reasoning already removed
 * @returns {{entry: string}|{problem: string}}
 */
export function readEntryAnswer(text) {
    const lines = [];
    const headings = new Set();
    for (const line of answerLines(text)) {
        const heading = SECTION_HEADING.exec(line);
        if (heading) {
            const section = ENTRY_SECTIONS.find(each => isSameName(each.name, heading[1]));
            headings.add(section.name);
            lines.push(`[${section.name}]`);
            if (heading[2].trim()) lines.push(heading[2].trim());
        } else if (headings.size) {
            lines.push(line.trimEnd());
        }
    }
    const entry = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (headings.size < FEWEST_ENTRY_HEADINGS) return { problem: `its answer holds ${headings.size} of the entry's 5 section headings` };
    if (entry.length < SHORTEST_ENTRY_CHARACTERS) return { problem: `its answer holds only ${entry.length} characters` };
    return { entry };
}

/**
 * The notes in an answer: its text with the fences removed. An answer with no text is not notes.
 *
 * @param {string} text - The answer, its reasoning already removed
 * @returns {{notes: string}|{problem: string}}
 */
export function readNotesAnswer(text) {
    const notes = answerLines(text).join('\n').trim();
    return notes ? { notes } : { problem: 'its answer was empty' };
}
