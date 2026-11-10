/**
 * Guard G10 (GUI-DNA, connection plan §8): one door to the browser's file picker.
 *
 * The settings panel lives in a SillyTavern popup, and the popup closes on any `cancel` event that reaches its
 * <dialog>. Dismissing a file picker fires one at the file input, and it bubbles, so an input inside the panel or a
 * modal on it closes the whole panel. Every picker opens through the one door, src/shared/pick-files.js (copied from
 * mvu-helper's), whose input never joins the page. None is left elsewhere, and a new one fails.
 *
 * Comments are not uses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsByFile, filesUnder, relativePath, withoutComments } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const THE_DOOR = 'shared/pick-files.js';

// None are left: every file is picked through the door. A selector naming one would count too.
const INPUTS_LEFT = {};

// type="file" in markup or a selector, or `.type = 'file'` in code.
const FILE_INPUT = /\btype\s*=\s*(["'])file\1/g;

function fileInputs(source) {
    return withoutComments(source).split('\n').flatMap((line, index) => [...line.matchAll(FILE_INPUT)].map(() => index + 1));
}

describe('file picker boundary (G10)', () => {
    it('no file input lives in src/ beyond the door and the inputs left', () => {
        const offenders = [];
        for (const file of filesUnder(SRC, ['.js', '.html'])) {
            const relative = relativePath(SRC, file);
            if (relative === THE_DOOR) continue;
            for (const line of fileInputs(readFileSync(file, 'utf8'))) offenders.push(`${relative}:${line}`);
        }
        expect(countsByFile(offenders)).toEqual(INPUTS_LEFT);
    });

    it('the door is the one place an input is made', () => {
        expect(fileInputs(readFileSync(path.join(SRC, THE_DOOR), 'utf8'))).toHaveLength(1);
    });

    it('sees a file input in markup and in code, and ignores comments', () => {
        const source = 'const html = `<input type="file" id="a" accept="image/*">`;\n// input.type = "file"\nconst i = x; i.type = \'file\';\n'
            + 'const more = `<!-- <input type="file"> -->`;\n/* type="file" */ const t = `<input type=\'text\'>`;\n';
        expect(fileInputs(source)).toEqual([1, 3]);
    });
});
