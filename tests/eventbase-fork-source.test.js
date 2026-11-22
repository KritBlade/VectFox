/**
 * Where a branch chat's events come from (findEventBaseForkSource in src/features/eventbase/eventbase-fork.js, §2.2,
 * §2.3 and §2.5 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): another chat's collection, a
 * later one included, and never one of the branch's own, its later ones included, whichever way the parent is found:
 * by the window records of the parent's collections in use there, or by reading a collection locked to the branch. A
 * collection of the parent not in use there is never read, and the fork says so (D18).
 *
 * The real ID module reads each collection's chat UUID, and the real fork core ranks the window records; the rest of
 * what the module reaches is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ branch: '5d7e9f1a-2b4c-4d6e-8f0a-1b3c5d7e9f2a', parent: '3f2a9c1e-7b4d-4e8a-9c61-2d5f8e0b7a43' }));
const host = vi.hoisted(() => ({ listing: [], windows: {}, lockedToBranch: [], lockedToParent: new Set(), chunks: {} }));

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
    // A lock as the Database Browser's Active here reads it: here, to the parent chat.
    isCollectionActiveForContextAnyKey: (keys, { chatId }) => chatId === 'Harbor Night' && keys.some(key => host.lockedToParent.has(key)),
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
    getCollectionWindowSize: vi.fn(),
    setCollectionWindowSize: vi.fn(),
    readEventBaseProgress: registryKey => ({ extractedWindows: host.windows[registryKey] ?? [] }),
}));
// Other chats' collections locked to the branch, never its own (sharedCollectionsLockedHere).
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    sharedCollectionsLockedHere: ({ chatUUID }) => ({
        otherChats: host.lockedToBranch.filter(key => !key.includes(chatUUID)).map(registryKey => ({ registryKey, collectionId: registryKey.slice(7), isPaused: false })),
        archives: [],
    }),
    useChatCollection: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { findEventBaseForkSource } = await import('../src/features/eventbase/eventbase-fork.js');

const SETTINGS = { vector_backend: 'qdrant' };
const BRANCH_FIRST = `vf_eventbase_qdrant_wren_keeper_${ids.branch}`;
const BRANCH_LATER = `${BRANCH_FIRST}_mh3k2x1a`;
const PARENT_FIRST = `vf_eventbase_qdrant_wren_keeper_${ids.parent}`;
const PARENT_LATER = `${PARENT_FIRST}_mh3k2x1b`;
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
    host.lockedToParent = new Set([`qdrant:${PARENT_LATER}`]);
    host.chunks = {};
});

describe("a branch chat's fork source", () => {
    it("takes the parent's later collection in use there from the window records, never one of the branch's own", async () => {
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toMatchObject({
            source: { origin: 'window-record', collectionId: PARENT_LATER, registryKey: `qdrant:${PARENT_LATER}`, sharedPrefixLength: 2 },
            problem: null,
        });
    });

    it('takes the one in use in the parent chat over one sharing more messages that is not', async () => {
        host.listing.push(listed(PARENT_FIRST));
        host.windows[`qdrant:${PARENT_FIRST}`] = ['101,102', '103,104'];
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toMatchObject({ source: { collectionId: PARENT_LATER, sharedPrefixLength: 2 } });
    });

    it('reads none of the parent\'s collections while none is in use there, and says so', async () => {
        host.lockedToParent = new Set();
        const found = await findEventBaseForkSource(SETTINGS);
        expect(found.source).toBeNull();
        expect(found.problem).toBe('Collections of another chat hold the first 2 messages of this branch, but none is in use in its parent '
            + 'chat, so nothing is forked. Open the parent chat and choose one in Collection in use here, on the AutoSync page, '
            + 'then turn auto-sync on here again.');
    });

    it('finds nothing, and no problem, for a branch whose history no collection holds', async () => {
        host.windows = {};
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toEqual({ source: null, problem: null });
    });

    it("reads a collection locked to the branch when no window record shares a window, never the branch's own later one", async () => {
        host.windows = {};
        host.lockedToBranch = [`qdrant:${BRANCH_LATER}`, `qdrant:${PARENT_LATER}`];
        const events = [{ metadata: { source_message_hashes: [101, 102], source_window_end: 1 } }];
        host.chunks = { [BRANCH_LATER]: events, [PARENT_LATER]: events };
        await expect(findEventBaseForkSource(SETTINGS)).resolves.toMatchObject({
            source: { origin: 'locked-collection', collectionId: PARENT_LATER, registryKey: `qdrant:${PARENT_LATER}`, sharedPrefixLength: 2 },
            problem: null,
        });
    });
});
