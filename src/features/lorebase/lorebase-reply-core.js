/**
 * LoreBase on a reply, the pure rules (plan §5.6, §5.8 and D8 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): which generations it serves, the books taking part and the entries it
 * decides in them, the pick and one review per pick, all sent at once on a call the caller supplies, and the toast for
 * a turn that left lore out (D14). Pure: no SillyTavern, no network.
 */
import { pickMessages, readPicks, tableOfContents } from './lorebase-pick-core.js';
import { partsToSend, readReview, reviewMessages } from './lorebase-review-core.js';
import { entryPassages } from './lorebase-splitter.js';

// Replies (D8): normal sends, swipes, regenerates and continues, and a quiet generation only when it is quiet-to-loud.
// Never impersonate: the pick's prompt (the reply answers the user's last message) was never tested on it.
const REPLY_GENERATION_TYPES = new Set(['normal', 'swipe', 'regenerate', 'continue']);
const QUIET_GENERATION_TYPE = 'quiet';

// The trials' requests (route_trials.py): room for each answer, and room for a thinking model to reason before it.
const THINKING_TOKEN_ALLOWANCE = 8000;
const PICK_MAX_TOKENS = 1500 + THINKING_TOKEN_ALLOWANCE;
const REVIEW_MAX_TOKENS = 2000 + THINKING_TOKEN_ALLOWANCE;
// The pick runs at low reasoning effort on either Accuracy setting (D6).
const PICK_REASONING_EFFORT = 'low';
const HIGH_ACCURACY = 'high';

/** A call that has not answered by then fails (§5.8). The trials' slowest pick took 4.8 seconds, their slowest review 9.3. */
export const CALL_TIMEOUT_MS = 30000;

const UNREADABLE_ANSWER = 'its answer could not be read';
// Room for a provider's own error text in the toast.
const DETAIL_CHARACTERS = 320;

/**
 * Whether a generation is a reply LoreBase picks lore for (D8).
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {{type: string, isQuietToLoud: boolean}|null} lastGeneration - The last generation past its slash commands, as
 *   GENERATION_AFTER_COMMANDS reported it, the one place SillyTavern says whether a quiet generation is quiet-to-loud
 * @returns {boolean}
 */
export function isReplyGeneration(type, lastGeneration) {
    if (REPLY_GENERATION_TYPES.has(type)) return true;
    return type === QUIET_GENERATION_TYPE && lastGeneration?.type === QUIET_GENERATION_TYPE && lastGeneration.isQuietToLoud === true;
}

/**
 * The books SillyTavern's scan loads for a generation, each once, in the order it loads them (world-info.js,
 * getSortedEntries): the global books, the character's own and extra books, the chat's book, then the persona's. A
 * character's book that is also the chat's or the persona's loads as that one, and the chat's or the persona's book
 * that is also global loads as global.
 * @param {{globalBooks: string[], characterBooks: string[], chatBook: string|null, personaBook: string|null}} sources
 * @returns {string[]}
 */
export function activeBookNames({ globalBooks, characterBooks, chatBook, personaBook }) {
    const isGlobal = name => globalBooks.includes(name);
    const names = [...globalBooks];
    for (const name of characterBooks) {
        if (!isGlobal(name) && name !== chatBook && name !== personaBook) names.push(name);
    }
    if (chatBook && !isGlobal(chatBook)) names.push(chatBook);
    if (personaBook && personaBook !== chatBook && !isGlobal(personaBook)) names.push(personaBook);
    return [...new Set(names.filter(Boolean))];
}

/**
 * The entries LoreBase decides in a book, in the book's own order: those the user selected, except where SillyTavern
 * keeps the entry its own (§5.2): a disabled entry, which it never sends; a constant one, which it always sends; and
 * one with sticky or cooldown, whose timers it finds again by a hash a forced entry lacks.
 * @param {{entries?: object}|null} book - The book as loadWorldInfo returns it
 * @param {{selectedUids: string[]}|null} record - The book's record, from getLoreBook
 * @returns {object[]}
 */
export function decidedEntries(book, record) {
    const selected = new Set(record?.selectedUids ?? []);
    return Object.values(book?.entries ?? {}).filter(entry => selected.has(String(entry.uid))
        && !entry.disable && !entry.constant && !(Number(entry.sticky) > 0) && !(Number(entry.cooldown) > 0));
}

/**
 * The review's reasoning effort: High Accuracy asks at the model's default, so none is sent; Default Accuracy at low.
 * @param {string} accuracy - The lorebase_accuracy setting
 * @returns {string|null}
 */
export function reviewEffort(accuracy) {
    return accuracy === HIGH_ACCURACY ? null : 'low';
}

/**
 * What a failed call's toast says went wrong: the call's own error, except for a call that did not answer in time or
 * an answer with nothing to read.
 * @param {unknown} error
 * @returns {string}
 */
function failureDetail(error) {
    if (error?.name === 'TimeoutError') return `it did not answer within ${CALL_TIMEOUT_MS / 1000} seconds`;
    if (error?.kind === 'parse') return UNREADABLE_ANSWER;
    return String(error?.message || error).replace(/\s+/g, ' ').trim();
}

async function reviewPick(pick, { scene, books, effort, ask }) {
    const book = books.find(candidate => candidate.bookName === pick.bookName);
    const entry = book.entries.find(candidate => candidate.uid === pick.uid);
    const { frame, passages } = entryPassages(entry);
    try {
        const items = await ask(reviewMessages(scene, pick, passages), { maxTokens: REVIEW_MAX_TOKENS, reasoningEffort: effort, identKeys: ['entry'] });
        const review = readReview(items, passages.length);
        if (!review) return { failure: { step: 'review', title: pick.title, detail: UNREADABLE_ANSWER } };
        const sentParts = partsToSend(passages, review, book.pinnedSections);
        return { reviewedPick: { bookName: pick.bookName, uid: pick.uid, title: pick.title, uses: review.uses, frame, passages, sentParts } };
    } catch (error) {
        return { failure: { step: 'review', title: pick.title, detail: failureDetail(error), error } };
    }
}

/**
 * @typedef {object} ReplyLore
 * @property {number} contentCount - Entries in the table of contents the pick read
 * @property {object[]} picks - From readPicks, most needed first
 * @property {number} unreadItemCount - Items of the pick's answer that named no entry of the table
 * @property {Array<{bookName: string, uid: number, title: string, uses: string, frame: object|null, passages: object[],
 *   sentParts: number[]}>} reviewedPicks - Each pick whose review was read, with the numbers of the parts it sends:
 *   none when the review says the reply uses none of the entry
 * @property {Array<{step: string, title?: string, detail: string, error?: unknown}>} failures - The failed pick, or
 *   each failed review; `error` is what the call threw, and an answer that could not be read has none
 */

/**
 * The lore for one reply: the pick over the table of contents of the books taking part, then one review per pick, all
 * sent at once. A failed pick leaves every selected entry out, and a failed review leaves out only its own entry (D14).
 * @param {object} turn
 * @param {string} turn.scene - From sceneText
 * @param {Array<{bookName: string, entries: object[], pinnedSections: string[]}>} turn.books - The books taking part,
 *   in book order, each with the entries LoreBase decides in it (decidedEntries)
 * @param {string|null} turn.reviewEffort - From reviewEffort
 * @param {(messages: Array<{role: string, content: string}>, request: {maxTokens: number, reasoningEffort: string|null,
 *   identKeys: string[]}) => Promise<unknown[]>} turn.ask - Sends one call and returns its answer's entries, as
 *   parseJsonArrayFromLlm reads them; throws when the call fails
 * @returns {Promise<ReplyLore>}
 */
export async function loreForReply({ scene, books, reviewEffort: effort, ask }) {
    const contents = tableOfContents(books);
    let picked;
    try {
        const items = await ask(pickMessages(scene, contents), { maxTokens: PICK_MAX_TOKENS, reasoningEffort: PICK_REASONING_EFFORT, identKeys: ['number'] });
        picked = readPicks(items, contents);
    } catch (error) {
        return { contentCount: contents.length, picks: [], unreadItemCount: 0, reviewedPicks: [], failures: [{ step: 'pick', detail: failureDetail(error), error }] };
    }
    const reviews = await Promise.all(picked.picks.map(pick => reviewPick(pick, { scene, books, effort, ask })));
    return {
        contentCount: contents.length,
        picks: picked.picks,
        unreadItemCount: picked.unreadItemCount,
        reviewedPicks: reviews.filter(review => review.reviewedPick).map(review => review.reviewedPick),
        failures: reviews.filter(review => review.failure).map(review => review.failure),
    };
}

/**
 * The toast for a turn that left lore out (D14, §5.8): what failed, what the reply goes on without, and that
 * regenerating the message tries again.
 * @param {Array<{step: string, title?: string, detail: string}>} failures - The failed pick, or the failed reviews; at least one
 * @param {number} pickCount - How many entries the pick named
 * @returns {string}
 */
export function leftOutLoreMessage(failures, pickCount) {
    const details = `Regenerate the message to try again. Details: ${failures[0].detail.slice(0, DETAIL_CHARACTERS)}`;
    if (failures[0].step === 'pick') {
        return `LoreBase could not pick the lore for this reply, so none of the entries selected for LoreBase go in. ${details}`;
    }
    const titles = failures.map(failure => `"${failure.title}"`).join(', ');
    const subject = failures.length === 1 ? `its pick ${titles}, so it is` : `${failures.length} of its picks (${titles}), so they are`;
    const others = pickCount > failures.length ? ' while the other picks go in' : '';
    return `LoreBase could not review ${subject} left out of this reply${others}. ${details}`;
}
