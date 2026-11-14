/**
 * Export, import and fork with "One shared collection" on (issue #30): every point of vectfox_main names its
 * collection in the tenant field content_type, so an export reads one collection's points only, and an imported or
 * forked point names the collection it goes into, not the one it came from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/installed-extensions.js', () => ({ extensionNames: [] }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => 'chat-1', chat_metadata: {} }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {} }));
vi.mock('../src/sillytavern/connection-settings.js', () => ({}));
vi.mock('../src/features/vector-backend/sparse-vector-encoder.js', () => ({ encodeSparseVector: () => ({ indices: [1], values: [1] }) }));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../../../../world-info.js', () => ({}));

const { fetchPortableChunks, insertChunksWithVectors } = await import('../src/features/collections/collection-export.js');

const SHARED = { vector_backend: 'qdrant', qdrant_multitenancy: true, embedding_provider: 'openrouter', cjk_tokenizer_mode: 'jieba_tw' };
const OWN = { ...SHARED, qdrant_multitenancy: false };
const ok = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) });
const bodyOf = path => JSON.parse(fetch.mock.calls.find(([url]) => url === path)[1].body);

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ success: true, items: [] })));
});

describe('export and import with the shared Qdrant collection', () => {
    it('reads one collection\'s points from vectfox_main for an export or a fork', async () => {
        await fetchPortableChunks('qdrant:vf_eventbase_qdrant_tester_source', SHARED);

        expect(bodyOf('/api/plugins/similharity/chunks/list')).toMatchObject({
            collectionId: 'vectfox_main',
            filters: { content_type: 'vf_eventbase_qdrant_tester_source' },
        });
    });

    it('stores an imported point under the collection it goes into, not the one it was exported from', async () => {
        const exported = { hash: 52001, index: 0, text: 'Keeper Orrin trims the lamp.', vector: [0.1, 0.2], metadata: { content_type: 'vf_eventbase_qdrant_tester_source' } };

        await insertChunksWithVectors('vf_eventbase_qdrant_tester_fork', [exported], SHARED);

        const insert = bodyOf('/api/plugins/similharity/chunks/insert');
        expect(insert.collectionId).toBe('vectfox_main');
        expect(insert.items[0].metadata.content_type).toBe('vf_eventbase_qdrant_tester_fork');
    });

    it('stores an import in its own Qdrant collection, its metadata unchanged, when the shared collection is off', async () => {
        const exported = { hash: 52001, index: 0, text: 'Keeper Orrin trims the lamp.', vector: [0.1, 0.2], metadata: { importance: 7 } };

        await insertChunksWithVectors('vf_eventbase_qdrant_tester_fork', [exported], OWN);

        const insert = bodyOf('/api/plugins/similharity/chunks/insert');
        expect(insert.collectionId).toBe('vf_eventbase_qdrant_tester_fork');
        expect(insert.items[0].metadata).toEqual({ importance: 7 });
    });
});
