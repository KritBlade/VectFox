/**
 * The ID a point of one VectFox collection is stored under inside a shared Qdrant collection (src/shared/point-ids.js):
 * a UUID from the collection's ID and the point's hash, the same every time, so one hash in two collections makes two
 * points, and LoreBase's books keep the IDs their points were stored under.
 */
import { describe, expect, it } from 'vitest';

const { tenantPointId } = await import('../src/shared/point-ids.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('tenantPointId', () => {
    // Pinned from LoreBase's pointId before it moved here: a book's stored points keep their IDs.
    it("gives the IDs LoreBase's points were stored under", () => {
        expect(tenantPointId('vf_lorebase_qdrant_rabbit_harbor_atlas_1x2y3z', 4815162342)).toBe('0b939f72-f835-8f17-b7b0-fac80fd90ab4');
        expect(tenantPointId('vf_eventbase_qdrant_tester_fork', 52001)).toBe('1a4878ce-5c53-801a-b07f-7458423215cc');
    });

    it('gives one hash a different UUID in each collection, and the same one every time', () => {
        const fork = tenantPointId('vf_eventbase_qdrant_tester_fork', 52001);
        expect(fork).toMatch(UUID);
        expect(fork).toBe(tenantPointId('vf_eventbase_qdrant_tester_fork', 52001));
        expect(fork).not.toBe(tenantPointId('vf_eventbase_qdrant_tester_source', 52001));
    });
});
