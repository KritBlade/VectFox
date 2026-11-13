// Tests that the Qdrant backend learns a collection's chunk count with one exact count request instead of scrolling
// every point and its payload, and that the listing's embedding-source fallback reads a single point. Qdrant is stubbed
// at the backend's one request function, so no server is needed, and every test names the requests that would be sent.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend from '../qdrant-backend.js';

const COLLECTION = 'ollama:chat_1';
// Qdrant stores the collection without the source prefix VectFox names it by.
const STORED = 'chat_1';
const SENTINEL_EXCLUSION = { key: 'type', match: { value: '_vectfox_meta' } };

/** Answer each request from the list in order, recording the method, endpoint and body it carried. */
function stubQdrant(answers) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend._request = async (method, endpoint, body = null) => {
        requests.push({ method, endpoint, body });
        const answer = answers.shift();
        if (!answer) throw new Error(`unexpected request: ${method} ${endpoint}`);
        return answer();
    };
    return requests;
}

afterEach(() => {
    delete qdrantBackend._request;
    qdrantBackend.baseUrl = null;
});

test('an empty collection counts zero, from one count request', async () => {
    const requests = stubQdrant([() => ({ result: { count: 0 } })]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 0);
    assert.deepEqual(requests, [{
        method: 'POST',
        endpoint: `/collections/${STORED}/points/count`,
        body: { filter: { must_not: [SENTINEL_EXCLUSION] }, exact: true },
    }]);
});

test('one chunk counts one, and many count the number Qdrant returns', async () => {
    const requests = stubQdrant([() => ({ result: { count: 1 } }), () => ({ result: { count: 1382 } })]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 1);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 1382);
    assert.equal(requests.length, 2);
});

test('the count is exact and excludes the sentinel point, and no point is read', async () => {
    const requests = stubQdrant([() => ({ result: { count: 7 } })]);
    await qdrantBackend.countPoints(COLLECTION, { type: 'chat', sourceId: 'chat_1' });
    assert.deepEqual(requests, [{
        method: 'POST',
        endpoint: `/collections/${STORED}/points/count`,
        body: {
            filter: {
                must: [
                    { key: 'type', match: { value: 'chat' } },
                    { key: 'sourceId', match: { value: 'chat_1' } },
                ],
                must_not: [SENTINEL_EXCLUSION],
            },
            exact: true,
        },
    }]);
});

test('a collection that is gone reads as no collection, so the listing can leave it out', async () => {
    const requests = stubQdrant([
        () => { throw new Error(`Qdrant POST /collections/${STORED}/points/count failed: 404 Collection \`${STORED}\` doesn't exist!`); },
        () => { throw new Error(`Qdrant GET /collections/${STORED} failed: 404 Collection \`${STORED}\` doesn't exist!`); },
    ]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), null);
    assert.deepEqual(requests.map(({ method, endpoint }) => `${method} ${endpoint}`), [
        `POST /collections/${STORED}/points/count`,
        `GET /collections/${STORED}`,
    ]);
});

test('a count route that is not there, though the collection is, reads as zero rather than as a deleted library', async () => {
    const requests = stubQdrant([
        () => { throw new Error(`Qdrant POST /collections/${STORED}/points/count failed: 404 Not Found`); },
        () => ({ result: { status: 'green', points_count: 12 } }),
    ]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 0);
    assert.deepEqual(requests.map(({ method, endpoint }) => `${method} ${endpoint}`), [
        `POST /collections/${STORED}/points/count`,
        `GET /collections/${STORED}`,
    ]);
});

test('a count that comes back without a number reads as zero and warns, not as a silent count', async () => {
    stubQdrant([() => ({ result: { status: 'ok' } })]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 0);
});

test('a failing backend reports zero and throws nothing, so the listing still answers', async () => {
    stubQdrant([() => { throw new Error(`Qdrant POST /collections/${STORED}/points/count failed: 503 Service Unavailable`); }]);
    assert.equal(await qdrantBackend.countPoints(COLLECTION), 0);
});

test('the source fallback reads one point and asks only for the source field', async () => {
    const requests = stubQdrant([() => ({
        result: { points: [{ id: 7, payload: { embeddingSource: 'openai' } }], next_page_offset: 7 },
    })]);
    assert.equal(await qdrantBackend.firstPointSource(COLLECTION), 'openai');
    // A next_page_offset is answered too: the fallback must not walk the collection. The payload selector
    // keeps the body at ~131 B, which Qdrant answers in about 1 ms instead of the ~40 ms a gzipped full point costs.
    assert.deepEqual(requests, [{
        method: 'POST',
        endpoint: `/collections/${STORED}/points/scroll`,
        body: { limit: 1, with_payload: ['embeddingSource'], with_vector: false, filter: { must_not: [SENTINEL_EXCLUSION] } },
    }]);
});

test('an empty collection, or a first point carrying no source, reads as unknown', async () => {
    stubQdrant([
        () => ({ result: { points: [] } }),
        () => ({ result: { points: [{ id: 1, payload: {} }] } }),
    ]);
    assert.equal(await qdrantBackend.firstPointSource(COLLECTION), 'unknown');
    assert.equal(await qdrantBackend.firstPointSource(COLLECTION), 'unknown');
});

test('a failed point read reads as unknown and throws nothing', async () => {
    stubQdrant([() => { throw new Error(`Qdrant POST /collections/${STORED}/points/scroll failed: 500 Internal Server Error`); }]);
    assert.equal(await qdrantBackend.firstPointSource(COLLECTION), 'unknown');
});
