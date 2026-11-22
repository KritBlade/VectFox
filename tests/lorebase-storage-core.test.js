/**
 * The rules of LoreBase's storage module (src/features/lorebase/lorebase-storage-core.js, §3.1 of InternalProject/
 * Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): a run of keys writes only the entries without keys, a run of
 * vectors only those without vectors, and a run of both each entry once; the selection's lack counted by kind; the
 * progress panel's title and closing line; a book's selected entries counted by what they have; and the Database
 * Browser's rows of each book's keys and vectors, the list's and the leftovers', and the row an import writes to in a
 * book with none (§3.2, §3.3).
 */
import { describe, expect, it } from 'vitest';
import {
    BOTH_KINDS, KEYS, VECTORS, emptyRowOf, missingCountsOf, pendingOfKinds, storageRowsOf, storedCountsOf, writingPanelTitle, writtenSummary,
} from '../src/features/lorebase/lorebase-storage-core.js';

const entry = uid => ({ uid });
const uidsOf = entries => entries.map(each => each.uid);
// Harbor Atlas: 1 lacks keys, 0 and 1 lack vectors. Desert Atlas: 5 lacks keys alone.
const PENDING = {
    books: [
        { bookName: 'Harbor Atlas', decidedEntries: [entry(0), entry(1)], keyEntries: [entry(1)], vectorEntries: [entry(0), entry(1)] },
        { bookName: 'Desert Atlas', decidedEntries: [entry(5)], keyEntries: [entry(5)], vectorEntries: [] },
    ],
    count: 3, readyCount: 0, decidedCount: 3, unreadBooks: 1,
};
const shapeOf = pending => pending.books.map(book => [book.bookName, uidsOf(book.keyEntries), uidsOf(book.vectorEntries)]);

describe('what a run of some kinds writes', () => {
    it('writes every entry lacking either in a run of both, each entry once', () => {
        const pending = pendingOfKinds(PENDING, BOTH_KINDS);
        expect(shapeOf(pending)).toEqual([['Harbor Atlas', [1], [0, 1]], ['Desert Atlas', [5], []]]);
        expect([pending.count, pending.unreadBooks]).toEqual([3, 1]);
    });

    it('writes only the entries without keys in a run of keys', () => {
        const pending = pendingOfKinds(PENDING, [KEYS]);
        expect(shapeOf(pending)).toEqual([['Harbor Atlas', [1], []], ['Desert Atlas', [5], []]]);
        expect(pending.count).toBe(2);
    });

    it('writes only the entries without vectors in a run of vectors, and drops a book with none', () => {
        const pending = pendingOfKinds(PENDING, [VECTORS]);
        expect(shapeOf(pending)).toEqual([['Harbor Atlas', [], [0, 1]]]);
        expect(pending.count).toBe(2);
        expect(pending.books[0].decidedEntries).toEqual([entry(0), entry(1)]);
    });

    it('takes a book given only the entries of one kind', () => {
        expect(pendingOfKinds({ books: [{ bookName: 'Harbor Atlas', keyEntries: [entry(3)] }] }, BOTH_KINDS))
            .toEqual({ books: [{ bookName: 'Harbor Atlas', keyEntries: [entry(3)], vectorEntries: [] }], count: 1, unreadBooks: 0 });
    });
});

describe('what the selection lacks, by kind', () => {
    it('counts the entries without keys and those without vectors, one lacking both in each', () => {
        expect(missingCountsOf(PENDING)).toEqual({ missingKeyCount: 2, missingVectorCount: 2 });
        expect(missingCountsOf({ books: [] })).toEqual({ missingKeyCount: 0, missingVectorCount: 0 });
    });
});

describe('the progress panel', () => {
    it("titles a run by what it writes", () => {
        expect([writingPanelTitle([KEYS]), writingPanelTitle([VECTORS]), writingPanelTitle(BOTH_KINDS)])
            .toEqual(['LoreBase keys', 'LoreBase vectors', 'LoreBase keys and vectors']);
    });

    it('closes with what was written of each kind, and what failed or was stopped', () => {
        expect(writtenSummary({ keysWritten: 2, vectorsWritten: 1, failed: 0, stopped: 0 })).toBe('Wrote the keys of 2 entries and the vectors of 1 entry');
        expect(writtenSummary({ keysWritten: 0, vectorsWritten: 3, failed: 1, stopped: 2 })).toBe('Wrote the vectors of 3 entries; 1 failed; 2 stopped');
        expect(writtenSummary({ keysWritten: 0, vectorsWritten: 0, failed: 4, stopped: 0 })).toBe('Wrote nothing; 4 failed');
    });
});

describe("a book's selected entries, by what they have", () => {
    // An entry's stored keys and vectors, ready with both (isEntryReady), and its vectors' state as its row shows it.
    const standing = (hasKeys, vectorStatus, failure = null, hasVectors = vectorStatus === 'ready') => ({
        hasKeys, hasVectors, isReady: hasKeys && hasVectors, vectorStatus, failure,
    });

    it('counts an entry whose vectors are written anew as ready on the ones it has, as a reply sends it', () => {
        expect(storedCountsOf([standing(true, 'writing', null, true), standing(true, 'writing')]))
            .toMatchObject({ vectorCount: 1, readyCount: 1, missingVectorCount: 1 });
    });

    it('counts the entries it decides, those with keys and with vectors from the model set now, those ready with both, and what the rest lack', () => {
        expect(storedCountsOf([standing(true, 'ready'), standing(true, 'missing'), standing(false, 'ready'), standing(false, 'writing')])).toEqual({
            decidedCount: 4, keyCount: 2, vectorCount: 2, readyCount: 1, missingKeyCount: 2, missingVectorCount: 2, otherModelCount: 0, failedCount: 0,
            firstFailure: null,
        });
        expect(storedCountsOf([])).toMatchObject({ decidedCount: 0, keyCount: 0, vectorCount: 0, readyCount: 0 });
    });

    it("counts the entries holding another embedding model's vectors as lacking vectors", () => {
        expect(storedCountsOf([standing(true, 'other-model'), standing(true, 'other-model'), standing(true, 'ready')]))
            .toMatchObject({ vectorCount: 1, readyCount: 1, missingVectorCount: 2, otherModelCount: 2 });
    });

    it('counts the failed entries not ready, with the first reason, and never a ready one whose earlier writing failed', () => {
        expect(storedCountsOf([
            standing(true, 'ready', 'rate limited'),
            standing(false, 'missing', 'the model answered no list'),
            standing(true, 'failed', 'the embedding server refused'),
        ])).toMatchObject({ readyCount: 1, failedCount: 2, firstFailure: 'the model answered no list' });
    });
});

describe("the Database Browser's rows", () => {
    const tenant = (book, collection, pointCount, id = `vf_lorebase_qdrant_rabbit_${String(book).toLowerCase().replace(/\W+/g, '_')}_${collection}`) => ({
        collection, tenant: id, book, pointCount, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3',
    });
    // Harbor Atlas's 2 selections hold 12 entries; Wren Journal has a record selecting none; Ghost Atlas's book is gone from
    // SillyTavern.
    const rowsOf = listing => storageRowsOf({
        listing,
        recordCounts: {
            'Harbor Atlas': { selectedCount: 12, selectionCount: 2 }, 'Wren Journal': { selectedCount: 0, selectionCount: 1 },
            'Ghost Atlas': { selectedCount: 3, selectionCount: 1 },
        },
        hereCollection: 'vf_lorebase_rabbit',
        sillyTavernBookNames: ['Harbor Atlas', 'Desert Atlas', 'Wren Journal'],
    });
    const shapeOf = rows => rows.map(row => [row.kind, row.book, row.kind === KEYS ? row.entryCount : `${row.collection}:${row.pointCount}`, row.isLeftover]);

    it('lists each book SillyTavern has with a record, keys or vectors here, its keys then its vectors here, either at 0, then the leftovers', () => {
        const rows = rowsOf({
            keys: [{ book: 'Harbor Atlas', entryCount: 313 }, { book: 'Old Pier', entryCount: 2 }, { book: 'Desert Atlas', entryCount: 21 }],
            vectors: [
                tenant('Old Pier', 'vectfox_main', 50), tenant('Harbor Atlas', 'vf_lorebase_rabbit', 504), tenant('Desert Atlas', 'vectfox_main', 9),
                tenant('Harbor Atlas', 'vectfox_main', 7), tenant('Old Pier', 'vf_lorebase_rabbit', 4),
            ],
        });
        expect(shapeOf(rows)).toEqual([
            ['keys', 'Desert Atlas', 21, false], ['vectors', 'Desert Atlas', 'vf_lorebase_rabbit:0', false],
            ['keys', 'Harbor Atlas', 313, false], ['vectors', 'Harbor Atlas', 'vf_lorebase_rabbit:504', false],
            ['keys', 'Wren Journal', 0, false], ['vectors', 'Wren Journal', 'vf_lorebase_rabbit:0', false],
            ['vectors', 'Desert Atlas', 'vectfox_main:9', true],
            ['vectors', 'Harbor Atlas', 'vectfox_main:7', true],
            ['keys', 'Old Pier', 2, true], ['vectors', 'Old Pier', 'vf_lorebase_rabbit:4', true], ['vectors', 'Old Pier', 'vectfox_main:50', true],
        ]);
        expect(rows.filter(row => row.kind === KEYS).map(row => [row.book, row.hasRecord, row.selectedCount, row.selectionCount, row.isInSillyTavern])).toEqual([
            ['Desert Atlas', false, 0, 0, true], ['Harbor Atlas', true, 12, 2, true], ['Wren Journal', true, 0, 1, true], ['Old Pier', false, 0, 0, false],
        ]);
        expect(rows.some(row => row.book === 'Ghost Atlas')).toBe(false);
        expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
    });

    it('keeps the tenant ID and embedding of a vectors row, and leaves the tenant of a row at 0 empty', () => {
        const [, here] = rowsOf({ keys: [], vectors: [tenant('Harbor Atlas', 'vf_lorebase_rabbit', 504, 'vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm')] });
        expect(here).toEqual({
            key: 'vectors|vf_lorebase_rabbit|vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm', kind: VECTORS, book: 'Harbor Atlas', hasRecord: true,
            selectedCount: 12, selectionCount: 2, isInSillyTavern: true, isLeftover: false, collection: 'vf_lorebase_rabbit',
            tenant: 'vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm', isHere: true, pointCount: 504, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3',
        });
        const wren = rowsOf({ keys: [], vectors: [] }).find(row => row.kind === VECTORS && row.book === 'Wren Journal');
        expect([wren.tenant, wren.pointCount]).toEqual([null, 0]);
    });

    it('gives a tenant whose points name no book a leftover vectors row of its own, after the books', () => {
        const rows = rowsOf({ keys: [], vectors: [tenant(null, 'vf_lorebase_rabbit', 3, 'vf_lorebase_qdrant_rabbit_unnamed_1a')] });
        expect(rows.at(-1)).toMatchObject({
            kind: VECTORS, book: null, tenant: 'vf_lorebase_qdrant_rabbit_unnamed_1a', hasRecord: false, selectedCount: 0, selectionCount: 0, isInSillyTavern: false,
            isLeftover: true, pointCount: 3,
        });
    });

    it('gives a book with no row the row an import would write to, at 0, as the list draws it', () => {
        const book = { book: 'Lantern Atlas', hasRecord: false, selectedCount: 0, selectionCount: 0 };
        expect(emptyRowOf(KEYS, book, 'vectfox_main')).toEqual({
            key: 'keys|Lantern Atlas', kind: KEYS, ...book, isInSillyTavern: true, isLeftover: false, entryCount: 0,
        });
        expect(emptyRowOf(VECTORS, book, 'vectfox_main')).toEqual({
            key: 'vectors|vectfox_main|Lantern Atlas', kind: VECTORS, ...book, isInSillyTavern: true, isLeftover: false, collection: 'vectfox_main',
            tenant: null, isHere: true, pointCount: 0, embeddingSource: '', embeddingModel: '',
        });
    });
});
