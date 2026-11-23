// collection-write-order.js — the order of the writes to one collection, so that an insert still embedding cannot
// bring back what a later delete, edit or purge removed. VectFox's hedge sends an insert again when the first attempt
// is slow, and the attempt that loses keeps running here: it embeds, then writes. A browser that stops waiting does
// not stop it.
//
// An insert registers its points when it arrives, before it embeds. A delete, edit or purge, when it arrives, marks
// the points it removes as overtaken in every insert registered before it. An insert writes only the points not
// overtaken. A new insert after the delete registers after it, so it writes. Writes to one collection run one at a
// time, in the order they are queued, so a write that has passed its check cannot land after a delete queued behind
// it; embedding stays outside the queue.
//
// A point is a hash and, in a shared Qdrant collection, its tenant fields. A write whose scope names tenant fields
// overtakes only the points whose fields are the same, as Qdrant's filter matches them; one that names none
// overtakes the hash in every tenant, as a delete by point ID does. A hash is compared as a number when it reads as
// one, as Qdrant parses it and as Vectra's loose comparison reads it.

/** The fields that name a tenant of a shared Qdrant collection, as qdrant-backend.js's filters name them. */
export const TENANT_FIELDS = Object.freeze(['content_type', 'type', 'sourceId']);

/** A hash as writes compare it. */
function hashKeyOf(hash) {
    const text = String(hash ?? '').trim();
    const number = Number(text);
    return text !== '' && Number.isFinite(number) ? String(number) : text;
}

/** The tenant fields a scope names, those with a value. */
function namedTenantFields(tenant = {}) {
    return TENANT_FIELDS.filter(field => tenant?.[field]).map(field => [field, String(tenant[field])]);
}

/**
 * A new record of one server's collections: the inserts registered in each, and its queue of writes.
 *
 * @returns {{startInsert: Function, overtake: Function, overtakeWhere: Function, queueWrite: Function}}
 */
export function createCollectionWriteOrder() {
    /** @type {Map<string, Set<{points: {hashKey: string, tenant: object, isOvertaken: boolean}[]}>>} */
    const insertsByCollection = new Map();
    /** @type {Map<string, Promise<void>>} */
    const lastWriteByCollection = new Map();

    /**
     * Register an insert's points, before it embeds.
     *
     * @param {string} collectionKey
     * @param {{hash: number|string, tenant?: object}[]} points - One per item, in the items' order
     * @returns {{isOvertaken: (position: number) => boolean, finish: () => void}} finish, once the insert has written
     *   or failed, takes it off the record
     */
    function startInsert(collectionKey, points) {
        const insert = {
            points: points.map(point => ({
                hashKey: hashKeyOf(point.hash),
                tenant: Object.fromEntries(TENANT_FIELDS.map(field => [field, point.tenant?.[field] === undefined ? undefined : String(point.tenant[field])])),
                isOvertaken: false,
            })),
        };
        if (!insertsByCollection.has(collectionKey)) insertsByCollection.set(collectionKey, new Set());
        insertsByCollection.get(collectionKey).add(insert);
        return {
            isOvertaken: position => insert.points[position]?.isOvertaken === true,
            finish: () => {
                const inserts = insertsByCollection.get(collectionKey);
                inserts?.delete(insert);
                if (inserts?.size === 0) insertsByCollection.delete(collectionKey);
            },
        };
    }

    /**
     * Mark as overtaken the points a write removes, in every insert registered before it.
     *
     * @param {string} collectionKey
     * @param {{hashes?: (number|string)[]|null, tenant?: object}} [scope] - The hashes it removes, every hash when null,
     *   and the tenant fields its filters name
     * @returns {number} How many points it overtook
     */
    function overtake(collectionKey, { hashes = null, tenant = {} } = {}) {
        const hashKeys = hashes === null ? null : new Set(hashes.map(hashKeyOf));
        const tenantFields = namedTenantFields(tenant);
        let overtakenCount = 0;
        for (const insert of insertsByCollection.get(collectionKey) ?? []) {
            for (const point of insert.points) {
                if (point.isOvertaken || (hashKeys && !hashKeys.has(point.hashKey))) continue;
                if (!tenantFields.every(([field, value]) => point.tenant[field] === value)) continue;
                point.isOvertaken = true;
                overtakenCount += 1;
            }
        }
        return overtakenCount;
    }

    /**
     * Mark as overtaken every point of every insert registered in the collections the test picks: a purge of
     * several at once.
     *
     * @param {(collectionKey: string) => boolean} isPurged
     * @returns {number} How many points it overtook
     */
    function overtakeWhere(isPurged) {
        let overtakenCount = 0;
        for (const collectionKey of insertsByCollection.keys()) {
            if (isPurged(collectionKey)) overtakenCount += overtake(collectionKey);
        }
        return overtakenCount;
    }

    /**
     * Run a write once the writes queued before it in the collection have settled, failed ones included.
     *
     * @template T
     * @param {string} collectionKey
     * @param {() => Promise<T>} write
     * @returns {Promise<T>} What the write returns or throws
     */
    function queueWrite(collectionKey, write) {
        const previous = lastWriteByCollection.get(collectionKey) ?? Promise.resolve();
        const result = previous.then(() => write());
        const settled = result.then(() => undefined, () => undefined);
        lastWriteByCollection.set(collectionKey, settled);
        settled.then(() => {
            if (lastWriteByCollection.get(collectionKey) === settled) lastWriteByCollection.delete(collectionKey);
        });
        return result;
    }

    return { startInsert, overtake, overtakeWhere, queueWrite };
}
