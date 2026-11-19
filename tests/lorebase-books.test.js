// Tests LoreBase's books listing (lorebase-books.js): the account's names built as VectFox builds them, so a tenant
// prefix holds one account's books alone; each book's entries with keys, and each of the account's book tenants in its
// own LoreBase collection and in vectfox_main, with the book, count and embedding its points carry; one account's books
// listed apart from another's on the same Qdrant; and discovery's listing left as it was. Qdrant is stubbed at the
// backend's one request function.
//
//   node --test tests/

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import qdrantBackend, { LOREBASE_KEYS_COLLECTION, TENANT_FIELD } from '../qdrant-backend.js';
import { listLoreBooks, loreBaseAccountCollection, loreBaseTenantPrefix } from '../lorebase-books.js';

const SHARED = 'vectfox_main';
// The IDs VectFox gives the books "Harbor Atlas" and "Desert Atlas" (loreBaseBookCollectionId in src/features/lorebase/
// lorebase-vectors-core.js) for the accounts rabbit, rabbit-x and Wren_Keeper.
const HARBOR_RABBIT = 'vf_lorebase_qdrant_rabbit_harbor_atlas_19qag9zxydm';
const DESERT_RABBIT = 'vf_lorebase_qdrant_rabbit_desert_atlas_vq228d1ob7';
const HARBOR_RABBIT_X = 'vf_lorebase_qdrant_rabbit-x_harbor_atlas_19qag9zxydm';
const HARBOR_WREN = 'vf_lorebase_qdrant_wren-keeper_harbor_atlas_19qag9zxydm';
const EVENTBASE_RABBIT = 'vf_eventbase_qdrant_rabbit_harbor_night_4b183768-74d3-49b5-ad07-2b20031c8bf2';

/**
 * Answer the backend's requests as a Qdrant holding the named collections, and record each request with its body.
 * `answers` maps "METHOD endpoint" to a result, a function of the request's body giving one, or an Error to throw.
 */
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
    delete qdrantBackend._tenantIndexed;
});

// One point of each tenant, as VectFox stores LoreBase's points: the book, and the embedding that made it.
const POINTS = {
    [HARBOR_RABBIT]: { lorebookName: 'Harbor Atlas', embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' },
    [DESERT_RABBIT]: { lorebookName: 'Desert Atlas', embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' },
    [HARBOR_RABBIT_X]: { lorebookName: 'Harbor Atlas', embeddingSource: 'openrouter', embeddingModel: 'qwen/qwen3-embedding-8b' },
};
const pointOf = body => {
    const tenant = body.filter.must.find(clause => clause.key === TENANT_FIELD)?.match.value;
    return { points: POINTS[tenant] ? [{ payload: POINTS[tenant] }] : [] };
};

/**
 * rabbit's books in its own collection and, from before One shared collection was turned off, one in vectfox_main,
 * beside an EventBase chat and the book of another account, rabbit-x, whose own collection holds its books too.
 */
function stubTwoAccounts(keysByUser) {
    return stubQdrant([LOREBASE_KEYS_COLLECTION, 'vf_lorebase_rabbit', 'vf_lorebase_rabbit-x', SHARED], {
        [`POST /collections/${LOREBASE_KEYS_COLLECTION}/facet`]: body => ({ hits: keysByUser[body.filter.must[0].match.value] ?? [] }),
        'POST /collections/vf_lorebase_rabbit/facet': { hits: [{ value: HARBOR_RABBIT, count: 640 }, { value: DESERT_RABBIT, count: 12 }] },
        'POST /collections/vf_lorebase_rabbit-x/facet': { hits: [{ value: HARBOR_RABBIT_X, count: 300 }] },
        [`POST /collections/${SHARED}/facet`]: {
            hits: [{ value: EVENTBASE_RABBIT, count: 900 }, { value: HARBOR_RABBIT, count: 600 }, { value: HARBOR_RABBIT_X, count: 50 }],
        },
        'POST /collections/vf_lorebase_rabbit/points/scroll': pointOf,
        'POST /collections/vf_lorebase_rabbit-x/points/scroll': pointOf,
        [`POST /collections/${SHARED}/points/scroll`]: pointOf,
    });
}

const KEYS_BY_USER = {
    rabbit: [{ value: 'Harbor Atlas', count: 313 }, { value: 'Wren Journal', count: 4 }],
    'rabbit-x': [{ value: 'Harbor Atlas', count: 2 }],
};

test("builds an account's names as VectFox does, so its tenant prefix holds its own books alone", () => {
    assert.equal(loreBaseAccountCollection('rabbit'), 'vf_lorebase_rabbit');
    assert.equal(loreBaseAccountCollection('default-user'), 'vf_lorebase_default-user');
    assert.equal(loreBaseAccountCollection('Wren_Keeper'), 'vf_lorebase_wren-keeper');
    assert.equal(loreBaseTenantPrefix('rabbit'), 'vf_lorebase_qdrant_rabbit_');
    assert.ok(HARBOR_RABBIT.startsWith(loreBaseTenantPrefix('rabbit')));
    assert.ok(HARBOR_RABBIT_X.startsWith(loreBaseTenantPrefix('rabbit-x')));
    assert.ok(!HARBOR_RABBIT_X.startsWith(loreBaseTenantPrefix('rabbit')));
    assert.ok(HARBOR_WREN.startsWith(loreBaseTenantPrefix('Wren_Keeper')));
    assert.throws(() => loreBaseTenantPrefix(''), RangeError);
});

test("lists the account's books: each one's entries with keys, and its tenants in its own collection, then in vectfox_main", async () => {
    const requests = stubTwoAccounts(KEYS_BY_USER);
    const listing = await listLoreBooks(qdrantBackend, 'rabbit');
    assert.deepEqual(listing.keys, [{ book: 'Harbor Atlas', entryCount: 313 }, { book: 'Wren Journal', entryCount: 4 }]);
    assert.deepEqual(listing.vectors, [
        { collection: 'vf_lorebase_rabbit', tenant: HARBOR_RABBIT, book: 'Harbor Atlas', pointCount: 640, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' },
        { collection: 'vf_lorebase_rabbit', tenant: DESERT_RABBIT, book: 'Desert Atlas', pointCount: 12, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' },
        { collection: SHARED, tenant: HARBOR_RABBIT, book: 'Harbor Atlas', pointCount: 600, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3' },
    ]);
    const keysFacet = requests.find(request => request.endpoint === `/collections/${LOREBASE_KEYS_COLLECTION}/facet`);
    assert.deepEqual(keysFacet.body.filter, { must: [{ key: 'user', match: { value: 'rabbit' } }] });
    // A tenant's point is read inside that tenant, the sentinel left out.
    const sample = requests.find(request => request.endpoint === '/collections/vf_lorebase_rabbit/points/scroll');
    assert.deepEqual(sample.body.filter.must, [{ key: TENANT_FIELD, match: { value: HARBOR_RABBIT } }]);
    assert.deepEqual(sample.body.filter.must_not, [{ key: 'type', match: { value: '_vectfox_meta' } }]);
    assert.deepEqual(sample.body.with_payload, { include: ['lorebookName', 'embeddingSource', 'embeddingModel'] });
    assert.equal(sample.body.limit, 1);
});

test("lists one account's books apart from another's on the same Qdrant, never reading the other's collection", async () => {
    const rabbitRequests = stubTwoAccounts(KEYS_BY_USER);
    const rabbit = await listLoreBooks(qdrantBackend, 'rabbit');
    assert.equal(rabbit.vectors.some(tenant => tenant.tenant === HARBOR_RABBIT_X), false);
    assert.equal(rabbitRequests.some(request => request.endpoint.startsWith('/collections/vf_lorebase_rabbit-x/')), false);

    const otherRequests = stubTwoAccounts(KEYS_BY_USER);
    const rabbitX = await listLoreBooks(qdrantBackend, 'rabbit-x');
    assert.deepEqual(rabbitX.keys, [{ book: 'Harbor Atlas', entryCount: 2 }]);
    assert.deepEqual(rabbitX.vectors.map(tenant => [tenant.collection, tenant.tenant, tenant.pointCount, tenant.embeddingModel]), [
        ['vf_lorebase_rabbit-x', HARBOR_RABBIT_X, 300, 'qwen/qwen3-embedding-8b'],
        [SHARED, HARBOR_RABBIT_X, 50, 'qwen/qwen3-embedding-8b'],
    ]);
    assert.equal(otherRequests.some(request => request.endpoint.startsWith('/collections/vf_lorebase_rabbit/')), false);
});

test('a tenant whose point names no book is listed with none, and one whose points were all deleted is not listed', async () => {
    const unnamed = 'vf_lorebase_qdrant_rabbit_unnamed_1a2b3c';
    stubQdrant([LOREBASE_KEYS_COLLECTION, 'vf_lorebase_rabbit'], {
        [`POST /collections/${LOREBASE_KEYS_COLLECTION}/facet`]: { hits: [] },
        'POST /collections/vf_lorebase_rabbit/facet': { hits: [{ value: unnamed, count: 3 }, { value: 'vf_lorebase_qdrant_rabbit_emptied_9z', count: 0 }] },
        'POST /collections/vf_lorebase_rabbit/points/scroll': { points: [{ payload: {} }] },
    });
    assert.deepEqual(await listLoreBooks(qdrantBackend, 'rabbit'), {
        keys: [],
        vectors: [{ collection: 'vf_lorebase_rabbit', tenant: unnamed, book: null, pointCount: 3, embeddingSource: 'unknown', embeddingModel: '' }],
    });
});

test('an account with no LoreBase collection lists no vectors; Qdrant not set up, or a count it refuses, fails the listing', async () => {
    stubQdrant([LOREBASE_KEYS_COLLECTION], { [`POST /collections/${LOREBASE_KEYS_COLLECTION}/facet`]: { hits: [{ value: 'Harbor Atlas', count: 1 }] } });
    assert.deepEqual(await listLoreBooks(qdrantBackend, 'rabbit'), { keys: [{ book: 'Harbor Atlas', entryCount: 1 }], vectors: [] });

    stubQdrant([LOREBASE_KEYS_COLLECTION, 'vf_lorebase_rabbit'], {
        [`POST /collections/${LOREBASE_KEYS_COLLECTION}/facet`]: { hits: [] },
        'POST /collections/vf_lorebase_rabbit/facet': new Error('Qdrant API error (500): facet failed'),
    });
    await assert.rejects(listLoreBooks(qdrantBackend, 'rabbit'), /facet failed/);

    delete qdrantBackend._loreKeysCollectionReady;
    qdrantBackend.baseUrl = null;
    await assert.rejects(listLoreBooks(qdrantBackend, 'rabbit'), /LoreBase keeps its keys in Qdrant/);
    await assert.rejects(listLoreBooks(qdrantBackend, ''), RangeError);
});

test("discovery still lists an account's LoreBase collection whole, its books' tenants not split out", async () => {
    stubQdrant(['vf_lorebase_rabbit'], {
        'POST /collections/vf_lorebase_rabbit/points/scroll': { points: [{ payload: { embeddingSource: 'custom' } }] },
        'POST /collections/vf_lorebase_rabbit/points/count': { count: 652 },
    });
    const { collections, tenantsListed } = await qdrantBackend.describeCollections();
    assert.equal(tenantsListed, true);
    assert.deepEqual(collections, [{ id: 'vf_lorebase_rabbit', source: 'custom', chunkCount: 652 }]);
});
