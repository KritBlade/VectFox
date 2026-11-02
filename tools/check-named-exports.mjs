// tools/check-named-exports.mjs — every in-repo import must reach a file spelled exactly as on disk, and every name
// it takes must be exported there.
//
// A missing file or a name the target does not export fails when the browser links the modules, and then the whole
// extension does not load. vitest never loads most of ui/ or anything that needs a live SillyTavern, so nothing
// else in `npm test` sees it. Ported from mvu-helper's check of the same name, which added it after a barrel left
// out one re-export.
//
// It walks the import graph from the manifest's "js" entry, so it checks exactly the shipped modules wherever they
// sit. It checks static imports, `export … from`, `export * from`, dynamic import() whose names can be read (a
// destructured result, or members read off the bound module) and `new URL('./…', import.meta.url)` targets. Letter
// case must match the folder listing: Windows ignores it, the Linux server SillyTavern may run on does not.
// Paths that leave this repo are SillyTavern's; tools/check-host-imports.mjs checks those.

import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportedNamesOf, findOnDisk, importsOf, isInside, shippedModules } from './es-module-scan.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shown = (file) => relative(repoRoot, file).replaceAll('\\', '/');

const problems = [];
const notes = [];
let checkedCount = 0;

const modules = shippedModules(repoRoot);
for (const file of modules) {
    for (const entry of importsOf(file)) {
        if (!entry.specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), entry.specifier);
        if (!isInside(repoRoot, target)) continue;
        checkedCount++;
        const where = `${shown(file)}:${entry.line}`;
        const found = findOnDisk(repoRoot, target);
        if (found.state === 'missing') {
            problems.push(`${where} ${entry.specifier}: no such file`);
            continue;
        }
        if (found.state === 'case') {
            problems.push(`${where} ${entry.specifier}: "${found.written}" is "${found.onDisk}" on disk`);
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
            if (!names.has(name)) problems.push(`${where} takes { ${name} } from ${entry.specifier}, which does not export it`);
        }
    }
}

notes.forEach((note) => console.log(`[named-exports] note: ${note}`));
if (problems.length) {
    problems.forEach((problem) => console.error(`[named-exports] ${problem}`));
    console.error(`[named-exports] FAIL: ${problems.length} problem(s). A missing file or statically imported name stops `
        + 'the extension loading in the browser; a missing dynamic name is undefined where it is used.');
    process.exit(1);
}
console.log(`[named-exports] OK: ${modules.length} modules, ${checkedCount} in-repo imports; every file and name found`);
