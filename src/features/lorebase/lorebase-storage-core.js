/**
 * The rules of LoreBase's storage module (lorebase-storage.js, §3.1 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md), with no host imports: the two kinds LoreBase stores for each selected entry,
 * what of the selection's lack a run of some kinds writes, the progress panel's title and closing line for it, how many
 * of a book's selected entries have each kind, and the Database Browser's rows of each book's keys and vectors (§3.2).
 * Its files are lorebase-files-core.js's.
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

/**
 * A row of the Database Browser's LoreBase rows: a book's keys, or one tenant of its vectors.
 * @typedef {{key: string, kind: 'keys', book: string, hasRecord: boolean, isInSillyTavern: boolean, entryCount: number}} KeysRow
 * @typedef {{key: string, kind: 'vectors', book: string|null, hasRecord: boolean, isInSillyTavern: boolean, collection: string,
 *   tenant: string|null, isHere: boolean, pointCount: number, embeddingSource: string, embeddingModel: string}} VectorsRow
 */

/**
 * The Database Browser's LoreBase rows (§3.2 of vectfox-multi-collection-per-chat.md), books by name. Every book that
 * has a LoreBase record, keys or vectors gets its Keys row, then its Vectors row in the collection LoreBase reads now,
 * at 0 when none are there, then a Vectors row for each of its tenants left in another collection; a tenant whose points
 * name no book gets a Vectors row of its own. Each row knows whether its book has a LoreBase record and whether
 * SillyTavern has the book.
 * @param {{listing: {keys: Array<{book: string, entryCount: number}>, vectors: Array<{collection: string, tenant: string,
 *   book: string|null, pointCount: number, embeddingSource: string, embeddingModel: string}>}, recordedBookNames: string[],
 *   hereCollection: string, sillyTavernBookNames: string[]}} parts - listing: Similharity's /lorebase/books; hereCollection:
 *   the Qdrant collection LoreBase reads this account's vectors in now
 * @returns {Array<KeysRow|VectorsRow>}
 */
export function storageRowsOf({ listing, recordedBookNames, hereCollection, sillyTavernBookNames }) {
    const recorded = new Set(recordedBookNames);
    const inSillyTavern = new Set(sillyTavernBookNames);
    const bookNames = new Set([
        ...recordedBookNames,
        ...listing.keys.map(row => row.book),
        ...listing.vectors.map(row => row.book).filter(book => book !== null),
    ]);
    const tenantRow = (tenant, facts) => ({
        key: `${VECTORS}|${tenant.collection}|${tenant.tenant}`,
        kind: VECTORS,
        ...facts,
        collection: tenant.collection,
        tenant: tenant.tenant,
        isHere: tenant.collection === hereCollection,
        pointCount: tenant.pointCount,
        embeddingSource: tenant.embeddingSource,
        embeddingModel: tenant.embeddingModel,
    });
    const rows = [];
    for (const book of [...bookNames].sort((first, second) => first.localeCompare(second))) {
        const facts = { book, hasRecord: recorded.has(book), isInSillyTavern: inSillyTavern.has(book) };
        rows.push({ key: `${KEYS}|${book}`, kind: KEYS, ...facts, entryCount: listing.keys.find(row => row.book === book)?.entryCount ?? 0 });
        const tenants = listing.vectors.filter(row => row.book === book);
        const here = tenants.filter(row => row.collection === hereCollection);
        if (!here.length) {
            rows.push({
                key: `${VECTORS}|${hereCollection}|${book}`, kind: VECTORS, ...facts, collection: hereCollection, tenant: null,
                isHere: true, pointCount: 0, embeddingSource: '', embeddingModel: '',
            });
        }
        for (const tenant of [...here, ...tenants.filter(row => row.collection !== hereCollection)]) rows.push(tenantRow(tenant, facts));
    }
    for (const tenant of listing.vectors.filter(row => row.book === null)) {
        rows.push(tenantRow(tenant, { book: null, hasRecord: false, isInSillyTavern: false }));
    }
    return rows;
}
