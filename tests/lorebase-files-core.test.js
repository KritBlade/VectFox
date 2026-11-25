/**
 * LoreBase's files, the pure part (src/features/lorebase/lorebase-files-core.js, §3.3 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): a book's keys file, each title from SillyTavern's book or the one stored with
 * its keys, an entry with neither left out; a keys file's import matching by number and title together, selected or not;
 * a tenant's vectors file of one embedding model; a vectors file's import matching each point's hash, made again, to a
 * part of an entry selected or not, counting the unselected entries' parts, and embedding a selected entry's again when
 * the file's model is not the one set now; a damaged or another kind's file; the Database Browser's words for each; and
 * Remove from LoreBase's confirm and outcome, which the Database Browser and the WorldInfo page both show, Unlink's too,
 * each saying whether the book stays in SillyTavern or SillyTavern no longer has it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const files = await import('../src/features/lorebase/lorebase-files-core.js');
const core = await import('../src/features/lorebase/lorebase-vectors-core.js');
const { tenantPointId } = await import('../src/shared/point-ids.js');

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
        expect(plan.writes[0].point.id).toBe(tenantPointId(BOOK_ID, lighthousePart.hash));
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
        const listed = { selectedCount: 12, isLeftover: false };
        expect(files.describeDelete({ kind: 'keys', entryCount: 313, ...listed })).toEqual({
            lost: 'the keys of 313 entries, those edited by hand included',
            after: "Its selected entries send nothing where they are in use until Generate keys writes their keys again, at the cost of LoreBase's model. LoreBase stays on. Export them first to keep a copy.",
        });
        expect(files.describeDelete({ kind: 'vectors', pointCount: 504, isHere: true, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3', ...listed }).after)
            .toBe('Its selected entries send nothing where they are in use until Generate vectors writes their vectors again. LoreBase stays on. Export them first to keep a copy.');
        expect(files.describeDelete({ kind: 'vectors', pointCount: 50, isHere: false, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3', ...listed })).toEqual({
            lost: 'the vectors of 50 parts, made by custom/baai/bge-m3',
            after: 'LoreBase reads its vectors from another collection now, so it does not read these. Export them first to keep a copy.',
        });
    });

    it('says replies lose nothing when no entry of the book is in them: none selected, or a leftover', () => {
        const nothingInReplies = 'No entry of this lorebook takes part in replies now, so replies lose nothing. Export them first to keep a copy.';
        const noneSelected = { selectedCount: 0, isLeftover: false };
        const leftover = { selectedCount: 12, isLeftover: true };
        expect(files.describeDelete({ kind: 'keys', entryCount: 2, ...noneSelected }).after).toBe(nothingInReplies);
        expect(files.describeDelete({ kind: 'vectors', pointCount: 2, isHere: true, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3', ...noneSelected }).after)
            .toBe(nothingInReplies);
        expect(files.describeDelete({ kind: 'keys', entryCount: 2, ...leftover }).after).toBe(nothingInReplies);
        expect(files.describeDelete({ kind: 'vectors', pointCount: 2, isHere: true, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3', ...leftover }).after)
            .toBe(nothingInReplies);
    });
});

describe("Remove from LoreBase's words, the same on both pages, and Unlink's", () => {
    const TENANT = 'vf_lorebase_qdrant_rook_harbor_atlas_19qag9zxydm';
    const holdingsOf = fields => ({
        bookName: BOOK, selectionCount: 1, selectedCount: 313, pinnedCount: 2, chatLockCount: 1, characterLockCount: 0, keyCount: 313,
        tenants: [{ collection: 'vf_lorebase_rook', tenant: TENANT, pointCount: 504 }], ...fields,
    });
    const sentencesOf = lines => lines.flatMap(line => [line.text, line.name]).filter(Boolean);

    it('names each part of the book that goes, and that the lorebook stays in SillyTavern', () => {
        expect(sentencesOf(files.removalConfirmLines(holdingsOf()))).toEqual([
            'Remove ALL of this lorebook from LoreBase?',
            'Lorebook:', BOOK,
            'Selection:', '313 selected entries and 2 pinned sections',
            'Locked to:', '1 chat',
            'Keys:', 'the keys of 313 entries, those edited by hand included',
            'Vectors:', '504 parts',
            'The lorebook stays in SillyTavern, where every entry fires by its keys, as SillyTavern does. Export its keys and vectors '
                + 'in the Database Browser first to keep a copy.',
            'Remove deletes all of it. Cancel keeps it.',
        ]);
    });

    it("counts the collections a book's vectors are in, and offers no export for a book with nothing stored", () => {
        const spread = holdingsOf({ tenants: [
            { collection: 'vf_lorebase_rook', tenant: TENANT, pointCount: 504 }, { collection: 'vectfox_main', tenant: TENANT, pointCount: 30 },
        ] });
        expect(sentencesOf(files.removalConfirmLines(spread))).toContain('534 parts in 2 collections');

        const blank = holdingsOf({ selectedCount: 18, pinnedCount: 0, chatLockCount: 0, characterLockCount: 1, keyCount: 0, tenants: [] });
        expect(sentencesOf(files.removalConfirmLines(blank))).toEqual([
            'Remove ALL of this lorebook from LoreBase?',
            'Lorebook:', BOOK,
            'Selection:', '18 selected entries',
            'Locked to:', '1 character',
            'Keys:', 'none',
            'Vectors:', 'none',
            'The lorebook stays in SillyTavern, where every entry fires by its keys, as SillyTavern does.',
            'Remove deletes all of it. Cancel keeps it.',
        ]);
    });

    it('asks in red, as the whole book goes, and with one selection says nothing of deleting one', () => {
        const lines = files.removalConfirmLines(holdingsOf());
        expect(lines[0]).toEqual({ text: 'Remove ALL of this lorebook from LoreBase?', status: 'danger' });
        expect(lines.filter(line => line.status)).toEqual([lines[0]]);
    });

    it("counts a book's selections once it has more than one, with the entries and pins they hold and every lock on them, and says in green where one is deleted", () => {
        const several = holdingsOf({ selectionCount: 3, chatLockCount: 2, characterLockCount: 1 });
        const lines = files.removalConfirmLines(several);
        expect(lines[1]).toEqual({ text: 'To delete one selection only, use Choose entries on the WorldInfo page.', status: 'success' });
        expect(sentencesOf(lines).slice(4, 8))
            .toEqual(['Selections:', '3 selections, 313 selected entries, and 2 pinned sections', 'Locked to:', '2 chats and 1 character']);
    });

    it('names a record with nothing selected, and every lock it holds', () => {
        const unselected = holdingsOf({ selectedCount: 0, pinnedCount: 0, chatLockCount: 2, characterLockCount: 1 });
        expect(sentencesOf(files.removalConfirmLines(unselected)).slice(3, 7)).toEqual(['Selection:', 'none', 'Locked to:', '2 chats and 1 character']);
    });

    it("asks Unlink in red, saying unlinking deletes all of the book too, then names the chat's lists it is unlinked from, what goes, and what still loads it", () => {
        const question = 'Unlink this lorebook? Unlinking also deletes ALL of it from LoreBase: its vectors, keys, selections and locks.';
        const links = { unlinkedFrom: ['globalList', 'characterBooks', 'chatBook'], stillLoadedBy: ['personaBook'] };
        const lines = files.removalConfirmLines(holdingsOf({ selectionCount: 2 }), links);
        // Choose entries deletes one selection, which is no way to unlink, so Unlink offers no green line.
        expect(lines.filter(line => line.status)).toEqual([{ text: question, status: 'danger' }]);
        expect(sentencesOf(lines)).toEqual([
            question,
            'Lorebook:', BOOK,
            'Unlinked from:', "the global list every chat loads, this character's Additional Lorebooks, and this chat's Chat Lorebook",
            'Selections:', '2 selections, 313 selected entries, and 2 pinned sections',
            'Locked to:', '1 chat',
            'Keys:', 'the keys of 313 entries, those edited by hand included',
            'Vectors:', '504 parts',
            'The lorebook stays in SillyTavern. Export its keys and vectors in the Database Browser first to keep a copy.',
            "This chat still loads it through your persona's lorebook: take it out there in SillyTavern.",
            'Unlink deletes all of it. Cancel keeps it.',
        ]);
        expect(sentencesOf(files.removalConfirmLines(holdingsOf(), { unlinkedFrom: [], stillLoadedBy: ['characterOwnBook'] })).slice(3, 5))
            .toEqual(['Unlinked from:', 'none']);
    });

    it('says SillyTavern no longer has the book, in place of what stays there, as Unlink on an added book renamed or deleted there finds', () => {
        const links = { unlinkedFrom: ['addedChatBooks'], stillLoadedBy: [] };
        const missing = { isInSillyTavern: false };
        expect(sentencesOf(files.removalConfirmLines(holdingsOf(), links, missing))).toContain(
            'SillyTavern no longer has this lorebook. Export its keys and vectors in the Database Browser first to keep a copy.',
        );
        const blank = holdingsOf({ selectedCount: 0, pinnedCount: 0, keyCount: 0, tenants: [] });
        expect(sentencesOf(files.removalConfirmLines(blank, links, missing))).toEqual([
            'Unlink this lorebook? Unlinking also deletes ALL of it from LoreBase: its vectors, keys, selections and locks.',
            'Lorebook:', BOOK,
            'Unlinked from:', 'the lorebooks added to this chat',
            'Selection:', 'none',
            'Locked to:', '1 chat',
            'Keys:', 'none',
            'Vectors:', 'none',
            'SillyTavern no longer has this lorebook.',
            'Unlink deletes all of it. Cancel keeps it.',
        ]);
        expect(sentencesOf(files.removalConfirmLines(blank, null, missing))).toContain('SillyTavern no longer has this lorebook.');
    });

    it('says what was removed, each count with its unit, and with Unlink what the book was unlinked from first', () => {
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 313, partsDeleted: 504 }))
            .toBe('Removed "Harbor Atlas" from LoreBase, with the keys of 313 entries and the vectors of 504 parts.');
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 1, partsDeleted: 0 }))
            .toBe('Removed "Harbor Atlas" from LoreBase, with the keys of 1 entry.');
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 0, partsDeleted: 0 })).toBe('Removed "Harbor Atlas" from LoreBase.');
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 0, partsDeleted: 0, unlinkedFrom: ['characterBooks'], stillLoadedBy: [] }))
            .toBe('Unlinked "Harbor Atlas" from this character\'s Additional Lorebooks, and removed it from LoreBase.');
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 2, partsDeleted: 5, unlinkedFrom: ['chatBook'], stillLoadedBy: [] }))
            .toBe('Unlinked "Harbor Atlas" from this chat\'s Chat Lorebook, and removed it from LoreBase, with the keys of 2 entries and the '
                + 'vectors of 5 parts.');
        // A book added to the chat through LoreBase's Add to this chat (L1 of entity-lore.md).
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 0, partsDeleted: 0, unlinkedFrom: ['addedChatBooks'], stillLoadedBy: [] }))
            .toBe('Unlinked "Harbor Atlas" from the lorebooks added to this chat, and removed it from LoreBase.');
        expect(files.describeRemovedLoreBook({ bookName: BOOK, keysDeleted: 2, partsDeleted: 0, unlinkedFrom: [], stillLoadedBy: ['characterOwnBook'] }))
            .toBe('Removed "Harbor Atlas" from LoreBase, with the keys of 2 entries. This chat still loads it through the character\'s '
                + 'own lorebook: take it out there in SillyTavern.');
    });
});
