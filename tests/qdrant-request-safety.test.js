// Tests that the Qdrant backend's one request function keeps the API key on the Qdrant host the user entered: a key
// holding a control character is refused before any request, and a redirect is followed only on that host. Node's
// fetch is stubbed, so no server is needed.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend from '../qdrant-backend.js';

const realFetch = globalThis.fetch;
const MADE_UP_KEY = 'made-up-qdrant-key-7Hq2';

/** Answer each request from the list, recording its URL and the key header it carried. */
function stubFetch(answers) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), key: init.headers['api-key'], redirect: init.redirect });
        return answers.shift()();
    };
    return seen;
}

afterEach(() => {
    globalThis.fetch = realFetch;
    qdrantBackend.apiKey = null;
});

test('a Qdrant key with a line break inside is refused before any request, without its value', async () => {
    const seen = stubFetch([() => new Response('{}')]);
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend.apiKey = `made-up\n${MADE_UP_KEY}`;
    await assert.rejects(qdrantBackend._request('GET', '/collections', null, 0), (error) => {
        assert.match(error.message, /^Qdrant: the api-key header holds a line break/);
        assert.equal(error.message.includes(MADE_UP_KEY), false);
        return true;
    });
    assert.equal(seen.length, 0);
});

test('a Qdrant key ending in a line break is sent, as before 3.4.4, for Node trims it', async () => {
    const seen = stubFetch([() => new Response('{"result":{"collections":[]}}')]);
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend.apiKey = `${MADE_UP_KEY}\r\n`;
    await qdrantBackend._request('GET', '/collections', null, 0);
    assert.equal(seen.length, 1);
});

test('a redirect to another host is refused, and the key reaches no other host', async () => {
    const seen = stubFetch([() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/collections' } })]);
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend.apiKey = MADE_UP_KEY;
    await assert.rejects(qdrantBackend._request('GET', '/collections', null, 0), /redirect to https:\/\/elsewhere\.example, another host/);
    assert.deepEqual(seen.map(each => [each.url, each.redirect]), [['http://qdrant.test:6333/collections', 'manual']]);
});

test('a redirect on the same host, such as http to https, is followed with the key', async () => {
    const seen = stubFetch([
        () => new Response(null, { status: 308, headers: { location: 'https://qdrant.test/collections' } }),
        () => new Response('{"result":{"collections":[]}}', { status: 200 }),
    ]);
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend.apiKey = MADE_UP_KEY;
    assert.deepEqual(await qdrantBackend._request('GET', '/collections', null, 0), { result: { collections: [] } });
    assert.deepEqual(seen.map(each => [each.url, each.key]), [
        ['http://qdrant.test:6333/collections', MADE_UP_KEY],
        ['https://qdrant.test/collections', MADE_UP_KEY],
    ]);
});
