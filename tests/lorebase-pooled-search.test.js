// Tests LoreBase's pooled search: one flat fused search per index, read in fused order, each entry keeping its best
// passages and the best cosine of the dense search beside it, a fixed number of entries per book, and every request
// scoped to the index's tenant. Qdrant is stubbed at the backend's one request function, so no server is needed.
//
//   npm test

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { TENANT_FIELD } from '../qdrant-backend.js';

const INDEX = 'vf_lorebase_qdrant_default_user_mushoku_1x2y';

function point(id, entryKey, passageIndex, score) {
    return { id, score, payload: { entryKey, entryUid: Number(entryKey.split('|')[1]), sectionName: 'BASICS', passageIndex, hash: 1000 + passageIndex } };
}

/** Answer the fused query with `fused` and the dense one with `dense`, recording both requests. */
function stubSearch(fused, dense) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test';
    qdrantBackend._request = async (method, endpoint, body) => {
        requests.push({ method, endpoint, body });
        return { result: { points: body.prefetch ? fused : dense } };
    };
    return requests;
}

afterEach(() => {
    delete qdrantBackend._request;
});

test('pools the fused order per entry, keeps each entry\'s best passages and best cosine, and stops at the entry limit', async () => {
    const fused = [
        point('a1', 'book|4', 0, 0.033), point('b1', 'book|7', 2, 0.031), point('a2', 'book|4', 3, 0.030),
        point('c1', 'book|9', 1, 0.029), point('a3', 'book|4', 5, 0.028), point('b2', 'book|7', 0, 0.027),
    ];
    const dense = [{ id: 'a2', score: 0.71 }, { id: 'a1', score: 0.62 }, { id: 'b1', score: 0.55 }];
    stubSearch(fused, dense);

    const entries = await qdrantBackend.pooledSearch(INDEX, [0.1, 0.2], { indices: [1], values: [1] }, { [TENANT_FIELD]: INDEX },
        { prefetchLimit: 50, entries: 2, passagesPerEntry: 2 });

    assert.deepEqual(entries.map(entry => entry.entryKey), ['book|4', 'book|7'], 'the third entry is past the limit');
    assert.deepEqual(entries[0].passages.map(passage => passage.passageIndex), [0, 3], 'two passages, in fused order');
    assert.equal(entries[0].cosine, 0.71, 'the entry carries its best passage cosine');
    assert.equal(entries[0].score, 0.033);
    assert.deepEqual(entries[1].passages.map(passage => passage.passageIndex), [2, 0]);
});

test('scopes both the fused and the dense search to the index\'s tenant, and never asks Qdrant to group', async () => {
    const requests = stubSearch([], []);

    await qdrantBackend.pooledSearch(INDEX, [0.1, 0.2], { indices: [1], values: [1] }, { [TENANT_FIELD]: INDEX });

    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.endpoint, `/collections/${INDEX}/points/query`);
        const filters = request.body.prefetch ? request.body.prefetch.map(leg => leg.filter) : [request.body.filter];
        for (const filter of filters) assert.deepEqual(filter.must, [{ key: TENANT_FIELD, match: { value: INDEX } }]);
    }
    assert.deepEqual(requests.find(request => request.body.prefetch).body.query, { fusion: 'rrf' });
});
