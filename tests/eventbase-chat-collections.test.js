/**
 * A chat's EventBase collections, found by the chat UUID their IDs hold (findEventBaseCollectionsForChat in
 * src/features/eventbase/eventbase-store.js, §2.5 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * its first collection and a later one, on every backend, and a legacy ID with no backend, in registry order, each with
 * its backend; never an archive holding the same UUID, nor another chat's collections; and no ranking by lock, as which
 * one the chat uses is the one route's answer (collectionInUse, D18).
 *
 * The real ID module reads the UUID. eventbase-store.js reaches SillyTavern modules that do not resolve under vitest,
 * which are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ harbor: '3f2a9c1e-7b4d-4e8a-9c61-2d5f8e0b7a43', tides: '8e6b2d4f-1c3a-4b5e-9f70-6a8c0e2d4b19' }));
const host = vi.hoisted(() => ({ registry: [], lockedKeys: [] }));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => 'Harbor Night'),
    chat_metadata: { integrity: ids.harbor },
}));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ name1: 'Wren', name2: 'Keeper', chat: [] })),
}));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    insertVectorItems: vi.fn(), queryCollection: vi.fn(), deleteVectorItems: vi.fn(), getSavedHashes: vi.fn(),
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    registerCollection: vi.fn(),
    getCollectionRegistry: vi.fn(() => host.registry),
    getCollectionListing: vi.fn(() => []),
}));
vi.mock('../src/features/collections/collection-metadata.js', () => ({
    getChatLockedCollections: vi.fn(() => host.lockedKeys),
    isCollectionActiveForContextAnyKey: vi.fn(() => false),
}));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({ buildEmbedText: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is read when
// embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));

const { findEventBaseCollectionsForChat } = await import('../src/features/eventbase/eventbase-store.js');

const HARBOR_FIRST = `qdrant:vf_eventbase_qdrant_wren_keeper_${ids.harbor}`;
const HARBOR_LATER = `qdrant:vf_eventbase_qdrant_wren_keeper_${ids.harbor}_mh3k2x1a`;
const HARBOR_ON_STANDARD = `vectra:vf_eventbase_standard_wren_keeper_${ids.harbor}`;
const HARBOR_LEGACY = `vf_eventbase_wren_keeper_${ids.harbor}`;
const HARBOR_ARCHIVE = `qdrant:vf_archiveevent_qdrant_wren_keeper_${ids.harbor}`;
const TIDES_FIRST = `qdrant:vf_eventbase_qdrant_wren_keeper_${ids.tides}`;
const TIDES_LATER = `qdrant:vf_eventbase_qdrant_wren_keeper_${ids.tides}_mh3k2x1b`;

const keysFound = (uuid) => findEventBaseCollectionsForChat(uuid).map(found => found.registryKey);

beforeEach(() => {
    host.registry = [HARBOR_FIRST, TIDES_LATER, HARBOR_LEGACY, HARBOR_ARCHIVE, HARBOR_ON_STANDARD, HARBOR_LATER, TIDES_FIRST];
    host.lockedKeys = [];
});

describe("a chat's EventBase collections", () => {
    it('finds its first and later collections on every backend, and a legacy ID, in registry order with their backends', () => {
        expect(findEventBaseCollectionsForChat(ids.harbor)).toEqual([
            { registryKey: HARBOR_FIRST, collectionId: HARBOR_FIRST.slice('qdrant:'.length), backend: 'qdrant' },
            { registryKey: HARBOR_LEGACY, collectionId: HARBOR_LEGACY, backend: null },
            { registryKey: HARBOR_ON_STANDARD, collectionId: HARBOR_ON_STANDARD.slice('vectra:'.length), backend: 'vectra' },
            { registryKey: HARBOR_LATER, collectionId: HARBOR_LATER.slice('qdrant:'.length), backend: 'qdrant' },
        ]);
    });

    it("finds none of another chat's collections, nor an archive holding the same UUID", () => {
        expect(keysFound(ids.tides)).toEqual([TIDES_LATER, TIDES_FIRST]);
    });

    it('ranks none by lock: the one locked to the open chat keeps its place', () => {
        host.lockedKeys = [HARBOR_LATER];
        expect(keysFound(ids.harbor)).toEqual([HARBOR_FIRST, HARBOR_LEGACY, HARBOR_ON_STANDARD, HARBOR_LATER]);
    });
});
