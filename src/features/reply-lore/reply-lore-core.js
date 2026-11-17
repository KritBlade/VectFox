/**
 * The lore of a reply, the pure rules: the lorebook entries SillyTavern's World Info scan put in the latest
 * reply's prompt, by book, each marked by what chose it. LoreBase's picks go in inside its blocks, each block carried
 * by one activated entry and able to hold picks of several books, so a block is listed as its picks; every other
 * activated entry is SillyTavern's own, by its keys, a constant entry or its other rules. Pure: no SillyTavern.
 */

/** What chose an entry: LoreBase's pick, or SillyTavern's own World Info. */
export const LOREBASE_SOURCE = 'lorebase';
export const SILLYTAVERN_SOURCE = 'sillytavern';

/**
 * @typedef {{uid: number|string, title: string, source: string, isWhole: boolean}} ReplyLoreEntry
 * @typedef {{bookName: string, entries: ReplyLoreEntry[]}} ReplyLoreBook
 */

/**
 * The reply's entries by book, the books and their entries in the order SillyTavern activated them.
 * @param {object[]|null} activatedEntries - WORLD_INFO_ACTIVATED's entries
 * @param {(entry: object) => Array<{bookName: string, uid: number|string, title: string, isWhole: boolean}>|null} picksCarriedBy
 *   - LoreBase's picks in the block an activated entry carries, or null for one of SillyTavern's own
 * @param {(entry: object) => string} titleOf - An entry's title
 * @returns {ReplyLoreBook[]}
 */
export function replyLoreBooks(activatedEntries, picksCarriedBy, titleOf) {
    const books = new Map();
    const add = (bookName, entry) => {
        if (!books.has(bookName)) books.set(bookName, []);
        books.get(bookName).push(entry);
    };
    for (const entry of activatedEntries ?? []) {
        if (!entry) continue;
        const picks = picksCarriedBy(entry);
        if (picks) {
            for (const pick of picks) add(pick.bookName, { uid: pick.uid, title: pick.title, source: LOREBASE_SOURCE, isWhole: pick.isWhole });
        } else {
            add(String(entry.world ?? ''), { uid: entry.uid, title: titleOf(entry), source: SILLYTAVERN_SOURCE, isWhole: true });
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
