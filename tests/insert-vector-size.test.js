// Tests that an insert whose vectors differ in size from the collection's deletes nothing and stops with the error
// Qdrant itself gives, in both of VectFox's Qdrant modes: one shared "vectfox_main" with multitenancy on, a collection
// per chat with it off. Qdrant is stubbed at the backend's one request function, so no server is needed.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend from '../qdrant-backend.js';

const STORED_SIZE = 1024;

/** Answer the backend's requests as a Qdrant holding `collectionName` at `storedSize`, and record each one. */
function stubQdrant(collectionName, storedSize) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test';
    qdrantBackend._request = async (method, endpoint) => {
        requests.push(`${method} ${endpoint}`);
        if (method === 'GET' && endpoint === '/collections') return { result: { collections: [{ name: collectionName }] } };
        if (method === 'GET' && endpoint === `/collections/${collectionName}`) {
            return { result: { config: { params: { vectors: { size: storedSize, distance: 'Cosine' } } } } };
        }
        return { result: {} };
    };
    return requests;
}

const itemsOfSize = size => [{ hash: 101, text: 'an event', vector: new Array(size).fill(0.1), metadata: {} }];

afterEach(() => {
    delete qdrantBackend._request;
});

for (const [mode, collectionName] of [['multitenancy on', 'vectfox_main'], ['multitenancy off', 'vf_eventbase_qdrant_tester_chat']]) {
    test(`${mode}: a different vector size stops with Qdrant's own error and deletes nothing`, async () => {
        const requests = stubQdrant(collectionName, STORED_SIZE);
        await assert.rejects(
            qdrantBackend.insertVectors(collectionName, itemsOfSize(768)),
            { message: `Vector dimension error: expected dim: ${STORED_SIZE}, got 768` },
        );
        assert.deepEqual(requests.filter(request => !request.startsWith('GET ')), []);
    });

    test(`${mode}: the same vector size inserts, and deletes nothing`, async () => {
        const requests = stubQdrant(collectionName, STORED_SIZE);
        await qdrantBackend.insertVectors(collectionName, itemsOfSize(STORED_SIZE));
        assert.equal(requests.some(request => request.startsWith('DELETE ')), false);
        assert.equal(requests.some(request => request.startsWith(`PUT /collections/${collectionName}/points`)), true);
    });
}
