/**
 * Guard G8 (GUI-DNA, connection plan §8): no native browser dialogs.
 *
 * On the SillyTavern page, confirm(), alert() and prompt() block the page thread and freeze generation. Every question
 * goes through src/sillytavern/popup.js instead, which answers NO when a dialog cannot open, so a broken popup never
 * reads as consent. None is left, and a new call fails.
 *
 * Code only: a call inside a comment or a string is not a call.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, countsByFile, jsFilesUnder, relativePath } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// None are left: every question goes through sillytavern/popup.js.
const CALLS_LEFT = {};

// A bare call, or one on the global object. `obj.confirm(…)` and `myConfirm(…)` are other functions.
const NATIVE_DIALOG_CALL = /(?:^|[^\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?(confirm|alert|prompt)\s*\(/g;

function nativeDialogCalls(code) {
    return [...code.matchAll(NATIVE_DIALOG_CALL)].map((match) => match[1]);
}

describe('native browser dialogs (G8)', () => {
    it('no file in src/ calls confirm(), alert() or prompt() beyond the calls left', () => {
        const offenders = [];
        for (const file of jsFilesUnder(SRC)) {
            codeOnly(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
                for (const name of nativeDialogCalls(line)) offenders.push(`${relativePath(SRC, file)}:${index + 1} ${name}()`);
            });
        }
        expect(countsByFile(offenders)).toEqual(CALLS_LEFT);
    });

    it('sees a call in code, and ignores one in a comment, a string or on another object', () => {
        const scanned = codeOnly("if (!confirm('x')) return; // alert(1)\nconst s = 'prompt(2)'; obj.confirm(3); window.alert(4); myConfirm(5);\n");
        expect(nativeDialogCalls(scanned)).toEqual(['confirm', 'alert']);
    });
});
