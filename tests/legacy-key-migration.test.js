/**
 * The start-up migration's credential steps (src/shared/api-keys.js, migrateLegacyApiKeys): settings nothing reads any
 * more that can hold a plaintext key are deleted without their values being read or logged, unless a VectHare
 * extension that owns them is installed; and a plaintext Qdrant key leaves settings.json only once SillyTavern
 * confirms it saved the key, as its writeSecret answers null on a failure and never throws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {},
    extensionNames: [],
    savedId: 'secret-id-1',
    written: [],
    logged: [],
}));

vi.mock('../src/sillytavern/settings.js', () => ({
    get extension_settings() { return host.settings; },
    saveSettings: vi.fn(async () => {}),
}));
vi.mock('../src/sillytavern/secrets.js', () => ({
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom', VLLM: 'api_key_vllm' },
    secret_state: {},
    writeSecret: vi.fn(async (slot) => { host.written.push(slot); return host.savedId; }),
    readSecretState: vi.fn(async () => {}),
}));
vi.mock('../src/sillytavern/installed-extensions.js', () => ({
    get extensionNames() { return host.extensionNames; },
}));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => true) }));
vi.mock('../src/sillytavern/log.js', () => {
    const record = (...args) => host.logged.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    return { log: { lifecycle: record, verbose: record, warn: record, error: record, trace: record } };
});

const { migrateLegacyApiKeys } = await import('../src/shared/api-keys.js');

const MADE_UP_KEY = 'sk-or-v1-' + 'f00d'.repeat(16);

beforeEach(() => {
    host.extensionNames = ['third-party/VectFox'];
    host.savedId = 'secret-id-1';
    host.written = [];
    host.logged = [];
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

describe('a plaintext Qdrant key', () => {
    it('leaves settings.json once SillyTavern saves it', async () => {
        host.settings = { vectfox: { qdrant_api_key: 'q-key' } };
        await migrateLegacyApiKeys();
        expect(host.written).toEqual(['api_key_qdrant']);
        expect(host.settings.vectfox).toEqual({});
    });

    it('stays in settings.json when SillyTavern did not save it', async () => {
        host.savedId = null;
        host.settings = { vectfox: { qdrant_api_key: 'q-key' } };
        await migrateLegacyApiKeys();
        expect(host.settings.vectfox).toEqual({ qdrant_api_key: 'q-key' });
        expect(host.logged.join('\n')).toContain('PRESERVED');
    });
});
