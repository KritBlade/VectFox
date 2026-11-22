/**
 * The lore of a reply, the pure rules (src/features/reply-lore/reply-lore-core.js): the entries SillyTavern's World Info
 * scan activated, by book, a LoreBase block listed as the picks it carries, which can come from several books, each
 * with Jev's chance when it has one, and every other entry as SillyTavern's own, with what fired it; and how many each
 * chose.
 */
import { describe, expect, it } from 'vitest';
import { LOREBASE_SOURCE, SILLYTAVERN_SOURCE, replyLoreBooks, replyLoreCounts } from '../src/features/reply-lore/reply-lore-core.js';

const titleOf = entry => entry.comment || `entry ${entry.uid}`;
// The scan's block carried by Harbor Atlas's entry 0 holds that pick and one of Keeper Notes'.
const picksCarriedBy = entry => (entry.world === 'Harbor Atlas' && entry.uid === 0
    ? [
        { bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', isWhole: false },
        { bookName: 'Keeper Notes', uid: 7, title: "Oil's Store", isWhole: true, jevChance: 0.82 },
    ]
    : null);
const sillyTavern = (uid, title) => ({ uid, title, source: SILLYTAVERN_SOURCE, isWhole: true, jevChance: null, activation: null });

describe('replyLoreBooks', () => {
    it("lists a LoreBase block as its picks, each under its own book, and every other entry as SillyTavern's own, in the scan's order", () => {
        const activated = [
            { world: 'Tide Tables', uid: 3, comment: 'Spring tides' },
            { world: 'Harbor Atlas', uid: 0, comment: 'Lighthouse of Vell', content: '<VectLorebook>…</VectLorebook>' },
            { world: 'Harbor Atlas', uid: 2, comment: '' },
        ];
        expect(replyLoreBooks(activated, picksCarriedBy, titleOf)).toEqual([
            { bookName: 'Tide Tables', entries: [sillyTavern(3, 'Spring tides')] },
            {
                bookName: 'Harbor Atlas',
                entries: [
                    { uid: 0, title: 'Lighthouse of Vell', source: LOREBASE_SOURCE, isWhole: false, jevChance: null, activation: null },
                    sillyTavern(2, 'entry 2'),
                ],
            },
            { bookName: 'Keeper Notes', entries: [{ uid: 7, title: "Oil's Store", source: LOREBASE_SOURCE, isWhole: true, jevChance: 0.82, activation: null }] },
        ]);
    });

    it("gives SillyTavern's own entries what fired them, and LoreBase's picks none, as the scan said", () => {
        const activationOf = entry => (entry.uid === 3 ? { primaryKey: 'spring tide', loop: 2 } : null);
        const books = replyLoreBooks([{ world: 'Tide Tables', uid: 3, comment: 'Spring tides' }, { world: 'Harbor Atlas', uid: 0 }], picksCarriedBy, titleOf, activationOf);
        expect(books.flatMap(book => book.entries).map(entry => [entry.title, entry.activation]))
            .toEqual([['Spring tides', { primaryKey: 'spring tide', loop: 2 }], ['Lighthouse of Vell', null], ["Oil's Store", null]]);
    });

    it('lists nothing for a scan with no entry', () => {
        expect(replyLoreBooks([], picksCarriedBy, titleOf)).toEqual([]);
        expect(replyLoreBooks(null, picksCarriedBy, titleOf)).toEqual([]);
    });
});

describe('replyLoreCounts', () => {
    it('counts the entries LoreBase picked and those SillyTavern chose', () => {
        const books = replyLoreBooks([{ world: 'Harbor Atlas', uid: 0 }, { world: 'Tide Tables', uid: 3 }], picksCarriedBy, titleOf);
        expect(replyLoreCounts(books)).toEqual({ loreBase: 2, sillyTavern: 1 });
    });
});
