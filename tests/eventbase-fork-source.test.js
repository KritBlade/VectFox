/**
 * Where a branch chat's events come from (findEventBaseForkSource in src/features/eventbase/eventbase-fork.js, §2.3
 * and §2.5 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): another chat's collection, a later
 * one included, and never one of the branch's own, its later ones included, whichever way the parent is found: by the
 * collections' window records, or by reading a collection locked to the branch.
 *
 * The real ID module reads each collection's chat UUID, and the real fork core ranks the window records; the rest of
 * what the module reaches is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ branch: '5d7e9f1a-2b4c-4d6e-8f0a-1b3c5d7e9f2a', parent: '3f2a9c1e-7b4d-4e8a-9c61-2d5f8e0b7a43' }));
const host = vi.hoisted(() => ({ listing: [], windows: {}, lockedToBranch: [], chunks: {} }));

vi.mock('../src/sillytavern/chat.js', () => ({
    getCurrentChatId: () => 'Harbor Night - branch',
    getContext: () => ({
        chatMetadata: { main_chat: 'Harbor Night' },
        chat: [101, 102, 103, 104].map(hash => ({ name: 'Wren', mes: `Message ${hash}`, hash })),
    }),
    chat_metadata: { integrity: ids.branch },
}));
vi.mock('../src/features/collections/index.js', () => ({
    getCollectionListing: () => host.listing,
    getCollectionMeta: vi.fn(),
    registerCollection: vi.fn(),
    getChatLockedCollections: () => host.lockedToBranch,
    isCollectionLockedToChat: () => false,
    removeCollectionLock: vi.fn(),
    setCollectionLock: vi.fn(),
    setCollectionMeta: vi.fn(),
    fetchPortableChunks: async collectionId => host.chunks[collectionId] ?? [],
    insertChunksWithVectors: vi.fn(),
}));
vi.mock('../src/features/vector-backend/index.js', () => ({ purgeVectorIndex: vi.fn() }));
vi.mock('../src/features/embedding/index.js', () => ({ getModelFromSettings: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    markWindowExtracted: vi.fn(),
    setVectorizationTip: vi.fn(),
    getLastUsedWindowSize: vi.fn(),
    setLastUsedWindowSize: vi.fn(),
    readEventBaseProgress: registryKey => ({ extractedWindows: host.windows[registryKey] ?? [] }),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { findEventBaseForkSource } = await import('../src/features/eventbase/eventbase-fork.js');

const SETTINGS = { vector_backend: 'qdrant' };
const BRANCH_FIRST = `vf_eventbase_qdrant_wren_keeper_${ids.branch}`;
const BRANCH_LATER = `${BRANCH_FIRST}_mh3k2x1a`;
const PARENT_LATER = `vf_eventbase_qdrant_wren_keeper_${ids.parent}_mh3k2x1b`;
const listed = collectionId => ({ registryKey: `qdrant:${collectionId}`, collectionId, backend: 'qdrant', isOwn: true });

beforeEach(() => {
    host.listing = [listed(BRANCH_FIRST), listed(BRANCH_LATER), listed(PARENT_LATER)];
    // The branch's own collections have read its 4 messages; the parent's later collection the 2 the branch shares.
    host.windows = {
        [`qdrant:${BRANCH_FIRST}`]: ['101,102', '103,104'],
        [`qdrant:${BRANCH_LATER}`]: ['101,102', '103,104'],
        [`qdrant:${PARENT_LATER}`]: ['101,102'],
    };
    host.lockedToBranch = [];
    host.chunks = {};
});

describe("a branch chat's fork source", () => {
    it("takes the parent's later collection from the window records, never one of the branch's own", async () => {
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toMatchObject({
            origin: 'window-record', collectionId: PARENT_LATER, registryKey: `qdrant:${PARENT_LATER}`, sharedPrefixLength: 2,
        });
    });

    it("reads a collection locked to the branch when no window record shares a window, never the branch's own later one", async () => {
        host.windows = {};
        host.lockedToBranch = [`qdrant:${BRANCH_LATER}`, `qdrant:${PARENT_LATER}`];
        const events = [{ metadata: { source_message_hashes: [101, 102], source_window_end: 1 } }];
        host.chunks = { [BRANCH_LATER]: events, [PARENT_LATER]: events };
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toMatchObject({
            origin: 'locked-collection', collectionId: PARENT_LATER, registryKey: `qdrant:${PARENT_LATER}`, sharedPrefixLength: 2,
        });
    });
});
