/**
 * LoreBase's keys (src/features/lorebase/lorebase-keys.js, plan D15 and D17 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): written for entries that have none, or for every one given on
 * Regenerate keys, at most 6 calls at once, an unreadable answer asked again up to 3 asks; each written entry's keys go to
 * Similharity's key route, a failed one is marked and named in a toast; and nothing is written off Qdrant or without
 * LoreBase's model; one entry's keys are regenerated to read, or stored as the user edited them. The progress panel's
 * runs and Delete all are LoreBase's storage module's (tests/lorebase-storage.test.js). Similharity's routes are a
 * fetch stand-in holding the keys in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ connection: { ok: true }, ask: null }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-connection.js', () => ({
    askOnLoreBase: () => (...args) => host.ask(...args),
    resolveLoreBaseLlmConfig: () => host.connection,
    describeLoreBaseConnectionProblem: (reason, problem) => `${problem} Until then the entries selected for LoreBase stay out of replies.`,
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
