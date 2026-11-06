/**
 * Tests for the story web's data (src/features/eventbase/story-arc-web-core.js).
 *
 * Guards that:
 *   - one node per event and one link per stored link, pointing from the later event to the earlier,
 *   - a link to an event no longer stored is left out,
 *   - a link end reads the same before and after the library swaps ids for node objects,
 *   - a pointer means the nearest allowed dot within reach, whatever its size,
 *   - a sub graph holds a node, what it links to and the links among them, unplaced, and leaves the whole web as it was,
 *   - a label wraps Chinese anywhere and keeps a Latin word whole, and a hover card stays inside the canvas,
 *   - a selected event's markup escapes story text.
 */

import { describe, it, expect } from 'vitest';
import {
    bowedLinkMiddle,
    buildStoryWeb,
    colourAlong,
    doBoxesOverlap,
    dotShortLabel,
    dotText,
    hoverCardSpot,
    linkEndId,
    linksOfNode,
    nearestNodeWithin,
    pointAlongBow,
    selectedEventMarkup,
    storySubWeb,
    wrapLabelLines,
} from '../src/features/eventbase/story-arc-web-core.js';

const event = (hash, links = []) => ({
    _hash: hash,
    event_id: `id${hash}`,
    source_window_start: hash * 10,
    text: `summary ${hash}`,
    story_links: links,
});

describe('buildStoryWeb', () => {
    it('makes one node per event and one link per stored link', () => {
        const { nodes, links } = buildStoryWeb([
            event(1),
            event(2, [{ event_id: 'id1', type: 'continues', thread: 'A thread' }]),
            event(3, [{ event_id: 'id2', type: 'reveals', thread: '' }, { event_id: 'id1', type: 'caused_by', thread: 'B' }]),
        ]);
        expect(nodes.map(node => [node.id, node.message, node.linkCount])).toEqual([[1, 10, 2], [2, 20, 2], [3, 30, 2]]);
        expect(links).toEqual([
            { source: 2, target: 1, type: 'continues', thread: 'A thread' },
            { source: 3, target: 2, type: 'reveals', thread: '' },
            { source: 3, target: 1, type: 'caused_by', thread: 'B' },
        ]);
    });

    it('leaves out a link to an event no longer stored', () => {
        const { links, nodes } = buildStoryWeb([event(2, [{ event_id: 'gone', type: 'continues' }])]);
        expect(links).toEqual([]);
        expect(nodes[0].linkCount).toBe(0);
    });

    it('gives the most linked node the full heat, and an unlinked node none', () => {
        const { nodes } = buildStoryWeb([
            event(1),
            event(2, [{ event_id: 'id1', type: 'continues' }]),
            event(3, [{ event_id: 'id1', type: 'continues' }]),
            event(4),
        ]);
        expect(nodes.find(node => node.id === 1).heat).toBe(1);
        expect(nodes.find(node => node.id === 4).heat).toBe(0);
    });

    it('takes a chat with no links', () => {
        expect(buildStoryWeb([event(1)]).nodes[0].heat).toBe(0);
    });
});

describe('linkEndId', () => {
    it('reads an id whether or not the library has swapped it for a node', () => {
        expect(linkEndId(5)).toBe(5);
        expect(linkEndId({ id: 5 })).toBe(5);
    });
});

describe('nearestNodeWithin', () => {
    const nodes = [{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 0 }, { id: 3, x: 3, y: 0 }, { id: 4 }];
    const anyId = () => true;

    it('takes the nearest node inside the reach', () => {
        expect(nearestNodeWithin(nodes, 2, 0, 20, anyId).id).toBe(3);
    });

    it('takes nothing outside the reach', () => {
        expect(nearestNodeWithin(nodes, 100, 0, 20, anyId)).toBeNull();
    });

    it('skips a node it may not take, and one not yet placed', () => {
        expect(nearestNodeWithin(nodes, 2, 0, 20, id => id !== 3).id).toBe(1);
        expect(nearestNodeWithin([{ id: 4 }], 0, 0, 20, anyId)).toBeNull();
    });
});

describe('storySubWeb', () => {
    const node = (id, extra = {}) => ({ id, message: id * 10, linkCount: 1, heat: 0.5, line: `- #${id * 10}: text`, colour: 'red', phase: 1, ...extra });
    const web = {
        nodes: [node(1, { x: 5, y: 6, vx: 1, vy: 1, homeX: 5, homeY: 6 }), node(2), node(3), node(4)],
        links: [
            { source: node(2), target: node(1), type: 'continues', thread: 'A' },
            { source: 3, target: 1, type: 'reveals', thread: 'B' },
            { source: 3, target: 2, type: 'caused_by', thread: 'C' },
            { source: 4, target: 3, type: 'continues', thread: 'D' },
        ],
    };

    it('holds the node, what it links to, and the links among them', () => {
        const { nodes, links } = storySubWeb(web, 1);
        expect(nodes.map(each => each.id)).toEqual([1, 2, 3]);
        expect(links).toEqual([
            { source: 2, target: 1, type: 'continues', thread: 'A' },
            { source: 3, target: 1, type: 'reveals', thread: 'B' },
            { source: 3, target: 2, type: 'caused_by', thread: 'C' },
        ]);
    });

    it('makes new unplaced nodes, with the centre pinned, and leaves the whole web as it was', () => {
        const { nodes } = storySubWeb(web, 1);
        expect(nodes[0]).toEqual({ id: 1, message: 10, linkCount: 1, heat: 0.5, line: '- #10: text', colour: 'red', phase: 1, fx: 0, fy: 0 });
        expect(nodes[1].fx).toBeUndefined();
        expect(nodes[0]).not.toBe(web.nodes[0]);
        expect(web.nodes[0].x).toBe(5);
        expect(web.nodes[0].fx).toBeUndefined();
    });

    it('holds a node with no links alone', () => {
        const { nodes, links } = storySubWeb({ nodes: [node(9)], links: [] }, 9);
        expect(nodes.map(each => each.id)).toEqual([9]);
        expect(links).toEqual([]);
    });
});

describe('dotText and dotShortLabel', () => {
    const dot = { message: 28, line: '- #28: 一個長長的故事: 有冒號' };

    it('takes the line\'s number off, and only that', () => {
        expect(dotText(dot)).toBe('一個長長的故事: 有冒號');
    });

    it('shortens to a number of characters, and says when it did', () => {
        expect(dotShortLabel(dot, 2)).toBe('#28 一個…');
        expect(dotShortLabel(dot, 50)).toBe('#28 一個長長的故事: 有冒號');
    });
});

describe('wrapLabelLines', () => {
    const widthOf = text => Array.from(text).length;

    it('breaks text with no spaces anywhere', () => {
        expect(wrapLabelLines('一二三四五六七', 3, widthOf, 5)).toEqual(['一二三', '四五六', '七']);
    });

    it('keeps a word whole when spaces let it', () => {
        expect(wrapLabelLines('one two three', 7, widthOf, 5)).toEqual(['one two', 'three']);
    });

    it('breaks a word longer than a line', () => {
        expect(wrapLabelLines('abcdefgh', 3, widthOf, 5)).toEqual(['abc', 'def', 'gh']);
    });

    it('ends in an ellipsis when it runs out of lines, still fitting the width', () => {
        const lines = wrapLabelLines('一二三四五六七', 3, widthOf, 2);
        expect(lines).toEqual(['一二三', '四五…']);
        expect(widthOf(lines[1])).toBeLessThanOrEqual(3);
    });

    it('gives nothing for empty text', () => {
        expect(wrapLabelLines('  ', 3, widthOf, 2)).toEqual([]);
    });
});

describe('hoverCardSpot', () => {
    const placement = { clearance: 10, width: 100, height: 50, canvasWidth: 400, canvasHeight: 300, margin: 8, spotsToLeaveInView: [] };

    it('goes under a dot, centred on it', () => {
        expect(hoverCardSpot({ ...placement, x: 200, y: 100 })).toEqual({ left: 150, top: 110 });
    });

    it('goes over a dot near the bottom, rather than cover it', () => {
        expect(hoverCardSpot({ ...placement, x: 200, y: 280 })).toEqual({ left: 150, top: 220 });
    });

    it('stays inside the canvas at the sides', () => {
        expect(hoverCardSpot({ ...placement, x: 5, y: 100 }).left).toBe(8);
        expect(hoverCardSpot({ ...placement, x: 395, y: 100 }).left).toBe(292);
    });

    it('stays inside a canvas smaller than the card', () => {
        expect(hoverCardSpot({ ...placement, x: 5, y: 5, canvasWidth: 60, canvasHeight: 40 })).toEqual({ left: 8, top: 8 });
    });

    it('takes the side that leaves connected dots in view', () => {
        const under = { x: 200, y: 130 };
        const over = { x: 200, y: 70 };
        expect(hoverCardSpot({ ...placement, x: 200, y: 100, spotsToLeaveInView: [under] }).top).toBe(40);
        expect(hoverCardSpot({ ...placement, x: 200, y: 100, spotsToLeaveInView: [under, over] })).toEqual({ left: 210, top: 75 });
    });

    it('takes the side covering the fewest when each covers some', () => {
        const spots = [{ x: 200, y: 130 }, { x: 180, y: 130 }, { x: 200, y: 70 }, { x: 250, y: 100 }, { x: 150, y: 100 }];
        expect(hoverCardSpot({ ...placement, x: 200, y: 100, spotsToLeaveInView: spots }).top).toBe(40);
    });
});

describe('doBoxesOverlap', () => {
    const box = { left: 0, top: 0, right: 10, bottom: 10 };

    it('says whether two boxes share space', () => {
        expect(doBoxesOverlap(box, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
        expect(doBoxesOverlap(box, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    });
});

describe('a bowed link', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };

    it('starts and ends on its dots', () => {
        const middle = bowedLinkMiddle(from, to);
        expect(pointAlongBow(from, middle, to, 0)).toEqual(from);
        expect(pointAlongBow(from, middle, to, 1)).toEqual(to);
    });

    it('bends away from the straight line between them', () => {
        const middle = bowedLinkMiddle(from, to);
        expect(pointAlongBow(from, middle, to, 0.5).y).toBeCloseTo(-4);
    });
});

describe('colourAlong', () => {
    const stops = [[0, 0, 0], [100, 100, 100], [200, 0, 0]];

    it('reaches both ends and mixes between stops', () => {
        expect(colourAlong(0, stops)).toBe('rgb(0,0,0)');
        expect(colourAlong(1, stops)).toBe('rgb(200,0,0)');
        expect(colourAlong(0.25, stops)).toBe('rgb(50,50,50)');
    });

    it('holds a share outside 0 to 1 at the ends', () => {
        expect(colourAlong(-1, stops)).toBe('rgb(0,0,0)');
        expect(colourAlong(2, stops)).toBe('rgb(200,0,0)');
    });
});

describe('linksOfNode', () => {
    it('splits a node\'s links into what it builds on and what builds on it', () => {
        const nodeById = new Map([[1, { message: 10 }], [2, { message: 20 }], [3, { message: 30 }]]);
        const links = [
            { source: 2, target: 1, type: 'continues', thread: 'A' },
            { source: { id: 3 }, target: { id: 2 }, type: 'reveals', thread: 'B' },
        ];
        expect(linksOfNode(2, links, nodeById)).toEqual({
            earlier: [{ message: 10, type: 'continues', thread: 'A' }],
            later: [{ message: 30, type: 'reveals', thread: 'B' }],
        });
    });
});

describe('selectedEventMarkup', () => {
    it('shows the event and its links, with story text escaped', () => {
        const markup = selectedEventMarkup(
            { message: 20, line: '- #20: <b>bold</b>' },
            { earlier: [{ message: 10, type: 'continues', thread: 'A & B' }], later: [] },
        );
        expect(markup).toContain('#20');
        expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt;');
        expect(markup).not.toContain('<b>bold');
        expect(markup).toContain('continues #10: A &amp; B');
    });
});
