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

// Mock collection-loader.js: StandardBackend.initialize() now detects the
// plugin via the canonical checkPluginAvailable() (dynamically imported) instead
// of its own /health probe. Stub it at the unit boundary so these tests drive
// availability through the same fetchMock /health response they always have,
// without loading the real collection-loader dependency graph. The stub keeps
// the historical `response.ok` semantics and the single-arg /health call the
// existing assertions expect.
vi.mock('../core/collection-loader.js', () => ({
    checkPluginAvailable: vi.fn(async () => {
        try {
            const r = await fetch('/api/plugins/similharity/health');
            return !!r?.ok;
        } catch {
            return false;
        }
    }),
    resetPluginAvailableCache: vi.fn(),
}));

// Mock providers.js
vi.mock('../core/providers.js', () => ({
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
}));

// Mock constants.js
vi.mock('../core/constants.js', () => ({
    VECTOR_LIST_LIMIT: 10000,
}));

// Import backends after mocks are set up
import { StandardBackend } from '../backends/standard.js';
import { QdrantBackend } from '../backends/qdrant.js';
import { VectorBackend } from '../backends/backend-interface.js';

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

    beforeEach(async () => {
        backend = new QdrantBackend();
        fetchMock = vi.fn();
        global.fetch = fetchMock;
        // tokenizer-lock caches sentinel metadata per-collection; clear between tests so
        // each hybridQuery test starts with a clean sentinel state.
        const { invalidateCollectionMetadata } = await import('../core/tokenizer-lock.js');
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

        it('should initialize Qdrant Cloud', async () => {
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
            expect(callBody.apiKey).toBe('my-api-key');
            expect(callBody.host).toBeNull();
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
            expect(callBody.filter).toBeDefined();
            expect(callBody.filter.must[0].key).toBe('content_type');
        });

        it('should use separate collections in non-multitenancy mode', async () => {
            fetchMock.mockResolvedValueOnce(mockFetchResponse({ items: [] }));

            const settings = { ...defaultSettings, qdrant_multitenancy: false };
            await backend.getSavedHashes('vf_chat_abc123', settings);

            const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(callBody.collectionId).toBe('vf_chat_abc123');
            expect(callBody.filter).toBeUndefined();
        });
    });

    describe('insertVectorItems', () => {
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

    describe('hybridQuery', () => {
        it('should call hybrid endpoint with options', async () => {
            // hybridQuery now makes a sentinel-metadata fetch first (tokenizer-lock check),
            // then the hybrid-query fetch.
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: null, supported: true })) // sentinel: no lock
                .mockResolvedValueOnce(mockFetchResponse({
                    results: [{ hash: 12345, text: 'Result', score: 0.9 }],
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
        });

        it('should fallback to regular query on hybrid failure', async () => {
            fetchMock
                .mockResolvedValueOnce(mockFetchResponse({ payload: null, supported: true })) // sentinel
                .mockResolvedValueOnce(mockFetchError(404, 'Hybrid not available'))            // hybrid fails
                .mockResolvedValueOnce(mockFetchResponse({                                     // queryCollection fallback
                    results: [{ hash: 12345, text: 'Result', score: 0.9 }],
                }));

            const result = await backend.hybridQuery('test-collection', 'search', 5, defaultSettings);

            expect(result.hashes).toEqual([12345]);
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
