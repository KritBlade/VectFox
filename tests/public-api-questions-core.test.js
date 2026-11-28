/**
 * The question another extension's write waits on (src/features/public-api/public-api-questions-core.js, §2 of
 * InternalProject/Vectfox/plans/public-api-writes.md): one question per extension and group for the page load; Deny,
 * or a question closed, answering no with no question after; a call that asks every time asking after Allow too, and
 * declined with no question after Deny; questions opened one at a time, in the order the writes came; Suppress all
 * warnings skipping every question and keeping no answer, a Deny given before it still holding; a group added to the
 * table asked and suppressed with no other change; and the lines each question shows.
 */

import { describe, expect, it } from 'vitest';
import {
    PUBLIC_WRITE_GROUPS, createWriteQuestions, deleteEventsQuestionOf, groupQuestionOf, writeOwnerOf,
} from '../src/features/public-api/public-api-questions-core.js';

/** A line as the dialog shows it: its fixed words and its value. */
const lineText = line => (line.parts
    ? line.parts.map(part => part.text ?? part.name).join('')
    : [line.text, line.name].filter(Boolean).join(' '));

/**
 * The user, as the questions see them: each question kept with its lines, answered at once with `answer`, or held
 * open until the test answers it when `answer` is null.
 */
function userAnswering(answer) {
    const user = { asked: [], answer };
    user.askUser = question => new Promise((resolve) => {
        user.asked.push({ ...question, text: question.lines.map(lineText), answer: resolve });
        if (user.answer !== null) resolve(user.answer);
    });
    return user;
}

/** The questions over the table given, the user and Suppress all warnings as the test sets them. */
function questionsFor(user, { groups = PUBLIC_WRITE_GROUPS, suppressed = { isOn: false } } = {}) {
    return createWriteQuestions({ groups, askUser: user.askUser, isSuppressed: () => suppressed.isOn });
}

/** Let every question that can open do so. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const DELETE_QUESTION = deleteEventsQuestionOf('Lore Organizer', { collectionName: 'Harbor events', summaries: ['Mara finds a key'] });

describe('the group question', () => {
    it('asks once for an extension and group: Allow lets every later write of it through with no question', async () => {
        const user = userAnswering(true);
        const questions = questionsFor(user);

        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);

        expect(user.asked.map(question => question.text)).toEqual([[
            'Lore Organizer wants to change your EventBase events.',
            'It can change them until you reload SillyTavern.',
            'Allow lets it. Deny refuses this change and the next ones.',
        ]]);
    });

    it('answers no after Deny, with no question for that extension\'s later writes, while another extension is asked its own', async () => {
        const user = userAnswering(false);
        const questions = questionsFor(user);

        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(false);
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(false);
        user.answer = true;
        expect(await questions.mayWrite('Tide Sorter', 'eventbase')).toBe(true);

        expect(user.asked.map(question => question.text[0])).toEqual([
            'Lore Organizer wants to change your EventBase events.',
            'Tide Sorter wants to change your EventBase events.',
        ]);
    });

    it('counts a question closed with no answer as Deny', async () => {
        const user = userAnswering(null);
        const questions = questionsFor(user);

        const asked = questions.mayWrite('Lore Organizer', 'eventbase');
        await settle();
        user.asked[0].answer(null);

        expect(await asked).toBe(false);
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(false);
        expect(user.asked).toHaveLength(1);
    });

    it('opens on Deny, with Allow and Deny as its buttons', () => {
        const { okButton, cancelButton, isDestructive, lines } = groupQuestionOf(PUBLIC_WRITE_GROUPS[0], 'Lore Organizer');

        expect({ okButton, cancelButton, isDestructive }).toEqual({ okButton: 'Allow', cancelButton: 'Deny', isDestructive: true });
        // The extension's name is a value, never part of a fixed sentence.
        expect(lines[0].parts[0]).toEqual({ name: 'Lore Organizer' });
    });
});

describe('a call that asks every time', () => {
    it('asks after Allow too, each answer for that call only', async () => {
        const user = userAnswering(true);
        const questions = questionsFor(user);
        await questions.mayWrite('Lore Organizer', 'eventbase');

        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(true);
        user.answer = false;
        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(false);
        user.answer = true;
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);

        expect(user.asked.map(question => question.okButton)).toEqual(['Allow', 'Delete', 'Delete']);
    });

    it('asks its own question alone when the group has no answer yet, which answers nothing for the group', async () => {
        const user = userAnswering(true);
        const questions = questionsFor(user);

        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(true);
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);

        expect(user.asked.map(question => question.okButton)).toEqual(['Delete', 'Allow']);
    });

    it('answers no with no question after a Deny of its group', async () => {
        const user = userAnswering(false);
        const questions = questionsFor(user);
        await questions.mayWrite('Lore Organizer', 'eventbase');

        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(false);
        expect(user.asked).toHaveLength(1);
    });
});

describe('the queue', () => {
    it('opens one question at a time, in the order the writes came, and a write waiting behind its own question goes with that answer', async () => {
        const user = userAnswering(null);
        const questions = questionsFor(user);

        const organizerFirst = questions.mayWrite('Lore Organizer', 'eventbase');
        const sorter = questions.mayWrite('Tide Sorter', 'eventbase');
        const organizerAgain = questions.mayWrite('Lore Organizer', 'eventbase');
        const organizerDelete = questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION);
        await settle();
        expect(user.asked.map(question => question.text[0])).toEqual(['Lore Organizer wants to change your EventBase events.']);

        user.asked[0].answer(true);
        expect(await organizerFirst).toBe(true);
        await settle();
        expect(user.asked.map(question => question.text[0])).toEqual([
            'Lore Organizer wants to change your EventBase events.',
            'Tide Sorter wants to change your EventBase events.',
        ]);

        user.asked[1].answer(false);
        expect(await sorter).toBe(false);
        expect(await organizerAgain).toBe(true);
        await settle();
        expect(user.asked).toHaveLength(3);
        expect(user.asked[2].okButton).toBe('Delete');
        user.asked[2].answer(true);
        expect(await organizerDelete).toBe(true);
    });

    it('lets a write that already has its answer go at once, past a question open for another extension', async () => {
        const user = userAnswering(true);
        const questions = questionsFor(user);
        await questions.mayWrite('Lore Organizer', 'eventbase');
        user.answer = null;

        const sorter = questions.mayWrite('Tide Sorter', 'eventbase');
        await settle();
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);

        user.asked[1].answer(true);
        expect(await sorter).toBe(true);
    });
});

describe('Suppress all warnings', () => {
    it('lets every write through with no question, deletes included, and keeps no answer', async () => {
        const user = userAnswering(false);
        const suppressed = { isOn: true };
        const questions = questionsFor(user, { suppressed });

        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(true);
        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(true);
        expect(user.asked).toHaveLength(0);

        suppressed.isOn = false;
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(false);
        expect(user.asked).toHaveLength(1);
    });

    it('keeps a Deny given before it was turned on', async () => {
        const user = userAnswering(false);
        const suppressed = { isOn: false };
        const questions = questionsFor(user, { suppressed });
        await questions.mayWrite('Lore Organizer', 'eventbase');

        suppressed.isOn = true;
        expect(await questions.mayWrite('Lore Organizer', 'eventbase')).toBe(false);
        expect(await questions.mayRunAfterAsking('Lore Organizer', 'eventbase', DELETE_QUESTION)).toBe(false);
        expect(user.asked).toHaveLength(1);
    });

    it('skips a question waiting in the queue once turned on', async () => {
        const user = userAnswering(null);
        const suppressed = { isOn: false };
        const questions = questionsFor(user, { suppressed });

        const organizer = questions.mayWrite('Lore Organizer', 'eventbase');
        const sorter = questions.mayWrite('Tide Sorter', 'eventbase');
        await settle();
        suppressed.isOn = true;
        user.asked[0].answer(true);

        expect(await organizer).toBe(true);
        expect(await sorter).toBe(true);
        expect(user.asked).toHaveLength(1);
    });
});

describe('a group added to the table', () => {
    const groups = [...PUBLIC_WRITE_GROUPS, { id: 'storyarc', changes: 'your StoryArc links and names' }];

    it('asks its own question, apart from the other groups\' answers, and Suppress all warnings skips it, with no other change', async () => {
        const user = userAnswering(true);
        const suppressed = { isOn: false };
        const questions = questionsFor(user, { groups, suppressed });
        await questions.mayWrite('Lore Organizer', 'eventbase');

        expect(await questions.mayWrite('Lore Organizer', 'storyarc')).toBe(true);
        expect(user.asked.map(question => question.text[0])).toEqual([
            'Lore Organizer wants to change your EventBase events.',
            'Lore Organizer wants to change your StoryArc links and names.',
        ]);

        suppressed.isOn = true;
        expect(await questions.mayWrite('Tide Sorter', 'storyarc')).toBe(true);
        expect(user.asked).toHaveLength(2);
    });

    it('is the only way a group is asked: one the table does not hold is a bug in VectFox', () => {
        const questions = questionsFor(userAnswering(true));
        expect(() => questions.mayWrite('Lore Organizer', 'storyarc')).toThrow("'storyarc' is not a group of writes");
    });
});

describe('the delete question', () => {
    it('names the extension, the collection, how many go and the first three by the start of their summaries', () => {
        const summaries = [
            'Mara finds a brass key under the pier, where the storm broke the old lamps and the tide left the nets',
            'Tobin keeps the key', '', 'The ferry runs again', 'The lighthouse goes dark',
        ];
        const question = deleteEventsQuestionOf('Lore Organizer', { collectionName: 'Harbor events', summaries });

        expect(question.lines.map(lineText)).toEqual([
            'Lore Organizer wants to delete 5 events.',
            'Collection: Harbor events',
            'Events: Mara finds a brass key under the pier, where the storm broke…; Tobin keeps the key; No summary; and 2 more',
            'Lost: their text and vectors. It cannot be undone.',
            'Delete removes them. Cancel keeps them.',
        ]);
        expect({ okButton: question.okButton, cancelButton: question.cancelButton, isDestructive: question.isDestructive })
            .toEqual({ okButton: 'Delete', cancelButton: 'Cancel', isDestructive: true });
    });

    it('counts one event as one, with nothing more', () => {
        const question = deleteEventsQuestionOf('Lore Organizer', { collectionName: 'Harbor events', summaries: ['Tobin keeps the key'] });
        expect(question.lines.slice(0, 3).map(lineText)).toEqual([
            'Lore Organizer wants to delete 1 event.', 'Collection: Harbor events', 'Events: Tobin keeps the key',
        ]);
    });
});

describe('the owner a write names', () => {
    it('is the extension\'s name, and a write that names none is a bug in the calling code', () => {
        expect(writeOwnerOf('Lore Organizer', 'VectFox.eventBase.updateEvent()')).toBe('Lore Organizer');
        for (const owner of [undefined, '', '   ', 7, {}]) {
            expect(() => writeOwnerOf(owner, 'VectFox.eventBase.updateEvent()'), String(owner)).toThrow(TypeError);
        }
    });
});
