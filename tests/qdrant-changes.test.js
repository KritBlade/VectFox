// Tests Similharity's change numbers and change log (qdrant-changes.js, D12 of VectFox's public API plan): each write
// takes its collection's next numbers in its turn, so two writes queued at once are numbered and stored in that order;
// a change read in its own turn sees a write whole or not at all; a delete, a purge of one tenant and a purge of a whole
// Qdrant collection each leave their record before the points go, and a record that cannot be written removes nothing;
// after a restart the counter goes on past the highest number among the points and the records; a number a client
// sends is replaced; the change log stays out of the listing, the start-up index pass and every chunk route; a read
// gives the changes after a number a page at a time; and a Qdrant older than 1.8 works as before. Qdrant is a small
// fake behind the backend's one request function (fake-qdrant.js).
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { CHANGE_LOG_COLLECTION, CHANGE_NUMBER_FIELD, TENANT_FIELD } from '../qdrant-backend.js';
import { createCollectionWriteOrder } from '../collection-write-order.js';
import { CHANGE_KINDS, createQdrantChanges } from '../qdrant-changes.js';
import { event, fakeQdrant, storedEvent } from './fake-qdrant.js';

const NUMBER = CHANGE_NUMBER_FIELD;
const OWN = 'vf_eventbase_qdrant_tester_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'vf_eventbase_qdrant_tester_market_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SHARED = 'vectfox_main';
const IN_A = { [TENANT_FIELD]: 'vf_eventbase_qdrant_tester_harbor_a' };
const IN_B = { [TENANT_FIELD]: 'vf_eventbase_qdrant_tester_harbor_b' };
const SENTINEL = { id: '00000000-0000-0000-0000-0000feedf00d', payload: { type: '_vectfox_meta', _vectfox_sentinel: true } };

/** The writes to each collection, queued as the routes queue them. */
function writeQueue() {
    const order = createCollectionWriteOrder();
    return (collection, write) => order.queueWrite(JSON.stringify(['qdrant', collection]), write);
}

const isRecordWrite = request => request.method === 'PUT' && request.endpoint === `/collections/${CHANGE_LOG_COLLECTION}/points?wait=true`;
const touchesChangeLog = request => request.endpoint.startsWith(`/collections/${CHANGE_LOG_COLLECTION}`);
const shortWait = () => new Promise(resolve => setTimeout(resolve, 20));

afterEach(() => {
    delete qdrantBackend._request;
    delete qdrantBackend._tenantIndexed;
    qdrantBackend.serverVersion = null;
});

test('two writes queued at once take 101 and 102 and are stored in that order', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(700, 100)]);
    const changes = createQdrantChanges(qdrantBackend);
    const queue = writeQueue();
    await Promise.all([
        queue(OWN, () => changes.insert(OWN, [event(701)], {})),
        queue(OWN, () => changes.insert(OWN, [event(702)], {})),
    ]);
    const stored = qdrant.requests.filter(request => request.method === 'PUT' && request.endpoint === `/collections/${OWN}/points?wait=true`);
    assert.deepEqual(stored.map(request => request.body.points.map(point => [point.id, point.payload[NUMBER]])), [[[701, 101]], [[702, 102]]]);
});

test('a change read queued beside a write sees all of it or none of it', { timeout: 5000 }, async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(700, 100)]);
    const changes = createQdrantChanges(qdrantBackend);
    const queue = writeQueue();
    const upsert = qdrant.holdWhen((method, endpoint) => method === 'PUT' && endpoint === `/collections/${OWN}/points?wait=true`);
    const readBefore = queue(OWN, () => changes.readChanges(OWN, {}, { after: 100 }));
    const write = queue(OWN, () => changes.insert(OWN, [event(701), event(702), event(703)], {}));
    const readAfter = queue(OWN, () => changes.readChanges(OWN, {}, { after: 100 }));
    await upsert.reached;
    const isScroll = request => request.endpoint.endsWith('/points/scroll');
    const scrollsWhileHeld = qdrant.requests.filter(isScroll).length;
    await shortWait();
    assert.equal(qdrant.requests.filter(isScroll).length, scrollsWhileHeld, 'the read queued behind the write waits for all of it');
    upsert.release();
    await write;
    assert.deepEqual((await readBefore).points, []);
    assert.deepEqual((await readAfter).points.map(point => point.hash), [701, 702, 703]);
});

test('a delete records each event it removes before the points go', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 1), storedEvent(702, 2), { id: 799, payload: { hash: 799, text: 'A passage, not an event.', [NUMBER]: 3 } }]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.remove(OWN, [701, '799']);
    assert.deepEqual(qdrant.records(), [
        { collection: OWN, kind: CHANGE_KINDS.removed, [NUMBER]: 4, type: 'chat', sourceId: 'unknown', hash: 701, event_id: 'ev-701' },
    ]);
    const deleteAt = qdrant.requests.findIndex(request => request.endpoint === `/collections/${OWN}/points/delete?wait=true`);
    assert.ok(qdrant.requests.findIndex(isRecordWrite) < deleteAt, 'the record is written first');
    assert.deepEqual(qdrant.payloads(OWN).map(payload => payload.hash), [702]);
});

test('a purge of one tenant records that it was emptied before its points go', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(SHARED, [storedEvent(711, 1, IN_A), storedEvent(721, 2, IN_B)]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.purge(SHARED, IN_A);
    assert.deepEqual(qdrant.records(), [{ collection: SHARED, kind: CHANGE_KINDS.emptied, [NUMBER]: 3, ...IN_A }]);
    const deleteAt = qdrant.requests.findIndex(request => request.endpoint === `/collections/${SHARED}/points/delete?wait=true`);
    assert.ok(qdrant.requests.findIndex(isRecordWrite) < deleteAt, 'the record is written first');
    assert.deepEqual(qdrant.payloads(SHARED).map(payload => payload.hash), [721]);
});

test('a purge of a whole Qdrant collection records that it was emptied before the collection goes', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 1)]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.purge(OWN);
    assert.deepEqual(qdrant.records(), [{ collection: OWN, kind: CHANGE_KINDS.emptied, [NUMBER]: 2 }]);
    const dropAt = qdrant.requests.findIndex(request => request.method === 'DELETE' && request.endpoint === `/collections/${OWN}`);
    assert.ok(qdrant.requests.findIndex(isRecordWrite) < dropAt, 'the record is written first');
    assert.equal(qdrant.has(OWN), false);
});

test('a record that cannot be written removes nothing', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 1)]);
    qdrant.seed(SHARED, [storedEvent(711, 2, IN_A)]);
    const changes = createQdrantChanges(qdrantBackend);
    qdrant.failWhen((method, endpoint) => isRecordWrite({ method, endpoint }));
    await assert.rejects(changes.remove(OWN, [701]), /made-up failure/);
    await assert.rejects(changes.purge(SHARED, IN_A), /made-up failure/);
    await assert.rejects(changes.purge(OWN), /made-up failure/);
    assert.equal(qdrant.requests.some(request => request.endpoint.includes('/points/delete') || request.method === 'DELETE'), false);
    assert.deepEqual(qdrant.payloads(OWN).map(payload => payload.hash), [701]);
    assert.deepEqual(qdrant.payloads(SHARED).map(payload => payload.hash), [711]);
});

test('after a restart the counter goes on past the highest number among the events and the log', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 40), storedEvent(702)]);
    qdrant.seed(CHANGE_LOG_COLLECTION, [
        { id: '00000000-0000-4000-8000-000000000001', payload: { collection: OWN, kind: CHANGE_KINDS.removed, [NUMBER]: 57, hash: 709, event_id: 'ev-709' } },
        { id: '00000000-0000-4000-8000-000000000002', payload: { collection: OTHER, kind: CHANGE_KINDS.emptied, [NUMBER]: 99 } },
    ]);
    await createQdrantChanges(qdrantBackend).insert(OWN, [event(703)], {});
    assert.equal(qdrant.payloads(OWN).find(payload => payload.hash === 703)[NUMBER], 58);
});

test('a number a client sends is replaced, on an insert and on a metadata change', async () => {
    const qdrant = fakeQdrant();
    const changes = createQdrantChanges(qdrantBackend);
    await changes.insert(OWN, [event(701, { [NUMBER]: 9999 })], {});
    assert.equal(qdrant.payloads(OWN)[0][NUMBER], 1);
    await changes.updateMetadata(OWN, 701, { story_links: ['ev-650'], [NUMBER]: 5555 }, {});
    const [stored] = qdrant.payloads(OWN);
    assert.equal(stored[NUMBER], 2);
    assert.deepEqual(stored.story_links, ['ev-650']);
});

test('a text change takes the next number and records no removal, as its event stays', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 5)]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.updateText(OWN, 701, { text: 'Event 701, told again.', hash: 7011, vector: [0.8, 0.6] }, {});
    assert.deepEqual(qdrant.payloads(OWN).map(payload => [payload.hash, payload.event_id, payload[NUMBER]]), [[7011, 'ev-701', 6]]);
    assert.deepEqual(qdrant.records(), []);
});

test('Purge everything leaves the change log: no listing, start-up index pass or chunk route reaches it', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701, 1)]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.remove(OWN, [701]);
    assert.ok(qdrant.has(CHANGE_LOG_COLLECTION));
    assert.deepEqual(await qdrantBackend.getCollections(), [OWN]);
    qdrant.requests.length = 0;
    await qdrantBackend.initialize({ url: 'http://qdrant.test' });
    assert.equal(qdrant.requests.some(touchesChangeLog), false, 'the start-up index pass leaves it alone');
    for (const reachIn of [
        () => changes.insert(CHANGE_LOG_COLLECTION, [event(799)], {}),
        () => changes.updateMetadata(CHANGE_LOG_COLLECTION, 799, { kind: CHANGE_KINDS.removed }, {}),
        () => changes.updateText(CHANGE_LOG_COLLECTION, 799, { text: 'A record, rewritten.' }, {}),
        () => changes.remove(CHANGE_LOG_COLLECTION, [799]),
        () => changes.purge(CHANGE_LOG_COLLECTION),
        () => changes.readChanges(CHANGE_LOG_COLLECTION, {}, { after: 0 }),
    ]) await assert.rejects(reachIn(), RangeError);
    assert.equal(qdrant.records().length, 1);
});

test('every collection indexes the change number as an integer, which order_by needs', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed('vf_new');
    await qdrantBackend.createPayloadIndexes('vf_new');
    assert.equal(qdrant.requests.find(request => request.body?.field_name === NUMBER)?.body.field_schema, 'integer');
});

test('a change read gives the points written and the events removed after a number, a page at a time in number order', async () => {
    fakeQdrant();
    const changes = createQdrantChanges(qdrantBackend);
    await changes.insert(OWN, [event(701), event(702), event(703), event(704), event(705)], {});
    const pointsOnly = await changes.readChanges(OWN, {}, { after: 0, limit: 4 });
    assert.deepEqual([pointsOnly.points.length, pointsOnly.cursor, pointsOnly.hasMore], [4, 4, true], 'more points than a page, and no record');
    await changes.remove(OWN, [702]);
    const first = await changes.readChanges(OWN, {}, { after: 0, limit: 3 });
    assert.deepEqual(first.points.map(point => [point.hash, point.metadata[NUMBER]]), [[701, 1], [703, 3], [704, 4]]);
    assert.deepEqual([first.removed, first.emptied, first.cursor, first.hasMore], [[], false, 4, true]);
    const second = await changes.readChanges(OWN, {}, { after: first.cursor, limit: 3 });
    assert.deepEqual(second.points.map(point => point.hash), [705]);
    assert.deepEqual(second.removed, [{ hash: 702, event_id: 'ev-702', [NUMBER]: 6 }]);
    assert.deepEqual([second.cursor, second.hasMore], [6, false]);
    const third = await changes.readChanges(OWN, {}, { after: second.cursor });
    assert.deepEqual([third.points, third.removed, third.cursor, third.hasMore], [[], [], 6, false]);
});

test('a read after a purge says emptied with only what came after; a tenant reads its own changes and the purge of the whole collection', async () => {
    fakeQdrant();
    const changes = createQdrantChanges(qdrantBackend);
    await changes.insert(SHARED, [event(711, IN_A), event(712, IN_A)], {});
    await changes.insert(SHARED, [event(721, IN_B), event(722, IN_B)], {});
    await changes.remove(SHARED, [712], IN_A);
    await changes.purge(SHARED, IN_A);
    await changes.insert(SHARED, [event(713, IN_A)], {});
    await changes.remove(SHARED, [722], IN_B);
    const readA = await changes.readChanges(SHARED, IN_A, { after: 2 });
    assert.deepEqual([readA.emptied, readA.points.map(point => point.hash), readA.removed, readA.cursor], [true, [713], [], 7], 'the removal before the purge is left out');
    const readB = await changes.readChanges(SHARED, IN_B, { after: 4 });
    assert.deepEqual([readB.emptied, readB.points, readB.removed.map(removal => removal.event_id), readB.cursor], [false, [], ['ev-722'], 8]);
    await changes.purge(SHARED);
    for (const [tenant, after] of [[IN_A, readA.cursor], [IN_B, readB.cursor]]) {
        const read = await changes.readChanges(SHARED, tenant, { after });
        assert.deepEqual([read.emptied, read.points, read.removed, read.cursor], [true, [], [], 9]);
    }
});

test('a full read gives every point, those stored before numbers included, with a cursor the next read goes on from', async () => {
    const qdrant = fakeQdrant();
    qdrant.seed(OWN, [storedEvent(701), storedEvent(702), SENTINEL]);
    const changes = createQdrantChanges(qdrantBackend);
    await changes.insert(OWN, [event(703)], {});
    await changes.remove(OWN, [701]);
    const full = await changes.readChanges(OWN, {});
    assert.deepEqual([full.points.map(point => point.hash), full.removed, full.emptied, full.cursor, full.hasMore], [[702, 703], [], false, 2, false]);
    const fromZero = await changes.readChanges(OWN, {}, { after: 0 });
    assert.deepEqual(fromZero.points.map(point => point.hash), [703], 'a read after 0 leaves out what was stored before numbers');
    await changes.insert(OWN, [event(704)], {});
    const next = await changes.readChanges(OWN, {}, { after: full.cursor });
    assert.deepEqual(next.points.map(point => point.hash), [704]);
});

test('a change read refuses an after or a limit that is not a whole number in range', async () => {
    fakeQdrant();
    const changes = createQdrantChanges(qdrantBackend);
    for (const read of [{ after: -1 }, { after: '5' }, { after: 1.5 }, { after: 0, limit: 0 }, { after: 0, limit: 1001 }]) {
        await assert.rejects(changes.readChanges(OWN, {}, read), RangeError, JSON.stringify(read));
    }
});

for (const version of ['1.7.4', null]) {
    test(`on a Qdrant ${version ? `of version ${version}` : 'of unknown version'}, nothing is numbered or recorded and a change read says it is not supported`, async () => {
        const qdrant = fakeQdrant({ version });
        qdrant.seed(OWN, [storedEvent(701), storedEvent(702)]);
        qdrant.seed(SHARED, [storedEvent(711, null, IN_A)]);
        const changes = createQdrantChanges(qdrantBackend);
        await changes.insert(OWN, [event(703, { [NUMBER]: 9999 })], {});
        await changes.updateMetadata(OWN, 703, { importance: 7 }, {});
        await changes.remove(OWN, [701]);
        await changes.purge(SHARED, IN_A);
        await changes.purge(OWN);
        assert.equal(qdrant.requests.some(touchesChangeLog), false);
        const stored = qdrant.requests.find(request => request.method === 'PUT' && request.endpoint === `/collections/${OWN}/points?wait=true`);
        assert.equal(stored.body.points[0].payload[NUMBER], 9999, 'the metadata is stored as the client sent it, as before');
        const read = await changes.readChanges(OWN, {}, { after: 0 });
        assert.equal(read.supported, false);
        assert.match(read.reason, version ? /1\.7\.4/ : /unknown/);
    });
}
