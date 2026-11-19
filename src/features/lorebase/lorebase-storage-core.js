/**
 * The rules of LoreBase's storage module (lorebase-storage.js, §3.1 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md), with no host imports: the two kinds LoreBase stores for each selected entry,
 * what of the selection's lack a run of some kinds writes, the progress panel's title and closing line for it, and how
 * many of a book's selected entries have each kind.
 */

/** An entry's keys, which LoreBase's model writes. */
export const KEYS = 'keys';
/** An entry's vectors, one point per part, which VectFox's embedding model writes. */
export const VECTORS = 'vectors';
/** A run of both kinds: Generate all, turning LoreBase on and closing the selection screen. */
export const BOTH_KINDS = Object.freeze([KEYS, VECTORS]);

const uidOf = entry => String(entry.uid);

/**
 * What a run of `kinds` writes of what the selected entries lack: each book's entries without keys when it writes keys,
 * those without vectors when it writes vectors, and `count`, each entry once. A book left with nothing goes.
 * @param {{books: Array<{bookName: string, decidedEntries?: object[], keyEntries?: object[], vectorEntries?: object[]}>,
 *   unreadBooks?: number}} pending - From selectedEntriesNotReady
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @returns {{books: Array<{bookName: string, decidedEntries?: object[], keyEntries: object[], vectorEntries: object[]}>,
 *   count: number, unreadBooks: number}}
 */
export function pendingOfKinds({ books, unreadBooks = 0 }, kinds) {
    const isWritingKeys = kinds.includes(KEYS);
    const isWritingVectors = kinds.includes(VECTORS);
    const kept = books
        .map(book => ({
            ...book,
            keyEntries: isWritingKeys ? book.keyEntries ?? [] : [],
            vectorEntries: isWritingVectors ? book.vectorEntries ?? [] : [],
        }))
        .filter(book => book.keyEntries.length || book.vectorEntries.length);
    const count = kept.reduce((sum, book) => sum + new Set([...book.keyEntries, ...book.vectorEntries].map(uidOf)).size, 0);
    return { books: kept, count, unreadBooks };
}

/**
 * How many selected entries lack keys, and how many lack vectors, an entry lacking both counted in each.
 * @param {{books: Array<{keyEntries?: object[], vectorEntries?: object[]}>}} pending - From selectedEntriesNotReady
 * @returns {{missingKeyCount: number, missingVectorCount: number}}
 */
export function missingCountsOf({ books }) {
    return {
        missingKeyCount: books.reduce((sum, book) => sum + (book.keyEntries?.length ?? 0), 0),
        missingVectorCount: books.reduce((sum, book) => sum + (book.vectorEntries?.length ?? 0), 0),
    };
}

/**
 * The progress panel's title for a run of `kinds`.
 * @param {readonly string[]} kinds
 * @returns {string}
 */
export function writingPanelTitle(kinds) {
    if (!kinds.includes(VECTORS)) return 'LoreBase keys';
    if (!kinds.includes(KEYS)) return 'LoreBase vectors';
    return 'LoreBase keys and vectors';
}

const entriesOf = count => `${count} ${count === 1 ? 'entry' : 'entries'}`;

/**
 * The progress panel's closing line for a run: what it wrote of each kind, and the entries that failed or were stopped.
 * @param {{keysWritten: number, vectorsWritten: number, failed: number, stopped: number}} outcome
 * @returns {string}
 */
export function writtenSummary({ keysWritten, vectorsWritten, failed, stopped }) {
    const written = [keysWritten ? `the keys of ${entriesOf(keysWritten)}` : '', vectorsWritten ? `the vectors of ${entriesOf(vectorsWritten)}` : '']
        .filter(Boolean).join(' and ');
    const parts = [written ? `Wrote ${written}` : 'Wrote nothing'];
    if (failed) parts.push(`${failed} failed`);
    if (stopped) parts.push(`${stopped} stopped`);
    return parts.join('; ');
}

/**
 * How many of a book's selected entries have keys, an empty list the model found counted, and how many have vectors
 * from the embedding model set now.
 * @param {object[]} decidedEntries - The book's selected entries LoreBase decides
 * @param {Record<string, string[]>|undefined} keysOfBook - uid -> keys, as Similharity holds them
 * @param {Set<string>} uidsWithVectors - From uidsWithCurrentVectors
 * @returns {{keyCount: number, vectorCount: number}}
 */
export function storedCountsOf(decidedEntries, keysOfBook, uidsWithVectors) {
    return {
        keyCount: decidedEntries.filter(entry => Boolean(keysOfBook?.[uidOf(entry)])).length,
        vectorCount: decidedEntries.filter(entry => uidsWithVectors.has(uidOf(entry))).length,
    };
}
