// Tests that payload-index creation reads a collection's own schema and writes only the indexes missing from it,
// instead of re-asserting all twenty on every page load. Qdrant is stubbed at the backend's one request function, so
// no server is needed, and every test names the requests that would be sent.
//
//   npm test

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend from '../qdrant-backend.js';

const COLLECTION = 'ollama:chat_1';
// Qdrant stores the collection without the source prefix VectFox names it by.
const STORED = 'chat_1';

// The configured index set, in the order it is created. `type` and `sourceId` are tenant fields.
const TYPES = {
    type: 'keyword',
    sourceId: 'keyword',
    embeddingSource: 'keyword',
    embeddingModel: 'keyword',
    characterName: 'keyword',
    chatId: 'keyword',
    keywords: 'keyword',
    text: 'text',
    hash: 'integer',
    timestamp: 'integer',
    importance: 'integer',
    source_window_end: 'integer',
    timeline_sort_key: 'integer',
    should_persist: 'bool',
    characters: 'keyword',
    locations: 'keyword',
    factions: 'keyword',
    concepts: 'keyword',
    items: 'keyword',
    event_type: 'keyword',
};
const FIELDS = Object.keys(TYPES);

/** Answer each request from the list in order, recording the method, endpoint, body and extra headers it carried. */
function stubQdrant(answers) {
    const requests = [];
    qdrantBackend.baseUrl = 'http://qdrant.test:6333';
    qdrantBackend._request = async (method, endpoint, body = null, maxRetries = 3, headers = null) => {
        requests.push({ method, endpoint, body, headers });
        const answer = answers.shift();
        if (!answer) throw new Error(`unexpected request: ${method} ${endpoint}`);
        return answer();
    };
    return requests;
}

/** A payload_schema covering `fields`, or every configured field by default. */
function schemaWith(fields = FIELDS) {
    const schema = {};
    for (const field of fields) {
        schema[field] = { data_type: TYPES[field], points: 3 };
    }
    return schema;
}

/** The request a creation for one configured field should be. */
function creation(field) {
    return {
        method: 'PUT',
        endpoint: `/collections/${STORED}/index`,
        body: {
            field_name: field,
            field_schema: field === 'type' || field === 'sourceId'
                ? { type: 'keyword', is_tenant: true }
                : TYPES[field],
        },
        headers: null,
    };
}

/** Commands, in order, as a test reads them. */
const commands = requests => requests.map(({ method, endpoint }) => `${method} ${endpoint}`);

afterEach(() => {
    delete qdrantBackend._request;
    qdrantBackend.baseUrl = null;
});

test('a fully indexed collection is read once and written not at all', async () => {
    const requests = stubQdrant([() => ({ result: { payload_schema: schemaWith() } })]);
    assert.equal(await qdrantBackend.createPayloadIndexes(COLLECTION), true);
    // One read answers every field, so one page load per collection costs one round trip, not twenty.
    assert.deepEqual(commands(requests), [`GET /collections/${STORED}`]);
    // The schema is small: asking for it uncompressed keeps the read cheap on a kept-alive connection.
    assert.deepEqual(requests[0].headers, { 'accept-encoding': 'identity' });
});

test('a partly indexed collection gets exactly the missing indexes, once each, in the configured order', async () => {
    const present = ['type', 'sourceId', 'keywords', 'hash', 'concepts'];
    const requests = stubQdrant([() => ({ result: { payload_schema: schemaWith(present) } })]);

    await qdrantBackend.createPayloadIndexes(COLLECTION);

    const missing = FIELDS.filter(field => !present.includes(field));
    assert.deepEqual(requests[0], {
        method: 'GET',
        endpoint: `/collections/${STORED}`,
        body: null,
        headers: { 'accept-encoding': 'identity' },
    });
    // Both the order and the request body, so a present field cannot be re-created and a missing one cannot be skipped.
    assert.deepEqual(requests.slice(1), missing.map(creation));
});

test('a reported type that disagrees with the configured schema is re-issued, and an unreported type counts as present', async () => {
    const present = ['type', 'hash', 'text', 'embeddingSource'];
    const schema = schemaWith(present);
    schema.text = { data_type: 'keyword', points: 0 };   // configured as text: re-issued
    schema.hash = { points: 4 };                         // no reported type: present
    const requests = stubQdrant([() => ({ result: { payload_schema: schema } })]);

    await qdrantBackend.createPayloadIndexes(COLLECTION);

    const reissued = FIELDS.filter(field => !present.includes(field) || field === 'text');
    assert.deepEqual(requests.slice(1), reissued.map(creation));
    assert.equal(requests.some(({ body }) => body?.field_name === 'hash'), false);
});

test('a collection with no schema yet receives every configured index', async () => {
    for (const info of [{ result: { payload_schema: {} } }, { result: { status: 'green' } }]) {
        const requests = stubQdrant([() => info]);
        await qdrantBackend.createPayloadIndexes(COLLECTION);
        assert.deepEqual(requests.slice(1), FIELDS.map(creation));
    }
});

test('creating a collection still gives it the full index set at creation time', async () => {
    const requests = stubQdrant([
        () => ({ result: { collections: [] } }),
        () => ({ result: true }),
        () => ({ result: { status: 'green', payload_schema: {} } }),
        ...FIELDS.map(() => ({ result: { operation_id: 1, status: 'acknowledged' } })),
    ]);

    await qdrantBackend.ensureCollection(COLLECTION, 768);

    assert.deepEqual(commands(requests), [
        'GET /collections',
        `PUT /collections/${STORED}`,
        `GET /collections/${STORED}`,
        ...FIELDS.map(() => `PUT /collections/${STORED}/index`),
    ]);
});

test('backfilling an older collection reads its schema instead of the collection list', async () => {
    const requests = stubQdrant([
        () => ({ result: { payload_schema: {} } }),
        ...FIELDS.map(() => ({ result: { operation_id: 1, status: 'acknowledged' } })),
    ]);

    await qdrantBackend.ensurePayloadIndexes(COLLECTION);

    // The old existence check was a whole-collection listing; the schema read now answers it.
    assert.equal(requests.some(({ endpoint }) => endpoint === '/collections'), false);
    assert.deepEqual(requests.slice(1), FIELDS.map(creation));
});

test('a collection that no longer exists gets one read and no writes, and does not throw', async () => {
    const requests = stubQdrant([
        () => { throw new Error(`Qdrant GET /collections/${STORED} failed: 404 Collection \`${STORED}\` doesn't exist!`); },
    ]);

    await assert.doesNotReject(() => qdrantBackend.ensurePayloadIndexes(COLLECTION));

    assert.deepEqual(commands(requests), [`GET /collections/${STORED}`]);
});

test('any other schema-read failure falls back to creating every index, as today', async () => {
    const requests = stubQdrant([
        () => { throw new Error(`Qdrant GET /collections/${STORED} failed: 500 Internal Server Error`); },
        ...FIELDS.map(() => ({ result: { operation_id: 1, status: 'acknowledged' } })),
    ]);

    await qdrantBackend.createPayloadIndexes(COLLECTION);

    assert.deepEqual(requests.slice(1), FIELDS.map(creation));
});

test('an "already exists" answer to a creation is swallowed and the remaining indexes are still created', async () => {
    const requests = stubQdrant([
        () => ({ result: { payload_schema: {} } }),
        () => { throw new Error(`Qdrant PUT /collections/${STORED}/index failed: 409 Index already exists`); },
        ...FIELDS.slice(1).map(() => ({ result: { operation_id: 1, status: 'acknowledged' } })),
    ]);

    await assert.doesNotReject(() => qdrantBackend.createPayloadIndexes(COLLECTION));

    // A concurrent creation cannot fail init, and cannot stop the rest of the set either.
    assert.equal(requests.filter(({ method }) => method === 'PUT').length, FIELDS.length);
});

test('a repeated invocation writes nothing the second time', async () => {
    const requests = stubQdrant([
        () => ({ result: { payload_schema: {} } }),
        ...FIELDS.map(() => ({ result: { operation_id: 1, status: 'acknowledged' } })),
        () => ({ result: { payload_schema: schemaWith() } }),
    ]);

    await qdrantBackend.createPayloadIndexes(COLLECTION);
    const afterFirst = requests.length;
    await qdrantBackend.createPayloadIndexes(COLLECTION);

    assert.deepEqual(commands(requests.slice(afterFirst)), [`GET /collections/${STORED}`]);
});

test('init reads the multitenancy collection once, then one read per collection, and writes nothing', async () => {
    const list = () => ({ result: { collections: [{ name: 'vectfox_main' }, { name: STORED }] } });
    const requests = stubQdrant([
        list,                                                    // connection test
        () => ({ version: '1.20.0' }),                           // version probe
        () => ({ result: { payload_schema: schemaWith() } }),    // vectfox_main, ensured before the loop
        list,                                                    // getCollections
        () => ({ result: { payload_schema: schemaWith() } }),    // chat_1
    ]);

    await qdrantBackend.initialize();

    assert.deepEqual(commands(requests), [
        'GET /collections',
        'GET /',
        'GET /collections/vectfox_main',
        'GET /collections',
        `GET /collections/${STORED}`,
    ]);
    assert.equal(requests.some(({ method }) => method === 'PUT'), false);
});
