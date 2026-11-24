/**
 * LoreBase on a reply, the pure rules (plan §5.6, §5.8 and D8 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): which generations it serves, the books taking part and the entries it
 * decides in them, the pick and one review per pick, all sent at once on a call the caller supplies and each timed for
 * the tester (§5.10), the toast for a turn that left lore out (D14), and when a reply says it leaves out selected entries
 * that have no keys (D17). Pure: no SillyTavern, no network.
 */
import { counted } from '../../shared/counted.js';
import { isQuietToLoud } from '../../shared/last-generation-core.js';
import { ACTIVATE_DECORATOR, DONT_ACTIVATE_DECORATOR, activationDecoratorOf } from './lorebase-decorators-core.js';
import { pickMessages, readPicks, tableOfContents } from './lorebase-pick-core.js';
import { hasTemplateCode, partsToSend, readReview, reviewMessages } from './lorebase-review-core.js';
import { entryPassages } from './lorebase-splitter.js';

// Replies (D8): normal sends, swipes, regenerates and continues, and a quiet generation only when it is quiet-to-loud.
// Never impersonate: the pick's prompt (the reply answers the user's last message) was never tested on it.
const REPLY_GENERATION_TYPES = new Set(['normal', 'swipe', 'regenerate', 'continue']);

// The trials' requests (route_trials.py): room for each answer, and room for a thinking model to reason before it.
export const THINKING_TOKEN_ALLOWANCE = 8000;
const PICK_MAX_TOKENS = 1500 + THINKING_TOKEN_ALLOWANCE;
const REVIEW_MAX_TOKENS = 2000 + THINKING_TOKEN_ALLOWANCE;
// The pick and every review run at low reasoning effort (D6).
const REASONING_EFFORT = 'low';
/**
 * The lorebase_accuracy values (plan §2 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): Fast and Cheap
 * [Jev], the default, Jev in place of Luna's pick and reviews (D16); and High Accuracy, Luna's pick and reviews.
 */
export const FAST_AND_CHEAP = 'fast';
const HIGH_ACCURACY = 'high';

/** A call that has not answered by then fails (§5.8). The trials' slowest pick took 4.8 seconds, their slowest review 9.3. */
export const CALL_TIMEOUT_MS = 30000;

const UNREADABLE_ANSWER = 'its answer could not be read';
// Room for a provider's own error text in the toast.
const DETAIL_CHARACTERS = 320;

/**
 * Whether a generation is a reply LoreBase picks lore for (D8).
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {import('../../shared/last-generation-core.js').GenerationPastCommands|null} lastGeneration - The last
 *   generation past its slash commands, the one place SillyTavern says whether a quiet generation is quiet-to-loud
 * @returns {boolean}
 */
export function isReplyGeneration(type, lastGeneration) {
    return REPLY_GENERATION_TYPES.has(type) || isQuietToLoud(type, lastGeneration);
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
 * Why LoreBase cannot decide an entry, so it cannot be selected (§5.2), or null. SillyTavern keeps it its own when it is
 * constant, which it always sends; has sticky or cooldown, whose timers it finds again by a hash a forced entry lacks;
 * or an @@activate or @@dont_activate line opens it (activationDecoratorOf), which its scan sends every time or never,
 * read before the keys and before the LoreBase block that would go in the entry's place. An entry with no text has
 * nothing to key, pick or send ('empty'), so its keys would fail at every writing. The one list of these: isDecidedEntry
 * and the selection screen's rows (undecidableReason) both read it.
 * @param {{content?: string, constant?: boolean, sticky?: number, cooldown?: number}} entry
 * @returns {'constant'|'sticky'|'cooldown'|'activate_decorator'|'dont_activate_decorator'|'empty'|null}
 */
export function undecidableReasonOf(entry) {
    if (entry.constant) return 'constant';
    if (Number(entry.sticky) > 0) return 'sticky';
    if (Number(entry.cooldown) > 0) return 'cooldown';
    const decorator = activationDecoratorOf(entry.content);
    if (decorator === ACTIVATE_DECORATOR) return 'activate_decorator';
    if (decorator === DONT_ACTIVATE_DECORATOR) return 'dont_activate_decorator';
    if (!String(entry.content ?? '').trim()) return 'empty';
    return null;
}

/**
 * Whether LoreBase decides an entry (§5.2): the user selected it, SillyTavern has it enabled, as it never sends a
 * disabled one, and nothing keeps it from LoreBase (undecidableReasonOf). The one rule: the reply, the scan, every
 * writing, prune and count read it, and the selection screen's rows by isDecidedRow.
 * @param {{uid: number|string, content?: string, disable?: boolean, constant?: boolean, sticky?: number, cooldown?: number}} entry
 * @param {Set<string>} selectedUids - The selected uids of the book's selection in use, or of every one of them
 * @returns {boolean}
 */
export function isDecidedEntry(entry, selectedUids) {
    return selectedUids.has(String(entry.uid)) && !entry.disable && undecidableReasonOf(entry) === null;
}

/**
 * The entries LoreBase decides in a book (isDecidedEntry), in the book's own order.
 * @param {{entries?: object}|null} book - The book as loadWorldInfo returns it
 * @param {{selectedUids: string[]}|null} selection - One of the book's selections, or every entry they hold together
 * @returns {object[]}
 */
export function decidedEntries(book, selection) {
    const selected = new Set(selection?.selectedUids ?? []);
    return Object.values(book?.entries ?? {}).filter(entry => isDecidedEntry(entry, selected));
}

/**
 * The choice a lorebase_accuracy value runs: Fast and Cheap [Jev] on `fast`, High Accuracy on any other. So a profile
 * still holding a value the dropdown no longer offers runs High Accuracy, and the dropdown shows it, until it is set
 * (plan §2 of lorebook-multi-vector.md).
 * @param {unknown} value - The lorebase_accuracy setting
 * @returns {'fast'|'high'}
 */
export function loreBaseAccuracyOf(value) {
    return value === FAST_AND_CHEAP ? FAST_AND_CHEAP : HIGH_ACCURACY;
}

/**
 * What a failed call's toast says went wrong: the call's own error, except for a call that did not answer in time or
 * an answer with nothing to read.
 * @param {unknown} error
 * @returns {string}
 */
export function callFailureDetail(error) {
    if (error?.name === 'TimeoutError') return `it did not answer within ${CALL_TIMEOUT_MS / 1000} seconds`;
    if (error?.kind === 'parse') return UNREADABLE_ANSWER;
    return String(error?.message || error).replace(/\s+/g, ' ').trim();
}

const secondsSince = startedAt => (performance.now() - startedAt) / 1000;

/** A pick sent whole with no review: its `uses`, which the tester shows as not reviewed. */
export const SENT_WHOLE_UNREVIEWED = 'whole';

/**
 * Whether a pick goes whole with no review (T20's luna_keys+one_part_whole): the review could only keep or drop it
 * whole, as it is one part, or has template code, which is sent whole (D9).
 * @param {{content?: string}} entry
 * @param {object[]} passages - The entry's parts, from entryPassages
 * @returns {boolean}
 */
export function isSentWholeUnreviewed(entry, passages) {
    return passages.length === 1 || hasTemplateCode(entry.content);
}

async function reviewPick(pick, { scene, books, ask }) {
    const book = books.find(candidate => candidate.bookName === pick.bookName);
    const entry = book.entries.find(candidate => candidate.uid === pick.uid);
    const { frame, passages } = entryPassages(entry);
    if (isSentWholeUnreviewed(entry, passages)) {
        const sentParts = passages.map((_, index) => index + 1);
        return { reviewedPick: { bookName: pick.bookName, uid: pick.uid, title: pick.title, uses: SENT_WHOLE_UNREVIEWED, frame, passages, sentParts, seconds: null } };
    }
    const failure = { step: 'review', bookName: pick.bookName, uid: pick.uid, title: pick.title };
    const startedAt = performance.now();
    try {
        const items = await ask(reviewMessages(scene, pick, passages), { maxTokens: REVIEW_MAX_TOKENS, reasoningEffort: REASONING_EFFORT, identKeys: ['entry'] });
        const seconds = secondsSince(startedAt);
        const review = readReview(items, passages.length);
        if (!review) return { failure: { ...failure, detail: UNREADABLE_ANSWER, seconds } };
        const sentParts = partsToSend(passages, review, book.pinnedSections);
        return { reviewedPick: { bookName: pick.bookName, uid: pick.uid, title: pick.title, uses: review.uses, frame, passages, sentParts, seconds } };
    } catch (error) {
        return { failure: { ...failure, detail: callFailureDetail(error), error, seconds: secondsSince(startedAt) } };
    }
}

/**
 * @typedef {object} ReplyLore
 * @property {number} contentCount - Entries in the table of contents the pick read
 * @property {object[]} picks - From readPicks, most needed first
 * @property {number} unreadItemCount - Items of the pick's answer that named no entry of the table
 * @property {number|null} pickSeconds - How long the pick took to answer, or to fail; null when it was not asked, as
 *   when Fast and Cheap [Jev]'s search failed or found nothing
 * @property {{prompt: number|null, cached: number|null}|null} [pickTokens] - On High Accuracy, the pick's prompt
 *   tokens and those the provider read from its cache, each null where it did not report them (§7.5 of
 *   lorebook-multi-vector.md); null when the call reported no counts or none came back; absent on Fast and Cheap [Jev]
 * @property {{seats: number, poolCount: number|null, seconds: number|null}} [search] - On Fast and Cheap [Jev], the
 *   search before Jev: the most entries Jev is asked about, how many the search kept, null when the entries were no
 *   more than the seats and nothing was searched, and how long it took (§5 of lorebook-multi-vector.md); absent on
 *   High Accuracy
 * @property {Array<{bookName: string, uid: number, title: string, uses: string, frame: object|null, passages: object[],
 *   sentParts: number[], seconds: number|null}>} reviewedPicks - Each pick whose review was read, with the numbers of
 *   the parts it sends: none when the review says the reply uses none of the entry; and how long its review took; and
 *   each pick sent whole with no review (isSentWholeUnreviewed), its uses SENT_WHOLE_UNREVIEWED and its seconds null
 * @property {Array<{step: string, bookName?: string, uid?: number, title?: string, detail: string, error?: unknown,
 *   seconds?: number}>} failures - The failed pick, or each failed review with its entry and how long it took; `error`
 *   is what the call threw, and an answer that could not be read has none
 */

/**
 * The lore for one reply on High Accuracy: the pick over the table of contents of the books taking part, then one
 * review per pick of more than one part, all sent at once, each at low reasoning effort, a one-part pick or one with
 * template code sent whole with no review. A failed pick leaves every selected entry out, and a failed review leaves
 * out only its own entry (D14).
 * @param {object} turn
 * @param {string} turn.scene - From sceneText
 * @param {Array<{bookName: string, entries: object[], pinnedSections: string[], keysByUid?: Record<string, string[]>}>} turn.books -
 *   The books taking part, in book order, each with the entries LoreBase decides in it (decidedEntries) and their keys
 * @param {(messages: Array<{role: string, content: string}>, request: {maxTokens: number, reasoningEffort: string,
 *   identKeys: string[]}) => Promise<unknown[]>} turn.ask - Sends one call and returns its answer's entries, as
 *   parseJsonArrayFromLlm reads them; throws when the call fails
 * @returns {Promise<ReplyLore>}
 */
export async function loreForReply({ scene, books, ask }) {
    const contents = tableOfContents(books);
    let picked;
    let pickTokens = null;
    const onUsage = usage => {
        if (usage) pickTokens = { prompt: usage.prompt_tokens ?? null, cached: usage.cached_tokens ?? null };
    };
    const pickStartedAt = performance.now();
    try {
        const items = await ask(pickMessages(scene, contents), { maxTokens: PICK_MAX_TOKENS, reasoningEffort: REASONING_EFFORT, identKeys: ['number'], onUsage });
        picked = readPicks(items, contents);
    } catch (error) {
        return {
            contentCount: contents.length, picks: [], unreadItemCount: 0, pickSeconds: secondsSince(pickStartedAt), pickTokens,
            reviewedPicks: [], failures: [{ step: 'pick', detail: callFailureDetail(error), error }],
        };
    }
    const pickSeconds = secondsSince(pickStartedAt);
    const reviews = await Promise.all(picked.picks.map(pick => reviewPick(pick, { scene, books, ask })));
    return {
        contentCount: contents.length,
        picks: picked.picks,
        unreadItemCount: picked.unreadItemCount,
        pickSeconds,
        pickTokens,
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

/** The toast for selected entries a reply leaves out because they have no keys or vectors yet, with where to write them. */
function unreadyEntriesMessage(unreadyBooks) {
    const total = unreadyBooks.reduce((sum, { count }) => sum + count, 0);
    const isOne = total === 1;
    const where = unreadyBooks.length === 1
        ? `of the lorebook "${unreadyBooks[0].bookName}"`
        : `in ${unreadyBooks.length} lorebooks (${unreadyBooks.map(({ bookName }) => `"${bookName}"`).join(', ')})`;
    return `${counted(total, 'selected entry', 'selected entries')} ${where} ${isOne ? 'has' : 'have'} no keys or vectors yet, so `
        + `LoreBase leaves ${isOne ? 'it' : 'them'} out of every reply. Generate all on VectFox's WorldInfo page writes what ${isOne ? 'it lacks' : 'they lack'}.`;
}

/**
 * Whether a reply says it leaves out selected entries that are not ready, with no keys or no vectors from the embedding
 * model set now (D17, §4.4 of lorebook-multi-vector.md): once per chat, and again when the books or their counts change,
 * so a selection whose keys or vectors were never written, or were lost with Qdrant, does not go quiet. A reply that
 * leaves none out is remembered too, so entries that lose them later are said again.
 *
 * @param {{chatId: string|null, signature: string}|null} lastNotice - What the last reply remembered
 * @param {string|null} chatId - The open chat
 * @param {Array<{bookName: string, count: number}>} unreadyBooks - Each book taking part that has selected entries not ready
 * @returns {{notice: {chatId: string|null, signature: string}, message: string|null}} What to remember, and the toast
 *   to show, or null
 */
export function unreadyEntriesNotice(lastNotice, chatId, unreadyBooks) {
    const signature = JSON.stringify(unreadyBooks.map(({ bookName, count }) => [bookName, count]));
    const isNew = !lastNotice || lastNotice.chatId !== chatId || lastNotice.signature !== signature;
    return { notice: { chatId, signature }, message: isNew && unreadyBooks.length ? unreadyEntriesMessage(unreadyBooks) : null };
}
