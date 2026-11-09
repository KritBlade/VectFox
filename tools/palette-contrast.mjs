// tools/palette-contrast.mjs — the palette's contrast, measured where each text and control colour reads worst.
//
//   node tools/palette-contrast.mjs
//
// The panel is glass (devdoc/gui-dna.md §3, Glass): cards, rows, fields and a notice are see-through panes over the
// canvas, and the canvas carries coloured light that stays put while the page scrolls under it. A surface therefore has
// no one colour: it is the canvas under it, then its own layers. This composites each surface over every canvas point it
// can sit on, at every stop of its own gradients, and reports the lowest WCAG ratio of each colour that sits on it.
// tests/palette-contrast.test.js holds every pair to its floor (§3, Contrast): 4.5:1 for text, 3:1 for a control, an
// icon and the focus ring.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PALETTE_CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared', 'gui-dna', 'palette.css');

const THEME_SELECTORS = { dark: '.vfx-ui', light: 'html[data-vfx-theme="light"] .vfx-ui' };
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
const TEXT = 4.5;
const GRAPHIC = 3;

/** Each theme's roles, `var()` resolved: { dark, light }, each a Map from the name after `--vfx-` to its value. */
export function paletteThemes(cssText) {
    const blocks = new Map();
    for (const match of cssText.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^{}\s][^{}]*?)\s*\{([^{}]*)\}/gm)) {
        blocks.set(match[1].trim(), match[2]);
    }
    const themes = {};
    for (const [theme, selector] of Object.entries(THEME_SELECTORS)) {
        const raw = new Map([...(blocks.get(selector) || '').matchAll(/--vfx-([\w-]+)\s*:\s*([^;]+);/g)]
            .map((match) => [match[1], match[2].trim()]));
        const resolve = (value, depth) => value.replace(/var\(--vfx-([\w-]+)\)/g, (_, role) => {
            if (depth > 8 || !raw.has(role)) throw new Error(`palette-contrast: the ${theme} theme's var(--vfx-${role}) names no role`);
            return resolve(raw.get(role), depth + 1);
        });
        themes[theme] = new Map([...raw].map(([role, value]) => [role, resolve(value, 0)]));
    }
    return themes;
}

/** A colour as { r, g, b } 0–255 and a 0–1: a hex, an rgb() in either syntax, or `transparent`. */
function parseColour(text) {
    const value = text.trim();
    if (value === 'transparent') return TRANSPARENT;
    const hex = value.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        const digits = hex[1].length <= 4 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
        const channel = (at) => parseInt(digits.slice(at, at + 2), 16);
        return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) / 255 : 1 };
    }
    const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/);
    if (rgb) {
        const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1);
        return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
    }
    throw new Error(`palette-contrast: not a colour: ${text}`);
}

/** The comma-separated parts of a value, commas inside parentheses kept. */
function topLevelParts(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')') depth -= 1;
        else if (text[index] === ',' && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

function parseStops(parts) {
    const stops = parts.map((part) => {
        const positioned = part.match(/^(.*?)\s+(-?[\d.]+)%$/);
        return positioned ? { colour: parseColour(positioned[1]), at: Number(positioned[2]) / 100 } : { colour: parseColour(part), at: null };
    });
    // A stop written without a position: the first at 0, the last at 1, the rest spread evenly between.
    stops.forEach((stop, index) => {
        if (stop.at === null) stop.at = stops.length === 1 ? 0 : index / (stops.length - 1);
    });
    return stops;
}

/** One background layer: a colour, a linear gradient (an angle in deg first) or a radial one (`<w>% <h>% at <x>% <y>%`). */
function parseLayer(text) {
    const gradient = text.match(/^(linear|radial)-gradient\(([\s\S]*)\)$/);
    if (!gradient) return { kind: 'colour', colour: parseColour(text) };
    const [head, ...stops] = topLevelParts(gradient[2]);
    if (gradient[1] === 'linear') {
        const angle = head.match(/^(-?[\d.]+)deg$/);
        if (!angle) throw new Error(`palette-contrast: a linear gradient starts with its angle in deg: ${text}`);
        return { kind: 'linear', angle: Number(angle[1]), stops: parseStops(stops) };
    }
    const shape = head.match(/^([\d.]+)%\s+([\d.]+)%\s+at\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
    if (!shape) throw new Error(`palette-contrast: a radial gradient starts with "<w>% <h>% at <x>% <y>%": ${text}`);
    const [width, height, x, y] = shape.slice(1).map((number) => Number(number) / 100);
    return { kind: 'radial', width, height, x, y, stops: parseStops(stops) };
}

const layersOf = (value) => (value === 'none' ? [] : topLevelParts(value).map(parseLayer));

/** A gradient's colour at t, interpolated with premultiplied alpha, as a browser does. */
function colourAt(stops, t) {
    if (t <= stops[0].at) return stops[0].colour;
    for (let index = 1; index < stops.length; index += 1) {
        const [from, to] = [stops[index - 1], stops[index]];
        if (t > to.at) continue;
        const share = to.at === from.at ? 1 : (t - from.at) / (to.at - from.at);
        const alpha = from.colour.a * (1 - share) + to.colour.a * share;
        if (alpha === 0) return TRANSPARENT;
        const channel = (key) => (from.colour[key] * from.colour.a * (1 - share) + to.colour[key] * to.colour.a * share) / alpha;
        return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
    }
    return stops[stops.length - 1].colour;
}

/** A layer's colour at (u, v), fractions of a pane: a radial gradient by its ellipse, a linear one along its line. */
function layerColourAt(layer, u, v, pane) {
    if (layer.kind === 'colour') return layer.colour;
    if (layer.kind === 'radial') return colourAt(layer.stops, Math.hypot((u - layer.x) / layer.width, (v - layer.y) / layer.height));
    // CSS angles point up at 0deg and turn clockwise; the gradient line runs corner to corner through the centre.
    const radians = layer.angle * Math.PI / 180;
    const [towardX, towardY] = [Math.sin(radians), -Math.cos(radians)];
    const length = Math.abs(pane.width * towardX) + Math.abs(pane.height * towardY);
    return colourAt(layer.stops, ((u - 0.5) * pane.width * towardX + (v - 0.5) * pane.height * towardY) / length + 0.5);
}

const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
});

const linearChannel = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);

// The pane the canvas fills (the panel's scroller), at a desktop and a phone size: a linear layer runs corner to
// corner, so its stops land differently on each.
const PANES = [{ width: 1600, height: 1000 }, { width: 390, height: 760 }];
const GRID_STEPS = 48;

// Where a surface can sit over the canvas, in fractions of the pane: [x from, y from, x to, y to].
const REGIONS = {
    anywhere: [0, 0, 1, 1],      // a card, a notice and a danger zone scroll over every point of the pane
    pageHeader: [0, 0, 1, 0.2],  // the page header and its chips and pills: the top of the page, above the first card
    rail: [0, 0, 0.13, 1],       // the rail: a 200px column at the start of a desktop pane
    topBar: [0, 0, 1, 0.08],     // the top bar: one row across the pane's top
};

function* canvasPoints([fromX, fromY, toX, toY]) {
    for (const pane of PANES) {
        for (let column = 0; column <= GRID_STEPS; column += 1) {
            for (let row = 0; row <= GRID_STEPS; row += 1) {
                yield { u: fromX + (toX - fromX) * column / GRID_STEPS, v: fromY + (toY - fromY) * row / GRID_STEPS, pane };
            }
        }
    }
}

// Each surface: the canvas region it sits over, or the solid role under it, then its layers bottom to top. A layer that
// is a gradient is taken at each of its stops, every stop measured like a solid colour, except a nav gradient taken
// `along` the stretch its text sits on: the rail's whole column, the middle of a bar's height, the rail's foot for the
// theme switch.
const CARD = ['surface', 'surface-gradient'];
const RAIL_COLUMN = { role: 'nav-gradient', along: [0, 1] };
const RAIL_FOOT = { role: 'nav-gradient', along: [1, 1] };
const BAR_MIDDLE = { role: 'nav-gradient', along: [0.25, 0.75] };
const BASE_SURFACES = {
    'page header': { region: 'pageHeader', layers: [] },
    'chip in the page header': { region: 'pageHeader', layers: ['surface-raised'] },
    card: { region: 'anywhere', layers: CARD },
    'card header band': { region: 'anywhere', layers: [...CARD, 'surface-header', 'surface-header-gradient'] },
    'row or tile': { region: 'anywhere', layers: [...CARD, 'surface-raised', 'surface-raised-gradient'] },
    'button on a card': { region: 'anywhere', layers: [...CARD, 'surface-raised'] },
    field: { region: 'anywhere', layers: [...CARD, 'field'] },
    notice: { region: 'anywhere', layers: ['surface'] },
    'warning notice': { region: 'anywhere', layers: ['warning-soft'] },
    'danger notice': { region: 'anywhere', layers: ['danger-soft'] },
    'danger zone': { region: 'anywhere', layers: ['danger-soft'] },
    dialog: { solid: 'surface-solid', layers: ['surface-gradient'] },
    'field in a dialog': { solid: 'surface-solid', layers: ['surface-gradient', 'field'] },
    'accent fill': { solid: 'accent-fill', layers: [] },
    'accent gradient': { solid: 'accent-fill', layers: ['accent-gradient'] },
    rail: { region: 'rail', layers: ['nav', RAIL_COLUMN] },
    'top bar': { region: 'topBar', layers: ['nav', BAR_MIDDLE] },
    // On phone the strip is sticky and the page scrolls under it, so its nav colour sits on the canvas colour.
    'phone strip': { solid: 'bg', layers: ['nav', BAR_MIDDLE] },
    'theme switch on the rail': { region: 'rail', layers: ['nav', RAIL_FOOT, 'nav-hover'] },
    'theme switch on the top bar': { region: 'topBar', layers: ['nav', BAR_MIDDLE, 'nav-hover'] },
    'theme switch on the phone strip': { solid: 'bg', layers: ['nav', BAR_MIDDLE, 'nav-hover'] },
};
const NAVS = ['rail', 'top bar', 'phone strip'];
const PILL_HOMES = ['page header', 'card', 'card header band', 'row or tile'];
const STATUSES = ['success', 'warning', 'danger', 'neutral'];

function surfaceModel() {
    const surfaces = { ...BASE_SURFACES };
    for (const nav of NAVS) {
        surfaces[`hovered item on the ${nav}`] = { ...BASE_SURFACES[nav], layers: [...BASE_SURFACES[nav].layers, 'nav-hover'] };
        surfaces[`active item on the ${nav}`] = { ...BASE_SURFACES[nav], layers: [...BASE_SURFACES[nav].layers, 'nav-active'] };
    }
    for (const status of [...STATUSES, 'accent']) {
        for (const home of PILL_HOMES) {
            surfaces[`${status} pill on the ${home}`] = { ...BASE_SURFACES[home], layers: [...BASE_SURFACES[home].layers, `${status}-soft`] };
        }
    }
    return surfaces;
}

const SURFACES = surfaceModel();
const EVERY_PANEL_SURFACE = Object.keys(BASE_SURFACES)
    .filter((name) => !NAVS.includes(name) && !name.startsWith('accent ') && !name.startsWith('theme switch'));

// Each colour, the surfaces it sits on and its floor.
const PAIRS = [
    { ink: 'text', minimum: TEXT, on: EVERY_PANEL_SURFACE },
    { ink: 'text-muted', minimum: TEXT, on: ['page header', 'card', 'card header band', 'row or tile', 'field', 'notice', 'dialog'] },
    { ink: 'text-faint', minimum: TEXT, on: ['field', 'field in a dialog'], use: 'a placeholder' },
    { ink: 'text-faint', minimum: GRAPHIC, on: ['card', 'row or tile'], use: 'an icon' },
    { ink: 'accent-ink', minimum: TEXT, on: ['page header', 'chip in the page header', 'card', 'card header band', 'row or tile', 'button on a card', 'field', 'dialog'] },
    { ink: 'accent-ink', minimum: GRAPHIC, on: EVERY_PANEL_SURFACE, use: 'the focus ring' },
    { ink: 'accent', minimum: GRAPHIC, on: ['card', 'row or tile'], use: 'a switch on' },
    { ink: 'control-off', minimum: GRAPHIC, on: ['card', 'row or tile'], use: 'a switch off, a slider track, an unchecked box' },
    { ink: 'danger-ink', minimum: TEXT, on: ['danger zone', 'danger notice'] },
    { ink: 'on-accent', minimum: TEXT, on: ['accent fill', 'accent gradient'] },
    { ink: 'nav-text', minimum: TEXT, on: NAVS.flatMap((nav) => [nav, `hovered item on the ${nav}`]) },
    { ink: 'nav-text-muted', minimum: TEXT, on: [...NAVS, ...NAVS.map((nav) => `theme switch on the ${nav}`)] },
    { ink: 'nav-accent', minimum: GRAPHIC, on: NAVS, use: 'the brand icon and the focus ring' },
    { ink: 'nav-active-text', minimum: TEXT, on: NAVS.map((nav) => `active item on the ${nav}`) },
    ...[...STATUSES, 'accent'].map((status) => ({
        ink: `${status}-ink`, minimum: TEXT, on: PILL_HOMES.map((home) => `${status} pill on the ${home}`),
    })),
];

/** The canvas's colour at every point of a region: the canvas colour, then its gradient's layers, the last listed lowest. */
function canvasColours(theme, region) {
    const base = parseColour(theme.get('bg'));
    const layers = layersOf(theme.get('bg-gradient')).reverse();
    return [...canvasPoints(REGIONS[region])].map(({ u, v, pane }) => layers.reduce((colour, layer) => over(layerColourAt(layer, u, v, pane), colour), base));
}

/** Every colour a surface can show: its canvas points (or its solid role), then each stop of each of its layers. */
function surfaceColours(theme, surface, canvasByRegion) {
    if (surface.region && !canvasByRegion.has(surface.region)) canvasByRegion.set(surface.region, canvasColours(theme, surface.region));
    let colours = surface.solid ? [parseColour(theme.get(surface.solid))] : canvasByRegion.get(surface.region);
    for (const layer of surface.layers) {
        const choices = typeof layer === 'string' ? layerChoices(theme.get(layer)) : stretchChoices(theme.get(layer.role), layer.along);
        colours = colours.flatMap((colour) => choices.map((choice) => over(choice, colour)));
    }
    return colours;
}

const layerChoices = (value) => layersOf(value).flatMap((layer) => (layer.kind === 'colour' ? [layer.colour] : layer.stops.map((stop) => stop.colour)));

/** A linear gradient's colours over a stretch of its line, [from, to] in fractions, sampled in eight steps. */
function stretchChoices(value, [from, to]) {
    const [gradient] = layersOf(value);
    if (!gradient || gradient.kind !== 'linear') return layerChoices(value);
    return Array.from({ length: 9 }, (_, step) => colourAt(gradient.stops, from + (to - from) * step / 8));
}

/** One row per colour and surface: the lowest ratio the colour reads at there, its floor, and whether it holds. */
export function contrastRows(theme) {
    const canvasByRegion = new Map();
    const luminancesBySurface = new Map();
    const rows = [];
    for (const pair of PAIRS) {
        const inkLuminance = luminance(parseColour(theme.get(pair.ink)));
        for (const name of pair.on) {
            if (!luminancesBySurface.has(name)) {
                luminancesBySurface.set(name, surfaceColours(theme, SURFACES[name], canvasByRegion).map(luminance));
            }
            let ratio = Infinity;
            for (const surfaceLuminance of luminancesBySurface.get(name)) {
                const [lighter, darker] = inkLuminance > surfaceLuminance ? [inkLuminance, surfaceLuminance] : [surfaceLuminance, inkLuminance];
                ratio = Math.min(ratio, (lighter + 0.05) / (darker + 0.05));
            }
            rows.push({ ink: pair.ink, use: pair.use || '', surface: name, ratio, minimum: pair.minimum, holds: ratio >= pair.minimum });
        }
    }
    return rows;
}

function main() {
    const themes = paletteThemes(readFileSync(PALETTE_CSS, 'utf8'));
    let failures = 0;
    for (const [name, theme] of Object.entries(themes)) {
        const rows = contrastRows(theme);
        console.log(`\n${name} theme — lowest ratio of each colour on each surface (floor 4.5 text, 3 graphic)`);
        for (const row of rows) {
            failures += row.holds ? 0 : 1;
            const use = row.use ? ` (${row.use})` : '';
            console.log(`  ${row.holds ? ' ' : '✗'} ${row.ratio.toFixed(2).padStart(5)}  ${row.ink}${use} on the ${row.surface}`);
        }
        console.log(`  lowest per colour: ${[...new Set(rows.map((row) => row.ink + (row.use ? ` (${row.use})` : '')))].map((key) => {
            const lowest = rows.filter((row) => row.ink + (row.use ? ` (${row.use})` : '') === key).reduce((a, b) => (a.ratio <= b.ratio ? a : b));
            return `${key} ${lowest.ratio.toFixed(1)} (${lowest.surface})`;
        }).join('; ')}`);
    }
    if (failures) {
        console.error(`\n[palette-contrast] FAIL — ${failures} pair(s) under their floor`);
        process.exit(1);
    }
    console.log('\n[palette-contrast] OK — every pair holds its floor');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
