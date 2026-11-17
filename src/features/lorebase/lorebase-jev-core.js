/**
 * LoreBase's Fast and cheap choice (plan D16 and §5.6 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): Jev, a decisions model, reads the scene and one yes-or-no question per
 * entry of the table of contents, its title and keys, and answers each with its chance of yes; the entries above 0.25,
 * at most 6, go whole, with no review. The state and questions are T22's word for word (`decision_state` and
 * `decision_pick_questions` in tools/lorebase-benchmark/segment_trials.py); tests/lorebase-jev-core.test.js holds them to
 * its own rendering. Pure: no SillyTavern, no network.
 */
import { tableOfContents } from './lorebase-pick-core.js';
import { SENT_WHOLE_UNREVIEWED, callFailureDetail } from './lorebase-reply-core.js';
import { entryPassages } from './lorebase-splitter.js';

// The entries Jev rates above this chance of yes are picked (the user, 2026-11-17, after T22's samples).
const JEV_CUT = 0.25;
// At most as many picks as Luna's.
const MOST_JEV_PICKS = 6;
const CHAT_INTRO = "The chat so far. The last message is the user's; the next reply answers it.";

/**
 * Jev's state: the scene after the line that opens the pick's, as T22 sent it.
 * @param {string} scene - From sceneText
 * @returns {string}
 */
export function jevState(scene) {
    return `${CHAT_INTRO}\n\n${scene}`;
}

const questionName = number => `e${number}`;

/**
 * Jev's questions: one per entry of the table of contents, named by its number.
 * @param {Array<{number: number, title: string, keys: string[]}>} contents - From tableOfContents
 * @returns {Record<string, {type: string, instructions: string}>}
 */
export function jevQuestions(contents) {
    return Object.fromEntries(contents.map(item => [questionName(item.number), {
        type: 'noul',
        instructions: `Does the next reply need the lorebook entry "${item.title}"${item.keys.length ? ` (about: ${item.keys.join(', ')})` : ''}?`,
    }]));
}

/**
 * The entries Jev picks: those it rates above 0.25, best first, a tie in the table's order, at most 6.
 * @param {Record<string, number>} yes - Each question's chance of yes, by question name
 * @param {Array<{number: number, bookName: string, uid: number, title: string, keys: string[]}>} contents
 * @returns {Array<{number: number, bookName: string, uid: number, title: string, keys: string[], yes: number}>}
 */
export function jevPicks(yes, contents) {
    return contents
        .map(item => ({ ...item, yes: yes[questionName(item.number)] }))
        .filter(item => Number.isFinite(item.yes) && item.yes > JEV_CUT)
        .sort((a, b) => b.yes - a.yes || a.number - b.number)
        .slice(0, MOST_JEV_PICKS);
}

/**
 * A reply's lore from Jev's picks, shaped as loreForReply's: every pick sent whole, with no review.
 * @param {object} turn
 * @param {ReturnType<typeof jevPicks>} turn.picks
 * @param {Array<{bookName: string, entries: object[]}>} turn.books - The books taking part
 * @param {number} turn.contentCount - Entries Jev was asked about
 * @param {number} turn.pickSeconds - How long Jev took
 * @returns {import('./lorebase-reply-core.js').ReplyLore}
 */
export function jevReplyLore({ picks, books, contentCount, pickSeconds }) {
    const reviewedPicks = picks.map(pick => {
        const entry = books.find(book => book.bookName === pick.bookName).entries.find(candidate => candidate.uid === pick.uid);
        const { frame, passages } = entryPassages(entry);
        return {
            bookName: pick.bookName, uid: pick.uid, title: pick.title, uses: SENT_WHOLE_UNREVIEWED, frame, passages,
            sentParts: passages.map((_, index) => index + 1), seconds: null,
        };
    });
    return { contentCount, picks, unreadItemCount: 0, pickSeconds, reviewedPicks, failures: [] };
}

/**
 * The lore for one reply on Fast and cheap: one request to Jev over the table of contents of the books taking part,
 * its picks sent whole. A failed request is a failed pick, which leaves every selected entry out (D14).
 * @param {object} turn
 * @param {string} turn.scene - From sceneText
 * @param {Array<{bookName: string, entries: object[], keysByUid?: Record<string, string[]>}>} turn.books - The books
 *   taking part, in book order, each with the entries LoreBase decides in it and their keys
 * @param {(state: string, questions: object) => Promise<{yes: Record<string, number>}>} turn.ask - Asks Jev; throws
 *   when the request fails
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore>}
 */
export async function loreForReplyByJev({ scene, books, ask }) {
    const contents = tableOfContents(books);
    const startedAt = performance.now();
    const secondsTaken = () => (performance.now() - startedAt) / 1000;
    try {
        const { yes } = await ask(jevState(scene), jevQuestions(contents));
        return jevReplyLore({ picks: jevPicks(yes, contents), books, contentCount: contents.length, pickSeconds: secondsTaken() });
    } catch (error) {
        return {
            contentCount: contents.length, picks: [], unreadItemCount: 0, pickSeconds: secondsTaken(), reviewedPicks: [],
            failures: [{ step: 'pick', detail: callFailureDetail(error), error }],
        };
    }
}
