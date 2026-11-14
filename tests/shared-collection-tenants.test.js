// Tests that VectFox's collections inside the shared "vectfox_main" stay apart: every read, count, change and delete
// scopes to the tenant field `content_type`, a purge that names no tenant deletes nothing, discovery lists each tenant
// as a collection of its own, and an insert takes a point ID the client chose. Qdrant is stubbed at the backend's one
// request function, so no server is needed.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { TENANT_FIELD } from '../qdrant-backend.js';

const SHARED = 'vectfox_main';
const TENANT = 'vf_eventbase_qdrant_tester_chat_a';
const tenantClause = { key: TENANT_FIELD, match: { value: TENANT } };

/**
 * Answer the backend's requests as a Qdrant holding the named collections, and record each request with its body.
 * `answers` maps "METHOD endpoint" to a result, or to an Error to throw.
 */
function stubQdrant(collectionNames, answers = {}) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test';
    qdrantBackend._request = async (method, endpoint, body) => {
        requests.push({ method, endpoint, body });
        const answer = answers[`${method} ${endpoint}`];
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return { result: answer };
        if (method === 'GET' && endpoint === '/collections') return { result: { collections: collectionNames.map(name => ({ name })) } };
        return { result: {} };
    };
    return requests;
}

afterEach(() => {
    delete qdrantBackend._request;
    delete qdrantBackend._tenantIndexed;
});

test('the tenant field is indexed as a tenant on every new collection', async () => {
    const requests = stubQdrant([]);
    await qdrantBackend.createPayloadIndexes('vf_new');
    const tenantIndex = requests.find(request => request.body?.field_name === TENANT_FIELD);
    assert.deepEqual(tenantIndex.body.field_schema, { type: 'keyword', is_tenant: true });
});

test('a search, a listing and the saved hashes read the named tenant only', async () => {
    const requests = stubQdrant([SHARED], {
        [`POST /collections/${SHARED}/points/search`]: [],
        [`POST /collections/${SHARED}/points/scroll`]: { points: [], next_page_offset: null },
    });
    await qdrantBackend.queryCollection(SHARED, [0.1, 0.2], 5, { [TENANT_FIELD]: TENANT });
    await qdrantBackend.listItems(SHARED, { [TENANT_FIELD]: TENANT });
    await qdrantBackend.getSavedHashes(SHARED, { [TENANT_FIELD]: TENANT });
    const reads = requests.filter(request => request.method === 'POST');
    assert.equal(reads.length, 3);
    for (const read of reads) {
        assert.deepEqual(read.body.filter.must, [tenantClause], read.endpoint);
        assert.deepEqual(read.body.filter.must_not, [{ key: 'type', match: { value: '_vectfox_meta' } }], read.endpoint);
    }
});

test('a delete with a tenant matches the payload hash inside it; without one it deletes the points by ID', async () => {
    const requests = stubQdrant([SHARED]);
    await qdrantBackend.deleteVectors(SHARED, [11, '12'], { [TENANT_FIELD]: TENANT });
    await qdrantBackend.deleteVectors('vf_own_collection', [11]);
    assert.deepEqual(requests[0].body, { filter: { must: [tenantClause, { key: 'hash', match: { any: [11, 12] } }] } });
    assert.deepEqual(requests[1].body, { points: [11] });
});

test('a metadata change with a tenant finds the point by payload hash inside it', async () => {
    const requests = stubQdrant([SHARED]);
    await qdrantBackend.updateItemMetadata(SHARED, 11, { importance: 9 }, { [TENANT_FIELD]: TENANT });
    assert.deepEqual(requests[0].body, {
        payload: { importance: 9 },
        filter: { must: [tenantClause, { key: 'hash', match: { value: 11 } }] },
    });
});

test('a purge deletes the named tenant only, and a purge that names no tenant throws and deletes nothing', async () => {
    const requests = stubQdrant([SHARED]);
    await qdrantBackend.purgeCollection(SHARED, { [TENANT_FIELD]: TENANT });
    const purge = requests.find(request => request.endpoint.endsWith('/points/delete?wait=true'));
    assert.deepEqual(purge.body, { filter: { must: [tenantClause] } });

    const later = stubQdrant([SHARED]);
    await assert.rejects(qdrantBackend.purgeCollection(SHARED, { filter: { must: [] } }), /needs a tenant/);
    assert.equal(later.some(request => request.endpoint.includes('/points/delete')), false);
});

test('an insert takes the point ID the client chose, and refuses one Qdrant cannot hold before writing anything', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const item = { id, hash: 77, text: 'a passage', vector: [0.1, 0.2], metadata: { [TENANT_FIELD]: TENANT } };
    const requests = stubQdrant([SHARED], { [`GET /collections/${SHARED}`]: { config: { params: { vectors: { size: 2 } } } } });
    await qdrantBackend.insertVectors(SHARED, [item]);
    const upsert = requests.find(request => request.method === 'PUT' && request.endpoint.startsWith(`/collections/${SHARED}/points`));
    assert.equal(upsert.body.points[0].id, id);
    assert.equal(upsert.body.points[0].payload.hash, 77);

    const refused = stubQdrant([SHARED]);
    await assert.rejects(qdrantBackend.insertVectors(SHARED, [{ ...item, id: 'passage-1' }]), /neither a whole number nor a UUID/);
    assert.equal(refused.length, 0);
});

test('discovery lists each tenant of the shared collection as a collection, with its count and source', async () => {
    const requests = stubQdrant([SHARED, 'vf_own_collection'], {
        [`POST /collections/${SHARED}/facet`]: { hits: [{ value: TENANT, count: 40 }, { value: 'vf_lorebook_b', count: 7 }] },
        [`POST /collections/${SHARED}/points/scroll`]: { points: [{ payload: { embeddingSource: 'custom' } }] },
        'POST /collections/vf_own_collection/points/scroll': { points: [{ payload: { embeddingSource: 'openrouter' } }] },
        'POST /collections/vf_own_collection/points/count': { count: 12 },
    });
    const { collections, tenantsListed } = await qdrantBackend.describeCollections();
    assert.equal(tenantsListed, true);
    assert.deepEqual(collections, [
        { id: TENANT, source: 'custom', chunkCount: 40, sharedCollection: SHARED },
        { id: 'vf_lorebook_b', source: 'custom', chunkCount: 7, sharedCollection: SHARED },
        { id: 'vf_own_collection', source: 'openrouter', chunkCount: 12 },
    ]);
    assert.ok(requests.some(request => request.method === 'PUT' && request.body?.field_name === TENANT_FIELD), 'the tenant field is indexed first');
});

test('a tenant whose points were all deleted is not listed, though Qdrant still reports it with a count of 0', async () => {
    stubQdrant([SHARED], {
        [`POST /collections/${SHARED}/facet`]: { hits: [{ value: TENANT, count: 40 }, { value: 'vf_purged_collection', count: 0 }] },
        [`POST /collections/${SHARED}/points/scroll`]: { points: [] },
    });
    const { collections } = await qdrantBackend.describeCollections();
    assert.deepEqual(collections.map(collection => collection.id), [TENANT]);
});

test('when the tenants cannot be listed, discovery says so and shows the shared collection whole', async () => {
    stubQdrant([SHARED], {
        [`POST /collections/${SHARED}/facet`]: new Error('Qdrant API error (404): Not Found'),
        [`POST /collections/${SHARED}/points/count`]: { count: 47 },
        [`POST /collections/${SHARED}/points/scroll`]: { points: [] },
    });
    const { collections, tenantsListed } = await qdrantBackend.describeCollections();
    assert.equal(tenantsListed, false);
    assert.deepEqual(collections, [{ id: SHARED, source: 'unknown', chunkCount: 47 }]);
});

test('a facet answer as long as its limit may be cut, so it counts as not listed', async () => {
    const hits = Array.from({ length: 10000 }, (_, index) => ({ value: `vf_chat_${index}`, count: 1 }));
    stubQdrant([SHARED], {
        [`POST /collections/${SHARED}/facet`]: { hits },
        [`POST /collections/${SHARED}/points/count`]: { count: 10000 },
        [`POST /collections/${SHARED}/points/scroll`]: { points: [] },
    });
    const { tenantsListed } = await qdrantBackend.describeCollections();
    assert.equal(tenantsListed, false);
});
