/**
 * ============================================================================
 * ENTITY-LORE, PROMPTS
 * ============================================================================
 * The calls a run makes on LoreBase's model (InternalProject/Vectfox/plans/
 * entity-lore.md §4.3, §4.4, §5.2), and the reading of their answers:
 *
 * - the name check: one call for every candidate of a run, which says of each
 *   name whether it is a named character, not one, or another name of a
 *   character that has an entry, Entity-Lore's or another book's, or is another
 *   candidate of the same check, never of one Allow again kept it apart from;
 *   and a second for the names the first calls named, shown the other books'
 *   author keys under their titles; a title is read as written, or bare of the
 *   tags and note a model leaves off;
 * - the entry: one call per character, written new or again (a rewrite reads
 *   the entry as it stands), from the character's events or from the notes on
 *   them: a profile of who they are, not a summary of the story, in five
 *   sections under bracket headings, which LoreBase's splitter makes parts;
 * - the notes on one slice of an arc too long for one call: what it shows of who
 *   the character is, and its biggest events, each list a share of the lines one
 *   arc's notes hold, so the notes stop growing with the story.
 *
 * Every example in a prompt is generic; no prompt names a cast. Pure: no host
 * or feature imports.
 * ============================================================================
 */

import { RECORD_STATE, bareTitle, isSameName } from './entity-lore-core.js';

/** The name check's answers (§4.3). not_named and same_as are the record's own states, which withNameCheckAnswer takes. */
export const NAME_CHECK_ANSWER = Object.freeze({ named: 'named', notNamed: RECORD_STATE.notNamed, sameAs: RECORD_STATE.sameAs });

/** An entry's sections, each under its bracket heading, in this order (§4.4). */
const ENTRY_SECTIONS = Object.freeze([
    { name: 'Identity', holds: 'who they are: full name and other names, role, origin, what they are to the story' },
    { name: 'Personality', holds: 'how they think, act and speak, what they want and fear, as the events show it' },
    { name: 'Background', holds: 'their past and where they come from: what happened to them before the story, and why, as the latest events tell it, in a few sentences; not a retelling of the story' },
    { name: 'Key events', holds: 'the turning points of their story, oldest first, one event per line: when, what happened, their part, the outcome' },
    { name: 'Relationships', holds: 'each character they are tied to: the tie, how it came about, how it stands' },
]);
// The entry's length (§4.4): its words, and the lines of its [Key events].
const ENTRY_WORDS = 600;
const KEY_EVENT_LINES = 15;
// A long arc's notes (§5.2): each of their two lists holds this many lines across the arc's slices, shared out among
// them, and at least the fewest on each, so the notes stop growing with the story.
const NOTES_LINES_PER_ARC = 60;
const FEWEST_NOTES_LINES = 3;
const notesLinesPerSlice = sliceCount => Math.max(FEWEST_NOTES_LINES, Math.ceil(NOTES_LINES_PER_ARC / sliceCount));
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

// The second ask's title lines and rule (E5 of entity-lore-names-across-languages.md), as its trial N5 asked them.
const KEYED_TITLES_HEADING = 'Entries already written for this story, by title, each with the other names and words its entry is keyed by:';
const KEYED_ROLE_RULE = ' A job, a title or a role is not_named even when an entry is keyed by it.';

/**
 * The name check's messages: the titles of the entries written for the story, Entity-Lore's and those of every other
 * book the chat loads (nameCheckTitles), then each candidate with how many events name it and one of those events, and
 * under it the names Allow again kept it apart from (D18), then what each answer means. Names in the list that are one
 * character are answered as one: named for the name with the most events, same_as it for the others, so only that name
 * gets an entry. Two names kept apart are never same_as each other. With `keysByTitle`, the second ask (E5): each title
 * with the author keys under it on a "Keyed by:" line, the heading saying so, and the not_named rule followed by one
 * sentence: a job, a title or a role a key holds is not_named still.
 *
 * @param {{candidates: Array<{name: string, eventCount: number, eventLine: string, keptApartFrom?: string[]}>,
 *   entryTitles: string[], keysByTitle?: Map<string, string[]>}} check - candidates in the run's order, each with one
 *   event naming it as its line reads; entryTitles may be empty; keysByTitle only for the second ask, by the title as
 *   entryTitles spells it
 * @returns {Array<{role: string, content: string}>}
 */
export function nameCheckMessages({ candidates, entryTitles, keysByTitle }) {
    const titleLine = (title) => {
        const keys = keysByTitle?.get(title) ?? [];
        return keys.length ? `- ${title}\n  Keyed by: ${keys.join(', ')}` : `- ${title}`;
    };
    const heading = keysByTitle ? KEYED_TITLES_HEADING : 'Entries already written for this story, by title:';
    const titles = entryTitles.length ? `${heading}\n${entryTitles.map(titleLine).join('\n')}` : 'Entries already written for this story: none.';
    const apartLine = keptApartFrom => (keptApartFrom.length ? `\n   Not the same character as ${keptApartFrom.join(', ')}.` : '');
    const names = candidates.map(({ name, eventCount, eventLine, keptApartFrom = [] }, index) => `${index + 1}. ${name}: ${eventCount} `
        + `${eventCount === 1 ? 'event' : 'events'}. One of them: ${oneLine(eventLine)}${apartLine(keptApartFrom)}`).join('\n');
    const isAnyKeptApart = candidates.some(candidate => candidate.keptApartFrom?.length);
    const prompt = [
        titles,
        '',
        `Names the story's events tag as people, each with how many events name it and one of those events:\n${names}`,
        '',
        'For each name, answer whether it is the proper name of one individual character:',
        '- named: a personal name, a family name with a title (Lord Ashford, Captain Reyes, Mrs. Hale), or a nickname used as a name.',
        '- not_named: a job, a title with no name in it, a role or a description (a waitress, the bus driver, the boss, the captain, '
            + 'the old man, the protagonist), a group (the guards, the villagers), or a pronoun.' + (keysByTitle ? KEYED_ROLE_RULE : ''),
        '- same_as: another name of a character who already has an entry, or of a character another name in this list names. '
            + 'Give that entry\'s title, or that name, exactly as written above. When names in this list are one character, '
            + 'answer named for the one with the most events, and same_as with that name for each of the others.'
            + (isAnyKeptApart ? ' Two names marked not the same character are never same_as each other.' : ''),
        'Answer each name once, writing it exactly as written above.',
        'Return {"names": [{"name": "...", "answer": "named" | "not_named" | "same_as", "same_as": "<title or name>"}, ...]}',
    ].join('\n');
    return [{ role: 'system', content: NAME_CHECK_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
}

const textOf = value => (typeof value === 'string' ? value.trim() : '');

/** The one title a same_as names once both are bare (bareTitle); none when no title is, or two titles are bare alike. */
function titleNamedBare(entryTitles, sameAs) {
    const bare = bareTitle(sameAs);
    const named = bare ? entryTitles.filter(title => bareTitle(title) === bare) : [];
    return named.length === 1 ? named[0] : undefined;
}

/**
 * The name check's answers, in the candidates' order. An item is read when it names a candidate, in any case, not
 * answered before, with one of the three answers; a same_as when it names an entry's title, or another candidate the
 * same answer calls named, so same_as never chains or points at itself, and names that title or that candidate as
 * written in the list; and when it names neither, for the one title it equals once both are bare (titleNamedBare). A
 * same_as naming a name the candidate is kept apart from (D18) reads as named, as the user said the two are not one
 * character, `keptApartFrom` naming it; one naming a title of more than one entry links none, and is not read. A
 * candidate with no answer read stays due, as a named one does.
 *
 * @param {unknown[]} items - The answer's records, as parseJsonArrayFromLlm reads them with `name` marking a record
 * @param {{candidates: Array<{name: string, keptApartFrom?: string[]}>, entryTitles: string[], sharedTitles?: string[]}}
 *   check - What nameCheckMessages asked, and the titles of more than one entry (nameCheckTitles)
 * @returns {{answers: Array<{name: string, answer: string, sameAs?: string, keptApartFrom?: string}>,
 *   unreadItemCount: number}} Each answer's name as the candidate's own
 */
export function readNameCheck(items, { candidates, entryTitles, sharedTitles = [] }) {
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
        const exactTitle = entryTitles.find(each => isSameName(each, found.sameAs));
        const other = exactTitle === undefined ? candidateOf(found.sameAs) : undefined;
        const title = exactTitle ?? (other ? undefined : titleNamedBare(entryTitles, found.sameAs));
        const sameAs = title ?? (other && other !== candidate && isNamed(other) ? other.name : '');
        const isKeptApart = (candidate.keptApartFrom ?? []).some(name => isSameName(name, sameAs));
        const isShared = title !== undefined && sharedTitles.some(shared => isSameName(shared, title));
        if (!sameAs) unreadItemCount += 1;
        else if (isKeptApart) answers.push({ name: candidate.name, answer: NAME_CHECK_ANSWER.named, keptApartFrom: sameAs });
        else if (isShared) unreadItemCount += 1;
        else answers.push({ name: candidate.name, answer: NAME_CHECK_ANSWER.sameAs, sameAs });
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
        ? `Notes on ${name}, part by part, oldest first: what each part of the story shows of who they are, then its biggest events:`
        : `The story's events naming ${name}, oldest first, one per line:`;
    const parts = [source, '', String(storyText).trim(), ''];
    if (standingEntry) parts.push(`${name}'s entry as it stands:`, '', String(standingEntry).trim(), '');
    const alsoCalled = otherNames.length ? `, also called ${otherNames.join(', ')}` : '';
    parts.push(
        `Write one lorebook entry about ${name}, a character in this story${alsoCalled}. The model writing the story's next replies reads it `
            + `whenever ${name} comes up, so it must hold who ${name} is, not a summary of the story: what stays true about them, and the `
            + 'turning points that made them who they are.',
        '',
        'Write these five sections, each under its heading exactly as written, on a line of its own:',
        ...ENTRY_SECTIONS.map(section => `[${section.name}]: ${section.holds}.`),
        '',
        'Rules:',
        `- Write only what the ${isFromNotes ? 'notes' : 'events'} say or plainly show. Never invent.`,
        `- Leave out what changes from scene to scene: where ${name} is now, what they wear, how they look, how they feel at the moment. Another tool tracks those.`,
        `- The ${isFromNotes ? 'notes' : 'events'} run in story order, and a later one can correct an earlier one: a secret comes out, or the reason behind something `
            + 'proves to be another. Write each section as the latest ones tell it, not as the account they correct.',
        `- [Key events] holds the turning points that changed ${name} or the story most, picked from the story's start to now: one event per line, `
            + 'never two in one line, even two with the same time. Leave the smaller events out.',
        '- Use every name exactly as the events write it.',
        `- ${TIME_RULE}`,
        `- ${languageRule(languageName)} Keep the headings in English, as written.`,
        `- At most ${ENTRY_WORDS} words. [Key events] at most ${KEY_EVENT_LINES} lines.`,
    );
    if (standingEntry) {
        parts.push(
            '',
            `Write ${name}'s entry again, whole, from the ${isFromNotes ? 'notes' : 'events'} and the entry as it stands:`,
            '- Keep every relationship the entry holds, unless the events show it was wrong. Add the ones the newer events bring.',
            "- Pick [Key events] again from the whole story: keep the entry's key events and add the newer turning points. Once [Key events] is "
                + 'full, a newer event takes the place of a smaller one only when it is bigger.',
            '- When the newer events changed a trait or a tie, write it as it stands now and say in a few words how it changed.',
        );
    }
    return [{ role: 'system', content: ENTRY_SYSTEM_PROMPT }, { role: 'user', content: parts.join('\n') }];
}

/**
 * The notes on one slice of a character's events, for an arc too long for one entry call (§4.4, §5.2): what the slice
 * shows of who they are, and its biggest events, oldest first, each list a share of the lines one arc's notes hold.
 *
 * @param {{name: string, eventLines: string[], sliceNumber: number, sliceCount: number, languageName?: string|null}} slice
 * @returns {Array<{role: string, content: string}>}
 */
export function notesMessages({ name, eventLines, sliceNumber, sliceCount, languageName = null }) {
    const linesEach = notesLinesPerSlice(sliceCount);
    const prompt = [
        `Part ${sliceNumber} of ${sliceCount} of the story's events naming ${name}, oldest first, one per line:`,
        '',
        eventLines.join('\n'),
        '',
        `Take notes on this part for a lorebook entry about ${name}, in two lists:`,
        `Who they are: at most ${linesEach} lines, one fact per line, on what this part shows of ${name}'s identity, personality, past and ties. `
            + 'When it shows more of their past, or shows an earlier account of it was wrong, say so.',
        `Events: at most ${linesEach} lines, the events of this part that changed ${name} or the story most, oldest first, one event per line: `
            + 'when it happened, what happened, their part, the outcome.',
        'Keep names as written. Leave out where they were, what they wore and how they felt.',
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
