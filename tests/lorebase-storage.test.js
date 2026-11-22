/**
 * LoreBase's storage module (src/features/lorebase/lorebase-storage.js, §3.1 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): what the selected entries of every book with a selection lack, and how many of
 * each book's selected entries have keys and vectors; the progress panel's run of keys, vectors or both (§4.3 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md), each entry counted once, whose Stop drops what is not yet
 * sent, telling its run listeners as it starts and ends, and Regenerate keys there; one run at a time. A run that
 * writes missing keys reads where to lock as it starts and then locks the books it wrote keys for there (§6.1); a run
 * of vectors alone and Regenerate keys lock nothing. Delete deletes every book's vectors, keys or both, never while
 * LoreBase writes, when it brings the panel up. For the Database Browser (§3.2, §3.3): its rows from Similharity's
 * listing and the books with a record, each with its selected count; the row a file the global Import takes goes to; a
 * row's keys or vectors exported; a file's import planned onto what matches, an unselected entry's parts included, and
 * written, a vectors file of another model embedded again for the selected entries; a row deleted; and an import or a
 * delete refused while LoreBase writes. Remove from LoreBase (§3.6): what a book holds read for its confirm, then its
 * vectors deleted in every collection, its keys, then its record, every other book left as it was; refused while
 * LoreBase writes and off Qdrant, and its record kept when a delete fails. The entry editor's save (saveEntryWithVectors): the entry saved through
 * SillyTavern, then its vectors alone written when LoreBase decides it, LoreBase on or off; an entry it does not decide
 * saved alone; no vectors off Qdrant; nothing saved while LoreBase writes. Similharity's LoreBase routes are a fetch
 * stand-in holding the keys and titles in memory, as
 * lorebase-keys.test.js has them; the vectors are a stand-in for lorebase-vectors.js, which lorebase-vectors.test.js
 * holds, its points made by the real lorebase-vectors-core.js.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oneSelectionRecord } from './lorebase-book-record.js';

const host = vi.hoisted(() => ({
    connection: { ok: true }, ask: null, panel: null, lockPlace: null, vectorized: new Set(), vectorFailures: new Set(),
    worldNames: [], listing: { keys: [], vectors: [] }, tenantPoints: [], getBackend: null,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
vi.mock('../src/sillytavern/world-info.js', () => {
    const loadWorldInfo = vi.fn();
    // SillyTavern's save of one entry, onto the book loadWorldInfo gives, so the next load reads it.
    const saveLorebookEntry = vi.fn(async (bookName, uid, fields) => {
        Object.assign((await loadWorldInfo(bookName)).entries[uid], fields);
    });
    return { loadWorldInfo, saveLorebookEntry, world_names: host.worldNames };
});
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/features/vector-backend/index.js', () => ({ getBackend: (...args) => host.getBackend(...args) }));
vi.mock('../src/shared/similharity-plugin.js', () => ({
    similharityStanding: () => ({ isFound: true, version: '3.4.14', requiredVersion: '3.4.14', isCurrent: true }), PLUGIN_UPDATE_INSTRUCTIONS: '',
}));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: {
        show: (...args) => host.panel.show(...args), setCancelHandler: handler => { host.panel.stop = handler; },
        updateCurrentItem: (...args) => host.panel.updateCurrentItem(...args), updateProgress: (...args) => host.panel.updateProgress(...args),
        addError: (...args) => host.panel.addError(...args), complete: (...args) => host.panel.complete(...args),
        reopen: (...args) => host.panel.reopen(...args),
    },
}));
vi.mock('../src/features/lorebase/lorebase-connection.js', () => ({
    askOnLoreBase: () => (...args) => host.ask(...args),
    resolveLoreBaseLlmConfig: () => host.connection,
    describeLoreBaseConnectionProblem: (reason, problem) => `${problem} Until then the entries selected for LoreBase stay out of replies.`,
}));
vi.mock('../src/features/lorebase/lorebase-switch.js', () => ({ isLoreBaseBackend: settings => settings?.vector_backend === 'qdrant' }));
// What each kind needs is lorebase-setup.js's (writingProblem), read here as it is: its other checks stand in.
vi.mock('../src/features/embedding/index.js', () => ({ embeddingSetupProblem: () => '' }));
vi.mock('../src/features/lorebase/lorebase-jev.js', () => ({ resolveJevConnection: () => ({ ok: true }) }));
// Where a run locks, and a lock that takes every book it is given: lorebase-chat-books.test.js holds which books lock.
vi.mock('../src/features/lorebase/lorebase-chat-books.js', () => ({
    keyRunLockPlace: vi.fn(() => host.lockPlace),
    lockKeyedBooks: vi.fn((place, keyedBookNames) => (place && keyedBookNames.length ? { chatId: place.chatId, bookNames: keyedBookNames } : null)),
}));
// An entry has its vectors once host.vectorized holds "book/uid"; writing adds it, and an entry in host.vectorFailures fails.
vi.mock('../src/features/lorebase/lorebase-vectors.js', async () => {
    const core = await import('../src/features/lorebase/lorebase-vectors-core.js');
    const noVectorsOf = async bookNames => new Map(bookNames.map(bookName => [bookName, new Map()]));
    return {
        currentEmbeddingModelKey: settings => core.embeddingModelKey(settings.embedding_provider || 'transformers', settings.embedding_model ?? 'baai/bge-m3'),
        entriesWithPoints: (bookName, entries) => entries.map(entry => ({
            entry, uid: String(entry.uid), points: core.entryPoints(entry, core.loreBaseBookCollectionId(bookName, 'rabbit')),
        })),
        loreBaseVectorsCollection: settings => (settings.qdrant_multitenancy ? 'vectfox_main' : 'vf_lorebase_rabbit'),
        readTenantPoints: vi.fn(async () => host.tenantPoints),
        importBookPoints: vi.fn(async (bookName, writes) => {
            for (const { point } of writes) host.vectorized.add(`${bookName}/${point.uid}`);
        }),
        deleteTenantPoints: vi.fn(async () => {}),
        forgetBookVectors: vi.fn(),
        bookVectors: vi.fn(noVectorsOf),
        readBookVectors: vi.fn(noVectorsOf),
        hasStoredCurrentVectors: vi.fn((bookName, entry) => host.vectorized.has(`${bookName}/${entry.uid}`)),
        vectorStateOf: (bookName, entry) => ({ status: host.vectorized.has(`${bookName}/${entry.uid}`) ? 'ready' : 'missing' }),
        writeBookVectors: vi.fn(async (bookName, decidedEntries, entries, settings, { run = null, onEntryDone = null } = {}) => {
            const result = { written: 0, failures: [], stopped: 0 };
            for (const entry of entries) {
                if (run?.isStopped) {
                    result.stopped += 1;
                } else if (host.vectorFailures.has(String(entry.uid))) {
                    const failure = { title: entry.comment, detail: 'upstream timeout' };
                    result.failures.push(failure);
                    onEntryDone?.(entry, failure);
                } else {
                    host.vectorized.add(`${bookName}/${entry.uid}`);
                    result.written += 1;
                    onEntryDone?.(entry, null);
                }
            }
            return result;
        }),
        forgetVectorWriteFailures: vi.fn(),
        showVectorFailures: vi.fn(),
    };
});

const BOOK = 'Harbor Atlas';
const entry = (uid, comment) => ({ uid, comment, content: `${comment} stands by the harbor.` });
const QDRANT = { vector_backend: 'qdrant' };
// The books card's rows, each showing every entry its book's selections hold, as with none in use in the chat.
const shownBooks = (...bookNames) => bookNames.map(bookName => ({ bookName, selectionId: null }));
const STILL_WRITING = 'LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.';

let stored;
let storedTitles;
let routeCalls;
let storage;
let keysModule;
let kinds;

function answerWith(keys) {
    return [{ keys }];
}

// An answer parseJsonArrayFromLlm reads with no list of keys in it.
const UNREADABLE = [{ names: [] }];
const uidsOf = entries => entries.map(each => each.uid);
const outcomeOf = fields => ({ keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null, ...fields });

beforeEach(async () => {
    vi.resetModules();
    globalThis.toastr = { warning: vi.fn() };
    stored = {};
    storedTitles = {};
    routeCalls = [];
    host.worldNames.length = 0;
    host.listing = { keys: [], vectors: [] };
    host.tenantPoints = [];
    host.getBackend = vi.fn(async () => ({}));
    globalThis.fetch = vi.fn(async (url, { body }) => {
        const request = JSON.parse(body);
        routeCalls.push({ url, request });
        if (url.endsWith('/books')) return { ok: true, json: async () => host.listing };
        if (url.endsWith('/read')) {
            const of = all => Object.fromEntries(request.books.map(book => [book, { ...(all[book] ?? {}) }]));
            return { ok: true, json: async () => ({ books: of(stored), titles: of(storedTitles) }) };
        }
        if (url.endsWith('/delete')) {
            const books = request.books ?? Object.keys(stored);
            const deleted = books.reduce((count, book) => count + Object.keys(stored[book] ?? {}).length, 0);
            for (const book of books) delete stored[book];
            return { ok: true, json: async () => ({ deleted }) };
        }
        for (const { uid, keys, title } of request.entries) {
            (stored[request.book] ??= {})[uid] = keys;
            if (title !== undefined) (storedTitles[request.book] ??= {})[uid] = title;
        }
        return { ok: true, json: async () => ({ written: request.entries.length }) };
    });
    host.connection = { ok: true };
    host.lockPlace = null;
    host.vectorized = new Set();
    host.vectorFailures = new Set();
    host.panel = { show: vi.fn(), updateCurrentItem: vi.fn(), updateProgress: vi.fn(), addError: vi.fn(), complete: vi.fn(), reopen: vi.fn(), stop: null };
    host.ask = vi.fn(async messages => answerWith([`keys from ${messages[1].content.split('\n')[2].split(' ')[0]}`]));
    storage = await import('../src/features/lorebase/lorebase-storage.js');
    keysModule = await import('../src/features/lorebase/lorebase-keys.js');
    kinds = await import('../src/features/lorebase/lorebase-storage-core.js');
    // A mocked module outlives resetModules, its calls with it.
    const { keyRunLockPlace, lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
    keyRunLockPlace.mockClear();
    lockKeyedBooks.mockClear();
    const vectorsModule = await import('../src/features/lorebase/lorebase-vectors.js');
    for (const name of ['bookVectors', 'readBookVectors', 'hasStoredCurrentVectors', 'writeBookVectors', 'forgetVectorWriteFailures', 'showVectorFailures',
        'readTenantPoints', 'importBookPoints', 'deleteTenantPoints', 'forgetBookVectors']) {
        vectorsModule[name].mockClear();
    }
});

// Harbor Atlas selects 0, 1 and a constant entry 2, entry 0 with keys; Desert Atlas selects 5; Lost Atlas cannot be
// loaded; Unused Atlas selects nothing. Without isVectorized, no entry has vectors.
async function selectBooks({ isVectorized = true } = {}) {
    const { extension_settings } = await import('../src/sillytavern/settings.js');
    const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
    extension_settings.vectfox.lorebase_books = {
        [BOOK]: oneSelectionRecord({ selectedUids: ['0', '1', '2'] }), 'Desert Atlas': oneSelectionRecord({ selectedUids: ['5'] }),
        'Lost Atlas': oneSelectionRecord({ selectedUids: ['1'] }), 'Unused Atlas': oneSelectionRecord({ selectedUids: [] }),
    };
    const books = {
        [BOOK]: { entries: { 0: entry(0, 'Lighthouse'), 1: entry(1, 'Tidewardens'), 2: { ...entry(2, 'Tide clock'), constant: true }, 3: entry(3, 'Pier') } },
        'Desert Atlas': { entries: { 5: entry(5, 'Dunes') } },
    };
    loadWorldInfo.mockClear();
    loadWorldInfo.mockImplementation(async bookName => {
        if (!books[bookName]) throw new Error('no such lorebook');
        return books[bookName];
    });
    stored[BOOK] = { 0: ['old keys'] };
    if (isVectorized) for (const key of [`${BOOK}/0`, `${BOOK}/1`, 'Desert Atlas/5']) host.vectorized.add(key);
    return loadWorldInfo;
}

describe('what the selected entries lack', () => {
    it('counts what the selected entries LoreBase decides lack, by book, each entry once, a book it cannot read counted apart', async () => {
        await selectBooks();
        const pending = await storage.selectedEntriesNotReady(QDRANT);
        expect(pending.books.map(book => [book.bookName, uidsOf(book.keyEntries), uidsOf(book.vectorEntries), uidsOf(book.decidedEntries)]))
            .toEqual([[BOOK, [1], [], [0, 1]], ['Desert Atlas', [5], [], [5]]]);
        expect([pending.count, pending.readyCount, pending.decidedCount, pending.unreadBooks]).toEqual([2, 1, 3, 1]);
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('counts the entries without vectors from the model set now, an entry lacking both once, and the ready ones apart', async () => {
        await selectBooks({ isVectorized: false });
        const pending = await storage.selectedEntriesNotReady(QDRANT);
        expect(pending.books.map(book => [book.bookName, uidsOf(book.keyEntries), uidsOf(book.vectorEntries)]))
            .toEqual([[BOOK, [1], [0, 1]], ['Desert Atlas', [5], [5]]]);
        expect([pending.count, pending.readyCount]).toEqual([3, 0]);
    });

    it('reads the vectors as this session holds them, or from Qdrant again when asked to', async () => {
        const { bookVectors, readBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        await selectBooks();
        await storage.selectedEntriesNotReady(QDRANT);
        expect([bookVectors.mock.calls.length, readBookVectors.mock.calls.length]).toEqual([1, 0]);
        await storage.selectedEntriesNotReady(QDRANT, { isRereading: true });
        expect(readBookVectors).toHaveBeenCalledWith([BOOK, 'Desert Atlas'], QDRANT);
    });

    it('never counts or keys a selected entry with no text', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: oneSelectionRecord({ selectedUids: ['0', '1'] }) };
        loadWorldInfo.mockImplementation(async () => ({ entries: { 0: entry(0, 'Lighthouse'), 1: { uid: 1, comment: 'Buoy Line', content: '' } } }));
        const pending = await storage.selectedEntriesNotReady(QDRANT);
        expect(pending.books.map(book => uidsOf(book.keyEntries))).toEqual([[0]]);
        expect(pending.count).toBe(1);
    });

    it('never counts an entry kept with no keys as missing', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: oneSelectionRecord({ selectedUids: ['4'] }) };
        loadWorldInfo.mockImplementation(async () => ({ entries: { 4: entry(4, 'Section marker') } }));
        stored[BOOK] = { 4: [] };
        host.vectorized.add(`${BOOK}/4`);
        expect((await storage.selectedEntriesNotReady(QDRANT)).count).toBe(0);
    });
});

describe("each book's keys and vectors, counted", () => {
    it('counts the selected entries LoreBase decides with keys, and with vectors from the model set now, by book', async () => {
        await selectBooks();
        host.vectorized.delete(`${BOOK}/1`);
        const counts = fields => ({
            keyCount: 0, vectorCount: 0, readyCount: 0, missingKeyCount: 0, missingVectorCount: 0, otherModelCount: 0, failedCount: 0, firstFailure: null,
            ...fields,
        });
        expect(await storage.storedCountsOfBooks(shownBooks(BOOK, 'Desert Atlas'), QDRANT)).toEqual(new Map([
            [BOOK, counts({ decidedCount: 2, keyCount: 1, vectorCount: 1, readyCount: 1, missingKeyCount: 1, missingVectorCount: 1 })],
            ['Desert Atlas', counts({ decidedCount: 1, vectorCount: 1, missingKeyCount: 1 })],
        ]));
    });

    it("counts the selection a row shows, or with none in use every entry the book's selections hold, and refuses one the book lacks", async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        await selectBooks();
        extension_settings.vectfox.lorebase_books[BOOK].selections.push({
            id: 'night', name: 'Night watch', selectedUids: ['0', '3'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [],
        });
        const harborOf = async selectionId => (await storage.storedCountsOfBooks([{ bookName: BOOK, selectionId }], QDRANT)).get(BOOK);
        expect(await harborOf('night'))
            .toMatchObject({ decidedCount: 2, keyCount: 1, vectorCount: 1, readyCount: 1, missingKeyCount: 1, missingVectorCount: 1 });
        expect(await harborOf('first'))
            .toMatchObject({ decidedCount: 2, keyCount: 1, vectorCount: 2, readyCount: 1, missingKeyCount: 1, missingVectorCount: 0 });
        expect(await harborOf(null))
            .toMatchObject({ decidedCount: 3, keyCount: 1, vectorCount: 2, readyCount: 1, missingKeyCount: 2, missingVectorCount: 1 });
        await expect(harborOf('gone')).rejects.toThrow(`LoreBase has no selection "gone" of lorebook "${BOOK}".`);
    });

    it('counts the entries whose keys or vectors failed in this session, with the first reason, as not ready', async () => {
        await selectBooks();
        host.ask = vi.fn(async messages => (messages[1].content.includes('Dunes') ? UNREADABLE : answerWith(['tidewardens'])));
        await storage.writeMissing(QDRANT, [kinds.KEYS]);
        expect((await storage.storedCountsOfBooks(shownBooks('Desert Atlas'), QDRANT)).get('Desert Atlas'))
            .toMatchObject({ keyCount: 0, readyCount: 0, failedCount: 1, firstFailure: 'its answer held no list of keys' });
    });

    it('reads nothing off Qdrant, where LoreBase keeps neither, or while VectFox is off', async () => {
        const loadWorldInfo = await selectBooks();
        expect(await storage.storedCountsOfBooks(shownBooks(BOOK), { vector_backend: 'standard' })).toEqual(new Map());
        expect(await storage.storedCountsOfBooks(shownBooks(BOOK), { ...QDRANT, enabled: false })).toEqual(new Map());
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });
});

describe('writing on the progress panel', () => {
    it('Generate all writes the missing keys in every book with a selection, reading the vectors from Qdrant first, and counts what it did', async () => {
        const loadWorldInfo = await selectBooks();
        const { readBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS)).toEqual(outcomeOf({ keysWritten: 2, unreadBooks: 1 }));
        expect(stored).toEqual({ [BOOK]: { 0: ['old keys'], 1: ['keys from Tidewardens'] }, 'Desert Atlas': { 5: ['keys from Dunes'] } });
        expect(loadWorldInfo.mock.calls.map(([bookName]) => bookName)).toEqual([BOOK, 'Desert Atlas', 'Lost Atlas']);
        expect(readBookVectors).toHaveBeenCalledWith([BOOK, 'Desert Atlas'], QDRANT);
    });

    it("writes an entry's keys, then its vectors, and the vectors of entries that have keys, every entry LoreBase decides given", async () => {
        await selectBooks({ isVectorized: false });
        const { writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS)).toEqual(outcomeOf({ keysWritten: 2, vectorsWritten: 3, unreadBooks: 1 }));
        expect(writeBookVectors.mock.calls.map(([bookName, decided, entries]) => [bookName, uidsOf(decided), uidsOf(entries)]))
            .toEqual([[BOOK, [0, 1], [0, 1]], ['Desert Atlas', [5], [5]]]);
        expect(host.vectorized).toEqual(new Set([`${BOOK}/0`, `${BOOK}/1`, 'Desert Atlas/5']));
    });

    it('counts each entry once on the progress panel, done when the last of what it lacked is written', async () => {
        await selectBooks({ isVectorized: false });
        await storage.writeMissing(QDRANT, kinds.BOTH_KINDS);
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys and vectors', 3, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.updateProgress.mock.calls.map(([done]) => done)).toEqual([1, 2, 3]);
        expect(host.panel.complete).toHaveBeenCalledWith(true, 'Wrote the keys of 2 entries and the vectors of 3 entries');
    });

    it('Generate keys writes only the missing keys, under "LoreBase keys", and locks the books it wrote keys for', async () => {
        await selectBooks({ isVectorized: false });
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK, 'Desert Atlas']) };
        const { writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        expect(await storage.writeMissing(QDRANT, [kinds.KEYS]))
            .toEqual(outcomeOf({ keysWritten: 2, unreadBooks: 1, chatLock: { chatId: 'chat-harbor', bookNames: [BOOK, 'Desert Atlas'] } }));
        expect(writeBookVectors).not.toHaveBeenCalled();
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys', 2, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.updateProgress.mock.calls.map(([done]) => done)).toEqual([1, 2]);
    });

    it('Generate vectors writes the vectors of every selected entry lacking them, keys or not, under "LoreBase vectors", and locks nothing', async () => {
        await selectBooks({ isVectorized: false });
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK, 'Desert Atlas']) };
        const { keyRunLockPlace } = await import('../src/features/lorebase/lorebase-chat-books.js');
        const { writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        expect(await storage.writeMissing(QDRANT, [kinds.VECTORS])).toEqual(outcomeOf({ vectorsWritten: 3, unreadBooks: 1 }));
        expect(writeBookVectors.mock.calls.map(([bookName, decided, entries]) => [bookName, uidsOf(decided), uidsOf(entries)]))
            .toEqual([[BOOK, [0, 1], [0, 1]], ['Desert Atlas', [5], [5]]]);
        expect(host.ask).not.toHaveBeenCalled();
        expect(keyRunLockPlace).not.toHaveBeenCalled();
        expect(stored).toEqual({ [BOOK]: { 0: ['old keys'] } });
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase vectors', 3, 'Entries', { unitLabel: 'Entries' });
    });

    it('gives no vectors to an entry whose keys failed, counting it failed once', async () => {
        await selectBooks({ isVectorized: false });
        const { writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        host.ask = vi.fn(async messages => (messages[1].content.includes('Dunes') ? UNREADABLE : answerWith(['tidewardens'])));
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS)).toEqual(outcomeOf({ keysWritten: 1, vectorsWritten: 2, failed: 1, unreadBooks: 1 }));
        expect(writeBookVectors.mock.calls.map(([bookName]) => bookName)).toEqual([BOOK]);
        expect(host.panel.updateProgress.mock.calls.map(([done]) => done)).toEqual([1, 2, 3]);
    });

    it('names the entries whose vectors failed on the panel and in their toast, and counts them failed', async () => {
        await selectBooks();
        const { showVectorFailures } = await import('../src/features/lorebase/lorebase-vectors.js');
        host.vectorized.delete(`${BOOK}/0`);
        host.vectorFailures.add('0');
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS)).toEqual(outcomeOf({ keysWritten: 2, failed: 1, unreadBooks: 1 }));
        expect(host.panel.addError).toHaveBeenCalledWith('Lighthouse: upstream timeout');
        expect(showVectorFailures).toHaveBeenCalledWith(BOOK, [{ title: 'Lighthouse', detail: 'upstream timeout' }]);
    });

    it('shows the writing on the progress panel: the entries to write, each one done, each failure, and the outcome', async () => {
        await selectBooks();
        host.ask = vi.fn(async messages => (messages[1].content.includes('Dunes') ? UNREADABLE : answerWith(['tidewardens'])));
        await storage.writeMissing(QDRANT, kinds.BOTH_KINDS);
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys and vectors', 2, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.updateCurrentItem.mock.calls.map(([bookName]) => bookName)).toEqual([BOOK, 'Desert Atlas']);
        expect(host.panel.updateProgress.mock.calls.map(([done]) => done)).toEqual([1, 2]);
        expect(host.panel.addError).toHaveBeenCalledWith('Dunes: its answer held no list of keys');
        expect(host.panel.complete).toHaveBeenCalledWith(false, 'Wrote the keys of 1 entry; 1 failed');
    });

    it('tells its run listeners as the run starts, with the entries to write, and as it ends, with what it did', async () => {
        await selectBooks();
        const seen = [];
        storage.onWritingRunChange(run => seen.push(run));
        await storage.writeMissing(QDRANT, kinds.BOTH_KINDS);
        expect(seen).toEqual([{ count: 2, outcome: null }, { count: 2, outcome: outcomeOf({ keysWritten: 2, unreadBooks: 1 }) }]);
    });

    it('tells its progress listeners the book it writes now, the kind, and its entries done of those to write, then nothing once it ends', async () => {
        await selectBooks({ isVectorized: false });
        const seen = [];
        storage.onWritingProgress(progress => seen.push(progress && `${progress.bookName}: ${progress.kind} ${progress.done} of ${progress.total}`));
        await storage.writeMissing(QDRANT, kinds.BOTH_KINDS);
        expect(seen).toEqual([
            `${BOOK}: keys 0 of 1`, `${BOOK}: keys 1 of 1`, `${BOOK}: vectors 0 of 2`, `${BOOK}: vectors 1 of 2`, `${BOOK}: vectors 2 of 2`,
            'Desert Atlas: keys 0 of 1', 'Desert Atlas: keys 1 of 1', 'Desert Atlas: vectors 0 of 1', 'Desert Atlas: vectors 1 of 1', null,
        ]);
    });

    it('shows no panel, tells no run listener and locks nothing when no selected entry lacks keys or vectors', async () => {
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK]) };
        const { lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
        const seen = [];
        storage.onWritingRunChange(run => seen.push(run));
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS, { pending: { books: [], count: 0, unreadBooks: 0 } })).toEqual(outcomeOf({}));
        expect(host.panel.show).not.toHaveBeenCalled();
        expect(seen).toEqual([]);
        expect(lockKeyedBooks).not.toHaveBeenCalled();
    });

    it('reads where to lock as the run starts, then locks the books it wrote keys for there and tells the run listeners', async () => {
        const loadWorldInfo = await selectBooks();
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: 'wren.png', lockableBookNames: new Set([BOOK, 'Desert Atlas']) };
        const { keyRunLockPlace, lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
        // Desert Atlas's one entry fails, so only Harbor Atlas has keys written.
        host.ask = vi.fn(async messages => (messages[1].content.includes('Dunes') ? UNREADABLE : answerWith(['tidewardens'])));
        const seen = [];
        storage.onWritingRunChange(run => seen.push(run.outcome?.chatLock));

        const outcome = await storage.writeMissing(QDRANT, kinds.BOTH_KINDS, { booksWithChosenLocks: ['Lost Atlas'] });
        expect(keyRunLockPlace).toHaveBeenCalledWith(['Lost Atlas']);
        expect(keyRunLockPlace.mock.invocationCallOrder[0]).toBeLessThan(loadWorldInfo.mock.invocationCallOrder[0]);
        expect(lockKeyedBooks).toHaveBeenCalledWith(host.lockPlace, [BOOK]);
        expect(outcome).toEqual(outcomeOf({ keysWritten: 1, failed: 1, unreadBooks: 1, chatLock: { chatId: 'chat-harbor', bookNames: [BOOK] } }));
        expect(seen).toEqual([undefined, { chatId: 'chat-harbor', bookNames: [BOOK] }]);
    });

    it('locks no book a run wrote vectors alone for', async () => {
        await selectBooks({ isVectorized: false });
        stored = { [BOOK]: { 0: ['lighthouse'], 1: ['tidewardens'] }, 'Desert Atlas': { 5: ['dunes'] } };
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK, 'Desert Atlas']) };
        const { lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
        expect(await storage.writeMissing(QDRANT, kinds.BOTH_KINDS)).toEqual(outcomeOf({ vectorsWritten: 3, unreadBooks: 1 }));
        expect(host.ask).not.toHaveBeenCalled();
        expect(lockKeyedBooks).toHaveBeenCalledWith(host.lockPlace, []);
    });

    it("the panel's Stop drops the entries not yet sent, back to no keys, and the run says how many it stopped", async () => {
        const entries = Array.from({ length: 9 }, (_, uid) => entry(uid, `Pier ${uid}`));
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const running = storage.writeMissing(QDRANT, kinds.BOTH_KINDS, { pending: { books: [{ bookName: BOOK, keyEntries: entries }], count: 9, unreadBooks: 0 } });
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(6));

        host.panel.stop();
        expect(keysModule.keyStateOf(BOOK, '8')).toEqual({ status: 'missing' });
        answers.forEach((resolve, index) => resolve(answerWith([`pier ${index}`])));
        expect(await running).toEqual(outcomeOf({ keysWritten: 6, stopped: 3 }));
        expect(host.ask).toHaveBeenCalledTimes(6);
        expect(host.panel.complete).toHaveBeenCalledWith(false, 'Wrote the keys of 6 entries; 3 stopped');
    });

    it('Stop leaves the vectors of the entries not yet written unsent, each counted stopped', async () => {
        const entries = [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')];
        stored[BOOK] = { 0: ['lighthouse'] };
        await keysModule.readBookKeys([BOOK]);
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const running = storage.writeMissing(QDRANT, kinds.BOTH_KINDS, {
            pending: { books: [{ bookName: BOOK, decidedEntries: entries, keyEntries: [entries[1]], vectorEntries: entries }], count: 2, unreadBooks: 0 },
        });
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));
        host.panel.stop();
        answers[0](answerWith(['tidewardens']));
        expect(await running).toEqual(outcomeOf({ keysWritten: 1, stopped: 2 }));
    });

    it('Regenerate keys rewrites the given entries under the progress panel, keys or not, writing no vectors, and locks nothing', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        await keysModule.readBookKeys([BOOK]);
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK]) };
        const { keyRunLockPlace } = await import('../src/features/lorebase/lorebase-chat-books.js');
        const { writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        const seen = [];
        storage.onWritingRunChange(run => seen.push(run.outcome));
        expect(await storage.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')], QDRANT))
            .toEqual(outcomeOf({ keysWritten: 2 }));
        expect(stored[BOOK]).toEqual({ 0: ['keys from Lighthouse'], 1: ['keys from Tidewardens'] });
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys', 2, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.stop).toEqual(expect.any(Function));
        expect(seen).toEqual([null, outcomeOf({ keysWritten: 2 })]);
        expect(keyRunLockPlace).not.toHaveBeenCalled();
        expect(writeBookVectors).not.toHaveBeenCalled();
    });

    it('runs one writing run on the panel at a time: a second is refused and brings the running one up, on the same entries or nothing to write too', async () => {
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const first = storage.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));

        await expect(storage.regenerateKeysOfEntries(BOOK, [entry(1, 'Tidewardens')], QDRANT)).rejects.toThrow(STILL_WRITING);
        await expect(storage.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse')], QDRANT)).rejects.toThrow(STILL_WRITING);
        await expect(storage.writeMissing(QDRANT, [kinds.VECTORS], {
            pending: { books: [{ bookName: BOOK, vectorEntries: [entry(1, 'Tidewardens')] }], count: 1, unreadBooks: 0 },
        })).rejects.toThrow(STILL_WRITING);
        await expect(storage.writeMissing(QDRANT, [kinds.VECTORS], { pending: { books: [], count: 0, unreadBooks: 0 } }))
            .rejects.toThrow(STILL_WRITING);
        expect(host.panel.reopen).toHaveBeenCalledTimes(4);
        answers[0](answerWith(['lighthouse']));
        await first;
        expect(await storage.regenerateKeysOfEntries(BOOK, [], QDRANT)).toEqual(outcomeOf({}));
    });
});

describe('deleting', () => {
    // What Similharity lists: Harbor Atlas's tenants in both collections, and one of a book with no record.
    const LISTED_TENANTS = [
        { book: BOOK, collection: 'vf_lorebase_rabbit', tenant: 'harbor-own', pointCount: 4 },
        { book: BOOK, collection: 'vectfox_main', tenant: 'harbor-shared', pointCount: 2 },
        { book: 'Imported Atlas', collection: 'vf_lorebase_rabbit', tenant: 'imported-own', pointCount: 3 },
    ];

    it('Delete all deletes every tenant Similharity lists, a book with no record and the other collection included, then every key, and forgets them', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { deleteTenantPoints, forgetVectorWriteFailures } = await import('../src/features/lorebase/lorebase-vectors.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: oneSelectionRecord({ selectedUids: ['0'] }), 'Desert Atlas': oneSelectionRecord({ selectedUids: [] }) };
        host.listing = { keys: [], vectors: LISTED_TENANTS };
        stored = { [BOOK]: { 0: ['lighthouse'], 1: ['tidewardens'] }, 'Desert Atlas': { 5: ['dunes'] } };
        await keysModule.readBookKeys([BOOK]);
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(bookName));

        expect(await storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).toBe(3);
        expect(deleteTenantPoints.mock.calls).toEqual(LISTED_TENANTS.map(({ tenant, collection }) => [tenant, collection, QDRANT]));
        expect(forgetVectorWriteFailures).toHaveBeenCalledTimes(1);
        expect(deleteTenantPoints.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(globalThis.fetch).mock.invocationCallOrder.at(-1));
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: {} });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'missing' });
        expect(seen).toEqual([BOOK]);
    });

    it('deletes only the kind asked for', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        host.listing = { keys: [], vectors: LISTED_TENANTS };
        stored = { [BOOK]: { 0: ['lighthouse'] } };
        expect(await storage.deleteStored([kinds.VECTORS], QDRANT)).toBe(0);
        expect(deleteTenantPoints).toHaveBeenCalledTimes(3);
        expect(routeCalls.map(call => call.url)).toEqual(['/api/plugins/similharity/lorebase/books']);

        expect(await storage.deleteStored([kinds.KEYS], QDRANT)).toBe(1);
        expect(deleteTenantPoints).toHaveBeenCalledTimes(3);
        expect(routeCalls.map(call => call.url).at(-1)).toBe('/api/plugins/similharity/lorebase/keys/delete');
    });

    it('stops before the keys when a tenant will not go, and is refused off Qdrant, as Remove is', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        host.listing = { keys: [], vectors: LISTED_TENANTS };
        deleteTenantPoints.mockRejectedValueOnce(new Error('Similharity could not delete the vectors of harbor-own in vf_lorebase_rabbit. The console says why.'));
        await expect(storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).rejects.toThrow('could not delete the vectors of harbor-own');
        expect(routeCalls.some(call => call.url.endsWith('/keys/delete'))).toBe(false);

        routeCalls.length = 0;
        await expect(storage.deleteStored(kinds.BOTH_KINDS, { vector_backend: 'standard' })).rejects.toThrow('Choose Qdrant as the vector backend');
        expect(routeCalls).toEqual([]);
    });

    it('is refused while keys are being written, and deletes nothing', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());

        await expect(storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).rejects.toThrow(STILL_WRITING);
        expect(host.panel.reopen).toHaveBeenCalledTimes(1);
        expect(deleteTenantPoints).not.toHaveBeenCalled();
        expect(routeCalls.some(call => call.url.endsWith('/delete'))).toBe(false);
        answer(answerWith(['lighthouse']));
        await writing;
    });

    it('says what Similharity answered when it cannot list what to delete, deletes nothing, and keeps knowing the keys', async () => {
        stored[BOOK] = { 0: ['lighthouse'] };
        await keysModule.readBookKeys([BOOK]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }));
        await expect(storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).rejects.toThrow("Similharity could not list LoreBase's books (HTTP 500)");
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['lighthouse'] });
    });
});

describe("the Database Browser's rows", () => {
    const keysRowOf = (fields = {}) => ({ key: `keys|${BOOK}`, kind: kinds.KEYS, book: BOOK, hasRecord: true, isInSillyTavern: true, entryCount: 1, ...fields });
    const vectorsRowOf = (fields = {}) => ({
        key: 'vectors|vf_lorebase_rabbit|harbor', kind: kinds.VECTORS, book: BOOK, hasRecord: true, isInSillyTavern: true,
        collection: 'vf_lorebase_rabbit', tenant: 'vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm', isHere: true, pointCount: 2,
        embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3', ...fields,
    });
    const OPENROUTER = { ...QDRANT, embedding_provider: 'openrouter' };
    const vectorsFileOf = (points, source = 'openrouter') => ({
        type: 'vectfox-lorebase-vectors', book: { name: BOOK }, exportDate: '2026-11-19T00:00:00.000Z',
        embedding: { source, model: 'baai/bge-m3', dimension: 2 }, points,
    });

    it("reads them from Similharity's listing once Qdrant is ready, with each book's selected entries LoreBase decides, and none off Qdrant", async () => {
        await selectBooks();
        host.worldNames.push(BOOK, 'Desert Atlas');
        host.listing = {
            keys: [{ book: BOOK, entryCount: 1 }],
            vectors: [{ collection: 'vf_lorebase_rabbit', tenant: 'vf_lorebase_qdrant_rabbit_harbor', book: BOOK, pointCount: 4, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' }],
        };
        const rows = await storage.loreBaseStorageRows(QDRANT);
        // Lost Atlas and Unused Atlas have records, but neither a book in SillyTavern nor anything stored. Harbor Atlas
        // selects 3 entries, its constant one SillyTavern's, so LoreBase decides 2, as the WorldInfo page's row counts them.
        expect(rows.map(row => [row.kind, row.book, row.selectedCount, row.isLeftover, row.kind === kinds.KEYS ? row.entryCount : row.pointCount])).toEqual([
            ['keys', 'Desert Atlas', 1, false, 0], ['vectors', 'Desert Atlas', 1, false, 0],
            ['keys', BOOK, 2, false, 1], ['vectors', BOOK, 2, false, 4],
        ]);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/books', request: {} });
        expect(host.getBackend).toHaveBeenCalledWith(expect.any(Object), 'qdrant');

        routeCalls.length = 0;
        expect(await storage.loreBaseStorageRows({ vector_backend: 'standard' })).toEqual([]);
        expect(routeCalls).toEqual([]);
    });

    it('names the books with Remove from LoreBase by the rule the rows are listed by: a record, keys, or vectors in the collection read now', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: oneSelectionRecord({ selectedUids: [] }) };
        host.listing = {
            keys: [{ book: 'Imported Atlas', entryCount: 3 }],
            vectors: [
                { collection: 'vectfox_main', tenant: 'elsewhere', book: 'Shared Atlas', pointCount: 2 },
                { collection: 'vf_lorebase_rabbit', tenant: 'here', book: 'Vector Atlas', pointCount: 2 },
            ],
        };
        const names = [BOOK, 'Imported Atlas', 'Shared Atlas', 'Vector Atlas', 'Plain Atlas'];
        expect([...await storage.removableLoreBookNames(names, QDRANT)]).toEqual([BOOK, 'Imported Atlas', 'Vector Atlas']);
        routeCalls.length = 0;
        expect([...await storage.removableLoreBookNames(names, { vector_backend: 'standard' })]).toEqual([]);
        expect(routeCalls).toEqual([]);
    });

    it("finds the row a file the global Import takes goes to: the book's own, or the one it would have, never a book SillyTavern lacks", async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        await selectBooks();
        host.worldNames.push(BOOK, 'Desert Atlas', 'Lantern Atlas');
        const listed = [keysRowOf({ selectedCount: 3, isLeftover: false }), vectorsRowOf({ selectedCount: 3, isLeftover: false })];
        const leftover = vectorsRowOf({ key: 'vectors|vectfox_main|harbor', collection: 'vectfox_main', isHere: false, isLeftover: true });
        expect(storage.loreBaseImportRow(kinds.KEYS, BOOK, [leftover, ...listed], QDRANT)).toBe(listed[0]);
        expect(storage.loreBaseImportRow(kinds.VECTORS, BOOK, [leftover, ...listed], QDRANT)).toBe(listed[1]);

        expect(storage.loreBaseImportRow(kinds.KEYS, 'Lantern Atlas', listed, QDRANT)).toEqual({
            key: 'keys|Lantern Atlas', kind: kinds.KEYS, book: 'Lantern Atlas', hasRecord: false, selectedCount: 0, selectionCount: 0, isInSillyTavern: true,
            isLeftover: false, entryCount: 0,
        });
        extension_settings.vectfox.lorebase_books['Lantern Atlas'] = oneSelectionRecord({ selectedUids: ['4'] });
        expect(storage.loreBaseImportRow(kinds.VECTORS, 'Lantern Atlas', [], { ...QDRANT, qdrant_multitenancy: true })).toMatchObject({
            kind: kinds.VECTORS, book: 'Lantern Atlas', hasRecord: true, selectedCount: 1, selectionCount: 1, collection: 'vectfox_main', tenant: null, isHere: true,
            pointCount: 0,
        });

        expect(() => storage.loreBaseImportRow(kinds.KEYS, 'Lost Atlas', listed, QDRANT))
            .toThrow('SillyTavern has no lorebook named "Lost Atlas". Bring the lorebook into SillyTavern first, or use Import on the keys row of the lorebook you want this file in.');
        expect(() => storage.loreBaseImportRow(kinds.KEYS, BOOK, listed, { vector_backend: 'standard' }))
            .toThrow("LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.");
    });

    it("exports a book's keys, each title from SillyTavern's book or the stored one, an entry with neither left out", async () => {
        await selectBooks();
        stored[BOOK] = { 0: ['lighthouse'], 7: ['gone entry'], 8: ['no title'] };
        storedTitles[BOOK] = { 7: 'Old pier' };
        const exported = await storage.exportStored(keysRowOf(), QDRANT);
        expect(exported.file).toMatchObject({ version: '1.0.0', generator: 'VectFox', type: 'vectfox-lorebase-keys', book: { name: BOOK } });
        expect(exported.file.entries).toEqual([{ uid: '0', title: 'Lighthouse', keys: ['lighthouse'] }, { uid: '7', title: 'Old pier', keys: ['gone entry'] }]);
        expect([exported.count, exported.leftOutCount]).toEqual([2, 1]);
        expect(host.ask).not.toHaveBeenCalled();
    });

    it("exports a tenant's points with their vectors, from the collection its row names", async () => {
        const { readTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        host.tenantPoints = [{ hash: 11, text: 'Lighthouse\nThe lamp.', vector: [0.1, 0.2], metadata: { entryUid: '0', partNumber: 0, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' } }];
        const row = vectorsRowOf({ collection: 'vectfox_main', isHere: false });
        const exported = await storage.exportStored(row, QDRANT);
        expect(readTenantPoints).toHaveBeenCalledWith(row.tenant, 'vectfox_main', QDRANT);
        expect(exported.file.embedding).toEqual({ source: 'openrouter', model: 'baai/bge-m3', dimension: 2 });
        expect(exported.file.points).toEqual([{ hash: 11, uid: '0', partNumber: 0, text: 'Lighthouse\nThe lamp.', vector: [0.1, 0.2] }]);
        expect(exported.count).toBe(1);
    });

    it('imports a keys file onto the entries whose number and title match, selected or not, with no LLM call', async () => {
        await selectBooks();
        const file = { type: 'vectfox-lorebase-keys', book: { name: BOOK }, entries: [
            { uid: '0', title: 'Lighthouse', keys: ['beacon'] },
            { uid: '3', title: 'Pier', keys: ['jetty'] },
            { uid: '1', title: 'Another book\'s entry', keys: ['elsewhere'] },
        ] };
        const plan = await storage.planImport(keysRowOf(), file, QDRANT);
        expect([plan.writes.map(write => write.uid), plan.replaceCount, plan.unmatchedCount, plan.damagedCount]).toEqual([['0', '3'], 1, 1, 0]);

        expect(await storage.writeImport(plan, QDRANT)).toEqual({ written: 2, failed: 0, isEmbedded: false });
        expect(routeCalls.at(-1).request).toEqual({ book: BOOK, entries: [{ uid: '0', title: 'Lighthouse', keys: ['beacon'] }, { uid: '3', title: 'Pier', keys: ['jetty'] }] });
        expect(keysModule.keyStateOf(BOOK, '3')).toEqual({ status: 'ready', keys: ['jetty'] });
        expect(host.ask).not.toHaveBeenCalled();
        expect(host.panel.show).not.toHaveBeenCalled();
    });

    it('imports a vectors file of the model set now with its vectors, under the panel, onto the parts of its entries, selected or not', async () => {
        const vectorsModule = await import('../src/features/lorebase/lorebase-vectors.js');
        await selectBooks({ isVectorized: false });
        // Entry 3 is not selected; entry 2 is constant, so LoreBase decides it never.
        const [lighthouse, tideClock, pier] = vectorsModule.entriesWithPoints(BOOK, [entry(0, 'Lighthouse'), entry(2, 'Tide clock'), entry(3, 'Pier')]);
        const file = vectorsFileOf([
            { uid: '0', partNumber: 0, text: lighthouse.points[0].text, vector: [0.1, 0.2] },
            { uid: '3', partNumber: 0, text: pier.points[0].text, vector: [0.3, 0.4] },
            { uid: '2', partNumber: 0, text: tideClock.points[0].text, vector: [0.5, 0.6] },
        ]);
        const plan = await storage.planImport(vectorsRowOf(), file, OPENROUTER);
        expect([plan.writes.length, plan.unselectedCount, plan.unmatchedCount, plan.needsEmbedding]).toEqual([2, 1, 1, false]);
        expect(uidsOf(plan.decidedEntries)).toEqual([0, 1]);

        expect(await storage.writeImport(plan, OPENROUTER)).toEqual({ written: 2, failed: 0, isEmbedded: false });
        expect(vectorsModule.importBookPoints).toHaveBeenCalledWith(BOOK, plan.writes, OPENROUTER, expect.any(Function));
        expect(vectorsModule.writeBookVectors).not.toHaveBeenCalled();
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase vectors', 2, 'Parts', { unitLabel: 'Parts' });
        expect(host.panel.complete).toHaveBeenCalledWith(true, 'Wrote the vectors of 2 parts');
    });

    it("embeds the selected entries' matched parts again when the file was made by another model, as Generate vectors does", async () => {
        const vectorsModule = await import('../src/features/lorebase/lorebase-vectors.js');
        await selectBooks({ isVectorized: false });
        const [lighthouse, pier] = vectorsModule.entriesWithPoints(BOOK, [entry(0, 'Lighthouse'), entry(3, 'Pier')]);
        const plan = await storage.planImport(vectorsRowOf(), vectorsFileOf([
            { uid: '0', partNumber: 0, text: lighthouse.points[0].text, vector: [0.1, 0.2] },
            { uid: '3', partNumber: 0, text: pier.points[0].text, vector: [0.3, 0.4] },
        ], 'openai'), OPENROUTER);
        expect([plan.needsEmbedding, plan.uids, plan.unselectedCount]).toEqual([true, ['0'], 1]);

        expect(await storage.writeImport(plan, OPENROUTER)).toEqual({ written: 1, failed: 0, isEmbedded: true });
        expect(vectorsModule.importBookPoints).not.toHaveBeenCalled();
        expect(uidsOf(vectorsModule.writeBookVectors.mock.calls[0][2])).toEqual([0]);
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase vectors', 1, 'Entries', { unitLabel: 'Entries' });
    });

    it('refuses a file of another kind than its row, and writes nothing', async () => {
        await selectBooks();
        await expect(storage.planImport(keysRowOf(), vectorsFileOf([]), QDRANT)).rejects.toThrow('This is not a LoreBase keys file.');
        await expect(storage.planImport(vectorsRowOf(), { type: 'vectfox-lorebase-keys', entries: [] }, QDRANT)).rejects.toThrow('This is not a LoreBase vectors file.');
        expect(routeCalls.some(call => call.url.endsWith('/write'))).toBe(false);
    });

    it("deletes a row's keys alone, or one tenant in the collection its row names", async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        stored = { [BOOK]: { 0: ['beacon'], 1: ['tide'] }, 'Desert Atlas': { 5: ['dunes'] } };
        expect(await storage.deleteStoredRow(keysRowOf(), QDRANT)).toBe(2);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: { books: [BOOK] } });
        expect(stored).toEqual({ 'Desert Atlas': { 5: ['dunes'] } });

        const row = vectorsRowOf({ collection: 'vectfox_main', isHere: false, pointCount: 7 });
        expect(await storage.deleteStoredRow(row, QDRANT)).toBe(7);
        expect(deleteTenantPoints).toHaveBeenCalledWith(row.tenant, 'vectfox_main', QDRANT);
    });

    it('refuses an import or a row delete while LoreBase writes, and writes or deletes nothing', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        await selectBooks();
        const plan = await storage.planImport(keysRowOf(), { type: 'vectfox-lorebase-keys', entries: [{ uid: '0', title: 'Lighthouse', keys: ['beacon'] }] }, QDRANT);
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(1, 'Tidewardens')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());
        const writesBefore = routeCalls.filter(call => call.url.endsWith('/write')).length;

        await expect(storage.writeImport(plan, QDRANT)).rejects.toThrow(STILL_WRITING);
        await expect(storage.deleteStoredRow(vectorsRowOf(), QDRANT)).rejects.toThrow(STILL_WRITING);
        expect(routeCalls.filter(call => call.url.endsWith('/write'))).toHaveLength(writesBefore);
        expect(deleteTenantPoints).not.toHaveBeenCalled();
        answer(answerWith(['tidewardens']));
        await writing;
    });
});

describe('removing a book from LoreBase', () => {
    const HARBOR_TENANT = 'vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm';
    const OFF_QDRANT = "LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.";
    const tenantOf = (book, tenant, collection, pointCount) => ({ collection, tenant, book, pointCount, embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' });

    // Harbor Atlas: 3 selected entries, a pinned section, a lock on a chat and one on a character, the keys of 2 entries,
    // and vectors in the collection LoreBase reads now and in vectfox_main. Desert Atlas: a selection, nothing stored.
    // Wren Journal: keys and vectors, and no record.
    async function recordBooks() {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        extension_settings.vectfox.lorebase_books = {
            [BOOK]: oneSelectionRecord({
                selectedUids: ['0', '1', '2'], pinnedSections: ['Rules'], lockedToChatIds: ['Harbor Night'],
                lockedToCharacterAvatars: ['keeper-orrin.png'], seenUids: ['0', '1', '2', '3'],
            }),
            'Desert Atlas': oneSelectionRecord({ selectedUids: ['5'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] }),
        };
        host.listing = {
            keys: [{ book: BOOK, entryCount: 2 }, { book: 'Wren Journal', entryCount: 1 }],
            vectors: [
                tenantOf(BOOK, HARBOR_TENANT, 'vf_lorebase_rabbit', 5),
                tenantOf(BOOK, HARBOR_TENANT, 'vectfox_main', 2),
                tenantOf('Wren Journal', 'vf_lorebase_qdrant_rabbit_wren_journal_3k', 'vf_lorebase_rabbit', 4),
            ],
        };
        stored = { [BOOK]: { 0: ['beacon'], 1: ['tide'] }, 'Wren Journal': { 9: ['quill'] } };
        return extension_settings.vectfox.lorebase_books;
    }

    it("reads what the confirm names: the book's selection, pins and locks, its keys, and its vectors in each collection", async () => {
        await recordBooks();
        expect(await storage.loreBookHoldings(BOOK, QDRANT)).toEqual({
            bookName: BOOK, selectionCount: 1, selectedCount: 3, pinnedCount: 1, chatLockCount: 1, characterLockCount: 1, keyCount: 2,
            tenants: [
                { collection: 'vf_lorebase_rabbit', tenant: HARBOR_TENANT, pointCount: 5 },
                { collection: 'vectfox_main', tenant: HARBOR_TENANT, pointCount: 2 },
            ],
        });
        expect(await storage.loreBookHoldings('Lost Atlas', QDRANT)).toEqual({
            bookName: 'Lost Atlas', selectionCount: 0, selectedCount: 0, pinnedCount: 0, chatLockCount: 0, characterLockCount: 0, keyCount: 0, tenants: [],
        });
    });

    it('deletes its vectors in every collection, then its keys, then its record, and leaves every other book as it was', async () => {
        const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
        const { deleteTenantPoints, forgetBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        const records = await recordBooks();
        await keysModule.readBookKeys([BOOK]);
        saveSettingsDebounced.mockClear();

        expect(await storage.removeLoreBook(BOOK, QDRANT)).toEqual({ bookName: BOOK, keysDeleted: 2, partsDeleted: 7 });
        expect(deleteTenantPoints.mock.calls).toEqual([[HARBOR_TENANT, 'vf_lorebase_rabbit', QDRANT], [HARBOR_TENANT, 'vectfox_main', QDRANT]]);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: { books: [BOOK] } });
        expect(deleteTenantPoints.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(globalThis.fetch).mock.invocationCallOrder.at(-1));
        expect(stored).toEqual({ 'Wren Journal': { 9: ['quill'] } });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'missing' });
        expect(forgetBookVectors).toHaveBeenCalledWith(BOOK);
        expect(Object.keys(records)).toEqual(['Desert Atlas']);
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });

    it('removes a book holding nothing but its record, deleting no vectors', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        const records = await recordBooks();
        expect(await storage.removeLoreBook('Desert Atlas', QDRANT)).toEqual({ bookName: 'Desert Atlas', keysDeleted: 0, partsDeleted: 0 });
        expect(deleteTenantPoints).not.toHaveBeenCalled();
        expect(Object.keys(records)).toEqual([BOOK]);
        expect(stored[BOOK]).toEqual({ 0: ['beacon'], 1: ['tide'] });
    });

    it('is refused while LoreBase writes, before anything is read for the confirm, and deletes nothing', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        const records = await recordBooks();
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(3, 'Pier')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());

        await expect(storage.loreBookHoldings(BOOK, QDRANT)).rejects.toThrow(STILL_WRITING);
        await expect(storage.removeLoreBook(BOOK, QDRANT)).rejects.toThrow(STILL_WRITING);
        expect(routeCalls.some(call => call.url.endsWith('/books') || call.url.endsWith('/delete'))).toBe(false);
        expect(deleteTenantPoints).not.toHaveBeenCalled();
        expect(records[BOOK]).toBeDefined();
        answer(answerWith(['pier']));
        await writing;
    });

    it('is refused off Qdrant, where LoreBase keeps its keys and vectors, and deletes nothing', async () => {
        const records = await recordBooks();
        const STANDARD = { vector_backend: 'standard' };
        await expect(storage.loreBookHoldings(BOOK, STANDARD)).rejects.toThrow(OFF_QDRANT);
        await expect(storage.removeLoreBook(BOOK, STANDARD)).rejects.toThrow(OFF_QDRANT);
        expect(routeCalls).toEqual([]);
        expect(records[BOOK]).toBeDefined();
    });

    it('keeps its keys and its record when its vectors cannot be deleted, and its record when its keys cannot', async () => {
        const { deleteTenantPoints } = await import('../src/features/lorebase/lorebase-vectors.js');
        const records = await recordBooks();
        deleteTenantPoints.mockRejectedValueOnce(new Error(`Similharity could not delete the vectors of ${HARBOR_TENANT} in vf_lorebase_rabbit. The console says why.`));
        await expect(storage.removeLoreBook(BOOK, QDRANT)).rejects.toThrow('Similharity could not delete the vectors');
        expect(stored[BOOK]).toEqual({ 0: ['beacon'], 1: ['tide'] });
        expect(records[BOOK]).toBeDefined();

        const answerRoute = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url, init) => (url.endsWith('/delete')
            ? { ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }
            : answerRoute(url, init)));
        await expect(storage.removeLoreBook(BOOK, QDRANT)).rejects.toThrow("Similharity could not delete LoreBase's keys (HTTP 500)");
        expect(records[BOOK]).toBeDefined();
    });
});

describe("the entry editor's save", () => {
    const EDITED = { comment: 'Tidewardens', content: 'The wardens ring the harbor bell at dusk.' };
    let saveLorebookEntry;
    let writeBookVectors;

    beforeEach(async () => {
        ({ saveLorebookEntry } = await import('../src/sillytavern/world-info.js'));
        ({ writeBookVectors } = await import('../src/features/lorebase/lorebase-vectors.js'));
        saveLorebookEntry.mockClear();
    });

    it('saves the entry through SillyTavern, then writes the vectors of that entry alone, as saved, whether LoreBase is on or off', async () => {
        await selectBooks();
        const outcome = await storage.saveEntryWithVectors(BOOK, '1', EDITED, QDRANT);

        expect(saveLorebookEntry).toHaveBeenCalledWith(BOOK, '1', EDITED);
        expect(writeBookVectors).toHaveBeenCalledTimes(1);
        const [bookName, decidedEntries, entriesToWrite, settings] = writeBookVectors.mock.calls[0];
        expect([bookName, settings]).toEqual([BOOK, QDRANT]);
        // Every entry LoreBase decides, so what none holds goes: the constant entry 2 and the unselected 3 are not.
        expect(uidsOf(decidedEntries)).toEqual([0, 1]);
        expect(entriesToWrite).toEqual([{ uid: 1, ...EDITED }]);
        expect(outcome).toEqual({ isDecided: true, failure: null, vectorProblem: null });
    });

    it('says why the vectors failed, the entry saved', async () => {
        await selectBooks();
        host.vectorFailures.add('1');
        expect(await storage.saveEntryWithVectors(BOOK, '1', EDITED, QDRANT))
            .toEqual({ isDecided: true, failure: { title: 'Tidewardens', detail: 'upstream timeout' }, vectorProblem: null });
        expect(saveLorebookEntry).toHaveBeenCalledTimes(1);
    });

    it('saves an entry LoreBase does not decide alone, its book\'s vectors left as they are', async () => {
        await selectBooks();
        expect(await storage.saveEntryWithVectors(BOOK, '3', { comment: 'Pier', content: 'The old pier.' }, QDRANT))
            .toEqual({ isDecided: false, failure: null, vectorProblem: null });
        expect(saveLorebookEntry).toHaveBeenCalledTimes(1);
        expect(writeBookVectors).not.toHaveBeenCalled();
    });

    it('writes no vectors off Qdrant, and says why, the entry saved', async () => {
        await selectBooks();
        const outcome = await storage.saveEntryWithVectors(BOOK, '1', EDITED, { vector_backend: 'standard' });
        expect(outcome).toEqual({ isDecided: true, failure: null, vectorProblem: "LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page." });
        expect(saveLorebookEntry).toHaveBeenCalledTimes(1);
        expect(writeBookVectors).not.toHaveBeenCalled();
    });

    it('saves nothing while LoreBase writes', async () => {
        await selectBooks();
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(1, 'Tidewardens')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());

        await expect(storage.saveEntryWithVectors(BOOK, '1', EDITED, QDRANT)).rejects.toThrow(STILL_WRITING);
        expect(saveLorebookEntry).not.toHaveBeenCalled();
        expect(writeBookVectors).not.toHaveBeenCalled();
        answer(answerWith(['tidewardens']));
        await writing;
    });
});
