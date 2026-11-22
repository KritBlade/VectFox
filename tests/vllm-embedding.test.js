// Tests embedding on vLLM: the texts go at most 32 to a request, and the embeddings come back in the order of the
// texts. With no key in the request each batch goes through SillyTavern's own getVllmBatchVector, which sends the saved
// vLLM key, and a key the request gives is sent in its place. A refusal says what one text's refusal says. SillyTavern
// is stubbed as its 1.19.0 code behaves.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVllmEmbeddings } from '../vllm-embedding.js';
import { OPENAI_STYLE_BATCH_LIMIT } from '../openai-style-embedding.js';

const DIRECTORIES = { root: '/st/data/default-user' };
const SERVER_URL = 'https://embed.example.test/v1';
const MODEL = 'BAAI/bge-m3';
const REQUEST_KEY = 'made-up-request-key';

/** An embedding that names its text by the text's length, so the order shows. */
const embeddingOf = text => [text.length, 0.5];

/** A reply of one embedding per text in OpenAI's shape, listed in the order `order` gives. */
function embeddingsReply(input, order = items => items) {
    const data = input.map((text, index) => ({ index, embedding: embeddingOf(text) }));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: order(data) }), text: async () => '' };
}

/** SillyTavern as the plugin sees it, recording each batch its vLLM function gets and each request sent here. */
function stubSillyTavern({ savedKeyBatch, reply = embeddingsReply } = {}) {
    const savedKeyBatches = [];
    const requests = [];
    const host = {
        // As SillyTavern 1.19.0's getVllmBatchVector: one request for every text it gets, with the saved vLLM key,
        // the embeddings sorted by index.
        getVllmBatchVector: async (texts, apiUrl, model, directories) => {
            savedKeyBatches.push({ texts, apiUrl, model, directories });
            return savedKeyBatch ? savedKeyBatch(texts) : texts.map(embeddingOf);
        },
        // SillyTavern 1.19.0's util.js trimV1, and url-join for the paths these tests use.
        trimV1: str => String(str ?? '').replace(/\/$/, '').replace(/\/v1$/, ''),
        urlJoin: (base, route) => `${base.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`,
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            requests.push({ url: String(url), headers: init.headers, body });
            return reply(body.input);
        },
    };
    return { host, savedKeyBatches, requests };
}

const embed = (texts, request, host) => getVllmEmbeddings(texts, { apiUrl: SERVER_URL, model: MODEL, directories: DIRECTORIES, ...request }, host);
const textsOf = count => Array.from({ length: count }, (_, place) => `lantern ${'x'.repeat(place)}`);

test('three texts make one request with the saved key, the embeddings in the order of the texts', async () => {
    const { host, savedKeyBatches, requests } = stubSillyTavern();
    const texts = ['a harbor at dusk', 'lanterns on the pier', 'a ship leaves'];
    const embeddings = await embed(texts, {}, host);
    assert.deepEqual(savedKeyBatches, [{ texts, apiUrl: SERVER_URL, model: MODEL, directories: DIRECTORIES }]);
    assert.equal(requests.length, 0);
    assert.deepEqual(embeddings, texts.map(embeddingOf));
});

test(`a batch splits at ${OPENAI_STYLE_BATCH_LIMIT} texts and comes back in order`, async () => {
    const { host, savedKeyBatches } = stubSillyTavern();
    const texts = textsOf(70);
    const embeddings = await embed(texts, {}, host);
    assert.deepEqual(savedKeyBatches.map(batch => batch.texts.length), [32, 32, 6]);
    assert.deepEqual(savedKeyBatches.flatMap(batch => batch.texts), texts);
    assert.deepEqual(embeddings, texts.map(embeddingOf));
});

test('one text makes one request, as the single-text routes send it', async () => {
    const { host, savedKeyBatches } = stubSillyTavern();
    const embeddings = await embed(['a harbor at dusk'], {}, host);
    assert.deepEqual(savedKeyBatches.map(batch => batch.texts), [['a harbor at dusk']]);
    assert.deepEqual(embeddings, [embeddingOf('a harbor at dusk')]);
});

test('no texts send nothing', async () => {
    const { host, savedKeyBatches, requests } = stubSillyTavern();
    assert.deepEqual(await embed([], {}, host), []);
    assert.equal(savedKeyBatches.length + requests.length, 0);
});

test('a key in the request is sent in its batches on /v1/embeddings, and the saved key is not used', async () => {
    const { host, savedKeyBatches, requests } = stubSillyTavern({ reply: input => embeddingsReply(input, items => [...items].reverse()) });
    const texts = textsOf(40);
    const embeddings = await embed(texts, { apiKey: REQUEST_KEY }, host);
    assert.equal(savedKeyBatches.length, 0);
    assert.deepEqual(requests.map(request => request.body.input.length), [32, 8]);
    for (const request of requests) {
        assert.equal(request.url, 'https://embed.example.test/v1/embeddings');
        assert.equal(request.headers.Authorization, `Bearer ${REQUEST_KEY}`);
        assert.equal(request.body.model, MODEL);
    }
    assert.deepEqual(embeddings, texts.map(embeddingOf));
});

test('a refusal through the saved key says what one text\'s refusal says, never the server\'s reply', async () => {
    const echo = '{"error":{"message":"Incorrect API key provided: sk-proj-************Ab1C"}}';
    const { host } = stubSillyTavern({
        savedKeyBatch: () => { throw new Error(`VLLM: Failed to get vector for text: Unauthorized ${echo}`); },
    });
    await assert.rejects(embed(textsOf(3), {}, host), { message: 'VLLM: Failed to get vector for text: 401 Unauthorized (the server refused the API key)' });
});

test('a refusal of the request\'s key gives its status and a fixed hint, never the server\'s reply', async () => {
    const echo = '{"error":{"message":"Incorrect API key provided: made-up-request-key"}}';
    const refusal = () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => echo });
    const { host, requests } = stubSillyTavern({ reply: refusal });
    await assert.rejects(embed(textsOf(40), { apiKey: REQUEST_KEY }, host), { message: 'VLLM: Failed to get vector for text: 401 Unauthorized (the server refused the API key)' });
    assert.equal(requests.length, 1);
});

test('a network failure keeps its cause, which names the address and the reason', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:8000'), { code: 'ECONNREFUSED' });
    const { host } = stubSillyTavern({ reply: () => { throw new TypeError('fetch failed', { cause }); } });
    await assert.rejects(embed(textsOf(2), { apiKey: REQUEST_KEY }, host), (error) => {
        assert.equal(error.message, 'fetch failed');
        assert.equal(error.cause, cause);
        return true;
    });
});

test('a reply without one embedding per text throws, so no embedding lands on the wrong text', async () => {
    const short = stubSillyTavern({ savedKeyBatch: texts => texts.slice(1).map(embeddingOf) });
    await assert.rejects(embed(textsOf(3), {}, short.host), { message: 'VLLM: the server returned 2 embeddings for 3 texts.' });

    const extra = stubSillyTavern({ savedKeyBatch: texts => [...texts, 'one more'].map(embeddingOf) });
    await assert.rejects(embed(textsOf(3), {}, extra.host), { message: 'VLLM: the server returned 4 embeddings for 3 texts.' });

    const missing = stubSillyTavern({ reply: input => embeddingsReply(input, items => items.map((item, place) => (place === 1 ? { index: 1 } : item))) });
    await assert.rejects(embed(textsOf(3), { apiKey: REQUEST_KEY }, missing.host), { message: 'VLLM: the server returned 2 embeddings for 3 texts.' });

    const notOpenAiStyle = stubSillyTavern({ reply: () => ({ ok: true, status: 200, json: async () => ({ embedding: [0.1] }) }) });
    await assert.rejects(embed(textsOf(1), { apiKey: REQUEST_KEY }, notOpenAiStyle.host), { message: 'VLLM: API response was not an array' });
});

test('a request key holding a line break is refused before any request, by the header\'s name only', async () => {
    const { host, requests } = stubSillyTavern();
    await assert.rejects(embed(textsOf(2), { apiKey: 'made-up-key\nX-Injected: 1' }, host), (error) => {
        assert.match(error.message, /^vLLM: the Authorization header holds a line break/);
        assert.equal(error.message.includes('made-up-key'), false);
        return true;
    });
    assert.equal(requests.length, 0);
});
