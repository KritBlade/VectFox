/**
 * Compact collection on an EventBase collection (src/features/eventbase/eventbase-compaction.js): it plans from the
 * stored events, moves the StoryArc links before any event goes, and removes nothing when the links did not all move.
 *
 * Runs the real compaction plan and StoryArc link writer; the collection's events, the vector backend and the host
 * modules are stubbed, as in story-arc-links.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const backend = vi.hoisted(() => ({ updateChunkMetadata: vi.fn(), deleteVectorItems: vi.fn(), queryCollection: vi.fn() }));
vi.mock('../src/features/vector-backend/index.js', () => backend);
vi.mock('../src/features/collections/index.js', () => ({ fetchPortableChunks: vi.fn() }));
// The EventBase search reads a collection's backend from its id; the real module reaches SillyTavern host modules.
vi.mock('../src/shared/collection-ids.js', () => ({ resolveBackendForCollection: (id) => ({ backend: null, collectionId: id }) }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ callLlmForJson: vi.fn(), resolveStoryLinkLlmConfig: vi.fn() }));
// The link model's price, which compaction never reads; the real barrel reaches SillyTavern.
vi.mock('../src/features/llm-provider/index.js', () => ({ readOpenRouterModelPrice: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({ collectionInUse: vi.fn(), noCollectionInUseText: vi.fn() }));
const listStoryEventsMock = vi.hoisted(() => vi.fn());
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ listStoryEvents: listStoryEventsMock }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: (run) => run() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ isInvalidModelConfigError: () => false, notifyInvalidModel: vi.fn() }));
const progressMock = vi.hoisted(() => ({
    show: vi.fn(), setCancelHandler: vi.fn(), clearCancelHandler: vi.fn(), updateProgress: vi.fn(),
    updateEmbeddingProgress: vi.fn(), addError: vi.fn(), complete: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: progressMock }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), lifecycle: vi.fn(), domain: vi.fn(), error: vi.fn() } }));

const { compactCollection, planCollectionCompaction } = await import('../src/features/eventbase/eventbase-compaction.js');

const COLLECTION = 'vf_eventbase_qdrant_rook_mira_aaaa';
const settings = { vector_backend: 'qdrant' };

/** A stored event of the two-message window starting at windowStart; its point's hash is `hash`. */
const eventOf = (hash, windowStart, { time = 1000, order = 0, links } = {}) => ({
    _hash: hash,
    event_id: `event-${hash}`,
    created_at: time,
    source_window_start: windowStart,
    source_window_end: windowStart + 1,
    source_message_hashes: [windowStart * 10, windowStart * 10 + 1],
    window_event_order: order,
    ...(links ? { story_links: links } : {}),
});

/** Window 0 read twice, and a later event linked to its older reading. */
const collectionWithRepeat = () => [
    eventOf(11, 0, { time: 1000 }),
    eventOf(12, 0, { time: 2000 }),
    eventOf(13, 4, { time: 3000, links: [{ event_id: 'event-11', type: 'continues', thread: '' }] }),
];

beforeEach(() => {
    vi.clearAllMocks();
    backend.updateChunkMetadata.mockReset().mockResolvedValue({});
    backend.deleteVectorItems.mockReset().mockResolvedValue(undefined);
    listStoryEventsMock.mockReset().mockResolvedValue(collectionWithRepeat());
});

describe('Compact collection', () => {
    it('plans from the collection\'s stored events', async () => {
        const plan = await planCollectionCompaction(COLLECTION, settings);
        expect(listStoryEventsMock).toHaveBeenCalledWith(COLLECTION, settings);
        expect(plan.repeats.map(event => event.event_id)).toEqual(['event-11']);
    });

    it('says so when the collection\'s events cannot be read', async () => {
        listStoryEventsMock.mockResolvedValue(null);
        await expect(planCollectionCompaction(COLLECTION, settings)).rejects.toThrow('Could not read this collection\'s events');
    });

    it('moves the links first, then removes the repeated events', async () => {
        const plan = await planCollectionCompaction(COLLECTION, settings);

        const result = await compactCollection(plan, COLLECTION, settings);

        expect(result.removedCount).toBe(1);
        expect(backend.updateChunkMetadata).toHaveBeenCalledWith(COLLECTION, 13, { story_links: [{ event_id: 'event-12', type: 'continues', thread: '' }] }, settings);
        expect(backend.deleteVectorItems).toHaveBeenCalledWith(COLLECTION, [11], settings);
        expect(backend.updateChunkMetadata.mock.invocationCallOrder[0]).toBeLessThan(backend.deleteVectorItems.mock.invocationCallOrder[0]);
    });

    it('removes the repeated events with no link write when no link points at them', async () => {
        listStoryEventsMock.mockResolvedValue([eventOf(11, 0, { time: 1000 }), eventOf(12, 0, { time: 2000 })]);
        const plan = await planCollectionCompaction(COLLECTION, settings);

        expect((await compactCollection(plan, COLLECTION, settings)).removedCount).toBe(1);
        expect(backend.updateChunkMetadata).not.toHaveBeenCalled();
        expect(backend.deleteVectorItems).toHaveBeenCalledWith(COLLECTION, [11], settings);
    });

    it('removes nothing when a link does not move, and says pressing it again finishes', async () => {
        backend.updateChunkMetadata.mockRejectedValue(new Error('Qdrant refused the write'));
        const plan = await planCollectionCompaction(COLLECTION, settings);

        const result = await compactCollection(plan, COLLECTION, settings);

        expect(result.removedCount).toBe(0);
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
        expect(progressMock.complete).toHaveBeenLastCalledWith(false, expect.stringContaining('No event was removed. Press Compact collection again to retry those.'));
    });

    it('removes nothing when stopped while the links move', async () => {
        backend.updateChunkMetadata.mockImplementation(async () => {
            progressMock.setCancelHandler.mock.calls.at(-1)[0]();
            return {};
        });
        const plan = await planCollectionCompaction(COLLECTION, settings);

        const result = await compactCollection(plan, COLLECTION, settings);

        expect(result).toMatchObject({ removedCount: 0, linkMoves: { isStopped: true } });
        expect(backend.deleteVectorItems).not.toHaveBeenCalled();
    });
});
