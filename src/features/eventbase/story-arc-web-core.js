/**
 * ============================================================================
 * STORY WEB
 * ============================================================================
 * The story's events and links as a graph to draw: one node per event, one link
 * per stored story link, pointing from the later event to the earlier one. Pure:
 * no host imports, and no drawing, only the markup of a selected event.
 * ============================================================================
 */

import { recordCard, resultList } from '../../shared/gui-dna/gui-dna-core.js';
import { formatStoryLine, storyLinePosition } from './eventbase-injection.js';

/**
 * @typedef {object} StoryWebNode
 * @property {number} id - The event's hash
 * @property {number|undefined} message - Its position in the conversation
 * @property {number} linkCount
 * @property {number} heat - 0 to 1: how many links it has, on a curve that keeps most events from looking cold
 * @property {string} line - The event as one story line
 */

/**
 * @param {object[]} events - Stored events, each with `_hash`
 * @returns {{nodes: StoryWebNode[], links: {source: number, target: number, type: string, thread: string}[]}}
 */
export function buildStoryWeb(events) {
    const eventByEventId = new Map(events.map(event => [event.event_id, event]));
    const links = events.flatMap(event => (event.story_links ?? []).flatMap((link) => {
        const parent = eventByEventId.get(link.event_id);
        return parent ? [{ source: event._hash, target: parent._hash, type: link.type, thread: link.thread ?? '' }] : [];
    }));
    const linkCountById = new Map();
    for (const { source, target } of links) {
        linkCountById.set(source, (linkCountById.get(source) ?? 0) + 1);
        linkCountById.set(target, (linkCountById.get(target) ?? 0) + 1);
    }
    const mostLinks = Math.max(1, ...linkCountById.values());
    const nodes = events.map((event) => {
        const linkCount = linkCountById.get(event._hash) ?? 0;
        return { id: event._hash, message: storyLinePosition(event), linkCount, heat: Math.sqrt(linkCount / mostLinks), line: formatStoryLine(event) };
    });
    return { nodes, links };
}

/** A link end's node id: the graph library swaps ids for node objects once it has the data. */
export function linkEndId(end) {
    return typeof end === 'object' && end !== null ? end.id : end;
}

/**
 * Each node's id with the ids it links to, which is what hovering lights.
 *
 * @param {{source: *, target: *}[]} links
 * @returns {Map<number, Set<number>>}
 */
export function linkedIdsByNode(links) {
    const linked = new Map();
    const add = (from, to) => {
        if (!linked.has(from)) linked.set(from, new Set([from]));
        linked.get(from).add(to);
    };
    for (const { source, target } of links) {
        const sourceId = linkEndId(source);
        const targetId = linkEndId(target);
        add(sourceId, targetId);
        add(targetId, sourceId);
    }
    return linked;
}

/**
 * A colour along a list of stops.
 *
 * @param {number} share - 0 to 1
 * @param {number[][]} stops - At least two, each [red, green, blue]
 * @returns {string} an rgb() colour
 */
export function colourAlong(share, stops) {
    const place = Math.min(Math.max(share, 0), 1) * (stops.length - 1);
    const lower = Math.min(Math.floor(place), stops.length - 2);
    const mixed = stops[lower].map((value, channel) => Math.round(value + (stops[lower + 1][channel] - value) * (place - lower)));
    return `rgb(${mixed.join(',')})`;
}

/**
 * One node's links, for showing it: what it builds on, then what builds on it.
 *
 * @param {number} nodeId
 * @param {{source: *, target: *, type: string, thread: string}[]} links
 * @param {Map<number, StoryWebNode>} nodeById
 * @returns {{earlier: {message: *, type: string, thread: string}[], later: {message: *, type: string, thread: string}[]}}
 */
export function linksOfNode(nodeId, links, nodeById) {
    const describe = (link, otherEnd) => ({ message: nodeById.get(linkEndId(otherEnd))?.message, type: link.type, thread: link.thread });
    return {
        earlier: links.filter(link => linkEndId(link.source) === nodeId).map(link => describe(link, link.target)),
        later: links.filter(link => linkEndId(link.target) === nodeId).map(link => describe(link, link.source)),
    };
}

/**
 * What a selected event shows: its line, then its links.
 *
 * @param {StoryWebNode} node
 * @param {{earlier: object[], later: object[]}} nodeLinks - From linksOfNode
 * @returns {string}
 */
export function selectedEventMarkup(node, { earlier, later }) {
    const linkLine = (link, icon) => ({ icon, name: `${link.type} #${link.message}${link.thread ? `: ${link.thread}` : ''}` });
    return recordCard({
        icon: 'fa-circle-dot',
        name: `#${node.message}`,
        body: resultList({ heading: { name: node.line }, lines: [...earlier.map(link => linkLine(link, 'fa-arrow-left')), ...later.map(link => linkLine(link, 'fa-arrow-right'))] }),
    });
}
