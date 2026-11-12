// Tests that no server reply and no part of a key leave the plugin: a failed reply becomes its status and a fixed hint
// that keeps the words VectFox reads, an error from SillyTavern's own embedding functions loses the reply it quotes,
// anything key-shaped is removed before the client sees it, and /qdrant/key-status returns no part of the key.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { errorFreeOfServerReply, errorWithoutServerReply, redactKeyMaterial, serverFailureText } from '../server-failure-text.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A made-up key, masked the way OpenAI's 401 quotes the key it refused.
const MASKED_ECHO = '{"error":{"message":"Incorrect API key provided: sk-proj-********************************Ab1C. You can find your API key at https://platform.openai.com/account/api-keys.","code":"invalid_api_key"}}';

// The words VectFox 3.6.39 reads to tell a model or setup error from the rest, as its model-http-errors.js has them.
const VECTFOX_MODEL_CONFIG_WORDS = /(deprecated|no endpoints?|no allowed providers?|not found|not_found|no such model|unknown model|invalid model|not a valid model|does not exist|doesn't exist)/i;
// And VectFox's key-refusal words (connection plan §4 row 4) and busy words (embedding-failure.js).
const VECTFOX_KEY_WORDS = /unauthorized|authorization|api key|api_key|apikey|authentication|credential/i;
const VECTFOX_BUSY_WORDS = /\b429\b|rate.?limit|too many requests|overloaded|over capacity|\bbusy\b|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|timed? ?out|timeout/i;

test('a refused key gives its status and the key hint, never the reply that quotes the key', () => {
    const text = serverFailureText({ status: 401, statusText: 'Unauthorized', reply: MASKED_ECHO });
    assert.equal(text, '401 Unauthorized (the server refused the API key)');
    assert.match(text, VECTFOX_KEY_WORDS);
});

test('a 401 earns the key hint by its status alone, whatever its reply says', () => {
    assert.equal(serverFailureText({ status: 401, statusText: 'Unauthorized', reply: '' }), '401 Unauthorized (the server refused the API key)');
    assert.equal(serverFailureText({ status: 401, reply: 'Access denied' }), '401 (the server refused the API key)');
    assert.equal(serverFailureText({ statusText: 'Unauthorized', reply: '<html>denied</html>' }), 'Unauthorized (the server refused the API key)');
});

test('a model error keeps a word VectFox reads as a setup error, on a 404 and on a 400', () => {
    for (const [status, statusText, reply] of [
        [404, 'Not Found', '{"error":"No endpoints found for baai/bge-m3"}'],
        [400, 'Bad Request', '{"error":{"message":"Invalid model: text-embedding-4"}}'],
        [400, 'Bad Request', 'The model `qwen-embed-9` does not exist'],
    ]) {
        const text = serverFailureText({ status, statusText, reply });
        assert.match(text, VECTFOX_MODEL_CONFIG_WORDS, `${status} ${reply}`);
        assert.equal(text.includes(reply), false);
        assert.equal(text.includes('bge-m3') || text.includes('qwen') || text.includes('text-embedding-4'), false);
    }
});

// The words VectFox 3.6.39 retries an embedding on (vector-api.js), matched as it matches them, in lower case.
const VECTFOX_RETRY_WORDS = ['network', 'timeout', 'timed out', 'failed to fetch', 'fetch', 'suspended', '429', 'rate limit', 'too many requests', '502', '503', '504'];
const isRetriedByVectFox = text => VECTFOX_RETRY_WORDS.some(word => text.toLowerCase().includes(word));

test('a busy or slow server keeps the words VectFox reads as busy and retries on', () => {
    for (const [status, statusText, reply] of [
        [429, 'Too Many Requests', 'slow down'],
        [500, 'Internal Server Error', 'Rate limit exceeded for this model'],
        [500, 'Internal Server Error', 'model is overloaded, try again'],
        [500, 'Internal Server Error', 'upstream request timed out'],
        [500, 'Internal Server Error', 'Gateway timeout talking to the model'],
    ]) {
        const text = serverFailureText({ status, statusText, reply });
        assert.match(text, VECTFOX_BUSY_WORDS, reply);
        assert.ok(isRetriedByVectFox(text), `${reply} -> ${text}`);
    }
    // As SillyTavern's own functions give it, with a status text and no code.
    assert.ok(isRetriedByVectFox(errorWithoutServerReply(new Error('VLLM: Failed to get vector for text: Internal Server Error rate limit hit')).message));
});

test('a refused key or a missing model is not retried, as before', () => {
    assert.equal(isRetriedByVectFox(serverFailureText({ status: 401, statusText: 'Unauthorized', reply: MASKED_ECHO })), false);
    assert.equal(isRetriedByVectFox(serverFailureText({ status: 404, statusText: 'Not Found', reply: 'No endpoints found for baai/bge-m3' })), false);
});

test('any other failure gives its status alone', () => {
    assert.equal(serverFailureText({ status: 400, statusText: 'Bad Request', reply: 'input too long' }), '400 Bad Request');
    assert.equal(serverFailureText({}), '');
});

test('an error from SillyTavern\'s own embedding functions loses the reply it quotes', () => {
    const fromSillyTavern = new Error(`VLLM: Failed to get vector for text: Unauthorized ${MASKED_ECHO}`);
    const error = errorWithoutServerReply(fromSillyTavern);
    assert.equal(error.message, 'VLLM: Failed to get vector for text: Unauthorized (the server refused the API key)');
    assert.equal(error.cause, undefined);

    const batch = errorWithoutServerReply(new Error('Ollama: Failed to get batch vectors: Not Found {"error":"model \\"nomic\\" not found"}'));
    assert.equal(batch.message, 'Ollama: Failed to get batch vectors: Not Found (the server says the model was not found or is not valid)');

    const bare = errorWithoutServerReply(new Error('LlamaCpp: Failed to get vector for text:  '));
    assert.equal(bare.message, 'LlamaCpp: Failed to get vector for text');
});

test('an error of another shape keeps its words, with anything key-shaped removed', () => {
    assert.equal(errorWithoutServerReply(new Error('API request failed')).message, 'API request failed');
    const leaked = errorWithoutServerReply(new Error(`Upstream said ${MASKED_ECHO}`));
    assert.equal(/sk-proj|Ab1C|\*{3}/.test(leaked.message), false);
});

test('an error the plugin built without a reply passes as it is', () => {
    const own = errorFreeOfServerReply('Custom embedding: 401 Unauthorized (the server refused the API key)');
    assert.equal(errorWithoutServerReply(own), own);
});

test('key shapes are removed, and ordinary error text is not', () => {
    const made = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);
    for (const text of [made, `key ${made} was refused`, 'Bearer abc.def-123456', 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ', 'gsk_' + 'Q'.repeat(30), 'xai-' + 'K'.repeat(30), '*******abc', 'nvapi-' + 'w'.repeat(20)]) {
        const redacted = redactKeyMaterial(text);
        assert.ok(redacted.includes('[key removed]'), text);
        assert.equal(redacted.includes(made), false);
    }
    for (const text of ['No endpoints found for baai/bge-m3', 'Qwen/Qwen3-Embedding-8B not found', 'Wrong input: Vector dimension error: expected dim: 1024, got 384', 'fetch failed (cause: connect ECONNREFUSED 127.0.0.1:6333) [ECONNREFUSED]']) {
        assert.equal(redactKeyMaterial(text), text);
    }
});

test('/qdrant/key-status returns a fixed mark, never part of the key, and formatError redacts', () => {
    const index = readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8');
    assert.match(index, /const KEY_SAVED_MARK = '\*+';/);
    assert.match(index, /return res\.json\(\{ set: true, masked: KEY_SAVED_MARK \}\);/);
    assert.equal(/_maskApiKey|apiKey\.slice\(|key\.slice\(-/.test(index), false);
    assert.match(index, /return redactKeyMaterial\(msg\);/);
});
