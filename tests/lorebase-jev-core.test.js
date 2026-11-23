/**
 * LoreBase's Fast and Cheap [Jev] choice, the pure rules (src/features/lorebase/lorebase-jev-core.js, plan D16 and §5.6 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md, §5 of lorebook-multi-vector.md): Jev's
 * state and questions are T22's word for word, as segment_trials.py renders them in the fixture export_trial_prompts.py
 * writes; the entries above 0.25 go whole with no review, best first, within the lore budget, as T37's budgeted_entries
 * sent them; above 100 entries a search's pool is asked about, at 100 or fewer every entry; and a failed search or
 * request is a failed pick.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    LORE_BUDGET_DEFAULT, LORE_BUDGET_MAX, LORE_BUDGET_MIN, POOL_SEATS, jevPicks, jevQuestions, jevState, loreBudgetOf, loreForReplyByJev,
} from '../src/features/lorebase/lorebase-jev-core.js';
import { tableOfContents } from '../src/features/lorebase/lorebase-pick-core.js';
import { SENT_WHOLE_UNREVIEWED } from '../src/features/lorebase/lorebase-reply-core.js';
import { sceneText } from '../src/features/lorebase/lorebase-scene-core.js';
import { entryPassages } from '../src/features/lorebase/lorebase-splitter.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lorebase-trial-prompts.json', import.meta.url), 'utf8'));

describe("T22's request to Jev, word for word", () => {
    it('sends the state and one question per entry as segment_trials.py renders them', () => {
        const contents = tableOfContents([{ bookName: fixture.bookName, entries: fixture.entries, keysByUid: fixture.madeUpKeys }]);
        expect(fixture.jev.model).toBe('typesafe/jev-1.14');
        expect(jevState(sceneText(fixture.messages))).toBe(fixture.jev.state);
        expect(jevQuestions(contents)).toEqual(fixture.jev.questions);
    });
});

describe("Jev's question for an entry with no keys", () => {
    it('names the entry alone, with no empty list of what it is about', () => {
        expect(jevQuestions([{ number: 1, title: 'Section marker', keys: [] }])).toEqual({
            [Object.keys(jevQuestions([{ number: 1, title: 'x', keys: ['y'] }]))[0]]: {
                type: 'noul', instructions: 'Does the next reply need the lorebook entry "Section marker"?',
            },
        });
    });
});

describe('the lore budget', () => {
    it('is 4,000 tokens by default, held from 1,000 to 12,000, a whole number', () => {
        expect([LORE_BUDGET_DEFAULT, LORE_BUDGET_MIN, LORE_BUDGET_MAX]).toEqual([4000, 1000, 12000]);
        expect([undefined, '', 'many', null].map(loreBudgetOf)).toEqual([4000, 4000, 4000, 4000]);
        expect([4500, '6000', 500, 20000, 2750.8].map(loreBudgetOf)).toEqual([4500, 6000, 1000, 12000, 2750]);
    });
});

describe("Jev's picks", () => {
    const contents = Array.from({ length: 9 }, (_, index) => ({ number: index + 1, bookName: 'Harbor Atlas', uid: index, title: `Entry ${index}`, keys: ['harbor'] }));
    const yesOf = values => Object.fromEntries(values.map((value, index) => [`e${index + 1}`, value]));
    const tokensOf = sizes => item => sizes[item.number - 1];
    const tenTokensEach = tokensOf(Array(9).fill(10));

    it('takes the entries rated above 0.25, best first, a tie in the table\'s order, and never one at 0.25', () => {
        const picks = jevPicks(yesOf([0.3, 0.25, 0.64, 0.26, 0.26, 0.1, 0.47]), contents, tenTokensEach, 3000);
        expect(picks.map(pick => [pick.number, pick.yes])).toEqual([[3, 0.64], [7, 0.47], [1, 0.3], [4, 0.26], [5, 0.26]]);
    });

    it('takes every entry above 0.25 that the budget holds, more than 6 when they fit, and none when no entry passes', () => {
        expect(jevPicks(yesOf([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3, 0.28]), contents, tenTokensEach, 3000).map(pick => pick.number))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(jevPicks(yesOf([0.2, 0.1, 0.25]), contents, tenTokensEach, 3000)).toEqual([]);
    });

    it('keeps the best always, skips one that would pass the budget and tries the next, as T37 sent them', () => {
        const sizes = tokensOf([1800, 900, 600, 400, 200, 10, 10, 10, 10]);
        const yes = yesOf([0.9, 0.8, 0.7, 0.6, 0.5, 0.1, 0.1, 0.1, 0.1]);
        // 1,800 + 900 = 2,700; 600 would pass 3,000 and is skipped; 400 would too; 200 fits at 2,900.
        expect(jevPicks(yes, contents, sizes, 3000).map(pick => pick.number)).toEqual([1, 2, 5]);
        expect(jevPicks(yesOf([0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), contents, tokensOf([5000, 1, 1, 1, 1, 1, 1, 1, 1]), 3000).map(pick => pick.number))
            .toEqual([1]);
    });
});

describe('a reply on Fast and Cheap [Jev]', () => {
    const lighthouse = { uid: 0, comment: 'Lighthouse of Vell', content: '[Cliff]\nThe lighthouse stands on the north cliff.\n[Lamp]\nIts lamp burns all night.' };
    const tidewardens = { uid: 1, comment: 'Tidewardens', content: 'The tidewardens read the harbor bells.' };
    const books = [{ bookName: 'Harbor Atlas', entries: [lighthouse, tidewardens], pinnedSections: [], keysByUid: { 0: ['lighthouse'], 1: ['tidewardens'] } }];
    const scene = 'Wren: Who keeps the lamp tonight?';
    const noSearch = vi.fn(async () => { throw new Error('no search at 100 entries or fewer'); });

    it('asks Jev once about every entry at 100 or fewer, with no search, and sends its picks whole, with no review', async () => {
        const ask = vi.fn(async () => ({ yes: { e1: 0.64, e2: 0.2 } }));
        const lore = await loreForReplyByJev({ scene, books, ask, searchPool: noSearch, loreBudget: 3000 });

        expect(noSearch).not.toHaveBeenCalled();
        expect(ask).toHaveBeenCalledTimes(1);
        expect(ask.mock.calls[0]).toEqual([jevState(scene), jevQuestions(tableOfContents(books))]);
        expect(lore.contentCount).toBe(2);
        expect(lore.search).toEqual({ seats: POOL_SEATS, poolCount: null, seconds: null });
        expect(lore.picks.map(pick => [pick.title, pick.yes])).toEqual([['Lighthouse of Vell', 0.64]]);
        expect(lore.reviewedPicks).toEqual([{
            bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', uses: SENT_WHOLE_UNREVIEWED, ...entryPassages(lighthouse),
            sentParts: [1, 2], seconds: null, jevChance: 0.64,
        }]);
        expect(lore.failures).toEqual([]);
        expect(lore.pickSeconds).toEqual(expect.any(Number));
    });

    it("counts an entry's tokens as the splitter counts its parts, against the budget", async () => {
        const ask = async () => ({ yes: { e1: 0.64, e2: 0.5 } });
        const lighthouseTokens = entryPassages(lighthouse).passages.reduce((total, passage) => total + passage.tokens, 0);
        const tight = await loreForReplyByJev({ scene, books, ask, searchPool: noSearch, loreBudget: lighthouseTokens });
        expect(tight.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell']);
        const roomy = await loreForReplyByJev({ scene, books, ask, searchPool: noSearch, loreBudget: 3000 });
        expect(roomy.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell', 'Tidewardens']);
    });

    describe('above 100 entries', () => {
        const many = Array.from({ length: POOL_SEATS + 5 }, (_, uid) => ({ uid, comment: `Entry ${uid}`, content: `Text of entry ${uid}.` }));
        const bigBooks = [{ bookName: 'Harbor Atlas', entries: many, pinnedSections: [], keysByUid: {} }];

        it('asks Jev only about the search\'s pool, with the table\'s numbers, and keeps the pool\'s size and the search\'s seconds', async () => {
            const searchPool = vi.fn(async contents => [contents[104], contents[2]]);
            const ask = vi.fn(async () => ({ yes: { e105: 0.9, e3: 0.4 } }));
            const lore = await loreForReplyByJev({ scene, books: bigBooks, ask, searchPool, loreBudget: 3000 });

            expect(searchPool).toHaveBeenCalledWith(tableOfContents(bigBooks));
            expect(Object.keys(ask.mock.calls[0][1])).toEqual(['e105', 'e3']);
            expect(lore.contentCount).toBe(105);
            expect(lore.search).toEqual({ seats: POOL_SEATS, poolCount: 2, seconds: expect.any(Number) });
            expect(lore.picks.map(pick => pick.title)).toEqual(['Entry 104', 'Entry 2']);
        });

        it('fails as a failed pick when the search fails, Jev not asked, its error kept', async () => {
            const error = Object.assign(new Error('Query embedding failed'), { code: 'invalid_model_config' });
            const ask = vi.fn();
            const lore = await loreForReplyByJev({ scene, books: bigBooks, ask, searchPool: async () => { throw error; }, loreBudget: 3000 });
            expect(ask).not.toHaveBeenCalled();
            expect(lore).toEqual({
                contentCount: 105, picks: [], unreadItemCount: 0, pickSeconds: null,
                search: { seats: POOL_SEATS, poolCount: null, seconds: expect.any(Number) }, reviewedPicks: [],
                failures: [{ step: 'pick', detail: 'the search failed: Query embedding failed', error }],
            });
        });

        it('asks Jev nothing when the search finds no part of a ready entry', async () => {
            const ask = vi.fn();
            const lore = await loreForReplyByJev({ scene, books: bigBooks, ask, searchPool: async () => [], loreBudget: 3000 });
            expect(ask).not.toHaveBeenCalled();
            expect([lore.picks, lore.failures, lore.search.poolCount, lore.pickSeconds]).toEqual([[], [], 0, null]);
        });
    });

    it('fails as a failed pick when Jev fails, so every selected entry is left out', async () => {
        const error = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
        const lore = await loreForReplyByJev({ scene, books, ask: async () => { throw error; }, searchPool: noSearch, loreBudget: 3000 });
        expect(lore).toEqual({
            contentCount: 2, picks: [], unreadItemCount: 0, pickSeconds: expect.any(Number),
            search: { seats: POOL_SEATS, poolCount: null, seconds: null }, reviewedPicks: [],
            failures: [{ step: 'pick', detail: 'it did not answer within 30 seconds', error }],
        });
    });
});
