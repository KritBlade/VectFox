// Tests the chunk routes' change numbers (index.js with qdrant-changes.js): on Qdrant, inserts take numbers in the order
// they reach the collection's write turn, a metadata change takes the next one, a delete and a purge record what they
// remove before it goes, and the change route reads in the collection's turn, so it waits for a write queued before
// it; it answers unsupported for another backend and refuses a malformed read. The routes are called as the plugin
// registers them, on a stand-in router, and each test's Qdrant is a fake of its own (fake-qdrant.js), at an address of
// its own, as the plugin keeps its numbers for as long as it runs.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { CHANGE_NUMBER_FIELD } from '../qdrant-backend.js';
import { CHANGE_KINDS } from '../qdrant-changes.js';
import { init } from '../index.js';
import { event, fakeQdrant, storedEvent } from './fake-qdrant.js';

const NUMBER = CHANGE_NUMBER_FIELD;
const COLLECTION = 'vf_eventbase_qdrant_tester_harbor_cccccccc-3333-4333-8333-cccccccccccc';

/** The plugin's routes as init registers them, by "METHOD path". */
const routes = new Map();
await init(new Proxy({}, { get: (_, method) => (path, handler) => routes.set(`${String(method).toUpperCase()} ${path}`, handler) }));

/** Call a route as Express would, and give back the status and the JSON it answered. */
async function call(method, path, { body = {}, params = {} } = {}) {
    const handler = routes.get(`${method} ${path}`);
    assert.ok(handler, `${method} ${path} is a route`);
    const answer = { status: 200, body: undefined };
    const res = {
        status(code) { answer.status = code; return res; },
        json(value) { answer.body = value; return res; },
    };
    await handler({ body, params, query: {}, user: { directories: { vectors: 'unused' }, profile: { handle: 'tester' } } }, res);
    return answer;
}

/** A fake Qdrant at an address of the test's own. */
const qdrantFor = name => fakeQdrant({ url: `http://${name}.qdrant.test` });
const shortWait = () => new Promise(resolve => setTimeout(resolve, 20));

afterEach(() => {
    delete qdrantBackend._request;
    delete qdrantBackend._tenantIndexed;
    qdrantBackend.serverVersion = null;
});

test('inserts through the route take numbers in the order they reach the write turn', async () => {
    const qdrant = qdrantFor('inserts');
    const answers = await Promise.all([
        call('POST', '/chunks/insert', { body: { backend: 'qdrant', collectionId: COLLECTION, items: [event(701)] } }),
        call('POST', '/chunks/insert', { body: { backend: 'qdrant', collectionId: COLLECTION, items: [event(702)] } }),
    ]);
    assert.deepEqual(answers.map(answer => answer.status), [200, 200]);
    assert.deepEqual(qdrant.payloads(COLLECTION).map(payload => [payload.hash, payload[NUMBER]]), [[701, 1], [702, 2]]);
});

test('a metadata change through the route takes the next number', async () => {
    const qdrant = qdrantFor('metadata');
    qdrant.seed(COLLECTION, [storedEvent(701, 3)]);
    const answer = await call('PATCH', '/chunks/:hash/metadata', { params: { hash: '701' }, body: { backend: 'qdrant', collectionId: COLLECTION, metadata: { importance: 9 } } });
    assert.equal(answer.status, 200);
    assert.deepEqual(qdrant.payloads(COLLECTION).map(payload => [payload.importance, payload[NUMBER]]), [[9, 4]]);
});

test('a delete and a purge through the route record what they remove before it goes', async () => {
    const qdrant = qdrantFor('removals');
    qdrant.seed(COLLECTION, [storedEvent(701, 1), storedEvent(702, 2)]);
    assert.equal((await call('POST', '/chunks/delete', { body: { backend: 'qdrant', collectionId: COLLECTION, hashes: [701] } })).status, 200);
    assert.equal((await call('POST', '/chunks/purge', { body: { backend: 'qdrant', collectionId: COLLECTION } })).status, 200);
    assert.deepEqual(qdrant.records().map(record => [record.kind, record[NUMBER], record.event_id]), [[CHANGE_KINDS.removed, 3, 'ev-701'], [CHANGE_KINDS.emptied, 4, undefined]]);
    assert.equal(qdrant.has(COLLECTION), false);
});

test('the change route reads in the collection\'s write turn, after the write queued before it', { timeout: 5000 }, async () => {
    const qdrant = qdrantFor('turns');
    const upsert = qdrant.holdWhen((method, endpoint) => method === 'PUT' && endpoint === `/collections/${COLLECTION}/points?wait=true`);
    const insert = call('POST', '/chunks/insert', { body: { backend: 'qdrant', collectionId: COLLECTION, items: [event(701), event(702)] } });
    await upsert.reached;
    const read = call('POST', '/chunks/changes', { body: { backend: 'qdrant', collectionId: COLLECTION, after: 0 } });
    await shortWait();
    const isChangeRead = request => request.endpoint === `/collections/${COLLECTION}/points/scroll`
        && request.body?.filter?.must?.some(clause => clause.key === NUMBER && clause.range);
    assert.equal(qdrant.requests.some(isChangeRead), false, 'the read waits for the write');
    upsert.release();
    assert.equal((await insert).status, 200);
    const answer = await read;
    assert.deepEqual([answer.status, answer.body.supported, answer.body.points.map(point => point.hash), answer.body.cursor], [200, true, [701, 702], 2]);
});

test('the change route answers unsupported for another backend and refuses a malformed read', async () => {
    qdrantFor('refusals');
    const otherBackend = await call('POST', '/chunks/changes', { body: { backend: 'vectra', collectionId: COLLECTION } });
    assert.deepEqual([otherBackend.status, otherBackend.body.supported], [200, false]);
    assert.equal((await call('POST', '/chunks/changes', { body: { backend: 'qdrant', collectionId: COLLECTION, after: -1 } })).status, 400);
    assert.equal((await call('POST', '/chunks/changes', { body: { backend: 'qdrant' } })).status, 400);
});
