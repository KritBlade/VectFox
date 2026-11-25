/**
 * The vector API's read of a collection's changes after a change number (src/features/vector-backend/vector-api.js,
 * readCollectionChanges), which EventBase's feed reads through (R2 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md):
 * the backend in use answers, and a read that fails drops the backend's health cache, so the next request sets the
 * backend up again, as after a SillyTavern restart left Similharity's Qdrant unset. The backend is a stand-in.
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

const backend = vi.hoisted(() => ({ readChanges: vi.fn() }));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: async () => backend,
    getBackendForCollection: async () => backend,
    invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(),
    recordInsert: vi.fn(),
    recordDelete: vi.fn(),
    recordError: vi.fn(),
}));

const { readCollectionChanges } = await import('../src/features/vector-backend/vector-api.js');
const { invalidateBackendHealth } = await import('../src/features/vector-backend/backend-registry.js');

const HARBOR_EVENTS = 'vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const settings = { vector_backend: 'qdrant' };

describe('a read of a collection\'s changes', () => {
    beforeEach(() => {
        backend.readChanges.mockReset();
        vi.mocked(invalidateBackendHealth).mockClear();
    });

    it('is the backend\'s answer, asked with the collection, the settings and the page', async () => {
        const page = { supported: true, points: [], removed: [], emptied: false, cursor: 12, hasMore: false };
        backend.readChanges.mockResolvedValue(page);

        expect(await readCollectionChanges(HARBOR_EVENTS, settings, { after: 9, limit: 100 })).toBe(page);
        expect(backend.readChanges).toHaveBeenCalledWith(HARBOR_EVENTS, settings, { after: 9, limit: 100 });
        expect(invalidateBackendHealth).not.toHaveBeenCalled();
    });

    it('throws the backend\'s error, and drops its health cache, when the read fails', async () => {
        const failure = new Error('Qdrant not initialized');
        backend.readChanges.mockRejectedValue(failure);

        await expect(readCollectionChanges(HARBOR_EVENTS, settings, { after: null, limit: 100 })).rejects.toBe(failure);
        expect(invalidateBackendHealth).toHaveBeenCalledWith('qdrant', failure);
    });
});
