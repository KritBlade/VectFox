/**
 * ============================================================================
 * STORY WEB
 * ============================================================================
 * The story's events and links as a graph to draw: one node per event, one link
 * per stored story link, pointing from the later event to the earlier one, and the
 * sums the drawing needs, the web's lights among them: which links carry a spark
 * and which dots flare, and when. Pure: no host imports, and no drawing, only the
 * markup of a selected event.
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
 * @property {string} [colour] - Added when drawn
 * @property {number} [phase] - Added when drawn: where it starts in its floating
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
 * The node nearest a spot, within a reach, which is the dot a pointer means.
 *
 * @param {{id: number, x?: number, y?: number}[]} nodes - One not yet placed has no x
 * @param {number} x
 * @param {number} y
 * @param {number} reach - In the same units as x and y
 * @param {(id: number) => boolean} isAllowed
 * @returns {object|null}
 */
export function nearestNodeWithin(nodes, x, y, reach, isAllowed) {
    let nearest = null;
    let nearestSquared = reach * reach;
    for (const node of nodes) {
        if (node.x === undefined || !isAllowed(node.id)) continue;
        const squared = (node.x - x) ** 2 + (node.y - y) ** 2;
        if (squared <= nearestSquared) {
            nearest = node;
            nearestSquared = squared;
        }
    }
    return nearest;
}

/**
 * One node and the nodes it links to, as a web of their own, with the links among them.
 * The nodes are new and unplaced, so the whole web keeps its layout, and the centre is
 * pinned in the middle.
 *
 * @param {{nodes: StoryWebNode[], links: {source: *, target: *, type: string, thread: string}[]}} web
 * @param {number} centreId
 * @returns {{nodes: object[], links: {source: number, target: number, type: string, thread: string}[]}}
 */
export function storySubWeb(web, centreId) {
    const ids = new Set([centreId]);
    for (const { source, target } of web.links) {
        if (linkEndId(source) === centreId) ids.add(linkEndId(target));
        if (linkEndId(target) === centreId) ids.add(linkEndId(source));
    }
    return {
        nodes: web.nodes.filter(node => ids.has(node.id)).map(({ id, message, linkCount, heat, line, colour, phase }) => ({
            id, message, linkCount, heat, line, colour, phase, ...(id === centreId ? { fx: 0, fy: 0 } : {}),
        })),
        links: web.links
            .filter(({ source, target }) => ids.has(linkEndId(source)) && ids.has(linkEndId(target)))
            .map(({ source, target, type, thread }) => ({ source: linkEndId(source), target: linkEndId(target), type, thread })),
    };
}

/** What a node's event says, without its line's number. */
export function dotText(node) {
    return node.line.replace(/^- #[^:]*:\s*/, '');
}

/** A node's number and the start of what it says. */
export function dotShortLabel(node, characterCount) {
    const characters = Array.from(dotText(node));
    return `#${node.message} ${characters.slice(0, characterCount).join('')}${characters.length > characterCount ? '…' : ''}`;
}

/**
 * Text broken into lines no wider than a width. A word with spaces around it stays
 * whole, and text with no spaces, such as Chinese, breaks anywhere. What does not fit
 * in the last line ends in an ellipsis.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {(text: string) => number} widthOf
 * @param {number} maxLines
 * @returns {string[]}
 */
export function wrapLabelLines(text, maxWidth, widthOf, maxLines) {
    const lines = [];
    let rest = Array.from(text.trim());
    while (rest.length > 0 && lines.length < maxLines) {
        let count = 1;
        while (count < rest.length && widthOf(rest.slice(0, count + 1).join('')) <= maxWidth) count += 1;
        if (count < rest.length) {
            const lastSpace = rest.slice(0, count + 1).lastIndexOf(' ');
            if (lastSpace > 0) count = lastSpace + 1;
        }
        lines.push(rest.slice(0, count).join('').trimEnd());
        rest = rest.slice(count);
    }
    if (rest.length > 0) {
        let lastLine = Array.from(lines[lines.length - 1]);
        while (lastLine.length > 1 && widthOf(`${lastLine.join('')}…`) > maxWidth) lastLine = lastLine.slice(0, -1);
        lines[lines.length - 1] = `${lastLine.join('')}…`;
    }
    return lines;
}

/**
 * Where a card goes for a dot at a spot: the side that covers the fewest of the dots it
 * should leave in view, trying under, over, right and left in that order, and always
 * inside the canvas.
 *
 * @param {{x: number, y: number, clearance: number, width: number, height: number, canvasWidth: number, canvasHeight: number, margin: number, spotsToLeaveInView: {x: number, y: number}[]}} placement
 * @returns {{left: number, top: number}}
 */
export function hoverCardSpot({ x, y, clearance, width, height, canvasWidth, canvasHeight, margin, spotsToLeaveInView }) {
    const insideCanvas = (left, top) => ({
        left: Math.max(Math.min(left, canvasWidth - width - margin), margin),
        top: Math.max(Math.min(top, canvasHeight - height - margin), margin),
    });
    const sides = [
        insideCanvas(x - width / 2, y + clearance),
        insideCanvas(x - width / 2, y - clearance - height),
        insideCanvas(x + clearance, y - height / 2),
        insideCanvas(x - clearance - width, y - height / 2),
    ];
    const coveredBy = ({ left, top }) => [{ x, y }, ...spotsToLeaveInView].filter(spot => spot.x >= left && spot.x <= left + width && spot.y >= top && spot.y <= top + height).length;
    return sides.reduce((best, side) => (coveredBy(side) < coveredBy(best) ? side : best));
}

/** Whether two boxes share any space. */
export function doBoxesOverlap(first, second) {
    return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
}

/** The control point that bows a link a little to one side. */
export function bowedLinkMiddle(from, to) {
    return { x: (from.x + to.x) / 2 + (to.y - from.y) * 0.08, y: (from.y + to.y) / 2 - (to.x - from.x) * 0.08 };
}

/**
 * A point along a bowed link.
 *
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} middle - From bowedLinkMiddle
 * @param {{x: number, y: number}} to
 * @param {number} share - 0 at from, 1 at to
 * @returns {{x: number, y: number}}
 */
export function pointAlongBow(from, middle, to, share) {
    const rest = 1 - share;
    return {
        x: rest * rest * from.x + 2 * rest * share * middle.x + share * share * to.x,
        y: rest * rest * from.y + 2 * rest * share * middle.y + share * share * to.y,
    };
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
 * How the web's lights behave. A spark runs along a link from its earlier event to its later, and may go on along a
 * link from the event it reaches. A flare swells a dot and makes it glow, then fades. Few light at once, so most
 * links and dots stay quiet, and a free place waits a random rest before it lights again.
 */
const LIGHTS = {
    linksPerSpark: 80,
    mostSparks: 6,
    sparkRestSeconds: 1.5,
    sparkGoesOnChance: 0.55,
    mostLinksPerSpark: 4,
    nodesPerFlare: 120,
    mostFlares: 4,
    flareRestSeconds: 1.2,
    flareSeconds: { low: 2.4, high: 3.6 },
    flarePeak: { low: 2.2, high: 3.2 },
    flareRiseShare: 0.3,
    pickTries: 3,
};

/** @typedef {{link: object, age: number, duration: number, linksRun: number}} Spark */
/** @typedef {{node: object, age: number, duration: number, peak: number}} Flare */
/** @typedef {{sparks: Spark[], flares: Flare[]}} WebLights */

/** @type {WebLights} */
export const NO_LIGHTS = Object.freeze({ sparks: Object.freeze([]), flares: Object.freeze([]) });

/**
 * What the web's lights do in a frame: they run in the whole web at rest while it floats, hold still while a pointer
 * stops the web or its layout still moves, and go out in a sub graph, on a search's events, and in a paused web.
 *
 * @param {{isFloating: boolean, isSettled: boolean, isPointedAt: boolean, isWholeWeb: boolean, isShowingFound: boolean}} web
 * @returns {'run'|'hold'|'off'}
 */
export function lightsModeOf({ isFloating, isSettled, isPointedAt, isWholeWeb, isShowingFound }) {
    if (!isFloating || !isWholeWeb || isShowingFound) return 'off';
    return isSettled && !isPointedAt ? 'run' : 'hold';
}

/**
 * How many sparks and flares may light at once among some dots and links: one of each when there are few, and a few
 * at most when there are many.
 *
 * @param {number} nodeCount
 * @param {number} linkCount
 * @returns {{sparks: number, flares: number}}
 */
export function lightCounts(nodeCount, linkCount) {
    const countFor = (itemCount, itemsPerLight, most) => (itemCount === 0 ? 0 : Math.min(most, Math.max(1, Math.round(itemCount / itemsPerLight))));
    return {
        sparks: countFor(linkCount, LIGHTS.linksPerSpark, LIGHTS.mostSparks),
        flares: countFor(nodeCount, LIGHTS.nodesPerFlare, LIGHTS.mostFlares),
    };
}

/** A random item not lit already, or null when a few tries find none. */
function pickUnlit(items, litItems, random) {
    if (items.length === 0) return null;
    for (let tries = 0; tries < LIGHTS.pickTries; tries += 1) {
        const item = items[Math.min(items.length - 1, Math.floor(random() * items.length))];
        if (!litItems.has(item)) return item;
    }
    return null;
}

const between = ({ low, high }, random) => low + (high - low) * random();

/** The chance a free place lights within some seconds, when it lights on average after a rest. */
const lightChance = (seconds, restSeconds) => 1 - Math.exp(-seconds / restSeconds);

/**
 * The web's lights some seconds on. Finished flares end. A spark that reaches its later event may go on along a link
 * from that event to a later one, up to a few links, and otherwise ends. Free places then light at random, each on a
 * link or dot not lit already.
 *
 * @param {WebLights} lights
 * @param {object} step
 * @param {number} step.seconds - Since the last step
 * @param {object[]} step.nodes - The dots a flare may take
 * @param {object[]} step.links - The links a spark may take
 * @param {(link: object) => number} step.sparkSeconds - How long a spark takes along a link
 * @param {() => number} step.random - From 0 up to 1
 * @returns {WebLights} New lights: the ones given are left as they were
 */
export function advanceLights(lights, { seconds, nodes, links, sparkSeconds, random }) {
    const counts = lightCounts(nodes.length, links.length);
    const litLinks = new Set(lights.sparks.map(spark => spark.link));
    const sparks = [];
    for (const spark of lights.sparks) {
        const age = spark.age + seconds;
        if (age < spark.duration) {
            sparks.push({ ...spark, age });
            continue;
        }
        if (spark.linksRun >= LIGHTS.mostLinksPerSpark || random() >= LIGHTS.sparkGoesOnChance) continue;
        const reachedId = linkEndId(spark.link.source);
        const link = pickUnlit(links.filter(onward => linkEndId(onward.target) === reachedId), litLinks, random);
        if (link === null) continue;
        litLinks.add(link);
        sparks.push({ link, age: age - spark.duration, duration: sparkSeconds(link), linksRun: spark.linksRun + 1 });
    }
    for (let place = sparks.length; place < counts.sparks; place += 1) {
        if (random() >= lightChance(seconds, LIGHTS.sparkRestSeconds)) continue;
        const link = pickUnlit(links, litLinks, random);
        if (link === null) continue;
        litLinks.add(link);
        sparks.push({ link, age: 0, duration: sparkSeconds(link), linksRun: 1 });
    }

    const flares = lights.flares.map(flare => ({ ...flare, age: flare.age + seconds })).filter(flare => flare.age < flare.duration);
    const litNodes = new Set(flares.map(flare => flare.node));
    for (let place = flares.length; place < counts.flares; place += 1) {
        if (random() >= lightChance(seconds, LIGHTS.flareRestSeconds)) continue;
        const node = pickUnlit(nodes, litNodes, random);
        if (node === null) continue;
        litNodes.add(node);
        flares.push({ node, age: 0, duration: between(LIGHTS.flareSeconds, random), peak: between(LIGHTS.flarePeak, random) });
    }
    return { sparks, flares };
}

/** 0 to 1, easing in and out. */
const easeInOut = share => share * share * (3 - 2 * share);

/**
 * How far a flare has swollen: 0 as it starts, full through its middle, and 0 again as it ends, easing into each.
 *
 * @param {Flare} flare
 * @returns {number}
 */
export function flareSwell(flare) {
    const share = Math.min(Math.max(flare.age / flare.duration, 0), 1);
    const risen = Math.min(share / LIGHTS.flareRiseShare, 1);
    const fallen = Math.min((1 - share) / LIGHTS.flareRiseShare, 1);
    return easeInOut(Math.min(risen, fallen));
}

/**
 * A spark's head and the end of its tail on a straight link, at a share of its run from the earlier event to the
 * later. The tail trails the head and starts no further back than the earlier event.
 *
 * @param {{x: number, y: number}} earlier
 * @param {{x: number, y: number}} later
 * @param {number} share - 0 at the earlier event, 1 at the later
 * @param {number} tailLength - In the same units as the spots
 * @returns {{head: {x: number, y: number}, tail: {x: number, y: number}}}
 */
export function sparkTrail(earlier, later, share, tailLength) {
    const length = Math.hypot(later.x - earlier.x, later.y - earlier.y);
    const tailShare = length === 0 ? share : Math.max(0, share - tailLength / length);
    const spotAt = place => ({ x: earlier.x + (later.x - earlier.x) * place, y: earlier.y + (later.y - earlier.y) * place });
    return { head: spotAt(share), tail: spotAt(tailShare) };
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
