/**
 * The visualizer tests Diagnostics runs clean up as the production tests do, with production-tests.js's
 * cleanupTestCollection (src/features/diagnostics/visualizer-tests.js): every collection they insert into is purged
 * and unregistered under the "backend:collectionId" key the registry holds it by, so a run leaves no registry entry.
 * The backend is stubbed as the Qdrant backend behaves: an insert registers its collection under that key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const host = vi.hoisted(() => ({ registry: new Set(), inserted: new Set(), stored: new Map() }));

vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({
    getStringHash: text => [...String(text)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) | 0, 7),
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(() => 'chat-1'), chat_metadata: {} }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: async () => true }));
vi.mock('../src/features/embedding/index.js', () => ({
    embeddingProfileRequestFields: async () => ({}),
    getModelFromSettings: () => '',
    resolveProviderApiUrl: () => undefined,
}));
vi.mock('../src/features/keyword-search/index.js', () => ({ extractTextKeywords: vi.fn(), extractLorebookKeywords: vi.fn() }));
vi.mock('../src/features/vector-backend/index.js', async () => {
    const { buildRegistryKey } = await vi.importActual('../src/shared/collection-ids.js');
    return {
        insertVectorItems: vi.fn(async (collectionId, items, settings) => {
            host.registry.add(buildRegistryKey(collectionId, settings));
            host.inserted.add(collectionId);
            const hashes = host.stored.get(collectionId) ?? new Set();
            for (const item of items) hashes.add(String(item.hash));
            host.stored.set(collectionId, hashes);
        }),
        getSavedHashes: vi.fn(async collectionId => [...(host.stored.get(collectionId) ?? [])]),
        deleteVectorItems: vi.fn(async (collectionId, hashes) => {
            for (const hash of hashes) host.stored.get(collectionId)?.delete(String(hash));
        }),
        purgeVectorIndex: vi.fn(async collectionId => { host.stored.delete(collectionId); }),
        reciprocalRankFusion: vi.fn(),
        weightedCombination: vi.fn(),
    };
});
vi.mock('../src/features/collections/index.js', () => ({
    getChunkMetadata: vi.fn(() => null),
    saveChunkMetadata: vi.fn(),
    deleteChunkMetadata: vi.fn(),
    unregisterCollection: vi.fn(key => host.registry.delete(key)),
    deleteCollection: vi.fn(),
}));

const { runVisualizerTests } = await import('../src/features/diagnostics/visualizer-tests.js');
const { unregisterCollection } = await import('../src/features/collections/index.js');

beforeEach(() => {
    vi.clearAllMocks();
    host.registry = new Set(['qdrant:vf_chat_harbor_notes']);
    host.inserted = new Set();
    host.stored = new Map();
});

describe('the visualizer tests\' cleanup', () => {
    it('leaves no registry entry for any collection they inserted into, and keeps the others', async () => {
        await runVisualizerTests({ vector_backend: 'qdrant', embedding_provider: 'custom' }, true);

        expect(host.inserted.size).toBeGreaterThan(0);
        for (const collectionId of host.inserted) {
            expect(unregisterCollection, collectionId).toHaveBeenCalledWith(`qdrant:${collectionId}`);
        }
        expect([...host.registry]).toEqual(['qdrant:vf_chat_harbor_notes']);
        expect(host.stored.size).toBe(0);
    });
});
