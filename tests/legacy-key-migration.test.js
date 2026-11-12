/**
 * The start-up migration's credential steps (src/shared/api-keys.js, migrateLegacyApiKeys): settings nothing reads any
 * more that can hold a plaintext key are deleted without their values being read or logged, unless a VectHare
 * extension that owns them is installed; and a plaintext OpenRouter, vLLM or Qdrant key leaves settings.json whether
 * or not SillyTavern saves it, as VectFox never keeps a key there. SillyTavern's writeSecret answers null on a failure
 * and never throws, and one red toast that stays until closed names each key it did not save.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {},
    secretState: {},
    extensionNames: [],
    unsavedSlots: new Set(),
    isPluginUp: true,
    written: [],
    logged: [],
}));

vi.mock('../src/sillytavern/settings.js', () => ({
    get extension_settings() { return host.settings; },
    saveSettings: vi.fn(async () => {}),
}));
vi.mock('../src/sillytavern/secrets.js', () => ({
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom', VLLM: 'api_key_vllm' },
    get secret_state() { return host.secretState; },
    writeSecret: vi.fn(async (slot) => {
        host.written.push(slot);
        return host.unsavedSlots.has(slot) ? null : `${slot}-id`;
    }),
    readSecretState: vi.fn(async () => {}),
}));
vi.mock('../src/sillytavern/installed-extensions.js', () => ({
    get extensionNames() { return host.extensionNames; },
}));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => host.isPluginUp) }));
vi.mock('../src/sillytavern/log.js', () => {
    const record = (...args) => host.logged.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    return { log: { lifecycle: record, verbose: record, warn: record, error: record, trace: record } };
});

const { migrateLegacyApiKeys } = await import('../src/shared/api-keys.js');

const MADE_UP_KEY = 'sk-or-v1-' + 'f00d'.repeat(16);
const STICKY = { timeOut: 0, extendedTimeOut: 0 };

/** Everything the user and the console saw, to check no key is in it. */
function everythingShown() {
    return [...host.logged, ...globalThis.toastr.error.mock.calls.flat().map(part => JSON.stringify(part))].join('\n');
}

beforeEach(() => {
    host.secretState = {};
    host.extensionNames = ['third-party/VectFox'];
    host.unsavedSlots = new Set();
    host.isPluginUp = true;
    host.written = [];
    host.logged = [];
    globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
    globalThis.fetch = vi.fn(async () => new Response('{"set":false,"masked":""}', { status: 200 }));
});

describe('settings nothing reads that can hold a key', () => {
    it('are deleted, and only their names reach the log', async () => {
        host.settings = {
            vectfox: { vector_backend: 'qdrant', bananabread_api_key: MADE_UP_KEY, milvus_token: 'm-token', milvus_password: 'm-pass' },
            vecthareplus: { summarize_openrouter_api_key: MADE_UP_KEY, other: 1 },
            vecthare: { qdrant_api_key: 'q-key' },
            'connection-manager': { profiles: [] },
        };

        await migrateLegacyApiKeys();

        expect(host.settings).toEqual({ vectfox: { vector_backend: 'qdrant' }, 'connection-manager': { profiles: [] } });
        const log = host.logged.join('\n');
        expect(log).toContain('extension_settings.vecthareplus');
        expect(log).toContain('bananabread_api_key');
        expect(log).not.toContain(MADE_UP_KEY);
        expect(log).not.toMatch(/m-token|m-pass|q-key/);
    });

    it('stay while a VectHare extension that reads them is installed', async () => {
        host.extensionNames = ['third-party/VectFox', 'third-party/VectHarePlus'];
        host.settings = { vectfox: {}, vecthareplus: { summarize_openrouter_api_key: MADE_UP_KEY } };

        await migrateLegacyApiKeys();

        expect(host.settings.vecthareplus).toEqual({ summarize_openrouter_api_key: MADE_UP_KEY });
        expect(host.logged.join('\n')).toContain('Kept extension_settings.vecthareplus');
    });

    it('leave a settings file without them as it is', async () => {
        host.settings = { vectfox: { vector_backend: 'standard' } };
        await migrateLegacyApiKeys();
        expect(host.settings).toEqual({ vectfox: { vector_backend: 'standard' } });
    });
});

describe('a plaintext key SillyTavern saves', () => {
    it.each([
        ['OpenRouter', { summarize_openrouter_api_key: MADE_UP_KEY, openrouter_api_key: '' }, ['api_key_openrouter']],
        ['vLLM', { vllm_api_key: MADE_UP_KEY, agentic_retrieval_vllm_api_key: 'other' }, ['api_key_custom', 'api_key_vllm']],
        ['Qdrant', { qdrant_api_key: MADE_UP_KEY }, ['api_key_qdrant']],
    ])('%s: goes to its slots and leaves settings.json, with no toast', async (_name, legacyFields, slots) => {
        host.settings = { vectfox: { vector_backend: 'qdrant', ...legacyFields } };

        await migrateLegacyApiKeys();

        expect(host.written).toEqual(slots);
        expect(host.settings.vectfox).toEqual({ vector_backend: 'qdrant' });
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(everythingShown()).not.toContain(MADE_UP_KEY);
    });

    it('goes to SillyTavern without Similharity too, which reads it there once installed', async () => {
        host.isPluginUp = false;
        host.settings = { vectfox: { qdrant_api_key: MADE_UP_KEY } };

        await migrateLegacyApiKeys();

        expect(host.written).toEqual(['api_key_qdrant']);
        expect(host.settings.vectfox).toEqual({});
    });

    it('is not written over a key the user saved in SillyTavern, and still leaves settings.json', async () => {
        host.secretState = { api_key_openrouter: [{ id: 'theirs', value: '*******abc', active: true }] };
        host.settings = { vectfox: { openrouter_api_key: MADE_UP_KEY } };

        await migrateLegacyApiKeys();

        expect(host.written).toEqual([]);
        expect(host.settings.vectfox).toEqual({});
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    it('an empty field is deleted with nothing written', async () => {
        host.settings = { vectfox: { qdrant_api_key: '  ', openrouter_api_key: '' } };

        await migrateLegacyApiKeys();

        expect(host.written).toEqual([]);
        expect(host.settings.vectfox).toEqual({});
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});

describe('a plaintext key SillyTavern did not save', () => {
    it.each([
        ['OpenRouter', { openrouter_api_key: MADE_UP_KEY }, 'api_key_openrouter'],
        ['vLLM', { vllm_api_key: MADE_UP_KEY }, 'api_key_custom'],
        ['vLLM', { vllm_api_key: MADE_UP_KEY }, 'api_key_vllm'],
        ['Qdrant', { qdrant_api_key: MADE_UP_KEY }, 'api_key_qdrant'],
    ])('%s, not saved in %s: still leaves settings.json, and a red toast asks for it again', async (name, legacyFields, unsavedSlot) => {
        host.unsavedSlots = new Set([unsavedSlot]);
        host.settings = { vectfox: { vector_backend: 'qdrant', ...legacyFields } };

        await migrateLegacyApiKeys();

        expect(host.settings.vectfox).toEqual({ vector_backend: 'qdrant' });
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(
            `SillyTavern did not save your ${name} key when VectFox moved it out of settings.json. Paste it again in VectFox's settings.`,
            'Key not saved',
            STICKY,
        );
        expect(host.logged.join('\n')).toContain(`did not save the key moved out of settings.json in ${unsavedSlot}`);
        expect(everythingShown()).not.toContain(MADE_UP_KEY);
    });

    it('are all named in one toast', async () => {
        host.unsavedSlots = new Set(['api_key_openrouter', 'api_key_vllm', 'api_key_qdrant']);
        host.settings = { vectfox: { openrouter_api_key: MADE_UP_KEY, vllm_api_key: MADE_UP_KEY, qdrant_api_key: MADE_UP_KEY } };

        await migrateLegacyApiKeys();

        expect(host.settings.vectfox).toEqual({});
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(
            'SillyTavern did not save your OpenRouter, vLLM, and Qdrant keys when VectFox moved them out of settings.json. Paste them again in VectFox\'s settings.',
            'Keys not saved',
            STICKY,
        );
    });
});
