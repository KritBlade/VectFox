/**
 * LoreBase's Fast and Cheap [Jev] choice, the pure rules (src/features/lorebase/lorebase-jev-core.js, plan D16 and §5.6 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): Jev's state and questions are T22's word
 * for word, as segment_trials.py renders them in the fixture export_trial_prompts.py writes; the entries above 0.25, at
 * most 6, best first, go whole with no review; and a failed request is a failed pick.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { jevPicks, jevQuestions, jevState, loreForReplyByJev } from '../src/features/lorebase/lorebase-jev-core.js';
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

describe("Jev's picks", () => {
    const contents = Array.from({ length: 9 }, (_, index) => ({ number: index + 1, bookName: 'Harbor Atlas', uid: index, title: `Entry ${index}`, keys: ['harbor'] }));
    const yesOf = values => Object.fromEntries(values.map((value, index) => [`e${index + 1}`, value]));

    it('takes the entries rated above 0.25, best first, a tie in the table\'s order, and never one at 0.25', () => {
        const picks = jevPicks(yesOf([0.3, 0.25, 0.64, 0.26, 0.26, 0.1, 0.47]), contents);
        expect(picks.map(pick => [pick.number, pick.yes])).toEqual([[3, 0.64], [7, 0.47], [1, 0.3], [4, 0.26], [5, 0.26]]);
    });

    it('takes at most 6, and none when no entry passes', () => {
        expect(jevPicks(yesOf([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3, 0.28]), contents).map(pick => pick.number)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(jevPicks(yesOf([0.2, 0.1, 0.25]), contents)).toEqual([]);
    });
});

describe('a reply on Fast and Cheap [Jev]', () => {
    const lighthouse = { uid: 0, comment: 'Lighthouse of Vell', content: '[Cliff]\nThe lighthouse stands on the north cliff.\n[Lamp]\nIts lamp burns all night.' };
    const tidewardens = { uid: 1, comment: 'Tidewardens', content: 'The tidewardens read the harbor bells.' };
    const books = [{ bookName: 'Harbor Atlas', entries: [lighthouse, tidewardens], pinnedSections: [], keysByUid: { 0: ['lighthouse'], 1: ['tidewardens'] } }];
    const scene = 'Wren: Who keeps the lamp tonight?';

    it('asks Jev once and sends its picks whole, with no review', async () => {
        const ask = vi.fn(async () => ({ yes: { e1: 0.64, e2: 0.2 } }));
        const lore = await loreForReplyByJev({ scene, books, ask });

        expect(ask).toHaveBeenCalledTimes(1);
        expect(ask.mock.calls[0]).toEqual([jevState(scene), jevQuestions(tableOfContents(books))]);
        expect(lore.contentCount).toBe(2);
        expect(lore.picks.map(pick => [pick.title, pick.yes])).toEqual([['Lighthouse of Vell', 0.64]]);
        expect(lore.reviewedPicks).toEqual([{
            bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', uses: SENT_WHOLE_UNREVIEWED, ...entryPassages(lighthouse),
            sentParts: [1, 2], seconds: null,
        }]);
        expect(lore.failures).toEqual([]);
        expect(lore.pickSeconds).toEqual(expect.any(Number));
    });

    it('fails as a failed pick, so every selected entry is left out', async () => {
        const error = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
        const lore = await loreForReplyByJev({ scene, books, ask: async () => { throw error; } });
        expect(lore).toEqual({
            contentCount: 2, picks: [], unreadItemCount: 0, pickSeconds: expect.any(Number), reviewedPicks: [],
            failures: [{ step: 'pick', detail: 'it did not answer within 30 seconds', error }],
        });
    });
});
