/**
 * LoreBase's tester, the pure rules (src/features/lorebase/lorebase-tester-core.js, plan §5.10 of InternalProject/
 * Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): a reply's report joins each pick with Luna's reasons and
 * its review, part by part, with the text it sends as the World Info scan gets it; lists the selected entries the pick
 * skipped; takes the reviews' wait as the slowest one's, as they run at once; counts the picks' tokens; and finds what
 * SillyTavern's keys would send among the entries a scan as SillyTavern alone activated.
 */
import { describe, expect, it } from 'vitest';

const { pickTokens, replyReport, selectedTextsSentByKeys } = await import('../src/features/lorebase/lorebase-tester-core.js');

const lighthouse = {
    uid: 0, comment: 'Lighthouse of Vell',
    content: '[Overview]\nThe lighthouse stands on the north cliff of Vell.\n[Keepers]\nKeeper Orrin tends the lamp each night.',
};
const tidewardens = { uid: 1, comment: 'Tidewardens', content: '@@activate\nThe tidewardens read the harbor bells.' };
const oldPier = { uid: 2, comment: 'Old Pier', content: 'The old pier fell in the long storm.' };
const fogSeason = { uid: 4, comment: 'Fog Season', content: 'Fog closes the strait each spring.' };
const books = [
    { bookName: 'Harbor Atlas', entries: [lighthouse, tidewardens, oldPier], pinnedSections: [] },
    { bookName: 'Wren Journal', entries: [fogSeason], pinnedSections: [] },
];
const passage = text => ({ section: '(intro)', text, tokens: 5 });
const picked = (bookName, entry, number, certain = true) => ({
    number, bookName, uid: entry.uid, title: entry.comment, basis: 'named in the chat', certain, why: `why ${number}`, needs: `needs ${number}`,
});
const lighthouseParts = [passage('[Overview] The lighthouse stands on the north cliff of Vell.'), passage('Keeper Orrin tends the lamp each night.')];
const timeout = new Error('timed out');
const lore = {
    contentCount: 4,
    picks: [picked('Harbor Atlas', lighthouse, 1), picked('Harbor Atlas', tidewardens, 2, false), picked('Wren Journal', fogSeason, 4)],
    unreadItemCount: 1,
    pickSeconds: 2.5,
    reviewedPicks: [
        { bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', uses: 'some', frame: null, passages: lighthouseParts, sentParts: [2], seconds: 3.1 },
        { bookName: 'Harbor Atlas', uid: 1, title: 'Tidewardens', uses: 'most', frame: null, passages: [passage('The tidewardens read the harbor bells.')], sentParts: [1], seconds: 1.2 },
    ],
    failures: [{ step: 'review', bookName: 'Wren Journal', uid: 4, title: 'Fog Season', detail: 'it did not answer within 30 seconds', error: timeout, seconds: 30 }],
};
const wordCount = async text => text.split(/\s+/u).filter(Boolean).length;

describe("a reply's report", () => {
    it("joins each pick with Luna's reasons and its review, part by part, with the text it sends", () => {
        const report = replyReport({ lore, books, seconds: 33.2 });
        expect(report.picks).toEqual([
            {
                bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', basis: 'named in the chat', certain: true, why: 'why 1', needs: 'needs 1', yes: null,
                wholeText: lighthouse.content,
                review: {
                    uses: 'some', seconds: 3.1,
                    parts: [{ text: lighthouseParts[0].text, isSent: false }, { text: lighthouseParts[1].text, isSent: true }],
                    sentText: 'Keeper Orrin tends the lamp each night.',
                },
                failure: null, isInPrompt: null,
            },
            {
                bookName: 'Harbor Atlas', uid: 1, title: 'Tidewardens', basis: 'named in the chat', certain: false, why: 'why 2', needs: 'needs 2', yes: null,
                wholeText: 'The tidewardens read the harbor bells.',
                review: { uses: 'most', seconds: 1.2, parts: [{ text: 'The tidewardens read the harbor bells.', isSent: true }], sentText: 'The tidewardens read the harbor bells.' },
                failure: null, isInPrompt: null,
            },
            {
                bookName: 'Wren Journal', uid: 4, title: 'Fog Season', basis: 'named in the chat', certain: true, why: 'why 4', needs: 'needs 4', yes: null,
                wholeText: fogSeason.content, review: null, failure: 'it did not answer within 30 seconds', isInPrompt: null,
            },
        ]);
    });

    it('lists the selected entries the pick skipped, keeps each failure without its error, and takes the slowest review as the wait', () => {
        const report = replyReport({ lore, books, seconds: 33.2 });
        expect(report.skipped).toEqual([{ bookName: 'Harbor Atlas', uid: 2, title: 'Old Pier' }]);
        expect(report.failures).toEqual([{ step: 'review', title: 'Fog Season', detail: 'it did not answer within 30 seconds' }]);
        expect(report.seconds).toEqual({ search: null, pick: 2.5, slowestReview: 30, total: 33.2 });
        expect([report.contentCount, report.unreadItemCount]).toEqual([4, 1]);
        expect(report.search).toBeNull();
    });

    it("keeps Fast and Cheap [Jev]'s search: the seats, the entries it kept, and its seconds", () => {
        const searched = replyReport({ lore: { ...lore, search: { seats: 100, poolCount: 100, seconds: 0.6 } }, books, seconds: 1.8 });
        expect(searched.search).toEqual({ seats: 100, poolCount: 100 });
        expect(searched.seconds.search).toBe(0.6);
        const unsearched = replyReport({ lore: { ...lore, search: { seats: 100, poolCount: null, seconds: null } }, books, seconds: 1.2 });
        expect(unsearched.search).toEqual({ seats: 100, poolCount: null });
        expect(unsearched.seconds.search).toBeNull();
    });

    it("keeps High Accuracy's pick tokens, those read from the provider's cache among them, and none when the call reported none", () => {
        expect(replyReport({ lore: { ...lore, pickTokens: { prompt: 15070, cached: 10141 } }, books, seconds: 6 }).pickTokens).toEqual({ prompt: 15070, cached: 10141 });
        expect(replyReport({ lore: { ...lore, pickTokens: { prompt: 15070, cached: null } }, books, seconds: 6 }).pickTokens).toEqual({ prompt: 15070, cached: null });
        expect(replyReport({ lore: { ...lore, pickTokens: null }, books, seconds: 6 }).pickTokens).toBeNull();
        expect(replyReport({ lore, books, seconds: 6 }).pickTokens).toBeNull();
    });

    it('sends nothing of a pick whose review says the reply uses none of it', () => {
        const none = { ...lore.reviewedPicks[0], uses: 'none', sentParts: [] };
        const report = replyReport({ lore: { ...lore, reviewedPicks: [none], failures: [] }, books, seconds: 4 });
        expect(report.picks[0].review).toMatchObject({ uses: 'none', sentText: '' });
        expect(report.picks[0].review.parts.map(part => part.isSent)).toEqual([false, false]);
    });

    it('skips every selected entry when the pick fails, with no review to wait for', () => {
        const failed = { contentCount: 4, picks: [], unreadItemCount: 0, pickSeconds: 30, reviewedPicks: [], failures: [{ step: 'pick', detail: 'its answer could not be read', error: timeout }] };
        const report = replyReport({ lore: failed, books, seconds: 30.1 });
        expect(report.picks).toEqual([]);
        expect(report.skipped.map(entry => entry.title)).toEqual(['Lighthouse of Vell', 'Tidewardens', 'Old Pier', 'Fog Season']);
        expect(report.failures).toEqual([{ step: 'pick', title: null, detail: 'its answer could not be read' }]);
        expect(report.seconds).toEqual({ search: null, pick: 30, slowestReview: null, total: 30.1 });
    });
});

describe("a reply's tokens", () => {
    it('counts what each reviewed pick sends and the same entry whole, and nothing for a failed review', async () => {
        const report = replyReport({ lore, books, seconds: 33.2 });
        expect(await pickTokens(report, wordCount)).toEqual({ sent: 13, pickedWhole: 24, picks: [{ sent: 7, whole: 18 }, { sent: 6, whole: 6 }, null] });
    });

    it("finds what SillyTavern's keys would send among the selected entries a scan as SillyTavern alone activated, each whole", () => {
        const report = replyReport({ lore, books, seconds: 33.2 });
        const activated = new Set([
            { world: 'Harbor Atlas', uid: 0, content: lighthouse.content },
            { world: 'Harbor Atlas', uid: 9, content: 'Not selected.' },
            { world: 'Keeper Notes', uid: 2, content: 'Another book, the same uid.' },
            { world: 'Harbor Atlas', uid: 1, content: tidewardens.content },
            { world: 'Harbor Atlas', uid: 2, content: oldPier.content },
        ]);
        expect(selectedTextsSentByKeys(report, activated)).toEqual([lighthouse.content, 'The tidewardens read the harbor bells.', oldPier.content]);
    });
});
