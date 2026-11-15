/**
 * LoreBase's delivery through SillyTavern's World Info scan, the pure rules (plan §5.7 and D14 of InternalProject/
 * Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): what each picked entry sends, and how a scan is armed with
 * it. In the scan's copy of the books, every entry LoreBase decides loses its keys, so SillyTavern's keyword step skips
 * it, and each pick is force-activated as SillyTavern loaded it, its own fields kept, with the text its review kept as
 * its content. The book file is never changed. Pure: no SillyTavern, no network.
 */
import { isDecidedEntry } from './lorebase-reply-core.js';

/** The lists of the books a scan loads, as SillyTavern's WORLDINFO_ENTRIES_LOADED carries them. */
const SCAN_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
const DECORATOR_OPENER = '@@';

/**
 * How SillyTavern's scan names an entry, in its forced activations and in what it activated.
 * @param {string} bookName
 * @param {number|string} uid
 * @returns {string}
 */
export function scanKey(bookName, uid) {
    return `${bookName}.${uid}`;
}

/**
 * An entry's content without the decorator lines that open it, as SillyTavern sends a scanned entry: it reads every
 * line starting with '@@' at the content's head as a decorator and leaves it out (parseDecorators in world-info.js),
 * and keeps the content whole when no other line follows them. A forced entry skips that step, so its content is
 * given as SillyTavern would send it.
 * @param {string} content
 * @returns {string}
 */
export function withoutDecoratorLines(content) {
    const text = String(content ?? '');
    if (!text.startsWith(DECORATOR_OPENER)) return text;
    const lines = text.split('\n');
    const firstContentLine = lines.findIndex(line => !line.startsWith(DECORATOR_OPENER));
    return firstContentLine === -1 ? text : lines.slice(firstContentLine).join('\n');
}

/**
 * What each picked entry sends, keyed by scanKey (§5.6): the whole entry, as the scan loads it, when its review kept
 * every part, as it always does for an entry with template code (D9); otherwise the parts it kept, in the entry's
 * order, one to a line, inside the entry's wrapper tags when it has them. A pick whose review kept no part sends
 * nothing, so it has no delivery.
 * @param {Array<{bookName: string, uid: number, frame: {open: string, close: string}|null,
 *   passages: Array<{text: string}>, sentParts: number[]}>} reviewedPicks - From loreForReply
 * @returns {Map<string, {isWhole: boolean, text: string}>}
 */
export function scanDeliveries(reviewedPicks) {
    const deliveries = new Map();
    for (const { bookName, uid, frame, passages, sentParts } of reviewedPicks) {
        if (!sentParts.length) continue;
        if (sentParts.length === passages.length) {
            deliveries.set(scanKey(bookName, uid), { isWhole: true, text: '' });
            continue;
        }
        const kept = sentParts.map(number => passages[number - 1].text);
        deliveries.set(scanKey(bookName, uid), { isWhole: false, text: (frame ? [frame.open, ...kept, frame.close] : kept).join('\n') });
    }
    return deliveries;
}

/**
 * Arm one scan: blank the keys of every entry LoreBase decides in it, and return the forced activations of the picks
 * it holds. Keys are blanked by giving the entry a new empty list, as the scan's entries share their key lists with
 * SillyTavern's cached book. A forced entry is the entry as the scan loaded it, its own keys, position, order, group
 * and probability kept, with the text its review kept as its content, so it competes in its inclusion group like
 * any member (§5.7). A delivery whose entry the scan does not hold, or no longer decides, is not sent.
 * @param {{[list: string]: object[]}} loaded - WORLDINFO_ENTRIES_LOADED's data; its entries are changed in place
 * @param {object} lore
 * @param {(bookName: string) => Set<string>|null} lore.selectedUidsOf - A book's selected uids where it takes part in
 *   this scan (D11), or null where LoreBase decides none of its entries
 * @param {Map<string, {isWhole: boolean, text: string}>|null} lore.deliveries - From scanDeliveries, for this scan's
 *   reply, or null for a scan that is not one
 * @returns {object[]} The forced activations, for WORLDINFO_FORCE_ACTIVATE
 */
export function armScan(loaded, { selectedUidsOf, deliveries }) {
    const forced = [];
    for (const list of SCAN_LISTS) {
        for (const entry of loaded[list] ?? []) {
            const selectedUids = selectedUidsOf(entry.world);
            if (!selectedUids || !isDecidedEntry(entry, selectedUids)) continue;
            const delivery = deliveries?.get(scanKey(entry.world, entry.uid));
            if (delivery) forced.push({ ...entry, content: withoutDecoratorLines(delivery.isWhole ? entry.content : delivery.text) });
            entry.key = [];
        }
    }
    return forced;
}
