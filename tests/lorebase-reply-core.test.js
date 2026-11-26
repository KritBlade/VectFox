/**
 * LoreBase on a reply, the pure rules (src/features/lorebase/lorebase-reply-core.js, plan §5.6, §5.8 and D8 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): which generations get a pick, the books
 * taking part and the entries LoreBase decides in them, the pick with each entry's keys and one review per pick of more
 * than one part sent at once as the route trials sent them, a one-part or template-code pick sent whole with no review
 * (T20), what a failed call leaves out (D14), and the toast that says so; when a reply says it leaves out selected
 * entries that have no keys (D17): once per chat, and again when the books or their counts change; and the choice a
 * lorebase_accuracy value runs (plan §2 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { pickMessages, tableOfContents } from '../src/features/lorebase/lorebase-pick-core.js';
import {
    SENT_WHOLE_UNREVIEWED, activeBookNames, decidedEntries, isReplyGeneration, loreBaseAccuracyOf, loreForReply, leftOutLoreMessage,
    unreadyEntriesNotice,
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

    // LoreBase adds them to the scan after SillyTavern loaded its own (L1 of InternalProject/Vectfox/plans/entity-lore.md).
    it("lists the books added to the chat through LoreBase last, each once, and one SillyTavern loads already where SillyTavern loads it", () => {
        expect(activeBookNames({
            globalBooks: ['Harbor Atlas'], characterBooks: ['Keeper Notes'], chatBook: 'Voyage Log', personaBook: null,
            addedBooks: ['Coral Index', 'Harbor Atlas', 'Reef Charts', 'Coral Index'],
        })).toEqual(['Harbor Atlas', 'Keeper Notes', 'Voyage Log', 'Coral Index', 'Reef Charts']);
    });
});

describe('the entries LoreBase decides', () => {
    const book = {
        entries: {
            0: { uid: 0, comment: 'Lighthouse of Vell', content: 'Orrin keeps the lamp.' },
            1: { uid: 1, comment: 'Tidewardens', content: 'They read the bells.' },
            2: { uid: 2, comment: 'Old Pier', content: 'Rotten boards.', disable: true },
            3: { uid: 3, comment: 'Harbor Bell', content: 'The bell.', constant: true },
            4: { uid: 4, comment: 'Storm Watch', content: 'A watch.', sticky: 2 },
            5: { uid: 5, comment: 'Fog Season', content: 'Fog in spring.', cooldown: 3 },
            6: { uid: 6, comment: 'Net Market', content: 'Nets for sale.', sticky: 0, cooldown: null },
            7: { uid: 7, comment: 'Buoy Line' },
            8: { uid: 8, comment: 'Salt Flats', content: ' \n ' },
            9: { uid: 9, comment: 'Lamp Oil', content: '@@activate\nOil for the lamp.' },
            10: { uid: 10, comment: 'Wreck Map', content: '@@if wren_is_here\n@@dont_activate\nThe wreck lies north.' },
            11: { uid: 11, comment: 'Gull Roost', content: '@@if wren_is_here\nGulls roost on the roof.\n@@activate' },
        },
    };

    it("keeps the selected entries in the book's order, and leaves SillyTavern its disabled, constant, sticky and cooldown ones", () => {
        expect(decidedEntries(book, { selectedUids: ['6', '0', '2', '3', '4', '5'] }).map(entry => entry.uid)).toEqual([0, 6]);
    });

    it('never decides a selected entry with no text, which has nothing to key, pick or send', () => {
        expect(decidedEntries(book, { selectedUids: ['7', '1', '8'] }).map(entry => entry.uid)).toEqual([1]);
    });

    it('leaves SillyTavern an entry an @@activate or @@dont_activate line opens, which its scan reads before the keys', () => {
        expect(decidedEntries(book, { selectedUids: ['9', '10', '11'] }).map(entry => entry.uid)).toEqual([11]);
    });

    it('decides nothing in a book with no selection, or one SillyTavern could not load', () => {
        expect(decidedEntries(book, { selectedUids: [] })).toEqual([]);
        expect(decidedEntries(book, null)).toEqual([]);
        expect(decidedEntries(null, { selectedUids: ['0'] })).toEqual([]);
    });
});

describe('the choice a lorebase_accuracy value runs', () => {
    it('is Fast and Cheap [Jev] on fast, and High Accuracy on high and on any value the dropdown no longer offers', () => {
        expect(['fast', 'high', 'default', undefined].map(loreBaseAccuracyOf)).toEqual(['fast', 'high', 'high', 'high']);
    });
});

describe("a reply's pick and reviews", () => {
    const scene = 'Wren: Who keeps the lamp at Vell tonight?';
    const lighthouse = { uid: 0, comment: 'Lighthouse of Vell', content: '[Overview]\nThe lighthouse stands on the north cliff of Vell.\n[Keepers]\nKeeper Orrin tends the lamp each night.\n[History]\nIt was raised after the long storm.' };
    const tidewardens = { uid: 1, comment: 'Tidewardens', content: '[Duties]\nThe tidewardens read the harbor bells.\n[Ranks]\nA warden rises by the bells they read.' };
    const fogSeason = { uid: 4, comment: 'Fog Season', content: '[Season]\nFog closes the strait for a month each spring.\n[Crossings]\nFerries wait at the pier until it lifts.' };
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
        const running = loreForReply({ scene, books, ask, pickLimit: 6 });
        // Both reviews are asked before either answers.
        await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
        releaseReviews();
        const lore = await running;

        const contents = tableOfContents(books);
        expect(ask.mock.calls[0]).toEqual([pickMessages(scene, contents, 6), { maxTokens: 9500, reasoningEffort: 'low', identKeys: ['number'], onUsage: expect.any(Function) }]);
        const review = { maxTokens: 10000, reasoningEffort: 'low', identKeys: ['entry'] };
        expect(ask.mock.calls[1]).toEqual([reviewMessages(scene, { title: 'Fog Season', why: 'fog decides the crossing', needs: 'needs 3' }, entryPassages(fogSeason).passages), review]);
        expect(ask.mock.calls[2]).toEqual([reviewMessages(scene, { title: 'Lighthouse of Vell', why: 'the keeper is asked after', needs: 'needs 1' }, entryPassages(lighthouse).passages), review]);

        expect(entryPassages(lighthouse).passages).toHaveLength(3);
        expect(lore.contentCount).toBe(3);
        expect(lore.picks.map(pick => pick.title)).toEqual(['Fog Season', 'Lighthouse of Vell']);
        expect(lore.reviewedPicks.map(({ bookName, uid, uses, sentParts }) => ({ bookName, uid, uses, sentParts }))).toEqual([
            { bookName: 'Wren Journal', uid: 4, uses: 'some', sentParts: [1, 2] },
            { bookName: 'Harbor Atlas', uid: 0, uses: 'some', sentParts: [1, 2] },
        ]);
        expect(lore.failures).toEqual([]);
    });

    it("keeps a pinned section's parts whatever the review leaves out, and sends nothing of an entry the reply uses none of", async () => {
        const historySection = entryPassages(lighthouse).passages[2].section;
        const pinned = { ...harborAtlas, pinnedSections: [historySection] };
        const ask = vi.fn(async (messages, request) => {
            if (isPick(request)) return [pickItem(1), pickItem(2)];
            return messages[1].content.includes('Entry 1: Lighthouse of Vell') ? [{ entry: 1, uses: 'some', leave_out: [2, 3] }] : [{ entry: 1, uses: 'none', leave_out: [] }];
        });
        const lore = await loreForReply({ scene, books: [pinned], ask, pickLimit: 6 });
        expect(lore.reviewedPicks.map(({ title, sentParts }) => ({ title, sentParts }))).toEqual([
            { title: 'Lighthouse of Vell', sentParts: [1, 3] },
            { title: 'Tidewardens', sentParts: [] },
        ]);
        expect(lore.failures).toEqual([]);
    });

    it('sends a one-part pick and one with template code whole, with no review, as T20 sent them', async () => {
        const ferryTolls = { uid: 5, comment: 'Ferry Tolls', content: 'The ferry costs two copper bits a head.' };
        const tideTable = { uid: 6, comment: 'Tide Table', content: '[High]\n<% if (tide) { %>The tide is high.<% } %>\n[Low]\nThe flats show at low tide.' };
        const book = { bookName: 'Harbor Atlas', entries: [ferryTolls, tideTable, tidewardens], pinnedSections: [] };
        const ask = vi.fn(async (_messages, request) => (isPick(request) ? [pickItem(1), pickItem(2), pickItem(3)] : [{ entry: 1, uses: 'most', leave_out: [2] }]));
        const lore = await loreForReply({ scene, books: [book], ask, pickLimit: 6 });

        expect(entryPassages(ferryTolls).passages).toHaveLength(1);
        expect(entryPassages(tideTable).passages.length).toBeGreaterThan(1);
        // The pick, and one review: Tidewardens'.
        expect(ask).toHaveBeenCalledTimes(2);
        expect(ask.mock.calls[1][0][1].content).toContain('Entry 1: Tidewardens');
        expect(lore.reviewedPicks.map(({ title, uses, sentParts, seconds }) => ({ title, uses, sentParts, seconds }))).toEqual([
            { title: 'Ferry Tolls', uses: SENT_WHOLE_UNREVIEWED, sentParts: [1], seconds: null },
            { title: 'Tide Table', uses: SENT_WHOLE_UNREVIEWED, sentParts: entryPassages(tideTable).passages.map((_, index) => index + 1), seconds: null },
            { title: 'Tidewardens', uses: 'most', sentParts: [1], seconds: expect.any(Number) },
        ]);
    });

    it("shows each entry's keys after its title in the pick's table, which ends its system prompt", async () => {
        const keyed = { ...harborAtlas, keysByUid: { 0: ['lighthouse', 'Keeper Orrin'], 1: ['tidewardens', 'harbor bells'] } };
        const ask = vi.fn(async () => []);
        await loreForReply({ scene, books: [keyed], ask, pickLimit: 6 });
        expect(ask.mock.calls[0][0][0].content.endsWith('\n\n1. Lighthouse of Vell (lighthouse, Keeper Orrin)\n2. Tidewardens (tidewardens, harbor bells)')).toBe(true);
    });

    it('asks the pick for at most the Pick limit, and reviews only the picks within it', async () => {
        const ask = vi.fn(async (_messages, request) => (isPick(request) ? [pickItem(2), pickItem(1), pickItem(3)] : [{ entry: 1, uses: 'most', leave_out: [] }]));
        const lore = await loreForReply({ scene, books: [harborAtlas, wrenJournal], ask, pickLimit: 1 });
        expect(ask.mock.calls[0][0]).toEqual(pickMessages(scene, tableOfContents([harborAtlas, wrenJournal]), 1));
        expect(ask.mock.calls[0][0][1].content).toContain('most needed first, at most 1.');
        expect(lore.picks.map(pick => pick.title)).toEqual(['Tidewardens']);
        expect(ask).toHaveBeenCalledTimes(2);
        expect(ask.mock.calls[1][0][1].content).toContain('Entry 1: Tidewardens');
    });

    it('asks no review when the pick names none', async () => {
        const ask = vi.fn(async () => []);
        const lore = await loreForReply({ scene, books: [harborAtlas], ask, pickLimit: 6 });
        expect(ask).toHaveBeenCalledTimes(1);
        expect(lore).toMatchObject({ picks: [], reviewedPicks: [], failures: [] });
    });

    it('times the pick, and each review on its own, for the tester (§5.10)', async () => {
        const ask = vi.fn(async (_messages, request) => {
            await new Promise(resolve => { setTimeout(resolve, isPick(request) ? 40 : 10); });
            return isPick(request) ? [pickItem(1), pickItem(2)] : [{ entry: 1, uses: 'most', leave_out: [] }];
        });
        const lore = await loreForReply({ scene, books: [harborAtlas], ask, pickLimit: 6 });
        expect(lore.pickSeconds).toBeGreaterThanOrEqual(0.03);
        expect(lore.reviewedPicks.map(reviewed => reviewed.seconds)).toEqual([expect.any(Number), expect.any(Number)]);
        for (const reviewed of lore.reviewedPicks) expect(reviewed.seconds).toBeGreaterThanOrEqual(0.005);
    });

    it('leaves every selected entry out when the pick fails, and asks no review', async () => {
        const error = timeout();
        const ask = vi.fn(async () => { throw error; });
        const lore = await loreForReply({ scene, books: [harborAtlas], ask, pickLimit: 6 });
        expect(ask).toHaveBeenCalledTimes(1);
        expect(lore).toEqual({
            contentCount: 2, picks: [], unreadItemCount: 0, pickSeconds: expect.any(Number), pickTokens: null, reviewedPicks: [],
            failures: [{ step: 'pick', detail: 'it did not answer within 30 seconds', error }],
        });
    });

    it("keeps the pick's prompt tokens and those its provider read from the cache, as the call reported them (§7.5)", async () => {
        const reported = async (usage, items) => {
            const ask = vi.fn(async (_messages, request) => {
                request.onUsage?.(usage);
                return items;
            });
            return (await loreForReply({ scene, books: [harborAtlas], ask, pickLimit: 6 })).pickTokens;
        };
        expect(await reported({ prompt_tokens: 15070, cached_tokens: 10141 }, [])).toEqual({ prompt: 15070, cached: 10141 });
        expect(await reported({ prompt_tokens: 15070, cached_tokens: null }, [])).toEqual({ prompt: 15070, cached: null });
        expect(await reported(null, [])).toBeNull();
    });

    it('leaves out only the entry whose review failed, and the other picks go in', async () => {
        const error = Object.assign(new Error('LoreBase: OpenRouter HTTP 429: Too Many Requests'), { kind: 'http' });
        const ask = vi.fn(async (messages, request) => {
            if (isPick(request)) return [pickItem(1), pickItem(2)];
            if (messages[1].content.includes('Entry 1: Lighthouse of Vell')) throw error;
            return [{ entry: 1, uses: 'most', leave_out: [] }];
        });
        const lore = await loreForReply({ scene, books: [harborAtlas], ask, pickLimit: 6 });
        expect(lore.reviewedPicks.map(({ title, sentParts }) => ({ title, sentParts }))).toEqual([{ title: 'Tidewardens', sentParts: [1, 2] }]);
        expect(lore.failures).toEqual([{
            step: 'review', bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', detail: 'LoreBase: OpenRouter HTTP 429: Too Many Requests', error,
            seconds: expect.any(Number),
        }]);
    });

    it('fails a call whose answer cannot be read: a pick with no entries in it, or a review with no amount for entry 1', async () => {
        const unreadable = Object.assign(new Error('Unable to find record array in LoreBase response.'), { kind: 'parse' });
        const pickAsk = vi.fn(async () => { throw unreadable; });
        expect((await loreForReply({ scene, books: [harborAtlas], ask: pickAsk, pickLimit: 6 })).failures)
            .toEqual([{ step: 'pick', detail: 'its answer could not be read', error: unreadable }]);

        const reviewAsk = vi.fn(async (_messages, request) => (isPick(request) ? [pickItem(2)] : [{ entry: 2, uses: 'most', leave_out: [] }]));
        const lore = await loreForReply({ scene, books: [harborAtlas], ask: reviewAsk, pickLimit: 6 });
        expect(lore.reviewedPicks).toEqual([]);
        expect(lore.failures).toEqual([{ step: 'review', bookName: 'Harbor Atlas', uid: 1, title: 'Tidewardens', detail: 'its answer could not be read', seconds: expect.any(Number) }]);
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

describe('the toast for selected entries not ready (D17, §4.4 of lorebook-multi-vector.md)', () => {
    const harbor = [{ bookName: 'Harbor Atlas', count: 21 }];

    it('says how many entries of which lorebook have no keys or vectors yet, that every reply leaves them out, and what writes them', () => {
        expect(unreadyEntriesNotice(null, 'chat-harbor', harbor).message).toBe('21 selected entries of the lorebook "Harbor Atlas" have no keys '
            + "or vectors yet, so LoreBase leaves them out of every reply. Generate all on VectFox's WorldInfo page writes what they lack.");
        expect(unreadyEntriesNotice(null, 'chat-harbor', [{ bookName: 'Harbor Atlas', count: 1 }]).message).toBe('1 selected entry of the lorebook '
            + "\"Harbor Atlas\" has no keys or vectors yet, so LoreBase leaves it out of every reply. Generate all on VectFox's WorldInfo page writes "
            + 'what it lacks.');
        expect(unreadyEntriesNotice(null, 'chat-harbor', [...harbor, { bookName: 'Keeper Notes', count: 2 }]).message).toBe('23 selected entries in 2 '
            + 'lorebooks ("Harbor Atlas", "Keeper Notes") have no keys or vectors yet, so LoreBase leaves them out of every reply. Generate all on '
            + "VectFox's WorldInfo page writes what they lack.");
    });

    it('shows once per chat, and again when the books or their counts change or another chat opens', () => {
        const first = unreadyEntriesNotice(null, 'chat-harbor', harbor);
        const same = unreadyEntriesNotice(first.notice, 'chat-harbor', harbor);
        expect(same.message).toBeNull();
        expect(unreadyEntriesNotice(same.notice, 'chat-harbor', [{ bookName: 'Harbor Atlas', count: 20 }]).message).toContain('20 selected entries');
        expect(unreadyEntriesNotice(same.notice, 'chat-harbor', [{ bookName: 'Keeper Notes', count: 21 }]).message).toContain('"Keeper Notes"');
        expect(unreadyEntriesNotice(same.notice, 'chat-voyage', harbor).message).toContain('21 selected entries');
    });

    it('shows nothing when every entry is ready, and says it again once entries lose their keys or vectors after that', () => {
        const shown = unreadyEntriesNotice(null, 'chat-harbor', harbor);
        const allReady = unreadyEntriesNotice(shown.notice, 'chat-harbor', []);
        expect(allReady.message).toBeNull();
        expect(unreadyEntriesNotice(allReady.notice, 'chat-harbor', harbor).message).toContain('21 selected entries');
    });
});
