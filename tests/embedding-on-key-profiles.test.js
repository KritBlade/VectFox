/**
 * Embedding on a SillyTavern connection profile of type llama.cpp, KoboldCPP or Custom (connection plan §3, row C7):
 * every request names the profile's URL, and its key's ID only when it stores a key; without the Similharity version manifest.json names the
 * request never starts; SillyTavern's own embedding routes, which take no key ID, are never reached; and a key the
 * server rejects raises the key message from every place an embedding request can fail.
 *
 * Runs the real provider rules, the real Similharity probe, both real backends, the real collection import and the
 * real diagnostics checks. SillyTavern's page global, which the connection-profile wrapper reads, and fetch are stubbed.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => 'chat-1', chat_metadata: {} }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: { OPENROUTER: 'api_key_openrouter' }, secret_state: {} }));
vi.mock('../src/sillytavern/connection-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', VLLM: 'vllm', LLAMACPP: 'llamacpp', KOBOLDCPP: 'koboldcpp' },
    textgenerationwebui_settings: { server_urls: { vllm: 'http://sillytavern-vllm:8000' } },
    oai_settings: {},
}));
vi.mock('../src/features/vector-backend/sparse-vector-encoder.js', () => ({ encodeSparseVector: () => ({ indices: [1], values: [1] }) }));
// SillyTavern modules the collection import's graph reaches; nothing these tests run uses them.
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../../../../world-info.js', () => ({}));

const { checkPluginAvailable, resetPluginAvailableCache } = await import('../src/shared/similharity-plugin.js');
const { resolveEmbeddingProfile, resolveProviderApiUrl } = await import('../src/features/embedding/index.js');
const { QdrantBackend } = await import('../src/features/vector-backend/qdrant.js');
const { StandardBackend } = await import('../src/features/vector-backend/standard.js');
const { checkApiKeys, checkApiUrls, checkEmbeddingProvider } = await import('../src/features/diagnostics/infrastructure-checks.js');

// SillyTavern 1.19.0's map for these APIs (public/scripts/slash-commands.js setupConnectAPIMap), the kcpp alias included.
const CONNECT_API_MAP = {
    ollama: { selected: 'textgenerationwebui', type: 'ollama' },
    llamacpp: { selected: 'textgenerationwebui', type: 'llamacpp' },
    koboldcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
    kcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
    custom: { selected: 'openai', source: 'custom' },
};

// Key IDs are SillyTavern's ids for keys it keeps; these name no real key.
const LLAMA = { id: 'p-llama', name: 'Lantern llama', api: 'llamacpp', 'api-url': 'http://lantern:8080', model: '', 'secret-id': 'key-id-llama' };
const KOBOLD = { id: 'p-kobold', name: 'Lantern Kobold', api: 'koboldcpp', 'api-url': 'http://lantern:5001' };
const CUSTOM = { id: 'p-custom', name: 'Lantern Custom', api: 'custom', 'api-url': 'https://embed.example.test/v1', model: 'lantern-embed', 'secret-id': 'key-id-custom' };
// An Ollama profile once saved as Custom, still naming that key: Ollama has no key, so none goes.
const HARBOR = { id: 'p-harbor', name: 'Harbor Ollama', api: 'ollama', 'api-url': 'http://harbor:11434', model: 'harbor-embed', 'secret-id': 'key-id-left-over' };

// The oldest Similharity VectFox works with, read from manifest.json as VectFox reads it; 3.3.5 is below any floor.
const MANIFEST = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const FLOOR = MANIFEST.similharity_minimum_version;

const host = vi.hoisted(() => ({ profiles: [], pluginVersion: null, embeddingReply: null }));

const KEY_REFUSAL = '{"error":"llama.cpp embedding: 401 Unauthorized {\\"error\\":{\\"message\\":\\"Invalid API Key\\"}}"}';
const ok = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    host.profiles = [LLAMA, KOBOLD, CUSTOM, HARBOR];
    host.pluginVersion = FLOOR;
    host.embeddingReply = null;
    resetPluginAvailableCache();
    vi.stubGlobal('SillyTavern', {
        getContext: () => ({
            extensionSettings: { disabledExtensions: [], connectionManager: { profiles: host.profiles } },
            CONNECT_API_MAP,
            ConnectionManagerRequestService: {},
        }),
    });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('manifest.json')) return ok(MANIFEST);
        if (url === '/api/plugins/similharity/health') {
            return host.pluginVersion === null
                ? { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' }
                : ok({ status: 'ok', version: host.pluginVersion });
        }
        if (url === '/api/plugins/similharity/backend/init/vectra') return ok({ success: true });
        if (host.embeddingReply) return host.embeddingReply;
        return ok({ success: true, embedding: [0.1, 0.2, 0.3], results: [] });
    }));
});

const onProfile = (profile, provider, backend = 'qdrant') => ({
    embedding_provider: provider, embedding_connection_profile_id: profile.id, vector_backend: backend,
    score_threshold: 0.2, embedding_vllm_url_override: true, embedding_vllm_url: 'http://manual-vllm:8000',
});
const embeddingRequests = () => fetch.mock.calls
    .filter(([url]) => !String(url).includes('manifest.json') && !url.endsWith('/health') && !url.endsWith('/backend/init/vectra'))
    .map(([url, init]) => ({ url, body: JSON.parse(init.body) }));
const ITEM = { hash: 52001, index: 0, text: 'Keeper Orrin trims the lighthouse lamp at dusk.', metadata: {} };

async function standardBackend() {
    const backend = new StandardBackend();
    await backend.initialize({});
    return backend;
}

const TYPES = [
    ['llamacpp', LLAMA, { source: 'llamacpp', model: '', apiUrl: 'http://lantern:8080', secret_id: 'key-id-llama' }],
    ['koboldcpp', KOBOLD, { source: 'koboldcpp', model: '', apiUrl: 'http://lantern:5001' }],
    ['custom', CUSTOM, { source: 'custom', model: 'lantern-embed', apiUrl: 'https://embed.example.test/v1', secret_id: 'key-id-custom' }],
];

describe('a llama.cpp, KoboldCPP or Custom profile, with the Similharity manifest.json names', () => {
    for (const [provider, profile, named] of TYPES) {
        it(`${provider}: a Qdrant query and insert name the profile's URL, and its key ID only when it stores one`, async () => {
            const backend = new QdrantBackend();
            await backend.embedQuery('Where is the lamp?', onProfile(profile, provider));
            await backend.insertVectorItems('vf_test_lantern', [ITEM], onProfile(profile, provider));
            const requests = embeddingRequests();
            expect(requests.map(request => request.url)).toEqual(['/api/plugins/similharity/get-embedding', '/api/plugins/similharity/chunks/insert']);
            for (const { body } of requests) {
                expect(body).toMatchObject(named);
                expect('secret_id' in body).toBe('secret_id' in named);
            }
        });

        it(`${provider}: the Standard backend's insert, query and multi-collection search all go through the plugin`, async () => {
            const backend = await standardBackend();
            const settings = onProfile(profile, provider, 'standard');
            await backend.insertVectorItems('vf_test_lantern', [ITEM], settings);
            await backend.queryCollection('vf_test_lantern', 'Where is the lamp?', 5, settings);
            await backend.queryMultipleCollections(['vf_test_lantern', 'vf_test_harbor'], 'Where is the lamp?', 5, 0.3, settings);
            const requests = embeddingRequests();
            expect(requests.map(request => request.url)).toEqual([
                '/api/plugins/similharity/chunks/insert',
                '/api/plugins/similharity/chunks/query',
                // One embedding for the whole search, then each collection on that vector, at the search's threshold.
                '/api/plugins/similharity/get-embedding',
                '/api/plugins/similharity/chunks/query',
                '/api/plugins/similharity/chunks/query',
            ]);
            for (const { body } of requests) expect(body).toMatchObject(named);
            expect(requests.slice(3).map(({ body }) => [body.collectionId, body.threshold, Array.isArray(body.queryVector)]))
                .toEqual([['vf_test_lantern', 0.3, true], ['vf_test_harbor', 0.3, true]]);
        });
    }

    it('reads a KoboldCPP profile saved under the kcpp alias as KoboldCPP', async () => {
        await checkPluginAvailable();
        host.profiles = [{ ...KOBOLD, api: 'kcpp' }];
        expect(resolveEmbeddingProfile(onProfile(KOBOLD, 'koboldcpp'))).toMatchObject({ profileName: 'Lantern Kobold', problem: '' });
    });

    it('sends no key ID on an Ollama profile, though it still names one', async () => {
        await new QdrantBackend().embedQuery('Where is the lamp?', onProfile(HARBOR, 'ollama'));
        const [{ body }] = embeddingRequests();
        expect(body).toMatchObject({ source: 'ollama', apiUrl: 'http://harbor:11434', model: 'harbor-embed' });
        expect('secret_id' in body).toBe(false);
    });

    it('stops before any request when no profile is chosen, as these types have no fields of their own', async () => {
        const settings = { ...onProfile(LLAMA, 'llamacpp'), embedding_connection_profile_id: '' };
        await expect(new QdrantBackend().embedQuery('Where is the lamp?', settings))
            .rejects.toMatchObject({ code: 'invalid_model_config', message: 'Embedding: no connection profile is chosen. Choose one on the Core page.' });
        expect(embeddingRequests()).toEqual([]);
    });

    it('passes the diagnostics checks, naming the profile, its URL and whether it sends a key', async () => {
        await expect(checkEmbeddingProvider(onProfile(LLAMA, 'llamacpp'))).resolves.toMatchObject({ status: 'pass', message: 'Using llama.cpp on profile "Lantern llama"' });
        expect(checkApiUrls(onProfile(LLAMA, 'llamacpp'))).toMatchObject({ status: 'pass', message: 'http://lantern:8080' });
        expect(checkApiKeys(onProfile(LLAMA, 'llamacpp'))).toMatchObject({ status: 'info', message: 'Sends the key profile "Lantern llama" stores' });
        expect(checkApiKeys(onProfile(KOBOLD, 'koboldcpp'))).toMatchObject({ status: 'info', message: 'Profile "Lantern Kobold" stores no key, so none is sent' });
    });
});

describe('without the Similharity manifest.json names', () => {
    for (const [pluginVersion, found] of [[null, 'SillyTavern has none'], ['3.3.5', 'SillyTavern has Similharity 3.3.5']]) {
        it(`stops every request on a profile that sends its key ID when ${found}, and says why`, async () => {
            host.pluginVersion = pluginVersion;
            const settings = onProfile(CUSTOM, 'custom');
            const expected = { code: 'invalid_model_config', message: expect.stringContaining(`Similharity plugin ${FLOOR} or later, and ${found}.`) };
            const backend = new QdrantBackend();
            await expect(backend.embedQuery('Where is the lamp?', settings)).rejects.toMatchObject(expected);
            await expect(backend.insertVectorItems('vf_test_lantern', [ITEM], settings)).rejects.toMatchObject(expected);
            expect(() => resolveProviderApiUrl(settings)).toThrow(expect.objectContaining(expected));
            await expect(checkEmbeddingProvider(settings)).resolves.toMatchObject({ status: 'fail', message: expected.message });
            expect(embeddingRequests()).toEqual([]);
        });
    }

    it('never sends these types to SillyTavern\'s own routes, from a Standard backend that started without the plugin', async () => {
        const backend = await standardBackend();
        backend.pluginAvailable = false;
        const settings = onProfile(LLAMA, 'llamacpp', 'standard');
        const expected = { code: 'invalid_model_config', message: expect.stringMatching(/^Embedding: a llama\.cpp profile embeds only through the Similharity plugin.*reload the page/) };
        await expect(backend.insertVectorItems('vf_test_lantern', [ITEM], settings)).rejects.toMatchObject(expected);
        await expect(backend.queryCollection('vf_test_lantern', 'Where is the lamp?', 5, settings)).rejects.toMatchObject(expected);
        await expect(backend.queryMultipleCollections(['vf_test_lantern'], 'Where is the lamp?', 5, 0.3, settings)).rejects.toMatchObject(expected);
        expect(embeddingRequests()).toEqual([]);
    });

    it('refuses an import into the Standard backend, which goes through SillyTavern\'s own route', async () => {
        const { insertChunksWithVectors } = await import('../src/features/collections/collection-export.js');
        await expect(insertChunksWithVectors('vf_test_lantern', [{ ...ITEM, vector: [0.1, 0.2, 0.3] }], onProfile(LLAMA, 'llamacpp', 'standard')))
            .rejects.toMatchObject({ code: 'invalid_model_config', message: expect.stringContaining('import into Qdrant instead') });
        expect(embeddingRequests()).toEqual([]);
    });
});

describe('a key the profile\'s server rejects', () => {
    const STORES_KEY = 'Embedding: the provider rejected the API key for profile "Lantern llama", or that key was deleted in SillyTavern. '
        + 'Check the key saved in that profile in SillyTavern.';
    const STORES_NONE = 'Embedding: the provider needs an API key, and profile "Lantern Kobold" stores none, so VectFox sent none. '
        + 'Select the key in SillyTavern and update the profile.';
    const SITES = {
        'the query embedding': (backend, settings) => backend.embedQuery('Where is the lamp?', settings),
        'an insert': (backend, settings) => backend.insertVectorItems('vf_test_lantern', [ITEM], settings),
        'a query': (backend, settings) => backend.queryCollection('vf_test_lantern', 'Where is the lamp?', 5, settings),
    };

    for (const [backendName, makeBackend] of [['Qdrant', async () => new QdrantBackend()], ['Standard', standardBackend]]) {
        for (const [site, send] of Object.entries(SITES)) {
            if (backendName === 'Standard' && site === 'the query embedding') continue; // the same function as Qdrant's
            it(`raises the key message from ${backendName}'s ${site}, by whether the profile stores a key`, async () => {
                const backend = await makeBackend();
                host.embeddingReply = { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => KEY_REFUSAL };
                await expect(send(backend, onProfile(LLAMA, 'llamacpp', backendName.toLowerCase()))).rejects.toMatchObject({ code: 'invalid_model_config', message: STORES_KEY });
                await expect(send(backend, onProfile(KOBOLD, 'koboldcpp', backendName.toLowerCase()))).rejects.toMatchObject({ code: 'invalid_model_config', message: STORES_NONE });
            });
        }
    }

    it('leaves a failure that names no key problem to the caller\'s own error', async () => {
        host.embeddingReply = { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '{"error":"fetch failed (cause: connect ECONNREFUSED)"}' };
        const error = await new QdrantBackend().embedQuery('Where is the lamp?', onProfile(LLAMA, 'llamacpp')).catch(caught => caught);
        expect(error.code).toBeUndefined();
        expect(error.message).toMatch(/^Query embedding via 'llamacpp' failed: 500/);
    });

    it('never gives a manual provider the profile key message', async () => {
        host.embeddingReply = { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => KEY_REFUSAL };
        const manualVllm = { embedding_provider: 'vllm', embedding_vllm_model: 'harbor-embed', vector_backend: 'qdrant', embedding_vllm_url_override: true, embedding_vllm_url: 'http://manual-vllm:8000' };
        const error = await new QdrantBackend().embedQuery('Where is the lamp?', manualVllm).catch(caught => caught);
        expect(error.message).not.toMatch(/profile/);
    });
});
