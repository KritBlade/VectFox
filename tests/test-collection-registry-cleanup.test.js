/**
 * The registry cleanup Diagnostics runs first (cleanupTestCollections in src/features/collections/collection-loader.js):
 * it removes the registry and lock-index entries of the collections the caller names as tests, in the
 * "backend:collectionId" form the registry holds and in the bare form of older entries, and nothing else.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({ characterId: '0', name1: 'TestPersona', chatId: 'chat-1' })),
}));

vi.mock('../../../../../script.js', () => ({
    characters: [],
    getRequestHeaders: vi.fn(() => ({})),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => 'chat-1'),
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

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { cleanupTestCollections } from '../src/features/collections/collection-loader.js';

const isTestCollection = id => /^vf_test_/.test(id) || /^VectFox_diag(_|$)/.test(id);
const REAL_KEY = 'qdrant:vf_lorebook_qdrant_testpersona_harbor_1750000000000';

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.vectfox.vectfox_collection_registry = [
        'qdrant:vf_test_keyword_restore_1794396416150',
        REAL_KEY,
        'vectra:VectFox_diag',
        'vf_test_storage_1750000000000',
        'vectra:my_notes_vf_test_backup',
    ];
    extension_settings.vectfox.chat_lock_index = {
        'chat-1': ['qdrant:vf_test_keyword_restore_1794396416150', REAL_KEY],
        'chat-2': ['vectra:VectFox_diag'],
    };
});

describe('the test collection registry cleanup', () => {
    it('removes the entries of the collections named as tests, in either key form, and keeps the rest', () => {
        expect(cleanupTestCollections(isTestCollection)).toBe(3);
        expect(extension_settings.vectfox.vectfox_collection_registry).toEqual([REAL_KEY, 'vectra:my_notes_vf_test_backup']);
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });

    it('prunes their lock-index entries, and a chat left with none', () => {
        cleanupTestCollections(isTestCollection);
        expect(extension_settings.vectfox.chat_lock_index).toEqual({ 'chat-1': [REAL_KEY] });
    });

    it('saves nothing when no entry is a test', () => {
        extension_settings.vectfox.vectfox_collection_registry = [REAL_KEY];
        extension_settings.vectfox.chat_lock_index = { 'chat-1': [REAL_KEY] };
        expect(cleanupTestCollections(isTestCollection)).toBe(0);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});
