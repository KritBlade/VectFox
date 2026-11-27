/**
 * settings-migration-eventbase-records-of-other-accounts.test.js — EventBase's record leaves every EventBase and archive
 * collection that is not this account's (src/app/settings-migration-eventbase-records-of-other-accounts.js, D5 of
 * InternalProject/Vectfox/plans/eventbase-window-record.md):
 *   - another account's collection of a chat the account imported loses its record, and keeps the rest of its metadata
 *   - the account's own collections, one locked to its chat, and one with a creatorHandle keep theirs
 *   - a collection that is not EventBase's is left as it is
 *   - a second run deletes nothing more, and settings with no collections are a no-op
 *
 * Ownership through the real isCollectionOfAccount, as src/index.js hands it; the ID module's host modules stubbed, as
 * in collection-id-handle-remap.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ name1: 'Wren' })) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: vi.fn(() => null), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

import { migration_drop_eventbase_records_of_other_accounts } from '../src/app/settings-migration-eventbase-records-of-other-accounts.js';
import { accountHandlesOf, isCollectionOfAccount } from '../src/features/collections/collection-ownership-core.js';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ARCHIVE_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OWN_KEY = `qdrant:vf_eventbase_qdrant_wren_harbor_${CHAT_UUID}`;
const OTHER_KEY = `qdrant:vf_eventbase_qdrant_orrin_harbor_${CHAT_UUID}`;
const OTHER_ARCHIVE_KEY = `qdrant:vf_archiveevent_qdrant_orrin_harbor_${ARCHIVE_UUID}`;
const LOCKED_OTHER_KEY = `qdrant:vf_eventbase_qdrant_tamsin_harbor_${CHAT_UUID}`;
// Made under a persona since renamed: its ID names the old handle, which its creatorHandle stamp keeps.
const RENAMED_PERSONA_KEY = `qdrant:vf_eventbase_qdrant_wrenold_harbor_${CHAT_UUID}_mh3k2x1a`;
const LOREBOOK_KEY = 'qdrant:vf_lorebook_orrin_harbor_book';

const RECORD = { vectorizationTip: 40, extractedWindows: ['101,102', '103,104'], windowSize: 2 };

/** Settings of an account whose one persona is Wren, holding a copy of its record on another account's collections. */
function settingsWithCopies() {
    return {
        collections: {
            [OWN_KEY]: { scope: 'chat', creatorHandle: 'wren', eventbaseProgress: structuredClone(RECORD) },
            [OTHER_KEY]: { scope: 'chat', autoSync: false, displayName: '', eventbaseProgress: structuredClone(RECORD) },
            [OTHER_ARCHIVE_KEY]: { scope: 'chat', eventbaseProgress: { vectorizationTip: 9, windowSize: 2 } },
            [LOCKED_OTHER_KEY]: { scope: 'chat', lockedToChatIds: ['Harbor Night'], eventbaseProgress: structuredClone(RECORD) },
            [RENAMED_PERSONA_KEY]: { scope: 'chat', creatorHandle: 'wrenold', eventbaseProgress: structuredClone(RECORD) },
            [LOREBOOK_KEY]: { scope: 'character', eventbaseProgress: { windowSize: 2 } },
        },
    };
}

const drop = (settings, personaNames = ['Wren']) => migration_drop_eventbase_records_of_other_accounts(
    settings, registryKey => isCollectionOfAccount(settings, registryKey, accountHandlesOf(personaNames)));

describe("the deletion of EventBase's records on other accounts' collections", () => {
    it("deletes the record of another account's collections, keeping the rest of their metadata", () => {
        const settings = settingsWithCopies();

        expect(drop(settings)).toEqual({ migrated: 2 });

        expect(settings.collections[OTHER_KEY]).toEqual({ scope: 'chat', autoSync: false, displayName: '' });
        expect(settings.collections[OTHER_ARCHIVE_KEY]).toEqual({ scope: 'chat' });
    });

    it('keeps the record of the account\'s own collection, of one locked to its chat, and of one it stamped', () => {
        const settings = settingsWithCopies();
        const before = structuredClone(settings);

        drop(settings);

        for (const key of [OWN_KEY, LOCKED_OTHER_KEY, RENAMED_PERSONA_KEY]) {
            expect(settings.collections[key]).toEqual(before.collections[key]);
        }
    });

    it('leaves a collection that is not EventBase\'s as it is', () => {
        const settings = settingsWithCopies();

        drop(settings);

        expect(settings.collections[LOREBOOK_KEY]).toEqual({ scope: 'character', eventbaseProgress: { windowSize: 2 } });
    });

    it('deletes nothing more on a second run, and is a no-op on settings with no collections', () => {
        const settings = settingsWithCopies();
        drop(settings);
        const afterFirstRun = structuredClone(settings);

        expect(drop(settings)).toEqual({ migrated: 0 });
        expect(settings).toEqual(afterFirstRun);
        expect(drop({})).toEqual({ migrated: 0 });
        expect(drop(undefined)).toEqual({ migrated: 0 });
    });
});
