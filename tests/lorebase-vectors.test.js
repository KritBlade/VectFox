/**
 * LoreBase's vectors in Qdrant (src/features/lorebase/lorebase-vectors.js, §4.2 to §4.4 of InternalProject/Vectfox/
 * plans/executed/lorebook-multi-vector.md): every book of an account a tenant inside vectfox_main while "One shared collection"
 * is on and inside the account's own collection while it is off (Q6); what Qdrant holds read once a session and kept
 * current by what is written and deleted; writes in batches of whole entries, stored before the stale points are
 * deleted; a wrong embedding setup fails the rest of a run at once; a stop leaves the batches not yet sent; the points
 * of entries no longer selected deleted; Delete all; what the session knew of one book's vectors and failures
 * forgotten once Remove from LoreBase deletes them; an edit SillyTavern saves written again in the background; and,
 * for the Database Browser's rows, a book tenant read whole with its dense vectors in the collection named, a vectors
 * file's points stored with their vectors, and a tenant deleted; a reply's search, both texts over every book taking
 * part in the collection LoreBase reads now. The vector API is a stand-in holding points in memory, routed by the real
 * qdrantTarget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oneSelectionRecord } from './lorebase-book-record.js';

const host = vi.hoisted(() => ({
    handle: 'rabbit',
    settings: { vectfox: {} },
    books: {},
    handlers: {},
    qdrant: new Map(),
    calls: [],
    insertFailure: null,
    isPurgeRefused: false,
    searchAnswer: null,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/user.js', () => ({ getCurrentUserHandle: () => host.handle }));
vi.mock('../src/sillytavern/vector-storage.js', () => ({ isVectorStorageWorldInfoOn: () => false }));
vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: (event, handler) => { host.handlers[event] = handler; } },
    event_types: { WORLDINFO_UPDATED: 'worldinfo_updated' },
}));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: async bookName => host.books[bookName] }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
vi.mock('../src/features/embedding/index.js', () => ({
    getModelFromSettings: settings => settings.embedding_model ?? 'baai/bge-m3',
    // A piece size of 8 words, so a long message is cut to its newest words.
    searchPieceTokensOf: () => 8,
    searchTokens: text => text.split(/\s+/).filter(Boolean).length,
}));
vi.mock('../src/features/vector-backend/index.js', async () => {
    const { MULTITENANCY_COLLECTION, qdrantTarget } = await import('../src/features/vector-backend/qdrant-target.js');
    const pointsAt = target => {
        const key = `${target.collectionId}|${target.filters.content_type ?? ''}`;
        if (!host.qdrant.has(key)) host.qdrant.set(key, new Map());
        return host.qdrant.get(key);
    };
    return {
        MULTITENANCY_COLLECTION,
        insertVectorItems: vi.fn(async (collectionId, items, settings) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'insert', target, hashes: items.map(item => item.hash) });
            const failure = host.insertFailure?.(items);
            if (failure) throw failure;
            for (const item of items) {
                pointsAt(target).set(item.hash, {
                    id: item.id, text: item.text, entryUid: item.metadata.entryUid, partNumber: item.metadata.partNumber, vector: item.vector,
                    embeddingSource: settings.embedding_provider || 'transformers', embeddingModel: settings.embedding_model ?? 'baai/bge-m3',
                });
            }
        }),
        listChunks: vi.fn(async (collectionId, settings, options) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'list', target, limit: options.limit, includeVectors: Boolean(options.includeVectors) });
            return {
                items: [...pointsAt(target)].map(([hash, point]) => ({ hash, text: point.text, metadata: point, vector: options.includeVectors ? point.vector : undefined })),
            };
        }),
        deleteVectorItems: vi.fn(async (collectionId, hashes, settings) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'delete', target, hashes });
            for (const hash of hashes) pointsAt(target).delete(hash);
        }),
        purgeVectorIndex: vi.fn(async (collectionId, settings) => {
            host.calls.push({ action: 'purge', target: qdrantTarget(collectionId, settings), isShared: Boolean(settings.qdrant_multitenancy) });
            return !host.isPurgeRefused;
        }),
        searchCollectionsTogether: vi.fn(async (collectionIds, texts, topK, settings) => {
            host.calls.push({ action: 'search', collectionIds, texts, topK, collection: qdrantTarget(collectionIds[0], settings).collectionId });
            return host.searchAnswer ?? texts.map(() => []);
        }),
    };
});

const BOOK = 'Harbor Atlas';
const lighthouse = {
    uid: 3, comment: 'Lighthouse of Vell',
    content: '[History]\nThe lighthouse was raised in the year of the long storm.\n[Keeper]\nKeeper Orrin trims the wick each dusk.',
};
const buoy = { uid: 4, comment: 'Buoy', content: 'A single red buoy marks the reef.' };
const pier = { uid: 5, comment: 'Old Pier', content: 'The old pier leans toward the tide.' };
const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter', qdrant_multitenancy: false, insert_batch_size: 3 };

let vectors;
let core;

const inserted = () => host.calls.filter(call => call.action === 'insert');
const deleted = () => host.calls.filter(call => call.action === 'delete');

function selectEntries(entries, uids = entries.map(entry => String(entry.uid))) {
    host.books[BOOK] = { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
    host.settings.vectfox.lorebase_books = { [BOOK]: oneSelectionRecord({ selectedUids: uids, pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] }) };
}

beforeEach(async () => {
    vi.resetModules();
    host.handle = 'rabbit';
    host.settings.vectfox = { enabled: true, lorebase_enabled: true, vector_backend: 'qdrant' };
    host.books = {};
    host.handlers = {};
    host.qdrant = new Map();
    host.calls = [];
    host.insertFailure = null;
    host.isPurgeRefused = false;
    host.searchAnswer = null;
    globalThis.toastr = { warning: vi.fn() };
    vectors = await import('../src/features/lorebase/lorebase-vectors.js');
    core = await import('../src/features/lorebase/lorebase-vectors-core.js');
    const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
    vi.mocked(notifyInvalidModel).mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a book tenant, for the Database Browser', () => {
    const listed = () => host.calls.filter(call => call.action === 'list');

    it('names the collection LoreBase reads now: the account\'s own, or vectfox_main while One shared collection is on', () => {
        expect(vectors.loreBaseVectorsCollection(SETTINGS)).toBe('vf_lorebase_rabbit');
        expect(vectors.loreBaseVectorsCollection({ ...SETTINGS, qdrant_multitenancy: true })).toBe('vectfox_main');
    });

    it('reads every point of a tenant in the collection named, its dense vector taken from beside the sparse one', async () => {
        const tenant = core.loreBaseBookCollectionId(BOOK, 'rabbit');
        host.qdrant.set(`vectfox_main|${tenant}`, new Map([
            [11, { text: 'Lighthouse', entryUid: '3', vector: { '': [0.1, 0.2], text_sparse: { indices: [1], values: [1] } } }],
            [12, { text: 'Buoy', entryUid: '4', vector: [0.3, 0.4] }],
        ]));
        const points = await vectors.readTenantPoints(tenant, 'vectfox_main', SETTINGS);
        expect(points.map(point => [point.hash, point.text, point.vector, point.metadata.entryUid])).toEqual([
            [11, 'Lighthouse', [0.1, 0.2], '3'], [12, 'Buoy', [0.3, 0.4], '4'],
        ]);
        expect(listed()[0]).toMatchObject({ target: { collectionId: 'vectfox_main', filters: { content_type: tenant } }, includeVectors: true });
    });

    it("gives View chunks the tenant as a lorebook's collection, read in whichever collection holds it", async () => {
        const { qdrantTarget } = await import('../src/features/vector-backend/qdrant-target.js');
        const tenant = core.loreBaseBookCollectionId(BOOK, 'rabbit');
        const row = { tenant, collection: 'vf_lorebase_rabbit', book: BOOK, pointCount: 504, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' };
        const here = vectors.tenantChunkSource(row, SETTINGS);
        expect(here.collection).toEqual({ id: tenant, name: BOOK, type: 'lorebook', backend: 'qdrant', source: 'openrouter', model: 'baai/bge-m3', chunkCount: 504 });
        expect(here.settings.vector_backend).toBe('qdrant');
        expect(qdrantTarget(tenant, here.settings)).toEqual({ collectionId: 'vf_lorebase_rabbit', filters: { content_type: tenant } });
        // A leftover in vectfox_main, whose points name no book.
        const leftover = vectors.tenantChunkSource({ ...row, collection: 'vectfox_main', book: null }, SETTINGS);
        expect(leftover.collection.name).toBe(tenant);
        expect(qdrantTarget(tenant, leftover.settings)).toEqual({ collectionId: 'vectfox_main', filters: { content_type: tenant } });
        expect(SETTINGS.qdrant_multitenancy).toBe(false);
    });

    it('stores a file\'s points with their vectors, IDs, entries and parts, and keeps them as the model set now\'s', async () => {
        selectEntries([lighthouse]);
        const [{ points }] = vectors.entriesWithPoints(BOOK, [lighthouse]);
        await vectors.importBookPoints(BOOK, points.map(point => ({ point, vector: [0.5, 0.5] })), SETTINGS);
        const bookId = core.loreBaseBookCollectionId(BOOK, 'rabbit');
        expect(inserted()).toEqual([{ action: 'insert', target: { collectionId: 'vf_lorebase_rabbit', filters: { content_type: bookId } }, hashes: points.map(point => point.hash) }]);
        const stored = host.qdrant.get(`vf_lorebase_rabbit|${bookId}`);
        expect([...stored.values()].map(point => [point.id, point.entryUid, point.partNumber, point.vector])).toEqual(
            points.map(point => [point.id, '3', point.partNumber, [0.5, 0.5]]));
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(vectors.hasStoredCurrentVectors(BOOK, lighthouse, SETTINGS)).toBe(true);
        expect(listed()).toHaveLength(1);
    });

    it('forgets the book when storing a file\'s points fails, so the next read finds what went in', async () => {
        selectEntries([lighthouse]);
        await vectors.bookVectors([BOOK], SETTINGS);
        host.insertFailure = () => new Error('Qdrant is down');
        const [{ points }] = vectors.entriesWithPoints(BOOK, [lighthouse]);
        await expect(vectors.importBookPoints(BOOK, points.map(point => ({ point, vector: [0.5, 0.5] })), SETTINGS)).rejects.toThrow('Qdrant is down');
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(listed()).toHaveLength(2);
    });

    it('deletes one tenant in the collection named, and reads the books again next time; a refused delete throws', async () => {
        selectEntries([lighthouse]);
        await vectors.bookVectors([BOOK], SETTINGS);
        const tenant = core.loreBaseBookCollectionId('Old Harbor', 'rabbit');
        await vectors.deleteTenantPoints(tenant, 'vectfox_main', SETTINGS);
        expect(host.calls.find(call => call.action === 'purge')).toEqual({ action: 'purge', target: { collectionId: 'vectfox_main', filters: { content_type: tenant } }, isShared: true });
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(listed()).toHaveLength(2);
        host.isPurgeRefused = true;
        await expect(vectors.deleteTenantPoints(tenant, 'vf_lorebase_rabbit', SETTINGS)).rejects.toThrow(`Similharity could not delete the vectors of ${tenant} in vf_lorebase_rabbit`);
    });
});

describe("a reply's search", () => {
    const contents = [
        { number: 1, bookName: BOOK, uid: 3, title: 'Lighthouse of Vell', keys: [] },
        { number: 2, bookName: 'Wren Journal', uid: 3, title: 'Fog Season', keys: [] },
    ];
    const messages = [
        { name: 'Orrin', text: 'The lamp was lit at dusk, as every night since the long storm took the old keeper.' },
        { name: 'Wren', text: 'Who keeps it tonight?' },
    ];

    it('searches both texts, the longer cut to its newest words, over every book in the collection LoreBase reads now', async () => {
        host.searchAnswer = [[{ score: 0.4, metadata: { lorebookName: 'Wren Journal', entryUid: '3' } }], []];
        const pool = await vectors.searchReplyPool([{ bookName: BOOK }, { bookName: 'Wren Journal' }], contents, messages, SETTINGS);

        const searches = host.calls.filter(call => call.action === 'search');
        expect(searches).toEqual([{
            action: 'search',
            collectionIds: [core.loreBaseBookCollectionId(BOOK, 'rabbit'), core.loreBaseBookCollectionId('Wren Journal', 'rabbit')],
            texts: ['Who keeps it tonight?', expect.stringMatching(/the long storm took the old keeper\.$/u)],
            topK: 400,
            collection: 'vf_lorebase_rabbit',
        }]);
        // Cut by characters, as the trials cut it, so it may start inside a word.
        expect(searches[0].texts[1].split(/\s+/).length).toBeLessThanOrEqual(8);
        expect(pool).toEqual([contents[1]]);

        await vectors.searchReplyPool([{ bookName: BOOK }], contents, messages, { ...SETTINGS, qdrant_multitenancy: true });
        expect(host.calls.filter(call => call.action === 'search')[1].collection).toBe('vectfox_main');
    });
});

describe('where the vectors live (Q6)', () => {
    it("keeps every book in the account's own collection while One shared collection is off, each a tenant by its ID", async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        expect(inserted()[0].target).toEqual({
            collectionId: 'vf_lorebase_rabbit',
            filters: { content_type: core.loreBaseBookCollectionId(BOOK, 'rabbit') },
        });
    });

    it('keeps them in vectfox_main while it is on, as every collection is', async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], { ...SETTINGS, qdrant_multitenancy: true });
        expect(inserted()[0].target).toEqual({ collectionId: 'vectfox_main', filters: { content_type: core.loreBaseBookCollectionId(BOOK, 'rabbit') } });
    });

    it('reads every point of a book once a session, and again when asked to', async () => {
        await vectors.bookVectors([BOOK], SETTINGS);
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(host.calls.filter(call => call.action === 'list')).toHaveLength(1);
        expect(host.calls[0].limit).toBe(Number.MAX_SAFE_INTEGER);
        await vectors.readBookVectors([BOOK], SETTINGS);
        expect(host.calls.filter(call => call.action === 'list')).toHaveLength(2);
    });
});

describe('writing vectors', () => {
    it("writes each entry's parts with their IDs, text and entry, in batches of whole entries, and keeps them as stored", async () => {
        const done = [];
        const result = await vectors.writeBookVectors(BOOK, [lighthouse, buoy, pier], [lighthouse, buoy, pier], SETTINGS, {
            onEntryDone: (entry, failure) => done.push([entry.uid, failure]),
        });
        expect(result).toEqual({ written: 3, failures: [], stopped: 0 });
        expect(inserted().map(call => call.hashes.length)).toEqual([3, 1]);
        expect(done).toEqual([[3, null], [4, null], [5, null]]);
        const [stored] = [...host.qdrant.values()];
        const firstPart = core.entryPoints(lighthouse, core.loreBaseBookCollectionId(BOOK, 'rabbit'))[0];
        expect(stored.get(firstPart.hash)).toMatchObject({ id: firstPart.id, text: firstPart.text, entryUid: '3' });
        await vectors.bookVectors([BOOK], SETTINGS);
        expect([lighthouse, buoy, pier].map(entry => vectors.hasStoredCurrentVectors(BOOK, entry, SETTINGS))).toEqual([true, true, true]);
    });

    it('writes nothing for an entry whose parts are stored by the model set now, and counts it written', async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        host.calls = [];
        expect(await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS)).toEqual({ written: 1, failures: [], stopped: 0 });
        expect(inserted()).toEqual([]);
    });

    it('writes an edited entry\'s changed part alone, then deletes its gone part', async () => {
        await vectors.writeBookVectors(BOOK, [lighthouse], [lighthouse], SETTINGS);
        host.calls = [];
        const edited = { ...lighthouse, content: '[History]\nThe lighthouse was raised in the year of the long storm.\n[Keeper]\nKeeper Wren trims the wick.' };
        await vectors.writeBookVectors(BOOK, [edited], [edited], SETTINGS);
        const bookId = core.loreBaseBookCollectionId(BOOK, 'rabbit');
        expect(host.calls.map(call => call.action)).toEqual(['insert', 'delete']);
        expect(inserted()[0].hashes).toEqual([core.entryPoints(edited, bookId)[1].hash]);
        expect(deleted()[0].hashes).toEqual([core.entryPoints(lighthouse, bookId)[1].hash]);
    });

    it('writes again what another embedding model made', async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], { ...SETTINGS, embedding_model: 'nomic-embed-text' });
        host.calls = [];
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        expect(inserted()).toHaveLength(1);
    });

    it('fails a batch that could not be written, entry by entry, and goes on with the next', async () => {
        host.insertFailure = items => (items.length === 3 ? new Error('upstream timeout') : null);
        const result = await vectors.writeBookVectors(BOOK, [lighthouse, buoy, pier], [lighthouse, buoy, pier], SETTINGS);
        expect(result.written).toBe(1);
        expect(result.failures).toEqual([
            { title: 'Lighthouse of Vell', detail: 'upstream timeout' }, { title: 'Buoy', detail: 'upstream timeout' },
        ]);
    });

    it('fails every entry left in the run at once on a wrong embedding setup, and raises the sticky popup once', async () => {
        const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
        host.insertFailure = () => Object.assign(new Error('Embedding: vector size mismatch'), { code: 'invalid_model_config' });
        const run = { isStopped: false, vectorProblem: null };
        const result = await vectors.writeBookVectors(BOOK, [lighthouse, buoy, pier], [lighthouse, buoy, pier], SETTINGS, { run });
        expect(inserted()).toHaveLength(1);
        expect(result.failures.map(failure => failure.detail)).toEqual(Array(3).fill('Embedding: vector size mismatch'));
        expect(run.vectorProblem).toBe('Embedding: vector size mismatch');
        expect(notifyInvalidModel).toHaveBeenCalledTimes(1);
    });

    it('sends one batch alone on a wrong embedding setup with no run, as an edit writes, raising the popup once', async () => {
        const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
        host.insertFailure = () => Object.assign(new Error('Embedding: vector size mismatch'), { code: 'invalid_model_config' });
        const result = await vectors.writeBookVectors(BOOK, [lighthouse, buoy, pier], [lighthouse, buoy, pier], SETTINGS);
        expect(inserted()).toHaveLength(1);
        expect(result.failures).toHaveLength(3);
        expect(notifyInvalidModel).toHaveBeenCalledTimes(1);
    });

    it('sends no batch once the run is stopped, and counts its entries stopped', async () => {
        const run = { isStopped: true, vectorProblem: null };
        expect(await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse, buoy], SETTINGS, { run })).toEqual({ written: 0, failures: [], stopped: 2 });
        expect(inserted()).toEqual([]);
    });

    it('fails every entry when what Qdrant holds cannot be read, and writes nothing', async () => {
        const { listChunks } = await import('../src/features/vector-backend/index.js');
        vi.mocked(listChunks).mockRejectedValueOnce(new Error('Qdrant is down'));
        const result = await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        expect(result.failures).toEqual([{ title: 'Buoy', detail: 'Qdrant is down' }]);
        expect(inserted()).toEqual([]);
    });

    it('names the entries whose vectors failed in one toast for the book', () => {
        vectors.showVectorFailures(BOOK, [{ title: 'Buoy', detail: 'upstream timeout' }]);
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('could not write the vectors of "Buoy" in lorebook "Harbor Atlas"');
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('Generate all');
    });
});

describe('deleting vectors', () => {
    it('deletes the points of entries no longer selected as the selection screen closes, and writes nothing', async () => {
        selectEntries([lighthouse, buoy]);
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse, buoy], SETTINGS);
        selectEntries([lighthouse, buoy], ['3']);
        host.calls = [];
        await vectors.pruneBookVectors(BOOK, SETTINGS);
        expect(inserted()).toEqual([]);
        expect(deleted()[0].hashes).toEqual([core.entryPoints(buoy, core.loreBaseBookCollectionId(BOOK, 'rabbit'))[0].hash]);
    });

    it('keeps the points of an entry another selection of the book still holds', async () => {
        selectEntries([lighthouse, buoy]);
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse, buoy], SETTINGS);
        selectEntries([lighthouse, buoy], ['3']);
        host.settings.vectfox.lorebase_books[BOOK].selections.push({
            id: 'night', name: 'Night watch', selectedUids: ['4'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [],
        });
        host.calls = [];
        await vectors.pruneBookVectors(BOOK, SETTINGS);
        expect(deleted()).toEqual([]);
        expect(inserted()).toEqual([]);
    });

    it('keeps what it read per collection, so flipping One shared collection reads that collection and never answers from the other', async () => {
        selectEntries([buoy]);
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        expect(vectors.hasStoredCurrentVectors(BOOK, buoy, SETTINGS)).toBe(true);
        const shared = { ...SETTINGS, qdrant_multitenancy: true };
        expect(vectors.vectorStateOf(BOOK, buoy, shared)).toEqual({ status: 'unknown' });
        expect(vectors.hasStoredCurrentVectors(BOOK, buoy, shared)).toBe(false);
        host.calls = [];
        await vectors.bookVectors([BOOK], shared);
        expect(host.calls.map(call => [call.action, call.target.collectionId])).toEqual([['list', 'vectfox_main']]);
        expect([vectors.hasStoredCurrentVectors(BOOK, buoy, shared), vectors.hasStoredCurrentVectors(BOOK, buoy, SETTINGS)]).toEqual([false, true]);
    });

    it('deletes one tenant whole, and forgets what it held so the next read finds what is left', async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], SETTINGS);
        host.calls = [];
        await vectors.deleteTenantPoints(core.loreBaseBookCollectionId(BOOK, 'rabbit'), 'vectfox_main', SETTINGS);
        expect(host.calls.map(call => call.target)).toEqual([
            { collectionId: 'vectfox_main', filters: { content_type: core.loreBaseBookCollectionId(BOOK, 'rabbit') } },
        ]);
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(host.calls.at(-1).action).toBe('list');
    });
});

describe('an edit SillyTavern saves', () => {
    async function saveEdit(entries) {
        host.books[BOOK] = { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
        host.handlers.worldinfo_updated(BOOK);
        await vi.advanceTimersByTimeAsync(2000);
    }

    it('writes the changed parts of the entries that had vectors once the saves settle, and leaves the others to the question', async () => {
        vi.useFakeTimers();
        Object.assign(host.settings.vectfox, SETTINGS);
        selectEntries([lighthouse, buoy]);
        vectors.initializeLoreBaseVectors();
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse], host.settings.vectfox);
        host.calls = [];
        const edited = { ...lighthouse, content: '[History]\nThe lighthouse was raised in the year of the long storm.\n[Keeper]\nKeeper Wren trims the wick.' };
        const editedBuoy = { ...buoy, content: 'Two red buoys mark the reef.' };
        await saveEdit([edited, editedBuoy]);
        const bookId = core.loreBaseBookCollectionId(BOOK, 'rabbit');
        expect(inserted().map(call => call.hashes)).toEqual([[core.entryPoints(edited, bookId)[1].hash]]);
        expect(deleted()[0].hashes).toEqual([core.entryPoints(lighthouse, bookId)[1].hash]);
    });

    it('writes once for a burst of saves', async () => {
        vi.useFakeTimers();
        Object.assign(host.settings.vectfox, SETTINGS);
        selectEntries([buoy]);
        vectors.initializeLoreBaseVectors();
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], host.settings.vectfox);
        host.calls = [];
        host.handlers.worldinfo_updated(BOOK);
        await vi.advanceTimersByTimeAsync(1000);
        await saveEdit([{ ...buoy, content: 'Two red buoys mark the reef.' }]);
        expect(inserted()).toHaveLength(1);
    });

    it('writes nothing while LoreBase is off: turning it on finds what changed', async () => {
        vi.useFakeTimers();
        Object.assign(host.settings.vectfox, SETTINGS, { lorebase_enabled: false });
        selectEntries([buoy]);
        vectors.initializeLoreBaseVectors();
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], host.settings.vectfox);
        host.calls = [];
        await saveEdit([{ ...buoy, content: 'Two red buoys mark the reef.' }]);
        expect(host.calls).toEqual([]);
    });
});

describe("each entry's vectors, as this session knows them (§7.1, §7.3 of lorebook-multi-vector.md)", () => {
    it("knows nothing of a book not read yet, then reads an entry as ready, missing, or holding another embedding model's vectors", async () => {
        selectEntries([lighthouse, buoy]);
        expect(vectors.vectorStateOf(BOOK, lighthouse, SETTINGS)).toEqual({ status: 'unknown' });
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse], SETTINGS);
        expect(vectors.vectorStateOf(BOOK, lighthouse, SETTINGS)).toEqual({ status: 'ready' });
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'missing' });
        expect(vectors.vectorStateOf(BOOK, lighthouse, { ...SETTINGS, embedding_model: 'openai/text-embedding-3-large' })).toEqual({ status: 'other-model' });
        // An edited part is missing; the unchanged one is the model's set now, so nothing is another model's.
        const edited = { ...lighthouse, content: lighthouse.content.replace('dusk', 'dawn') };
        expect(vectors.vectorStateOf(BOOK, edited, SETTINGS)).toEqual({ status: 'missing' });
    });

    it('says an entry is being written while its batch is sent, and why it failed until it is written, telling the listeners each time', async () => {
        selectEntries([lighthouse, buoy]);
        const told = [];
        const stop = vectors.onVectorStateChange(bookName => told.push(`${bookName}: ${vectors.vectorStateOf(BOOK, buoy, SETTINGS).status}`));
        let whileSent = null;
        host.insertFailure = () => {
            whileSent = vectors.vectorStateOf(BOOK, buoy, SETTINGS);
            return new Error('the embedding server refused');
        };
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [buoy], SETTINGS);
        expect(whileSent).toEqual({ status: 'writing' });
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'failed', detail: 'the embedding server refused' });
        expect(told).toEqual([`${BOOK}: writing`, `${BOOK}: failed`]);

        host.insertFailure = null;
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [buoy], SETTINGS);
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'ready' });
        stop();
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse], SETTINGS);
        expect(told.at(-1)).toBe(`${BOOK}: ready`);
    });

    it('leaves a stopped entry missing, and forgets every failure once every vector is deleted', async () => {
        selectEntries([lighthouse, buoy]);
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [buoy], SETTINGS, { run: { isStopped: true } });
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'missing' });
        host.insertFailure = () => new Error('the embedding server refused');
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [buoy], SETTINGS);
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS).status).toBe('failed');
        await vectors.deleteTenantPoints(core.loreBaseBookCollectionId(BOOK, 'rabbit'), 'vf_lorebase_rabbit', SETTINGS);
        vectors.forgetVectorWriteFailures();
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'missing' });
    });

    it("forgets one book's failures and what it held once the book leaves LoreBase, telling the listeners", async () => {
        selectEntries([lighthouse, buoy]);
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [lighthouse], SETTINGS);
        host.insertFailure = () => new Error('the embedding server refused');
        await vectors.writeBookVectors(BOOK, [lighthouse, buoy], [buoy], SETTINGS);
        const told = [];
        const stop = vectors.onVectorStateChange(bookName => told.push(bookName));
        vectors.forgetBookVectors(BOOK);
        stop();
        expect(told).toEqual([BOOK]);
        expect(vectors.vectorStateOf(BOOK, lighthouse, SETTINGS)).toEqual({ status: 'unknown' });
        await vectors.bookVectors([BOOK], SETTINGS);
        expect(vectors.vectorStateOf(BOOK, buoy, SETTINGS)).toEqual({ status: 'missing' });
    });
});
