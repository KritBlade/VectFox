// code-scan.mjs — what the source-scanning gates share: the list of src/ files, a copy of a file with everything
// that is not code blanked out (or only its comments), and the per-file count a gate that has not reached zero yet
// holds to.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Every file under `dir`, recursively, whose name ends with one of `extensions` ('.js', '.css', …).
export function filesUnder(dir, extensions) {
    const found = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) found.push(...filesUnder(full, extensions));
        else if (extensions.some((extension) => name.endsWith(extension))) found.push(full);
    }
    return found;
}

// Every .js file under `dir`, recursively.
export function jsFilesUnder(dir) {
    return filesUnder(dir, ['.js']);
}

// A file's path from `root`, with forward slashes on every system.
export function relativePath(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

// Blank comments AND the contents of string/template/regex literals (quotes kept, line breaks kept), so a scan sees
// code only and its line numbers still match the file. With keepStrings, only comments are blanked, so a scan can read
// the markup a template holds. A template's ${…} is code either way, nested templates included. Regex literals get
// their own state: an odd quote inside a pattern would otherwise desync the scan.
const REGEX_MAY_START_AFTER = '(,=:[!&|?{};+-*%~^<>';
export function codeOnly(source, { keepStrings = false } = {}) {
    const out = [];
    const blank = (c) => (keepStrings ? c : (c === '\n' ? '\n' : ' '));
    let state = null;
    let prevMeaningful = '';
    let braceDepth = 0;
    let isInRegexClass = false;
    const templateBraceDepths = []; // for each open ${, the brace depth its closing } returns to
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1];
        if (state === null) {
            if (c === '/' && next === '/') { state = '//'; out.push('  '); i++; continue; }
            if (c === '/' && next === '*') { state = '/*'; out.push('  '); i++; continue; }
            if (c === '}' && templateBraceDepths.at(-1) === braceDepth) {
                templateBraceDepths.pop();
                state = '`';
                out.push(c);
                continue;
            }
            if (c === '{') braceDepth++;
            else if (c === '}') braceDepth--;
            if (c === '/' && (prevMeaningful === '' || REGEX_MAY_START_AFTER.includes(prevMeaningful))) state = '/re';
            else if (c === '"' || c === "'" || c === '`') state = c;
            if (!/\s/.test(c)) prevMeaningful = c;
            out.push(c);
        } else if (state === '/re') {
            if (c === '\\') { out.push(blank(c), blank(next)); i++; continue; }
            out.push(blank(c));
            // A / inside a character class, such as /[&<>"'/]/, does not end the pattern.
            if (c === '[') isInRegexClass = true;
            else if (c === ']') isInRegexClass = false;
            else if ((c === '/' && !isInRegexClass) || c === '\n') {
                state = null;
                isInRegexClass = false;
                prevMeaningful = c;
                out[out.length - 1] = c;
            }
        } else if (state === '//') {
            if (c === '\n') { state = null; out.push(c); } else out.push(' ');
        } else if (state === '/*') {
            if (c === '*' && next === '/') { state = null; i++; out.push('  '); continue; }
            out.push(c === '\n' ? '\n' : ' ');
        } else {
            if (c === '\\') { out.push(blank(c), blank(next)); i++; continue; }
            if (c === state) { state = null; out.push(c); continue; }
            if (state === '`' && c === '$' && next === '{') {
                out.push('$', '{');
                i++;
                templateBraceDepths.push(braceDepth);
                state = null;
                prevMeaningful = '{';
                continue;
            }
            out.push(blank(c));
        }
    }
    return out.join('');
}

// The source with its comments blanked, JavaScript and HTML alike, and its strings kept, line breaks kept: what a scan
// for markup reads.
export function withoutComments(source) {
    return codeOnly(source, { keepStrings: true }).replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
}

// How many of `offenders` ("<file>:<line> …") each file holds. A gate that starts above zero compares this with its
// baseline exactly: a new site fails, and a site cleared lowers its file's number in the same change.
export function countsByFile(offenders) {
    const counts = {};
    for (const offender of offenders) {
        const file = offender.slice(0, offender.indexOf(':'));
        counts[file] = (counts[file] ?? 0) + 1;
    }
    return counts;
}
