/**
 * LoreBase's keys (src/features/lorebase/lorebase-keys.js, plan D15 and D17 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): written for entries that have none, or for every one given on
 * Regenerate keys, at most 6 calls at once, an unreadable answer asked again up to 3 asks; each written entry's keys go to
 * Similharity's key route, a failed one is marked and named in a toast; and nothing is written off Qdrant or without
 * LoreBase's model; one entry's keys are regenerated to read, or stored as the user edited them; every write names the
 * entry's title, which a read gives back; a keys file's keys are stored with no LLM call; one book's keys are deleted
 * alone; and every call makes Similharity's Qdrant ready first. The progress panel's runs and Delete all are LoreBase's
 * storage module's (tests/lorebase-storage.test.js). Similharity's routes are a fetch stand-in holding the keys and
 * titles in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ connection: { ok: true }, ask: null, getBackend: null, order: [], standing: null }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: { vector_backend: 'qdrant' } }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/features/vector-backend/index.js', () => ({ getBackend: (...args) => host.getBackend(...args) }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ similharityStanding: () => host.standing, PLUGIN_UPDATE_INSTRUCTIONS: 'Update Similharity.' }));
vi.mock('../src/features/lorebase/lorebase-connection.js', () => ({
    askOnLoreBase: () => (...args) => host.ask(...args),
    resolveLoreBaseLlmConfig: () => host.connection,
    describeLoreBaseConnectionProblem: (reason, problem) => `${problem} Until then the entries selected for LoreBase stay out of replies.`,
}));
// What keys need is lorebase-setup.js's (keyWritingProblem), read here as it is: its other checks stand in.
vi.mock('../src/features/embedding/index.js', () => ({ embeddingSetupProblem: () => '' }));
vi.mock('../src/features/lorebase/lorebase-jev.js', () => ({ resolveJevConnection: () => ({ ok: true }) }));
vi.mock('../src/features/lorebase/lorebase-switch.js', () => ({ isLoreBaseBackend: settings => settings?.vector_backend === 'qdrant' }));

const BOOK = 'Harbor Atlas';
const entry = (uid, comment) => ({ uid, comment, content: `${comment} stands by the harbor.` });
const QDRANT = { vector_backend: 'qdrant' };

let stored;
let storedTitles;
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
    storedTitles = {};
    routeCalls = [];
    host.order = [];
    host.standing = { isFound: true, version: '3.4.14', requiredVersion: '3.4.14', isCurrent: true };
    host.getBackend = vi.fn(async () => { host.order.push('ready'); });
    globalThis.fetch = vi.fn(async (url, { body }) => {
        const request = JSON.parse(body);
        routeCalls.push({ url, request });
        host.order.push(url);
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
    host.ask = vi.fn(async messages => answerWith([`keys from ${messages[1].content.split('\n')[2].split(' ')[0]}`]));
    keysModule = await import('../src/features/lorebase/lorebase-keys.js');
});

describe('writing keys', () => {
    it('reads what Qdrant holds first, writes only the entries with none, and marks them ready', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        const result = await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse'), entry(1, 'Tidewardens')], QDRANT);

        expect(result).toEqual({ written: 1, failed: 0, stopped: 0 });
        expect(host.ask).toHaveBeenCalledTimes(1);
        expect(routeCalls.map(call => call.url)).toEqual(['/api/plugins/similharity/lorebase/keys/read', '/api/plugins/similharity/lorebase/keys/write']);
        expect(routeCalls[1].request).toEqual({ book: BOOK, entries: [{ uid: '1', keys: ['keys from Tidewardens'], title: 'Tidewardens' }] });
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

        await keysModule.saveEditedKeys(BOOK, entry(4, 'Drowned Bell'), ['drowned bell', 'bell tower']);
        expect(routeCalls.at(-1)).toEqual({
            url: '/api/plugins/similharity/lorebase/keys/write',
            request: { book: BOOK, entries: [{ uid: '4', keys: ['drowned bell', 'bell tower'], title: 'Drowned Bell' }] },
        });
        expect(stored[BOOK]['4']).toEqual(['drowned bell', 'bell tower']);
        expect(seen).toEqual([{ status: 'ready', keys: ['drowned bell', 'bell tower'] }]);
    });

    it('throws what Similharity answered when the edited keys cannot be stored, and keeps the old keys', async () => {
        stored[BOOK] = { 0: ['old keys'] };
        await keysModule.readBookKeys([BOOK]);
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is down"}' }));
        await expect(keysModule.saveEditedKeys(BOOK, entry(0, 'Lighthouse'), ['new keys'])).rejects.toThrow("Similharity could not write LoreBase's keys (HTTP 500)");
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'ready', keys: ['old keys'] });
    });
});

describe('titles, a keys file, and one book', () => {
    it('makes Similharity\'s Qdrant ready before each call, as every vector call is', async () => {
        await keysModule.readBookKeys([BOOK]);
        expect(host.getBackend).toHaveBeenCalledWith({ vector_backend: 'qdrant' }, 'qdrant');
        expect(host.order).toEqual(['ready', '/api/plugins/similharity/lorebase/keys/read']);
    });

    it('calls no route when Qdrant cannot be reached, and says why', async () => {
        host.getBackend = vi.fn(async () => { throw new Error('Backend qdrant failed health check'); });
        await expect(keysModule.readBookKeys([BOOK])).rejects.toThrow('Backend qdrant failed health check');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('reads a book\'s keys with the title stored beside each, and keeps the keys for the selection screen', async () => {
        stored[BOOK] = { 0: ['lighthouse'], 1: ['tidewardens'] };
        storedTitles[BOOK] = { 0: 'Lighthouse' };
        expect(await keysModule.readBookKeysWithTitles(BOOK)).toEqual({ keys: { 0: ['lighthouse'], 1: ['tidewardens'] }, titles: { 0: 'Lighthouse' } });
        expect(keysModule.keyStateOf(BOOK, '1')).toEqual({ status: 'ready', keys: ['tidewardens'] });
    });

    it('stores a keys file\'s keys with their titles, with no LLM call, and tells the listeners once', async () => {
        const seen = [];
        keysModule.onKeyStateChange(bookName => seen.push(bookName));
        const written = await keysModule.writeImportedKeys(BOOK, [
            { uid: '0', title: 'Lighthouse', keys: ['lighthouse'] },
            { uid: '3', title: 'Tide clock', keys: [] },
        ]);
        expect(written).toBe(2);
        expect(host.ask).not.toHaveBeenCalled();
        expect(routeCalls.at(-1).request).toEqual({ book: BOOK, entries: [
            { uid: '0', title: 'Lighthouse', keys: ['lighthouse'] },
            { uid: '3', title: 'Tide clock', keys: [] },
        ] });
        expect(keysModule.keyStateOf(BOOK, '3')).toEqual({ status: 'ready', keys: [] });
        expect(seen).toEqual([BOOK]);
    });

    it('deletes one book\'s keys alone, forgets them, and keeps another book\'s', async () => {
        stored = { [BOOK]: { 0: ['lighthouse'] }, 'Desert Atlas': { 5: ['dunes'] } };
        await keysModule.readBookKeys([BOOK, 'Desert Atlas']);
        expect(await keysModule.deleteBookKeys([BOOK])).toBe(1);
        expect(routeCalls.at(-1)).toEqual({ url: '/api/plugins/similharity/lorebase/keys/delete', request: { books: [BOOK] } });
        expect(keysModule.keyStateOf(BOOK, '0')).toEqual({ status: 'missing' });
        expect(keysModule.keyStateOf('Desert Atlas', '5')).toEqual({ status: 'ready', keys: ['dunes'] });
        expect(stored).toEqual({ 'Desert Atlas': { 5: ['dunes'] } });
    });

    it("sends no delete of one book to a Similharity older than the floor, which would delete every book's keys", async () => {
        stored = { [BOOK]: { 0: ['lighthouse'] }, 'Desert Atlas': { 5: ['dunes'] } };
        host.standing = { isFound: true, version: '3.4.13', requiredVersion: '3.4.14', isCurrent: false };
        await expect(keysModule.deleteBookKeys([BOOK])).rejects.toThrow(
            "Deleting one lorebook's keys needs Similharity 3.4.14 or later, and 3.4.13 is installed, so nothing was deleted. Update Similharity.");
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(stored).toEqual({ [BOOK]: { 0: ['lighthouse'] }, 'Desert Atlas': { 5: ['dunes'] } });
    });
});

describe('what keys need', () => {
    it('writes nothing off Qdrant, and says LoreBase keeps them there', async () => {
        const { keyWritingProblem } = await import('../src/features/lorebase/lorebase-setup.js');
        expect(keyWritingProblem({ vector_backend: 'standard' })).toContain('Choose Qdrant as the vector backend');
        expect(await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], { vector_backend: 'standard' })).toEqual({ written: 0, failed: 0, stopped: 0 });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('writes nothing without LoreBase\'s model, and says where to set it', async () => {
        host.connection = { ok: false, reason: 'no_model', problem: 'LoreBase has no model.' };
        const { keyWritingProblem } = await import('../src/features/lorebase/lorebase-setup.js');
        expect(keyWritingProblem(QDRANT)).toBe('LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.');
        expect(await keysModule.writeKeys(BOOK, [entry(0, 'Lighthouse')], QDRANT)).toEqual({ written: 0, failed: 0, stopped: 0 });
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('says what Similharity answered when the keys cannot be read', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"Qdrant is not set up"}' }));
        await expect(keysModule.readBookKeys([BOOK])).rejects.toThrow("Similharity could not read LoreBase's keys (HTTP 500): {\"error\":\"Qdrant is not set up\"}");
    });
});
