/**
 * The text a server answers a failed request with, as VectFox logs and shows it (src/shared/server-error-text.js):
 * anything shaped like an API key is removed, a masked key included, and ordinary error text is left as it is.
 */

import { describe, expect, it } from 'vitest';
import { readErrorBody, redactKeyMaterial } from '../src/shared/server-error-text.js';

// A made-up key, masked the way OpenAI's 401 quotes the key it refused.
const MASKED_ECHO = '{"error":{"message":"Incorrect API key provided: sk-proj-********************************Ab1C. You can find your API key at https://platform.openai.com/account/api-keys."}}';

describe('redactKeyMaterial', () => {
    it('removes a masked key a provider quotes, leaving the rest of its words', () => {
        const text = redactKeyMaterial(MASKED_ECHO);
        expect(text).not.toMatch(/sk-proj|Ab1C|\*{3}/);
        expect(text).toContain('Incorrect API key provided: [key removed]');
    });

    it('removes whole keys of each vendor shape, and Bearer tokens', () => {
        const madeUp = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);
        for (const text of [madeUp, `key ${madeUp} refused`, 'Bearer abc.def-123456', 'sk-ant-api03-' + 'Z'.repeat(20), 'gsk_' + 'Q'.repeat(30), 'xai-' + 'K'.repeat(30), 'AIza' + 'p'.repeat(35), '*******abc', 'nvapi-' + 'w'.repeat(20)]) {
            const redacted = redactKeyMaterial(text);
            expect(redacted, text).toContain('[key removed]');
            expect(redacted).not.toContain(madeUp);
        }
    });

    it('leaves ordinary error text alone', () => {
        for (const text of [
            'No endpoints found for baai/bge-m3',
            'Qwen/Qwen3-Embedding-8B not found',
            'Wrong input: Vector dimension error: expected dim: 1024, got 384',
            'fetch failed (cause: connect ECONNREFUSED 127.0.0.1:6333) [ECONNREFUSED]',
            'Custom embedding: 401 Unauthorized (the server refused the API key)',
        ]) {
            expect(redactKeyMaterial(text)).toBe(text);
        }
    });
});

describe('readErrorBody', () => {
    it('reads a failed reply with any key removed', async () => {
        expect(await readErrorBody(new Response(MASKED_ECHO, { status: 401 }))).not.toMatch(/sk-proj|Ab1C/);
    });

    it('gives the fallback for a body that cannot be read', async () => {
        const response = new Response('used once', { status: 500 });
        await response.text();
        expect(await readErrorBody(response, 'No response body')).toBe('No response body');
        expect(await readErrorBody(response)).toBe('');
    });
});
