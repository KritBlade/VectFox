/**
 * Unit tests for world-info-integration.js
 * Tests semantic World Info activation and lorebook vectorization helpers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SillyTavern host modules — vitest matches mocks by resolved ID, so the path
// "../../../../extensions.js" from /tests/ resolves to the same module that
// /core/ files import via "../../../../extensions.js". The jsdom directive
// was removed because it broke vite's import-analysis pre-pass for these mocks.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({
        chat: [],
        groupId: null,
        name2: 'TestCharacter',
        characterId: 'char123',
    })),
}));

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(),
    getCurrentChatId: vi.fn(() => 'chat123'),
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: {},
    substituteParams: vi.fn((s) => s),
}));

vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: vi.fn(),
}));

// Reached via bounded-retrieval -> embedding-latency-warning, which names the
// configured embedding provider when a retrieval times out. The real module
// imports SillyTavern's secrets.js/textgen-settings.js, absent under vitest.
vi.mock('../core/providers.js', () => ({
    getModelFromSettings: (s) => s?.embedding_openrouter_model || '',
}));

vi.mock('../core/collection-metadata.js', () => ({
    getCollectionMeta: vi.fn(),
    isCollectionEnabled: vi.fn(),
    shouldCollectionActivate: vi.fn(),
    // Read by _classifyInactiveLorebook to explain WHY a collection was skipped.
    getCollectionLockCount: vi.fn(() => 0),
    getCollectionCharacterLockCount: vi.fn(() => 0),
    isCollectionLockedToChat: vi.fn(() => false),
    isCollectionLockedToCharacter: vi.fn(() => false),
}));

vi.mock('../core/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((key) => ({
        backend: 'standard',
        source: 'local',
        collectionId: key.split(':').pop() || key,
    })),
    buildLorebookCollectionId: vi.fn((name, scope) => `lorebook_${scope}_${name}`),
    resolveBackendForCollection: vi.fn((id) => ({ backend: 'standard', collectionId: id })),
    sanitizeNameSegment: vi.fn((name, maxLen) =>
        String(name || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').substring(0, maxLen)),
}));

// Shared mutable state available to both mock factories and test bodies.
// Used to drive per-test getCollectionMeta sourceName and disabled flags
// (the production functions read from a global, not the passed settings).
const _testState = vi.hoisted(() => ({
    registry: [],
    sourceNameByKey: {},  // registryKey → sourceName
    disabledByKey: {},    // registryKey → true if disabled
}));

vi.mock('../core/collection-loader.js', () => ({
    // getCollectionListing: synthesize entries from settings.vectfox_collection_registry.
    // sourceName and enabled come from _testState (tests set them in beforeEach).
    getCollectionListing: vi.fn((settings) => {
        const registry = settings?.vectfox_collection_registry || [];
        return registry.map(key => ({
            registryKey: key,
            collectionId: key.startsWith('vf_') ? key : `vf_${key}`,
            meta: {
                enabled: !_testState.disabledByKey[key],
                sourceName: _testState.sourceNameByKey[key] || null,
            },
            isOwn: true,
        }));
    }),
    // getCollectionRegistry: production reads extension_settings (no args).
    // The world-info-integration.js source was updated to honor a passed-in
    // settings.vectfox_collection_registry override, so most tests work via
    // that. _testState.registry stays as the fallback for tests that call
    // helpers without explicit settings.
    getCollectionRegistry: vi.fn(() => _testState.registry),
}));

vi.mock('../core/constants.js', () => ({
    EXTENSION_PROMPT_TAG: 'vectfox_world_info',
    LOREBOOK_PROMPT_TAG: 'vectfox_lorebook',
    // Reached via backends -> embedding-latency-warning -> retrieval-budget,
    // which derives its slow-embed log threshold from the retrieval budget.
    // All seven are required: retrieval-budget.js imports them by name, and a
    // mock factory that omits one makes the import throw.
    RETRIEVAL_TIMEOUT_DEFAULT_MS: 15000,
    RETRIEVAL_TIMEOUT_MIN_MS: 3000,
    RETRIEVAL_TIMEOUT_MAX_MS: 120000,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS: 30000,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS: 10000,
    AGENTIC_TIMEOUT_MIN_MS: 1000,
    AGENTIC_TIMEOUT_MAX_MS: 60000,
}));

vi.mock('../core/lorebook-rename-detector.js', () => ({
    detectLorebookRenames: vi.fn(() => []),
    showLorebookRenameModal: vi.fn(),
    openDatabaseBrowserForRename: vi.fn(),
}));

vi.mock('../core/conditional-activation.js', () => ({
    buildSearchContext: vi.fn(() => ({
        recentMessages: [],
        generationType: 'normal',
        isGroupChat: false,
    })),
}));

import { getContext } from '../../../../extensions.js';
import { setExtensionPrompt, getCurrentChatId } from '../../../../../script.js';
import { queryCollection } from '../core/core-vector-api.js';
import { getCollectionMeta, isCollectionEnabled, shouldCollectionActivate } from '../core/collection-metadata.js';
import { parseRegistryKey, buildLorebookCollectionId } from '../core/collection-ids.js';
import { buildSearchContext } from '../core/conditional-activation.js';

import {
    getSemanticWorldInfoEntries,
    isLorebookVectorized,
    getLorebooksVectorizationStatus,
    getLorebookVectorStats,
    enhanceWorldInfoEntriesUI,
    initializeWorldInfoIntegration,
} from '../core/world-info-integration.js';

// ============================================================================
// getSemanticWorldInfoEntries Tests
// ============================================================================

describe('getSemanticWorldInfoEntries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default mock implementations
        isCollectionEnabled.mockReturnValue(true);
        shouldCollectionActivate.mockResolvedValue(true);
        getCollectionMeta.mockReturnValue({ sourceName: 'Test Lorebook' });
    });

    it('should return empty array when world info is disabled', async () => {
        const settings = { enabled_world_info: false };
        const result = await getSemanticWorldInfoEntries(['hello'], [], settings);
        expect(result).toEqual([]);
    });

    it('should return empty array when no recent messages', async () => {
        const settings = { enabled_world_info: true };
        const result = await getSemanticWorldInfoEntries([], [], settings);
        expect(result).toEqual([]);
    });

    it('should return empty array when messages are empty strings', async () => {
        const settings = { enabled_world_info: true };
        const result = await getSemanticWorldInfoEntries(['', '   '], [], settings);
        expect(result).toEqual([]);
    });

    it('should query lorebook collections and return matching entries', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { uid: 'entry1', text: 'Dragon content', keywords: ['dragon'], score: 0.8 },
                { uid: 'entry2', text: 'Wizard content', keywords: ['wizard'], score: 0.5 },
            ],
        });

        const result = await getSemanticWorldInfoEntries(['Tell me about dragons'], [], settings);

        expect(result).toHaveLength(2);
        expect(result[0].uid).toBe('entry1');
        expect(result[0].score).toBe(0.8);
        expect(result[0].vectorActivated).toBe(true);
    });

    it('should filter entries below threshold', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.6,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { uid: 'entry1', text: 'High score', score: 0.8 },
                { uid: 'entry2', text: 'Low score', score: 0.4 },
            ],
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toHaveLength(1);
        expect(result[0].uid).toBe('entry1');
    });

    it('should use lower threshold for hybrid search', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.5,
            // Trigger hybridActive: native-capable backend + prefer_native
            vector_backend: 'qdrant',
            hybrid_native_prefer: true,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [
                { uid: 'entry1', text: 'Content', score: 0.45 }, // 0.45 > 0.5 * 0.8 = 0.4
            ],
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toHaveLength(1);
    });

    it('should sort entries by score descending', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 5,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1, 2, 3],
            metadata: [
                { uid: 'entry1', text: 'Mid', score: 0.5 },
                { uid: 'entry2', text: 'High', score: 0.9 },
                { uid: 'entry3', text: 'Low', score: 0.4 },
            ],
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result[0].score).toBe(0.9);
        expect(result[1].score).toBe(0.5);
        expect(result[2].score).toBe(0.4);
    });

    it('should deduplicate with active entries by UID', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { uid: 'entry1', text: 'Content 1', score: 0.8 },
                { uid: 'entry2', text: 'Content 2', score: 0.7 },
            ],
        });

        const activeEntries = [{ uid: 'entry1', content: 'Already active' }];
        const result = await getSemanticWorldInfoEntries(['query'], activeEntries, settings);

        expect(result).toHaveLength(1);
        expect(result[0].uid).toBe('entry2');
    });

    it('should deduplicate with active entries by content', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1, 2],
            metadata: [
                { uid: 'entry1', text: 'Duplicate Content', score: 0.8 },
                { uid: 'entry2', text: 'Unique Content', score: 0.7 },
            ],
        });

        const activeEntries = [{ uid: 'other', content: 'Duplicate Content' }];
        const result = await getSemanticWorldInfoEntries(['query'], activeEntries, settings);

        expect(result).toHaveLength(1);
        expect(result[0].uid).toBe('entry2');
    });

    it('should skip non-lorebook collections', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['chat_history_123', 'vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'Content', score: 0.8 }],
        });

        await getSemanticWorldInfoEntries(['query'], [], settings);

        // Should only query the lorebook collection, not chat_history
        expect(queryCollection).toHaveBeenCalledTimes(1);
    });

    it('should skip disabled collections', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_disabled_T0', 'vf_lorebook_global_enabled_T0'],
        };

        // Source reads enabled flag from entry.meta.enabled (set via getCollectionListing
        // mock), not from isCollectionEnabled. Drive via _testState.disabledByKey.
        _testState.disabledByKey['vf_lorebook_global_disabled_T0'] = true;

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'Content', score: 0.8 }],
        });

        await getSemanticWorldInfoEntries(['query'], [], settings);

        // Should only query the enabled collection
        expect(queryCollection).toHaveBeenCalledTimes(1);

        delete _testState.disabledByKey['vf_lorebook_global_disabled_T0'];
    });

    it('should skip collections that fail activation filters', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_blocked_T0', 'vf_lorebook_global_allowed_T0'],
        };

        // Only 'allowed' collection passes activation
        shouldCollectionActivate.mockImplementation((id) => Promise.resolve(id.includes('allowed')));

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'Content', score: 0.8 }],
        });

        await getSemanticWorldInfoEntries(['query'], [], settings);

        // Should only query collections that pass activation (the 'allowed' one)
        expect(queryCollection).toHaveBeenCalledTimes(1);
    });

    it('should handle query errors gracefully', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockRejectedValue(new Error('Query failed'));

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toEqual([]);
    });

    it('should use default query depth when not specified', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({ hashes: [], metadata: [] });

        const messages = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'];
        await getSemanticWorldInfoEntries(messages, [], settings);

        // Default depth is 3, so query should include last 3 messages
        expect(queryCollection).toHaveBeenCalledWith(
            expect.any(String),
            'msg3\nmsg4\nmsg5',
            expect.any(Number),
            settings
        );
    });

    it('should respect custom query depth', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_query_depth: 2,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({ hashes: [], metadata: [] });

        const messages = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'];
        await getSemanticWorldInfoEntries(messages, [], settings);

        expect(queryCollection).toHaveBeenCalledWith(
            expect.any(String),
            'msg4\nmsg5',
            expect.any(Number),
            settings
        );
    });

    it('should include lorebook name and collection info in results', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        // Source reads sourceName from entry.meta.sourceName (set via getCollectionListing
        // mock), not from getCollectionMeta call directly. Drive via _testState.
        _testState.sourceNameByKey['vf_lorebook_global_test_T0'] = 'My Lorebook';
        getCollectionMeta.mockReturnValue({ sourceName: 'My Lorebook' });
        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'Content', score: 0.8 }],
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result[0].lorebookName).toBe('My Lorebook');
        expect(result[0].collectionId).toBeDefined();
        expect(result[0].registryKey).toBeDefined();
    });
});

// ============================================================================
// isLorebookVectorized Tests
// ============================================================================

describe('isLorebookVectorized', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return true when lorebook is in registry', () => {
        // Note: _findLorebookRegistryEntry uses prefix+substring search, not
        // buildLorebookCollectionId, because collection IDs include backend+handle+
        // timestamp segments that can't be reconstructed from the name alone.
        const settings = {
            vectfox_collection_registry: ['vf_lorebook_global_testbook_T0', 'other_collection'],
        };

        const result = isLorebookVectorized('testbook', settings);

        expect(result).toBe(true);
    });

    it('should return false when lorebook is not in registry', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_missing_T0');
        const settings = {
            vectfox_collection_registry: ['vf_lorebook_global_other_T0'],
        };

        const result = isLorebookVectorized('missing', settings);

        expect(result).toBe(false);
    });

    it('should return false when registry is empty', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = {
            vectfox_collection_registry: [],
        };

        const result = isLorebookVectorized('test', settings);

        expect(result).toBe(false);
    });

    it('should return false when registry is undefined', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = {};

        const result = isLorebookVectorized('test', settings);

        expect(result).toBe(false);
    });
});

// ============================================================================
// getLorebooksVectorizationStatus Tests
// ============================================================================

describe('getLorebooksVectorizationStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return Map with status for each lorebook', () => {
        buildLorebookCollectionId.mockImplementation((name) => `vf_lorebook_global_${name}`);
        const settings = {
            vectfox_collection_registry: ['vf_lorebook_global_book1_T0', 'vf_lorebook_global_book3_T0'],
        };

        const result = getLorebooksVectorizationStatus(['book1', 'book2', 'book3'], settings);

        expect(result).toBeInstanceOf(Map);
        expect(result.get('book1')).toBe(true);
        expect(result.get('book2')).toBe(false);
        expect(result.get('book3')).toBe(true);
    });

    it('should return empty Map for empty input', () => {
        const settings = { vectfox_collection_registry: [] };
        const result = getLorebooksVectorizationStatus([], settings);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('should handle all false when registry is empty', () => {
        buildLorebookCollectionId.mockImplementation((name) => `vf_lorebook_global_${name}`);
        const settings = { vectfox_collection_registry: [] };

        const result = getLorebooksVectorizationStatus(['book1', 'book2'], settings);

        expect(result.get('book1')).toBe(false);
        expect(result.get('book2')).toBe(false);
    });
});

// ============================================================================
// getLorebookVectorStats Tests
// ============================================================================

describe('getLorebookVectorStats', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return null when lorebook is not vectorized', async () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_missing_T0');
        getCollectionMeta.mockReturnValue(null);

        const result = await getLorebookVectorStats('missing', {});

        expect(result).toBeNull();
    });

    it('should return stats when lorebook is vectorized', async () => {
        getCollectionMeta.mockReturnValue({
            sourceName: 'Test Lorebook',
            chunkCount: 42,
            createdAt: '2024-01-01',
            scope: 'global',
            settings: { strategy: 'per_entry' },
        });
        isCollectionEnabled.mockReturnValue(true);

        // Pass registry in settings (source now honors caller-supplied registry)
        const settings = { vectfox_collection_registry: ['vf_lorebook_global_test_T0'] };
        const result = await getLorebookVectorStats('test', settings);

        expect(result).toEqual({
            collectionId: 'vf_lorebook_global_test_T0',
            sourceName: 'Test Lorebook',
            chunkCount: 42,
            createdAt: '2024-01-01',
            enabled: true,
            strategy: 'per_entry',
            scope: 'global',
        });
    });

    it('should use default values for missing fields', async () => {
        getCollectionMeta.mockReturnValue({
            sourceName: 'Test',
        });
        isCollectionEnabled.mockReturnValue(false);

        const settings = { vectfox_collection_registry: ['vf_lorebook_global_test_T0'] };
        const result = await getLorebookVectorStats('test', settings);

        expect(result.chunkCount).toBe(0);
        expect(result.strategy).toBe('per_entry');
        // Source defaults scope to 'character' when meta.scope is missing
        // (see core/world-info-integration.js:339). Test originally expected
        // 'global' — source semantic changed and test was not updated.
        expect(result.scope).toBe('character');
        expect(result.enabled).toBe(false);
    });
});

// ============================================================================
// enhanceWorldInfoEntriesUI Tests
// ============================================================================

describe('enhanceWorldInfoEntriesUI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return entries unchanged when lorebook is not vectorized', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = { vectfox_collection_registry: [] };
        const entries = [
            { uid: 1, content: 'Entry 1' },
            { uid: 2, content: 'Entry 2' },
        ];

        const result = enhanceWorldInfoEntriesUI('test', entries, settings);

        expect(result).toEqual(entries);
        expect(result[0].vectorized).toBeUndefined();
    });

    it('should add vector status when lorebook is vectorized', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = { vectfox_collection_registry: ['vf_lorebook_global_test_T0'] };
        const entries = [
            { uid: 1, content: 'Entry 1' },
            { uid: 2, content: 'Entry 2' },
        ];

        const result = enhanceWorldInfoEntriesUI('test', entries, settings);

        expect(result[0].vectorized).toBe(true);
        expect(result[0].vectorStatus).toEqual({
            isVectorized: true,
            canUseSemanticActivation: true,
            lorebookVectorized: true,
        });
        expect(result[1].vectorized).toBe(true);
    });

    it('should preserve original entry properties', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = { vectfox_collection_registry: ['vf_lorebook_global_test_T0'] };
        const entries = [
            { uid: 1, content: 'Entry 1', customField: 'custom' },
        ];

        const result = enhanceWorldInfoEntriesUI('test', entries, settings);

        expect(result[0].uid).toBe(1);
        expect(result[0].content).toBe('Entry 1');
        expect(result[0].customField).toBe('custom');
    });

    it('should handle empty entries array', () => {
        buildLorebookCollectionId.mockReturnValue('vf_lorebook_global_test_T0');
        const settings = { vectfox_collection_registry: ['vf_lorebook_global_test_T0'] };

        const result = enhanceWorldInfoEntriesUI('test', [], settings);

        expect(result).toEqual([]);
    });
});

// ============================================================================
// initializeWorldInfoIntegration Tests
// ============================================================================

describe('initializeWorldInfoIntegration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clean up global
        delete globalThis.window;
        globalThis.window = {};
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it('should expose functions on window.VectFox_WorldInfo', () => {
        initializeWorldInfoIntegration();

        expect(window.VectFox_WorldInfo).toBeDefined();
        expect(window.VectFox_WorldInfo.getSemanticEntries).toBe(getSemanticWorldInfoEntries);
        expect(window.VectFox_WorldInfo.isLorebookVectorized).toBe(isLorebookVectorized);
        expect(window.VectFox_WorldInfo.getVectorizationStatus).toBe(getLorebooksVectorizationStatus);
        expect(window.VectFox_WorldInfo.getVectorStats).toBe(getLorebookVectorStats);
        expect(window.VectFox_WorldInfo.enhanceEntriesUI).toBe(enhanceWorldInfoEntriesUI);
    });
});


// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Edge Cases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isCollectionEnabled.mockReturnValue(true);
        shouldCollectionActivate.mockResolvedValue(true);
        getCollectionMeta.mockReturnValue({ sourceName: 'Test' });
    });

    it('should handle entries with complex key formats', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{
                uid: 'entry1',
                text: 'Content',
                keywords: [
                    { text: 'dragon', weight: 1.5 },
                    { keyword: 'fire' },
                    'simple string',
                ],
                score: 0.8,
            }],
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toHaveLength(1);
        expect(result[0].key).toEqual([
            { text: 'dragon', weight: 1.5 },
            { keyword: 'fire' },
            'simple string',
        ]);
    });

    it('should handle null metadata gracefully', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: null,
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toEqual([]);
    });

    it('should handle missing score field', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'Content' }], // no score field
        });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        // Score defaults to 0, which is below threshold
        expect(result).toEqual([]);
    });

    it('should handle deduplication with case-insensitive content matching', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: 'DRAGON CONTENT', score: 0.8 }],
        });

        const activeEntries = [{ uid: 'other', content: 'dragon content' }];
        const result = await getSemanticWorldInfoEntries(['query'], activeEntries, settings);

        expect(result).toEqual([]);
    });

    it('should handle deduplication with whitespace trimming', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: ['vf_lorebook_global_test_T0'],
        };

        queryCollection.mockResolvedValue({
            hashes: [1],
            metadata: [{ uid: 'entry1', text: '  Content with spaces  ', score: 0.8 }],
        });

        const activeEntries = [{ uid: 'other', content: 'Content with spaces' }];
        const result = await getSemanticWorldInfoEntries(['query'], activeEntries, settings);

        expect(result).toEqual([]);
    });

    it('should handle multiple lorebook collections', async () => {
        const settings = {
            enabled_world_info: true,
            world_info_threshold: 0.3,
            world_info_top_k: 3,
            vectfox_collection_registry: [
                'vf_lorebook_global_book1_T0',
                'vf_lorebook_global_book2_T0',
            ],
        };

        // Source reads sourceName from entry.meta (set via getCollectionListing
        // mock), not from getCollectionMeta directly. Drive via _testState.
        _testState.sourceNameByKey['vf_lorebook_global_book1_T0'] = 'Book One';
        _testState.sourceNameByKey['vf_lorebook_global_book2_T0'] = 'Book Two';
        getCollectionMeta.mockImplementation((id) => ({
            sourceName: id.includes('book1') ? 'Book One' : 'Book Two',
        }));

        queryCollection
            .mockResolvedValueOnce({
                hashes: [1],
                metadata: [{ uid: 'entry1', text: 'From book 1', score: 0.8 }],
            })
            .mockResolvedValueOnce({
                hashes: [2],
                metadata: [{ uid: 'entry2', text: 'From book 2', score: 0.7 }],
            });

        const result = await getSemanticWorldInfoEntries(['query'], [], settings);

        expect(result).toHaveLength(2);
        expect(result[0].lorebookName).toBe('Book One');
        expect(result[1].lorebookName).toBe('Book Two');
    });
});
