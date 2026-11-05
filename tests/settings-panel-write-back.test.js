/**
 * Every settings panel handler runs Object.assign(extension_settings.vectfox, settings).
 * That line must never undo what other code stored since the page loaded.
 *
 * These tests run VectFox's real start-up in src/index.js and hand the object it gives
 * the panel to that same line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { panel } = vi.hoisted(() => ({ panel: { settings: null } }));

vi.mock('../src/sillytavern/settings.js', () => ({
    extension_settings: {},
    saveSettingsDebounced: vi.fn(),
    saveSettings: vi.fn(),
}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => null),
    chat_metadata: {},
}));
vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: vi.fn() },
    event_types: {},
}));
vi.mock('../src/sillytavern/prompt-injection.js', () => ({
    extension_prompt_types: { IN_CHAT: 1 },
}));
vi.mock('../src/sillytavern/extension-runtime.js', () => ({
    ModuleWorkerWrapper: class {},
    debounce: callback => callback,
    debounce_timeout: { relaxed: 1 },
}));
vi.mock('../src/features/chunkbase/index.js', () => ({
    synchronizeChat: vi.fn(),
    rearrangeChat: vi.fn(),
}));
vi.mock('../src/features/collections/index.js', () => ({
    migrateOldEnabledKeys: () => ({ migrated: 0 }),
    cleanupCorruptedCollections: vi.fn(),
    registerCollection: vi.fn(),
    setDeletedOrImportedCollectionCleanup: vi.fn(),
}));
vi.mock('../src/features/eventbase/index.js', () => ({
    clearCachesForDeletedOrImportedCollection: vi.fn(),
    refreshWorldInfoEntryDepthCache: vi.fn(),
}));
vi.mock('../src/features/vector-backend/index.js', () => ({
    setInsertedCollectionRegistrar: vi.fn(),
}));
vi.mock('../src/shared/api-keys.js', () => ({
    migrateLegacyApiKeys: vi.fn(),
}));
vi.mock('../src/app/network-startup.js', () => ({
    runNetworkStartup: vi.fn(),
}));
vi.mock('../src/features/settings-panel/index.js', () => ({
    renderSettings: (_containerId, settings) => { panel.settings = settings; },
    openDiagnosticsModal: vi.fn(),
    loadWebLlmModels: vi.fn(),
    updateWebLlmStatus: vi.fn(),
    refreshAutoSyncCheckbox: vi.fn(),
}));
vi.mock('../src/features/database-browser/index.js', () => ({
    initializeVisualizer: vi.fn(),
    initializeDatabaseBrowser: vi.fn(),
}));
vi.mock('../src/features/world-info/index.js', () => ({
    initializeWorldInfoIntegration: vi.fn(),
}));
vi.mock('../src/features/keyword-search/index.js', () => ({
    CJK_TOKENIZER_MODES: { intl: 'intl', jieba: 'jieba', jieba_tw: 'jieba_tw' },
    setCjkTokenizerMode: vi.fn(),
    ensureJiebaTokenizerLoaded: vi.fn(async () => true),
    ensureJiebaTwLoaded: vi.fn(async () => true),
}));

const LIVE_COLLECTION = 'qdrant:vf_eventbase_qdrant_persona_story_chat-uuid';
const NEW_COLLECTION = 'qdrant:vf_eventbase_qdrant_persona_other-story_other-uuid';
const ORPHAN_COLLECTION = 'qdrant:vf_lorebook_qdrant_persona_story_1';
const THIS_CHAT = 'Story - this chat';
const EARLIER_CHAT = 'Story - earlier chat';

/** Loads the page: the store as it came from settings.json, then VectFox's real start-up. */
async function loadPage(storedSettings) {
    vi.resetModules();
    panel.settings = null;

    let runStartUp = null;
    vi.stubGlobal('window', {});
    vi.stubGlobal('jQuery', (callback) => { runStartUp = callback; });

    const { extension_settings } = await import('../src/sillytavern/settings.js');
    extension_settings.vectfox = storedSettings;

    await import('../src/index.js');
    await runStartUp();

    const metadata = await import('../src/features/collections/collection-metadata.js');
    const changeAnySetting = () => Object.assign(extension_settings.vectfox, panel.settings);
    return { extension_settings, metadata, changeAnySetting };
}

describe('settings panel write-back', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps a lock set after the page loaded when a setting changes', async () => {
        const { metadata, changeAnySetting } = await loadPage({
            collections: { [LIVE_COLLECTION]: { lockedToChatIds: [EARLIER_CHAT] } },
        });

        metadata.setCollectionLock(LIVE_COLLECTION, THIS_CHAT);
        expect(metadata.isCollectionLockedToChat(LIVE_COLLECTION, THIS_CHAT)).toBe(true);

        changeAnySetting();

        expect(metadata.isCollectionLockedToChat(LIVE_COLLECTION, THIS_CHAT)).toBe(true);
        expect(metadata.isCollectionLockedToChat(LIVE_COLLECTION, EARLIER_CHAT)).toBe(true);
    });

    it('keeps metadata created and removed after the page loaded when a setting changes', async () => {
        const { extension_settings, metadata, changeAnySetting } = await loadPage({
            collections: { [LIVE_COLLECTION]: {}, [ORPHAN_COLLECTION]: {} },
        });

        metadata.ensureCollectionMeta(NEW_COLLECTION);
        metadata.cleanupOrphanedMeta([LIVE_COLLECTION, NEW_COLLECTION]);

        changeAnySetting();

        const collections = extension_settings.vectfox.collections;
        expect(collections[NEW_COLLECTION]).toBeDefined();
        expect(collections[ORPHAN_COLLECTION]).toBeUndefined();
    });

    it('keeps a lock set after a setting changed, then a second change', async () => {
        const { metadata, changeAnySetting } = await loadPage({
            collections: { [LIVE_COLLECTION]: {} },
        });

        changeAnySetting();
        metadata.setCollectionLock(LIVE_COLLECTION, THIS_CHAT);
        changeAnySetting();

        expect(metadata.isCollectionLockedToChat(LIVE_COLLECTION, THIS_CHAT)).toBe(true);
    });

    it('keeps a lock when the store held no collections at page load', async () => {
        const { metadata, changeAnySetting } = await loadPage({});

        metadata.setCollectionLock(LIVE_COLLECTION, THIS_CHAT);
        changeAnySetting();

        expect(metadata.isCollectionLockedToChat(LIVE_COLLECTION, THIS_CHAT)).toBe(true);
    });

    it('keeps a value other code wrote straight to the store when a setting changes', async () => {
        const { extension_settings, changeAnySetting } = await loadPage({ eventbase_window_size: 2 });

        extension_settings.vectfox.eventbase_window_size = 6;
        changeAnySetting();

        expect(extension_settings.vectfox.eventbase_window_size).toBe(6);
    });

    it('keeps a collection registry that discovery replaced when a setting changes', async () => {
        const { extension_settings, changeAnySetting } = await loadPage({
            vectfox_collection_registry: [LIVE_COLLECTION],
        });

        extension_settings.vectfox.vectfox_collection_registry = [LIVE_COLLECTION, NEW_COLLECTION];
        changeAnySetting();

        expect(extension_settings.vectfox.vectfox_collection_registry).toContain(NEW_COLLECTION);
    });

    it('gives a stored value priority over its default, and a missing one the default', async () => {
        await loadPage({ top_k: 25 });

        expect(panel.settings.top_k).toBe(25);
        expect(panel.settings.depth).toBe(2);
    });

    it('lets a migration read a saved key before the defaults go in', async () => {
        const { extension_settings } = await loadPage({ source: 'cohere' });

        expect(extension_settings.vectfox.embedding_provider).toBe('cohere');
        expect(extension_settings.vectfox.source).toBeUndefined();
    });
});
