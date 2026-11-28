/**
 * The question another extension's write waits on (§2 of InternalProject/Vectfox/plans/public-api-writes.md): the
 * groups of writes, each asked once per extension and group for the page load; the page load's answers; the calls
 * that ask every time; and the queue that opens one question at a time. Suppress all warnings skips every question
 * and makes no answer, so a Deny given before it still holds. No host imports: public-api.js opens the questions in
 * SillyTavern's popup and reads the setting.
 */

import { counted } from '../../shared/counted.js';
import { textPreview } from '../../shared/text-preview.js';

/**
 * The groups of writes, each one question for each extension (§2.1). Each row: its ID, which the calls of the group
 * name, and what its question says the extension wants to change. The question and Suppress all warnings read this
 * table, so a new group is one row and its own calls.
 */
export const PUBLIC_WRITE_GROUPS = Object.freeze([
    Object.freeze({ id: 'eventbase', changes: 'your EventBase events' }),
]);

/** An answer the user gave a group's question this page load. */
const ANSWER = Object.freeze({ allowed: 'allowed', denied: 'denied' });

/** How many of the events a delete names its question shows by their summaries; the rest it counts. */
const NAMED_EVENT_COUNT = 3;

/** How many characters of an event's summary its delete question shows. */
const SUMMARY_PREVIEW_LENGTH = 60;

/**
 * The extension a write names as its own, by which its question asks the user and its answer is kept.
 * @param {unknown} owner - What the write gave as `owner`
 * @param {string} call - The call, as its TypeError names it
 * @returns {string}
 * @throws {TypeError} When it names no extension, a bug in the calling code
 */
export function writeOwnerOf(owner, call) {
    if (typeof owner !== 'string' || !owner.trim()) {
        throw new TypeError(`${call}: owner must name your extension, as VectFox's question names it to the user`);
    }
    return owner;
}

/**
 * The group's question: who asks, what it wants to change and for how long. It opens on Deny, so an Enter pressed as
 * it opens refuses the write.
 * @param {{changes: string}} group - A row of the group table
 * @param {string} owner - The extension that asks, as its write names it
 * @returns {{lines: object[], okButton: string, cancelButton: string, isDestructive: boolean}}
 */
export function groupQuestionOf(group, owner) {
    return {
        lines: [
            { parts: [{ name: owner }, { text: ` wants to change ${group.changes}.` }] },
            { text: 'It can change them until you reload SillyTavern.' },
            { text: 'Allow lets it. Deny refuses this change and the next ones.' },
        ],
        okButton: 'Allow',
        cancelButton: 'Deny',
        isDestructive: true,
    };
}

/**
 * The question before another extension deletes events: who asks, how many go and from which collection, the first
 * ones by their summaries, and that it cannot be undone, in the Chunk Visualizer's lines.
 * @param {string} owner - The extension that asks
 * @param {{collectionName: string, summaries: string[]}} deletion - collectionName: the collection's name, as the
 *   Database Browser shows it; summaries: each event's summary, in the order named
 * @returns {{lines: object[], okButton: string, cancelButton: string, isDestructive: boolean}}
 */
export function deleteEventsQuestionOf(owner, { collectionName, summaries }) {
    const named = summaries.slice(0, NAMED_EVENT_COUNT).map(summary => textPreview(summary, SUMMARY_PREVIEW_LENGTH) || 'No summary').join('; ');
    const more = summaries.length - NAMED_EVENT_COUNT;
    return {
        lines: [
            { parts: [{ name: owner }, { text: ` wants to delete ${counted(summaries.length, 'event')}.` }] },
            { text: 'Collection:', name: collectionName },
            { text: 'Events:', name: more > 0 ? `${named}; and ${more} more` : named },
            { text: 'Lost: their text and vectors. It cannot be undone.' },
            { text: 'Delete removes them. Cancel keeps them.' },
        ],
        okButton: 'Delete',
        cancelButton: 'Cancel',
        isDestructive: true,
    };
}

/**
 * The page load's answers to the write questions, and the queue that opens them one at a time, in the order the
 * writes came, so two extensions writing at once never stack two questions. The answers live as long as this object,
 * which public-api.js keeps for the page load, so a reload forgets every one.
 * @param {object} parts
 * @param {ReadonlyArray<{id: string, changes: string}>} parts.groups - The group table, PUBLIC_WRITE_GROUPS
 * @param {(question: {lines: object[], okButton: string, cancelButton: string, isDestructive: boolean}) => Promise<unknown>} parts.askUser -
 *   Opens one question and answers truthy only on its action button; closing it answers no
 * @param {() => boolean} parts.isSuppressed - Whether Suppress all warnings is on now
 * @returns {{mayWrite: (owner: string, groupId: string) => Promise<boolean>,
 *   mayRunAfterAsking: (owner: string, groupId: string, question: object) => Promise<boolean>}}
 */
export function createWriteQuestions({ groups, askUser, isSuppressed }) {
    /** @type {Map<string, Map<string, string>>} Each owner's answer for each group it asked. */
    const answers = new Map();
    let lastQuestion = Promise.resolve();

    const groupOf = (groupId) => {
        const group = groups.find(row => row.id === groupId);
        if (!group) throw new Error(`VectFox public API: '${groupId}' is not a group of writes`);
        return group;
    };
    const answerOf = (owner, groupId) => answers.get(owner)?.get(groupId) ?? null;
    const keepAnswer = (owner, groupId, answer) => {
        if (!answers.has(owner)) answers.set(owner, new Map());
        answers.get(owner).set(groupId, answer);
    };

    /**
     * What a call is answered: `decided`'s answer when it has one, now or once the questions queued before it have
     * closed, as a question answered while the call waited may answer it too; else what `ask` gets from the user, its
     * question opened in its turn.
     * @param {() => (boolean|null)} decided - The answer with no question, null when there is none
     * @param {() => Promise<boolean>} ask
     * @returns {Promise<boolean>}
     */
    const answerOrAsk = async (decided, ask) => {
        const before = decided();
        if (before !== null) return before;
        const turn = lastQuestion.then(() => decided() ?? ask());
        // EXPECTED: a question that fails rejects to its own caller through `turn`; the queue only waits for its end.
        lastQuestion = turn.catch(() => {});
        return turn;
    };

    /**
     * Whether a write of a group from an extension may go: its answer this page load, else the group's question,
     * asked once. Suppress all warnings lets it go with no question and keeps no answer.
     * @param {string} owner
     * @param {string} groupId
     * @returns {Promise<boolean>}
     */
    function mayWrite(owner, groupId) {
        const group = groupOf(groupId);
        return answerOrAsk(() => {
            const answer = answerOf(owner, groupId);
            if (answer) return answer === ANSWER.allowed;
            return isSuppressed() ? true : null;
        }, async () => {
            const isAllowed = Boolean(await askUser(groupQuestionOf(group, owner)));
            keepAnswer(owner, groupId, isAllowed ? ANSWER.allowed : ANSWER.denied);
            return isAllowed;
        });
    }

    /**
     * Whether a call that asks every time may go (§2.1): a Deny of its group answers no with no question; else its own
     * question, which answers for this call only. Suppress all warnings lets it go with no question.
     * @param {string} owner
     * @param {string} groupId
     * @param {{lines: object[], okButton: string, cancelButton: string, isDestructive: boolean}} question
     * @returns {Promise<boolean>}
     */
    function mayRunAfterAsking(owner, groupId, question) {
        groupOf(groupId);
        return answerOrAsk(() => {
            if (answerOf(owner, groupId) === ANSWER.denied) return false;
            return isSuppressed() ? true : null;
        }, async () => Boolean(await askUser(question)));
    }

    return { mayWrite, mayRunAfterAsking };
}
