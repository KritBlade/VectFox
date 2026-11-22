/**
 * The chat UUID a collection's ID holds (parseCollectionId in src/shared/collection-ids.js, §2.5 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): a chat's first EventBase collection, a later
 * one, whose ID ends in the time it was made after the UUID, a legacy ID with no backend, and an archive each give the
 * UUID they hold; a chat whose UUID is its file name gives the ID's last segment; every other collection gives none.
 * Moving a later collection to another backend or persona, as an import does, keeps its suffix and its chat.
 *
 * The real module imports SillyTavern's host modules, stubbed as in collection-id-handle-remap.test.js.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ name1: 'Wren' })) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: vi.fn(() => null), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

const { parseCollectionId, remapCollectionIdToBackend, remapCollectionIdToHandle } = await import('../src/shared/collection-ids.js');

const HARBOR_UUID = '3f2a9c1e-7b4d-4e8a-9c61-2d5f8e0b7a43';
const ARCHIVE_UUID = 'c41d7e2b-9a35-4f60-8b17-5e2c9d0a6f18';
const FIRST = `vf_eventbase_qdrant_wren_keeper_${HARBOR_UUID}`;
const LATER = `${FIRST}_mh3k2x1a`;

const chatUUIDOf = collectionId => parseCollectionId(collectionId).chatUUID;

describe('the chat UUID a collection ID holds', () => {
    it("reads the same UUID from a chat's first collection and from a later one", () => {
        expect(chatUUIDOf(FIRST)).toBe(HARBOR_UUID);
        expect(chatUUIDOf(LATER)).toBe(HARBOR_UUID);
        expect(chatUUIDOf(`vf_eventbase_qdrant_crit_blade_fuka_shikuzaki_2_${HARBOR_UUID}_mh3k2x1b`)).toBe(HARBOR_UUID);
    });

    it('reads it from a legacy ID with no backend, and an archive gives its archive UUID', () => {
        expect(chatUUIDOf(`vf_eventbase_wren_keeper_${HARBOR_UUID}`)).toBe(HARBOR_UUID);
        expect(chatUUIDOf(`vf_archiveevent_qdrant_wren_harbor_night_${ARCHIVE_UUID}`)).toBe(ARCHIVE_UUID);
        const contentHash = '9b1f4c0e8d2a7b3c6f5e4d1a0b9c8d7e6f5a4b3c';
        expect(chatUUIDOf(`vf_archiveevent_standard_wren_harbor_${contentHash}`)).toBe(contentHash);
    });

    it("gives a chat whose UUID is its file name the ID's last segment", () => {
        expect(chatUUIDOf('vf_eventbase_qdrant_wren_keeper_Harbor Night - 2026-11-20@12h00m00s')).toBe('Harbor Night - 2026-11-20@12h00m00s');
    });

    it('gives none for a lorebook, an unknown or an empty ID', () => {
        expect(chatUUIDOf('vf_lorebook_qdrant_wren_worldlore_1750000000000')).toBeNull();
        expect(chatUUIDOf('harbor_notes')).toBeNull();
        expect(chatUUIDOf('')).toBeNull();
        expect(chatUUIDOf(null)).toBeNull();
    });

    it("keeps a later collection's suffix and chat when an import moves it to another backend or persona", () => {
        const onStandard = remapCollectionIdToBackend(LATER, 'standard');
        const underOrrin = remapCollectionIdToHandle(LATER, 'Orrin');
        expect(onStandard).toBe(`vf_eventbase_standard_wren_keeper_${HARBOR_UUID}_mh3k2x1a`);
        expect(underOrrin).toBe(`vf_eventbase_qdrant_orrin_keeper_${HARBOR_UUID}_mh3k2x1a`);
        expect([chatUUIDOf(onStandard), chatUUIDOf(underOrrin)]).toEqual([HARBOR_UUID, HARBOR_UUID]);
    });
});
