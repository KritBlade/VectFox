/**
 * deleteVectorsFolder (src/features/collections/collection-loader.js), behind the Action page's Purge: it asks
 * Similharity to delete SillyTavern's vectors folder, and a plugin that answers with anything but success throws, so
 * Purge never reads a failed delete as done and never resets the settings after one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({})),
}));

vi.mock('../../../../../script.js', () => ({
    characters: [],
    getRequestHeaders: vi.fn(() => ({ 'X-CSRF-Token': 'test' })),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => null),
}));

vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    queryCollection: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

const { deleteVectorsFolder } = await import('../src/features/collections/collection-loader.js');

beforeEach(() => {
    delete global.fetch;
});

describe('deleteVectorsFolder', () => {
    it('asks Similharity to delete the vectors folder, with SillyTavern\'s request headers', async () => {
        global.fetch = vi.fn(async () => ({ ok: true, text: async () => '{"success":true}' }));
        await deleteVectorsFolder();
        expect(global.fetch).toHaveBeenCalledWith('/api/plugins/similharity/purge-all', { method: 'POST', headers: { 'X-CSRF-Token': 'test' } });
    });

    it('throws with the plugin\'s status when it answers with anything but success', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'Not Found' }));
        await expect(deleteVectorsFolder()).rejects.toThrow('purge-all returned 404: Not Found');
    });

    it('throws when the plugin cannot be reached', async () => {
        global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        await expect(deleteVectorsFolder()).rejects.toThrow('Failed to fetch');
    });
});
