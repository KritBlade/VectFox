/**
 * The reply lore list, as the wand menu's Last reply's lore shows it in a dialog: the lines over it, saying how many
 * entries each source chose, and the list, by book, each entry with a pill in its source's colour, LoreBase blue (the
 * accent), SillyTavern green, and a line saying what brought it in when that is known: Jev's chance of yes for a pick
 * of Fast and Cheap [Jev], or the parts High Accuracy kept; for one of SillyTavern's, the keyword that fired it, with
 * its secondary keys and their logic, or the rule that did, and a loop pill when an entry of an earlier loop fired it.
 */
import { groupTitle, listRow, stack, statusPill } from '../../shared/gui-dna/gui-dna-core.js';
import { ACTIVATION_REASONS } from '../../sillytavern/world-info-activations-core.js';
import { LOREBASE_SOURCE, replyLoreCounts } from './reply-lore-core.js';

const counted = (count, one, many) => `${Number(count).toLocaleString('en-US')} ${count === 1 ? one : many}`;

// The rules other than its keys that bring one of SillyTavern's entries in, as its line says them.
const REASON_LINES = new Map([
    [ACTIVATION_REASONS.CONSTANT, { text: 'Constant' }],
    [ACTIVATION_REASONS.STICKY, { text: 'Sticky: still in after an earlier activation' }],
    [ACTIVATION_REASONS.DECORATOR, { text: 'Brought in by its @@activate line' }],
    [ACTIVATION_REASONS.EXTERNAL, { text: 'Brought in by an extension' }],
]);

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

/**
 * What fired one of SillyTavern's entries, as its row's line: the keyword, or the keywords with their logic, or the
 * rule that did; null when the scan's lines said nothing of it.
 * @param {import('./reply-lore-core.js').EntryActivation|null} activation
 * @returns {object|null}
 */
function activationLine(activation) {
    if (!activation) return null;
    if (REASON_LINES.has(activation.reason)) return REASON_LINES.get(activation.reason);
    if (typeof activation.primaryKey !== 'string') return null;
    const primaryKey = activation.primaryKey.trim();
    if (!activation.logic) return { text: 'Keyword', name: primaryKey };
    return { text: 'Keywords', name: [primaryKey, activation.logic, activation.secondaryKeys.join(', ')].filter(Boolean).join(' ') };
}

function loreBaseLine(entry) {
    if (Number.isFinite(entry.jevChance)) return { text: "Jev's chance", name: `${Math.round(entry.jevChance * 100)}%` };
    return entry.isWhole ? null : { text: 'Only the parts the reply needed' };
}

function entryRow(entry) {
    const isLoreBase = entry.source === LOREBASE_SOURCE;
    const loop = entry.activation?.loop;
    return listRow({
        icon: isLoreBase ? 'fa-wand-magic-sparkles' : 'fa-key',
        name: entry.title,
        sub: isLoreBase ? loreBaseLine(entry) : activationLine(entry.activation),
        pills: [
            statusPill({ text: isLoreBase ? 'LoreBase' : 'SillyTavern', status: isLoreBase ? 'accent' : 'success' }),
            ...(!isLoreBase && loop > 1 ? [statusPill({ name: `Loop ${loop}` })] : []),
        ],
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
