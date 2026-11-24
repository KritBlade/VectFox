// A Qdrant for tests: collections of points and payload indexes kept in memory behind the Qdrant backend's one request
// function, with the filters, ordered scrolls and point reads Similharity's change numbers use (qdrant-changes.js), and
// the events VectFox's EventBase writes. Not a test file itself: the tests of change numbers import it.

import qdrantBackend, { CHANGE_LOG_COLLECTION, CHANGE_NUMBER_FIELD } from '../qdrant-backend.js';

const NUMBER = CHANGE_NUMBER_FIELD;

/** An error as the backend's request function throws one for a Qdrant status. */
function qdrantError(method, endpoint, status, message) {
    return new Error(`Qdrant ${method} ${endpoint} failed: ${status} ${message}`);
}

/** Whether a payload meets one condition of a Qdrant filter, a nested filter included. */
function meets(payload, condition) {
    if (condition.must || condition.should || condition.must_not) return matches(payload, condition);
    if (condition.is_empty) {
        const value = payload[condition.is_empty.key];
        return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
    }
    const value = payload[condition.key];
    const values = Array.isArray(value) ? value : [value];
    if (condition.match && 'value' in condition.match) return values.includes(condition.match.value);
    if (condition.match && 'any' in condition.match) return values.some(one => condition.match.any.includes(one));
    if (condition.range) {
        const { gt, gte, lt, lte } = condition.range;
        return typeof value === 'number' && (gt === undefined || value > gt) && (gte === undefined || value >= gte)
            && (lt === undefined || value < lt) && (lte === undefined || value <= lte);
    }
    throw new Error(`fake Qdrant: no condition like ${JSON.stringify(condition)}`);
}

/** Whether a payload meets a Qdrant filter: every must, one should when any is given, no must_not. */
function matches(payload, filter) {
    if (!filter) return true;
    return (filter.must ?? []).every(condition => meets(payload, condition))
        && (!filter.should?.length || filter.should.some(condition => meets(payload, condition)))
        && !(filter.must_not ?? []).some(condition => meets(payload, condition));
}

/** A point as Qdrant gives it back: its payload whole, only the fields named, or none. */
function shaped(point, withPayload) {
    if (withPayload === true) return { id: point.id, payload: structuredClone(point.payload) };
    if (withPayload?.include) {
        return { id: point.id, payload: Object.fromEntries(withPayload.include.filter(field => field in point.payload).map(field => [field, point.payload[field]])) };
    }
    return { id: point.id };
}

/** Point IDs in Qdrant's order: whole numbers first, then UUIDs. */
function byPointId(first, second) {
    const isNumber = point => typeof point.id === 'number';
    if (isNumber(first) !== isNumber(second)) return isNumber(first) ? -1 : 1;
    return isNumber(first) ? first.id - second.id : String(first.id).localeCompare(String(second.id));
}

/**
 * A Qdrant holding collections of points and payload indexes in memory, set as the backend's one request function.
 * Every request is recorded. `failWhen(test)` fails the requests a test picks with a 500; `holdWhen(test)` holds them
 * until its `release()` is called, and its `reached` settles when the first one arrives. A scroll ordered by a field needs an integer index on it, as Qdrant's does.
 * Its address is the backend's, so a test that names its own stands for another Qdrant, which the plugin's change
 * numbers keep apart.
 */
export function fakeQdrant({ version = '1.20.2', url = 'http://qdrant.test' } = {}) {
    const collections = new Map();
    const requests = [];
    let failure = null;
    let hold = null;

    function collectionNamed(method, endpoint, name) {
        const collection = collections.get(name);
        if (!collection) throw qdrantError(method, endpoint, 404, `Not found: Collection \`${name}\` doesn't exist!`);
        return collection;
    }
    const pointsOf = collection => [...collection.points.values()].sort(byPointId);
    const selected = (collection, body) => (body.points
        ? body.points.map(id => collection.points.get(id)).filter(Boolean)
        : pointsOf(collection).filter(point => matches(point.payload, body.filter)));
    const schemaReport = schema => (typeof schema === 'object'
        ? { data_type: schema.type, params: { is_tenant: schema.is_tenant === true } }
        : { data_type: schema });

    function scroll(method, endpoint, collection, body) {
        const points = pointsOf(collection).filter(point => matches(point.payload, body.filter));
        const limit = body.limit ?? 10;
        const orderBy = body.order_by;
        if (orderBy) {
            const index = collection.indexes.get(orderBy.key);
            if ((typeof index === 'object' ? index.type : index) !== 'integer') {
                throw qdrantError(method, endpoint, 400, `Bad request: No range index for \`order_by\` key: \`${orderBy.key}\``);
            }
            const sign = orderBy.direction === 'desc' ? -1 : 1;
            const numbered = points.filter(point => typeof point.payload[orderBy.key] === 'number')
                .sort((first, second) => sign * (first.payload[orderBy.key] - second.payload[orderBy.key]));
            return { points: numbered.slice(0, limit).map(point => shaped(point, body.with_payload)), next_page_offset: null };
        }
        const start = body.offset === undefined ? 0 : points.findIndex(point => point.id === body.offset);
        return {
            points: points.slice(start, start + limit).map(point => shaped(point, body.with_payload)),
            next_page_offset: points[start + limit]?.id ?? null,
        };
    }

    qdrantBackend.baseUrl = url;
    qdrantBackend.serverVersion = version;
    qdrantBackend._request = async (method, endpoint, body = null) => {
        requests.push({ method, endpoint, body: body === null ? null : structuredClone(body) });
        if (failure?.(method, endpoint, body)) throw qdrantError(method, endpoint, 500, 'made-up failure');
        if (hold?.test(method, endpoint, body)) {
            hold.reach();
            await hold.held;
        }
        const path = endpoint.split('?')[0];
        if (method === 'GET' && path === '/') return { title: 'qdrant - vector search engine', version };
        if (method === 'GET' && path === '/collections') return { result: { collections: [...collections.keys()].map(name => ({ name })) } };
        const whole = path.match(/^\/collections\/([^/]+)$/);
        if (whole) {
            const name = whole[1];
            if (method === 'GET') {
                const collection = collectionNamed(method, endpoint, name);
                const payloadSchema = Object.fromEntries([...collection.indexes].map(([field, schema]) => [field, schemaReport(schema)]));
                return { result: { points_count: collection.points.size, config: { params: { vectors: collection.vectors } }, payload_schema: payloadSchema } };
            }
            if (method === 'PUT') {
                if (collections.has(name)) throw qdrantError(method, endpoint, 409, `Wrong input: Collection \`${name}\` already exists!`);
                collections.set(name, { vectors: body?.vectors ?? {}, points: new Map(), indexes: new Map() });
                return { result: true };
            }
            if (method === 'DELETE') {
                collectionNamed(method, endpoint, name);
                collections.delete(name);
                return { result: true };
            }
        }
        const [, name, operation] = path.match(/^\/collections\/([^/]+)\/(.+)$/) ?? [];
        const collection = collectionNamed(method, endpoint, name);
        if (method === 'PUT' && operation === 'index') {
            collection.indexes.set(body.field_name, body.field_schema);
            return { result: { status: 'acknowledged' } };
        }
        if (method === 'PUT' && operation === 'points') {
            for (const point of body.points) collection.points.set(point.id, { id: point.id, payload: structuredClone(point.payload ?? {}) });
            return { result: { status: 'completed' } };
        }
        if (method === 'POST' && operation === 'points') {
            return { result: body.ids.filter(id => collection.points.has(id)).map(id => shaped(collection.points.get(id), body.with_payload)) };
        }
        if (method === 'POST' && operation === 'points/scroll') return { result: scroll(method, endpoint, collection, body) };
        if (method === 'POST' && operation === 'points/count') {
            return { result: { count: pointsOf(collection).filter(point => matches(point.payload, body.filter)).length } };
        }
        if (method === 'POST' && operation === 'points/delete') {
            for (const point of selected(collection, body)) collection.points.delete(point.id);
            return { result: { status: 'completed' } };
        }
        if (method === 'POST' && operation === 'points/payload') {
            for (const point of selected(collection, body)) Object.assign(point.payload, structuredClone(body.payload));
            return { result: { status: 'completed' } };
        }
        throw new Error(`fake Qdrant: no route for ${method} ${endpoint}`);
    };

    return {
        requests,
        /** Make a collection holding these points, each `{ id, payload }`, with no payload index yet. */
        seed(name, points = []) {
            collections.set(name, { vectors: { size: 2, distance: 'Cosine' }, points: new Map(points.map(point => [point.id, structuredClone(point)])), indexes: new Map() });
        },
        has: name => collections.has(name),
        payloads: name => pointsOf(collectionNamed('GET', `/collections/${name}`, name)).map(point => point.payload),
        /** The change log's records in number order, each without the time it was written. */
        records: () => (collections.has(CHANGE_LOG_COLLECTION)
            ? pointsOf(collections.get(CHANGE_LOG_COLLECTION)).map(({ payload: { recorded_at: _recordedAt, ...record } }) => record).sort((first, second) => first[NUMBER] - second[NUMBER])
            : []),
        failWhen(test) { failure = test; },
        holdWhen(test) {
            let release;
            let reach;
            const reached = new Promise(resolve => { reach = resolve; });
            hold = { test, reach, held: new Promise(resolve => { release = resolve; }) };
            return { reached, release: () => { hold = null; release(); } };
        },
    };
}

/** An event as VectFox's EventBase inserts one. */
export function event(hash, metadata = {}) {
    return { hash, text: `Event ${hash} at the harbor.`, vector: [0.6, 0.8], metadata: { event_id: `ev-${hash}`, ...metadata } };
}

/** A stored event: with its number, or with none, as one stored before numbers existed. */
export function storedEvent(hash, number, payload = {}) {
    return {
        id: hash,
        payload: { hash, text: `Event ${hash} at the harbor.`, event_id: `ev-${hash}`, type: 'chat', sourceId: 'unknown', ...(number ? { [NUMBER]: number } : {}), ...payload },
    };
}
