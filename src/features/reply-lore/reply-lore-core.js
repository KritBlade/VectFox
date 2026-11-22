/**
 * The lore of a reply, the pure rules: the lorebook entries SillyTavern's World Info scan put in the latest
 * reply's prompt, by book, each marked by what chose it. LoreBase's picks go in inside its blocks, each block carried
 * by one activated entry and able to hold picks of several books, so a block is listed as its picks, each with Jev's
 * chance of yes on Fast and Cheap [Jev]; every other activated entry is SillyTavern's own, with what fired it as the
 * scan said: its keyword, a constant entry or another of its rules, and the loop it went in. Pure: no SillyTavern.
 */

/** What chose an entry: LoreBase's pick, or SillyTavern's own World Info. */
export const LOREBASE_SOURCE = 'lorebase';
export const SILLYTAVERN_SOURCE = 'sillytavern';

/**
 * @typedef {import('../../sillytavern/world-info-activations-core.js').EntryActivation} EntryActivation
 * @typedef {{uid: number|string, title: string, source: string, isWhole: boolean, jevChance: number|null,
 *   activation: EntryActivation|null}} ReplyLoreEntry - jevChance on LoreBase's picks of Fast and Cheap [Jev] only;
 *   activation on SillyTavern's own entries only, null when the scan's lines were not read
 * @typedef {{bookName: string, entries: ReplyLoreEntry[]}} ReplyLoreBook
 */

/**
 * The reply's entries by book, the books and their entries in the order SillyTavern activated them.
 * @param {object[]|null} activatedEntries - WORLD_INFO_ACTIVATED's entries
 * @param {(entry: object) => Array<{bookName: string, uid: number|string, title: string, isWhole: boolean,
 *   jevChance?: number|null}>|null} picksCarriedBy - LoreBase's picks in the block an activated entry carries, or null
 *   for one of SillyTavern's own
 * @param {(entry: object) => string} titleOf - An entry's title
 * @param {(entry: object) => EntryActivation|null} [activationOf] - What fired one of SillyTavern's own entries
 * @returns {ReplyLoreBook[]}
 */
export function replyLoreBooks(activatedEntries, picksCarriedBy, titleOf, activationOf = () => null) {
    const books = new Map();
    const add = (bookName, entry) => {
        if (!books.has(bookName)) books.set(bookName, []);
        books.get(bookName).push(entry);
    };
    for (const entry of activatedEntries ?? []) {
        if (!entry) continue;
        const picks = picksCarriedBy(entry);
        if (picks) {
            for (const pick of picks) {
                add(pick.bookName, {
                    uid: pick.uid, title: pick.title, source: LOREBASE_SOURCE, isWhole: pick.isWhole, jevChance: pick.jevChance ?? null, activation: null,
                });
            }
        } else {
            add(String(entry.world ?? ''), {
                uid: entry.uid, title: titleOf(entry), source: SILLYTAVERN_SOURCE, isWhole: true, jevChance: null, activation: activationOf(entry) ?? null,
            });
        }
    }
    return [...books].map(([bookName, entries]) => ({ bookName, entries }));
}

/**
 * How many of the reply's entries each source chose.
 * @param {ReplyLoreBook[]} books
 * @returns {{loreBase: number, sillyTavern: number}}
 */
export function replyLoreCounts(books) {
    const entries = books.flatMap(book => book.entries);
    const loreBase = entries.filter(entry => entry.source === LOREBASE_SOURCE).length;
    return { loreBase, sillyTavern: entries.length - loreBase };
}
