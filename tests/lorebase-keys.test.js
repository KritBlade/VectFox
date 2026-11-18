/**
 * LoreBase's keys (src/features/lorebase/lorebase-keys.js, plan D15 and D17 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): written for entries that have none, or for every one given on
 * Regenerate keys, at most 6 calls at once, an unreadable answer asked again up to 3 asks; each written entry's keys go to
 * Similharity's key route, a failed one is marked and named in a toast; and nothing is written off Qdrant or without
 * LoreBase's model. Generate all keys writes the missing keys of every book with a selection under the progress panel,
 * whose Stop drops the entries not yet sent, telling its run listeners as it starts and ends, and Regenerate keys
 * rewrites the given entries there; one run at a time. A run that writes missing keys reads where to lock as it starts
 * and then locks the books it wrote keys for there (§6.1 of InternalProject/Vectfox/plans/lorebook-multi-vector.md);
 * Regenerate keys locks nothing. Delete all keys deletes every key, never while keys are written, when it names how
 * many are left and brings the panel up.
 * Similharity's routes are a fetch stand-in holding the keys in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ connection: { ok: true }, ask: null, panel: null, lockPlace: null }));

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
// Where a run locks, and a lock that takes every book it is given: lorebase-chat-books.test.js holds which books lock.
vi.mock('../src/features/lorebase/lorebase-chat-books.js', () => ({
    keyRunLockPlace: vi.fn(() => host.lockPlace),
    lockKeyedBooks: vi.fn((place, keyedBookNames) => (place && keyedBookNames.length ? { chatId: place.chatId, bookNames: keyedBookNames } : null)),
}));

const BOOK = 'Harbor Atlas';
const entry = (uid, comment) => ({ uid, comment, content: `${comment} stands by the harbor.` });
const QDRANT = { vector_backend: 'qdrant' };

let stored;
let routeCalls;
let keysModule;

function answerWith(keys) {
    return [{ keys }];
}

// An answer parseJsonArrayFromLlm reads with no list of keys in it.
const UNREADABLE = [{ names: [] }];

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
    host.panel ={ show: vi.fn(), updateCurrentItem: vi.fn(), updateProgress: vi.fn(), addError: vi.fn(), complete: vi.fn(), reopen: vi.fn(), stop: null };
    host.ask = vi.fn(async messages => answerWith([`keys from ${messages[1].content.split('\n')[2].split(' ')[0]}`]));
    keysModule = await import('../src/features/lorebase/lorebase-keys.js');
    // A mocked module outlives resetModules, its calls with it.
    const { keyRunLockPlace, lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
    keyRunLockPlace.mockClear();
    lockKeyedBooks.mockClear();
});

describe('writing keys', () => {
    it('reads what Qdrant holds first, writes only the entries with none, and marks them ready', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        const result = await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')], QDRANT);

        expect(result).toEqual({ written: 1, failed: 0, stopped: 0 });
        expect(host.ask).toHaveBeenCalledTimes(1);
        expect(routeCalls.map(call => call.url)).toEqual(['/api/plugins/similharity/lorebase/keys/read', '/api/plugins/similharity/lorebase/keys/write']);
        expect(routeCalls[1].request).toEqual({ book: BOOK, entries: [{ uid: '1', keys: ['keys from Tidewardens'] }] });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['old keys'] });
        expect(keysModule.keyStateOf(BOOK, '1')).toEqual({ status: 'ready', keys: ['keys from Tidewardens'] });
    });

    it('asks with the keys request: room for the answer and thinking, the model\'s own effort, keys marking the record', async () => {
        await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        expect(host.ask.mock.calls[0][1]).toEqual({ maxTokens: 11000, reasoningEffort: null, identKeys: ['keys'] });
    });

    it('writes every entry given again on Regenerate keys, keys or not', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        await keysModule.readBookKeys([BOOK]);
        const result = await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')], QDRANT, { isRegenerating: true });

        expect(result).toEqual({ written: 2, failed: 0, stopped: 0 });
        expect(stored[BOOK]).toEqual({ 0: ['keys from Lighthouse'], 1: ['keys from Tidewardens'] });
    });

    it('asks an unreadable answer again, up to 3 asks, then marks the entry failed and names it in a toast', async () => {
        host.ask = vi.fn(async () => UNREADABLE);
        const result = await keysModule.writeKeys(BOOK, [entry(4, 'Drowned Bell')], QDRANT);

        expect(result).toEqual({ written: 0, failed: 1, stopped: 0 });
        expect(host.ask).toHaveBeenCalledTimes(3);
        expect(keysModule.keyStateOf(BOOK, '4')).toEqual({ status: 'failed', detail: 'its answer held no list of keys' });
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('could not write the keys of "Drowned Bell" in lorebook "Harbor Atlas"');
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('Regenerate keys');
    });

    it('keeps an answer of no keys at once, as an empty list, with no second ask and no toast', async () => {
        host.ask = vi.fn(async () => answerWith([]));
        const result = await keysModule.writeKeys(BOOK, [entry(4, 'Section marker')], QDRANT);

        expect(result).toEqual({ written: 1, failed: 0, stopped: 0 });
        expect(host.ask).toHaveBeenCalledTimes(1);
        expect(stored[BOOK]).toEqual({ 4: [] });
        expect(keysModule.keyStateOf(BOOK, '4')).toEqual({ status: 'ready', keys: [] });
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('never counts an entry kept with no keys as missing', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['4'] } };
        loadWorldInfo.mockImplementation(async () => ({ entries: { 4: entry(4, 'Section marker') } }));
        stored[BOOK] = { 4: [] };
        expect((await keysModule.selectedEntriesWithoutKeys()).count).toBe(0);
    });

    it('takes a failed call as an ask, and writes the keys once a later ask answers', async () => {
        host.ask = vi.fn().mockRejectedValueOnce(new Error('upstream timeout')).mockResolvedValue(answerWith(['bell']));
        const result = await keysModule.writeKeys(BOOK, [entry(4, 'Drowned Bell')], QDRANT);

        expect(result).toEqual({ written: 1, failed: 0, stopped: 0 });
        expect(host.ask).toHaveBeenCalledTimes(2);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('runs at most 6 key calls at once', async () => {
        let running = 0;
        let most = 0;
        host.ask = vi.fn(async () => {
            running += 1;
            most = Math.max(most, running);
            await new Promise(resolve => setTimeout(resolve, 5));
            running -= 1;
            return answerWith(['harbor']);
        });
        const entries = Array.from({ length: 14 }, (_, uid) => entry(uid, `Pier ${uid}`));
        const result = await keysModule.writeKeys(BOOK, entries, QDRANT);

        expect(result).toEqual({ written: 14, failed: 0, stopped: 0 });
        expect(most).toBe(6);
    });

    it('runs as many key calls at once as Entries at once says, held to 8', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        let running = 0;
        let most = 0;
        host.ask = vi.fn(async () => {
            running += 1;
            most = Math.max(most, running);
            await new Promise(resolve => setTimeout(resolve, 5));
            running -= 1;
            return answerWith(['harbor']);
        });
        const entries = Array.from({ length: 12 }, (_, uid) => entry(uid, `Pier ${uid}`));
        extension_settings.vectfox.lorebase_key_calls_at_once = 2;
        await keysModule.writeKeys(BOOK, entries, QDRANT);
        expect(most).toBe(2);

        most = 0;
        extension_settings.vectfox.lorebase_key_calls_at_once = 40;
        await keysModule.writeKeys('Desert Atlas', entries, QDRANT);
        expect(most).toBe(8);
        delete extension_settings.vectfox.lorebase_key_calls_at_once;
    });

    it('tells its listeners when an entry starts being written and when it is done', async () => {
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(`${bookName}: ${keysModule.keyStateOf(bookName, '0').status}`));
        await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        expect(seen).toEqual([`${BOOK}: writing`, `${BOOK}: ready`]);
    });
});

describe("editing one entry's keys", () => {
    it("regenerates an entry's keys from the model and stores nothing", async () => {
        expect(await keysModule.regenerateKeys(entry(2, 'Tide clock'), QDRANT)).toEqual(['keys from Tide']);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(keysModule.keyStateOf(BOOK, '2')).toEqual({ status: 'missing' });
    });

    it('regenerates nothing off Qdrant or without the model, and keeps a refused model\'s kind', async () => {
        await expect(keysModule.regenerateKeys(entry(2, 'Tide clock'), { vector_backend: 'standard' })).rejects.toThrow('Choose Qdrant as the vector backend');
        host.ask = vi.fn(async () => { throw Object.assign(new Error('The model openai/gpt-7 does not exist.'), { kind: 'model_config' }); });
        await expect(keysModule.regenerateKeys(entry(2, 'Tide clock'), QDRANT)).rejects.toMatchObject({ kind: 'model_config' });
        expect(host.ask).toHaveBeenCalledTimes(1);
    });

    it('stores the keys the user edited in place of a failed state, and tells the listeners', async () => {
        host.ask = vi.fn(async () => UNREADABLE);
        await keysModule.writeKeys(BOOK, [entry(4, 'Drowned Bell')], QDRANT);
        expect(keysModule.keyStateOf(BOOK, '4').status).toBe('failed');
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(keysModule.keyStateOf(bookName, '4')));

        await keysModule.saveEditedKeys(BOOK, 4, ['drowned bell', 'bell tower']);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/write', request: { book: BOOK, entries: [{ uid: '4', keys: ['drowned bell', 'bell tower'] }] } });
        expect(stored[BOOK]['4']).toEqual(['drowned bell', 'bell tower']);
        expect(seen).toEqual([{ status: 'ready', keys: ['drowned bell', 'bell tower'] }]);
    });

    it('throws what Similharity answered when the edited keys cannot be stored, and keeps the old keys', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        await keysModule.readBookKeys([BOOK]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }));
        await expect(keysModule.saveEditedKeys(BOOK, 0, ['new keys'])).rejects.toThrow("Similharity could not write LoreBase's keys (HTTP 500)");
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['old keys'] });
    });
});

describe('every key at once', () => {
    async function selectBooks() {
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
        return loadWorldInfo;
    }

    it('counts the selected entries LoreBase decides that have no keys, by book, a book it cannot read counted apart', async () => {
        await selectBooks();
        const pending = await keysModule.selectedEntriesWithoutKeys();
        expect(pending.books.map(book => [book.bookName, book.entries.map(each => each.uid)])).toEqual([[BOOK, [1]], ['Desert Atlas', [5]]]);
        expect([pending.count, pending.decidedCount, pending.unreadBooks]).toEqual([2, 3, 1]);
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('never counts or keys a selected entry with no text', async () => {
        const { extension_settings } = await import('../src/sillytavern/settings.js');
        const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
        extension_settings.vectfox.lorebase_books = { [BOOK]: { selectedUids: ['0', '1'] } };
        loadWorldInfo.mockImplementation(async () => ({ entries: { 0: entry(0, 'Lighthouse'), 1: { uid: 1, comment: 'Buoy Line', content: '' } } }));
        const pending = await keysModule.selectedEntriesWithoutKeys();
        expect(pending.books.map(book => book.entries.map(each => each.uid))).toEqual([[0]]);
        expect(pending.count).toBe(1);
    });

    it('Generate all keys writes the selected entries with no keys in every book with a selection, and counts what it did', async () => {
        const loadWorldInfo = await selectBooks();
        expect(await keysModule.writeKeysOfSelections(QDRANT)).toEqual({ written: 2, failed: 0, stopped: 0, unreadBooks: 1, chatLock: null });
        expect(stored).toEqual({ [BOOK]: { 0: ['old keys'], 1: ['keys from Tidewardens'] }, 'Desert Atlas': { 5: ['keys from Dunes'] } });
        expect(loadWorldInfo.mock.calls.map(([bookName]) => bookName)).toEqual([BOOK, 'Desert Atlas', 'Lost Atlas']);
    });

    it('shows the writing on the progress panel: the entries to key, each one done, each failure, and the outcome', async () => {
        await selectBooks();
        host.ask = vi.fn(async messages => (messages[1].content.includes('Dunes') ? UNREADABLE : answerWith(['tidewardens'])));
        await keysModule.writeKeysOfSelections(QDRANT);
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys', 2, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.updateCurrentItem.mock.calls.map(([bookName]) => bookName)).toEqual([BOOK, 'Desert Atlas']);
        expect(host.panel.updateProgress.mock.calls.map(([done]) => done)).toEqual([1, 2]);
        expect(host.panel.addError).toHaveBeenCalledWith('Dunes: its answer held no list of keys');
        expect(host.panel.complete).toHaveBeenCalledWith(false, 'Wrote the keys of 1 entry; 1 failed');
    });

    it('tells its run listeners as the run starts, with the entries to key, and as it ends, with what it did', async () => {
        await selectBooks();
        const seen = [];
        keysModule.onKeyRunChange(run => seen.push(run));
        await keysModule.writeKeysOfSelections(QDRANT);
        expect(seen).toEqual([{ count: 2, outcome: null }, { count: 2, outcome: { written: 2, failed: 0, stopped: 0, unreadBooks: 1, chatLock: null } }]);
    });

    it('shows no panel, tells no run listener and locks nothing when no selected entry is missing keys', async () => {
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK]) };
        const { lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');
        const seen = [];
        keysModule.onKeyRunChange(run => seen.push(run));
        expect(await keysModule.writeKeysOfSelections(QDRANT, { books: [], count: 0, unreadBooks: 0 }))
            .toEqual({ written: 0, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null });
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
        keysModule.onKeyRunChange(run => seen.push(run.outcome?.chatLock));

        const outcome = await keysModule.writeKeysOfSelections(QDRANT, null, { booksWithChosenLocks: ['Lost Atlas'] });
        expect(keyRunLockPlace).toHaveBeenCalledWith(['Lost Atlas']);
        expect(keyRunLockPlace.mock.invocationCallOrder[0]).toBeLessThan(loadWorldInfo.mock.invocationCallOrder[0]);
        expect(lockKeyedBooks).toHaveBeenCalledWith(host.lockPlace, [BOOK]);
        expect(outcome).toEqual({ written: 1, failed: 1, stopped: 0, unreadBooks: 1, chatLock: { chatId: 'chat-harbor', bookNames: [BOOK] } });
        expect(seen).toEqual([undefined, { chatId: 'chat-harbor', bookNames: [BOOK] }]);
    });

    it("the panel's Stop drops the entries not yet sent, back to no keys, and the run says how many it stopped", async () => {
        const entries = Array.from({ length: 9 }, (_, uid) => entry(uid, `Pier ${uid}`));
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const running = keysModule.writeKeysOfSelections(QDRANT, { books: [{ bookName: BOOK, entries }], count: 9, unreadBooks: 0 });
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(6));

        host.panel.stop();
        expect(keysModule.keyStateOf(BOOK, '8')).toEqual({ status: 'missing' });
        answers.forEach((resolve, index) => resolve(answerWith([`pier ${index}`])));
        expect(await running).toEqual({ written: 6, failed: 0, stopped: 3, unreadBooks: 0, chatLock: null });
        expect(host.ask).toHaveBeenCalledTimes(6);
        expect(host.panel.complete).toHaveBeenCalledWith(false, 'Wrote the keys of 6 entries; 3 stopped');
    });

    it('Regenerate keys rewrites the given entries under the progress panel, keys or not, telling the run listeners, and locks nothing', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        await keysModule.readBookKeys([BOOK]);
        host.lockPlace = { chatId: 'chat-harbor', characterAvatar: null, lockableBookNames: new Set([BOOK]) };
        const { keyRunLockPlace } = await import('../src/features/lorebase/lorebase-chat-books.js');
        const seen = [];
        keysModule.onKeyRunChange(run => seen.push(run.outcome));
        expect(await keysModule.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')], QDRANT))
            .toEqual({ written: 2, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null });
        expect(stored[BOOK]).toEqual({ 0: ['keys from Lighthouse'], 1: ['keys from Tidewardens'] });
        expect(host.panel.show).toHaveBeenCalledWith('LoreBase keys', 2, 'Entries', { unitLabel: 'Entries' });
        expect(host.panel.stop).toEqual(expect.any(Function));
        expect(seen).toEqual([null, { written: 2, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null }]);
        expect(keyRunLockPlace).not.toHaveBeenCalled();
    });

    it('runs one key run on the panel at a time: a second is refused and brings the running one up', async () => {
        const answers = [];
        host.ask = vi.fn(() => new Promise(resolve => answers.push(resolve)));
        const first = keysModule.regenerateKeysOfEntries(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));

        await expect(keysModule.regenerateKeysOfEntries(BOOK, [entry(1, 'Tidewardens')], QDRANT))
            .rejects.toThrow('LoreBase is already writing keys on the progress panel. Wait for it, or press Stop there.');
        expect(host.panel.reopen).toHaveBeenCalledTimes(1);
        answers[0](answerWith(['lighthouse']));
        await first;
        expect(await keysModule.regenerateKeysOfEntries(BOOK, [], QDRANT)).toEqual({ written: 0, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null });
    });

    it('Delete all keys deletes every key the user has, forgets the ones it knew, and tells the listeners', async () => {
        stored = { [BOOK]: { 0: ['lighthouse'], 1: ['tidewardens'] }, 'Desert Atlas': { 5: ['dunes'] } };
        await keysModule.readBookKeys([BOOK]);
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(bookName));

        expect(await keysModule.deleteAllKeys()).toBe(3);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: {} });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'missing' });
        expect(seen).toEqual([BOOK]);
    });

    it('Delete all keys is refused while keys are being written, and deletes nothing', async () => {
        let answer;
        host.ask = vi.fn(() => new Promise(resolve => { answer = resolve; }));
        const writing = keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT);
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());

        await expect(keysModule.deleteAllKeys()).rejects.toThrow(
            'LoreBase is still writing the keys of 1 entry; the progress panel shows them. Press Stop there, or delete once it is done.');
        expect(host.panel.reopen).toHaveBeenCalledTimes(1);
        expect(routeCalls.some(call => call.url.endsWith('/delete'))).toBe(false);
        answer(answerWith(['lighthouse']));
        await writing;
    });

    it('says what Similharity answered when the keys cannot be deleted, and keeps knowing them', async () => {
        stored[BOOK] = { 0: ['lighthouse'] };
        await keysModule.readBookKeys([BOOK]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }));
        await expect(keysModule.deleteAllKeys()).rejects.toThrow("Similharity could not delete LoreBase's keys (HTTP 500)");
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['lighthouse'] });
    });
});

describe('what keys need', () => {
    it('writes nothing off Qdrant, and says LoreBase keeps them there', async () => {
        expect(keysModule.keyWritingProblem({ vector_backend: 'standard' })).toContain('Choose Qdrant as the vector backend');
        expect(await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], { vector_backend: 'standard' })).toEqual({ written: 0, failed: 0, stopped: 0 });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('writes nothing without LoreBase\'s model, and says where to set it', async () => {
        host.connection = { ok: false, reason: 'no_model', problem: 'LoreBase has no model.' };
        expect(keysModule.keyWritingProblem(QDRANT)).toBe('LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.');
        expect(await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT)).toEqual({ written: 0, failed: 0, stopped: 0 });
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('says what Similharity answered when the keys cannot be read', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is not set up"}' }));
        await expect(keysModule.readBookKeys([BOOK])).rejects.toThrow("Similharity could not read LoreBase's keys (HTTP 500): {\"error\":\"Qdrant is not set up\"}");
    });
});
