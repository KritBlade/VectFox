/**
 * The rules of LoreBase's storage module (lorebase-storage.js, §3.1 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md), with no host imports: the two kinds LoreBase stores for each selected entry,
 * what of the selection's lack a run of some kinds writes, the progress panel's title and closing line for it, where a
 * book's selected entries stand, and the Database Browser's rows of each book's keys and vectors, the
 * list's and the leftovers' (§3.2). Its files are lorebase-files-core.js's.
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
 * What the selected entries lack, for the books card's line once the selection screen closes or LoreBase's switch is
 * turned on: every entry missing either kind, each once, those missing each kind, how many LoreBase decides, and
 * whether a writing run was started for them, which writes its own lines.
 * @param {{books: Array<{keyEntries?: object[], vectorEntries?: object[]}>, count: number, decidedCount: number}} pending
 *   From selectedEntriesNotReady
 * @param {boolean} isWriting - Whether a writing run was started for them
 * @returns {{missingCount: number, missingKeyCount: number, missingVectorCount: number, decidedCount: number, isWriting: boolean}}
 */
export function missingSummaryOf(pending, isWriting) {
    return { missingCount: pending.count, ...missingCountsOf(pending), decidedCount: pending.decidedCount, isWriting };
}

/**
 * The kinds some entry lacks, in the order a run writes them: what writing them needs (writingProblem), and the Generate
 * button that writes them.
 * @param {{missingKeyCount: number, missingVectorCount: number}} counts - From missingCountsOf
 * @returns {string[]} KEYS, VECTORS, both, or none
 */
export function kindsLacking({ missingKeyCount, missingVectorCount }) {
    return [missingKeyCount ? KEYS : null, missingVectorCount ? VECTORS : null].filter(Boolean);
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
 * Where a book's selected entries LoreBase decides stand, for its row on the books card (§7.1 of
 * lorebook-multi-vector.md): how many it decides, so a selected entry it skips, as a disabled one, needs nothing; how
 * many have keys stored, an empty list the model found counted; how many have vectors from the embedding model set now;
 * how many are ready (isEntryReady in lorebase-readiness.js); how many lack keys and how many lack vectors, an entry
 * lacking both counted in each; how many hold only another embedding model's vectors; and how many of those not ready
 * failed in this session, with the first one's reason.
 * @param {Array<{hasKeys: boolean, hasVectors: boolean, isReady: boolean, vectorStatus: string, failure: string|null}>} entries
 *   Each selected entry LoreBase decides: whether its keys and its current vectors are stored, whether it is ready, its
 *   vectors' status (vectorStateOf in lorebase-vectors.js), and what the last failed writing of its keys or vectors
 *   reported, or null
 * @returns {{decidedCount: number, keyCount: number, vectorCount: number, readyCount: number, missingKeyCount: number,
 *   missingVectorCount: number, otherModelCount: number, failedCount: number, firstFailure: string|null}}
 */
export function storedCountsOf(entries) {
    const counts = {
        decidedCount: entries.length, keyCount: 0, vectorCount: 0, readyCount: 0, missingKeyCount: 0, missingVectorCount: 0,
        otherModelCount: 0, failedCount: 0, firstFailure: null,
    };
    for (const { hasKeys, hasVectors, isReady, vectorStatus, failure } of entries) {
        if (hasKeys) counts.keyCount += 1;
        else counts.missingKeyCount += 1;
        if (hasVectors) counts.vectorCount += 1;
        else counts.missingVectorCount += 1;
        if (vectorStatus === 'other-model') counts.otherModelCount += 1;
        if (isReady) {
            counts.readyCount += 1;
        } else if (failure) {
            counts.failedCount += 1;
            counts.firstFailure ??= failure;
        }
    }
    return counts;
}

/**
 * What every row of a book knows of it: its name, whether it has a LoreBase record, how many entries its selections
 * hold together and how many selections it has, whether SillyTavern has it, and whether the row is a leftover, one
 * LoreBase cannot use here.
 * @typedef {{book: string|null, hasRecord: boolean, selectedCount: number, selectionCount: number, isInSillyTavern: boolean,
 *   isLeftover: boolean}} BookFacts
 */

/**
 * A row of the Database Browser's LoreBase rows: a book's keys, or one tenant of its vectors.
 * @typedef {BookFacts & {key: string, kind: 'keys', entryCount: number}} KeysRow
 * @typedef {BookFacts & {key: string, kind: 'vectors', collection: string, tenant: string|null, isHere: boolean,
 *   pointCount: number, embeddingSource: string, embeddingModel: string}} VectorsRow
 */

const keysRowOf = (facts, entryCount) => ({ key: `${KEYS}|${facts.book}`, kind: KEYS, ...facts, entryCount });

/**
 * A row to import a file onto in a book that has none, as the list draws it at 0: its Keys row, or its Vectors row in
 * the collection LoreBase reads now (§3.3 of vectfox-multi-collection-per-chat.md).
 * @param {string} kind - KEYS or VECTORS
 * @param {{book: string, hasRecord: boolean, selectedCount: number, selectionCount: number}} book - A book SillyTavern has
 * @param {string} hereCollection - The Qdrant collection LoreBase reads this account's vectors in now
 * @returns {KeysRow|VectorsRow}
 */
export function emptyRowOf(kind, book, hereCollection) {
    const facts = { ...book, isInSillyTavern: true, isLeftover: false };
    if (kind === KEYS) return keysRowOf(facts, 0);
    return {
        key: `${VECTORS}|${hereCollection}|${facts.book}`, kind: VECTORS, ...facts, collection: hereCollection, tenant: null,
        isHere: true, pointCount: 0, embeddingSource: '', embeddingModel: '',
    };
}

/**
 * What Similharity's listing holds of one book: how many of its entries have keys, and each tenant of its vectors, in
 * either collection. The one reading of a book's part of the listing: the Database Browser's rows (storageRowsOf), what
 * Remove from LoreBase deletes (loreBookHoldings) and which books have it (removableLoreBookNames).
 * @param {{keys: Array<{book: string, entryCount: number}>, vectors: Array<{book: string|null, collection: string}>}} listing
 * @param {string} book
 * @returns {{keyCount: number, tenants: object[]}}
 */
export function listedHoldingsOf(listing, book) {
    return {
        keyCount: listing.keys.find(row => row.book === book)?.entryCount ?? 0,
        tenants: listing.vectors.filter(row => row.book === book),
    };
}

/**
 * Whether LoreBase holds anything of a book SillyTavern has: a record, keys, or vectors in the collection it reads now.
 * The one rule of whether a book has Remove from LoreBase: the Database Browser lists such a book (storageRowsOf), and
 * the WorldInfo page gives its row the trash (removableLoreBookNames in lorebase-storage.js).
 * @param {{hasRecord: boolean, keyCount: number, hereTenantCount: number}} holdings - From the record and the listing
 * @returns {boolean}
 */
export function hasLoreBaseHoldings({ hasRecord, keyCount, hereTenantCount }) {
    return hasRecord || keyCount > 0 || hereTenantCount > 0;
}

/**
 * The Database Browser's LoreBase rows (§3.2 of vectfox-multi-collection-per-chat.md): first the list, then the
 * leftovers, each by book name. The list holds every book SillyTavern has that LoreBase holds anything of
 * (hasLoreBaseHoldings): its Keys row, then the Vectors row of the collection read now, either at 0 when nothing is
 * there. The leftovers hold what LoreBase cannot use here, each row holding something: a book's vectors in the other
 * collection, every row of a book SillyTavern no longer has, and each tenant whose points name no book, last.
 * @param {{listing: {keys: Array<{book: string, entryCount: number}>, vectors: Array<{collection: string, tenant: string,
 *   book: string|null, pointCount: number, embeddingSource: string, embeddingModel: string}>},
 *   recordCounts: Record<string, {selectedCount: number, selectionCount: number}>, hereCollection: string,
 *   sillyTavernBookNames: string[]}} parts - listing: Similharity's /lorebase/books; recordCounts: each book with a
 *   LoreBase record, by name, with how many entries its selections hold together and how many selections it has
 *   (loreBookRecordCounts); hereCollection: the Qdrant collection LoreBase reads this account's vectors in now
 * @returns {Array<KeysRow|VectorsRow>}
 */
export function storageRowsOf({ listing, recordCounts, hereCollection, sillyTavernBookNames }) {
    const inSillyTavern = new Set(sillyTavernBookNames);
    const bookNames = new Set([
        ...Object.keys(recordCounts),
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
    const listed = [];
    const leftovers = [];
    for (const book of [...bookNames].sort((first, second) => first.localeCompare(second))) {
        const hasRecord = Object.hasOwn(recordCounts, book);
        const facts = {
            book, hasRecord, selectedCount: recordCounts[book]?.selectedCount ?? 0, selectionCount: recordCounts[book]?.selectionCount ?? 0,
            isInSillyTavern: inSillyTavern.has(book),
        };
        const leftoverFacts = { ...facts, isLeftover: true };
        const { keyCount: entryCount, tenants } = listedHoldingsOf(listing, book);
        const here = tenants.filter(row => row.collection === hereCollection);
        const elsewhere = tenants.filter(row => row.collection !== hereCollection);
        if (!facts.isInSillyTavern) {
            if (entryCount) leftovers.push(keysRowOf(leftoverFacts, entryCount));
            for (const tenant of [...here, ...elsewhere]) leftovers.push(tenantRow(tenant, leftoverFacts));
            continue;
        }
        if (hasLoreBaseHoldings({ hasRecord, keyCount: entryCount, hereTenantCount: here.length })) {
            const listedFacts = { ...facts, isLeftover: false };
            listed.push(keysRowOf(listedFacts, entryCount));
            if (here.length) for (const tenant of here) listed.push(tenantRow(tenant, listedFacts));
            else listed.push(emptyRowOf(VECTORS, facts, hereCollection));
        }
        for (const tenant of elsewhere) leftovers.push(tenantRow(tenant, leftoverFacts));
    }
    for (const tenant of listing.vectors.filter(row => row.book === null)) {
        leftovers.push(tenantRow(tenant, { book: null, hasRecord: false, selectedCount: 0, selectionCount: 0, isInSillyTavern: false, isLeftover: true }));
    }
    return [...listed, ...leftovers];
}
