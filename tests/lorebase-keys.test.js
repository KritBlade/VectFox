// Tests LoreBase's key store: a collection with no vectors, a point per entry whose ID comes from the user, the book
// and the uid, each user reading and writing only their own points, malformed writes refused, and the collection
// left out of VectFox's collection listing. Qdrant is stubbed at the backend's one request function.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { LOREBASE_KEYS_COLLECTION } from '../qdrant-backend.js';
import { keysPointId, readLoreKeys, writeLoreKeys } from '../lorebase-keys.js';

function stubQdrant(collectionNames, answers = {}) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test';
    qdrantBackend._request = async (method, endpoint, body) => {
        requests.push({ method, endpoint, body });
        const answer = answers[`${method} ${endpoint}`];
        if (typeof answer === 'function') return { result: answer(body) };
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return { result: answer };
        if (method === 'GET' && endpoint === '/collections') return { result: { collections: collectionNames.map(name => ({ name })) } };
        return { result: {} };
    };
    return requests;
}

afterEach(() => {
    delete qdrantBackend._request;
    delete qdrantBackend._loreKeysCollectionReady;
});

test('the first write makes the collection with no vectors and indexes the user as its tenant', async () => {
    const requests = stubQdrant([]);
    await writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', [{ uid: 3, keys: ['lighthouse', 'keeper'] }]);
    const made = requests.find(request => request.method === 'PUT' && request.endpoint === `/collections/${LOREBASE_KEYS_COLLECTION}`);
    assert.deepEqual(made.body, { vectors: {} });
    const indexes = requests.filter(request => request.endpoint.startsWith(`/collections/${LOREBASE_KEYS_COLLECTION}/index`));
    assert.deepEqual(indexes.map(request => request.body), [
        { field_name: 'user', field_schema: { type: 'keyword', is_tenant: true } },
        { field_name: 'book', field_schema: { type: 'keyword' } },
    ]);
});

test('a write puts one point per entry, its ID from the user, book and uid, so a second write replaces it', async () => {
    const requests = stubQdrant([LOREBASE_KEYS_COLLECTION]);
    const written = await writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', [
        { uid: 3, keys: ['lighthouse'] }, { uid: '9', keys: ['dunes', 'caravan'] },
    ]);
    assert.equal(written, 2);
    const upsert = requests.find(request => request.endpoint === `/collections/${LOREBASE_KEYS_COLLECTION}/points?wait=true`);
    assert.deepEqual(upsert.body.points.map(point => point.id), [keysPointId('tester', 'Harbor book', '3'), keysPointId('tester', 'Harbor book', '9')]);
    assert.deepEqual(upsert.body.points[0].vector, {});
    assert.equal(upsert.body.points[0].payload.user, 'tester');
    assert.equal(upsert.body.points[0].payload.book, 'Harbor book');
    assert.equal(upsert.body.points[0].payload.uid, '3');
    assert.deepEqual(upsert.body.points[1].payload.keys, ['dunes', 'caravan']);
    assert.match(keysPointId('tester', 'Harbor book', '3'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(keysPointId('tester', 'Harbor book', '3'), keysPointId('other', 'Harbor book', '3'));
});

test('a read asks for the requesting user\'s points of the named books only, and follows every page', async () => {
    let page = 0;
    const requests = stubQdrant([LOREBASE_KEYS_COLLECTION], {
        [`POST /collections/${LOREBASE_KEYS_COLLECTION}/points/scroll`]: () => (page++ === 0
            ? { points: [{ payload: { book: 'Harbor book', uid: '3', keys: ['lighthouse'] } }], next_page_offset: 'next' }
            : { points: [{ payload: { book: 'Desert book', uid: '1', keys: ['dunes'] } }], next_page_offset: null }),
    });
    const keys = await readLoreKeys(qdrantBackend, 'tester', ['Harbor book', 'Desert book', 'Empty book']);
    assert.deepEqual(keys, { 'Harbor book': { 3: ['lighthouse'] }, 'Desert book': { 1: ['dunes'] }, 'Empty book': {} });
    const scrolls = requests.filter(request => request.endpoint.endsWith('/points/scroll'));
    assert.equal(scrolls.length, 2);
    assert.deepEqual(scrolls[0].body.filter.must, [
        { key: 'user', match: { value: 'tester' } },
        { key: 'book', match: { any: ['Harbor book', 'Desert book', 'Empty book'] } },
    ]);
    assert.equal(scrolls[1].body.offset, 'next');
});

test('a malformed write is refused before Qdrant is asked', async () => {
    const requests = stubQdrant([LOREBASE_KEYS_COLLECTION]);
    await assert.rejects(writeLoreKeys(qdrantBackend, 'tester', '', [{ uid: 1, keys: ['a'] }]), RangeError);
    await assert.rejects(writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', []), RangeError);
    await assert.rejects(writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', [{ uid: 1, keys: [] }]), RangeError);
    await assert.rejects(writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', [{ uid: 1, keys: [42] }]), RangeError);
    await assert.rejects(readLoreKeys(qdrantBackend, 'tester', 'Harbor book'), RangeError);
    assert.equal(requests.length, 0);
});

test('without Qdrant set up, a write says LoreBase needs it', async () => {
    qdrantBackend.baseUrl = null;
    await assert.rejects(writeLoreKeys(qdrantBackend, 'tester', 'Harbor book', [{ uid: 1, keys: ['a'] }]), /LoreBase keeps its keys in Qdrant/);
});

test('the keys collection is left out of the collection listing VectFox discovers', async () => {
    stubQdrant(['vectfox_main', LOREBASE_KEYS_COLLECTION, 'vf_eventbase_tester']);
    assert.deepEqual(await qdrantBackend.getCollections(), ['vectfox_main', 'vf_eventbase_tester']);
});
