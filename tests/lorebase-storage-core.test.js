/**
 * The rules of LoreBase's storage module (src/features/lorebase/lorebase-storage-core.js, §3.1 of InternalProject/
 * Vectfox/plans/vectfox-multi-collection-per-chat.md): a run of keys writes only the entries without keys, a run of
 * vectors only those without vectors, and a run of both each entry once; the selection's lack counted by kind; the
 * progress panel's title and closing line; and a book's selected entries counted by what they have.
 */
import { describe, expect, it } from 'vitest';
import {
    BOTH_KINDS, KEYS, VECTORS, missingCountsOf, pendingOfKinds, storedCountsOf, writingPanelTitle, writtenSummary,
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
    it('counts those with keys, an empty list included, and those with vectors from the model set now', () => {
        const decided = [entry(0), entry(1), entry(2)];
        expect(storedCountsOf(decided, { 0: ['lighthouse'], 2: [] }, new Set(['1']))).toEqual({ keyCount: 2, vectorCount: 1 });
        expect(storedCountsOf(decided, undefined, new Set())).toEqual({ keyCount: 0, vectorCount: 0 });
    });
});
