/**
 * ============================================================================
 * STORY WEB, DRAWN
 * ============================================================================
 * Draws the story web with the force-graph library, which lays it out and handles
 * zoom, pan and hover. Styled like a constellation: dots coloured by link count, and
 * links lit only for what is hovered or found. The library loads on first use.
 * Colours come from the stylesheet (story-arc-page.css).
 * ============================================================================
 */

import { escapeHtml } from '../../shared/html-escape.js';
import { colourAlong, linkEndId, linkedIdsByNode } from './story-arc-web-core.js';

const FORCE_GRAPH_URL = new URL('../../vendor/force-graph-1.52.0.min.js', import.meta.url).href;

const LAYOUT_WARMUP_TICKS = 60;
const LAYOUT_SETTLE_TICKS = 140;
const NODE_REPULSION = -14;
const LINK_LENGTH = 14;
const FIT_PADDING = 30;
const FIT_MS = 500;
const LABEL_LINE_CHARS = 140;

const LINK_ALPHA = { resting: 0.24, found: 0.75, lit: 0.95, dimmed: 0.03 };
const NODE_ALPHA = { lit: 0.95, dimmed: 0.07, halo: 0.16 };
const HALO_MIN_LINKS = 4;
const PARTICLES_ON_A_LIT_LINK = 2;

/** The drawn size in screen pixels, so a dot stays visible when zoomed out. */
const screenRadius = (node, scale) => (1 + Math.sqrt(node.linkCount) * 0.55) * Math.min(Math.max(scale, 0.8), 2);

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
 * @param {{onNodeClick: (node: object|null) => void}} callbacks - null when the background is clicked
 * @returns {Promise<{showFound: Function, clearFound: Function, setLines: Function, setPaused: Function, destroy: Function}>}
 */
export async function drawStoryWeb(container, web, { onNodeClick }) {
    const ForceGraph = await loadForceGraph();
    const style = getComputedStyle(container);
    const heatStops = ['few', 'some', 'more', 'many'].map(step => channelsOf(style, `--vfx-web-heat-${step}`));
    const linkChannels = {
        continues: style.getPropertyValue('--vfx-web-continues'),
        caused_by: style.getPropertyValue('--vfx-web-caused-by'),
        reveals: style.getPropertyValue('--vfx-web-reveals'),
    };
    const ringColour = `rgb(${style.getPropertyValue('--vfx-web-ring')})`;
    for (const node of web.nodes) node.colour = colourAlong(node.heat, heatStops);

    const linkedIds = linkedIdsByNode(web.links);
    let hoveredId = null;
    let selectedId = null;
    let reachedIds = null;
    let closestIds = new Set();

    const isFoundOnly = id => !reachedIds || reachedIds.has(id);
    const isNodeLit = (id) => {
        if (hoveredId !== null) return linkedIds.get(hoveredId)?.has(id) || id === hoveredId;
        return isFoundOnly(id);
    };
    const isLinkHovered = link => hoveredId !== null && (linkEndId(link.source) === hoveredId || linkEndId(link.target) === hoveredId);
    const isLinkFound = link => reachedIds !== null && reachedIds.has(linkEndId(link.source)) && reachedIds.has(linkEndId(link.target));
    const linkAlpha = (link) => {
        if (hoveredId !== null) return isLinkHovered(link) ? LINK_ALPHA.lit : LINK_ALPHA.dimmed;
        return reachedIds ? LINK_ALPHA.found : LINK_ALPHA.resting;
    };
    const isLinkLit = link => (hoveredId !== null ? isLinkHovered(link) : isLinkFound(link));

    const graph = new ForceGraph(container)
        .backgroundColor('rgba(0,0,0,0)')
        .width(container.clientWidth)
        .height(container.clientHeight)
        .warmupTicks(LAYOUT_WARMUP_TICKS)
        .cooldownTicks(LAYOUT_SETTLE_TICKS)
        .nodeLabel(node => `<b>#${escapeHtml(node.message)}</b> · ${node.linkCount} ${node.linkCount === 1 ? 'link' : 'links'}<br>${escapeHtml(node.line.slice(0, LABEL_LINE_CHARS))}`)
        .nodeVisibility(node => isFoundOnly(node.id))
        .linkVisibility(link => isFoundOnly(linkEndId(link.source)) && isFoundOnly(linkEndId(link.target)))
        .nodeCanvasObject((node, context, scale) => {
            const radius = screenRadius(node, scale) / scale;
            const isLit = isNodeLit(node.id);
            context.fillStyle = node.colour;
            if (isLit && node.linkCount >= HALO_MIN_LINKS) {
                context.globalAlpha = NODE_ALPHA.halo;
                context.beginPath();
                context.arc(node.x, node.y, radius * 2.1, 0, 2 * Math.PI);
                context.fill();
            }
            context.globalAlpha = isLit ? NODE_ALPHA.lit : NODE_ALPHA.dimmed;
            context.beginPath();
            context.arc(node.x, node.y, radius, 0, 2 * Math.PI);
            context.fill();
            context.globalAlpha = 1;
            if (closestIds.has(node.id) || node.id === selectedId) {
                context.strokeStyle = ringColour;
                context.lineWidth = 1.5 / scale;
                context.stroke();
            }
        })
        .nodePointerAreaPaint((node, colour, context, scale) => {
            context.fillStyle = colour;
            context.beginPath();
            context.arc(node.x, node.y, (screenRadius(node, scale) + 3) / scale, 0, 2 * Math.PI);
            context.fill();
        })
        .linkColor(link => `rgba(${linkChannels[link.type] ?? linkChannels.continues}, ${linkAlpha(link)})`)
        .linkWidth(link => (isLinkLit(link) ? 1.4 : 0.5))
        .linkDirectionalParticles(link => (isLinkLit(link) ? PARTICLES_ON_A_LIT_LINK : 0))
        .linkDirectionalParticleWidth(2.2)
        .linkDirectionalParticleSpeed(0.006)
        .onNodeHover((node) => {
            hoveredId = node?.id ?? null;
            refreshLit();
        })
        .onNodeClick((node) => {
            selectedId = node.id;
            onNodeClick(node);
        })
        .onBackgroundClick(() => {
            selectedId = null;
            onNodeClick(null);
        })
        .onEngineStop(() => {
            if (!reachedIds) graph.zoomToFit(FIT_MS, FIT_PADDING);
        });
    graph.d3Force('charge').strength(NODE_REPULSION);
    graph.d3Force('link').distance(LINK_LENGTH);
    graph.graphData(web);

    /** Lit links carry moving beads, which need the canvas to keep drawing. A resting web needs no redraw. */
    function refreshLit() {
        graph.autoPauseRedraw(hoveredId === null && reachedIds === null);
        graph.linkDirectionalParticles(graph.linkDirectionalParticles());
    }

    const resizeObserver = new ResizeObserver(() => graph.width(container.clientWidth).height(container.clientHeight));
    resizeObserver.observe(container);

    return {
        /** Show only what a search reached, and mark its closest events. */
        showFound({ closestHashes, reachedHashes }) {
            reachedIds = new Set(reachedHashes);
            closestIds = new Set(closestHashes);
            refreshLit();
            graph.zoomToFit(FIT_MS, FIT_PADDING, node => reachedIds.has(node.id));
        },
        clearFound() {
            reachedIds = null;
            closestIds = new Set();
            refreshLit();
            graph.zoomToFit(FIT_MS, FIT_PADDING);
        },
        /** New lines for the nodes, after a merge changes how events read. The layout stays. */
        setLines(lineById) {
            for (const node of web.nodes) node.line = lineById.get(node.id) ?? node.line;
        },
        setPaused(isPaused) {
            if (isPaused) graph.pauseAnimation();
            else graph.resumeAnimation();
        },
        destroy() {
            resizeObserver.disconnect();
            graph._destructor();
            container.replaceChildren();
        },
    };
}
