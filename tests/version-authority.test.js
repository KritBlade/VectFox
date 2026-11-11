// Tests that the plugin's version is written in package.json alone, so a release changes that one file: index.js
// reads it from there for /health, /version and its startup line, and no other file names a version of its own.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = name => readFileSync(path.join(PLUGIN_ROOT, name), 'utf8');

test('package.json holds the version, and index.js reads it from there', () => {
    const { version } = JSON.parse(read('package.json'));
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.match(read('index.js'), /const \{ version: pluginVersion \} = JSON\.parse\(await fs\.readFile\(new URL\('\.\/package\.json', import\.meta\.url\), 'utf8'\)\);/);
});

test('no other file names the version or keeps one of its own', () => {
    const { version } = JSON.parse(read('package.json'));
    const files = [...readdirSync(PLUGIN_ROOT).filter(name => name.endsWith('.js')), 'README.md'];
    for (const name of files) {
        const text = read(name);
        assert.equal(text.includes(version), false, `${name} names ${version}`);
        assert.doesNotMatch(text, /@version\s+\d|pluginVersion\s*=\s*['"]\d/, `${name} keeps a version of its own`);
    }
});
