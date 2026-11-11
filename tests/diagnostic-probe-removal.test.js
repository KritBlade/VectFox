/**
 * Diagnostics deletes the probe collection its endpoint checks make (src/features/diagnostics/infrastructure-checks.js)
 * as soon as the last of them is done, through SillyTavern's own purge, so no run leaves it in Standard storage, with
 * or without the Similharity plugin.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ order: [] }));

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/secrets.js', () => ({ secret_state: {} }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() },
}));
vi.mock('../src/features/embedding/index.js', () => ({
    isValidProvider: vi.fn(),
    getProviderConfig: vi.fn(),
    getModelField: vi.fn(),
    getSecretKey: vi.fn(),
    requiresApiKey: vi.fn(),
    requiresUrl: vi.fn(),
    resolveProviderApiUrl: vi.fn(),
}));

const { removeProbeCollection } = await import('../src/features/diagnostics/infrastructure-checks.js');
const { log } = await import('../src/sillytavern/log.js');

describe('removing the probe collection', () => {
    beforeEach(() => vi.clearAllMocks());

    it('purges it through SillyTavern, which needs no plugin', async () => {
        const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
        vi.stubGlobal('fetch', fetch);
        const row = await removeProbeCollection();
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('/api/vector/purge');
        expect(JSON.parse(init.body)).toEqual({ collectionId: 'VectFox_diag' });
        expect(row).toMatchObject({ status: 'pass', message: 'Removed VectFox_diag, the collection the endpoint checks make' });
    });

    it('warns with the status when SillyTavern refuses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
        const row = await removeProbeCollection();
        expect(row).toMatchObject({ status: 'warning', message: 'Could not remove VectFox_diag, the collection the endpoint checks make: HTTP 500' });
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('warns with the error when the request fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
        const row = await removeProbeCollection();
        expect(row).toMatchObject({ status: 'warning', message: 'Could not remove VectFox_diag, the collection the endpoint checks make: Failed to fetch' });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('VectFox_diag'), expect.any(Error));
    });
});

/** The exported checks whose bodies name the probe collection, read from the source, so a new probe is counted. */
function checksThatNameTheProbeCollection() {
    const source = readFileSync(new URL('../src/features/diagnostics/infrastructure-checks.js', import.meta.url), 'utf8');
    const starts = [...source.matchAll(/^export (?:async )?function (\w+)/gm)];
    return starts
        .map((match, index) => ({ name: match[1], body: source.slice(match.index, starts[index + 1]?.index ?? source.length) }))
        .filter(({ name, body }) => name !== 'removeProbeCollection' && body.includes('PROBE_COLLECTION_ID'))
        .map(({ name }) => name);
}

describe('the runner', () => {
    it('removes the probe collection after every check that names it, once per run', async () => {
        vi.resetModules();
        const recorded = name => vi.fn(async () => { host.order.push(name); return { name, status: 'pass', message: '' }; });
        const infrastructureNames = [
            'checkVectorsExtension', 'checkBackendEndpoints', 'checkServerPlugin', 'checkPluginEndpoints', 'removeProbeCollection',
            'checkQdrantBackend', 'checkEmbeddingProvider', 'checkTransformersMemoryLimits', 'checkApiKeys', 'checkApiUrls',
            'checkProviderConnectivity',
        ];
        vi.doMock('../src/features/diagnostics/infrastructure-checks.js', () => Object.fromEntries(infrastructureNames.map(name => [name, recorded(name)])));
        vi.doMock('../src/features/diagnostics/configuration-checks.js', () => Object.fromEntries([
            'checkScoreThreshold', 'checkInsertQueryCounts', 'checkChatVectors', 'checkConditionalActivationModule',
            'checkCollectionIdFormat', 'checkHashCollisionRate', 'checkChatMetadataIntegrity', 'checkCollectionRegistryStatus',
            'checkPromptContextConfig', 'checkPNGExportCapability',
        ].map(name => [name, recorded(name)])));
        vi.doMock('../src/features/diagnostics/production-tests.js', () => Object.fromEntries([
            'testEmbeddingGeneration', 'testVectorStorage', 'testVectorRetrieval', 'testVectorDimensions', 'testChunkServerSync',
            'testDuplicateHashes', 'testPluginEmbeddingGeneration', 'testReciprocalRankFusion', 'testWeightedCombination',
            'testKeywordExtraction', 'testLorebookKeywordExtraction', 'sweepLeftoverTestCollections',
        ].map(name => [name, recorded(name)]).concat([['isDiagnosticCollection', () => false]])));
        vi.doMock('../src/features/diagnostics/activation-tests.js', () => ({ testConditionalActivation: vi.fn(async () => []) }));
        vi.doMock('../src/features/diagnostics/visualizer-tests.js', () => ({ runVisualizerTests: vi.fn(async () => []) }));
        vi.doMock('../src/features/collections/index.js', () => ({ cleanupTestCollections: vi.fn(() => 0) }));
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
        host.order.length = 0;

        const { runDiagnostics } = await import('../src/features/diagnostics/diagnostics-runner.js');
        const results = await runDiagnostics({ vector_backend: 'qdrant', embedding_provider: 'openrouter' }, true);

        const probes = checksThatNameTheProbeCollection();
        expect(probes).toEqual(expect.arrayContaining(['checkVectorsExtension', 'checkBackendEndpoints', 'checkPluginEndpoints']));
        const removal = host.order.indexOf('removeProbeCollection');
        expect(host.order.filter(name => name === 'removeProbeCollection')).toHaveLength(1);
        for (const probe of probes) {
            expect(host.order.indexOf(probe), probe).toBeGreaterThanOrEqual(0);
            expect(host.order.lastIndexOf(probe), probe).toBeLessThan(removal);
        }
        expect(results.categories.infrastructure.map(row => row.name)).toContain('removeProbeCollection');
    });
});
