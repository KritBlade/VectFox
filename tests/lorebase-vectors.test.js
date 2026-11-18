/**
 * LoreBase's vectors in Qdrant (src/features/lorebase/lorebase-vectors.js, §4.2 to §4.4 of InternalProject/Vectfox/
 * plans/lorebook-multi-vector.md): every book of an account a tenant inside vectfox_main while "One shared collection"
 * is on and inside the account's own collection while it is off (Q6); what Qdrant holds read once a session and kept
 * current by what is written and deleted; writes in batches of whole entries, stored before the stale points are
 * deleted; a wrong embedding setup fails the rest of a run at once; a stop leaves the batches not yet sent; the points
 * of entries no longer selected deleted; Delete all; and an edit SillyTavern saves written again in the background.
 * The vector API is a stand-in holding points in memory, routed by the real qdrantTarget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    handle: 'rabbit',
    settings: { vectfox: {} },
    books: {},
    handlers: {},
    qdrant: new Map(),
    calls: [],
    insertFailure: null,
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
vi.mock('../src/features/embedding/index.js', () => ({ getModelFromSettings: settings => settings.embedding_model ?? 'baai/bge-m3' }));
vi.mock('../src/features/vector-backend/index.js', async () => {
    const { qdrantTarget } = await import('../src/features/vector-backend/qdrant-target.js');
    const pointsAt = target => {
        const key = `${target.collectionId}|${target.filters.content_type ?? ''}`;
        if (!host.qdrant.has(key)) host.qdrant.set(key, new Map());
        return host.qdrant.get(key);
    };
    return {
        insertVectorItems: vi.fn(async (collectionId, items, settings) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'insert', target, hashes: items.map(item => item.hash) });
            const failure = host.insertFailure?.(items);
            if (failure) throw failure;
            for (const item of items) {
                pointsAt(target).set(item.hash, {
                    id: item.id, text: item.text, entryUid: item.metadata.entryUid,
                    embeddingSource: settings.embedding_provider || 'transformers', embeddingModel: settings.embedding_model ?? 'baai/bge-m3',
                });
            }
        }),
        listChunks: vi.fn(async (collectionId, settings, options) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'list', target, limit: options.limit });
            return { items: [...pointsAt(target)].map(([hash, point]) => ({ hash, text: point.text, metadata: point })) };
        }),
        deleteVectorItems: vi.fn(async (collectionId, hashes, settings) => {
            const target = qdrantTarget(collectionId, settings);
            host.calls.push({ action: 'delete', target, hashes });
            for (const hash of hashes) pointsAt(target).delete(hash);
        }),
        purgeVectorIndex: vi.fn(async (collectionId, settings) => {
            host.calls.push({ action: 'purge', target: qdrantTarget(collectionId, settings), isShared: Boolean(settings.qdrant_multitenancy) });
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
    host.settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: uids, pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } };
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
    globalThis.toastr = { warning: vi.fn() };
    vectors = await import('../src/features/lorebase/lorebase-vectors.js');
    core = await import('../src/features/lorebase/lorebase-vectors-core.js');
    const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
    vi.mocked(notifyInvalidModel).mockClear();
});

afterEach(() => {
    vi.useRealTimers();
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
        expect(vectors.uidsWithCurrentVectors(BOOK, [lighthouse, buoy, pier], (await vectors.bookVectors([BOOK], SETTINGS)).get(BOOK), SETTINGS))
            .toEqual(new Set(['3', '4', '5']));
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

    it("Delete all deletes the account's own collection while One shared collection is off", async () => {
        await vectors.deleteAllVectors([BOOK, 'Desert Atlas'], SETTINGS);
        expect(host.calls).toEqual([{ action: 'purge', target: { collectionId: 'vf_lorebase_rabbit', filters: {} }, isShared: false }]);
    });

    it("Delete all deletes each book's tenant in vectfox_main while it is on, and forgets what it held", async () => {
        await vectors.writeBookVectors(BOOK, [buoy], [buoy], { ...SETTINGS, qdrant_multitenancy: true });
        host.calls = [];
        await vectors.deleteAllVectors([BOOK, 'Desert Atlas'], { ...SETTINGS, qdrant_multitenancy: true });
        expect(host.calls.map(call => call.target)).toEqual([
            { collectionId: 'vectfox_main', filters: { content_type: core.loreBaseBookCollectionId(BOOK, 'rabbit') } },
            { collectionId: 'vectfox_main', filters: { content_type: core.loreBaseBookCollectionId('Desert Atlas', 'rabbit') } },
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
