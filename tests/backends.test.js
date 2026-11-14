/**
 * Backend Unit Tests
 * Tests for Standard and Qdrant vector backends
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock getRequestHeaders before importing backends
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token',
    })),
}));

// Mock extensions.js
vi.mock('../../../../extensions.js', () => ({
    extension_settings: {
        apiUrl: 'http://localhost:5100',
        apiKey: 'test-api-key',
    },
}));

// Mock textgen-settings.js
vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: {
        OLLAMA: 'ollama',
        LLAMACPP: 'llamacpp',
        VLLM: 'vllm',
    },
    textgenerationwebui_settings: {
        server_urls: {
            ollama: 'http://localhost:11434',
            llamacpp: 'http://localhost:8080',
            vllm: 'http://localhost:8000',
        },
    },
}));

// Mock openai.js
vi.mock('../../../../openai.js', () => ({
    oai_settings: {
        vertexai_auth_mode: 'service_account',
        vertexai_region: 'us-central1',
        vertexai_express_project_id: 'test-project',
    },
}));

// Mock secrets.js
vi.mock('../../../../secrets.js', () => ({
    secret_state: {},
}));

// StandardBackend.initialize() detects the plugin through similharity-plugin.js's
// checkPluginAvailable(). Stub it at the unit boundary so these tests drive
// availability through the fetchMock /health response, with `response.ok`
// semantics and the single-arg /health call the assertions expect.
vi.mock('../src/shared/similharity-plugin.js', () => ({
    checkPluginAvailable: vi.fn(async () => {
        try {
            const r = await fetch('/api/plugins/similharity/health');
            return !!r?.ok;
        } catch {
            return false;
        }
    }),
    resetPluginAvailableCache: vi.fn(),
    // The installed plugin meets the floor unless a test says otherwise.
    similharityStanding: vi.fn(() => ({ isFound: true, version: '3.4.8', requiredVersion: '3.4.8', isCurrent: true })),
    PLUGIN_UPDATE_INSTRUCTIONS: 'Restart SillyTavern so it can auto-update the server plugin.',
}));

// Mock providers.js
vi.mock('../src/features/embedding/providers.js', () => ({
    getModelField: vi.fn((source) => {
        const modelFields = {
            openai: 'openai_model',
            cohere: 'cohere_model',
            ollama: 'ollama_model',
            transformers: null,
        };
        return modelFields[source] || null;
    }),
    getModelFromSettings: vi.fn(() => 'test-model'),
    // A manual provider's requests name no profile fields.
    embeddingProfileRequestFields: vi.fn(async () => ({})),
}));

// Mock constants.js
vi.mock('../src/shared/constants.js', () => ({
    VECTOR_LIST_LIMIT: 10000,
    // Reached via backends -> embedding-latency-warning -> retrieval-budget,
    // which derives its slow-embed log threshold from the retrieval budget.
    // All seven are required: retrieval-budget.js imports them by name, and a
    // mock factory that omits one makes the import throw.
    RETRIEVAL_TIMEOUT_DEFAULT_MS: 15000,
    RETRIEVAL_TIMEOUT_MIN_MS: 3000,
    RETRIEVAL_TIMEOUT_MAX_MS: 120000,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS: 30000,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS: 10000,
    AGENTIC_TIMEOUT_MIN_MS: 1000,
    AGENTIC_TIMEOUT_MAX_MS: 60000,
}));

// Import backends after mocks are set up
import { StandardBackend } from '../src/features/vector-backend/standard.js';
import { QdrantBackend, setInsertedCollectionRegistrar } from '../src/features/vector-backend/qdrant.js';
import { qdrantTarget } from '../src/features/vector-backend/qdrant-target.js';
import { similharityStanding } from '../src/shared/similharity-plugin.js';
import { buildRegistryKey } from '../src/shared/collection-ids.js';
import { VectorBackend } from '../src/features/vector-backend/backend-interface.js';

// =============================================================================
// TEST UTILITIES
// =============================================================================

/**
 * Create a mock fetch response
 */
function mockFetchResponse(data, options = {}) {
    return Promise.resolve({
        ok: options.ok !== false,
        status: options.status || 200,
        statusText: options.statusText || 'OK',
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
    });
}

/**
 * Create a mock fetch error response
 */
function mockFetchError(status, message) {
    return Promise.resolve({
        ok: false,
        status,
        statusText: message,
        json: () => Promise.reject(new Error('Not JSON')),
        text: () => Promise.resolve(message),
    });
}

/**
 * Default test settings
 */
const defaultSettings = {
    embedding_provider: 'transformers',
    score_threshold: 0.25,
    openai_model: 'text-embedding-ada-002',
    cohere_model: 'embed-english-v3.0',
    embedding_ollama_model: 'mxbai-embed-large',
};

/**
 * Sample test items for insertion
 */
const sampleItems = [
    { hash: 12345, text: 'Hello world', index: 0, vector: [0.1, 0.2, 0.3] },
    { hash: 67890, text: 'Test message', index: 1, vector: [0.4, 0.5, 0.6] },
];

// =============================================================================
// VECTOR BACKEND INTERFACE TESTS
// =============================================================================

describe('VectorBackend Interface', () => {
    it('should throw errors for unimplemented methods', async () => {
        const backend = new VectorBackend();

        await expect(backend.initialize({})).rejects.toThrow('Backend must implement initialize()');
        await expect(backend.healthCheck()).rejects.toThrow('Backend must implement healthCheck()');
        await expect(backend.getSavedHashes('col', {})).rejects.toThrow('Backend must implement getSavedHashes()');
        await expect(backend.insertVectorItems('col', [], {})).rejects.toThrow('Backend must implement insertVectorItems()');
        await expect(backend.deleteVectorItems('col', [], {})).rejects.toThrow('Backend must implement deleteVectorItems()');
        await expect(backend.queryCollection('col', 'text', 5, {})).rejects.toThrow('Backend must implement queryCollection()');
        await expect(backend.queryMultipleCollections([], 'text', 5, 0.5, {})).rejects.toThrow('Backend must implement queryMultipleCollections()');
        await expect(backend.purgeVectorIndex('col', {})).rejects.toThrow('Backend must implement purgeVectorIndex()');
        await expect(backend.purgeFileVectorIndex('col', {})).rejects.toThrow('Backend must implement purgeFileVectorIndex()');
        await expect(backend.purgeAllVectorIndexes({})).rejects.toThrow('Backend must implement purgeAllVectorIndexes()');
    });

    it('should return false for supportsHybridSearch by default', () => {
        const backend = new VectorBackend();
        expect(backend.supportsHybridSearch()).toBe(false);
    });

    it('should fallback to queryCollection for hybridQuery', async () => {
        const backend = new VectorBackend();
        // hybridQuery calls queryCollection which throws
        await expect(backend.hybridQuery('col', 'text', 5, {})).rejects.toThrow('Backend must implement queryCollection()');
    });
});

// =============================================================================
// STANDARD BACKEND TESTS
// =============================================================================

describe('StandardBackend', () => {
    let backend;
    let fetchMock;

    beforeEach(() => {
        backend = new StandardBackend();
        fetchMock = vi.fn();
        global.fetch = fetchMock;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('initialize', () => {
        it('should initialize with plugin available', async () => {
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({}, { ok: true })) // health check
                .mockResolvedValueOnce(mockFetchResponse({})); // init

            await backend.initialize(defaultSettings);

            expect(backend.pluginAvailable).toBe(true);
            expect(fetchMock).toHaveBeenCalledWith('/api/plugins/similharity/health');
        });

        it('should initialize without plugin when health check fails', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(404, 'Not Found'));

            await backend.initialize(defaultSettings);

            expect(backend.pluginAvailable).toBe(false);
        });

        it('should handle network errors during initialization', async () => {
            fetchMock.mockRejectedValueOnce(new Error('Network error'));

            await backend.initialize(defaultSettings);

            expect(backend.pluginAvailable).toBe(false);
        });
    });

    describe('healthCheck', () => {
        it('should return true when ST API is available', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            const result = await backend.healthCheck();

            expect(result).toBe(true);
            expect(fetchMock).toHaveBeenCalledWith('/api/vector/list', expect.any(Object));
        });

        it('should return true even on 500 status (collection not found)', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}, { ok: false, status: 500 }));

            const result = await backend.healthCheck();

            expect(result).toBe(true);
        });

        it('should return false on network error', async () => {
            fetchMock.mockRejectedValueOnce(new Error('Network error'));

            const result = await backend.healthCheck();

            expect(result).toBe(false);
        });
    });

    describe('getSavedHashes', () => {
        it('should return array of hashes', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse([12345, 67890]));

            const result = await backend.getSavedHashes('test-collection', defaultSettings);

            expect(result).toEqual([12345, 67890]);
        });

        it('should return empty array on 500 status', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Collection not found'));

            const result = await backend.getSavedHashes('test-collection', defaultSettings);

            expect(result).toEqual([]);
        });

        it('should throw on other errors', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(403, 'Forbidden'));

            await expect(backend.getSavedHashes('test-collection', defaultSettings))
                .rejects.toThrow('Failed to get saved hashes');
        });
    });

    describe('insertVectorItems', () => {
        beforeEach(async () => {
            // Initialize with plugin available
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({}, { ok: true }))
                .mockResolvedValueOnce(mockFetchResponse({}));
            await backend.initialize(defaultSettings);
            fetchMock.mockClear();
        });

        it('should insert items via plugin API when available', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.insertVectorItems('test-collection', sampleItems, defaultSettings);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/plugins/similharity/chunks/insert',
                expect.objectContaining({
                    method: 'POST',
                })
            );
        });

        it('should skip empty items array', async () => {
            await backend.insertVectorItems('test-collection', [], defaultSettings);

            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('keeps the keywords, importance and summary fields an item carries only in its metadata', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));
            const storedAgain = { hash: 77, index: 0, text: 'The gate stood open.', metadata: { keywords: ['gate'], importance: 7, parentHash: 42 } };

            await backend.insertVectorItems('test-collection', [storedAgain], defaultSettings);

            const [sent] = JSON.parse(fetchMock.mock.calls[0][1].body).items;
            expect(sent.metadata).toMatchObject({ keywords: ['gate'], importance: 7, parentHash: 42 });
        });

        it('should throw on insert failure', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Insert failed'));

            await expect(backend.insertVectorItems('test-collection', sampleItems, defaultSettings))
                .rejects.toThrow('Failed to insert vectors');
        });
    });

    describe('insertVectorItems without plugin', () => {
        beforeEach(async () => {
            // Initialize without plugin
            fetchMock.mockResolvedValueOnce(mockFetchError(404, 'Not Found'));
            await backend.initialize(defaultSettings);
            fetchMock.mockClear();
        });

        it('should insert items via native API when plugin unavailable', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.insertVectorItems('test-collection', sampleItems, defaultSettings);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/vector/insert',
                expect.objectContaining({
                    method: 'POST',
                })
            );
        });
    });

    describe('deleteVectorItems', () => {
        it('should delete items successfully', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.deleteVectorItems('test-collection', [12345, 67890], defaultSettings);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/vector/delete',
                expect.objectContaining({
                    method: 'POST',
                })
            );
        });

        it('should throw on delete failure', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Delete failed'));

            await expect(backend.deleteVectorItems('test-collection', [12345], defaultSettings))
                .rejects.toThrow('Failed to delete vectors');
        });
    });

    describe('queryCollection', () => {
        it('should query and return results', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({
                hashes: [12345, 67890],
                metadata: [
                    { text: 'Result 1', score: 0.9 },
                    { text: 'Result 2', score: 0.8 },
                ],
            }));

            const result = await backend.queryCollection('test-collection', 'search query', 5, defaultSettings);

            expect(result.hashes).toEqual([12345, 67890]);
            expect(result.metadata).toHaveLength(2);
            expect(result.metadata[0].score).toBe(0.9);
        });

        it('should include pre-computed query vector when provided', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ hashes: [], metadata: [] }));

            const queryVector = [0.1, 0.2, 0.3];
            await backend.queryCollection('test-collection', 'search query', 5, defaultSettings, queryVector);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.embeddings).toBeDefined();
            expect(callBody.embeddings['search query']).toEqual(queryVector);
        });

        it('should throw on query failure', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Query failed'));

            await expect(backend.queryCollection('test-collection', 'search', 5, defaultSettings))
                .rejects.toThrow('Failed to query collection');
        });
    });

    describe('queryMultipleCollections', () => {
        it('should query multiple collections', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({
                'col1': { hashes: [1], metadata: [{ text: 'A', score: 0.9 }] },
                'col2': { hashes: [2], metadata: [{ text: 'B', score: 0.8 }] },
            }));

            const result = await backend.queryMultipleCollections(
                ['col1', 'col2'],
                'search',
                5,
                0.25,
                defaultSettings
            );

            expect(result.col1).toBeDefined();
            expect(result.col2).toBeDefined();
        });

        it('should fallback to individual queries on multi-query failure', async () => {
            // First call fails (multi-query)
            fetchMock
                .mockResolvedValueOnce(mockFetchError(404, 'Not Found'))
                // Individual queries succeed
                .mockResolvedValueOnce(mockFetchResponse({ hashes: [1], metadata: [{ text: 'A', score: 0.9 }] }))
                .mockResolvedValueOnce(mockFetchResponse({ hashes: [2], metadata: [{ text: 'B', score: 0.8 }] }));

            const result = await backend.queryMultipleCollections(
                ['col1', 'col2'],
                'search',
                5,
                0.25,
                defaultSettings
            );

            expect(result.col1).toBeDefined();
            expect(result.col2).toBeDefined();
        });
    });

    describe('purgeVectorIndex', () => {
        it('should purge collection successfully', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.purgeVectorIndex('test-collection', defaultSettings);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/vector/purge',
                expect.objectContaining({
                    method: 'POST',
                })
            );
        });

        it('should throw on purge failure', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Purge failed'));

            await expect(backend.purgeVectorIndex('test-collection', defaultSettings))
                .rejects.toThrow('Failed to purge collection');
        });
    });

    describe('purgeVectorIndex with plugin', () => {
        beforeEach(() => {
            backend.pluginAvailable = true;
            fetchMock.mockImplementation(() => mockFetchResponse({ success: true }));
        });

        const purgeBodies = () => fetchMock.mock.calls
            .filter(([url]) => url === '/api/plugins/similharity/chunks/purge')
            .map(([, opts]) => JSON.parse(opts.body));

        it('purges every discovered source folder, not the current embedding provider', async () => {
            // Collection written under transformers, plus an empty leftover under
            // openrouter. The current provider (openrouter) must not decide the path.
            await backend.purgeVectorIndex('col', {
                ...defaultSettings,
                embedding_provider: 'openrouter',
                _discoveredSources: [
                    { source: 'openrouter', models: [{ name: 'baaibge-m3', path: 'baaibge-m3', chunkCount: 0 }] },
                    { source: 'transformers', models: [{ name: 'jina', path: 'jina', chunkCount: 56 }] },
                ],
            });

            expect(purgeBodies()).toEqual([
                { backend: 'vectra', collectionId: 'col', source: 'openrouter', model: 'baaibge-m3' },
                { backend: 'vectra', collectionId: 'col', source: 'transformers', model: 'jina' },
            ]);
        });

        it('sends an empty model for a model-less index instead of the model object', async () => {
            await backend.purgeVectorIndex('col', {
                ...defaultSettings,
                _discoveredSources: [{ source: 'unknown', models: [{ name: '(default)', path: null, chunkCount: 0 }] }],
            });

            expect(purgeBodies()).toEqual([
                { backend: 'vectra', collectionId: 'col', source: 'unknown', model: '' },
            ]);
        });

        it('targets the current provider when no discovery data is passed', async () => {
            await backend.purgeVectorIndex('col', defaultSettings);

            expect(purgeBodies()).toHaveLength(1);
            expect(purgeBodies()[0].source).toBe('transformers');
        });
    });

    describe('embedQuery', () => {
        it("returns null without the plugin, so ST's native query embeds per request", async () => {
            backend.pluginAvailable = false;

            await expect(backend.embedQuery('text', defaultSettings)).resolves.toBeNull();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('embeds through the plugin /get-embedding route when the plugin is available', async () => {
            backend.pluginAvailable = true;
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ embedding: [0.1, 0.2] }));

            await expect(backend.embedQuery('text', defaultSettings)).resolves.toEqual([0.1, 0.2]);
            expect(fetchMock).toHaveBeenCalledWith('/api/plugins/similharity/get-embedding', expect.objectContaining({ method: 'POST' }));
        });
    });

    describe('purgeAllVectorIndexes', () => {
        it('should purge all collections successfully', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.purgeAllVectorIndexes(defaultSettings);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/vector/purge-all',
                expect.objectContaining({
                    method: 'POST',
                })
            );
        });
    });

    describe('supportsHybridSearch', () => {
        it('should return false (no native hybrid support)', () => {
            expect(backend.supportsHybridSearch()).toBe(false);
        });
    });
});


// =============================================================================
// QDRANT BACKEND TESTS
// =============================================================================

describe('QdrantBackend', () => {
    let backend;
    let fetchMock;
    // Stands in for collection-loader's registerCollection, which index.js sets at startup.
    const registrar = vi.fn();

    beforeEach(async () => {
        backend = new QdrantBackend();
        fetchMock = vi.fn();
        global.fetch = fetchMock;
        registrar.mockClear();
        setInsertedCollectionRegistrar(registrar);
        // tokenizer-lock caches sentinel metadata per-collection; clear between tests so
        // each hybridQuery test starts with a clean sentinel state.
        const { invalidateCollectionMetadata } = await import('../src/features/vector-backend/tokenizer-lock.js');
        invalidateCollectionMetadata('test-collection');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('initialize', () => {
        it('should initialize local Qdrant', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            const settings = {
                ...defaultSettings,
                qdrant_use_cloud: false,
                qdrant_host: 'localhost',
                qdrant_port: 6333,
            };

            await backend.initialize(settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.host).toBe('localhost');
            expect(callBody.port).toBe(6333);
            expect(callBody.url).toBeNull();
        });

        it('should initialize Qdrant Cloud with no key, so Similharity reads it on the server, a key left in settings included', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            const settings = {
                ...defaultSettings,
                qdrant_use_cloud: true,
                qdrant_url: 'https://my-cluster.cloud.qdrant.io',
                qdrant_api_key: 'my-api-key',
            };

            await backend.initialize(settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.url).toBe('https://my-cluster.cloud.qdrant.io');
            expect(callBody.apiKey).toBeNull();
            expect(callBody.host).toBeNull();
            expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('my-api-key');
        });
    });

    describe('healthCheck', () => {
        it('should return true when healthy', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ healthy: true }));

            const result = await backend.healthCheck();

            expect(result).toBe(true);
        });
    });

    describe('_stripRegistryPrefix', () => {
        it('should strip backend:source: prefix', () => {
            expect(backend._stripRegistryPrefix('qdrant:openai:my-collection'))
                .toBe('my-collection');
        });
    });

    describe('_parseCollectionId', () => {
        it('should parse VectFox format (vf_type_id)', () => {
            const result = backend._parseCollectionId('vf_chat_abc123');
            expect(result.type).toBe('chat');
            expect(result.sourceId).toBe('abc123');
        });

        it('should handle registry key prefix', () => {
            const result = backend._parseCollectionId('qdrant:transformers:vf_chat_abc123');
            expect(result.type).toBe('chat');
            expect(result.sourceId).toBe('abc123');
        });
    });

    describe('multitenancy mode', () => {
        it('should use shared collection in multitenancy mode', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ items: [] }));

            const settings = { ...defaultSettings, qdrant_multitenancy: true };
            await backend.getSavedHashes('vf_chat_abc123', settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.collectionId).toBe('vectfox_main');
            expect(callBody.filters).toEqual({ content_type: 'vf_chat_abc123' });
            expect(callBody.filter).toBeUndefined();
        });

        it('should use separate collections in non-multitenancy mode', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ items: [] }));

            const settings = { ...defaultSettings, qdrant_multitenancy: false };
            await backend.getSavedHashes('vf_chat_abc123', settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.collectionId).toBe('vf_chat_abc123');
            expect(callBody.filters).toEqual({});
            expect(callBody.filter).toBeUndefined();
        });
    });

    describe('the shared collection: every request keeps to the points of one collection (issue #30)', () => {
        const shared = { ...defaultSettings, qdrant_multitenancy: true };
        const tenant = { content_type: 'vf_chat_abc123' };
        const bodyOf = call => JSON.parse(fetchMock.mock.calls[call][1].body);

        it('routes a collection, or its registry key, to vectfox_main with the collection as the tenant', () => {
            expect(qdrantTarget('qdrant:vf_chat_abc123', shared)).toEqual({ collectionId: 'vectfox_main', filters: tenant });
            expect(qdrantTarget('qdrant:vf_chat_abc123', defaultSettings)).toEqual({ collectionId: 'vf_chat_abc123', filters: {} });
        });

        it('sends the tenant as filters on a delete, a search, a listing, a metadata change and the stats', async () => {
            fetchMock.mockImplementation(async () => mockFetchResponse({ results: [], items: [], stats: {} }));

            await backend.deleteVectorItems('vf_chat_abc123', [1, 2], shared);
            await backend.queryCollection('vf_chat_abc123', 'search', 5, shared, [0.1, 0.2]);
            await backend.listChunks('vf_chat_abc123', shared);
            await backend.updateChunkMetadata('vf_chat_abc123', 1, { enabled: false }, shared);
            await backend.getStats('vf_chat_abc123', shared);

            for (const call of [0, 1, 2, 3, 4]) {
                expect(bodyOf(call)).toMatchObject({ collectionId: 'vectfox_main', filters: tenant });
                expect(bodyOf(call).filter).toBeUndefined();
            }
        });

        it('passes the tenant to a single chunk read in its query string', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ chunk: null }));

            await backend.getChunk('vf_chat_abc123', 1, shared);

            const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
            expect(url.searchParams.get('collectionId')).toBe('vectfox_main');
            expect(JSON.parse(url.searchParams.get('filters'))).toEqual(tenant);
        });

        it('keeps the cosine lookup of a hybrid search to the tenant, as the hybrid query itself is', async () => {
            fetchMock.mockImplementation(async (url) => (url.endsWith('collection-metadata')
                ? mockFetchResponse({ payload: null, supported: true })
                : mockFetchResponse({ results: [] })));

            await backend.hybridQuery('vf_chat_abc123', 'search', 5, shared, {}, [0.4, 0.5]);

            const searches = fetchMock.mock.calls.filter(([url]) => /chunks\/(hybrid-query|query)$/.test(url));
            expect(searches).toHaveLength(2);
            for (const [, options] of searches) {
                expect(JSON.parse(options.body)).toMatchObject({ collectionId: 'vectfox_main', filters: tenant });
            }
        });

        it('purges the points of the collection from vectfox_main by its tenant', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

            await backend.purgeVectorIndex('vf_chat_abc123', shared);

            expect(bodyOf(0)).toMatchObject({ collectionId: 'vectfox_main', filters: tenant });
        });

        it('deletes nothing and says why when Similharity is older than the floor, which would ignore the tenant', async () => {
            similharityStanding.mockReturnValueOnce({ isFound: true, version: '3.4.6', requiredVersion: '3.4.8', isCurrent: false })
                .mockReturnValueOnce({ isFound: true, version: '3.4.6', requiredVersion: '3.4.8', isCurrent: false });

            await expect(backend.purgeVectorIndex('vf_chat_abc123', shared))
                .rejects.toThrow('Deleting a collection from the shared Qdrant collection needs Similharity 3.4.8 or later, and 3.4.6 is installed');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('purges a collection of its own whole, with no tenant, when the shared collection is off', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

            await backend.purgeVectorIndex('vf_chat_abc123', defaultSettings);

            expect(bodyOf(0).collectionId).toBe('vf_chat_abc123');
            expect(bodyOf(0).filters).toBeUndefined();
        });
    });

    describe('insertVectorItems', () => {
        it('registers the collection under its registry key after a successful insert', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            await backend.insertVectorItems('vf_chat_abc123', sampleItems, defaultSettings);

            expect(registrar).toHaveBeenCalledWith(buildRegistryKey('vf_chat_abc123', defaultSettings));
        });

        it('stops with the configuration error, naming both sizes, when the collection holds another vector size', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, JSON.stringify({ error: 'Vector dimension error: expected dim: 1024, got 768' })));

            const insert = backend.insertVectorItems('vf_chat_abc123', sampleItems, defaultSettings);

            await expect(insert).rejects.toMatchObject({
                code: 'invalid_model_config',
                message: 'Embedding: this collection holds vectors of size 1024, but the current embedding model makes size 768, so nothing was stored. '
                    + 'Don\'t change the embedding model: a different vector size means re-vectorizing the whole collection. Switch back to the model you were using.',
            });
            expect(registrar).not.toHaveBeenCalled();
        });

        it('stops with the configuration error, naming both CJK tokenizers, when the collection was made with another', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchError(500, JSON.stringify({
                error: '[Qdrant] Tokenizer mode mismatch: collection "vf_chat_abc123" was built with "intl" but insert is using "jieba_tw". '
                    + 'Delete the collection and re-vectorize to switch tokenizer modes.',
            })));

            const insert = backend.insertVectorItems('vf_chat_abc123', sampleItems, { ...defaultSettings, cjk_tokenizer_mode: 'jieba_tw' });

            await expect(insert).rejects.toMatchObject({
                code: 'invalid_model_config',
                message: 'Keyword search: this collection was made with the CJK tokenizer "Intl.Segmenter (English / Latin)", and VectFox is set to '
                    + '"Traditional Chinese (Jieba WASM)", so nothing was stored. Set the CJK tokenizer back to "Intl.Segmenter (English / Latin)", '
                    + 'or delete this collection and vectorize it again.',
            });
            expect(registrar).not.toHaveBeenCalled();
        });

        it('keeps the keywords, importance and summary fields an item carries only in its metadata, and appends the keywords once', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));
            const storedAgain = {
                hash: 77,
                index: 0,
                text: 'The gate stood open. [KEYWORDS: gate]',
                metadata: { keywords: [{ text: 'gate', weight: 1.5 }], importance: 7, isSummaryChunk: true, parentHash: 42 },
            };

            await backend.insertVectorItems('vf_chat_abc123', [storedAgain], defaultSettings);

            const [sent] = JSON.parse(fetchMock.mock.calls[0][1].body).items;
            expect(sent.text).toBe('The gate stood open. [KEYWORDS: gate]');
            expect(sent.metadata).toMatchObject({ keywords: [{ text: 'gate', weight: 1.5 }], importance: 7, isSummaryChunk: true, parentHash: 42 });
        });

        it('should add content_type in multitenancy mode', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

            const settings = { ...defaultSettings, qdrant_multitenancy: true };
            await backend.insertVectorItems('vf_chat_abc123', sampleItems, settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.items[0].metadata.content_type).toBe('vf_chat_abc123');
        });

        it('should batch large insertions', async () => {
            // Create 150 items (should be split into 2 batches of 100)
            const manyItems = Array.from({ length: 150 }, (_, i) => ({
                hash: i,
                text: `Item ${i}`,
                index: i,
            }));

            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({}))
                .mockResolvedValueOnce(mockFetchResponse({}));

            await backend.insertVectorItems('test-collection', manyItems, defaultSettings);

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('supportsHybridSearch', () => {
        it('should return true', () => {
            expect(backend.supportsHybridSearch()).toBe(true);
        });
    });

    describe('purgeVectorIndex', () => {
        it('makes the next tokenizer-sentinel read refetch instead of reusing the cached sentinel', async () => {
            const { fetchCollectionMetadata } = await import('../src/features/vector-backend/tokenizer-lock.js');
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: { cjk_tokenizer_mode: 'jieba' } }))   // sentinel before the purge
                .mockResolvedValueOnce(mockFetchResponse({}))                                              // purge
                .mockResolvedValueOnce(mockFetchResponse({ payload: { cjk_tokenizer_mode: 'intl' } }));   // sentinel after re-vectorizing

            expect(await fetchCollectionMetadata('test-collection')).toEqual({ cjk_tokenizer_mode: 'jieba' });
            await backend.purgeVectorIndex('test-collection', defaultSettings);

            expect(await fetchCollectionMetadata('test-collection')).toEqual({ cjk_tokenizer_mode: 'intl' });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });
    });

    describe('hybridQuery', () => {
        // Call order per hybridQuery: sentinel-metadata fetch (tokenizer-lock
        // check) → /get-embedding (embed ONCE, vector reused by both queries) →
        // dense /chunks/query (cosine-gate lookup, fired in parallel) →
        // /chunks/hybrid-query. The dense fetch lands before the hybrid fetch
        // because its promise is created first.
        it('should call hybrid endpoint with options and report cosine as the score', async () => {
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: null, supported: true }))      // sentinel: no lock
                .mockResolvedValueOnce(mockFetchResponse({ embedding: [0.1, 0.2, 0.3] }))          // get-embedding
                .mockResolvedValueOnce(mockFetchResponse({
                    results: [{ hash: 12345, text: 'Result', score: 0.87 }],                       // dense: cosine
                }))
                .mockResolvedValueOnce(mockFetchResponse({
                    results: [{ hash: 12345, text: 'Result', score: 0.016 }],                      // hybrid: raw RRF
                }));

            const result = await backend.hybridQuery('test-collection', 'search', 5, defaultSettings, {
                vectorWeight: 0.7,
                textWeight: 0.3,
                fusionMethod: 'rrf',
            });

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/plugins/similharity/chunks/hybrid-query',
                expect.any(Object)
            );
            expect(result.metadata[0].hybridSearch).toBe(true);
            // score is the cosine from the dense lookup — thresholds downstream
            // gate on similarity; the rank-derived RRF value moves to fusionScore.
            expect(result.metadata[0].score).toBeCloseTo(0.87, 5);
            expect(result.metadata[0].fusionScore).toBeCloseTo(0.016, 5);
        });

        it('should throw on hybrid failure instead of retrying vector-only itself', async () => {
            // Degradation for the hybrid path belongs to hybridSearch in
            // src/features/vector-backend/hybrid-search.js and lives there ONCE: a
            // retry here would cost an extra HTTP call per failure and hand the caller
            // an empty set it could not tell apart from "no match". See GitHub issue #11.
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: null, supported: true }))      // sentinel
                .mockResolvedValueOnce(mockFetchResponse({ embedding: [0.1, 0.2, 0.3] }))          // get-embedding
                .mockResolvedValueOnce(mockFetchResponse({ results: [] }))                         // dense cosine lookup
                .mockResolvedValueOnce(mockFetchError(404, 'Hybrid not available'));               // hybrid fails

            await expect(backend.hybridQuery('test-collection', 'search', 5, defaultSettings))
                .rejects.toThrow('Hybrid query failed');

            // Exactly four calls: sentinel, embed, cosine lookup, failed hybrid.
            // A FIFTH would mean the removed internal vector-only retry came back
            // (the cosine lookup is part of the happy path, not a retry).
            expect(fetchMock).toHaveBeenCalledTimes(4);
        });

        it('returns empty, not a throw, on a vector size mismatch, and says so in a sticky toast', async () => {
            // Deliberate dead end rather than a fallback: the same mismatch fails on every path.
            globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: null, supported: true }))
                .mockResolvedValueOnce(mockFetchResponse({ embedding: [0.1, 0.2, 0.3] }))
                .mockResolvedValueOnce(mockFetchError(400, 'Vector dimension error: expected dim: 1024, got 768'))  // dense hits it too
                .mockResolvedValueOnce(mockFetchError(400, 'Vector dimension error: expected dim: 1024, got 768'));

            const result = await backend.hybridQuery('test-collection', 'search', 5, defaultSettings);

            expect(result).toEqual({ hashes: [], metadata: [] });
            expect(globalThis.toastr.error).toHaveBeenCalledWith(
                'Embedding: this collection holds vectors of size 1024, but the current embedding model makes size 768, so this search found nothing. '
                    + 'Don\'t change the embedding model: a different vector size means re-vectorizing the whole collection. Switch back to the model you were using.',
                'VectFox — configuration invalid',
                { timeOut: 0, extendedTimeOut: 0 },
            );
            delete globalThis.toastr;
        });

        it('reuses a supplied query vector instead of calling /get-embedding', async () => {
            fetchMock.mockImplementation((url) => (url.endsWith('collection-metadata')
                ? mockFetchResponse({ payload: null, supported: true })
                : mockFetchResponse({ results: [] })));
            const queryVector = [0.4, 0.5, 0.6];

            await backend.hybridQuery('test-collection', 'search', 5, defaultSettings, {}, queryVector);

            const calls = fetchMock.mock.calls.map(([url, opts]) => ({ url, body: opts?.body ? JSON.parse(opts.body) : null }));
            expect(calls.map(c => c.url)).not.toContain('/api/plugins/similharity/get-embedding');
            for (const c of calls.filter(c => /chunks\/(hybrid-query|query)$/.test(c.url))) {
                expect(c.body.queryVector).toEqual(queryVector);
            }
        });
    });

    describe('hybridQueryWithRerank', () => {
        it('sends the supplied vector and falls back to hybridQuery without re-embedding', async () => {
            fetchMock.mockImplementation((url) => {
                if (url.endsWith('collection-metadata')) return mockFetchResponse({ payload: null, supported: true });
                if (url.endsWith('hybrid-query-rerank')) return mockFetchError(400, 'formula queries need Qdrant 1.13');
                return mockFetchResponse({ results: [] });
            });
            const queryVector = [0.4, 0.5, 0.6];

            await backend.hybridQueryWithRerank('test-collection', 'search', 5, defaultSettings, { weights: {} }, {}, queryVector);

            const calls = fetchMock.mock.calls.map(([url, opts]) => ({ url, body: opts?.body ? JSON.parse(opts.body) : null }));
            expect(calls.map(c => c.url)).not.toContain('/api/plugins/similharity/get-embedding');
            const retrievals = calls.filter(c => /chunks\/(hybrid-query-rerank|hybrid-query|query)$/.test(c.url));
            expect(retrievals.map(c => c.url)).toContain('/api/plugins/similharity/chunks/hybrid-query'); // the fallback ran
            for (const c of retrievals) {
                expect(c.body.queryVector).toEqual(queryVector);
            }
        });
    });
});


// =============================================================================
// CROSS-BACKEND CONSISTENCY TESTS
// =============================================================================

describe('Cross-Backend Consistency', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = vi.fn();
        global.fetch = fetchMock;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('all backends should implement VectorBackend interface methods', () => {
        const backends = [
            new StandardBackend(),
            new QdrantBackend(),
        ];

        const requiredMethods = [
            'initialize',
            'healthCheck',
            'getSavedHashes',
            'insertVectorItems',
            'deleteVectorItems',
            'queryCollection',
            'queryMultipleCollections',
            'purgeVectorIndex',
            'purgeFileVectorIndex',
            'purgeAllVectorIndexes',
            'supportsHybridSearch',
            'hybridQuery',
        ];

        for (const backend of backends) {
            for (const method of requiredMethods) {
                expect(typeof backend[method]).toBe('function');
            }
        }
    });

    it('all backends should return consistent query result format', async () => {
        const backends = [
            new StandardBackend(),
            new QdrantBackend(),
        ];

        // Standard backend returns slightly different format from native API
        const mockResponses = {
            StandardBackend: { hashes: [12345], metadata: [{ text: 'Test', score: 0.9 }] },
            QdrantBackend: { results: [{ hash: 12345, text: 'Test', score: 0.9, metadata: {} }] },
        };

        for (const backend of backends) {
            const backendName = backend.constructor.name;
            fetchMock.mockResolvedValueOnce(mockFetchResponse(mockResponses[backendName]));

            const result = await backend.queryCollection('test', 'search', 5, defaultSettings);

            expect(result).toHaveProperty('hashes');
            expect(result).toHaveProperty('metadata');
            expect(Array.isArray(result.hashes)).toBe(true);
            expect(Array.isArray(result.metadata)).toBe(true);
        }
    });

    it('only Qdrant should support hybrid search', () => {
        const standardBackend = new StandardBackend();
        const qdrantBackend = new QdrantBackend();

        expect(standardBackend.supportsHybridSearch()).toBe(false);
        expect(qdrantBackend.supportsHybridSearch()).toBe(true);
    });
});
