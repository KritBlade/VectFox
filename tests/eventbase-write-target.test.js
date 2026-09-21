/**
 * eventbase-write-target.test.js — resolver split: read honors a foreign lock,
 * ingestion does not.
 *
 * A per-chat lock is the supported way to share an OLDER chat's EventBase with
 * the current chat so its events are retrieved here. Ingestion must not follow
 * that lock: writing chat B's events into chat A's collection puts two
 * independent `source_window_end` index spaces in one sort frame (chronology
 * corrupts) and makes Resume read chat A's tip and skip every window.
 *
 * Isolation: eventbase-store.js transitively imports ST modules that don't
 * resolve under vitest. Same empty-stub approach as eventbase-settle-lag.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CHAT_A_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHAT_B_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const COL_A = `vf_eventbase_qdrant_rabbit_kagami_${CHAT_A_UUID}`;
const COL_B = `vf_eventbase_qdrant_rabbit_kagami_${CHAT_B_UUID}`;
const KEY_A = `qdrant:${COL_A}`;
const KEY_B = `qdrant:${COL_B}`;

/** Registry-key/bare pairs the current chat has locked. */
let lockedKeys = new Set();
/** Listing rows, in registry order — order is what the old tie-break used. */
let listingRows = [];

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => 'chat-b.jsonl'),
}));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ name1: 'Rabbit', name2: 'Kagami', chat: [] })),
}));
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(), queryCollection: vi.fn(), deleteVectorItems: vi.fn(),
    getAdditionalArgs: vi.fn(), getSavedHashes: vi.fn(),
}));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: vi.fn(() => CHAT_B_UUID),
    buildEventBaseCollectionId: vi.fn(),
    getRegistryBackend: vi.fn(() => 'qdrant'),
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'vf_eventbase_' },
    parseRegistryKey: vi.fn(),
    buildChatSearchPatterns: vi.fn((_chatId, uuid) => [String(uuid).toLowerCase()]),
    matchesPatterns: vi.fn((id, patterns) =>
        !!id && patterns.some(p => String(id).toLowerCase().includes(p))),
}));
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(),
    getCollectionRegistry: vi.fn(() => []),
    getCollectionListing: vi.fn(() => listingRows),
}));
vi.mock('../core/collection-metadata.js', () => ({
    getChatLockedCollections: vi.fn(() => []),
    isCollectionActiveForContextAnyKey: vi.fn(keys => keys.some(k => lockedKeys.has(k))),
}));
vi.mock('../core/eventbase-schema.js', () => ({ buildEmbedText: vi.fn() }));
vi.mock('../core/log.js', () => ({
    log: {
        lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(),
        warn: vi.fn(), error: vi.fn(), enabled: () => false,
    },
}));

const { resolveActiveEventBaseCollection, resolveEventBaseWriteTarget } =
    await import('../core/eventbase-store.js');

const row = (collectionId, registryKey) => ({
    collectionId, registryKey, backend: 'qdrant', meta: {}, isOwn: true, isActive: true,
});
const settings = { vector_backend: 'qdrant' };

beforeEach(() => {
    lockedKeys = new Set();
    listingRows = [];
});

describe('resolveEventBaseWriteTarget — a foreign lock never captures writes', () => {
    it('returns null when the only locked collection belongs to another chat', () => {
        // Chat B is open and has locked chat A's EventBase for retrieval, but has
        // not been vectorized yet. Ingestion must decline chat A's collection so
        // runEventBaseIngestion falls through to buildEventBaseCollectionId.
        listingRows = [row(COL_A, KEY_A)];
        lockedKeys = new Set([KEY_A, COL_A]);

        expect(resolveEventBaseWriteTarget(settings, CHAT_B_UUID)).toBeNull();
        // Read semantics are unchanged — the lock still shares chat A's events.
        expect(resolveActiveEventBaseCollection(settings, CHAT_B_UUID)?.collectionId).toBe(COL_A);
    });

    it('picks the chat\'s own collection when both are locked, whatever the registry order', () => {
        lockedKeys = new Set([KEY_A, COL_A, KEY_B, COL_B]);

        for (const order of [[row(COL_A, KEY_A), row(COL_B, KEY_B)], [row(COL_B, KEY_B), row(COL_A, KEY_A)]]) {
            listingRows = order;
            expect(resolveEventBaseWriteTarget(settings, CHAT_B_UUID)?.collectionId).toBe(COL_B);
        }
    });

    it('keeps the own-UUID collection active for reads too, regardless of order', () => {
        // The rank fix: without the UUID tier both score 0 and registry insertion
        // order decides — which silently flips after a delete + re-register.
        lockedKeys = new Set([KEY_A, COL_A, KEY_B, COL_B]);

        listingRows = [row(COL_A, KEY_A), row(COL_B, KEY_B)];
        expect(resolveActiveEventBaseCollection(settings, CHAT_B_UUID)?.collectionId).toBe(COL_B);
    });

    it('still resolves the chat\'s own collection with no lock at all', () => {
        listingRows = [row(COL_B, KEY_B)];

        expect(resolveEventBaseWriteTarget(settings, CHAT_B_UUID)?.collectionId).toBe(COL_B);
    });

    it('accepts a locked collection owned by another persona when the UUID matches', () => {
        // Lock widens ownership (imported/foreign-persona collection for THIS chat);
        // it is only the UUID that write mode refuses to bend on.
        listingRows = [{ ...row(COL_B, KEY_B), isOwn: false }];
        lockedKeys = new Set([KEY_B, COL_B]);

        expect(resolveEventBaseWriteTarget(settings, CHAT_B_UUID)?.collectionId).toBe(COL_B);
    });

    it('rejects a foreign-persona collection for this chat when it is not locked', () => {
        listingRows = [{ ...row(COL_B, KEY_B), isOwn: false }];

        expect(resolveEventBaseWriteTarget(settings, CHAT_B_UUID)).toBeNull();
    });
});
