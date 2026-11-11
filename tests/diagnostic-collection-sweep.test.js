/**
 * The sweep Diagnostics runs after its checks (src/features/diagnostics/production-tests.js): it removes only the
 * collections diagnostics make, under their reserved names, and each from the backend and source folders that hold
 * it. It once purged a Standard-storage probe through Qdrant, so the probe stayed while the sweep said it was cleaned,
 * and a real collection named `test` on Qdrant would have gone instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ collections: [], failing: new Set() }));

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
// shared/collection-ids.js, which builds the registry keys, reads the open chat; nothing here uses it.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/features/vector-backend/index.js', () => ({
    getSavedHashes: vi.fn(),
    purgeVectorIndex: vi.fn(),
    reciprocalRankFusion: vi.fn(),
    weightedCombination: vi.fn(),
}));
vi.mock('../src/features/embedding/index.js', () => ({ getModelFromSettings: vi.fn(), resolveProviderApiUrl: vi.fn() }));
vi.mock('../src/features/keyword-search/index.js', () => ({
    applyKeywordBoost: vi.fn(),
    extractTextKeywords: vi.fn(),
    extractLorebookKeywords: vi.fn(),
}));
vi.mock('../src/features/collections/index.js', () => ({
    unregisterCollection: vi.fn(),
    deleteCollection: vi.fn(async id => ({ success: !host.failing.has(id) })),
}));

const { sweepLeftoverTestCollections, isDiagnosticCollection } = await import('../src/features/diagnostics/production-tests.js');
const { deleteCollection } = await import('../src/features/collections/index.js');

const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter' };
const standardProbe = { id: 'VectFox_diag', backend: 'vectra', source: 'transformers', models: [{ name: 'm', path: 'm' }] };

beforeEach(() => {
    vi.clearAllMocks();
    host.failing.clear();
    host.collections = [
        standardProbe,
        { id: 'vf_test_storage_1750000000000', backend: 'qdrant', source: 'openrouter', models: [] },
        { id: 'test', backend: 'qdrant', source: 'openrouter', models: [] },
        { id: 'test', backend: 'vectra', source: 'transformers', models: [] },
        { id: 'my_notes_test', backend: 'vectra', source: 'transformers', models: [] },
        { id: 'vf_eventbase_qdrant_harbor', backend: 'qdrant', source: 'openrouter', models: [] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ collections: host.collections }) })));
});

describe('the diagnostic collection sweep', () => {
    it('removes only the reserved diagnostic names, never a collection named test', async () => {
        const outcome = await sweepLeftoverTestCollections(SETTINGS);
        expect(deleteCollection.mock.calls.map(([id]) => id)).toEqual(['VectFox_diag', 'vf_test_storage_1750000000000']);
        expect(outcome).toMatchObject({ status: 'pass', message: 'Removed 2 leftover diagnostic collection(s): VectFox_diag (vectra), vf_test_storage_1750000000000 (qdrant)' });
    });

    it('removes each from the backend and source folders that hold it', async () => {
        await sweepLeftoverTestCollections(SETTINGS);
        const [id, settings, registryKey] = deleteCollection.mock.calls[0];
        expect(id).toBe('VectFox_diag');
        expect(settings).toMatchObject({ vector_backend: 'vectra', embedding_provider: 'openrouter', _discoveredSources: [{ source: 'transformers', models: standardProbe.models }] });
        expect(registryKey).toBe('vectra:VectFox_diag');
        expect(SETTINGS.vector_backend).toBe('qdrant');
    });

    it('unregisters each under the "backend:collectionId" key the registry holds it by', async () => {
        await sweepLeftoverTestCollections(SETTINGS);
        expect(deleteCollection.mock.calls.map(([, , registryKey]) => registryKey)).toEqual(['vectra:VectFox_diag', 'qdrant:vf_test_storage_1750000000000']);
    });

    it('names the diagnostic collections by their bare IDs', () => {
        expect(['vf_test_storage_1', 'VectFox_diag', 'VectFox_diag_nonexistent'].every(isDiagnosticCollection)).toBe(true);
        expect(['test', 'my_notes_test', 'VectFox_diagnosis', 'vf_lorebook_harbor'].some(isDiagnosticCollection)).toBe(false);
    });

    it('warns, naming what it could not remove, instead of saying it cleaned it', async () => {
        host.failing.add('VectFox_diag');
        const outcome = await sweepLeftoverTestCollections(SETTINGS);
        expect(outcome).toMatchObject({ status: 'warning', message: 'Could not remove: VectFox_diag (vectra)' });
    });

    it('says so when there is nothing to remove', async () => {
        host.collections = [{ id: 'vf_eventbase_qdrant_harbor', backend: 'qdrant', source: 'openrouter' }];
        expect((await sweepLeftoverTestCollections(SETTINGS)).message).toBe('No leftover diagnostic collections found');
        expect(deleteCollection).not.toHaveBeenCalled();
    });
});
