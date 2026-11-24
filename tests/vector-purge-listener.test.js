/**
 * A purged collection is told to the listener src/index.js sets (src/features/vector-backend/vector-api.js,
 * purgeVectorIndex and setPurgedCollectionListener), which the public API sends on as an EventBase collection emptied
 * (A2 of InternalProject/Vectfox/plans/vectfox-public-api.md): once the backend has emptied it, never for a purge that
 * failed, and a listener that throws never fails the purge. The backend is a stand-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [], getContext: vi.fn(() => ({ chat: [] })) }));
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => null),
    chat_metadata: {},
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: {},
    saveSettingsDebounced: vi.fn(),
}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {} }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: { server_urls: {} } }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), domain: vi.fn(), enabled: () => false } }));

const backend = vi.hoisted(() => ({ purgeVectorIndex: vi.fn() }));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: async () => backend,
    getBackendForCollection: async () => backend,
    invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(),
    recordInsert: vi.fn(),
    recordDelete: vi.fn(),
    recordError: vi.fn(),
}));

const { purgeVectorIndex, setPurgedCollectionListener } = await import('../src/features/vector-backend/vector-api.js');
const { log } = await import('../src/sillytavern/log.js');

const HARBOR_EVENTS = 'vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const settings = { vector_backend: 'qdrant' };

describe('a purged collection', () => {
    const purged = [];
    beforeEach(() => {
        purged.length = 0;
        vi.mocked(log.warn).mockClear();
        backend.purgeVectorIndex.mockReset().mockResolvedValue(undefined);
        setPurgedCollectionListener(collectionId => purged.push(collectionId));
    });

    it('is told to the listener once the backend has emptied it', async () => {
        backend.purgeVectorIndex.mockImplementation(async () => {
            expect(purged).toEqual([]);
        });
        expect(await purgeVectorIndex(HARBOR_EVENTS, settings)).toBe(true);
        expect(purged).toEqual([HARBOR_EVENTS]);
    });

    it('is not told when the purge failed', async () => {
        backend.purgeVectorIndex.mockRejectedValue(new Error('Qdrant is unreachable'));
        expect(await purgeVectorIndex(HARBOR_EVENTS, settings)).toBe(false);
        expect(purged).toEqual([]);
    });

    it('stays purged when the listener throws, which the console says', async () => {
        setPurgedCollectionListener(() => { throw new Error('a listener broke'); });
        expect(await purgeVectorIndex(HARBOR_EVENTS, settings)).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(HARBOR_EVENTS), expect.objectContaining({ message: 'a listener broke' }));
    });
});
