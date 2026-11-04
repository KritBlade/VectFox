// tools/check-host-imports.mjs — every SillyTavern import must sit in src/sillytavern/, reach a file in SillyTavern
// spelled exactly as on disk, and take only names exported there.
//
// Only the facades in src/sillytavern/ import SillyTavern, by relative paths that leave this repo
// (`../../../../../../script.js`); every other module imports the facade that re-exports the name, so a folder move
// changes no SillyTavern path. No unit test loads SillyTavern and the in-repo checks skip it, so a wrong `../` count,
// or a name SillyTavern does not export, shows up only in the browser. Ported from mvu-helper's check of the same
// name, which checks paths only.
//
// The browser resolves each path from the URL SillyTavern serves this extension at,
// /scripts/extensions/third-party/VectFox/, which lies in SillyTavern's public/ folder; this check does the same.
// It reads files only, so a SillyTavern source checkout works as well as an install:
//   node tools/check-host-imports.mjs                           the first folder in SILLYTAVERN_FOLDERS that exists
//   ST_ROOT=<SillyTavern folder> node tools/check-host-imports.mjs

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportedNamesOf, findOnDisk, importsOf, isInside, shippedModules } from './es-module-scan.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shown = (file) => relative(repoRoot, file).replaceAll('\\', '/');

const SERVED_AT = ['scripts', 'extensions', 'third-party', 'VectFox'];
// The first that holds public/script.js wins, so an install outranks a source checkout.
const SILLYTAVERN_FOLDERS = [
    'H:\\Apps\\SillyTavern-Launcher\\SillyTavern',   // main PC: the launcher install
    'C:\\Derek\\Github\\Dev\\misc\\SillyTavern-1.19.0',    // work PC: a source checkout
    '/Users/goten/Github/Dev/SillyTavern',          // Mac: a source checkout
];

const candidates = [process.env.ST_ROOT, ...SILLYTAVERN_FOLDERS].filter(Boolean);
const sillyTavernFolder = candidates.find((folder) => existsSync(join(folder, 'public', 'script.js')));
if (!sillyTavernFolder) {
    console.error('[host-imports] No SillyTavern found (looked for <folder>/public/script.js) in:');
    candidates.forEach((folder) => console.error(`[host-imports]   ${folder}`));
    console.error('[host-imports] A source checkout is enough. Point at one: ST_ROOT=<SillyTavern folder> npm test');
    process.exit(1);
}
const publicFolder = join(sillyTavernFolder, 'public');
const servedFolder = join(publicFolder, ...SERVED_AT);
console.log(`[host-imports] resolving as served from ${servedFolder}`);

const hostLayerFolder = join(repoRoot, 'src', 'sillytavern');
const misplaced = [];
const problems = [];
const notes = [];
let checkedCount = 0;

for (const file of shippedModules(repoRoot)) {
    for (const entry of importsOf(file)) {
        if (entry.kind === 'url') continue;
        const isRelative = entry.specifier.startsWith('.');
        if (!isRelative && !entry.specifier.startsWith('/')) continue;
        if (isRelative && isInside(repoRoot, resolve(dirname(file), entry.specifier))) continue;
        checkedCount++;
        const where = `${shown(file)}:${entry.line}`;
        if (!isInside(hostLayerFolder, file)) misplaced.push(`${where} ${entry.specifier}`);
        const target = isRelative
            ? resolve(join(servedFolder, relative(repoRoot, dirname(file))), entry.specifier)
            : join(publicFolder, entry.specifier);
        if (!isInside(publicFolder, target)) {
            problems.push(`${where} ${entry.specifier}: climbs above SillyTavern's public folder`);
            continue;
        }
        const found = findOnDisk(publicFolder, target);
        if (found.state === 'missing') {
            problems.push(`${where} ${entry.specifier}: no such file (${target})`);
            continue;
        }
        if (found.state === 'case') {
            problems.push(`${where} ${entry.specifier}: "${found.written}" is "${found.onDisk}" in SillyTavern`);
            continue;
        }
        if (entry.names === null) {
            notes.push(`${where} names from ${entry.specifier} not checked: the code uses the module in a way they cannot be read from`);
            continue;
        }
        if (!entry.names.length) continue;
        const { names, unreadStars } = exportedNamesOf(target);
        if (unreadStars.length) {
            notes.push(`${where} names from ${entry.specifier} not checked: it re-exports * from ${unreadStars.join(', ')}`);
            continue;
        }
        for (const name of entry.names) {
            if (!names.has(name)) problems.push(`${where} takes { ${name} } from ${entry.specifier}, which SillyTavern does not export`);
        }
    }
}

notes.forEach((note) => console.log(`[host-imports] note: ${note}`));
if (misplaced.length) {
    misplaced.forEach((hostImport) => console.error(`[host-imports] ${hostImport}: imports SillyTavern outside src/sillytavern/`));
    console.error(`[host-imports] FAIL: ${misplaced.length} SillyTavern import(s) outside src/sillytavern/. Import the `
        + 'facade there that re-exports each name (add the name to the facade that fits it), so no folder move can '
        + 'break the path.');
}
if (problems.length) {
    problems.forEach((problem) => console.error(`[host-imports] ${problem}`));
    console.error(`[host-imports] FAIL: ${problems.length} problem(s). Each one stops the extension loading in the `
        + 'browser, or leaves a dynamic name undefined where it is used.');
}
if (misplaced.length || problems.length) process.exit(1);
console.log(`[host-imports] OK: ${checkedCount} SillyTavern imports, all in src/sillytavern/; every file and name found`);
