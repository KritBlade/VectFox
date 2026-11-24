// tools/sillytavern-folder.mjs — the SillyTavern folder the checks in tools/ read: ST_ROOT when it is set, else the
// first folder in SILLYTAVERN_FOLDERS that holds public/script.js, so an install outranks a source checkout. The checks
// read files only, so a source checkout works as well as an install.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// One folder per PC.
const SILLYTAVERN_FOLDERS = [
    'H:\\Apps\\SillyTavern-Launcher\\SillyTavern',   // main PC: the launcher install
    'C:\\Derek\\Github\\Dev\\misc\\SillyTavern',    // work PC: a source checkout
    '/Users/goten/Github/Dev/SillyTavern',          // Mac: a source checkout
];

/**
 * The SillyTavern folder to read. With none found, it names every folder tried and exits, as the check cannot run.
 * @param {string} tag - The check's name, which starts each line it prints, such as 'host-imports'
 * @returns {string}
 */
export function findSillyTavernFolder(tag) {
    const candidates = [process.env.ST_ROOT, ...SILLYTAVERN_FOLDERS].filter(Boolean);
    const found = candidates.find((folder) => existsSync(join(folder, 'public', 'script.js')));
    if (found) return found;
    console.error(`[${tag}] No SillyTavern found (looked for <folder>/public/script.js) in:`);
    candidates.forEach((folder) => console.error(`[${tag}]   ${folder}`));
    console.error(`[${tag}] A source checkout is enough. Point at one: ST_ROOT=<SillyTavern folder> npm test`);
    process.exit(1);
}
