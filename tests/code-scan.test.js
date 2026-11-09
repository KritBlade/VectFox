/**
 * The source scan every gate reads through (tests/code-scan.mjs). A scan that loses its place in a file stops seeing
 * the rest of it, and a gate built on it then passes on code it never read.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, countsByFile, jsFilesUnder, relativePath, withoutComments } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('codeOnly', () => {
    it('keeps its place through every file in src/: what it leaves as code opens and closes every bracket', () => {
        const unbalanced = [];
        for (const file of jsFilesUnder(SRC)) {
            const code = codeOnly(readFileSync(file, 'utf8'));
            const opened = (code.match(/[{([]/g) || []).length;
            const closed = (code.match(/[})\]]/g) || []).length;
            if (opened !== closed) unbalanced.push(`${relativePath(SRC, file)} opens ${opened}, closes ${closed}`);
        }
        expect(unbalanced).toEqual([]);
    });

    it('blanks comments and string contents, and keeps every line break', () => {
        const source = "call(1); // note\nconst s = 'text'; /* a\nblock */ go(`t\nx`);\n";
        const scanned = codeOnly(source);
        expect(scanned.split('\n')).toHaveLength(source.split('\n').length);
        expect(scanned).toContain('call(1);');
        expect(scanned).not.toContain('note');
        expect(scanned).not.toContain('text');
        expect(scanned).toContain('go(`');
    });

    it('reads a template\'s ${…} as code, nested templates included, and keeps its place after them', () => {
        const source = 'const a = `<div>${flag ? `<b>${name(1)}</b>` : \'\'}</div>`;\nconfirm(2);\n';
        const scanned = codeOnly(source);
        expect(scanned).toContain('name(1)');
        expect(scanned).not.toContain('<b>');
        expect(scanned.split('\n')[1]).toBe('confirm(2);');
    });

    it('keeps its place past braces inside ${…} and a regex with a quote in it', () => {
        const source = 'const a = `${items.map(item => { return item; }).join(\'\')}`;\nconst re = /it\'s/;\nalert(3);\n';
        expect(codeOnly(source).split('\n')[2]).toBe('alert(3);');
    });

    it('keeps its place past a regex whose character class holds a slash', () => {
        const source = "text.replace(/[&<>\"'/]/g, swap); const s = '{';\nprompt(4);\n";
        expect(codeOnly(source).split('\n')[1]).toBe('prompt(4);');
    });
});

describe('withoutComments', () => {
    it('keeps what strings hold, and blanks JavaScript and HTML comments', () => {
        const source = 'const html = `<input type="file" accept="image/*"> <!-- <input type="file"> -->`; // type="file"\n';
        const scanned = withoutComments(source);
        expect(scanned.match(/type="file"/g)).toHaveLength(1);
        expect(scanned).toContain('accept="image/*"');
    });
});

describe('countsByFile', () => {
    it('counts each file\'s sites', () => {
        expect(countsByFile(['a.js:1 x', 'b/c.js:4 y', 'a.js:9 z'])).toEqual({ 'a.js': 2, 'b/c.js': 1 });
    });
});
