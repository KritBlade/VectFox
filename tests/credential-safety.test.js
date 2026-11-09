/**
 * Credential invariants, from InternalProject/Vectfox/plans/vectfox-connection-manager.md §10. Scans src/ as text, with
 * no host imports and no SillyTavern mocks. A red here means a change can put an API key where it does not belong:
 * report it and stop. Never edit this file to make it pass.
 *
 * Invariant 6 (overridePayload's keys) arrives with the connection profiles, and invariant 7 is the plugin's own test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function jsFilesUnder(folder) {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) return jsFilesUnder(path);
        return entry.name.endsWith('.js') ? [path] : [];
    });
}

const sourceFiles = jsFilesUnder(join(repoRoot, 'src')).map(path => ({
    path: relative(repoRoot, path).replaceAll('\\', '/'),
    lines: readFileSync(path, 'utf8').split(/\r?\n/),
}));

const isCommentLine = line => /^\s*(\/\/|\/?\*)/.test(line);

/** `file:line` of every line matching `pattern`, comments included unless `codeOnly`. */
function hitsOf(pattern, { codeOnly = false, files = sourceFiles } = {}) {
    return files.flatMap(file => file.lines.flatMap((line, index) => (
        pattern.test(line) && !(codeOnly && isCommentLine(line)) ? [`${file.path}:${index + 1}`] : []
    )));
}

const fileAt = path => sourceFiles.find(file => file.path === path);

describe('credential invariants (plan §10)', () => {
    it('1: nothing reads a key value back from SillyTavern', () => {
        expect(hitsOf(/\/api\/secrets\/find|\/api\/secrets\/view|findSecret/)).toEqual([]);
    });

    it('2: no API key is a VectFox setting', () => {
        const lines = fileAt('src/index.js').lines;
        const start = lines.findIndex(line => /defaultSettings\s*=\s*\{/.test(line));
        const end = lines.findIndex((line, index) => index > start && /^\};/.test(line));
        const keys = lines.slice(start + 1, end).flatMap(line => /^\s*([A-Za-z_]\w*)\s*:/.exec(line)?.[1] ?? []);
        // The block was found, rather than an empty slice passing.
        expect(keys.length).toBeGreaterThan(100);
        expect(keys.filter(key => /_api_key$/.test(key))).toEqual([]);
    });

    it('3: a fetch to a vendor URL written in the code is on the allowlist: public model lists, sent with no key', () => {
        const literalVendorFetches = sourceFiles.flatMap(file => file.lines.flatMap(line => {
            const url = /fetch\(\s*['"`](https?:\/\/[^'"`]+)['"`]/.exec(line)?.[1];
            return url ? [`${file.path} ${url}`] : [];
        })).sort();
        expect(literalVendorFetches).toEqual([
            'src/features/eventbase/story-arc-links.js https://openrouter.ai/api/v1/models',
            'src/features/settings-panel/settings-panel.js https://openrouter.ai/api/v1/models',
            'src/features/settings-panel/settings-panel.js https://openrouter.ai/api/v1/models',
            'src/features/settings-panel/settings-panel.js https://openrouter.ai/api/v1/models?output_modalities=embeddings',
        ]);
    });

    it('4: no proxy credentials, and a profile\'s key ID and URL only in the connection-profile wrapper', () => {
        expect(hitsOf(/proxy_password|reverse_proxy/)).toEqual([]);
        const profileFields = hitsOf(/secret-id|api-url|secret_id/)
            .filter(hit => !hit.startsWith('src/sillytavern/connection-profiles.js:'));
        expect(profileFields).toEqual([]);
    });

    it('5: no Authorization header anywhere, and no key in the chat request body', () => {
        expect(hitsOf(/Authorization/, { codeOnly: true })).toEqual([]);
        const requestBuilder = fileAt('src/features/llm-provider/llm-provider-call.js');
        // Still the file that builds every chat request body.
        expect(requestBuilder.lines.some(line => line.includes('/api/backends/chat-completions/generate'))).toBe(true);
        expect(hitsOf(/\bapi_key\b|\bapiKey\b/, { codeOnly: true, files: [requestBuilder] })).toEqual([]);
    });
});
