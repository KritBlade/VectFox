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
 *   - a selected event's markup escapes story text,
 *   - the web's lights run only in the whole web at rest while it floats, hold under the pointer, and go out otherwise,
 *   - few light at once, at most 14 sparks and 6 flares, never two on one link or dot, and spread over the web in time,
 *   - a spark runs from the earlier event to the later, goes on only along a link to a later event, up to 4 links,
 *   - a flare swells and fades, and a step leaves the lights it was given as they were.
 */

import { describe, it, expect } from 'vitest';
import {
    NO_LIGHTS,
    advanceLights,
    bowedLinkMiddle,
    buildStoryWeb,
    colourAlong,
    doBoxesOverlap,
    dotShortLabel,
    dotText,
    flareSwell,
    hoverCardSpot,
    lightCounts,
    lightsModeOf,
    linkEndId,
    linksOfNode,
    nearestNodeWithin,
    pointAlongBow,
    selectedEventMarkup,
    sparkTrail,
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

describe('the web\'s lights', () => {
    const atRest = { isFloating: true, isSettled: true, isPointedAt: false, isWholeWeb: true, isShowingFound: false };
    const FRAME_SECONDS = 1 / 30;
    const oneSecondEach = () => 1;

    /** A repeatable random (mulberry32), so a long run of steps is the same each time. */
    function seededRandom(seed) {
        let state = seed >>> 0;
        return () => {
            state = (state + 0x6D2B79F5) >>> 0;
            let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
            mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
            return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Hands out the given values in turn, then never lights anything. */
    function randomInTurn(values) {
        let index = 0;
        return () => (index < values.length ? values[index++] : 0.999);
    }

    /** Events in a row, each linked to the one before, as the library holds them: link ends are nodes. */
    function webInARow(count) {
        const nodes = Array.from({ length: count }, (_, id) => ({ id }));
        const links = nodes.slice(1).map((node, index) => ({ source: node, target: nodes[index], type: 'continues' }));
        return { nodes, links };
    }

    describe('lightsModeOf', () => {
        it('runs in the whole web at rest while it floats', () => {
            expect(lightsModeOf(atRest)).toBe('run');
        });

        it('holds still while a pointer stops the web, and while its layout still moves', () => {
            expect(lightsModeOf({ ...atRest, isPointedAt: true })).toBe('hold');
            expect(lightsModeOf({ ...atRest, isSettled: false })).toBe('hold');
        });

        it('goes out in a paused web, a sub graph, and on a search\'s events', () => {
            expect(lightsModeOf({ ...atRest, isFloating: false })).toBe('off');
            expect(lightsModeOf({ ...atRest, isWholeWeb: false })).toBe('off');
            expect(lightsModeOf({ ...atRest, isShowingFound: true })).toBe('off');
        });
    });

    describe('lightCounts', () => {
        it('lights one of each among a few', () => {
            expect(lightCounts(7, 3)).toEqual({ sparks: 1, flares: 1 });
        });

        it('lights no spark without links, and nothing in an empty web', () => {
            expect(lightCounts(5, 0)).toEqual({ sparks: 0, flares: 1 });
            expect(lightCounts(0, 0)).toEqual({ sparks: 0, flares: 0 });
        });

        it('lights at most 14 sparks and 6 flares, however big the web', () => {
            expect(lightCounts(5000, 9000)).toEqual({ sparks: 14, flares: 6 });
        });
    });

    describe('advanceLights', () => {
        it('keeps to its counts over a long run, never lights a link or dot twice, and spreads over the web', () => {
            const { nodes, links } = webInARow(1000);
            const counts = lightCounts(nodes.length, links.length);
            const random = seededRandom(7);
            const litLinks = new Set();
            const litNodes = new Set();
            let mostSparks = 0;
            let lights = NO_LIGHTS;
            for (let step = 0; step < 3000; step += 1) {
                lights = advanceLights(lights, { seconds: FRAME_SECONDS, nodes, links, sparkSeconds: oneSecondEach, random });
                expect(lights.sparks.length).toBeLessThanOrEqual(counts.sparks);
                expect(lights.flares.length).toBeLessThanOrEqual(counts.flares);
                expect(new Set(lights.sparks.map(spark => spark.link)).size).toBe(lights.sparks.length);
                expect(new Set(lights.flares.map(flare => flare.node)).size).toBe(lights.flares.length);
                for (const spark of lights.sparks) litLinks.add(spark.link);
                for (const flare of lights.flares) litNodes.add(flare.node);
                mostSparks = Math.max(mostSparks, lights.sparks.length);
            }
            expect(mostSparks).toBeGreaterThan(1);
            expect(litLinks.size).toBeGreaterThan(50);
            expect(litNodes.size).toBeGreaterThan(50);
        });

        it('lights no link or dot twice at once, when the random pick lands on a lit one', () => {
            const { nodes, links } = webInARow(201);
            const lights = advanceLights(NO_LIGHTS, { seconds: 1, nodes, links, sparkSeconds: oneSecondEach, random: () => 0 });
            expect(lights.sparks.length).toBeGreaterThan(0);
            expect(new Set(lights.sparks.map(spark => spark.link)).size).toBe(lights.sparks.length);
            expect(lights.flares.length).toBeGreaterThan(0);
            expect(new Set(lights.flares.map(flare => flare.node)).size).toBe(lights.flares.length);
        });

        it('lights nothing when no time passes, or while the rest has not run out', () => {
            const { nodes, links } = webInARow(10);
            expect(advanceLights(NO_LIGHTS, { seconds: 0, nodes, links, sparkSeconds: oneSecondEach, random: () => 0 })).toEqual(NO_LIGHTS);
            expect(advanceLights(NO_LIGHTS, { seconds: 1, nodes, links, sparkSeconds: oneSecondEach, random: () => 0.999 })).toEqual(NO_LIGHTS);
        });

        it('starts a spark at the start of its run, timed for its link, and a flare from nothing', () => {
            const { nodes, links } = webInARow(3);
            const lights = advanceLights(NO_LIGHTS, { seconds: 1, nodes, links, sparkSeconds: link => link.source.id * 0.5, random: () => 0 });
            expect(lights.sparks).toEqual([{ link: links[0], age: 0, duration: 0.5, linksRun: 1 }]);
            expect(lights.flares).toHaveLength(1);
            expect(lights.flares[0].age).toBe(0);
            expect(flareSwell(lights.flares[0])).toBe(0);
        });

        it('sends a spark on along a link from the event it reaches to a later one, never back', () => {
            const nodes = ['older', 'earlier', 'reached', 'later'].map(id => ({ id }));
            const [older, earlier, reached, later] = nodes;
            const back = { source: reached, target: older, type: 'reveals' };
            const run = { source: reached, target: earlier, type: 'continues' };
            const onward = { source: later, target: reached, type: 'continues' };
            const lights = advanceLights(
                { sparks: [{ link: run, age: 0.9, duration: 1, linksRun: 1 }], flares: [] },
                { seconds: 0.2, nodes, links: [back, run, onward], sparkSeconds: oneSecondEach, random: randomInTurn([0, 0]) },
            );
            expect(lights.sparks).toHaveLength(1);
            expect(lights.sparks[0].link).toBe(onward);
            expect(lights.sparks[0].linksRun).toBe(2);
            expect(lights.sparks[0].age).toBeCloseTo(0.1);
        });

        it('ends a spark at the newest event', () => {
            const { nodes, links } = webInARow(3);
            const lights = advanceLights(
                { sparks: [{ link: links[1], age: 0.9, duration: 1, linksRun: 1 }], flares: [] },
                { seconds: 0.2, nodes, links, sparkSeconds: oneSecondEach, random: randomInTurn([0]) },
            );
            expect(lights.sparks).toEqual([]);
        });

        it('sends a spark on up to 4 links, then ends it', () => {
            const { nodes, links } = webInARow(3);
            const arriving = linksRun => ({ sparks: [{ link: links[0], age: 0.9, duration: 1, linksRun }], flares: [] });
            const step = { seconds: 0.2, nodes, links, sparkSeconds: oneSecondEach };
            expect(advanceLights(arriving(3), { ...step, random: randomInTurn([0, 0]) }).sparks.map(spark => spark.linksRun)).toEqual([4]);
            expect(advanceLights(arriving(4), { ...step, random: randomInTurn([0, 0]) }).sparks.map(spark => spark.linksRun)).not.toContain(5);
        });

        it('ends a flare when its time is up', () => {
            const { nodes, links } = webInARow(3);
            const flare = { node: nodes[1], age: 2.9, duration: 3, peak: 2 };
            const lights = advanceLights({ sparks: [], flares: [flare] }, { seconds: 0.2, nodes, links, sparkSeconds: oneSecondEach, random: () => 0.999 });
            expect(lights.flares).toEqual([]);
        });

        it('leaves the lights it is given as they were', () => {
            const { nodes, links } = webInARow(4);
            const given = { sparks: [{ link: links[0], age: 0.2, duration: 1, linksRun: 1 }], flares: [{ node: nodes[3], age: 1, duration: 3, peak: 2 }] };
            const before = structuredClone(given);
            advanceLights(given, { seconds: 0.5, nodes, links, sparkSeconds: oneSecondEach, random: () => 0 });
            expect(given).toEqual(before);
        });
    });

    describe('flareSwell', () => {
        it('starts and ends at nothing, eases in and out, and holds full through its middle', () => {
            const at = age => flareSwell({ age, duration: 2 });
            expect(at(0)).toBe(0);
            expect(at(0.1)).toBeGreaterThan(0);
            expect(at(0.1)).toBeLessThan(at(0.3));
            expect(at(0.8)).toBe(1);
            expect(at(1.2)).toBe(1);
            expect(at(1.9)).toBeLessThan(at(1.7));
            expect(at(2)).toBe(0);
        });
    });

    describe('sparkTrail', () => {
        const earlier = { x: 0, y: 0 };
        const later = { x: 100, y: 0 };

        it('puts the head at the earlier event as it leaves and at the later as it arrives', () => {
            expect(sparkTrail(earlier, later, 0, 28).head).toEqual({ x: 0, y: 0 });
            expect(sparkTrail(earlier, later, 1, 28).head).toEqual({ x: 100, y: 0 });
        });

        it('trails the tail behind the head, and starts it no further back than the earlier event', () => {
            const halfway = sparkTrail(earlier, later, 0.5, 28);
            expect(halfway.head).toEqual({ x: 50, y: 0 });
            expect(halfway.tail.x).toBeCloseTo(22);
            expect(halfway.tail.y).toBe(0);
            expect(sparkTrail(earlier, later, 0.1, 28).tail).toEqual({ x: 0, y: 0 });
        });

        it('stays on the spot of a link with no length', () => {
            expect(sparkTrail(earlier, earlier, 0.5, 28)).toEqual({ head: { x: 0, y: 0 }, tail: { x: 0, y: 0 } });
        });
    });
});
