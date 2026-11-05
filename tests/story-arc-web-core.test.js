/**
 * Tests for the story web's data (src/features/eventbase/story-arc-web-core.js).
 *
 * Guards that:
 *   - one node per event and one link per stored link, pointing from the later event to the earlier,
 *   - a link to an event no longer stored is left out,
 *   - hovering knows which ids a node lights, before and after the library swaps ids for node objects,
 *   - a selected event's markup escapes story text.
 */

import { describe, it, expect } from 'vitest';
import { buildStoryWeb, colourAlong, linkEndId, linkedIdsByNode, linksOfNode, selectedEventMarkup } from '../src/features/eventbase/story-arc-web-core.js';

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

describe('linkEndId and linkedIdsByNode', () => {
    it('reads an id whether or not the library has swapped it for a node', () => {
        expect(linkEndId(5)).toBe(5);
        expect(linkEndId({ id: 5 })).toBe(5);
    });

    it('holds a node with what it links to, both ways', () => {
        const linked = linkedIdsByNode([{ source: { id: 2 }, target: 1 }, { source: 3, target: 2 }]);
        expect([...linked.get(2)].sort()).toEqual([1, 2, 3]);
        expect([...linked.get(1)].sort()).toEqual([1, 2]);
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
