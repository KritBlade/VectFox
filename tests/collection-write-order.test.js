// Tests the order of the writes to one collection: an insert still embedding when a delete, edit or purge arrives does
// not write what that write removed, and a new insert after it does write; in a shared Qdrant collection a write
// overtakes only its tenant's points, and one naming no tenant every tenant's; and the writes to one collection run one
// at a time, in the order they were queued, a failed one included. The race is #25's: VectFox's hedge sends an insert
// again, the second attempt stores the point, the point is deleted, and then the first attempt finishes embedding.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionWriteOrder } from '../collection-write-order.js';

const COLLECTION = JSON.stringify(['qdrant', 'vectfox_main']);
const OTHER_COLLECTION = JSON.stringify(['qdrant', 'chat_harbor']);

/** A promise and the function that settles it, so a test holds an embedding until it chooses. */
function held() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

/** A collection's stored points, by hash, as the handlers' writes leave them. */
function fakeStore() {
    const points = new Map();
    return {
        points,
        write: items => items.forEach(item => points.set(String(item.hash), item.text)),
        delete: hashes => hashes.forEach(hash => points.delete(String(hash))),
        clear: () => points.clear(),
    };
}

/** An insert as the backend handlers run it: registered on arrival, embedded, then written in the queue. */
async function insert(order, store, collectionKey, items, embedding = Promise.resolve()) {
    const registered = order.startInsert(collectionKey, items.map(item => ({ hash: item.hash, tenant: item.tenant })));
    try {
        await embedding;
        await order.queueWrite(collectionKey, async () => {
            store.write(items.filter((_, position) => !registered.isOvertaken(position)));
        });
    } finally {
        registered.finish();
    }
}

/** A delete as the handlers run it: overtaking on arrival, then written in the queue. */
function remove(order, store, collectionKey, hashes, tenant = {}) {
    order.overtake(collectionKey, { hashes, tenant });
    return order.queueWrite(collectionKey, async () => store.delete(hashes));
}

const LANTERN = { hash: 701, text: 'Lantern 1 hangs on the pier.' };
const ROPE = { hash: 702, text: 'A rope ties the red boat.' };
const GULL = { hash: 703, text: 'A gull lands on the mast.' };

test('#25: a hedged insert that finishes embedding after a delete does not bring the point back', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const firstEmbedding = held();
    const first = insert(order, store, COLLECTION, [LANTERN], firstEmbedding.promise);
    await insert(order, store, COLLECTION, [LANTERN]);
    assert.deepEqual([...store.points.keys()], ['701']);

    await remove(order, store, COLLECTION, [LANTERN.hash]);
    assert.equal(store.points.size, 0);

    firstEmbedding.release();
    await first;
    assert.equal(store.points.size, 0);
});

test('a new insert after the delete is written', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const firstEmbedding = held();
    const first = insert(order, store, COLLECTION, [LANTERN], firstEmbedding.promise);
    await remove(order, store, COLLECTION, [LANTERN.hash]);
    const again = insert(order, store, COLLECTION, [LANTERN]);
    firstEmbedding.release();
    await Promise.all([first, again]);
    assert.deepEqual([...store.points.keys()], ['701']);
});

test('only the deleted points of an insert go unwritten', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const embedding = held();
    const pending = insert(order, store, COLLECTION, [LANTERN, ROPE, GULL], embedding.promise);
    await remove(order, store, COLLECTION, [ROPE.hash]);
    embedding.release();
    await pending;
    assert.deepEqual([...store.points.keys()].sort(), ['701', '703']);
});

test('a hash is the same as a number or as the text of one', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const embedding = held();
    const pending = insert(order, store, COLLECTION, [{ hash: '701', text: LANTERN.text }, { hash: 702, text: ROPE.text }], embedding.promise);
    assert.equal(order.overtake(COLLECTION, { hashes: [701, '0702'] }), 2);
    embedding.release();
    await pending;
    assert.equal(store.points.size, 0);
});

test('a delete naming a tenant overtakes that tenant\'s points only, and one naming none overtakes every tenant\'s', () => {
    const harbor = { content_type: 'chat_harbor', type: 'chat', sourceId: 'unknown' };
    const forest = { content_type: 'chat_forest', type: 'chat', sourceId: 'unknown' };
    const order = createCollectionWriteOrder();
    const registered = order.startInsert(COLLECTION, [{ hash: 701, tenant: harbor }, { hash: 701, tenant: forest }]);

    assert.equal(order.overtake(COLLECTION, { hashes: [701], tenant: { content_type: 'chat_harbor' } }), 1);
    assert.deepEqual([registered.isOvertaken(0), registered.isOvertaken(1)], [true, false]);

    // A tenant field the points do not hold, as a released purge naming a sourceId its points lack: Qdrant deletes none.
    assert.equal(order.overtake(COLLECTION, { hashes: null, tenant: { sourceId: 'chat_forest' } }), 0);

    assert.equal(order.overtake(COLLECTION, { hashes: [701] }), 1);
    assert.equal(registered.isOvertaken(1), true);
    registered.finish();
});

test('a purge overtakes every point of the inserts registered before it, in that collection alone', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const otherStore = fakeStore();
    const embedding = held();
    const pending = insert(order, store, COLLECTION, [LANTERN, ROPE], embedding.promise);
    const otherPending = insert(order, otherStore, OTHER_COLLECTION, [GULL], embedding.promise);
    order.overtake(COLLECTION);
    await order.queueWrite(COLLECTION, async () => store.clear());
    embedding.release();
    await Promise.all([pending, otherPending]);
    assert.equal(store.points.size, 0);
    assert.deepEqual([...otherStore.points.keys()], ['703']);
});

test('a purge of several collections overtakes the ones it picks', async () => {
    const order = createCollectionWriteOrder();
    const picked = order.startInsert(COLLECTION, [{ hash: 701 }]);
    const left = order.startInsert(OTHER_COLLECTION, [{ hash: 701 }]);
    assert.equal(order.overtakeWhere(collectionKey => collectionKey === COLLECTION), 1);
    assert.deepEqual([picked.isOvertaken(0), left.isOvertaken(0)], [true, false]);
});

test('an insert off the record is overtaken no more', () => {
    const order = createCollectionWriteOrder();
    const registered = order.startInsert(COLLECTION, [{ hash: 701 }]);
    registered.finish();
    assert.equal(order.overtake(COLLECTION, { hashes: [701] }), 0);
    assert.equal(registered.isOvertaken(0), false);
});

test('a write that has passed its check finishes before a delete queued behind it runs', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    const writing = held();
    const steps = [];
    const registered = order.startInsert(COLLECTION, [{ hash: 701 }]);
    const pendingWrite = order.queueWrite(COLLECTION, async () => {
        const itemsToWrite = [LANTERN].filter((_, position) => !registered.isOvertaken(position));
        steps.push('insert checked');
        await writing.promise;
        store.write(itemsToWrite);
        steps.push('insert written');
    });
    await new Promise(resolve => setImmediate(resolve));
    const pendingDelete = remove(order, store, COLLECTION, [LANTERN.hash]).then(() => steps.push('deleted'));
    writing.release();
    await Promise.all([pendingWrite, pendingDelete]);
    registered.finish();
    assert.deepEqual(steps, ['insert checked', 'insert written', 'deleted']);
    assert.equal(store.points.size, 0);
});

test('writes run one at a time in their queued order, a failed one included, and give back what each returns', async () => {
    const order = createCollectionWriteOrder();
    const steps = [];
    const first = held();
    const results = [
        order.queueWrite(COLLECTION, async () => { await first.promise; steps.push('first'); return 1; }),
        order.queueWrite(COLLECTION, async () => { steps.push('second'); throw new Error('Qdrant refused the write'); }),
        order.queueWrite(COLLECTION, async () => { steps.push('third'); return 3; }),
    ];
    first.release();
    const settled = await Promise.allSettled(results);
    assert.deepEqual(steps, ['first', 'second', 'third']);
    assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(settled[0].value, 1);
    assert.equal(settled[1].reason.message, 'Qdrant refused the write');
    assert.equal(settled[2].value, 3);
});

test('writes to different collections do not wait for each other', async () => {
    const order = createCollectionWriteOrder();
    const blocked = held();
    const steps = [];
    const slow = order.queueWrite(COLLECTION, async () => { await blocked.promise; steps.push('slow'); });
    await order.queueWrite(OTHER_COLLECTION, async () => steps.push('other'));
    assert.deepEqual(steps, ['other']);
    blocked.release();
    await slow;
    assert.deepEqual(steps, ['other', 'slow']);
});

test('a failed insert leaves the record, so it holds nothing back', async () => {
    const order = createCollectionWriteOrder();
    const store = fakeStore();
    await assert.rejects(insert(order, store, COLLECTION, [LANTERN], Promise.reject(new Error('VLLM: Failed to get vector for text: 503'))), /503/);
    assert.equal(order.overtake(COLLECTION, { hashes: [LANTERN.hash] }), 0);
    await insert(order, store, COLLECTION, [LANTERN]);
    assert.deepEqual([...store.points.keys()], ['701']);
});
