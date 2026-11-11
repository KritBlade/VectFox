/**
 * Diagnostics' view of the Similharity plugin (src/features/diagnostics/infrastructure-checks.js and
 * diagnostics-runner.js): one fresh /health probe per run, through the shared probe (src/shared/similharity-plugin.js),
 * which the version pill, the "VectFox Plugin" check and the plugin-endpoints check all read; and the "VectFox
 * Plugin" check warning below similharity_minimum_version in manifest.json, the floor's one place.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/secrets.js', () => ({ secret_state: {} }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() },
}));
vi.mock('../src/features/embedding/index.js', () => ({
    embeddingProfileKind: vi.fn(() => null),
    isValidProvider: vi.fn(),
    getProviderConfig: vi.fn(),
    getModelField: vi.fn(),
    getModelFromSettings: vi.fn(),
    getSecretKey: vi.fn(),
    requiresApiKey: vi.fn(),
    requiresUrl: vi.fn(),
    resolveEmbeddingProfile: vi.fn(() => null),
    resolveProviderApiUrl: vi.fn(),
}));

const { checkPluginEndpoints, checkServerPlugin } = await import('../src/features/diagnostics/infrastructure-checks.js');
const { resetPluginAvailableCache } = await import('../src/shared/similharity-plugin.js');

const MANIFEST = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const FLOOR = MANIFEST.similharity_minimum_version;

const plugin = vi.hoisted(() => ({ health: null }));
const healthRequests = () => fetch.mock.calls.filter(([url]) => url === '/api/plugins/similharity/health').length;

beforeEach(() => {
    vi.clearAllMocks();
    resetPluginAvailableCache();
    plugin.health = { status: 'ok', version: FLOOR, backends: ['vectra', 'qdrant'] };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('manifest.json')) return { ok: true, status: 200, json: async () => MANIFEST };
        if (url === '/api/plugins/similharity/health') {
            return plugin.health ? { ok: true, status: 200, json: async () => plugin.health } : { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    }));
});

describe('the "VectFox Plugin" check', () => {
    it('passes a plugin at the floor, naming its version and the backends its /health lists', async () => {
        await expect(checkServerPlugin()).resolves.toMatchObject({ status: 'pass', message: `v${FLOOR} - Backends: vectra, qdrant` });
    });

    it('passes a plugin that lists no backends with its version alone', async () => {
        plugin.health = { status: 'ok', version: FLOOR };
        await expect(checkServerPlugin()).resolves.toMatchObject({ status: 'pass', message: `v${FLOOR}` });
    });

    it('warns on a plugin older than the floor, naming both versions and how to update', async () => {
        plugin.health = { ...plugin.health, version: '3.3.5' };
        const row = await checkServerPlugin();
        expect(row.status).toBe('warning');
        expect(row.message).toMatch(new RegExp(`^v3\\.3\\.5 is older than v${FLOOR.replaceAll('.', '\\.')}, the oldest VectFox works with\\. Restart SillyTavern`));
    });

    it('warns on a plugin that reports no version, one that reports itself unhealthy, and no plugin', async () => {
        plugin.health = { status: 'ok' };
        await expect(checkServerPlugin()).resolves.toMatchObject({ status: 'warning', message: expect.stringMatching(/^The plugin reports no version/) });
        resetPluginAvailableCache();
        plugin.health = { status: 'degraded', version: FLOOR };
        await expect(checkServerPlugin()).resolves.toMatchObject({ status: 'warning', message: 'Plugin unhealthy: degraded' });
        resetPluginAvailableCache();
        plugin.health = null;
        await expect(checkServerPlugin()).resolves.toMatchObject({ status: 'warning', message: expect.stringMatching(/^Plugin not found \(HTTP 404\)/) });
    });
});

describe('the plugin-endpoints check', () => {
    it('skips with the reason when no plugin was found, and tests no endpoint', async () => {
        plugin.health = null;
        await expect(checkPluginEndpoints()).resolves.toMatchObject({ status: 'skipped', message: 'Plugin not available (HTTP 404) - endpoints not tested' });
        expect(fetch.mock.calls.map(([url]) => url).filter(url => url.startsWith('/api/plugins/similharity/') && !url.endsWith('/health'))).toEqual([]);
    });

    it('shares one /health request with the "VectFox Plugin" check', async () => {
        await checkServerPlugin();
        await checkPluginEndpoints();
        expect(healthRequests()).toBe(1);
    });
});

describe('the runner', () => {
    it('probes /health once per run, freshly each run, and shows the version it reported', async () => {
        vi.resetModules();
        vi.doMock('../src/features/diagnostics/infrastructure-checks.js', async importOriginal => {
            const real = await importOriginal();
            const quiet = name => vi.fn(async () => ({ name, status: 'pass', message: '' }));
            return Object.fromEntries(Object.keys(real).map(name => [name, ['checkServerPlugin', 'checkPluginEndpoints'].includes(name) ? real[name] : quiet(name)]));
        });
        vi.doMock('../src/features/diagnostics/configuration-checks.js', () => Object.fromEntries([
            'checkChunkBaseSimilarityThreshold', 'checkInsertQueryCounts', 'checkChatVectors', 'checkConditionalActivationModule',
            'checkCollectionIdFormat', 'checkHashCollisionRate', 'checkChatMetadataIntegrity', 'checkCollectionRegistryStatus',
            'checkPromptContextConfig', 'checkPNGExportCapability',
        ].map(name => [name, vi.fn(async () => ({ name, status: 'pass', message: '' }))])));
        vi.doMock('../src/features/diagnostics/production-tests.js', () => ({ isDiagnosticCollection: () => false, sweepLeftoverTestCollections: vi.fn(async () => ({})) }));
        vi.doMock('../src/features/diagnostics/activation-tests.js', () => ({ testConditionalActivation: vi.fn(async () => []) }));
        vi.doMock('../src/features/diagnostics/visualizer-tests.js', () => ({ runVisualizerTests: vi.fn(async () => []) }));
        vi.doMock('../src/features/collections/index.js', () => ({ cleanupTestCollections: vi.fn(() => 0) }));

        const { runDiagnostics } = await import('../src/features/diagnostics/diagnostics-runner.js');
        const first = await runDiagnostics({ vector_backend: 'standard', embedding_provider: 'transformers' }, false);
        expect(healthRequests()).toBe(1);
        expect(first.version).toEqual({ extension: MANIFEST.version, plugin: FLOOR });
        expect(first.categories.infrastructure.find(row => row.name === 'VectFox Plugin')).toMatchObject({ status: 'pass' });

        plugin.health = { ...plugin.health, version: '3.3.5' };
        const second = await runDiagnostics({ vector_backend: 'standard', embedding_provider: 'transformers' }, false);
        expect(healthRequests()).toBe(2);
        expect(second.version.plugin).toBe('3.3.5');
        expect(second.categories.infrastructure.find(row => row.name === 'VectFox Plugin')).toMatchObject({ status: 'warning' });
    });
});
