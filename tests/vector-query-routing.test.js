/**
 * A collection query's route to its backend (src/features/vector-backend/vector-api.js, queryCollection), with only
 * `fetch` mocked: everything from queryCollection down through hybrid-search.js to QdrantBackend and StandardBackend
 * is the real code. It pins:
 *   - which plugin endpoint a query reaches, per backend, with the BARE collection ID once the registry key is resolved
 *   - that each Qdrant hybrid hit scores the cosine of a dense lookup, not the rank-derived RRF fused score
 *   - that the query is embedded once, and that every fallback reuses that vector
 *   - what a failed embedding or a failed backend does: one retry of a failing embedding, none of an invalid model,
 *     one fallback for a failed hybrid query, and a thrown error when every route fails
 * EventBase's search sends its queries this way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vitest.config.js maps every SillyTavern import to one module per served URL, so
// "../../../../extensions.js" from here is the module src/sillytavern/ imports.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    modules: [],
    getContext: vi.fn(() => ({ chat: [], groupId: null, name1: 'Wren', name2: 'Keeper Orrin', characterId: '3' })),
}));
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
    getCurrentChatId: vi.fn(() => 'chat-harbor'),
    chat_metadata: { integrity: 'chat-uuid-123' },
    setExtensionPrompt: vi.fn(),
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: {},
    substituteParams: vi.fn(text => text),
    saveSettings: vi.fn(),
    saveSettingsDebounced: vi.fn(),
}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {}, writeSecret: vi.fn(), readSecretState: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', LLAMACPP: 'llamacpp', VLLM: 'vllm' },
    textgenerationwebui_settings: { server_urls: {} },
}));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => true) }));

const { queryCollection } = await import('../src/features/vector-backend/vector-api.js');
const { resetBackendHealth } = await import('../src/features/vector-backend/backend-registry.js');
const { invalidateCollectionMetadata } = await import('../src/features/vector-backend/tokenizer-lock.js');
const { resetRetrievalFailureNotifications } = await import('../src/shared/model-config-notifier.js');

/** Registry keys as the insert writes them: "<backend>:<bare id>". */
const QDRANT_ID = 'vf_eventbase_qdrant_wren_keeper_orrin_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const QDRANT_KEY = `qdrant:${QDRANT_ID}`;
const VECTRA_ID = 'vf_eventbase_standard_wren_keeper_orrin_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const VECTRA_KEY = `vectra:${VECTRA_ID}`;
const QUERY = 'Who keeps the lighthouse of Vell?';

function chunk(hash, score) {
    return { hash, text: 'Keeper Orrin keeps the lighthouse of Vell.', score, metadata: { eventbase: true, event_id: `event-${hash}` } };
}

function settingsWith(overrides = {}) {
    return {
        vector_backend: 'qdrant',
        embedding_provider: 'transformers',
        keyword_scoring_method: 'hybrid',
        hybrid_native_prefer: true,
        cjk_tokenizer_mode: 'intl',
        qdrant_multitenancy: false,
        qdrant_host: '127.0.0.1',
        qdrant_port: 6333,
        ...overrides,
    };
}

// ============================================================================
// FETCH ROUTER
// ============================================================================

/** Every request a test made: { url, body }. */
let fetchLog = [];
let hybridQueryResponder;
let plainQueryResponder;
/**
 * Qdrant's /chunks/query serves two callers: the dense lookup QdrantBackend.hybridQuery sends beside every native
 * hybrid query for each hit's cosine, and hybrid-search.js's client-side fallback when the hybrid query fails.
 */
let denseQueryResponder;
let embeddingResponder;

/** What /get-embedding returns: every query of one call must reuse this vector. */
const QUERY_VECTOR = [0.1, 0.2, 0.3];

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, statusText: ok ? 'OK' : 'Internal Server Error', json: async () => body, text: async () => JSON.stringify(body) };
}

function installFetchRouter() {
    global.fetch = vi.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        fetchLog.push({ url, body });
        if (url === '/api/plugins/similharity/health') return jsonResponse({ ok: true });
        if (url === '/api/plugins/similharity/backend/init/qdrant') return jsonResponse({ success: true });
        if (url === '/api/plugins/similharity/backend/health/qdrant') return jsonResponse({ healthy: true });
        if (url === '/api/plugins/similharity/backend/init/vectra') return jsonResponse({ success: true });
        if (url === '/api/vector/list') return jsonResponse([]);
        if (url === '/api/plugins/similharity/chunks/collection-metadata') return jsonResponse({ payload: { cjk_tokenizer_mode: 'intl' } });
        if (url === '/api/plugins/similharity/get-embedding') return embeddingResponder(body);
        if (url === '/api/plugins/similharity/chunks/hybrid-query') return hybridQueryResponder(body);
        if (url === '/api/plugins/similharity/chunks/query' && body?.backend === 'qdrant') return denseQueryResponder(body);
        if (url === '/api/plugins/similharity/chunks/query' || url === '/api/vector/query') return plainQueryResponder(body);
        return jsonResponse({ error: `unrouted: ${url}` }, { ok: false, status: 404 });
    });
}

const RETRIEVAL_URL = /chunks\/hybrid-query$|chunks\/query$|api\/vector\/query$/;
const retrievals = () => fetchLog.filter(request => RETRIEVAL_URL.test(request.url));
const embeddings = () => fetchLog.filter(request => request.url === '/api/plugins/similharity/get-embedding');

function failEveryRetrieval() {
    const failed = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
    hybridQueryResponder = failed;
    plainQueryResponder = failed;
    denseQueryResponder = failed;
}

beforeEach(async () => {
    fetchLog = [];
    hybridQueryResponder = () => jsonResponse({ success: true, results: [] });
    plainQueryResponder = () => jsonResponse({ success: true, results: [] });
    denseQueryResponder = () => jsonResponse({ success: true, results: [{ hash: 111, score: 0.83 }] });
    embeddingResponder = () => jsonResponse({ success: true, embedding: QUERY_VECTOR });
    installFetchRouter();
    global.toastr = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
    // Backends and the tokenizer sentinel are cached across calls; each test starts cold.
    resetBackendHealth();
    invalidateCollectionMetadata(QDRANT_ID);
    invalidateCollectionMetadata(VECTRA_ID);
    resetRetrievalFailureNotifications();
    const { extension_settings } = await import('../../../../extensions.js');
    extension_settings.vectfox = settingsWith();
});

afterEach(() => {
    vi.clearAllMocks();
});

// ============================================================================
// TESTS
// ============================================================================

describe('a Qdrant collection', () => {
    it('sends the query to the plugin hybrid-query endpoint with the BARE collection ID', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunk(111, 0.0164)] });
        await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        const hybrid = fetchLog.filter(request => request.url === '/api/plugins/similharity/chunks/hybrid-query');
        expect(hybrid).toHaveLength(1);
        expect(hybrid[0].body.backend).toBe('qdrant');
        // The "qdrant:" registry prefix is stripped: the prefixed form names a collection that does not exist.
        expect(hybrid[0].body.collectionId).toBe(QDRANT_ID);
        // Native sparse hybrid needs the browser-computed sparse query vector.
        expect(Array.isArray(hybrid[0].body.sparseQueryVector?.indices)).toBe(true);
        expect(retrievals().map(request => request.url)).not.toContain('/api/vector/query');
    });

    it("scores each hit by the dense lookup's cosine, keeping the RRF fused score apart", async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunk(1, 0.0164), chunk(2, 0.0161)] });
        denseQueryResponder = () => jsonResponse({ success: true, results: [{ hash: 1, score: 0.72 }, { hash: 2, score: 0.26 }] });
        const result = await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        expect(result.metadata.map(hit => [hit.hash, hit.score])).toEqual([[1, 0.72], [2, 0.26]]);
        expect(result.metadata[0].fusionScore).toBeCloseTo(0.0164, 5);
    });

    it('scores 0 a hit only the keyword leg found, which the dense lookup does not hold', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunk(777, 0.0164)] });
        denseQueryResponder = () => jsonResponse({ success: true, results: [] });
        const result = await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        expect(result.metadata.map(hit => hit.score)).toEqual([0]);
    });

    it('embeds the query once, for both the hybrid query and the dense lookup', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunk(111, 0.0164)] });
        await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        expect(embeddings()).toHaveLength(1);
        const hybrid = fetchLog.find(request => request.url === '/api/plugins/similharity/chunks/hybrid-query');
        expect(hybrid.body.queryVector).toEqual(QUERY_VECTOR);
        // The text rides along, so an older plugin that ignores queryVector embeds it itself.
        expect(hybrid.body.searchText).toBeTruthy();
        const dense = fetchLog.find(request => request.url === '/api/plugins/similharity/chunks/query' && request.body?.queryVector);
        expect(dense.body.queryVector).toEqual(QUERY_VECTOR);
    });

    it('falls back to the vector-only query when the hybrid endpoint fails', async () => {
        hybridQueryResponder = () => jsonResponse({ error: 'sparse vector not configured' }, { ok: false, status: 500 });
        denseQueryResponder = () => jsonResponse({ success: true, results: [chunk(111, 0.83)] });
        const result = await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        expect(retrievals().map(request => request.url)).toContain('/api/plugins/similharity/chunks/query');
        expect(result.metadata.map(hit => hit.hash)).toEqual([111]);
    });
});

describe('a Vectra collection', () => {
    it('goes to the plugin query path, never to hybrid-query, with the bare ID and the one query vector', async () => {
        plainQueryResponder = () => jsonResponse({ success: true, results: [chunk(111, 0.83)] });
        const result = await queryCollection(VECTRA_KEY, QUERY, 3, settingsWith({ vector_backend: 'standard' }));

        const urls = retrievals().map(request => request.url);
        expect(urls).not.toContain('/api/plugins/similharity/chunks/hybrid-query');
        const query = fetchLog.find(request => request.url === '/api/plugins/similharity/chunks/query');
        expect(query.body).toMatchObject({ backend: 'vectra', collectionId: VECTRA_ID, queryVector: QUERY_VECTOR });
        expect(result.metadata).toHaveLength(1);
    });
});

describe('a failing backend or embedding', () => {
    it('sends one fallback after a failed hybrid query, on the same vector, then throws', async () => {
        failEveryRetrieval();
        await expect(queryCollection(QDRANT_KEY, QUERY, 3, settingsWith())).rejects.toThrow();

        expect(retrievals().map(request => request.url)).toEqual([
            '/api/plugins/similharity/chunks/query', // the dense lookup beside the hybrid query
            '/api/plugins/similharity/chunks/hybrid-query', // the native hybrid query, which fails
            '/api/plugins/similharity/chunks/query', // hybrid-search.js's client-side fallback
        ]);
        expect(retrievals()[0].body.queryVector).toEqual(QUERY_VECTOR);
        expect(retrievals()[2].body.queryVector).toEqual(QUERY_VECTOR);
        expect(embeddings()).toHaveLength(1);
    });

    it('retries a failed query embedding once, then queries on the new vector', async () => {
        let embeddingCalls = 0;
        embeddingResponder = () => (++embeddingCalls === 1
            ? jsonResponse({ error: 'API request failed' }, { ok: false, status: 500 })
            : jsonResponse({ success: true, embedding: QUERY_VECTOR }));
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunk(111, 0.0164)] });
        const result = await queryCollection(QDRANT_KEY, QUERY, 3, settingsWith());

        expect(embeddingCalls).toBe(2);
        expect(result.metadata).toHaveLength(1);
    });

    it('throws after the one retry, without any retrieval call', async () => {
        embeddingResponder = () => jsonResponse({ error: 'API request failed' }, { ok: false, status: 500 });
        await expect(queryCollection(QDRANT_KEY, QUERY, 3, settingsWith())).rejects.toThrow();

        expect(embeddings()).toHaveLength(2);
        expect(retrievals()).toEqual([]);
    });

    it('does not retry an invalid-model embedding error, which fails the same way every time', async () => {
        embeddingResponder = () => jsonResponse({ error: 'No endpoints found for baai/bge-m3' }, { ok: false, status: 404 });
        await expect(queryCollection(QDRANT_KEY, QUERY, 3, settingsWith())).rejects.toThrow();

        expect(embeddings()).toHaveLength(1);
        expect(retrievals()).toEqual([]);
    });
});
