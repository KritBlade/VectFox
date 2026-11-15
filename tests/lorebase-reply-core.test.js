/**
 * LoreBase on a reply, the pure rules (src/features/lorebase/lorebase-reply-core.js, plan §5.6, §5.8 and D8 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): which generations get a pick, the books
 * taking part and the entries LoreBase decides in them, the pick and one review per pick sent at once as the route
 * trials sent them, what a failed call leaves out (D14), and the toast that says so.
 */
import { describe, expect, it, vi } from 'vitest';
import { pickMessages, tableOfContents } from '../src/features/lorebase/lorebase-pick-core.js';
import {
    activeBookNames, decidedEntries, isReplyGeneration, loreForReply, leftOutLoreMessage, reviewEffort,
} from '../src/features/lorebase/lorebase-reply-core.js';
import { reviewMessages } from '../src/features/lorebase/lorebase-review-core.js';
import { entryPassages } from '../src/features/lorebase/lorebase-splitter.js';

describe('which generations get a pick (D8)', () => {
    it('picks for normal sends, swipes, regenerates and continues', () => {
        for (const type of ['normal', 'swipe', 'regenerate', 'continue']) expect(isReplyGeneration(type, null), type).toBe(true);
    });

    it('picks for a quiet generation only when it is quiet-to-loud, and never for impersonate', () => {
        expect(isReplyGeneration('quiet', null)).toBe(false);
        expect(isReplyGeneration('quiet', { type: 'quiet', isQuietToLoud: false })).toBe(false);
        expect(isReplyGeneration('quiet', { type: 'quiet', isQuietToLoud: true })).toBe(true);
        // A record another kind of generation left says nothing about this one.
        expect(isReplyGeneration('quiet', { type: 'continue', isQuietToLoud: true })).toBe(false);
        expect(isReplyGeneration('impersonate', { type: 'impersonate', isQuietToLoud: true })).toBe(false);
    });
});

describe('the books taking part', () => {
    it('lists each book SillyTavern loads, in the order it loads them: global, character, chat, then persona', () => {
        expect(activeBookNames({ globalBooks: ['Harbor Atlas'], characterBooks: ['Keeper Notes', 'Tide Tables'], chatBook: 'Voyage Log', personaBook: 'Wren Journal' }))
            .toEqual(['Harbor Atlas', 'Keeper Notes', 'Tide Tables', 'Voyage Log', 'Wren Journal']);
    });

    it('takes a book that is in two places once, where SillyTavern loads it', () => {
        expect(activeBookNames({ globalBooks: ['Harbor Atlas'], characterBooks: ['Harbor Atlas', 'Voyage Log', 'Wren Journal'], chatBook: 'Voyage Log', personaBook: 'Wren Journal' }))
            .toEqual(['Harbor Atlas', 'Voyage Log', 'Wren Journal']);
        expect(activeBookNames({ globalBooks: ['Voyage Log'], characterBooks: [], chatBook: 'Voyage Log', personaBook: 'Voyage Log' })).toEqual(['Voyage Log']);
        expect(activeBookNames({ globalBooks: [], characterBooks: [], chatBook: null, personaBook: null })).toEqual([]);
    });
});

describe('the entries LoreBase decides', () => {
    const book = {
        entries: {
            0: { uid: 0, comment: 'Lighthouse of Vell' },
            1: { uid: 1, comment: 'Tidewardens' },
            2: { uid: 2, comment: 'Old Pier', disable: true },
            3: { uid: 3, comment: 'Harbor Bell', constant: true },
            4: { uid: 4, comment: 'Storm Watch', sticky: 2 },
            5: { uid: 5, comment: 'Fog Season', cooldown: 3 },
            6: { uid: 6, comment: 'Net Market', sticky: 0, cooldown: null },
        },
    };

    it("keeps the selected entries in the book's order, and leaves SillyTavern its disabled, constant, sticky and cooldown ones", () => {
        expect(decidedEntries(book, { selectedUids: ['6', '0', '2', '3', '4', '5'] }).map(entry => entry.uid)).toEqual([0, 6]);
    });

    it('decides nothing in a book with no selection, or one SillyTavern could not load', () => {
        expect(decidedEntries(book, { selectedUids: [] })).toEqual([]);
        expect(decidedEntries(book, null)).toEqual([]);
        expect(decidedEntries(null, { selectedUids: ['0'] })).toEqual([]);
    });
});

describe("the review's reasoning effort", () => {
    it('is the model default on High Accuracy, so none is sent, and low on Default Accuracy', () => {
        expect(reviewEffort('high')).toBeNull();
        expect(reviewEffort('default')).toBe('low');
    });
});

describe("a reply's pick and reviews", () => {
    const scene = 'Wren: Who keeps the lamp at Vell tonight?';
    const lighthouse = { uid: 0, comment: 'Lighthouse of Vell', content: '[Overview]\nThe lighthouse stands on the north cliff of Vell.\n[Keepers]\nKeeper Orrin tends the lamp each night.\n[History]\nIt was raised after the long storm.' };
    const tidewardens = { uid: 1, comment: 'Tidewardens', content: 'The tidewardens read the harbor bells.' };
    const fogSeason = { uid: 4, comment: 'Fog Season', content: 'Fog closes the strait for a month each spring.' };
    const harborAtlas = { bookName: 'Harbor Atlas', entries: [lighthouse, tidewardens], pinnedSections: [] };
    const wrenJournal = { bookName: 'Wren Journal', entries: [fogSeason], pinnedSections: [] };
    const pickItem = (number, why = `why ${number}`) => ({ number, basis: 'named in the chat', certain: true, why, needs: `needs ${number}` });
    const isPick = request => request.identKeys[0] === 'number';
    const timeout = () => Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });

    it('asks the pick at low effort with room for 1500 tokens and 8000 of thinking, then one review per pick at 2000 and 8000, all sent at once', async () => {
        let releaseReviews;
        const reviewsHeld = new Promise(resolve => { releaseReviews = resolve; });
        const ask = vi.fn(async (_messages, request) => {
            if (isPick(request)) return [pickItem(3, 'fog decides the crossing'), pickItem(1, 'the keeper is asked after')];
            await reviewsHeld;
            return [{ entry: 1, uses: 'some', leave_out: [3] }];
        });
        const books = [harborAtlas, wrenJournal];
        const running = loreForReply({ scene, books, reviewEffort: 'low', ask });
        // Both reviews are asked before either answers.
        await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
        releaseReviews();
        const lore = await running;

        const contents = tableOfContents(books);
        expect(ask.mock.calls[0]).toEqual([pickMessages(scene, contents), { maxTokens: 9500, reasoningEffort: 'low', identKeys: ['number'] }]);
        const review = { maxTokens: 10000, reasoningEffort: 'low', identKeys: ['entry'] };
        expect(ask.mock.calls[1]).toEqual([reviewMessages(scene, { title: 'Fog Season', why: 'fog decides the crossing', needs: 'needs 3' }, entryPassages(fogSeason).passages), review]);
        expect(ask.mock.calls[2]).toEqual([reviewMessages(scene, { title: 'Lighthouse of Vell', why: 'the keeper is asked after', needs: 'needs 1' }, entryPassages(lighthouse).passages), review]);

        expect(entryPassages(lighthouse).passages).toHaveLength(3);
        expect(lore.contentCount).toBe(3);
        expect(lore.picks.map(pick => pick.title)).toEqual(['Fog Season', 'Lighthouse of Vell']);
        expect(lore.reviewedPicks.map(({ bookName, uid, uses, sentParts }) => ({ bookName, uid, uses, sentParts }))).toEqual([
            { bookName: 'Wren Journal', uid: 4, uses: 'some', sentParts: [1] },
            { bookName: 'Harbor Atlas', uid: 0, uses: 'some', sentParts: [1, 2] },
        ]);
        expect(lore.failures).toEqual([]);
    });

    it("asks the review at the model's default effort on High Accuracy", async () => {
        const ask = vi.fn(async (_messages, request) => (isPick(request) ? [pickItem(2)] : [{ entry: 1, uses: 'most', leave_out: [] }]));
        await loreForReply({ scene, books: [harborAtlas], reviewEffort: null, ask });
        expect(ask.mock.calls[1][1]).toEqual({ maxTokens: 10000, reasoningEffort: null, identKeys: ['entry'] });
    });

    it("keeps a pinned section's parts whatever the review leaves out, and sends nothing of an entry the reply uses none of", async () => {
        const historySection = entryPassages(lighthouse).passages[2].section;
        const pinned = { ...harborAtlas, pinnedSections: [historySection] };
        const ask = vi.fn(async (messages, request) => {
            if (isPick(request)) return [pickItem(1), pickItem(2)];
            return messages[1].content.includes('Entry 1: Lighthouse of Vell') ? [{ entry: 1, uses: 'some', leave_out: [2, 3] }] : [{ entry: 1, uses: 'none', leave_out: [] }];
        });
        const lore = await loreForReply({ scene, books: [pinned], reviewEffort: 'low', ask });
        expect(lore.reviewedPicks.map(({ title, sentParts }) => ({ title, sentParts }))).toEqual([
            { title: 'Lighthouse of Vell', sentParts: [1, 3] },
            { title: 'Tidewardens', sentParts: [] },
        ]);
        expect(lore.failures).toEqual([]);
    });

    it('asks no review when the pick names none', async () => {
        const ask = vi.fn(async () => []);
        const lore = await loreForReply({ scene, books: [harborAtlas], reviewEffort: 'low', ask });
        expect(ask).toHaveBeenCalledTimes(1);
        expect(lore).toMatchObject({ picks: [], reviewedPicks: [], failures: [] });
    });

    it('leaves every selected entry out when the pick fails, and asks no review', async () => {
        const error = timeout();
        const ask = vi.fn(async () => { throw error; });
        const lore = await loreForReply({ scene, books: [harborAtlas], reviewEffort: 'low', ask });
        expect(ask).toHaveBeenCalledTimes(1);
        expect(lore).toEqual({
            contentCount: 2, picks: [], unreadItemCount: 0, reviewedPicks: [],
            failures: [{ step: 'pick', detail: 'it did not answer within 30 seconds', error }],
        });
    });

    it('leaves out only the entry whose review failed, and the other picks go in', async () => {
        const error = Object.assign(new Error('LoreBase: OpenRouter HTTP 429: Too Many Requests'), { kind: 'http' });
        const ask = vi.fn(async (messages, request) => {
            if (isPick(request)) return [pickItem(1), pickItem(2)];
            if (messages[1].content.includes('Entry 1: Lighthouse of Vell')) throw error;
            return [{ entry: 1, uses: 'most', leave_out: [] }];
        });
        const lore = await loreForReply({ scene, books: [harborAtlas], reviewEffort: 'low', ask });
        expect(lore.reviewedPicks.map(({ title, sentParts }) => ({ title, sentParts }))).toEqual([{ title: 'Tidewardens', sentParts: [1] }]);
        expect(lore.failures).toEqual([{ step: 'review', title: 'Lighthouse of Vell', detail: 'LoreBase: OpenRouter HTTP 429: Too Many Requests', error }]);
    });

    it('fails a call whose answer cannot be read: a pick with no entries in it, or a review with no amount for entry 1', async () => {
        const unreadable = Object.assign(new Error('Unable to find record array in LoreBase response.'), { kind: 'parse' });
        const pickAsk = vi.fn(async () => { throw unreadable; });
        expect((await loreForReply({ scene, books: [harborAtlas], reviewEffort: 'low', ask: pickAsk })).failures)
            .toEqual([{ step: 'pick', detail: 'its answer could not be read', error: unreadable }]);

        const reviewAsk = vi.fn(async (_messages, request) => (isPick(request) ? [pickItem(2)] : [{ entry: 2, uses: 'most', leave_out: [] }]));
        const lore = await loreForReply({ scene, books: [harborAtlas], reviewEffort: 'low', ask: reviewAsk });
        expect(lore.reviewedPicks).toEqual([]);
        expect(lore.failures).toEqual([{ step: 'review', title: 'Tidewardens', detail: 'its answer could not be read' }]);
    });
});

describe('the toast for lore left out (D14)', () => {
    const tryAgain = 'Regenerate the message to try again.';

    it('says a failed pick sends none of the selected entries', () => {
        expect(leftOutLoreMessage([{ step: 'pick', detail: 'it did not answer within 30 seconds' }], 0)).toBe(
            `LoreBase could not pick the lore for this reply, so none of the entries selected for LoreBase go in. ${tryAgain} Details: it did not answer within 30 seconds`);
    });

    it("names a failed review's entry, and says whether the other picks go in", () => {
        expect(leftOutLoreMessage([{ step: 'review', title: 'Tidewardens', detail: 'its answer could not be read' }], 3)).toBe(
            `LoreBase could not review its pick "Tidewardens", so it is left out of this reply while the other picks go in. ${tryAgain} Details: its answer could not be read`);
        const both = [{ step: 'review', title: 'Tidewardens', detail: 'HTTP 429' }, { step: 'review', title: 'Fog Season', detail: 'HTTP 502' }];
        expect(leftOutLoreMessage(both, 2)).toBe(
            `LoreBase could not review 2 of its picks ("Tidewardens", "Fog Season"), so they are left out of this reply. ${tryAgain} Details: HTTP 429`);
    });

    it("keeps the provider's own error to 320 characters", () => {
        const message = leftOutLoreMessage([{ step: 'pick', detail: 'x'.repeat(400) }], 0);
        expect(message.endsWith(`Details: ${'x'.repeat(320)}`)).toBe(true);
    });
});
