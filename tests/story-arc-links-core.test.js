/**
 * Tests for the pure logic of StoryArc links (src/features/eventbase/story-arc-links-core.js):
 * what an LLM chooses links from, reading its reply, walking the links, and the file
 * that saves them apart from their events.
 */

import { describe, it, expect } from 'vitest';
import {
    ALL_STORY_LINK_TYPES,
    STORY_LINKS_FILE_TYPE,
    STORY_LINK_PROMPT,
    STORY_LINK_TYPE,
    buildStoryLinkGraph,
    buildStoryLinkMessage,
    buildStoryLinksFile,
    describeStoryLinkCoverage,
    describeStoryLinksImport,
    earlierEventsOf,
    estimateStoryLinkPass,
    inTimelineOrder,
    measureStoryLinkCoverage,
    mergeLinkCandidates,
    nearestByVector,
    planStoryLinkWrites,
    readStoryLinks,
    readStoryLinksFile,
    shouldLinkNewEvents,
    walkStoryLinks,
} from '../src/features/eventbase/story-arc-links-core.js';

const event = (hash, start, extra = {}) => ({ _hash: hash, event_id: `id${hash}`, source_window_start: start, text: `[other] event ${hash}`, ...extra });
const link = (hash, type = STORY_LINK_TYPE.CONTINUES, thread = 'a thread') => ({ event_id: `id${hash}`, type, thread });
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

    // Links that lead nowhere must read as none, or a chat looks linked while every walk stops at once.
    it('does not count an event whose links reach no stored event', () => {
        const coverage = measureStoryLinkCoverage([
            event(1, 1, { story_links: [link(999)] }),
            event(2, 2, { story_links: [{ hash: 1, type: STORY_LINK_TYPE.CONTINUES, thread: 't' }] }),
        ]);
        expect(coverage).toMatchObject({ decidedCount: 2, linkedCount: 0, hasUsableLinks: false });
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

    it('maps ids to event ids and keeps the strongest first', () => {
        const { links, droppedCount } = readStoryLinks({
            links: [
                { id: 'E3', type: 'caused_by', thread: ' The blockade ' },
                { id: 'E1', type: 'continues', thread: 'The blockade' },
            ],
        }, candidates);
        expect(links).toEqual([
            { event_id: 'id33', type: 'caused_by', thread: 'The blockade' },
            { event_id: 'id11', type: 'continues', thread: 'The blockade' },
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
        expect(links).toEqual([{ event_id: 'id22', type: 'reveals', thread: '' }]);
        expect(droppedCount).toBe(4);
    });

    it('drops a candidate with no event_id, which no link could name', () => {
        const { links, droppedCount } = readStoryLinks({ links: [{ id: 'E1', type: 'continues' }] }, [{ _hash: 11, source_window_start: 1 }]);
        expect(links).toEqual([]);
        expect(droppedCount).toBe(1);
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

    // An import or a text edit gives an event's point a new hash.
    it('keeps a link when the event it reaches has a new hash', () => {
        const { parents, children } = buildStoryLinkGraph([event(1, 10, { _hash: 777 }), event(2, 20, { story_links: [link(1)] })]);
        expect(parents.get(2)).toEqual([{ hash: 777, type: STORY_LINK_TYPE.CONTINUES }]);
        expect(children.get(777)).toEqual([{ hash: 2, type: STORY_LINK_TYPE.CONTINUES }]);
    });

    it('does not take an event with no event_id for what a link with none reaches', () => {
        const { parents } = buildStoryLinkGraph([
            { _hash: 1, source_window_start: 1 },
            { _hash: 2, source_window_start: 2, story_links: [{ type: STORY_LINK_TYPE.CONTINUES, thread: 't' }] },
        ]);
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

describe('describeStoryLinkCoverage', () => {
    it('says how many events are linked, and how many are not decided yet', () => {
        expect(describeStoryLinkCoverage({ totalCount: 1803, decidedCount: 1803, linkedCount: 1672 })).toBe('1672 of 1803 events linked');
        expect(describeStoryLinkCoverage({ totalCount: 10, decidedCount: 7, linkedCount: 5 })).toBe('5 of 10 events linked, 3 not decided yet');
    });

    it('says when there are no events, and when they could not be read', () => {
        expect(describeStoryLinkCoverage({ totalCount: 0, decidedCount: 0, linkedCount: 0 })).toBe('No events yet');
        expect(describeStoryLinkCoverage(null)).toContain('Could not read');
    });
});

describe('the links file', () => {
    const events = [
        event(2, 20, { story_links: [link(1)] }),
        event(1, 10, { story_links: [] }),
        event(3, 30),
    ];
    const collection = { id: 'vf_eventbase_chat', name: 'A chat' };
    const file = () => buildStoryLinksFile(events, collection, '2026-11-05T00:00:00.000Z');

    it('holds each decided event in timeline order, and leaves out what is undecided', () => {
        expect(file()).toEqual({
            type: STORY_LINKS_FILE_TYPE,
            exportDate: '2026-11-05T00:00:00.000Z',
            collection,
            events: [
                { event_id: 'id1', story_links: [] },
                { event_id: 'id2', story_links: [link(1)] },
            ],
        });
    });

    it('refuses to export links that name no event_id', () => {
        const unusable = [event(1, 10, { story_links: [] }), event(2, 20, { story_links: [{ hash: 1, type: STORY_LINK_TYPE.CONTINUES, thread: 't' }] })];
        expect(() => buildStoryLinksFile(unusable, collection, 'a date')).toThrow('1 events hold links without an event_id');
    });

    it('reads back what it wrote', () => {
        const linksByEventId = readStoryLinksFile(JSON.parse(JSON.stringify(file())));
        expect([...linksByEventId]).toEqual([['id1', []], ['id2', [link(1)]]]);
    });

    it('keeps only what a link needs', () => {
        const withExtras = { ...file(), events: [{ event_id: 'id2', extra: true, story_links: [{ ...link(1), extra: 'field', thread: 7 }] }] };
        expect(readStoryLinksFile(withExtras).get('id2')).toEqual([{ event_id: 'id1', type: STORY_LINK_TYPE.CONTINUES, thread: '' }]);
    });

    it('refuses anything that is not a links file', () => {
        for (const other of [null, {}, { type: 'other', events: [] }, { type: STORY_LINKS_FILE_TYPE }, { chunks: [] }]) {
            expect(() => readStoryLinksFile(other), JSON.stringify(other)).toThrow('not a StoryArc links file');
        }
    });

    // Writing part of a damaged file would leave a collection half replaced with no sign of it.
    it('refuses a damaged file whole', () => {
        const damagedRecords = [
            { story_links: [] },
            { event_id: 'id1' },
            { event_id: 'id1', story_links: [{ type: STORY_LINK_TYPE.CONTINUES }] },
            { event_id: 'id1', story_links: [{ event_id: 'id2', type: 'follows' }] },
        ];
        for (const record of damagedRecords) {
            const events = [{ event_id: 'id9', story_links: [] }, record];
            expect(() => readStoryLinksFile({ ...file(), events }), JSON.stringify(record)).toThrow('damaged at its event number 2');
        }
    });
});

describe('planStoryLinkWrites', () => {
    const linksByEventId = new Map([['id1', []], ['id2', [link(1)]]]);

    it('matches events by event_id, whatever hash their points have now', () => {
        const plan = planStoryLinkWrites(linksByEventId, [event(1, 10, { _hash: 777 }), event(2, 20, { _hash: 888 })]);
        expect(plan.writes.map(write => write.event._hash)).toEqual([777, 888]);
        expect(plan.writes[1].links).toEqual([link(1)]);
        expect(plan).toMatchObject({ fileEventCount: 2, storedEventCount: 2, leftOutLinkCount: 0 });
    });

    it('finds nothing in a collection of other events', () => {
        const plan = planStoryLinkWrites(linksByEventId, [event(8, 10), event(9, 20)]);
        expect(plan.writes).toEqual([]);
        expect(plan.fileEventCount).toBe(2);
    });

    it('skips what the collection lacks, and leaves out links it could not walk', () => {
        const plan = planStoryLinkWrites(linksByEventId, [event(2, 20), event(5, 50)]);
        expect(plan.writes).toEqual([{ event: expect.objectContaining({ _hash: 2 }), links: [] }]);
        expect(plan).toMatchObject({ fileEventCount: 2, storedEventCount: 2, leftOutLinkCount: 1 });
    });
});

describe('describeStoryLinksImport', () => {
    it('says only what will be replaced when the file and the collection hold the same events', () => {
        const lines = describeStoryLinksImport({ writes: [{}, {}], fileEventCount: 2, storedEventCount: 2, leftOutLinkCount: 0 });
        expect(lines).toEqual(['2 of this collection\'s 2 events are in the file, and their links will be replaced.']);
    });

    it('says what stays, what is skipped and what is left out', () => {
        const lines = describeStoryLinksImport({ writes: [{}, {}], fileEventCount: 5, storedEventCount: 3, leftOutLinkCount: 4 });
        expect(lines).toEqual([
            '2 of this collection\'s 3 events are in the file, and their links will be replaced.',
            'The other 1 keep what they have.',
            '3 events in the file are not in this collection, so they are skipped.',
            '4 links reach events this collection does not hold, so they are left out.',
        ]);
    });
});
