/**
 * What EventBase tells the listeners src/index.js sets (src/features/eventbase/eventbase-announcements.js): each
 * listener hears only its own kind; a removal with no event ID says nothing, and an emptied collection says null; a
 * listener left out hears nothing; and one that throws is logged, never failing the work it hears of.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const { announceCollectionInUseChanged, announceEventsRemoved, announceRunEnded, setEventBaseListeners } = await import('../src/features/eventbase/eventbase-announcements.js');
const { log } = await import('../src/sillytavern/log.js');

const HARBOR_EVENTS = 'vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

afterEach(() => {
    setEventBaseListeners();
    vi.mocked(log.warn).mockClear();
});

describe("EventBase's announcements", () => {
    it('tells each listener its own kind only', () => {
        const heard = { runs: [], removals: [], inUse: [] };
        setEventBaseListeners({
            onRunEnded: run => heard.runs.push(run),
            onEventsRemoved: (collectionId, eventIds) => heard.removals.push([collectionId, eventIds]),
            onCollectionInUseChanged: inUse => heard.inUse.push(inUse),
        });

        announceRunEnded({ collectionId: HARBOR_EVENTS, eventsAdded: 3, windowsProcessed: 2 });
        announceEventsRemoved(HARBOR_EVENTS, ['evt-gate']);
        announceEventsRemoved(HARBOR_EVENTS, null);
        announceCollectionInUseChanged({ chatId: null, collectionId: null });

        expect(heard).toEqual({
            runs: [{ collectionId: HARBOR_EVENTS, eventsAdded: 3, windowsProcessed: 2 }],
            removals: [[HARBOR_EVENTS, ['evt-gate']], [HARBOR_EVENTS, null]],
            inUse: [{ chatId: null, collectionId: null }],
        });
    });

    it('says nothing of a removal that names no event', () => {
        const removals = vi.fn();
        setEventBaseListeners({ onEventsRemoved: removals });
        announceEventsRemoved(HARBOR_EVENTS, []);
        expect(removals).not.toHaveBeenCalled();
    });

    it('tells a listener left out nothing, and logs one that throws without failing the caller', () => {
        setEventBaseListeners({ onRunEnded: () => { throw new Error('a listener broke'); } });
        expect(() => announceEventsRemoved(HARBOR_EVENTS, ['evt-gate'])).not.toThrow();
        expect(() => announceRunEnded({ collectionId: HARBOR_EVENTS, eventsAdded: 0, windowsProcessed: 1 })).not.toThrow();
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('onRunEnded'), expect.objectContaining({ message: 'a listener broke' }));
    });
});
