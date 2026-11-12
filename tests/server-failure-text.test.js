// Tests that no server reply and no part of a key leave the plugin: a failed reply becomes its status and fixed hints
// that keep the words released VectFox reads, an error from SillyTavern's own embedding functions loses the reply it
// quotes, anything key-shaped is removed before the client sees it, and /qdrant/key-status returns no part of the key.
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

// What released VectFox reads in the text, the same in 3.6.17 (main) and 3.6.39 (Dev): model-http-errors.js's setup
// words, vector-api.js's retry words, matched in lower case, and model-config-notifier.js's isConnectionError.
const VECTFOX_MODEL_CONFIG_WORDS = /(deprecated|no endpoints?|no allowed providers?|not found|not_found|no such model|unknown model|invalid model|not a valid model|does not exist|doesn't exist)/i;
const VECTFOX_RETRY_WORDS = ['network', 'timeout', 'timed out', 'failed to fetch', 'fetch', 'suspended', '429', 'rate limit', 'too many requests', '502', '503', '504'];
const isRetriedByVectFox = text => VECTFOX_RETRY_WORDS.some(word => text.toLowerCase().includes(word));
const VECTFOX_CONNECTION_WORDS = /econnrefused|enotfound|eai_again|econnreset|etimedout|ehostunreach|enetunreach|epipe|getaddrinfo|fetch failed|failed to fetch|socket hang up|connection refused|refused to connect|could not connect|err_invalid_url|invalid url|err_connection|net::err|network ?error|connection error|dns lookup/i;
// And VectFox's key-refusal words (connection plan §4 row 4) and busy words (embedding-failure.js), from 3.6.128.
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

test('every hint a reply earns is given, in a fixed order', () => {
    assert.equal(serverFailureText({ status: 401, statusText: 'Unauthorized', reply: '{"error":{"message":"User not found.","code":401}}' }),
        '401 Unauthorized (the server refused the API key and says the model was not found or is not valid)');
    assert.equal(serverFailureText({ status: 500, reply: 'overloaded, the upstream timed out: fetch failed' }),
        '500 (the server is busy or hit a rate limit, timed out and reports a network error)');
});

test('a busy, slow or unreachable server keeps the words VectFox reads as busy and retries on', () => {
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
    const unreachable = serverFailureText({ status: 500, statusText: 'Internal Server Error', reply: '{"error":"litellm.APIConnectionError: Connection error."}' });
    assert.equal(unreachable, '500 Internal Server Error (the server reports a network error)');
    assert.ok(isRetriedByVectFox(unreachable));
    assert.match(unreachable, VECTFOX_CONNECTION_WORDS);
});

test('a refused key or a missing model is not retried, as before', () => {
    assert.equal(isRetriedByVectFox(serverFailureText({ status: 401, statusText: 'Unauthorized', reply: MASKED_ECHO })), false);
    assert.equal(isRetriedByVectFox(serverFailureText({ status: 404, statusText: 'Not Found', reply: 'No endpoints found for baai/bge-m3' })), false);
});

test('any other failure gives its status alone', () => {
    assert.equal(serverFailureText({ status: 400, statusText: 'Bad Request', reply: 'input too long' }), '400 Bad Request');
    assert.equal(serverFailureText({}), '');
});

test('an error from SillyTavern\'s own embedding functions loses the reply it quotes, and gets its code back', () => {
    const fromSillyTavern = new Error(`VLLM: Failed to get vector for text: Unauthorized ${MASKED_ECHO}`);
    const error = errorWithoutServerReply(fromSillyTavern);
    assert.equal(error.message, 'VLLM: Failed to get vector for text: 401 Unauthorized (the server refused the API key)');
    assert.equal(error.cause, undefined);

    const batch = errorWithoutServerReply(new Error('Ollama: Failed to get batch vectors: Not Found {"error":"model \\"nomic\\" not found"}'));
    assert.equal(batch.message, 'Ollama: Failed to get batch vectors: 404 Not Found (the server says the model was not found or is not valid)');

    const gateway = errorWithoutServerReply(new Error('VLLM: Failed to get vector for text: Bad Gateway <html><title>502 Bad Gateway</title><center>nginx</center></html>'));
    assert.equal(gateway.message, 'VLLM: Failed to get vector for text: 502 Bad Gateway');

    const bare = errorWithoutServerReply(new Error('LlamaCpp: Failed to get vector for text:  '));
    assert.equal(bare.message, 'LlamaCpp: Failed to get vector for text');
});

test('nginx\'s own reason phrases give their codes, and another phrase takes its code from the error page', () => {
    const quote = (phrase, page) => errorWithoutServerReply(new Error(`VLLM: Failed to get vector for text: ${phrase} ${page}`)).message;
    assert.equal(quote('Service Temporarily Unavailable', nginxPage(503, 'Service Temporarily Unavailable')), 'VLLM: Failed to get vector for text: 503 Service Temporarily Unavailable');
    assert.equal(quote('Gateway Time-out', nginxPage(504, 'Gateway Time-out')), 'VLLM: Failed to get vector for text: 504 Gateway Time-out (the server timed out)');
    assert.equal(quote('Not Allowed', nginxPage(405, 'Not Allowed')), 'VLLM: Failed to get vector for text: 405 Not Allowed');
    // The server's own phrase stays with the reply, which is never passed on.
    assert.equal(quote('Down for maintenance', '<html><head><title>503 Service Unavailable</title></head></html>'), 'VLLM: Failed to get vector for text: 503');
    assert.equal(quote('Down for maintenance', 'come back later'), 'VLLM: Failed to get vector for text');
});

// nginx's own error page, as it serves it when it answers a request itself, with its own reason phrase.
const nginxPage = (code, phrase) => `<html>\r\n<head><title>${code} ${phrase}</title></head>\r\n<body>\r\n<center><h1>${code} ${phrase}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;

// Replies a server can give, as SillyTavern's own functions quote them and as the plugin's own requests see them.
const FAILED_REPLIES = [
    [503, 'Service Temporarily Unavailable', nginxPage(503, 'Service Temporarily Unavailable')],
    [504, 'Gateway Time-out', nginxPage(504, 'Gateway Time-out')],
    [408, 'Request Time-out', nginxPage(408, 'Request Time-out')],
    [405, 'Not Allowed', nginxPage(405, 'Not Allowed')],
    [413, 'Request Entity Too Large', nginxPage(413, 'Request Entity Too Large')],
    [503, 'Down for maintenance', '<html><head><title>503 Service Unavailable</title></head><body>Back soon.</body></html>'],
    [502, 'Bad Gateway', '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>'],
    [502, 'Bad Gateway', ''],
    [503, 'Service Unavailable', '<!DOCTYPE html><title>503 Service Temporarily Unavailable</title>'],
    [503, 'Service Unavailable', '{"code":50505,"message":"Model service overloaded. Please try again later."}'],
    [504, 'Gateway Timeout', '<html><body><h1>504 Gateway Time-out</h1>The server didn\'t respond in time.</body></html>'],
    [429, 'Too Many Requests', '{"error":"Rate limit reached for requests"}'],
    [400, 'Bad Request', '{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}'],
    [404, 'Not Found', '{"object":"error","message":"The model `bge-m3` does not exist.","type":"NotFoundError","param":null,"code":404}'],
    [404, 'Not Found', '{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}'],
    [401, 'Unauthorized', '{"error":{"message":"User not found.","code":401}}'],
    [401, 'Unauthorized', MASKED_ECHO],
    [500, 'Internal Server Error', '{"error":{"message":"litellm.APIConnectionError: Connection error.","type":null,"param":null,"code":"500"}}'],
    [500, 'Internal Server Error', '{"error":"fetch failed"}'],
    [500, 'Internal Server Error', '{"error":"upstream request timed out"}'],
    [500, 'Internal Server Error', '{"error":"connect ECONNREFUSED 10.0.0.7:8000"}'],
    [400, 'Bad Request', '{"object":"error","message":"This model\'s maximum context length is 8192 tokens. However, you requested 9000 tokens.","type":"BadRequestError","code":400}'],
    [500, 'Internal Server Error', '{"error":{"code":500,"message":"input is too large to process. increase the physical batch size","type":"server_error"}}'],
    [500, 'Internal Server Error', ''],
];

test('released VectFox loses no setup error, retry or connection error it read in the reply', () => {
    for (const [status, statusText, reply] of FAILED_REPLIES) {
        // What the plugin passed on before 3.4.4, then what it passes on now, from SillyTavern's functions and its own.
        const quoted = `VLLM: Failed to get vector for text: ${statusText} ${reply}`;
        for (const passedOn of [
            errorWithoutServerReply(new Error(quoted)).message,
            `VLLM: Failed to get vector for text: ${serverFailureText({ status, statusText, reply })}`,
        ]) {
            const label = `${status} ${reply.slice(0, 60)} -> ${passedOn}`;
            assert.equal(VECTFOX_MODEL_CONFIG_WORDS.test(passedOn), VECTFOX_MODEL_CONFIG_WORDS.test(quoted), `setup error: ${label}`);
            if (isRetriedByVectFox(quoted)) assert.ok(isRetriedByVectFox(passedOn), `retry: ${label}`);
            if (VECTFOX_CONNECTION_WORDS.test(quoted)) assert.match(passedOn, VECTFOX_CONNECTION_WORDS, `connection: ${label}`);
            if ([429, 502, 503, 504].includes(status)) assert.ok(isRetriedByVectFox(passedOn), `retried by its status: ${label}`);
            if (reply) assert.equal(passedOn.includes(reply), false, `reply quoted: ${label}`);
        }
    }
});

test('an error of another shape keeps its words and its cause, with anything key-shaped removed', () => {
    assert.equal(errorWithoutServerReply(new Error('API request failed')).message, 'API request failed');
    const leaked = errorWithoutServerReply(new Error(`Upstream said ${MASKED_ECHO}`));
    assert.equal(/sk-proj|Ab1C|\*{3}/.test(leaked.message), false);

    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:8000'), { code: 'ECONNREFUSED' });
    const network = errorWithoutServerReply(new TypeError('fetch failed', { cause: refused }));
    assert.equal(network.message, 'fetch failed');
    assert.equal(network.cause, refused);
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
    for (const text of ['No endpoints found for baai/bge-m3', 'Qwen/Qwen3-Embedding-8B not found', 'Wrong input: Vector dimension error: expected dim: 1024, got 384', 'fetch failed (cause: connect ECONNREFUSED 127.0.0.1:6333) [ECONNREFUSED]', 'see https://example.test/v1/embeddings or mail ops@example.test']) {
        assert.equal(redactKeyMaterial(text), text);
    }
});

test('a header value Node quotes when it refuses it is removed whole, a line break inside included', () => {
    // As Node 24's fetch words it for a key holding a line break.
    const quoted = 'Headers.append: "Bearer made-up-key-first\nmade-up-key-rest" is an invalid header value.';
    assert.equal(redactKeyMaterial(quoted), 'Headers.append: "[key removed]" is an invalid header value.');
});

test('the user and password written into a URL are removed, and the host kept', () => {
    assert.equal(redactKeyMaterial('Request cannot be constructed from a URL that includes credentials: https://ops:made-up-pass@vllm.example.test/v1/embeddings'),
        'Request cannot be constructed from a URL that includes credentials: https://[key removed]@vllm.example.test/v1/embeddings');
});

test('a long reply with no key in it is read in linear time', () => {
    const started = performance.now();
    redactKeyMaterial(`${'A'.repeat(50_000)} "${'b'.repeat(50_000)} ${'//c'.repeat(20_000)}`);
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

test('/qdrant/key-status returns a fixed mark, never part of the key, and formatError redacts', () => {
    const index = readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8');
    assert.match(index, /const KEY_SAVED_MARK = '\*+';/);
    assert.match(index, /return res\.json\(\{ set: true, masked: KEY_SAVED_MARK \}\);/);
    assert.equal(/_maskApiKey|apiKey\.slice\(|key\.slice\(-/.test(index), false);
    assert.match(index, /return redactKeyMaterial\(msg\);/);
});
