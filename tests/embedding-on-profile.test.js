/**
 * Embedding on a SillyTavern connection profile of type Ollama (connection plan §3, row C6): the URL and model come from
 * the profile, a profile that cannot be used stops before any request with its reason, and manual Ollama is unchanged.
 *
 * Runs the real provider rules (src/features/embedding/providers.js), the real Qdrant backend and the real diagnostics
 * checks. SillyTavern's page global, which the connection-profile wrapper reads, and fetch are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => 'chat-1', chat_metadata: {} }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: { OPENROUTER: 'api_key_openrouter' }, secret_state: {} }));
vi.mock('../src/sillytavern/connection-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', VLLM: 'vllm', LLAMACPP: 'llamacpp', KOBOLDCPP: 'koboldcpp' },
    textgenerationwebui_settings: { server_urls: { ollama: 'http://sillytavern-ollama:11434' } },
    oai_settings: {},
}));
vi.mock('../src/features/vector-backend/sparse-vector-encoder.js', () => ({ encodeSparseVector: () => ({ indices: [1], values: [1] }) }));

const { getModelFromSettings, resolveEmbeddingProfile, resolveProviderApiUrl } = await import('../src/features/embedding/index.js');
const { QdrantBackend } = await import('../src/features/vector-backend/qdrant.js');
const { checkApiUrls, checkEmbeddingProvider } = await import('../src/features/diagnostics/infrastructure-checks.js');

// SillyTavern 1.19.0's map for the APIs these profiles use (public/scripts/slash-commands.js setupConnectAPIMap).
const CONNECT_API_MAP = {
    ollama: { selected: 'textgenerationwebui', type: 'ollama' },
    custom: { selected: 'openai', source: 'custom' },
};
const HARBOR = { id: 'p-harbor', name: 'Harbor Ollama', api: 'ollama', 'api-url': 'http://harbor:11434', model: 'harbor-embed' };

const host = vi.hoisted(() => ({ profiles: [], disabledExtensions: [], contextReads: 0 }));

beforeEach(() => {
    host.profiles = [HARBOR];
    host.disabledExtensions = [];
    host.contextReads = 0;
    vi.stubGlobal('SillyTavern', {
        getContext: () => {
            host.contextReads++;
            return {
                extensionSettings: { disabledExtensions: host.disabledExtensions, connectionManager: { profiles: host.profiles } },
                CONNECT_API_MAP,
                ConnectionManagerRequestService: {},
            };
        },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ embedding: [0.1, 0.2, 0.3] }), text: async () => '' })));
});

const MANUAL = { embedding_ollama_url_override: true, embedding_ollama_url: 'http://manual:11434', embedding_ollama_model: 'manual-embed', ollama_keep: true };
const onProfile = (extra = {}) => ({ embedding_provider: 'ollama', embedding_connection_profile_id: 'p-harbor', vector_backend: 'qdrant', ...MANUAL, ...extra });
const sentBody = (call = 0) => JSON.parse(fetch.mock.calls[call][1].body);
const ITEM = { hash: 52001, index: 0, text: 'Keeper Orrin trims the lighthouse lamp at dusk.', metadata: {} };

describe('embedding on an Ollama profile', () => {
    it('takes the URL and the model from the profile, never the manual fields', () => {
        expect(resolveProviderApiUrl(onProfile())).toBe('http://harbor:11434');
        expect(resolveProviderApiUrl(onProfile(), 'ollama')).toBe('http://harbor:11434');
        expect(getModelFromSettings(onProfile())).toBe('harbor-embed');
        expect(resolveEmbeddingProfile(onProfile())).toEqual({ profileName: 'Harbor Ollama', url: 'http://harbor:11434', model: 'harbor-embed', problem: '' });
    });

    it('sends the profile\'s URL and model on a query and an insert, with Keep model in memory', async () => {
        const backend = new QdrantBackend();
        await backend.embedQuery('Where is the lamp?', onProfile());
        expect(sentBody(0)).toMatchObject({ source: 'ollama', model: 'harbor-embed', apiUrl: 'http://harbor:11434', keep: true });

        await backend.insertVectorItems('vf_test_harbor', [ITEM], onProfile());
        expect(fetch.mock.calls[1][0]).toBe('/api/plugins/similharity/chunks/insert');
        expect(sentBody(1)).toMatchObject({ source: 'ollama', model: 'harbor-embed', apiUrl: 'http://harbor:11434', keep: true });
    });

    it('passes the diagnostics checks, naming the profile and its URL', async () => {
        await expect(checkEmbeddingProvider(onProfile())).resolves.toMatchObject({ status: 'pass', message: 'Using Ollama (harbor-embed) on profile "Harbor Ollama"' });
        expect(checkApiUrls(onProfile())).toMatchObject({ status: 'pass', message: 'http://harbor:11434' });
    });
});

describe('an Ollama profile that cannot be used', () => {
    const BROKEN = {
        'deleted in SillyTavern': [() => { host.profiles = []; }, 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.'],
        'while the Connection Manager is off': [() => { host.disabledExtensions = ['connection-manager']; }, /^Embedding: SillyTavern's Connection Manager extension is off/],
        'of another type': [() => { host.profiles = [{ ...HARBOR, api: 'custom' }]; }, /^Embedding: profile "Harbor Ollama" \(API "custom"\) cannot embed/],
        'naming no server URL': [() => { host.profiles = [{ ...HARBOR, 'api-url': ' ' }]; }, 'Embedding: profile "Harbor Ollama" names no server URL. Set one in that profile in SillyTavern.'],
        'naming no model': [() => { host.profiles = [{ ...HARBOR, model: '' }]; }, 'Embedding: profile "Harbor Ollama" names no model. Choose an embedding model in that profile in SillyTavern.'],
    };

    for (const [state, [arrange, reason]] of Object.entries(BROKEN)) {
        it(`stops before any request on a profile ${state}, and says why`, async () => {
            arrange();
            const settings = onProfile();
            const expected = { code: 'invalid_model_config', message: reason instanceof RegExp ? expect.stringMatching(reason) : reason };
            expect(() => resolveProviderApiUrl(settings)).toThrow(expect.objectContaining(expected));
            const backend = new QdrantBackend();
            await expect(backend.embedQuery('Where is the lamp?', settings)).rejects.toMatchObject(expected);
            await expect(backend.insertVectorItems('vf_test_harbor', [ITEM], settings)).rejects.toMatchObject(expected);
            expect(fetch).not.toHaveBeenCalled();
            await expect(checkEmbeddingProvider(settings)).resolves.toMatchObject({ status: 'fail', message: expected.message });
            expect(checkApiUrls(settings)).toMatchObject({ status: 'fail', message: expected.message });
        });
    }

    it('still names the model a profile holds, and none for a deleted profile', () => {
        host.profiles = [{ ...HARBOR, 'api-url': '' }];
        expect(getModelFromSettings(onProfile())).toBe('harbor-embed');
        host.profiles = [];
        expect(getModelFromSettings(onProfile())).toBe('');
        expect(getModelFromSettings(onProfile(), null)).toBeNull();
    });
});

describe('manual Ollama', () => {
    it('reads its own fields and SillyTavern\'s server URL, and never looks for a profile', () => {
        const manual = { embedding_provider: 'ollama', ...MANUAL };
        expect(resolveProviderApiUrl(manual)).toBe('http://manual:11434');
        expect(resolveProviderApiUrl({ ...manual, embedding_ollama_url_override: false })).toBe('http://sillytavern-ollama:11434');
        expect(getModelFromSettings(manual)).toBe('manual-embed');
        expect(resolveEmbeddingProfile(manual)).toBeNull();
        expect(host.contextReads).toBe(0);
    });

    it('leaves a profile ID unread on a provider no profile carries', () => {
        const openRouter = { embedding_provider: 'openrouter', embedding_connection_profile_id: 'p-harbor', embedding_openrouter_model: 'baai/bge-m3' };
        expect(getModelFromSettings(openRouter)).toBe('baai/bge-m3');
        expect(resolveProviderApiUrl(openRouter)).toBeUndefined();
        expect(resolveEmbeddingProfile(openRouter)).toBeNull();
        expect(host.contextReads).toBe(0);
    });

    it('sends its own URL and model on a query', async () => {
        await new QdrantBackend().embedQuery('Where is the lamp?', { embedding_provider: 'ollama', vector_backend: 'qdrant', ...MANUAL });
        expect(sentBody(0)).toMatchObject({ source: 'ollama', model: 'manual-embed', apiUrl: 'http://manual:11434', keep: true });
    });
});
