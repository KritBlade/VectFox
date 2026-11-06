/**
 * ============================================================================
 * STORY WEB, DRAWN
 * ============================================================================
 * Draws the story web with the force-graph library, which lays it out and handles
 * zoom and pan. The web floats. A pointer near a dot stops it and lights that dot, its
 * links with beads running from the earlier event to the later, and its connected dots.
 * Clicking a dot goes into a sub graph of that dot and its connected dots, where each
 * can be clicked in turn.
 *
 * All of that is drawn on the canvas. Nothing here may write an inline style as the
 * pointer moves: SillyTavern's stylesheets test the style attribute inside :has(), so
 * each such write costs a style pass over the whole page. For the same reason the
 * library's own tooltip is taken out of the page, as it restyles itself on every mouse
 * move even while hidden. The library loads on first use, and colours come from the
 * stylesheet (story-arc-page.css).
 * ============================================================================
 */

import { bowedLinkMiddle, colourAlong, doBoxesOverlap, dotShortLabel, dotText, hoverCardSpot, linkEndId, nearestNodeWithin, pointAlongBow, storySubWeb, wrapLabelLines } from './story-arc-web-core.js';

const FORCE_GRAPH_URL = new URL('../../vendor/force-graph-1.52.0.min.js', import.meta.url).href;

const WHOLE_WEB_VIEW = { warmupTicks: 60, settleTicks: 140, repulsion: -30, linkLength: 16, mostZoom: 12, fitPadding: 30, hoverReach: 24, dotScale: 1 };
const SUB_WEB_VIEW = { warmupTicks: 40, settleTicks: 60, repulsion: -700, linkLength: 90, mostZoom: 4, fitPadding: 90, hoverReach: 48, dotScale: 1.5 };
/** What pulls the layout towards its middle, stronger on the canvas's short side, so it fills a wide canvas and islands stay near. */
const LAYOUT_PULL = 0.02;
const LAYOUT_PULL_STRETCH = 1.6;
const FIT_MS = 500;

/** A redraw at most this often while floating, which keeps the graphics card quiet on a fast screen. */
const DRAW_EVERY_MS = 33;
const FLOAT_REACH_PX = 8;
const FLOAT_LONGEST_STEP_MS = 100;
const BEAD_LAPS_PER_SECOND = 0.45;
const BEAD_RADIUS_PX = 2.2;

const LINK_ALPHA = { resting: 0.3, found: 0.75, lit: 0.95, dimmed: 0.03 };
const LINK_WIDTH = { resting: 0.6, found: 1.4, dimmed: 0.5 };
const NODE_ALPHA = { dimmed: 0.08, halo: 0.14 };
const HALO_MIN_LINKS = 4;
const TWO_PI = 2 * Math.PI;

const CARD_WIDTH_PX = 320;
const CARD_PADDING_PX = 8;
const CARD_LINE_PX = 16;
const CARD_MAX_LINES = 6;
const CANVAS_MARGIN_PX = 8;
const LABEL_HEIGHT_PX = 16;
const LABEL_CHARACTERS = 18;

let forceGraphLoading = null;

/** The library, which puts itself on the page's global scope. */
function loadForceGraph() {
    forceGraphLoading ??= import(FORCE_GRAPH_URL).then(() => {
        if (typeof globalThis.ForceGraph !== 'function') throw new Error('The force-graph library did not load');
        return globalThis.ForceGraph;
    });
    return forceGraphLoading;
}

/** "96, 165, 250" from a stylesheet variable, as [96, 165, 250]. */
const channelsOf = (style, name) => style.getPropertyValue(name).split(',').map(Number);

/**
 * Draw a story web in a container.
 *
 * @param {HTMLElement} container
 * @param {{nodes: object[], links: object[]}} web - From buildStoryWeb. The library takes it over
 * @param {object} options
 * @param {(centre: object|null, shownNodes: object[]) => void} options.onViewChange - The sub graph's centre, or null for the whole web
 * @param {boolean} options.isFloating
 * @returns {Promise<{showFound: Function, clearFound: Function, goBack: Function, setLines: Function, setFloating: Function, setPaused: Function, destroy: Function}>}
 */
export async function drawStoryWeb(container, web, { onViewChange, isFloating: startsFloating }) {
    const ForceGraph = await loadForceGraph();
    const style = getComputedStyle(container);
    const heatStops = ['few', 'some', 'more', 'many'].map(step => channelsOf(style, `--vfx-web-heat-${step}`));
    const linkChannels = {
        continues: style.getPropertyValue('--vfx-web-continues'),
        caused_by: style.getPropertyValue('--vfx-web-caused-by'),
        reveals: style.getPropertyValue('--vfx-web-reveals'),
    };
    const ringColour = `rgb(${style.getPropertyValue('--vfx-web-ring')})`;
    const surfaceColour = style.getPropertyValue('--vfx-surface-solid').trim();
    const textColour = style.getPropertyValue('--vfx-text').trim();
    const bodyFont = `12px ${style.fontFamily}`;
    const headerFont = `600 12px ${style.fontFamily}`;
    const linkColourFor = alpha => Object.fromEntries(Object.entries(linkChannels).map(([type, channels]) => [type, `rgba(${channels}, ${alpha})`]));
    const linkColours = { resting: linkColourFor(LINK_ALPHA.resting), found: linkColourFor(LINK_ALPHA.found), dimmed: linkColourFor(LINK_ALPHA.dimmed) };
    for (const node of web.nodes) {
        node.colour = colourAlong(node.heat, heatStops);
        node.phase = Math.random() * TWO_PI;
    }
    const nodeById = new Map(web.nodes.map(node => [node.id, node]));

    let view = WHOLE_WEB_VIEW;
    let shownWeb = web;
    let centreId = null;
    const subWebTrail = [];
    let isSettled = false;
    let isFloating = startsFloating;
    let floatSeconds = 0;
    let lastFloatAt = performance.now();
    let lastDrawAt = 0;
    let framesToDraw = 0;
    let frameRequest = null;
    let pointerSpot = null;
    let pressedNode = null;
    let hoveredNode = null;
    let hoveredLinks = [];
    let hoverCard = null;
    let reachedIds = null;
    let foundLinks = [];
    let closestIds = new Set();
    let linkState = 'resting';

    const isShown = id => centreId !== null || reachedIds === null || reachedIds.has(id);
    const dotRadius = (node, scale) => {
        const pulse = 1 + 0.13 * Math.sin(floatSeconds * 1.05 + node.phase);
        return (2 + Math.sqrt(node.linkCount) * 0.7) * Math.min(Math.max(scale, 0.8), 2) * pulse * view.dotScale;
    };

    const graph = new ForceGraph(container)
        .backgroundColor('rgba(0,0,0,0)')
        .width(container.clientWidth)
        .height(container.clientHeight)
        .enablePointerInteraction(false)
        .enableNodeDrag(false)
        .nodeVisibility(node => isShown(node.id))
        .linkVisibility(link => isShown(linkEndId(link.source)) && isShown(linkEndId(link.target)))
        .nodeCanvasObject((node, context, scale) => {
            const radius = dotRadius(node, scale) / scale;
            context.fillStyle = node.colour;
            if (hoveredNode === null && node.linkCount >= HALO_MIN_LINKS) {
                context.globalAlpha = NODE_ALPHA.halo;
                context.beginPath();
                context.arc(node.x, node.y, radius * 2.1, 0, TWO_PI);
                context.fill();
            }
            const twinkle = 0.82 + 0.18 * Math.sin(floatSeconds * 1.4 + node.phase * 2.1);
            context.globalAlpha = hoveredNode !== null ? NODE_ALPHA.dimmed : Math.min(1, 0.55 + node.linkCount * 0.05) * twinkle;
            context.beginPath();
            context.arc(node.x, node.y, radius, 0, TWO_PI);
            context.fill();
            context.globalAlpha = 1;
            if (node.id === centreId || (centreId === null && closestIds.has(node.id))) {
                context.strokeStyle = ringColour;
                context.lineWidth = 1.5 / scale;
                context.stroke();
            }
        })
        .linkColor(link => linkColours[linkState][link.type] ?? linkColours[linkState].continues)
        .linkWidth(() => LINK_WIDTH[linkState])
        .onBackgroundClick(() => {
            if (pressedNode !== null && pressedNode.id !== centreId) {
                if (centreId !== null) subWebTrail.push(centreId);
                showSubWeb(pressedNode.id);
            }
        })
        .onEngineStop(() => {
            for (const node of shownWeb.nodes) {
                if (node.homeX === undefined) {
                    node.homeX = node.x;
                    node.homeY = node.y;
                }
            }
            isSettled = true;
            fitView();
        })
        .onRenderFramePre((context, scale) => prepareFrame(scale))
        .onRenderFramePost((context, scale) => {
            context.save();
            context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
            context.textAlign = 'left';
            context.textBaseline = 'alphabetic';
            if (hoveredNode !== null) drawHover(context, scale);
            else if (centreId !== null) drawSubWeb(context, scale);
            else if (reachedIds !== null) drawBeads(context, foundLinks);
            context.restore();
        });
    container.querySelector('.float-tooltip-kap')?.remove();
    const canvas = container.querySelector('canvas');

    graph.d3Force('shape', (alpha) => {
        const { clientWidth: width, clientHeight: height } = container;
        const pullX = LAYOUT_PULL * Math.max(1, height / Math.max(width, 1)) ** LAYOUT_PULL_STRETCH;
        const pullY = LAYOUT_PULL * Math.max(1, width / Math.max(height, 1)) ** LAYOUT_PULL_STRETCH;
        for (const node of shownWeb.nodes) {
            node.vx -= node.x * pullX * alpha;
            node.vy -= node.y * pullY * alpha;
        }
    });
    applyView(WHOLE_WEB_VIEW);
    graph.graphData(web);

    function applyView(nextView) {
        view = nextView;
        graph.d3Force('charge').strength(nextView.repulsion);
        graph.d3Force('link').distance(nextView.linkLength);
        graph.maxZoom(nextView.mostZoom).warmupTicks(nextView.warmupTicks).cooldownTicks(nextView.settleTicks);
    }

    function fitView() {
        const isFitToFound = centreId === null && reachedIds !== null;
        graph.zoomToFit(FIT_MS, view.fitPadding, isFitToFound ? node => reachedIds.has(node.id) : undefined);
    }

    function tellView() {
        onViewChange(centreId === null ? null : nodeById.get(centreId), shownWeb.nodes);
    }

    function showSubWeb(id) {
        centreId = id;
        shownWeb = storySubWeb(web, id);
        applyView(SUB_WEB_VIEW);
        setHoveredNode(null);
        isSettled = false;
        graph.graphData(shownWeb);
        tellView();
    }

    /** Back to the whole web, where it stood: no new layout. */
    function showWholeWeb() {
        subWebTrail.length = 0;
        if (centreId === null) return;
        centreId = null;
        shownWeb = web;
        applyView({ ...WHOLE_WEB_VIEW, warmupTicks: 0, settleTicks: 0 });
        setHoveredNode(null);
        isSettled = false;
        graph.graphData(web);
        tellView();
    }

    /** Asks for a redraw now, for a change the floating's timing should not delay. */
    function drawSoon() {
        framesToDraw = 2;
        graph.autoPauseRedraw(false);
    }

    function onFrame(now) {
        frameRequest = requestAnimationFrame(onFrame);
        const isDue = isFloating && now - lastDrawAt >= DRAW_EVERY_MS;
        if (isDue) lastDrawAt = now;
        if (framesToDraw > 0) framesToDraw -= 1;
        graph.autoPauseRedraw(!isDue && framesToDraw === 0);
    }

    function setHoveredNode(node) {
        if (node === hoveredNode) return;
        hoveredNode = node;
        hoverCard = null;
        hoveredLinks = node === null ? [] : shownWeb.links.filter(link => linkEndId(link.source) === node.id || linkEndId(link.target) === node.id);
        container.classList.toggle('is-over-dot', node !== null);
        drawSoon();
    }

    function refreshHover() {
        if (pointerSpot === null) {
            setHoveredNode(null);
            return;
        }
        const { x, y } = graph.screen2GraphCoords(pointerSpot.x, pointerSpot.y);
        setHoveredNode(nearestNodeWithin(shownWeb.nodes, x, y, view.hoverReach / graph.zoom(), isShown));
    }

    /** Moves the dots, unless the pointer has stopped them, then settles what this frame lights. */
    function prepareFrame(scale) {
        const now = performance.now();
        if (isFloating && isSettled && hoveredNode === null) {
            floatSeconds += Math.min(now - lastFloatAt, FLOAT_LONGEST_STEP_MS) / 1000;
            const reach = FLOAT_REACH_PX / scale;
            for (const node of shownWeb.nodes) {
                node.x = node.homeX + reach * Math.sin(floatSeconds * 0.6 + node.phase);
                node.y = node.homeY + reach * Math.cos(floatSeconds * 0.5 + node.phase * 1.3);
            }
        }
        lastFloatAt = now;
        refreshHover();
        if (hoveredNode !== null) linkState = 'dimmed';
        else linkState = centreId !== null || reachedIds !== null ? 'found' : 'resting';
    }

    const spotOf = node => graph.graph2ScreenCoords(node.x, node.y);
    const channelsOfLink = link => linkChannels[link.type] ?? linkChannels.continues;
    const beadShare = (index, count) => (performance.now() / 1000 * BEAD_LAPS_PER_SECOND + index / Math.max(count, 13)) % 1;

    function drawBead(context, spot, channels, share) {
        context.globalAlpha = 0.4 + 0.6 * Math.sin(share * Math.PI);
        context.fillStyle = `rgb(${channels})`;
        context.shadowColor = `rgb(${channels})`;
        context.shadowBlur = 6;
        context.beginPath();
        context.arc(spot.x, spot.y, BEAD_RADIUS_PX, 0, TWO_PI);
        context.fill();
        context.shadowBlur = 0;
        context.globalAlpha = 1;
    }

    /** A bead on each link, from its earlier event to its later. */
    function drawBeads(context, links) {
        links.forEach((link, index) => {
            const earlier = spotOf(link.target);
            const later = spotOf(link.source);
            const share = beadShare(index, links.length);
            drawBead(context, { x: earlier.x + (later.x - earlier.x) * share, y: earlier.y + (later.y - earlier.y) * share }, channelsOfLink(link), share);
        });
    }

    function drawLitDot(context, node, scale, glow) {
        const spot = spotOf(node);
        const radius = dotRadius(node, scale) * (node === hoveredNode ? 2 : 1.6);
        context.fillStyle = node.colour;
        context.shadowColor = node.colour;
        context.shadowBlur = glow;
        context.beginPath();
        context.arc(spot.x, spot.y, radius, 0, TWO_PI);
        context.fill();
        context.shadowBlur = 0;
        if (node.id === centreId) {
            context.strokeStyle = ringColour;
            context.lineWidth = 1.5;
            context.stroke();
        }
        return { spot, radius };
    }

    /** A dot's short label beside it, unless it would cover something already drawn. */
    function drawDotLabel(context, node, { spot, radius }, takenBoxes) {
        const text = dotShortLabel(node, LABEL_CHARACTERS);
        context.font = bodyFont;
        const width = context.measureText(text).width + 8;
        const fitsRight = spot.x + radius + 4 + width <= graph.width();
        const left = fitsRight ? spot.x + radius + 4 : spot.x - radius - 4 - width;
        const box = { left, top: spot.y - LABEL_HEIGHT_PX / 2, right: left + width, bottom: spot.y + LABEL_HEIGHT_PX / 2 };
        if (takenBoxes.some(taken => doBoxesOverlap(taken, box))) return;
        takenBoxes.push(box);
        context.globalAlpha = 0.8;
        context.fillStyle = surfaceColour;
        context.fillRect(box.left, box.top, width, LABEL_HEIGHT_PX);
        context.globalAlpha = 1;
        context.fillStyle = textColour;
        context.fillText(text, left + 4, spot.y + 4);
    }

    function hoverCardOf(context) {
        if (hoverCard !== null) return hoverCard;
        const header = `#${hoveredNode.message} · ${hoveredNode.linkCount} ${hoveredNode.linkCount === 1 ? 'link' : 'links'}`;
        const textWidth = Math.min(CARD_WIDTH_PX, graph.width() - 2 * CANVAS_MARGIN_PX) - 2 * CARD_PADDING_PX;
        context.font = bodyFont;
        const lines = wrapLabelLines(dotText(hoveredNode), textWidth, text => context.measureText(text).width, CARD_MAX_LINES);
        const widest = Math.max(...lines.map(line => context.measureText(line).width));
        context.font = headerFont;
        hoverCard = {
            header,
            lines,
            width: Math.max(widest, context.measureText(header).width) + 2 * CARD_PADDING_PX,
            height: (lines.length + 1) * CARD_LINE_PX + 2 * CARD_PADDING_PX,
        };
        return hoverCard;
    }

    function drawHoverCard(context, card, { left, top }) {
        context.fillStyle = surfaceColour;
        context.strokeStyle = hoveredNode.colour;
        context.lineWidth = 1.5;
        context.beginPath();
        context.roundRect(left, top, card.width, card.height, 6);
        context.fill();
        context.stroke();
        context.fillStyle = textColour;
        context.font = headerFont;
        context.fillText(card.header, left + CARD_PADDING_PX, top + CARD_PADDING_PX + 12);
        context.font = bodyFont;
        card.lines.forEach((line, index) => context.fillText(line, left + CARD_PADDING_PX, top + CARD_PADDING_PX + 12 + (index + 1) * CARD_LINE_PX));
    }

    function drawHover(context, scale) {
        hoveredLinks.forEach((link, index) => {
            const earlier = spotOf(link.target);
            const later = spotOf(link.source);
            const middle = bowedLinkMiddle(earlier, later);
            const channels = channelsOfLink(link);
            context.strokeStyle = `rgba(${channels}, ${LINK_ALPHA.lit})`;
            context.lineWidth = 1.5;
            context.beginPath();
            context.moveTo(earlier.x, earlier.y);
            context.quadraticCurveTo(middle.x, middle.y, later.x, later.y);
            context.stroke();
            const share = beadShare(index, hoveredLinks.length);
            drawBead(context, pointAlongBow(earlier, middle, later, share), channels, share);
        });
        const connected = new Set(hoveredLinks.map(link => (linkEndId(link.source) === hoveredNode.id ? link.target : link.source)));
        const connectedDots = [...connected].map(node => [node, drawLitDot(context, node, scale, 10)]);
        const hoveredDot = drawLitDot(context, hoveredNode, scale, 20);
        const card = hoverCardOf(context);
        const { left, top } = hoverCardSpot({ x: hoveredDot.spot.x, y: hoveredDot.spot.y, clearance: hoveredDot.radius + 8, width: card.width, height: card.height, canvasWidth: graph.width(), canvasHeight: graph.height(), margin: CANVAS_MARGIN_PX, spotsToLeaveInView: connectedDots.map(([, dot]) => dot.spot) });
        const takenBoxes = [{ left, top, right: left + card.width, bottom: top + card.height }];
        for (const [node, dot] of connectedDots) drawDotLabel(context, node, dot, takenBoxes);
        drawHoverCard(context, card, { left, top });
    }

    /** A sub graph at rest: beads on every link, and every dot labelled. */
    function drawSubWeb(context, scale) {
        drawBeads(context, shownWeb.links);
        const takenBoxes = [];
        const centre = shownWeb.nodes.find(node => node.id === centreId);
        const inLabelOrder = [centre, ...shownWeb.nodes.filter(node => node !== centre)];
        for (const node of inLabelOrder) drawDotLabel(context, node, { spot: spotOf(node), radius: dotRadius(node, scale) }, takenBoxes);
    }

    const pointerSpotOf = (event) => {
        const box = canvas.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const onPointerMove = (event) => {
        pointerSpot = event.buttons ? null : pointerSpotOf(event);
        refreshHover();
    };
    const onPointerDown = (event) => {
        pointerSpot = pointerSpotOf(event);
        refreshHover();
        pressedNode = hoveredNode;
    };
    const onPointerLeave = () => {
        pointerSpot = null;
        refreshHover();
    };
    container.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('pointerdown', onPointerDown, { passive: true });
    container.addEventListener('pointerleave', onPointerLeave, { passive: true });

    const resizeObserver = new ResizeObserver(() => graph.width(container.clientWidth).height(container.clientHeight));
    resizeObserver.observe(container);
    frameRequest = requestAnimationFrame(onFrame);

    return {
        /** Show only what a search reached, and mark its closest events. */
        showFound({ closestHashes, reachedHashes }) {
            showWholeWeb();
            reachedIds = new Set(reachedHashes);
            closestIds = new Set(closestHashes);
            foundLinks = web.links.filter(link => reachedIds.has(linkEndId(link.source)) && reachedIds.has(linkEndId(link.target)));
            drawSoon();
            fitView();
        },
        clearFound() {
            showWholeWeb();
            reachedIds = null;
            closestIds = new Set();
            foundLinks = [];
            drawSoon();
            fitView();
        },
        /** One step back through the sub graphs, then to the whole web. */
        goBack() {
            const previousId = subWebTrail.pop();
            if (previousId === undefined) showWholeWeb();
            else showSubWeb(previousId);
        },
        /** New lines for the nodes, after a merge changes how events read. The layout stays. */
        setLines(lineById) {
            for (const node of [...web.nodes, ...(centreId === null ? [] : shownWeb.nodes)]) node.line = lineById.get(node.id) ?? node.line;
            hoverCard = null;
        },
        /** Floating costs a redraw about 30 times a second, which a pause stops. */
        setFloating(shouldFloat) {
            isFloating = shouldFloat;
            drawSoon();
        },
        setPaused(isPaused) {
            if (isPaused) {
                graph.pauseAnimation();
                cancelAnimationFrame(frameRequest);
                frameRequest = null;
                return;
            }
            graph.resumeAnimation();
            lastFloatAt = performance.now();
            frameRequest ??= requestAnimationFrame(onFrame);
        },
        destroy() {
            cancelAnimationFrame(frameRequest);
            container.removeEventListener('pointermove', onPointerMove);
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('pointerleave', onPointerLeave);
            resizeObserver.disconnect();
            graph._destructor();
            container.replaceChildren();
            container.classList.remove('is-over-dot');
        },
    };
}
