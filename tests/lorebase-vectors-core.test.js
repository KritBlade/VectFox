/**
 * LoreBase's vectors, the pure part (src/features/lorebase/lorebase-vectors-core.js, §4.1 to §4.5 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the account's Qdrant collection and each book's ID inside it
 * (Q6), one point per part with its entry's title before the part, hashes and point IDs that keep entries and books
 * apart, which entries have their vectors from the model set now, what brings a book in line with its selection,
 * insert batches of whole entries, and a reply's search: its two texts, each cut to its newest tokens, and the pool
 * the searches' points make, as segment_trials.py's rank_entries made it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const {
    PARTS_PER_SEAT, bookVectorWork, embeddingModelKey, entryPoints, hasCurrentVectors, hasOtherModelVectors, loreBaseAccountCollection, loreBaseBookCollectionId,
    newestWithin, pointBatches, pointHash, searchPool, searchTextsOf, storedPointsOf, uidsWithStoredVectors,
} = await import('../src/features/lorebase/lorebase-vectors-core.js');
const { tenantPointId } = await import('../src/shared/point-ids.js');

const BOOK_ID = loreBaseBookCollectionId('Harbor Atlas', 'rabbit');
const MODEL = embeddingModelKey('openrouter', 'baai/bge-m3');
const lighthouse = {
    uid: 3,
    comment: '[Harbor] Lighthouse of Vell',
    content: '[History]\nThe lighthouse was raised in the year of the long storm.\n[Keeper]\nKeeper Orrin trims the wick each dusk.',
};
const buoy = { uid: 4, comment: 'Buoy', content: 'A single red buoy marks the reef.' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const storedFrom = (points, model = MODEL) => new Map(points.map(point => [point.hash, { uid: point.uid, modelKey: model }]));
const decidedOf = entries => entries.map(entry => ({ uid: String(entry.uid), points: entryPoints(entry, BOOK_ID) }));

describe("an account's collection and a book's ID (Q6)", () => {
    it("names the account's own collection by its handle, an odd character a hyphen", () => {
        expect(loreBaseAccountCollection('rabbit')).toBe('vf_lorebase_rabbit');
        expect(loreBaseAccountCollection('default-user')).toBe('vf_lorebase_default-user');
        expect(loreBaseAccountCollection('Wren_Keeper')).toBe('vf_lorebase_wren-keeper');
    });

    it("names a book by its account, its cleaned name and a hash of the exact name, the same every time", () => {
        expect(BOOK_ID).toMatch(/^vf_lorebase_qdrant_rabbit_harbor_atlas_[0-9a-z]+$/);
        expect(loreBaseBookCollectionId('Harbor Atlas', 'rabbit')).toBe(BOOK_ID);
        expect(loreBaseBookCollectionId('Harbor Atlas', 'wren')).not.toBe(BOOK_ID);
    });

    it('tells apart names that clean to the same text, keeps CJK names, and names an all-symbol book "book"', () => {
        expect(loreBaseBookCollectionId('harbor-atlas', 'rabbit')).not.toBe(BOOK_ID);
        expect(loreBaseBookCollectionId('命定之诗', 'rabbit')).toMatch(/^vf_lorebase_qdrant_rabbit_命定之诗_[0-9a-z]+$/);
        expect(loreBaseBookCollectionId('★★★', 'rabbit')).toMatch(/^vf_lorebase_qdrant_rabbit_book_[0-9a-z]+$/);
    });
});

describe('points (§4.1)', () => {
    it("makes one point per part, its entry's title on the line before the part's text, numbered from 1", () => {
        const points = entryPoints(lighthouse, BOOK_ID);
        expect(points.map(({ text, uid, partNumber }) => ({ text, uid, partNumber }))).toEqual([
            { text: 'Lighthouse of Vell\n[History]\nThe lighthouse was raised in the year of the long storm.', uid: '3', partNumber: 1 },
            { text: 'Lighthouse of Vell\n[Keeper]\nKeeper Orrin trims the wick each dusk.', uid: '3', partNumber: 2 },
        ]);
        expect(points.every(point => point.hash === pointHash(3, point.text) && point.id === tenantPointId(BOOK_ID, point.hash))).toBe(true);
    });

    it("hashes a part with its entry's uid, as a whole number Qdrant keeps exactly", () => {
        const hash = pointHash(3, 'Lighthouse of Vell\nA beam over the reef.');
        expect(Number.isSafeInteger(hash) && hash >= 0).toBe(true);
        expect(pointHash(3, 'Lighthouse of Vell\nA beam over the reef.')).toBe(hash);
        expect(pointHash(4, 'Lighthouse of Vell\nA beam over the reef.')).not.toBe(hash);
    });

    it("gives each point a UUID from its book's ID and hash, so two books' same part never meet", () => {
        const hash = pointHash(3, 'Buoy\nA single red buoy marks the reef.');
        expect(tenantPointId(BOOK_ID, hash)).toMatch(UUID);
        expect(tenantPointId(BOOK_ID, hash)).toBe(tenantPointId(BOOK_ID, hash));
        expect(tenantPointId(loreBaseBookCollectionId('Desert Atlas', 'rabbit'), hash)).not.toBe(tenantPointId(BOOK_ID, hash));
    });

    it('reads what Qdrant holds by hash, with each entry and model, leaving out a point with no hash', () => {
        const stored = storedPointsOf([
            { hash: 12, metadata: { entryUid: '3', embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' } },
            { hash: '13', metadata: { entryUid: 4, embeddingSource: 'ollama', embeddingModel: '' } },
            { metadata: { type: '_vecthare_meta' } },
        ]);
        expect([...stored]).toEqual([[12, { uid: '3', modelKey: MODEL }], [13, { uid: '4', modelKey: embeddingModelKey('ollama', '') }]]);
    });
});

describe('ready vectors (§4.4)', () => {
    it("has an entry's vectors only when every part is stored by the model set now", () => {
        const points = entryPoints(lighthouse, BOOK_ID);
        expect(hasCurrentVectors(points, storedFrom(points), MODEL)).toBe(true);
        expect(hasCurrentVectors(points, storedFrom(points.slice(1)), MODEL)).toBe(false);
        expect(hasCurrentVectors(points, storedFrom(points, embeddingModelKey('ollama', 'nomic-embed-text')), MODEL)).toBe(false);
    });

    it('counts an entry with no part as having its vectors, so it never waits for them', () => {
        expect(hasCurrentVectors([], new Map(), MODEL)).toBe(true);
    });

    it("finds a part another embedding model made, but not a part edited since, nor one the model set now made (§7.1)", () => {
        const points = entryPoints(lighthouse, BOOK_ID);
        expect(hasOtherModelVectors(points, storedFrom(points, embeddingModelKey('ollama', 'nomic-embed-text')), MODEL)).toBe(true);
        expect(hasOtherModelVectors(points, storedFrom(points.slice(1)), MODEL)).toBe(false);
        expect(hasOtherModelVectors(points, storedFrom(points), MODEL)).toBe(false);
        expect(hasOtherModelVectors([], new Map(), MODEL)).toBe(false);
    });
});

describe("what brings a book's vectors in line (§4.3)", () => {
    it('writes the parts of the entries named that are not stored by the model set now, and nothing stored already', () => {
        const [history, keeper] = entryPoints(lighthouse, BOOK_ID);
        const work = bookVectorWork(decidedOf([lighthouse, buoy]), ['3', '4'], storedFrom([history]), MODEL);
        expect(work.points.map(point => point.text)).toEqual([keeper.text, entryPoints(buoy, BOOK_ID)[0].text]);
        expect(work.deleteHashes).toEqual([]);
    });

    it('writes again a part another model made, and leaves the entries not named to wait', () => {
        const points = entryPoints(lighthouse, BOOK_ID);
        const work = bookVectorWork(decidedOf([lighthouse, buoy]), ['3'], storedFrom(points, embeddingModelKey('ollama', 'nomic-embed-text')), MODEL);
        expect(work.points.map(point => point.partNumber)).toEqual([1, 2]);
        expect(work.points.every(point => point.uid === '3')).toBe(true);
    });

    it('deletes a part an edit removed and every point of an entry no longer decided, and nothing an entry still holds', () => {
        const edited = { ...lighthouse, content: '[History]\nThe lighthouse was raised in the year of the long storm.' };
        const before = entryPoints(lighthouse, BOOK_ID);
        const gone = entryPoints(buoy, BOOK_ID);
        const work = bookVectorWork(decidedOf([edited]), [], storedFrom([...before, ...gone]), MODEL);
        expect(work.points).toEqual([]);
        expect(work.deleteHashes.sort()).toEqual([before[1].hash, gone[0].hash].sort());
    });

    it('names the entries that had vectors, for an edit to write again', () => {
        const stored = storedFrom(entryPoints(buoy, BOOK_ID));
        expect(uidsWithStoredVectors(decidedOf([lighthouse, buoy]), stored)).toEqual(['4']);
    });
});

describe('insert batches', () => {
    const entryWith = (uid, pointCount) => ({ uid: String(uid), points: Array.from({ length: pointCount }, (_, index) => ({ hash: uid * 10 + index })) });

    it('fills each batch with whole entries up to the size, never splitting one', () => {
        const batches = pointBatches([entryWith(1, 2), entryWith(2, 2), entryWith(3, 1), entryWith(4, 3)], 5);
        expect(batches.map(batch => batch.map(entry => entry.uid))).toEqual([['1', '2', '3'], ['4']]);
    });

    it('puts an entry of more points than the size in a batch of its own', () => {
        const batches = pointBatches([entryWith(1, 1), entryWith(2, 7), entryWith(3, 1)], 5);
        expect(batches.map(batch => batch.map(entry => entry.uid))).toEqual([['1'], ['2'], ['3']]);
    });
});

describe("a reply's search texts", () => {
    it("searches the user's last message first, then the message before it, and one text for a scene of one message", () => {
        const messages = [{ name: 'Wren', text: 'Hello.' }, { name: 'Orrin', text: 'The lamp is lit.' }, { name: 'Wren', text: 'Who keeps it tonight?' }];
        expect(searchTextsOf(messages)).toEqual(['Who keeps it tonight?', 'The lamp is lit.']);
        expect(searchTextsOf([{ name: 'Wren', text: 'Who keeps it tonight?' }])).toEqual(['Who keeps it tonight?']);
    });

    it('keeps a text within the size whole, and cuts a longer one to its newest tokens within it', () => {
        const words = text => text.split(/\s+/).filter(Boolean).length;
        expect(newestWithin('  The lamp is lit.  ', 4, words)).toBe('The lamp is lit.');
        const long = Array.from({ length: 50 }, (_, index) => `word${index}`).join(' ');
        const cut = newestWithin(long, 10, words);
        expect(words(cut)).toBeLessThanOrEqual(10);
        expect(cut.endsWith('word49')).toBe(true);
        expect(newestWithin(long, Infinity, words)).toBe(long);
    });

    it('asks for four parts a seat, as the trials searched', () => {
        expect(PARTS_PER_SEAT).toBe(4);
    });
});

describe("a reply's pool", () => {
    const contents = [
        { number: 1, bookName: 'Harbor Atlas', uid: 3 },
        { number: 2, bookName: 'Harbor Atlas', uid: 4 },
        { number: 3, bookName: 'Wren Journal', uid: 3 },
        { number: 4, bookName: 'Wren Journal', uid: 9 },
    ];
    const point = (bookName, entryUid, score) => ({ score, metadata: { lorebookName: bookName, entryUid: String(entryUid) } });

    it("keeps each entry's best part of either search, the best entries first, then returns them in the table's order", () => {
        const searches = [
            [point('Wren Journal', 9, 0.9), point('Harbor Atlas', 3, 0.5), point('Wren Journal', 9, 0.4)],
            [point('Harbor Atlas', 4, 0.7), point('Harbor Atlas', 3, 0.8)],
        ];
        // Entry 4 at 0.9, entry 1 at 0.8 from the second search, entry 2 at 0.7.
        expect(searchPool(searches, contents, 2).map(item => item.number)).toEqual([1, 4]);
        expect(searchPool(searches, contents, 3).map(item => item.number)).toEqual([1, 2, 4]);
    });

    it('gives a tie to the earlier search, then to the table\'s order', () => {
        const searches = [[point('Wren Journal', 9, 0.5)], [point('Harbor Atlas', 4, 0.5), point('Harbor Atlas', 3, 0.5)]];
        expect(searchPool(searches, contents, 1).map(item => item.number)).toEqual([4]);
        expect(searchPool(searches, contents, 2).map(item => item.number)).toEqual([1, 4]);
    });

    it("counts no part of an entry the table does not hold: another book's, or one LoreBase does not decide now", () => {
        const searches = [[point('Old Pier', 3, 0.99), point('Harbor Atlas', 77, 0.95), point('Wren Journal', 3, 0.2)]];
        expect(searchPool(searches, contents, 100)).toEqual([contents[2]]);
        expect(searchPool([[], []], contents, 100)).toEqual([]);
    });
});
