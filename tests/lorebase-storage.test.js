/**
 * LoreBase's storage module (src/features/lorebase/lorebase-storage.js, §3.1 of InternalProject/Vectfox/plans/
 * vectfox-multi-collection-per-chat.md): what the selected entries of every book with a selection lack, and how many of
 * each book's selected entries have keys and vectors; the progress panel's run of keys, vectors or both (§4.3 of
 * InternalProject/Vectfox/plans/lorebook-multi-vector.md), each entry counted once, whose Stop drops what is not yet
 * sent, telling its run listeners as it starts and ends, and Regenerate keys there; one run at a time. A run that
 * writes missing keys reads where to lock as it starts and then locks the books it wrote keys for there (§6.1); a run
 * of vectors alone and Regenerate keys lock nothing. Delete deletes every book's vectors, keys or both, never while
 * LoreBase writes, when it brings the panel up. Similharity's key routes are a fetch stand-in holding the keys in
 * memory, as lorebase-keys.test.js has them; the vectors are a stand-in for lorebase-vectors.js, which
 * lorebase-vectors.test.js holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    connection: { ok: true }, ask: null, panel: null, lockPlace: null, vectorized: new Set(), vectorFailures: new Set(),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: vi.fn() }));
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
// Where a run locks, and a lock that takes every book it is given: lorebase-chat-books.test.js holds which books lock.
vi.mock('../src/features/lorebase/lorebase-chat-books.js', () => ({
    keyRunLockPlace: vi.fn(() => host.lockPlace),
    lockKeyedBooks: vi.fn((place, keyedBookNames) => (place && keyedBookNames.length ? { chatId: place.chatId, bookNames: keyedBookNames } : null)),
}));
// An entry has its vectors once host.vectorized holds "book/uid"; writing adds it, and an entry in host.vectorFailures fails.
vi.mock('../src/features/lorebase/lorebase-vectors.js', () => {
    const noVectorsOf = async bookNames => new Map(bookNames.map(bookName => [bookName, new Map()]));
    return {
        bookVectors: vi.fn(noVectorsOf),
        readBookVectors: vi.fn(noVectorsOf),
        uidsWithCurrentVectors: vi.fn((bookName, entries) => new Set(entries.map(entry => String(entry.uid)).filter(uid => host.vectorized.has(`${bookName}/${uid}`)))),
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
        deleteAllVectors: vi.fn(async () => host.vectorized.clear()),
        showVectorFailures: vi.fn(),
    };
});

const BOOK = 'Harbor Atlas';
const entry = (uid, comment) => ({ uid, comment, content: `${comment} stands by the harbor.` });
const QDRANT = { vector_backend: 'qdrant' };
const STILL_WRITING = 'LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.';

let stored;
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
    routeCalls = [];
    globalThis.fetch = vi.fn(async (url, { body }) => {
        const request = JSON.parse(body);
        routeCalls.push({ url, request });
        if (url.endsWith('/read')) {
            return { ok: true, json: async () => ({ books: Object.fromEntries(request.books.map(book => [book, { ...(stored[book] ?? {}) }])) }) };
        }
        if (url.endsWith('/delete')) {
            const deleted = Object.values(stored).reduce((count, book) => count + Object.keys(book).length, 0);
            stored = {};
            return { ok: true, json: async () => ({ deleted }) };
        }
        for (const { uid, keys } of request.entries) (stored[request.book] ??= {})[uid] = keys;
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
    for (const name of ['bookVectors', 'readBookVectors', 'uidsWithCurrentVectors', 'writeBookVectors', 'deleteAllVectors', 'showVectorFailures']) {
        vectorsModule[name].mockClear();
    }
});

// Harbor Atlas selects 0, 1 and a constant entry 2, entry 0 with keys; Desert Atlas selects 5; Lost Atlas cannot be
// loaded; Unused Atlas selects nothing. Without isVectorized, no entry has vectors.
async function selectBooks({ isVectorized = true } = {}) {
    const { extension_settings } = await import('../src/sillytavern/settings.js');
    const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
    extension_settings.vectfox.lorebase_books = {
        [BOOK]: { selectedUids: ['0', '1', '2'] }, 'Desert Atlas': { selectedUids: ['5'] },
        'Lost Atlas': { selectedUids: ['1'] }, 'Unused Atlas': { selectedUids: [] },
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
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['0', '1'] } };
        loadWorldInfo.mockImplementation(async () => ({ entries: { 0: entry(0, 'Lighthouse'), 1: { uid: 1, comment: 'Buoy Line', content: '' } } }));
        const pending = await storage.selectedEntriesNotReady(QDRANT);
        expect(pending.books.map(book => uidsOf(book.keyEntries))).toEqual([[0]]);
        expect(pending.count).toBe(1);
    });

    it('never counts an entry kept with no keys as missing', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['4'] } };
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
        expect(await storage.storedCountsOfBooks([BOOK, 'Desert Atlas'], QDRANT)).toEqual(new Map([
            [BOOK, { keyCount: 1, vectorCount: 1 }],
            ['Desert Atlas', { keyCount: 0, vectorCount: 1 }],
        ]));
    });

    it('reads nothing off Qdrant, where LoreBase keeps neither, or while VectFox is off', async () => {
        const loadWorldInfo = await selectBooks();
        expect(await storage.storedCountsOfBooks([BOOK], { vector_backend: 'standard' })).toEqual(new Map());
        expect(await storage.storedCountsOfBooks([BOOK], { ...QDRANT, enabled: false })).toEqual(new Map());
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });
});

describe('what each kind needs', () => {
    it("needs Qdrant and LoreBase's model for keys, and only Qdrant for vectors", () => {
        expect(storage.writingProblem(QDRANT, [kinds.KEYS])).toBeNull();
        expect(storage.writingProblem({ vector_backend: 'standard' }, kinds.BOTH_KINDS)).toContain('Choose Qdrant as the vector backend');
        expect(storage.writingProblem({ vector_backend: 'standard' }, [kinds.VECTORS]))
            .toBe('LoreBase keeps the vectors of each entry in Qdrant. Choose Qdrant as the vector backend first.');
        host.connection = { ok: false, reason: 'no_model', problem: 'LoreBase has no model.' };
        expect(storage.writingProblem(QDRANT, [kinds.KEYS])).toBe('LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.');
        expect(storage.writingProblem(QDRANT, [kinds.VECTORS])).toBeNull();
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

    it('runs one writing run on the panel at a time: a second is refused and brings the running one up', async () => {
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const first = storage.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));

        await expect(storage.regenerateKeysOfEntries(BOOK, [entry(1, 'Tidewardens')], QDRANT)).rejects.toThrow(STILL_WRITING);
        await expect(storage.writeMissing(QDRANT, [kinds.VECTORS], {
            pending: { books: [{ bookName: BOOK, vectorEntries: [entry(1, 'Tidewardens')] }], count: 1, unreadBooks: 0 },
        })).rejects.toThrow(STILL_WRITING);
        expect(host.panel.reopen).toHaveBeenCalledTimes(2);
        answers[0](answerWith(['lighthouse']));
        await first;
        expect(await storage.regenerateKeysOfEntries(BOOK, [], QDRANT)).toEqual(outcomeOf({}));
    });
});

describe('deleting', () => {
    it('Delete all deletes every vector, then every key the user has, forgets the keys it knew, and tells the listeners', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { deleteAllVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['0'] }, 'Desert Atlas': { selectedUids: [] } };
        stored = { [BOOK]: { 0: ['lighthouse'], 1: ['tidewardens'] }, 'Desert Atlas': { 5: ['dunes'] } };
        await keysModule.readBookKeys([BOOK]);
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(bookName));

        expect(await storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).toBe(3);
        expect(deleteAllVectors).toHaveBeenCalledWith([BOOK, 'Desert Atlas'], QDRANT);
        expect(deleteAllVectors.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(globalThis.fetch).mock.invocationCallOrder.at(-1));
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: {} });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'missing' });
        expect(seen).toEqual([BOOK]);
    });

    it('deletes only the kind asked for', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { deleteAllVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['0'] } };
        stored = { [BOOK]: { 0: ['lighthouse'] } };
        expect(await storage.deleteStored([kinds.VECTORS], QDRANT)).toBe(0);
        expect(deleteAllVectors).toHaveBeenCalledTimes(1);
        expect(routeCalls).toEqual([]);

        expect(await storage.deleteStored([kinds.KEYS], QDRANT)).toBe(1);
        expect(deleteAllVectors).toHaveBeenCalledTimes(1);
        expect(routeCalls.map(call => call.url)).toEqual(['/api/plugins/similharity/lorebase/keys/delete']);
    });

    it('is refused while keys are being written, and deletes nothing', async () => {
        const { deleteAllVectors } = await import('../src/features/lorebase/lorebase-vectors.js');
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());

        await expect(storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).rejects.toThrow(STILL_WRITING);
        expect(host.panel.reopen).toHaveBeenCalledTimes(1);
        expect(deleteAllVectors).not.toHaveBeenCalled();
        expect(routeCalls.some(call => call.url.endsWith('/delete'))).toBe(false);
        answer(answerWith(['lighthouse']));
        await writing;
    });

    it('says what Similharity answered when the keys cannot be deleted, and keeps knowing them', async () => {
        stored[BOOK] = { 0: ['lighthouse'] };
        await keysModule.readBookKeys([BOOK]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }));
        await expect(storage.deleteStored(kinds.BOTH_KINDS, QDRANT)).rejects.toThrow("Similharity could not delete LoreBase's keys (HTTP 500)");
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['lighthouse'] });
    });
});
