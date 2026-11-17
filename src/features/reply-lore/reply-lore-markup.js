/**
 * The reply lore list, as the wand menu's Selected lorebook shows it in a dialog: the lines over it, saying how many
 * entries each source chose, and the list, by book, each entry with a pill in its source's colour: LoreBase blue (the
 * accent), SillyTavern green.
 */
import { groupTitle, listRow, stack, statusPill } from '../../shared/gui-dna/gui-dna-core.js';
import { LOREBASE_SOURCE, replyLoreCounts } from './reply-lore-core.js';

const counted = (count, one, many) => `${Number(count).toLocaleString('en-US')} ${count === 1 ? one : many}`;

/**
 * The dialog's lines: why there is no list yet, or what the list holds.
 * @param {import('./reply-lore-core.js').ReplyLoreBook[]|null} books - The latest reply's, or null before one
 * @returns {object[]}
 */
export function replyLoreLines(books) {
    if (!books) {
        return [{ icon: 'fa-book-open', text: 'No reply in this chat since the page loaded. Send or swipe, and this lists the lorebook entries its prompt held.' }];
    }
    if (!books.length) return [{ icon: 'fa-book-open', text: "The latest reply's prompt held no lorebook entry." }];
    const { loreBase, sillyTavern } = replyLoreCounts(books);
    return [
        { icon: 'fa-book-open', text: "The lorebook entries in the latest reply's prompt:" },
        { text: `${counted(loreBase, 'entry', 'entries')} picked by LoreBase, in blue, and ${counted(sillyTavern, 'entry', 'entries')} by SillyTavern's own World Info, in green.` },
    ];
}

function entryRow(entry) {
    const isLoreBase = entry.source === LOREBASE_SOURCE;
    return listRow({
        icon: isLoreBase ? 'fa-wand-magic-sparkles' : 'fa-key',
        name: entry.title,
        sub: isLoreBase && !entry.isWhole ? { text: 'Only the parts the reply needed' } : null,
        pills: [statusPill({ text: isLoreBase ? 'LoreBase' : 'SillyTavern', status: isLoreBase ? 'accent' : 'success' })],
    });
}

/**
 * The list, by book.
 * @param {import('./reply-lore-core.js').ReplyLoreBook[]} books
 * @returns {string}
 */
export function replyLoreMarkup(books) {
    return stack(books.map(book => [groupTitle({ icon: 'fa-book', name: book.bookName }), ...book.entries.map(entryRow)].join('')));
}
