/**
 * LoreBase's pick and review (plan §5.6 and D6 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md)
 * ask GPT-6 Luna the route trials' prompts word for word, and read its answers as the trials did. The fixture holds
 * made-up inputs and the prompts route_trials.py and segment_trials.py themselves render from them; InternalProject/
 * Vectfox/tools/lorebase-benchmark/export_trial_prompts.py writes it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickMessages, readPicks, tableOfContents } from '../src/features/lorebase/lorebase-pick-core.js';
import { partsToSend, readReview, reviewMessages } from '../src/features/lorebase/lorebase-review-core.js';
import { sceneText } from '../src/features/lorebase/lorebase-scene-core.js';
import { entryPassages } from '../src/features/lorebase/lorebase-splitter.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lorebase-trial-prompts.json', import.meta.url), 'utf8'));

describe("the trials' prompts, word for word", () => {
    const scene = sceneText(fixture.messages);
    const contents = tableOfContents([{ bookName: fixture.bookName, entries: fixture.entries }]);

    it("asks the pick what T28's luna_keys_table_in_system asked: toc_focus with the table of contents at the end of the system prompt", () => {
        expect(pickMessages(scene, contents)).toEqual([
            { role: 'system', content: fixture.pick.system },
            { role: 'user', content: fixture.pick.prompt },
        ]);
    });

    it("asks the pick with each entry's keys after its title as T20's luna_keys arm asked (segment_trials.py)", () => {
        const keysByUid = fixture.madeUpKeys;
        const keyed = tableOfContents([{ bookName: fixture.bookName, entries: fixture.entries, keysByUid }]);
        expect(pickMessages(scene, keyed)).toEqual([
            { role: 'system', content: fixture.keyedPick.system },
            { role: 'user', content: fixture.keyedPick.prompt },
        ]);
    });

    it('asks the review of one picked entry what route_trials.py asked', () => {
        const { number, why, needs } = fixture.reviewedPick;
        const { passages } = entryPassages(fixture.entries[number - 1]);
        expect(reviewMessages(scene, { ...contents[number - 1], why, needs }, passages)).toEqual([
            { role: 'system', content: fixture.review.system },
            { role: 'user', content: fixture.review.prompt },
        ]);
    });
});

describe('the table of contents', () => {
    it('numbers the selected entries across books in book order, each by its title with its keys', () => {
        expect(tableOfContents([
            { bookName: 'Harbor Lore', entries: [{ uid: 4, comment: '[Harbor] Keeper Orrin' }, { uid: 9, comment: 'Ferry Tolls' }], keysByUid: { 4: ['Orrin', 'lighthouse'] } },
            { bookName: 'Hill Lore', entries: [{ uid: 0, comment: 'Places: Windmill Hill' }] },
        ])).toEqual([
            { number: 1, bookName: 'Harbor Lore', uid: 4, title: 'Keeper Orrin', keys: ['Orrin', 'lighthouse'] },
            { number: 2, bookName: 'Harbor Lore', uid: 9, title: 'Ferry Tolls', keys: [] },
            { number: 3, bookName: 'Hill Lore', uid: 0, title: 'Windmill Hill', keys: [] },
        ]);
    });
});

describe('reading the pick', () => {
    const contents = tableOfContents([{ bookName: 'Harbor Lore', entries: Array.from({ length: 9 }, (_, uid) => ({ uid, comment: `Entry ${uid}` })) }]);

    it('keeps the picks in their order with their reasons, each entry once, at most 6', () => {
        const items = [9, 3, 3, 1, 2, 4, 5, 6, 7].map(number => ({ number, basis: ' Named In The Chat ', why: ' The user asks. ', needs: ' who ', certain: number === 9 }));
        const { picks, unreadItemCount } = readPicks(items, contents);
        expect(picks.map(pick => pick.number)).toEqual([9, 3, 1, 2, 4, 5]);
        expect(picks[0]).toEqual({
            number: 9, bookName: 'Harbor Lore', uid: 8, title: 'Entry 8', keys: [], basis: 'named in the chat', why: 'The user asks.', needs: 'who', certain: true,
        });
        expect(picks[1].certain).toBe(false);
        expect(unreadItemCount).toBe(0);
    });

    it('counts the items that name no entry of the table, which the trials skipped', () => {
        const { picks, unreadItemCount } = readPicks([{ number: 0 }, { number: 10 }, { number: '2' }, { number: 2.5 }, { why: 'no number' }, null, { number: 2 }], contents);
        expect(picks).toEqual([{ number: 2, bookName: 'Harbor Lore', uid: 1, title: 'Entry 1', keys: [], basis: '', why: '', needs: '', certain: null }]);
        expect(unreadItemCount).toBe(6);
    });

    it('reads an answer that picks nothing as no picks', () => {
        expect(readPicks([], contents)).toEqual({ picks: [], unreadItemCount: 0 });
    });
});

describe('reading the review', () => {
    it('reads how much the reply uses and the parts to leave out, each a whole number among the parts', () => {
        expect(readReview([{ entry: 1, uses: ' Some ', leave_out: [4, '2', ' 3 ', 2, 9, 0, 'two', 1.5] }], 4)).toEqual({ uses: 'some', leaveOut: [2, 3, 4] });
    });

    it('finds the answer for entry 1 written as a number or as text, with or without parts to leave out', () => {
        expect(readReview([{ entry: '1', uses: 'none' }], 3)).toEqual({ uses: 'none', leaveOut: [] });
        expect(readReview([{ entry: 2, uses: 'most' }, { entry: 1, uses: 'most', leave_out: 'all' }], 3)).toEqual({ uses: 'most', leaveOut: [] });
    });

    it('cannot read an answer with no entry 1, or no amount the prompt offered', () => {
        expect(readReview([{ entry: 2, uses: 'most' }], 3)).toBeNull();
        expect(readReview([{ entry: 1, uses: 'all' }], 3)).toBeNull();
        expect(readReview([{ entry: 1, leave_out: [2] }], 3)).toBeNull();
        expect(readReview([], 3)).toBeNull();
    });
});

describe('what a reviewed pick sends', () => {
    const passages = [
        { section: '(intro)', text: 'The drowned bell hangs beneath the harbor.' },
        { section: 'History', text: '[History]\nIt rang the night the sea wall broke.' },
        { section: 'Rules', text: '[Rules]\nOnly a keeper may ring it.' },
    ];

    it("sends every part but those left out, in the entry's order", () => {
        expect(partsToSend(passages, { uses: 'some', leaveOut: [2] }, [])).toEqual([1, 3]);
    });

    it('sends a pinned section even when the review leaves it out', () => {
        expect(partsToSend(passages, { uses: 'some', leaveOut: [1, 3] }, ['Rules'])).toEqual([2, 3]);
    });

    it('sends nothing when the reply uses none of the entry, pinned sections included', () => {
        expect(partsToSend(passages, { uses: 'none', leaveOut: [] }, ['Rules'])).toEqual([]);
    });

    it('sends an entry with template code whole (D9)', () => {
        const templated = [...passages, { section: 'State', text: '<%= tideLevel %>' }];
        expect(partsToSend(templated, { uses: 'most', leaveOut: [1, 2] }, [])).toEqual([1, 2, 3, 4]);
    });
});
