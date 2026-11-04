/**
 * Tests for the pure logic of StoryArc links (src/features/eventbase/story-arc-links-core.js):
 * what an LLM chooses links from, reading its reply, and walking the links.
 */

import { describe, it, expect } from 'vitest';
import {
    ALL_STORY_LINK_TYPES,
    STORY_LINK_PROMPT,
    STORY_LINK_TYPE,
    buildStoryLinkGraph,
    buildStoryLinkMessage,
    earlierEventsOf,
    estimateStoryLinkPass,
    inTimelineOrder,
    measureStoryLinkCoverage,
    mergeLinkCandidates,
    nearestByVector,
    readStoryLinks,
    shouldLinkNewEvents,
    walkStoryLinks,
} from '../src/features/eventbase/story-arc-links-core.js';

const event = (hash, start, extra = {}) => ({ _hash: hash, source_window_start: start, text: `[other] event ${hash}`, ...extra });
const link = (hash, type = STORY_LINK_TYPE.CONTINUES, thread = 'a thread') => ({ hash, type, thread });
const hashes = (events) => events.map(item => item._hash);

describe('inTimelineOrder', () => {
    it('sorts by timeline_sort_key, so events of one window keep their real order', () => {
        const ordered = inTimelineOrder([
            { timeline_sort_key: 20010000, id: 'second window' },
            { timeline_sort_key: 20000001, id: 'first window, second event' },
            { timeline_sort_key: 20000000, id: 'first window, first event' },
        ]);
        expect(ordered.map(item => item.id)).toEqual(['first window, first event', 'first window, second event', 'second window']);
    });

    it('places events without the key on the same scale', () => {
        const ordered = inTimelineOrder([
            { timeline_sort_key: 30000000, id: 'new, message 3000' },
            { source_window_start: 2000, id: 'old, message 2000' },
            { source_window_start: 2000, window_event_order: 1, id: 'old, message 2000, second' },
            { source_window_end: 4000, id: 'old, only an end' },
        ]);
        expect(ordered.map(item => item.id)).toEqual(['old, message 2000', 'old, message 2000, second', 'new, message 3000', 'old, only an end']);
    });

    it('does not change the array it is given', () => {
        const events = [{ timeline_sort_key: 2 }, { timeline_sort_key: 1 }];
        inTimelineOrder(events);
        expect(events[0].timeline_sort_key).toBe(2);
    });
});

describe('measureStoryLinkCoverage', () => {
    it('tells a decided event with no links from an undecided one', () => {
        const coverage = measureStoryLinkCoverage([
            event(1, 1, { story_links: [] }),
            event(2, 2, { story_links: [link(1)] }),
            event(3, 3),
        ]);
        expect(coverage).toMatchObject({ totalCount: 3, decidedCount: 2, linkedCount: 1 });
    });

    it('calls links usable from 90% decided, and only when one has a link', () => {
        const decided = Array.from({ length: 9 }, (_, i) => event(i, i, { story_links: [link(0)] }));
        expect(measureStoryLinkCoverage([...decided, event(9, 9)]).hasUsableLinks).toBe(true);
        expect(measureStoryLinkCoverage([...decided, event(9, 9), event(10, 10)]).hasUsableLinks).toBe(false);
        expect(measureStoryLinkCoverage([event(1, 1, { story_links: [] })]).hasUsableLinks).toBe(false);
        expect(measureStoryLinkCoverage([]).hasUsableLinks).toBe(false);
    });
});

describe('shouldLinkNewEvents', () => {
    it('links in a new chat, and in a chat whose older events are decided', () => {
        expect(shouldLinkNewEvents([])).toBe(true);
        expect(shouldLinkNewEvents([event(1, 1, { story_links: [] })])).toBe(true);
    });

    // Otherwise every reply would pay for links nothing can walk yet.
    it('waits when the chat has never had a link pass', () => {
        expect(shouldLinkNewEvents([event(1, 1), event(2, 2)])).toBe(false);
    });
});

describe('earlierEventsOf', () => {
    it('leaves out the event\'s own window and later ones', () => {
        const events = [event(1, 10), event(2, 20), event(3, 20), event(4, 30)];
        expect(hashes(earlierEventsOf(events[2], events))).toEqual([1]);
        expect(hashes(earlierEventsOf(events[0], events))).toEqual([]);
    });
});

describe('nearestByVector', () => {
    const withVector = (hash, values) => event(hash, hash, { vector: Float32Array.from(values) });

    it('returns the closest first, at most the limit', () => {
        const events = [withVector(1, [1, 0]), withVector(2, [0, 1]), withVector(3, [0.8, 0.6]), withVector(4, [-1, 0])];
        expect(hashes(nearestByVector(Float32Array.from([1, 0]), events, 2))).toEqual([1, 3]);
    });

    it('skips an event with no vector or one of another size', () => {
        const events = [event(1, 1), withVector(2, [1, 0, 0]), withVector(3, [1, 0])];
        expect(hashes(nearestByVector(Float32Array.from([1, 0]), events, 5))).toEqual([3]);
    });
});

describe('mergeLinkCandidates', () => {
    it('adds the 3 events just before, oldest first, without repeats', () => {
        const earlier = [1, 2, 3, 4, 5].map(i => event(i, i * 10));
        expect(hashes(mergeLinkCandidates([earlier[0], earlier[4]], earlier))).toEqual([1, 3, 4, 5]);
    });
});

describe('buildStoryLinkMessage', () => {
    it('shows candidates with E ids and message numbers, and the new event last', () => {
        const message = buildStoryLinkMessage(
            event(3, 300, { text: '[discovery] She finds the map\nCAUSE: A tip\nRESULT: They sail\nCHARS: Nora' }),
            [event(1, 100, { text: '[other] They reach port' })],
        );
        expect(message).toBe('EARLIER:\nE1: (message 100) They reach port\n\nNEW:\n(message 300) She finds the map | CAUSE: A tip | RESULT: They sail');
    });

    it('still shows text that does not follow the stored format', () => {
        expect(buildStoryLinkMessage(event(1, 5, { text: 'plain words' }), [])).toContain('(message 5) plain words');
    });
});

describe('readStoryLinks', () => {
    const candidates = [event(11, 1), event(22, 2), event(33, 3)];

    it('maps ids to hashes and keeps the strongest first', () => {
        const { links, droppedCount } = readStoryLinks({
            links: [
                { id: 'E3', type: 'caused_by', thread: ' The blockade ' },
                { id: 'E1', type: 'continues', thread: 'The blockade' },
            ],
        }, candidates);
        expect(links).toEqual([
            { hash: 33, type: 'caused_by', thread: 'The blockade' },
            { hash: 11, type: 'continues', thread: 'The blockade' },
        ]);
        expect(droppedCount).toBe(0);
    });

    it('drops and counts an unknown id, an unknown type and a repeat', () => {
        const { links, droppedCount } = readStoryLinks({
            links: [
                { id: 'E9', type: 'continues' },
                { id: '2', type: 'continues' },
                { id: 'E1', type: 'follows' },
                { id: 'E2', type: 'reveals' },
                { id: 'E2', type: 'continues' },
            ],
        }, candidates);
        expect(links).toEqual([{ hash: 22, type: 'reveals', thread: '' }]);
        expect(droppedCount).toBe(4);
    });

    it('reads "no links" as a decision', () => {
        expect(readStoryLinks({ links: [] }, candidates)).toEqual({ links: [], droppedCount: 0 });
    });

    // Reading a malformed reply as "no links" would store a wrong decision that no retry ever fixes.
    it('throws on a reply with no links array', () => {
        for (const reply of [{}, { links: 'none' }, null, 'E1']) {
            expect(() => readStoryLinks(reply, candidates), JSON.stringify(reply)).toThrow('no links array');
        }
    });
});

describe('buildStoryLinkGraph and walkStoryLinks', () => {
    const events = [
        event(1, 10, { story_links: [] }),
        event(2, 20, { story_links: [link(1)] }),
        event(3, 30, { story_links: [link(2), link(1, STORY_LINK_TYPE.CAUSED_BY)] }),
        event(4, 500, { story_links: [link(3, STORY_LINK_TYPE.REVEALS)] }),
        event(5, 510),
    ];

    it('walks back and forward over the allowed types, counting links', () => {
        const { parents, children } = buildStoryLinkGraph(events);
        expect([...walkStoryLinks([3], parents, ALL_STORY_LINK_TYPES)]).toEqual([[3, 0], [2, 1], [1, 1]]);
        expect([...walkStoryLinks([1], children, [STORY_LINK_TYPE.CONTINUES])]).toEqual([[1, 0], [2, 1], [3, 2]]);
    });

    it('does not cross a link type it is not allowed', () => {
        const { parents } = buildStoryLinkGraph(events);
        expect([...walkStoryLinks([4], parents, [STORY_LINK_TYPE.CONTINUES]).keys()]).toEqual([4]);
    });

    // Re-extraction and message deletes remove events that later events still link to.
    it('leaves out a link to a deleted event', () => {
        const { parents } = buildStoryLinkGraph([event(2, 20, { story_links: [link(999)] })]);
        expect(parents.size).toBe(0);
    });

    it('can keep only some links, by place and message gap', () => {
        const { parents } = buildStoryLinkGraph(events, (position, messageGap) => position === 0 && messageGap < 100);
        expect(parents.get(3)).toEqual([{ hash: 2, type: STORY_LINK_TYPE.CONTINUES }]);
        expect(parents.has(4)).toBe(false);
    });
});

describe('estimateStoryLinkPass', () => {
    it('gives tokens, minutes and cost', () => {
        const estimate = estimateStoryLinkPass(1437, { input: 0.0000001, output: 0.0000005 });
        expect(estimate.minutes).toBe(19);
        expect(estimate.costUsd).toBeCloseTo(0.49, 2);
    });

    it('gives no cost when the price is unknown', () => {
        expect(estimateStoryLinkPass(10, null).costUsd).toBeNull();
    });
});

describe('STORY_LINK_PROMPT', () => {
    it('names every link type and asks for JSON', () => {
        for (const type of ALL_STORY_LINK_TYPES) expect(STORY_LINK_PROMPT).toContain(`"${type}"`);
        expect(STORY_LINK_PROMPT).toContain('Reply with JSON only');
    });
});
