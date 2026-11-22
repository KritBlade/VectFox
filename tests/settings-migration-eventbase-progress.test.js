/**
 * settings-migration-eventbase-progress.test.js — how far EventBase has read each chat moves from five stores keyed by
 * the chat's UUID into the record of each of the chat's collections (src/app/settings-migration-eventbase-progress.js,
 * §2.4 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 *   - a chat with one collection: each store's entry becomes its part of the pointer
 *   - a chat with collections on two backends and under two personas: each gets the same pointer, as they shared it
 *   - a chat's later collection, whose ID ends in the time it was made after the UUID, gets the chat's pointer too
 *   - an archive collection gets the entries of its archive UUID
 *   - an entry no collection holds is dropped, and the five stores are deleted
 *   - a collection that already has a pointer keeps it
 *   - the window size is the size of the first window on the chat's record, else the stored size, else the Vectorize
 *     dialog's Window size
 *   - an empty registry leaves the stores for the next start
 *   - a second run changes nothing, and settings with no stores are a no-op
 *
 * The migration changes only the settings it is handed. It reads each collection's chat UUID through the real ID
 * module (parseCollectionId), whose SillyTavern host modules are stubbed, as in collection-id-handle-remap.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ name1: 'Wren' })) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: vi.fn(() => null), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
import {
    EVENTBASE_PROGRESS_STORES,
    migration_eventbase_progress_into_collections,
} from '../src/app/settings-migration-eventbase-progress.js';

const HARBOR_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TIDES_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ARCHIVE_UUID = 'cccccccc-3333-4333-8333-cccccccccccc';
const GONE_UUID = 'dddddddd-4444-4444-8444-dddddddddddd';

const HARBOR_KEY = `qdrant:vf_eventbase_qdrant_wren_keeper_${HARBOR_UUID}`;
const TIDES_QDRANT_KEY = `qdrant:vf_eventbase_qdrant_wren_keeper_${TIDES_UUID}`;
const TIDES_VECTRA_KEY = `vectra:vf_eventbase_standard_wren_keeper_${TIDES_UUID}`;
const TIDES_OTHER_PERSONA_KEY = `qdrant:vf_eventbase_qdrant_orrin_keeper_${TIDES_UUID}`;
const ARCHIVE_KEY = `qdrant:vf_archiveevent_qdrant_wren_keeper_${ARCHIVE_UUID}`;
const LOREBASE_KEY = 'qdrant:vf_lorebase_wren';

// Window fingerprints: one source hash per message, so a window of 3 messages has 3.
const WINDOW_OF_THREE = '101,102,103';
const LATER_WINDOW_OF_TWO = '104,105';

/** Settings as a VectFox before the copy saved them. */
function settingsBeforeTheCopy() {
    return {
        eventbase_window_size: 4,
        vectfox_collection_registry: [HARBOR_KEY, TIDES_QDRANT_KEY, TIDES_VECTRA_KEY, TIDES_OTHER_PERSONA_KEY, ARCHIVE_KEY, LOREBASE_KEY],
        collections: {
            [HARBOR_KEY]: { scope: 'chat', lockedToChatIds: ['Harbor Night'], autoSync: true },
            [TIDES_VECTRA_KEY]: { scope: 'chat', eventbaseProgress: { vectorizationTip: 7, windowSize: 2 } },
            [LOREBASE_KEY]: { scope: 'character' },
        },
        eventbase_vectorization_tip: { [HARBOR_UUID]: 40, [TIDES_UUID]: 12, [ARCHIVE_UUID]: 9, [GONE_UUID]: 99 },
        eventbase_extracted_windows: { [HARBOR_UUID]: [WINDOW_OF_THREE, LATER_WINDOW_OF_TWO], [TIDES_UUID]: [], [GONE_UUID]: ['1,2'] },
        eventbase_unfinished_windows: { [HARBOR_UUID]: ['106,107'], [TIDES_UUID]: [] },
        eventbase_autosync_start_marker: { [HARBOR_UUID]: 30, [GONE_UUID]: 5 },
        eventbase_last_used_window_size: { [HARBOR_UUID]: 2, [TIDES_UUID]: 6, [GONE_UUID]: 2 },
    };
}

describe('the one-time copy of EventBase pointers into the collections', () => {
    it("gives a chat's one collection every part of its pointer, keeping the record's other fields", () => {
        const settings = settingsBeforeTheCopy();

        migration_eventbase_progress_into_collections(settings);

        expect(settings.collections[HARBOR_KEY]).toEqual({
            scope: 'chat',
            lockedToChatIds: ['Harbor Night'],
            autoSync: true,
            eventbaseProgress: {
                vectorizationTip: 40,
                extractedWindows: [WINDOW_OF_THREE, LATER_WINDOW_OF_TWO],
                unfinishedWindows: ['106,107'],
                autoSyncStartMarker: 30,
                windowSize: 3,
            },
        });
    });

    it("gives each of a chat's collections, on another backend or under another persona, the pointer they shared", () => {
        const settings = settingsBeforeTheCopy();

        migration_eventbase_progress_into_collections(settings);

        const tidesPointer = { vectorizationTip: 12, windowSize: 6 };
        expect(settings.collections[TIDES_QDRANT_KEY]).toEqual({ eventbaseProgress: tidesPointer });
        expect(settings.collections[TIDES_OTHER_PERSONA_KEY]).toEqual({ eventbaseProgress: tidesPointer });
        // Each gets its own copy, so writing one never reaches the other.
        expect(settings.collections[TIDES_QDRANT_KEY].eventbaseProgress).not.toBe(settings.collections[TIDES_OTHER_PERSONA_KEY].eventbaseProgress);
    });

    it("gives a chat's later collection the chat's pointer too, as its ID holds the chat's UUID", () => {
        const harborLaterKey = `${HARBOR_KEY}_mh3k2x1a`;
        const settings = settingsBeforeTheCopy();
        settings.vectfox_collection_registry.push(harborLaterKey);

        migration_eventbase_progress_into_collections(settings);

        expect(settings.collections[harborLaterKey]).toEqual({ eventbaseProgress: settings.collections[HARBOR_KEY].eventbaseProgress });
        expect(settings.collections[harborLaterKey].eventbaseProgress).not.toBe(settings.collections[HARBOR_KEY].eventbaseProgress);
    });

    it('keeps the pointer of a collection that already has one', () => {
        const settings = settingsBeforeTheCopy();

        migration_eventbase_progress_into_collections(settings);

        expect(settings.collections[TIDES_VECTRA_KEY]).toEqual({ scope: 'chat', eventbaseProgress: { vectorizationTip: 7, windowSize: 2 } });
    });

    it('gives an archive collection the entries of its archive UUID, the window size from the dialog when none is stored', () => {
        const settings = settingsBeforeTheCopy();

        migration_eventbase_progress_into_collections(settings);

        expect(settings.collections[ARCHIVE_KEY]).toEqual({ eventbaseProgress: { vectorizationTip: 9, windowSize: 4 } });
    });

    it('drops an entry no collection holds, gives no other collection a pointer, and deletes the five stores', () => {
        const settings = settingsBeforeTheCopy();

        const result = migration_eventbase_progress_into_collections(settings);

        for (const store of Object.keys(EVENTBASE_PROGRESS_STORES)) expect(settings).not.toHaveProperty(store);
        expect(settings.collections[LOREBASE_KEY]).toEqual({ scope: 'character' });
        expect(JSON.stringify(settings.collections)).not.toContain('99');
        expect(result).toEqual({ migrated: 4, chatCount: 3, droppedChatCount: 1, storeCount: 5 });
    });

    it('reads the window size from the first window on record, before the size stored at the last run', () => {
        const settings = settingsBeforeTheCopy();
        settings.eventbase_extracted_windows[HARBOR_UUID] = [LATER_WINDOW_OF_TWO, WINDOW_OF_THREE];

        migration_eventbase_progress_into_collections(settings);

        expect(settings.collections[HARBOR_KEY].eventbaseProgress.windowSize).toBe(2);
    });

    it('leaves the stores for the next start when the registry is empty', () => {
        const settings = { ...settingsBeforeTheCopy(), vectfox_collection_registry: [] };
        const before = structuredClone(settings);

        const result = migration_eventbase_progress_into_collections(settings);

        expect(settings).toEqual(before);
        expect(result.storeCount).toBe(0);
    });

    it('changes nothing on a second run', () => {
        const settings = settingsBeforeTheCopy();
        migration_eventbase_progress_into_collections(settings);
        const afterFirstRun = structuredClone(settings);

        const result = migration_eventbase_progress_into_collections(settings);

        expect(settings).toEqual(afterFirstRun);
        expect(result).toEqual({ migrated: 0, chatCount: 0, droppedChatCount: 0, storeCount: 0 });
    });

    it('is a safe no-op on settings with no stores, and on no settings', () => {
        const settings = { vectfox_collection_registry: [HARBOR_KEY], collections: {} };
        expect(migration_eventbase_progress_into_collections(settings).storeCount).toBe(0);
        expect(settings).toEqual({ vectfox_collection_registry: [HARBOR_KEY], collections: {} });
        expect(migration_eventbase_progress_into_collections(undefined).storeCount).toBe(0);
    });
});
