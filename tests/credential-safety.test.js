/**
 * Credential invariants, from InternalProject/Vectfox/plans/vectfox-connection-manager.md §10. Scans src/ as text, with
 * no host imports and no SillyTavern mocks. A red here means a change can put an API key where it does not belong:
 * report it and stop. Never edit this file to make it pass.
 *
 * Invariant 6 reads the request-shape builder itself, a pure module with no host imports. Invariant 7 is the plugin's
 * own test. Invariants 8 and 9 keep any part of a key out of what VectFox shows and logs: a provider can quote the key
 * it refused, and SillyTavern's masked value ends with the key's last characters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CONNECTION_PROFILE_OVERRIDE_KEYS, connectionProfileRequestShape } from '../src/features/llm-provider/connection-profile-core.js';

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

    it('6: a profile request overrides only the plan §2 keys, and the wrapper adds only the no-key ID', () => {
        // The plan's table, written out here so a change to the builder's own list cannot widen it unseen.
        const PLAN_KEYS = {
            chat: ['max_completion_tokens', 'reasoning_effort', 'response_format', 'temperature'],
            text: ['temperature'],
        };
        expect(Object.fromEntries(Object.entries(CONNECTION_PROFILE_OVERRIDE_KEYS).map(([api, keys]) => [api, [...keys].sort()]))).toEqual(PLAN_KEYS);
        const sent = new Set();
        for (const api of ['chat', 'text']) {
            for (const sendTemperature of [true, false]) {
                for (const tokenLimitParameter of ['max_tokens', 'max_completion_tokens']) {
                    for (const reasoningEffort of [null, 'none']) {
                        for (const responseFormat of [null, { type: 'json_object' }]) {
                            const { overridePayload } = connectionProfileRequestShape({ api, maxTokens: 100, temperature: 0.2, sendTemperature, tokenLimitParameter, reasoningEffort, responseFormat });
                            Object.keys(overridePayload).forEach(key => sent.add(`${api}:${key}`));
                            expect(Object.keys(overridePayload).filter(key => !PLAN_KEYS[api].includes(key))).toEqual([]);
                        }
                    }
                }
            }
        }
        // The builder was exercised, rather than an empty payload passing.
        expect(sent.size).toBe(5);
        // The wrapper spreads the builder's payload and adds one key, only for a profile with no stored key.
        const wrapper = fileAt('src/sillytavern/connection-profiles.js');
        expect(hitsOf(/overridePayload,/, { codeOnly: true, files: [wrapper] })).toHaveLength(1);
        expect(wrapper.lines.filter(line => /\.\.\.overridePayload/.test(line)).map(line => line.trim()))
            .toEqual(['const payload = connectionProfileStoresKey(profile) ? overridePayload : { ...overridePayload, secret_id: NO_KEY_SECRET_ID };']);
    });

    it('8: every failed reply VectFox reads goes through readErrorBody, which removes anything key-shaped', () => {
        // The reads of a response's or a file's text that are content, never a failure: files the user picks, a
        // fetched web page, a video transcript, the BM25 dictionary.
        const CONTENT_READS = [
            /await file\.text\(\)/,
            /pageTextFromHtml\(await response\.text\(\)/,
            /const transcript = await response\.text\(\);/,
            /const dictText = await resp\.text\(\);/,
        ];
        const textReads = sourceFiles
            .filter(file => file.path !== 'src/shared/server-error-text.js')
            .flatMap(file => file.lines.flatMap((line, index) => (
                /\.text\(\)/.test(line) && !isCommentLine(line) ? [{ hit: `${file.path}:${index + 1}`, line }] : []
            )));
        expect(textReads.filter(read => !CONTENT_READS.some(pattern => pattern.test(read.line))).map(read => read.hit)).toEqual([]);
        // The guard was found at the reads, rather than nothing left to check.
        expect(hitsOf(/await readErrorBody\(/, { codeOnly: true }).length).toBeGreaterThan(30);
    });

    it('9: no text VectFox shows or logs is built from a key, a masked one included', () => {
        expect(hitsOf(/(?:savedKey|legacyPlaintext|apiKey|masked|secret\w*)\.slice\(\s*-/i, { codeOnly: true })).toEqual([]);
        expect(hitsOf(/\$\{\s*(?:savedKey|masked|presence\.masked|legacyPlaintext|apiKey)\s*\}/, { codeOnly: true })).toEqual([]);
        // Similharity before 3.4.4 answers /qdrant/key-status with the key's last 4 characters, which is never read.
        expect(hitsOf(/presence\.masked|data\?\.masked|data\.masked/, { codeOnly: true })).toEqual([]);
    });
});
