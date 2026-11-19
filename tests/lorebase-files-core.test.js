/**
 * LoreBase's files, the pure part (src/features/lorebase/lorebase-files-core.js, §3.3 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md): a book's keys file, each title from SillyTavern's book or the one stored with
 * its keys, an entry with neither left out; a keys file's import matching by number and title together, selected or not;
 * a tenant's vectors file of one embedding model; a vectors file's import matching each point's hash, made again, to a
 * part of an entry selected or not, counting the unselected entries' parts, and embedding a selected entry's again when
 * the file's model is not the one set now; a damaged or another kind's file; and the Database Browser's words for each.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const files = await import('../src/features/lorebase/lorebase-files-core.js');
const core = await import('../src/features/lorebase/lorebase-vectors-core.js');

const HEADER = { version: '1.0.0', exportDate: '2026-11-19T08:00:00.000Z', generator: 'VectFox' };
const BOOK = 'Harbor Atlas';
const lighthouse = { uid: 0, comment: '[Harbor] Lighthouse', content: 'The lamp turns all night.' };
const pier = { uid: 3, comment: 'Pier', content: 'The old pier leans toward the tide.' };
const bell = { uid: 4, comment: '', content: 'A bell rings at low tide.' };
const MODEL = core.embeddingModelKey('openrouter', 'baai/bge-m3');

describe('a keys file', () => {
    it('opens with the header and holds each entry with keys, its title from SillyTavern now, or the stored one', () => {
        const exported = files.keysFileOf({
            book: BOOK, header: HEADER,
            keys: { 0: ['lamp'], 4: [], 7: ['gone'], 8: ['nameless'] },
            titles: { 0: 'An older title', 7: 'Old pier' },
            entries: [lighthouse, pier, bell],
        });
        expect(exported.file).toEqual({
            ...HEADER, type: files.LOREBASE_KEYS_FILE_TYPE, book: { name: BOOK },
            entries: [
                { uid: '0', title: 'Lighthouse', keys: ['lamp'] },
                { uid: '4', title: 'entry 4', keys: [] },
                { uid: '7', title: 'Old pier', keys: ['gone'] },
            ],
        });
        expect([exported.count, exported.leftOutCount]).toEqual([3, 1]);
    });

    it('takes every title from its stored keys when SillyTavern no longer has the book', () => {
        const exported = files.keysFileOf({ book: BOOK, header: HEADER, keys: { 0: ['lamp'], 3: ['pier'] }, titles: { 0: 'Lighthouse' }, entries: [] });
        expect(exported.file.entries).toEqual([{ uid: '0', title: 'Lighthouse', keys: ['lamp'] }]);
        expect(exported.leftOutCount).toBe(1);
    });

    it('imports onto the entries whose number and title both match, selected or not, and counts what replaces and what it skips', () => {
        const file = { type: files.LOREBASE_KEYS_FILE_TYPE, entries: [
            { uid: 0, title: 'Lighthouse', keys: ['beacon'] },
            { uid: '3', title: 'Pier', keys: [] },
            { uid: '4', title: 'Another book\'s bell', keys: ['bell'] },
            { uid: '9', title: 'Pier', keys: ['nowhere'] },
            { uid: '0', title: 'Lighthouse', keys: ['twice'] },
            { uid: '3', title: 'Pier', keys: ['x'.repeat(301)] },
            { uid: '', title: 'Nameless', keys: ['a'] },
            null,
        ] };
        const plan = files.planKeysImport(file, { entries: [lighthouse, pier, bell], storedKeys: { 0: ['lamp'] } });
        expect(plan).toEqual({
            writes: [{ uid: '0', title: 'Lighthouse', keys: ['beacon'] }, { uid: '3', title: 'Pier', keys: [] }],
            replaceCount: 1, unmatchedCount: 2, damagedCount: 4,
        });
    });

    it('refuses a file that is not a keys file', () => {
        expect(() => files.planKeysImport({ type: files.LOREBASE_VECTORS_FILE_TYPE, points: [] }, { entries: [], storedKeys: {} }))
            .toThrow("This is not a LoreBase keys file. Export on a lorebook's keys row in the Database Browser makes one.");
        expect(() => files.planKeysImport({ type: files.LOREBASE_KEYS_FILE_TYPE }, { entries: [], storedKeys: {} })).toThrow('This is not a LoreBase keys file.');
    });
});

describe('a vectors file', () => {
    const point = (hash, uid, source, vector = [0.1, 0.2]) => ({
        hash, text: `part ${hash}`, vector, metadata: { entryUid: uid, partNumber: 0, embeddingSource: source, embeddingModel: 'baai/bge-m3' },
    });

    it("holds the points of the model most of them were made by, with that model's source, name and vector size", () => {
        const exported = files.vectorsFileOf({
            book: BOOK, header: HEADER,
            points: [point(1, '0', 'openrouter'), point(2, '0', 'openrouter'), point(3, '3', 'custom'), point(4, '3', 'openrouter', null)],
        });
        expect(exported.file).toEqual({
            ...HEADER, type: files.LOREBASE_VECTORS_FILE_TYPE, book: { name: BOOK },
            embedding: { source: 'openrouter', model: 'baai/bge-m3', dimension: 2 },
            points: [
                { hash: 1, uid: '0', partNumber: 0, text: 'part 1', vector: [0.1, 0.2] },
                { hash: 2, uid: '0', partNumber: 0, text: 'part 2', vector: [0.1, 0.2] },
            ],
        });
        expect([exported.count, exported.leftOutCount]).toEqual([2, 2]);
    });

    const BOOK_ID = core.loreBaseBookCollectionId(BOOK, 'rabbit');
    // Both entries LoreBase would decide; only the lighthouse is selected.
    const candidates = [lighthouse, pier].map(entry => ({ uid: String(entry.uid), points: core.entryPoints(entry, BOOK_ID) }));
    const selectedUids = new Set(['0']);
    const [lighthousePart] = candidates[0].points;
    const [pierPart] = candidates[1].points;
    const fileOf = (points, source = 'openrouter') => ({ type: files.LOREBASE_VECTORS_FILE_TYPE, embedding: { source, model: 'baai/bge-m3', dimension: 2 }, points });

    it("imports each point whose hash, made again from its uid and text, is a part of an entry here, selected or not, under this book's point ID", () => {
        const plan = files.planVectorsImport(fileOf([
            { uid: '0', partNumber: 0, text: lighthousePart.text, vector: [0.1, 0.2], hash: 1 },
            { uid: '3', partNumber: 0, text: pierPart.text, vector: [0.3, 0.4] },
            { uid: '3', partNumber: 0, text: 'A part this book does not have.', vector: [0.5, 0.6] },
            { uid: '0', partNumber: 0, text: lighthousePart.text, vector: [0.7, 0.8] },
            { uid: '0', partNumber: 0, text: lighthousePart.text, vector: [0.1, 0.2, 0.3] },
            { uid: '3', partNumber: 0, text: pierPart.text, vector: [0.1, Number.NaN] },
        ]), { candidates, selectedUids, stored: new Map([[lighthousePart.hash, { uid: '0', modelKey: MODEL }]]), modelKey: MODEL });
        expect(plan.writes).toEqual([{ point: lighthousePart, vector: [0.1, 0.2] }, { point: pierPart, vector: [0.3, 0.4] }]);
        expect(plan.writes[0].point.id).toBe(core.pointId(BOOK_ID, lighthousePart.hash));
        expect([plan.uids, plan.replaceCount, plan.unselectedCount, plan.unmatchedCount, plan.damagedCount, plan.needsEmbedding])
            .toEqual([['0', '3'], 1, 1, 1, 3, false]);
    });

    it("embeds a selected entry's matched parts again when the file was made by another model, and skips an unselected entry's", () => {
        const plan = files.planVectorsImport(fileOf([
            { uid: '3', partNumber: 0, text: pierPart.text, vector: [0.3, 0.4] },
            { uid: '0', partNumber: 0, text: lighthousePart.text, vector: [0.1, 0.2] },
        ], 'custom'), { candidates, selectedUids, stored: new Map(), modelKey: MODEL });
        expect([plan.uids, plan.unselectedCount, plan.needsEmbedding, plan.embedding])
            .toEqual([['0'], 1, true, { source: 'custom', model: 'baai/bge-m3', dimension: 2 }]);
    });

    it('refuses a file that is not a vectors file', () => {
        expect(() => files.planVectorsImport({ type: files.LOREBASE_KEYS_FILE_TYPE, entries: [] }, { candidates, selectedUids, stored: new Map(), modelKey: MODEL }))
            .toThrow("This is not a LoreBase vectors file. Export on a lorebook's vectors row in the Database Browser makes one.");
    });
});

describe("the Database Browser's words", () => {
    it('says what an export holds and what it left out', () => {
        expect(files.describeExport('keys', { count: 1, leftOutCount: 0 })).toBe('Exported the keys of 1 entry');
        expect(files.describeExport('keys', { count: 311, leftOutCount: 1 }))
            .toBe('Exported the keys of 311 entries; 1 entry was left out, as neither SillyTavern nor the stored keys name its title');
        expect(files.describeExport('vectors', { count: 504, leftOutCount: 3 }))
            .toBe('Exported the vectors of 504 parts; 3 parts were left out, made by another embedding model or holding no vector');
    });

    it('says what an import writes, replaces and skips, and whether its vectors go in or are embedded again', () => {
        expect(files.describeImport('keys', { writes: [{}, {}], replaceCount: 0, unmatchedCount: 0, damagedCount: 1 })).toEqual([
            'It writes the keys of 2 entries.',
            'It skips 1 entry the file holds damaged or twice.',
        ]);
        const vectors = {
            writes: [{}, {}, {}], uids: ['0', '3'], replaceCount: 1, unselectedCount: 0, unmatchedCount: 2, damagedCount: 0,
            embedding: { source: 'custom', model: 'baai/bge-m3' },
        };
        expect(files.describeImport('vectors', { ...vectors, needsEmbedding: false })).toEqual([
            'It writes the vectors of 3 parts of 2 entries, 1 of them replacing a part this lorebook has.',
            'It skips 2 parts that are no part of an entry here now.',
            "The file's vectors were made by custom/baai/bge-m3, the model set now, so they go in as they are, with no embedding call.",
        ]);
        expect(files.describeImport('vectors', { ...vectors, needsEmbedding: true }, { source: 'openrouter', model: 'baai/bge-m3' })[2])
            .toBe("The file's vectors were made by custom/baai/bge-m3 and yours by openrouter/baai/bge-m3, so the parts are embedded again with yours,"
                + ' as Generate vectors embeds them. To use the saved vectors, switch to custom/baai/bge-m3 first.');
    });

    it("says that an unselected entry's parts are erased on the next write, or skipped when they would be embedded again", () => {
        const vectors = { writes: [{}, {}], uids: ['0', '3'], replaceCount: 0, unmatchedCount: 0, damagedCount: 0, embedding: { source: 'custom', model: 'baai/bge-m3' } };
        expect(files.describeImport('vectors', { ...vectors, unselectedCount: 1, needsEmbedding: false })[1])
            .toBe("1 of them belongs to an entry not selected, so the next write of this lorebook's vectors erases it unless you select that entry first.");
        expect(files.describeImport('vectors', { ...vectors, unselectedCount: 2, needsEmbedding: false })[1])
            .toBe("2 of them belong to entries not selected, so the next write of this lorebook's vectors erases them unless you select those entries first.");
        expect(files.describeImport('vectors', { ...vectors, unselectedCount: 3, unmatchedCount: 1, needsEmbedding: true }, { source: 'openrouter', model: 'baai/bge-m3' })[1])
            .toBe("It skips 3 parts of entries not selected, as only a selected entry's parts are embedded again, and 1 part that is no part of an entry here now.");
        expect(files.nothingToImportText('vectors', { ...vectors, writes: [], unselectedCount: 2, needsEmbedding: true }, BOOK))
            .toBe("This file's vectors were made by another embedding model, and the parts of Harbor Atlas it matches belong to entries not selected,"
                + ' so nothing was embedded again. Select those entries first, or switch to the model the file names.');
        expect(files.nothingToImportText('vectors', { ...vectors, writes: [], unselectedCount: 0, unmatchedCount: 3, needsEmbedding: false }, BOOK))
            .toBe("None of this file's 3 parts is a part of an entry of Harbor Atlas now, so nothing was written.");
    });

    it('says what an import wrote, and why one wrote nothing', () => {
        expect(files.describeImported('keys', { written: 2, failed: 0, isEmbedded: false }, BOOK)).toBe('Imported the keys of 2 entries into Harbor Atlas');
        expect(files.describeImported('vectors', { written: 1, failed: 1, isEmbedded: true }, BOOK))
            .toBe('Imported the vectors of 1 entry, embedded again with your model, into Harbor Atlas; 1 entry was not written, as the other toast says');
        expect(files.nothingToImportText('keys', { writes: [], unmatchedCount: 4, damagedCount: 1 }, BOOK))
            .toBe("None of this file's 5 entries matches an entry of Harbor Atlas by number and title, so nothing was written.");
    });

    it('says what a delete loses, and what follows for the entries, LoreBase staying on', () => {
        expect(files.describeDelete({ kind: 'keys', entryCount: 313 })).toEqual({
            lost: 'the keys of 313 entries, those edited by hand included',
            after: "Its selected entries leave replies until Generate keys writes their keys again, at the cost of LoreBase's model. LoreBase stays on. Export them first to keep a copy.",
        });
        expect(files.describeDelete({ kind: 'vectors', pointCount: 50, isHere: false, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' })).toEqual({
            lost: 'the vectors of 50 parts, made by custom/baai/bge-m3',
            after: 'LoreBase reads its vectors from another collection now, so it does not read these. Export them first to keep a copy.',
        });
    });
});
