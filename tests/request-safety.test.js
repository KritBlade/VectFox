// Tests the guards on a request that carries a key: a header value holding a control character is refused before
// Node can quote it, by the header's name only; and a redirect is followed only on the host the request was sent to,
// so Qdrant's api-key header never reaches another host.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSendableHeaders, fetchOnSameHost } from '../request-safety.js';

const MADE_UP_KEY = 'made-up-qdrant-key-7Hq2';

test('a header value with a line break inside is refused by its name, without its value', () => {
    for (const value of [`made-up\n${MADE_UP_KEY}`, `Bearer ${MADE_UP_KEY}\r\nX-Other: 1`, `${MADE_UP_KEY}\u0000`, `${MADE_UP_KEY}\u007f`, `${MADE_UP_KEY}\u0001\n`]) {
        assert.throws(() => assertSendableHeaders({ 'Content-Type': 'application/json', 'api-key': value }, 'Qdrant'), (error) => {
            assert.equal(error.message.includes(MADE_UP_KEY), false);
            assert.match(error.message, /^Qdrant: the api-key header holds a line break or another control character/);
            return true;
        });
    }
});

test('ordinary header values, a tab included, pass', () => {
    assertSendableHeaders({ 'api-key': MADE_UP_KEY, Authorization: `Bearer\t${MADE_UP_KEY}`, 'Content-Type': 'application/json' }, 'Qdrant');
    assertSendableHeaders(undefined, 'Qdrant');
});

test('line breaks, tabs and spaces at either end pass, as Node trims them and sends the rest', () => {
    for (const value of [`${MADE_UP_KEY}\n`, `${MADE_UP_KEY}\r\n`, `\r\n ${MADE_UP_KEY}`, ` \t${MADE_UP_KEY}\t `]) {
        assertSendableHeaders({ 'api-key': value }, 'Qdrant');
    }
});

/** A fetch that answers from a list, recording each call. */
function scriptedFetch(answers) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers, redirect: init.redirect });
        const answer = answers.shift();
        return { status: answer.status, headers: new Headers(answer.headers ?? {}), body: null, ok: answer.status < 300 };
    };
    return { calls, fetchImpl };
}

test('a redirect on the same host is followed, with the key header, as fetch would', async () => {
    const { calls, fetchImpl } = scriptedFetch([
        { status: 308, headers: { location: 'https://qdrant.lan:443/collections' } },
        { status: 200 },
    ]);
    const response = await fetchOnSameHost(fetchImpl, 'http://qdrant.lan:6333/collections', { method: 'PUT', body: '{"a":1}', headers: { 'api-key': MADE_UP_KEY } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map(call => [call.url, call.method, call.body, call.redirect]), [
        ['http://qdrant.lan:6333/collections', 'PUT', '{"a":1}', 'manual'],
        ['https://qdrant.lan/collections', 'PUT', '{"a":1}', 'manual'],
    ]);
    assert.equal(calls[1].headers['api-key'], MADE_UP_KEY);
});

test('a 301 turns a POST into a GET with no body, and a 303 any method but HEAD', async () => {
    const moved = scriptedFetch([{ status: 301, headers: { location: '/next' } }, { status: 200 }]);
    await fetchOnSameHost(moved.fetchImpl, 'http://10.0.1.249:6333/points', { method: 'POST', body: '{}' });
    assert.deepEqual([moved.calls[1].url, moved.calls[1].method, moved.calls[1].body], ['http://10.0.1.249:6333/next', 'GET', undefined]);

    const seeOther = scriptedFetch([{ status: 303, headers: { location: '/next' } }, { status: 200 }]);
    await fetchOnSameHost(seeOther.fetchImpl, 'http://10.0.1.249:6333/points', { method: 'PUT', body: '{}' });
    assert.equal(seeOther.calls[1].method, 'GET');
});

test('a redirect to another host is refused before anything is sent there, naming only its origin', async () => {
    const { calls, fetchImpl } = scriptedFetch([{ status: 302, headers: { location: 'https://elsewhere.example:8443/steal?x=1' } }]);
    await assert.rejects(fetchOnSameHost(fetchImpl, 'http://10.0.1.249:6333/collections', { method: 'GET', headers: { 'api-key': MADE_UP_KEY } }), (error) => {
        assert.match(error.message, /redirect to https:\/\/elsewhere\.example:8443, another host/);
        assert.equal(error.message.includes('steal'), false);
        return true;
    });
    assert.equal(calls.length, 1);
});

test('a reply that is not a redirect returns at once, and endless redirects stop', async () => {
    const plain = scriptedFetch([{ status: 404 }]);
    assert.equal((await fetchOnSameHost(plain.fetchImpl, 'http://qdrant.lan:6333/x', {})).status, 404);

    const loop = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 307, headers: { location: '/again' } })));
    await assert.rejects(fetchOnSameHost(loop.fetchImpl, 'http://qdrant.lan:6333/x', {}), /redirected more than 5 times/);
});
