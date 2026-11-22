/**
 * LoreBase's tester, the pure rules (plan §5.10 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): one reply's report, built from its lore as the pick and the reviews
 * left it: each pick with Luna's reasons, what its review kept and left out, part by part, and the text it sends; the
 * selected entries the pick skipped; on Fast and Cheap [Jev] the search before Jev, or that none ran; on High Accuracy
 * the pick's prompt tokens and those read from the provider's cache; and the seconds, the search's among them. Its
 * token counts come from a counter the caller supplies, and
 * what SillyTavern's keys would send from the entries a scan as SillyTavern alone activated. Pure: no SillyTavern, no
 * network.
 */
import { withoutDecoratorLines } from './lorebase-decorators-core.js';
import { scanDeliveries, scanKey } from './lorebase-delivery-core.js';
import { entryTitle } from './lorebase-splitter.js';

/**
 * @typedef {object} ReportPick
 * @property {string} bookName
 * @property {number} uid
 * @property {string} title
 * @property {string} basis - Why Luna picked it: "named in the chat", "in the scene, not named", ...
 * @property {boolean|null} certain - Whether Luna said the reply will certainly draw on it
 * @property {string} why - Luna's one sentence on why the reply needs it
 * @property {string} needs - What Luna wanted from it
 * @property {number|null} yes - On Fast and Cheap [Jev], Jev's chance of yes for it (D16); null for Luna's picks
 * @property {string} wholeText - The entry as SillyTavern sends it whole
 * @property {{uses: string, seconds: number, parts: Array<{text: string, isSent: boolean}>, sentText: string}|null}
 *   review - What its review kept, and the text the pick sends: '' when it keeps no part; null when the review failed
 * @property {string|null} failure - What the failed review reported, or null
 * @property {boolean|null} isInPrompt - For a pick that sends text, whether the reply's World Info scan kept it, as
 *   SillyTavern's World Info budget is the last cut; null until that scan is seen
 */

/**
 * @typedef {object} ReplyReportBody
 * @property {number} contentCount - Selected entries the pick read
 * @property {ReportPick[]} picks - Most needed first
 * @property {Array<{bookName: string, uid: number, title: string}>} skipped - Selected entries the pick left out
 * @property {number} unreadItemCount - Items of the pick's answer that named no entry
 * @property {Array<{step: string, title: string|null, detail: string}>} failures
 * @property {{seats: number, poolCount: number|null}|null} search - On Fast and Cheap [Jev], the search before Jev:
 *   the most entries Jev is asked about, and how many the search kept, null when nothing was searched; null on High
 *   Accuracy
 * @property {{prompt: number|null, cached: number|null}|null} pickTokens - On High Accuracy, the pick's prompt tokens
 *   and those the provider read from its cache, each null where it did not report them; null on Fast and Cheap [Jev],
 *   or when the pick's call reported no counts
 * @property {{search: number|null, pick: number|null, slowestReview: number|null, total: number}} seconds - The
 *   reviews run at once, so the slowest one is the reviews' wait
 */

const largest = values => (values.length ? Math.max(...values) : null);

/**
 * One reply's report from its lore.
 * @param {object} turn
 * @param {import('./lorebase-reply-core.js').ReplyLore} turn.lore - From loreForReply
 * @param {Array<{bookName: string, entries: object[]}>} turn.books - The books taking part, as the pick read them
 * @param {number} turn.seconds - LoreBase's whole time on the reply
 * @returns {ReplyReportBody}
 */
export function replyReport({ lore, books, seconds }) {
    const entryOf = (bookName, uid) => books.find(book => book.bookName === bookName)?.entries.find(entry => entry.uid === uid);
    const reviewOf = new Map(lore.reviewedPicks.map(reviewed => [scanKey(reviewed.bookName, reviewed.uid), reviewed]));
    const failureOf = new Map(lore.failures.filter(failure => failure.step === 'review').map(failure => [scanKey(failure.bookName, failure.uid), failure]));
    const deliveries = scanDeliveries(lore.reviewedPicks);
    const picks = lore.picks.map(pick => {
        const key = scanKey(pick.bookName, pick.uid);
        const wholeText = withoutDecoratorLines(entryOf(pick.bookName, pick.uid)?.content);
        const reviewed = reviewOf.get(key);
        const delivery = deliveries.get(key);
        const review = reviewed ? {
            uses: reviewed.uses,
            seconds: reviewed.seconds,
            parts: reviewed.passages.map((passage, index) => ({ text: passage.text, isSent: reviewed.sentParts.includes(index + 1) })),
            sentText: delivery ? (delivery.isWhole ? wholeText : withoutDecoratorLines(delivery.text)) : '',
        } : null;
        const { bookName, uid, title, basis, certain, why, needs } = pick;
        return {
            bookName, uid, title, basis, certain, why, needs, yes: Number.isFinite(pick.yes) ? pick.yes : null, wholeText, review,
            failure: failureOf.get(key)?.detail ?? null, isInPrompt: null,
        };
    });
    const picked = new Set(picks.map(pick => scanKey(pick.bookName, pick.uid)));
    const skipped = books.flatMap(({ bookName, entries }) => entries
        .filter(entry => !picked.has(scanKey(bookName, entry.uid)))
        .map(entry => ({ bookName, uid: entry.uid, title: entryTitle(entry) })));
    const reviewSeconds = [...lore.reviewedPicks, ...failureOf.values()].map(review => review.seconds).filter(Number.isFinite);
    const finiteOrNull = value => (Number.isFinite(value) ? value : null);
    return {
        contentCount: lore.contentCount,
        picks,
        skipped,
        unreadItemCount: lore.unreadItemCount,
        failures: lore.failures.map(({ step, title, detail }) => ({ step, title: title ?? null, detail })),
        search: lore.search ? { seats: lore.search.seats, poolCount: finiteOrNull(lore.search.poolCount) } : null,
        pickTokens: lore.pickTokens ? { prompt: finiteOrNull(lore.pickTokens.prompt), cached: finiteOrNull(lore.pickTokens.cached) } : null,
        seconds: {
            search: finiteOrNull(lore.search?.seconds), pick: finiteOrNull(lore.pickSeconds), slowestReview: largest(reviewSeconds), total: seconds,
        },
    };
}

/**
 * What the reply's picks send and the same entries whole, in tokens, each pick's and in all.
 * @param {ReplyReportBody} report
 * @param {(text: string) => Promise<number>} countTokens
 * @returns {Promise<{sent: number, pickedWhole: number, picks: Array<{sent: number, whole: number}|null>}>} A pick
 *   whose review failed sends nothing and counts nothing
 */
export async function pickTokens(report, countTokens) {
    const picks = await Promise.all(report.picks.map(async pick => (pick.review ? {
        sent: pick.review.sentText ? await countTokens(pick.review.sentText) : 0,
        whole: await countTokens(pick.wholeText),
    } : null)));
    const counted = picks.filter(Boolean);
    return {
        sent: counted.reduce((total, pick) => total + pick.sent, 0),
        pickedWhole: counted.reduce((total, pick) => total + pick.whole, 0),
        picks,
    };
}

/**
 * The texts SillyTavern's keys would send of the entries the pick read: those of them a scan as SillyTavern alone
 * activated, each whole, as SillyTavern sends it.
 * @param {ReplyReportBody} report
 * @param {Iterable<{world: string, uid: number, content?: string}>} activatedEntries - What that scan activated
 * @returns {string[]}
 */
export function selectedTextsSentByKeys(report, activatedEntries) {
    const selected = new Set([...report.picks, ...report.skipped].map(entry => scanKey(entry.bookName, entry.uid)));
    return [...activatedEntries].filter(entry => selected.has(scanKey(entry.world, entry.uid))).map(entry => withoutDecoratorLines(entry.content));
}
