/**
 * The GUI-DNA guards (connection plan §8, mvu-helper/devdoc/gui-dna.md), checked against the source:
 *   G2  a hint, card description, switch description or page subtitle is one line: ≤ 90 characters, in markup and
 *       in every one the code builds
 *   G3  no inline style except display:none
 *   G4  every class a JS selector looks for is still emitted somewhere
 *   G5  colours live only in palette.css's token blocks, and both themes name every role
 *   G7  an element the code paints into carries no translation key
 * G3 and G5 start as exact per-file counts, since the pages not yet on the DNA hold styles and colours of their own:
 * each phase clears its page's, its files' counts drop in the same change, and they reach zero at P13. A new one
 * fails. G1 does not apply, as VectFox ships one language; G6 arrives with P13, G8 to G10 and G12 have files of their
 * own, and G11 does not apply, as VectFox has no per-card profile.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsByFile, filesUnder, jsFilesUnder, relativePath, withoutComments } from './code-scan.mjs';
import { PANEL_TABS } from '../src/features/settings-panel/panel-shell-markup.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DNA_FOLDER = path.join(SRC, 'shared', 'gui-dna');
const PALETTE_CSS = path.join(DNA_FOLDER, 'palette.css');
const GUI_DNA_CSS = path.join(DNA_FOLDER, 'gui-dna.css');

const read = (file) => readFileSync(file, 'utf8');
const relative = (file) => relativePath(ROOT, file);
const decodeEntities = (text) => text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

// Third-party code, which these scans do not read.
const VENDOR_FOLDER = 'vendor/';
const isOurs = (file) => !relativePath(SRC, file).startsWith(VENDOR_FOLDER);
const ourJsFiles = () => jsFilesUnder(SRC).filter(isOurs);
const ourFiles = (extensions) => filesUnder(SRC, extensions).filter(isOurs);

// Surfaces VectFox draws itself (gui-dna.md §4), which keep their own colours: the story web on StoryArc's page, whose
// canvas and legend are built from the --vfx-web- channels story-arc-page.css sets, and the card image a PNG export
// writes.
const SELF_DRAWN_FILES = new Set([
    'features/eventbase/story-arc-web.js',
    'features/eventbase/story-arc-web-core.js',
    'features/collections/png-export.js',
]);
const WEB_CHANNEL_COLOUR = /\brgb\(var\(--vfx-web-[\w-]+\)\)/g;

// A file that builds with the gene builders, generated or VectFox's own, and the shell's markup, whose page subtitles are data.
const BUILDS_GENES = /from\s+['"][^'"]*gui-dna\/(?:gui-dna-core|panel-page-genes)\.js['"]/;
const SHELL_MARKUP = path.join(SRC, 'features', 'settings-panel', 'panel-shell-markup.js');

// ── G2 ─────────────────────────────────────────────────────────────────────────────────────────────
const ONE_LINE_MAX = 90;
const ONE_LINE_ELEMENT = /<(p|span|div|small)\b[^>]*\bclass="[^"]*\b(vfx-hint|vfx-card-desc|vfx-switch-desc|vfx-page-subtitle)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
// A hint a renderer builds, hint({ text: '…' }), and a card description handed to a card header builder: the kind,
// the quote, then the string, escapes included.
const BUILT_ONE_LINER = /\b(hint\(\{\s*text|description)\s*:\s*(['"])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const unescape = (text) => text.replace(/\\(.)/g, '$1');

function oneLineTexts() {
    const texts = PANEL_TABS.filter((tab) => tab.subtitle).map((tab) => ({ kind: 'vfx-page-subtitle (PANEL_TABS)', text: tab.subtitle }));
    for (const file of ourJsFiles()) {
        const text = withoutComments(read(file));
        for (const match of text.matchAll(ONE_LINE_ELEMENT)) {
            const shown = decodeEntities(match[3].replace(/\$\{[^}]*\}/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
            if (shown) texts.push({ kind: `${match[2]} (${relative(file)})`, text: shown });
        }
        if (!BUILDS_GENES.test(text) && file !== SHELL_MARKUP) continue;
        for (const match of text.matchAll(BUILT_ONE_LINER)) {
            const kind = match[1] === 'description' ? 'vfx-card-desc' : 'vfx-hint';
            texts.push({ kind: `${kind} (${relative(file)})`, text: unescape(match[3]) });
        }
    }
    return texts;
}

// ── G3 ─────────────────────────────────────────────────────────────────────────────────────────────
// The styles left, by file, until their page's phase moves them to GUI-DNA classes.
const INLINE_STYLES_LEFT = {
    'features/chunkbase/content-vectorizer.js': 22,
    'features/database-browser/chunk-visualizer.js': 4,
    'features/database-browser/database-browser.js': 10,
    'features/query-tester/query-tester.js': 21,
    'features/settings-panel/settings-panel.js': 61,
    'features/text-cleaning/text-cleaning-ui.js': 2,
    'features/text-cleaning/text-cleaning.js': 2,
    'features/vector-backend/tokenizer-lock.js': 1,
    'features/world-info/lorebook-rename-detector.js': 1,
    'shared/progress-tracker.js': 1,
};

function inlineStyleSites() {
    const sites = [];
    for (const file of ourFiles(['.js', '.html'])) {
        withoutComments(read(file)).split('\n').forEach((line, index) => {
            // A style attribute: style= then its quote. A variable named style is not one.
            const styles = (line.match(/\bstyle\s*=\s*["'`]/g) || []).length;
            const hidden = (line.match(/\bstyle\s*=\s*["']\s*display\s*:\s*none\s*;?\s*["']/g) || []).length;
            const jqueryCss = (line.match(/\.css\(/g) || []).length;
            for (let site = 0; site < styles - hidden + jqueryCss; site++) sites.push(`${relativePath(SRC, file)}:${index + 1}`);
        });
    }
    return sites;
}

// ── G4 ─────────────────────────────────────────────────────────────────────────────────────────────
const SELECTOR_CALL = /(?:\$|\.find|\.closest|\.children|\.parents?|\.filter|\.is|\.not|\.has|querySelector(?:All)?)\(\s*(['"`])((?:(?!\1)[^\n])*)\1/g;
// A delegated handler's selector: .on('click', '.x', …).
const DELEGATED_SELECTOR = /\.on\(\s*['"`][^'"`\n]*['"`]\s*,\s*(['"`])((?:(?!\1)[^\n])*)\1/g;
// VectFox's own classes: the DNA's, and those of the pages not on it yet, whose hooks a phase can strand.
const CLASS_TOKEN = /\.((?:vfx|vectfox)-[\w-]+)/g;
const mentions = (text, token) => new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text);

function selectorClassesAndEmittedText() {
    const selectorClasses = new Map();   // class → first file that looks it up
    const emitted = [read(GUI_DNA_CSS)];
    for (const file of ourJsFiles()) {
        const text = withoutComments(read(file));
        for (const match of [...text.matchAll(SELECTOR_CALL), ...text.matchAll(DELEGATED_SELECTOR)]) {
            for (const token of match[2].matchAll(CLASS_TOKEN)) {
                if (!selectorClasses.has(token[1])) selectorClasses.set(token[1], relative(file));
            }
        }
        // A class counts as emitted only OUTSIDE a lookup.
        emitted.push(text.replace(SELECTOR_CALL, '').replace(DELEGATED_SELECTOR, ''));
    }
    return { selectorClasses, emitted };
}

// ── G5 ─────────────────────────────────────────────────────────────────────────────────────────────
// A hex colour (not an HTML entity such as &#039;), or an rgb/hsl call.
const COLOUR = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|\b(?:rgba?|hsla?)\(/g;
const TOKEN_DECLARATION = /^\s*--vfx-[\w-]+\s*:/;
// The colours left, by file, until their page's phase moves them to --vfx- tokens.
const COLOURS_LEFT = {
    'features/chunkbase/content-vectorizer.css': 1,
    'features/database-browser/chunk-visualizer.css': 77,
    'features/database-browser/collection-badges.css': 37,
    'features/database-browser/database-browser.css': 17,
    'features/diagnostics/diagnostics.css': 1,
    'features/diagnostics/health-dashboard.css': 12,
    'features/query-tester/query-tester.js': 11,
    'features/settings-panel/settings-panel.js': 12,
    'shared/base.css': 6,
    'shared/forms.css': 7,
    'shared/modals.css': 60,
    'shared/progress-tracker.css': 6,
    'shared/tabs.css': 5,
};

function colourSites() {
    const sites = [];
    for (const file of ourFiles(['.js', '.css', '.html'])) {
        if (SELF_DRAWN_FILES.has(relativePath(SRC, file))) continue;
        const isPalette = file === PALETTE_CSS;
        const text = file.endsWith('.css') ? read(file).replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')) : withoutComments(read(file));
        text.split('\n').forEach((line, index) => {
            if (isCommentLine(line) || (isPalette && TOKEN_DECLARATION.test(line))) return;
            for (const _colour of line.replace(WEB_CHANNEL_COLOUR, '').match(COLOUR) || []) sites.push(`${relativePath(SRC, file)}:${index + 1}`);
        });
    }
    return sites;
}

// The palette's two themes: the dark default on the root class, the light one under the attribute the shell writes on
// <html>. A role one block leaves out silently keeps the other theme's colour, so both name the same roles.
const DARK_THEME_SELECTOR = '.vfx-ui';
const LIGHT_THEME_SELECTOR = 'html[data-vfx-theme="light"] .vfx-ui';

function themeRoles(css) {
    const roles = new Map();
    for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^{}\s][^{}]*?)\s*\{([^{}]*)\}/gm)) {
        roles.set(match[1].trim(), new Set([...match[2].matchAll(/^\s*(--vfx-[\w-]+)\s*:/gm)].map((role) => role[1])));
    }
    return roles;
}

// ── G7 ─────────────────────────────────────────────────────────────────────────────────────────────
const PAINT_CALL = String.raw`\.(?:html|text|append|prepend)\(\s*[^)\s]|\.empty\(`;
const ID_LOOKUP = /\$\(\s*(['"])#([\w-]+)\1\s*\)/g;
const ID_VARIABLE = /(?:const|let|var)\s+(\$?\w+)\s*=\s*\$\(\s*(['"])#([\w-]+)\2\s*\)/g;

function paintedIds() {
    const painted = new Set();
    for (const file of ourJsFiles()) {
        const text = withoutComments(read(file));
        for (const line of text.split('\n')) {
            for (const match of line.matchAll(ID_LOOKUP)) {
                const rest = line.slice(match.index + match[0].length).split(';')[0];
                if (new RegExp(`^\\s*(?:\\.\\w+\\([^)]*\\)\\s*)*?(?:${PAINT_CALL})`).test(rest)) painted.add(match[2]);
            }
        }
        for (const match of text.matchAll(ID_VARIABLE)) {
            const variable = match[1].replace(/\$/g, '\\$');
            if (new RegExp(`(?<![\\w$])${variable}(?:${PAINT_CALL})`).test(text)) painted.add(match[3]);
        }
    }
    return painted;
}

// Every opening tag written in src, by the id it carries.
function openingTagsById() {
    const tags = new Map();
    for (const file of ourJsFiles()) {
        for (const match of withoutComments(read(file)).matchAll(/<[a-z][^<>]*\bid="([\w-]+)"[^<>]*>/g)) tags.set(match[1], match[0]);
    }
    return tags;
}

describe('GUI-DNA guards', () => {
    it(`G2 — a hint, card description, switch description or page subtitle is one line (≤ ${ONE_LINE_MAX} characters)`, () => {
        const texts = oneLineTexts();
        // A scan that found nothing would pass anything: it sees each page's subtitle, a built hint and a card description.
        expect(texts.filter((t) => t.kind.startsWith('vfx-page-subtitle')).length).toBeGreaterThanOrEqual(PANEL_TABS.length);
        expect(texts.some((t) => t.kind.startsWith('vfx-hint (src/'))).toBe(true);
        expect(texts.some((t) => t.kind.startsWith('vfx-card-desc (src/'))).toBe(true);
        const tooLong = texts.filter((t) => t.text.length > ONE_LINE_MAX).map((t) => `${t.kind} (${t.text.length}): ${t.text}`);
        expect(tooLong).toEqual([]);
    });

    it('G3 — no inline style beyond the styles left (display:none excepted)', () => {
        expect(countsByFile(inlineStyleSites())).toEqual(INLINE_STYLES_LEFT);
    });

    it('G4 — every class a JS selector looks for is still emitted somewhere', () => {
        const { selectorClasses, emitted } = selectorClassesAndEmittedText();
        // The scan sees the shell's own lookup: a scan that found nothing would pass anything.
        expect(selectorClasses.get('vfx-collapse')).toBe('src/features/settings-panel/panel-shell.js');
        const orphaned = [...selectorClasses].filter(([token]) => !emitted.some((text) => mentions(text, token)))
            .map(([token, file]) => `${file} looks for .${token}, which nothing emits`);
        expect(orphaned).toEqual([]);
    });

    it('G5 — colours live only in palette.css, beyond the colours left', () => {
        expect(read(PALETTE_CSS).match(COLOUR).length).toBeGreaterThan(20);   // a palette that moved would pass anything
        expect(countsByFile(colourSites())).toEqual(COLOURS_LEFT);
    });

    it('G5 — the dark and the light theme name the same colour roles', () => {
        const themes = themeRoles(read(PALETTE_CSS));
        expect([...themes.keys()]).toEqual([DARK_THEME_SELECTOR, LIGHT_THEME_SELECTOR]);
        const [dark, light] = [themes.get(DARK_THEME_SELECTOR), themes.get(LIGHT_THEME_SELECTOR)];
        expect(dark.size).toBeGreaterThan(40);   // a parse that found nothing would pass anything
        expect([...dark].filter((role) => !light.has(role)).map((role) => `${role}: dark only`)).toEqual([]);
        expect([...light].filter((role) => !dark.has(role)).map((role) => `${role}: light only`)).toEqual([]);
        // The light block's attribute is the one the shell writes.
        expect(read(path.join(SRC, 'features', 'settings-panel', 'panel-shell.js'))).toContain('document.documentElement.dataset.vfxTheme = theme');
    });

    it('G7 — an element the code paints into carries no translation key', () => {
        const painted = paintedIds();
        expect(painted.has('VectFox_story_arc_link_status')).toBe(true);   // the scan sees a paint through a variable
        const tags = openingTagsById();
        const clashes = [...painted].filter((id) => /\bdata-i18n="/.test(tags.get(id) ?? ''))
            .map((id) => `#${id} is painted by code and carries data-i18n, which a translation pass would overwrite`);
        expect(clashes).toEqual([]);
    });
});
