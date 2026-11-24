/**
 * Change numbers and the change log of Similharity's Qdrant collections, which VectFox's EventBase feed reads (D12 and
 * section 5.3 of InternalProject/Vectfox/plans/vectfox-public-api.md).
 *
 * Every point Similharity writes into a Qdrant collection, by an insert or an edit, carries a change number in
 * `change_number`, which Similharity gives and which replaces any number a client sends. Every removal of an event, a
 * point with an `event_id`, leaves a record in the change log, and every purge leaves one record that the collection,
 * or one tenant of it, was emptied. A record takes its number from the same counter as the collection's points, so a
 * read of what changed after a number gets the points written and the events removed since, in number order.
 *
 * There is one counter per Qdrant collection, kept in this server's memory. Each function here runs inside the
 * collection's turn in the write queue (collection-write-order.js), and a write it numbers is stored with wait=true
 * before the turn ends, so two writes never take the same number, no point with a lower number appears after a reader
 * has read a higher one, and a change read never sees half a write. After a restart, the first turn in a collection
 * sets its counter to the highest number among its points and its records (a scroll ordered by the number, Qdrant
 * 1.8+). A number taken by a write that failed may be given again after a restart, as nothing holds it, and no answer
 * gives a cursor that nothing holds.
 *
 * A removal's records are written in its turn, before its points go, in one request: a record that cannot be written
 * removes nothing. The change log is a Qdrant collection with no vectors, which no chunk route writes, deletes or
 * purges, and which the collection listing leaves out (qdrant-backend.js).
 *
 * On a Qdrant older than 1.8, or one whose version is unknown, nothing is numbered or recorded: each write is the
 * backend's own, and a change read answers that it is not supported.
 */

import crypto from 'node:crypto';
import { CHANGE_LOG_COLLECTION, CHANGE_NUMBER_FIELD } from './qdrant-backend.js';
import { TENANT_FIELDS } from './collection-write-order.js';

/** What a change log record says happened: an event removed, or a collection, or one tenant of it, emptied. */
export const CHANGE_KINDS = Object.freeze({ removed: 'removed', emptied: 'emptied' });

/** How many changes a change read gives when asked for no number, and the most it gives. */
export const DEFAULT_CHANGES_PER_READ = 100;
export const MOST_CHANGES_PER_READ = 1000;

// A record's own fields. Its tenant fields are those of the point it records, or of the purge's filters.
const RECORD_COLLECTION_FIELD = 'collection';
const RECORD_KIND_FIELD = 'kind';

/** The change log's payload indexes: the collection and kind a read filters on, the number it orders by, the tenants. */
const CHANGE_LOG_INDEXES = Object.freeze([
    [RECORD_COLLECTION_FIELD, 'keyword'],
    [RECORD_KIND_FIELD, 'keyword'],
    [CHANGE_NUMBER_FIELD, 'integer'],
    ...TENANT_FIELDS.map(field => [field, 'keyword']),
]);

const POINTS_PER_SCROLL = 1000;

/** Whether a Qdrant request failed because its collection is not there. */
function isMissingCollection(error) {
    return /\bfailed: 404\b/.test(error?.message ?? '');
}

/** Whether a Qdrant request failed because what it makes is there already. */
function isAlreadyMade(error) {
    return Boolean(error?.message?.includes('already exists') || error?.message?.includes('409'));
}

/** A point's or a record's change number: 0 when it has none, as a point stored before numbers existed has none. */
function numberOf(point) {
    const number = point?.payload?.[CHANGE_NUMBER_FIELD];
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** The tenant fields a payload or a request's filters hold, those with a value. */
function tenantFieldsOf(fields) {
    return Object.fromEntries(TENANT_FIELDS.filter(field => fields?.[field]).map(field => [field, fields[field]]));
}

/** The clause that picks one Qdrant collection's records. */
function recordsOf(collection) {
    return { key: RECORD_COLLECTION_FIELD, match: { value: collection } };
}

/** A point as the chunk routes give one: its hash, its text and its whole payload. */
function asItem(point) {
    return { hash: point.payload?.hash, text: point.payload?.text, metadata: point.payload ?? {} };
}

/** A removal record as a change read gives one. */
function asRemoval(record) {
    return { hash: record.payload.hash, event_id: record.payload.event_id, [CHANGE_NUMBER_FIELD]: numberOf(record) };
}

/**
 * The change numbers and the change log of the Qdrant collections a backend reaches.
 * @param {object} backend - The Qdrant backend (qdrant-backend.js)
 * @returns {{insert: Function, updateMetadata: Function, updateText: Function, remove: Function, purge: Function,
 *   readChanges: Function}} Each to be run inside the collection's turn in the write queue
 */
export function createQdrantChanges(backend) {
    /** The last number given in each Qdrant collection, by the Qdrant's address and the collection's name. */
    const lastNumbers = new Map();
    /** The Qdrant addresses whose change log this process has made or found, with its indexes. */
    const readyChangeLogs = new Set();
    /** The collections whose payload indexes this process has checked, by address and name. */
    const checkedCollections = new Set();

    const keyOf = collection => `${backend.baseUrl}\u0000${collection}`;
    const isOn = () => Boolean(backend.baseUrl) && backend.supportsChangeNumbers();

    /**
     * A collection's stored name, the name counters and records use.
     * @param {string} collectionId
     * @returns {string}
     * @throws {RangeError} When it names the change log
     */
    function storedNameOf(collectionId) {
        const collection = backend._parseCollectionName(collectionId);
        if (collection === CHANGE_LOG_COLLECTION) {
            throw new RangeError(`${CHANGE_LOG_COLLECTION} is Similharity's change log, which no chunk route writes, deletes, purges or reads changes of.`);
        }
        return collection;
    }

    /** Make the change log, with no vectors, and the indexes it lacks, once per process for each Qdrant. */
    async function ensureChangeLog() {
        if (readyChangeLogs.has(backend.baseUrl)) return;
        let payloadSchema = null;
        try {
            const info = await backend._request('GET', `/collections/${CHANGE_LOG_COLLECTION}`);
            payloadSchema = info?.result?.payload_schema ?? {};
        } catch (error) {
            if (!isMissingCollection(error)) throw error;
        }
        if (payloadSchema === null) {
            try {
                await backend._request('PUT', `/collections/${CHANGE_LOG_COLLECTION}`, { vectors: {} });
            } catch (error) {
                // EXPECTED: another collection's turn made it between the read and this request.
                if (!isAlreadyMade(error)) throw error;
            }
            payloadSchema = {};
        }
        for (const [field, schema] of CHANGE_LOG_INDEXES) {
            if (backend._isIndexAsConfigured(payloadSchema[field], schema)) continue;
            try {
                await backend._request('PUT', `/collections/${CHANGE_LOG_COLLECTION}/index?wait=true`, { field_name: field, field_schema: schema });
            } catch (error) {
                // EXPECTED: another collection's turn made the index meanwhile.
                if (!isAlreadyMade(error)) throw error;
            }
        }
        readyChangeLogs.add(backend.baseUrl);
    }

    /**
     * The points a filter picks in number order, those without a number left out, as Qdrant's order_by leaves them;
     * none when the collection is not there.
     * @param {string} collection
     * @param {object} filter
     * @param {{direction: 'asc'|'desc', limit: number, withPayload?: boolean|object}} order
     * @returns {Promise<object[]>}
     */
    async function byNumber(collection, filter, { direction, limit, withPayload = true }) {
        try {
            const response = await backend._request('POST', `/collections/${collection}/points/scroll`, {
                filter, limit, with_payload: withPayload, with_vector: false, order_by: { key: CHANGE_NUMBER_FIELD, direction },
            });
            return response?.result?.points ?? [];
        } catch (error) {
            if (isMissingCollection(error)) return [];
            throw error;
        }
    }

    /** The highest number among the points or records a filter picks, 0 when none has one. */
    async function highestNumber(collection, filter) {
        const [highest] = await byNumber(collection, filter, { direction: 'desc', limit: 1, withPayload: { include: [CHANGE_NUMBER_FIELD] } });
        return numberOf(highest);
    }

    /** Every point a filter picks, a page at a time in point-ID order; none when the collection is not there. */
    async function everyPoint(collection, filter, withPayload = true) {
        const points = [];
        let offset = null;
        try {
            do {
                const response = await backend._request('POST', `/collections/${collection}/points/scroll`, {
                    filter, limit: POINTS_PER_SCROLL, with_payload: withPayload, with_vector: false, ...(offset === null ? {} : { offset }),
                });
                points.push(...(response?.result?.points ?? []));
                offset = response?.result?.next_page_offset ?? null;
            } while (offset !== null);
        } catch (error) {
            if (isMissingCollection(error)) return [];
            throw error;
        }
        return points;
    }

    /**
     * Ready a collection's numbers to be read or given: the change log made, and the collection's payload indexes
     * checked once it exists, so the number's range index, which order_by needs, is there even where the start-up
     * index pass could not make it.
     * @param {string} collection
     */
    async function prepare(collection) {
        await ensureChangeLog();
        const key = keyOf(collection);
        if (checkedCollections.has(key)) return;
        if (await backend.createPayloadIndexes(collection)) checkedCollections.add(key);
    }

    /**
     * The next numbers of a collection's counter, for one write in the collection's turn. The first turn after a
     * restart sets the counter to the highest number among the collection's points and its records.
     * @param {string} collection
     * @param {number} count
     * @returns {Promise<number[]>}
     */
    async function takeNumbers(collection, count) {
        const key = keyOf(collection);
        if (!lastNumbers.has(key)) {
            await prepare(collection);
            const [inPoints, inRecords] = await Promise.all([
                highestNumber(collection, undefined),
                highestNumber(CHANGE_LOG_COLLECTION, { must: [recordsOf(collection)] }),
            ]);
            lastNumbers.set(key, Math.max(inPoints, inRecords));
        }
        const last = lastNumbers.get(key);
        lastNumbers.set(key, last + count);
        return Array.from({ length: count }, (_, position) => last + 1 + position);
    }

    /** Write records to the change log in one request, each with an ID of its own, so a retry writes them once. */
    async function writeRecords(records) {
        await ensureChangeLog();
        const recordedAt = new Date().toISOString();
        await backend._request('PUT', `/collections/${CHANGE_LOG_COLLECTION}/points?wait=true`, {
            points: records.map(record => ({ id: crypto.randomUUID(), vector: {}, payload: { ...record, recorded_at: recordedAt } })),
        });
    }

    /**
     * The points a delete removes, read as the delete finds them: by payload hash inside the tenant its filters name,
     * or by point ID; none when the collection is not there.
     * @returns {Promise<object[]>} Each with its hash, `event_id` and tenant fields
     */
    async function pointsDeleted(collection, pointHashes, filters) {
        const include = ['hash', 'event_id', ...TENANT_FIELDS];
        if (backend._namesTenant(filters)) {
            return everyPoint(collection, { must: [...backend._scopeMust(filters), { key: 'hash', match: { any: pointHashes } }] }, { include });
        }
        try {
            const response = await backend._request('POST', `/collections/${collection}/points`, {
                ids: pointHashes, with_payload: { include }, with_vector: false,
            });
            return response?.result ?? [];
        } catch (error) {
            if (isMissingCollection(error)) return [];
            throw error;
        }
    }

    /** Whether a Qdrant collection is there. */
    async function collectionExists(collection) {
        try {
            await backend._request('GET', `/collections/${collection}`);
            return true;
        } catch (error) {
            if (isMissingCollection(error)) return false;
            throw error;
        }
    }

    /**
     * The change log filter for one collection's records after a number: with a tenant named, its records and those of
     * purges of the whole Qdrant collection, which name no tenant and emptied every one.
     */
    function recordsFilter(collection, filters, after = null) {
        const must = [recordsOf(collection)];
        if (after !== null) must.push({ key: CHANGE_NUMBER_FIELD, range: { gt: after } });
        const tenant = tenantFieldsOf(filters);
        if (!Object.keys(tenant).length) return { must };
        return {
            must,
            should: [
                { must: Object.entries(tenant).map(([field, value]) => ({ key: field, match: { value } })) },
                { must: TENANT_FIELDS.map(field => ({ is_empty: { key: field } })) },
            ],
        };
    }

    /**
     * Insert points, each numbered: the number replaces any the item's metadata holds.
     * @param {string} collectionId
     * @param {Array<object>} items - As insertVectors takes them
     * @param {object} tenantMetadata
     * @param {object} [opts]
     */
    async function insert(collectionId, items, tenantMetadata, opts) {
        const collection = storedNameOf(collectionId);
        if (!isOn() || !items.length) return backend.insertVectors(collectionId, items, tenantMetadata, opts);
        const numbers = await takeNumbers(collection, items.length);
        const numbered = items.map((item, position) => ({ ...item, metadata: { ...(item.metadata ?? {}), [CHANGE_NUMBER_FIELD]: numbers[position] } }));
        return backend.insertVectors(collectionId, numbered, tenantMetadata, opts);
    }

    /** Change a point's metadata, giving it the next number, which replaces any the metadata holds. */
    async function updateMetadata(collectionId, hash, metadata, filters) {
        const collection = storedNameOf(collectionId);
        if (!isOn()) return backend.updateItemMetadata(collectionId, hash, metadata, filters);
        const [number] = await takeNumbers(collection, 1);
        return backend.updateItemMetadata(collectionId, hash, { ...metadata, [CHANGE_NUMBER_FIELD]: number }, filters);
    }

    /** Change a point's text, its hash and vector with it, giving it the next number. Its event is not removed. */
    async function updateText(collectionId, hash, updates, filters) {
        const collection = storedNameOf(collectionId);
        if (!isOn()) return backend.updateItem(collectionId, hash, updates, filters);
        const [number] = await takeNumbers(collection, 1);
        return backend.updateItem(collectionId, hash, { ...updates, [CHANGE_NUMBER_FIELD]: number }, filters);
    }

    /**
     * Delete points by hash, after recording each event among them in the change log.
     * @throws {Error} When the records cannot be written, and then nothing is deleted
     */
    async function remove(collectionId, hashes, filters = {}) {
        const collection = storedNameOf(collectionId);
        if (!isOn() || !hashes.length) return backend.deleteVectors(collectionId, hashes, filters);
        const events = (await pointsDeleted(collection, backend._pointHashesOf(hashes), filters))
            .filter(point => typeof point?.payload?.event_id === 'string' && point.payload.event_id);
        if (events.length) {
            const numbers = await takeNumbers(collection, events.length);
            await writeRecords(events.map((point, position) => ({
                [RECORD_COLLECTION_FIELD]: collection,
                [RECORD_KIND_FIELD]: CHANGE_KINDS.removed,
                [CHANGE_NUMBER_FIELD]: numbers[position],
                ...tenantFieldsOf(point.payload),
                hash: point.payload.hash,
                event_id: point.payload.event_id,
            })));
        }
        return backend.deleteVectors(collectionId, hashes, filters);
    }

    /**
     * Purge one tenant of a collection, when filters are given, or the whole Qdrant collection, after recording that
     * it was emptied. A purge whose filters name no tenant deletes nothing (purgeCollection refuses it), and a
     * collection that is not there has nothing to empty, so neither leaves a record.
     * @throws {Error} When the record cannot be written, and then nothing is purged
     */
    async function purge(collectionId, filters = {}) {
        const collection = storedNameOf(collectionId);
        const isTenantPurge = Object.keys(filters ?? {}).length > 0;
        const purgeNow = () => (isTenantPurge ? backend.purgeCollection(collectionId, filters) : backend.purgeAll(collectionId));
        if (!isOn()) return purgeNow();
        if ((!isTenantPurge || backend._namesTenant(filters)) && await collectionExists(collection)) {
            const [number] = await takeNumbers(collection, 1);
            await writeRecords([{
                [RECORD_COLLECTION_FIELD]: collection,
                [RECORD_KIND_FIELD]: CHANGE_KINDS.emptied,
                [CHANGE_NUMBER_FIELD]: number,
                ...(isTenantPurge ? tenantFieldsOf(filters) : {}),
            }]);
        }
        return purgeNow();
    }

    /**
     * What changed in a collection, or in the tenant its filters name. With no `after`, a full read: every point,
     * those stored before numbers existed included, and the highest number the collection's points and records hold
     * as the cursor. With `after`, a page of the changes after that number, in number order: the points written since
     * and the events removed since, and, when the collection was emptied since, `emptied` with only what came after.
     * `cursor` is the last number the page covers, and `hasMore` says to read again from it.
     * @param {string} collectionId
     * @param {object} [filters] - The tenant, and any fields narrowing the points, as the other chunk routes take them
     * @param {{after?: number|null, limit?: number}} [read]
     * @returns {Promise<object>} `{ supported: true, points, removed, emptied, cursor, hasMore }`, or
     *   `{ supported: false, reason }` on a Qdrant without change numbers
     * @throws {RangeError} When `after` or `limit` is not a whole number in range, or the collection is the change log;
     *   {Error} when Qdrant is not set up, or cannot be read
     */
    async function readChanges(collectionId, filters = {}, { after = null, limit = DEFAULT_CHANGES_PER_READ } = {}) {
        const collection = storedNameOf(collectionId);
        if (after !== null && !(Number.isSafeInteger(after) && after >= 0)) {
            throw new RangeError('after must be a whole number of 0 or more, or left out for a full read.');
        }
        if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= MOST_CHANGES_PER_READ)) {
            throw new RangeError(`limit must be a whole number from 1 to ${MOST_CHANGES_PER_READ}.`);
        }
        // Not set up yet, as after a restart until VectFox sets it up again: a state to retry, not an unsupported Qdrant.
        if (!backend.baseUrl) throw new Error('Qdrant not initialized');
        if (!isOn()) {
            return { supported: false, reason: `Change numbers need Qdrant 1.8 or newer, and this Qdrant's version is ${backend.serverVersion ?? 'unknown'}.` };
        }
        await prepare(collection);
        const scope = backend._scopeMust(filters);
        if (after === null) {
            const points = await everyPoint(collection, backend._buildFilterExcludingSentinel(scope));
            const inRecords = await highestNumber(CHANGE_LOG_COLLECTION, recordsFilter(collection, filters));
            return {
                supported: true,
                points: points.map(asItem),
                removed: [],
                emptied: false,
                cursor: points.reduce((highest, point) => Math.max(highest, numberOf(point)), inRecords),
                hasMore: false,
            };
        }
        const [points, records] = await Promise.all([
            byNumber(collection, backend._buildFilterExcludingSentinel([...scope, { key: CHANGE_NUMBER_FIELD, range: { gt: after } }]), { direction: 'asc', limit: limit + 1 }),
            byNumber(CHANGE_LOG_COLLECTION, recordsFilter(collection, filters, after), { direction: 'asc', limit: limit + 1 }),
        ]);
        // Each list holds its first limit + 1 changes, so the first `limit` of the two together are the collection's.
        const changes = [...points.map(point => ({ number: numberOf(point), point })), ...records.map(record => ({ number: numberOf(record), record }))]
            .sort((first, second) => first.number - second.number);
        const page = changes.slice(0, limit);
        const lastEmptied = page.findLastIndex(change => change.record?.payload?.[RECORD_KIND_FIELD] === CHANGE_KINDS.emptied);
        const kept = page.slice(lastEmptied + 1);
        return {
            supported: true,
            points: kept.filter(change => change.point).map(change => asItem(change.point)),
            removed: kept.filter(change => change.record?.payload?.[RECORD_KIND_FIELD] === CHANGE_KINDS.removed).map(change => asRemoval(change.record)),
            emptied: lastEmptied >= 0,
            cursor: page.length ? page[page.length - 1].number : after,
            hasMore: changes.length > limit,
        };
    }

    return { insert, updateMetadata, updateText, remove, purge, readChanges };
}
