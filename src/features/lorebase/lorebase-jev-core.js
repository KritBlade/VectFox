/**
 * LoreBase's Fast and Cheap [Jev] choice (plan D16 and §5.6 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md, §5 of lorebook-multi-vector.md): Jev, a decisions model, reads the scene
 * and one yes-or-no question per entry, its title and keys, and answers each with its chance of yes; the entries above
 * 0.25 go whole, with no review, best first, within the lore budget. Above POOL_SEATS entries, a search first finds the
 * POOL_SEATS that Jev is asked about. The state and questions are T22's word for word (`decision_state` and
 * `decision_pick_questions` in tools/lorebase-benchmark/segment_trials.py), the budget T37's (`budgeted_entries`);
 * tests/lorebase-jev-core.test.js holds them to its own rendering. Pure: no SillyTavern, no network.
 */
import { tableOfContents } from './lorebase-pick-core.js';
import { SENT_WHOLE_UNREVIEWED, callFailureDetail } from './lorebase-reply-core.js';
import { entryPassages } from './lorebase-splitter.js';

// The entries Jev rates above this chance of yes are picked (the user, 2026-11-17, after T22's samples).
const JEV_CUT = 0.25;
/** The search's seats (§5 of lorebook-multi-vector.md): Jev is asked about the search's this many best entries, and
 * about every entry when the books taking part have no more, as a search would then keep them all. */
export const POOL_SEATS = 100;
/** The lore budget, in tokens a reply (Q4 of lorebook-multi-vector.md): 4,000 by default, and its bounds. */
export const LORE_BUDGET_DEFAULT = 4000;
export const LORE_BUDGET_MIN = 1000;
export const LORE_BUDGET_MAX = 12000;
const CHAT_INTRO = "The chat so far. The last message is the user's; the next reply answers it.";

/**
 * The lore budget from its saved value: a whole number of tokens from the least to the most, or the default for a
 * setting that holds no number.
 * @param {unknown} value - The lorebase_lore_budget_tokens setting
 * @returns {number}
 */
export function loreBudgetOf(value) {
    const tokens = Number.parseInt(value, 10);
    return Number.isFinite(tokens) ? Math.min(LORE_BUDGET_MAX, Math.max(LORE_BUDGET_MIN, tokens)) : LORE_BUDGET_DEFAULT;
}

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
 * The entries Jev picks (T37's budgeted_entries): those it rates above 0.25, best first, a tie in the table's order,
 * within the lore budget: the best always, and each next one when it keeps the lore within the budget, one that would
 * pass it skipped and the next tried.
 * @param {Record<string, number>} yes - Each question's chance of yes, by question name
 * @param {Array<{number: number, bookName: string, uid: number, title: string, keys: string[]}>} contents - The entries
 *   Jev was asked about
 * @param {(item: {bookName: string, uid: number}) => number} tokensOf - An entry's tokens, as it goes whole
 * @param {number} budget - The lore budget, in those tokens
 * @returns {Array<{number: number, bookName: string, uid: number, title: string, keys: string[], yes: number}>}
 */
export function jevPicks(yes, contents, tokensOf, budget) {
    const rated = contents
        .map(item => ({ ...item, yes: yes[questionName(item.number)] }))
        .filter(item => Number.isFinite(item.yes) && item.yes > JEV_CUT)
        .sort((a, b) => b.yes - a.yes || a.number - b.number);
    const picks = [];
    let tokens = 0;
    for (const item of rated) {
        const size = tokensOf(item);
        if (picks.length && tokens + size > budget) continue;
        picks.push(item);
        tokens += size;
    }
    return picks;
}

/**
 * A reply's lore from Jev's picks, shaped as loreForReply's: every pick sent whole, with no review, keeping Jev's chance
 * of yes for the reply lore list.
 * @param {object} turn
 * @param {ReturnType<typeof jevPicks>} turn.picks
 * @param {Array<{bookName: string, entries: object[]}>} turn.books - The books taking part
 * @param {number} turn.contentCount - The books' entries in the table of contents
 * @param {number|null} turn.pickSeconds - How long Jev took; null when it was not asked
 * @param {{seats: number, poolCount: number|null, seconds: number|null}} turn.search - The search before Jev
 * @returns {import('./lorebase-reply-core.js').ReplyLore}
 */
export function jevReplyLore({ picks, books, contentCount, pickSeconds, search }) {
    const reviewedPicks = picks.map(pick => {
        const { frame, passages } = entryPassages(entryOf(books, pick));
        return {
            bookName: pick.bookName, uid: pick.uid, title: pick.title, uses: SENT_WHOLE_UNREVIEWED, frame, passages,
            sentParts: passages.map((_, index) => index + 1), seconds: null, jevChance: pick.yes,
        };
    });
    return { contentCount, picks, unreadItemCount: 0, pickSeconds, search, reviewedPicks, failures: [] };
}

const entryOf = (books, item) => books.find(book => book.bookName === item.bookName).entries.find(candidate => candidate.uid === item.uid);
const entryTokens = entry => entryPassages(entry).passages.reduce((total, passage) => total + passage.tokens, 0);
const secondsSince = startedAt => (performance.now() - startedAt) / 1000;

/**
 * The lore for one reply on Fast and Cheap [Jev] (§5 of lorebook-multi-vector.md): at POOL_SEATS entries or fewer in
 * the table of contents of the books taking part, Jev is asked about every one; above, the search's POOL_SEATS best,
 * in the table's order. Jev's picks go whole within the lore budget, the books sharing it. A failed search, as a failed
 * request to Jev, is a failed pick, which leaves every selected entry out (D14).
 * @param {object} turn
 * @param {string} turn.scene - From sceneText
 * @param {Array<{bookName: string, entries: object[], keysByUid?: Record<string, string[]>}>} turn.books - The books
 *   taking part, in book order, each with its ready entries and their keys
 * @param {(state: string, questions: object) => Promise<{yes: Record<string, number>}>} turn.ask - Asks Jev; throws
 *   when the request fails
 * @param {(contents: object[]) => Promise<object[]>} turn.searchPool - The search's pool of the table of contents
 *   (searchReplyPool); throws when the search fails
 * @param {number} turn.loreBudget - In tokens, from loreBudgetOf
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore>}
 */
export async function loreForReplyByJev({ scene, books, ask, searchPool, loreBudget }) {
    const contents = tableOfContents(books);
    const search = { seats: POOL_SEATS, poolCount: null, seconds: null };
    const failed = (detail, error, pickSeconds) => ({
        contentCount: contents.length, picks: [], unreadItemCount: 0, pickSeconds, search, reviewedPicks: [],
        failures: [{ step: 'pick', detail, error }],
    });
    let asked = contents;
    if (contents.length > POOL_SEATS) {
        const searchStartedAt = performance.now();
        try {
            asked = await searchPool(contents);
        } catch (error) {
            search.seconds = secondsSince(searchStartedAt);
            return failed(`the search failed: ${callFailureDetail(error)}`, error, null);
        }
        search.seconds = secondsSince(searchStartedAt);
        search.poolCount = asked.length;
        // A search that found no part of a ready entry leaves Jev nothing to be asked.
        if (!asked.length) return jevReplyLore({ picks: [], books, contentCount: contents.length, pickSeconds: null, search });
    }
    const startedAt = performance.now();
    try {
        const { yes } = await ask(jevState(scene), jevQuestions(asked));
        const picks = jevPicks(yes, asked, item => entryTokens(entryOf(books, item)), loreBudget);
        return jevReplyLore({ picks, books, contentCount: contents.length, pickSeconds: secondsSince(startedAt), search });
    } catch (error) {
        return failed(callFailureDetail(error), error, secondsSince(startedAt));
    }
}
