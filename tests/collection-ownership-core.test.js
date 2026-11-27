/**
 * Which collections are this account's (src/features/collections/collection-ownership-core.js): one whose ID names one
 * of the account's persona handles, one with a creatorHandle, or one locked to a chat of the account, under the registry
 * key or the bare ID; never another account's collection of a chat the account imported, which shares its chat UUID.
 *
 * Real ID module (collection-ids.js), its SillyTavern host modules stubbed, as in collection-id-handle-remap.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ name1: 'Wren' })) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: vi.fn(() => null), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));

import { accountHandlesOf, isCollectionOfAccount } from '../src/features/collections/collection-ownership-core.js';

const CHAT_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OWN_KEY = `qdrant:vf_eventbase_qdrant_wren_harbor_${CHAT_UUID}`;
const TWO_WORD_PERSONA_KEY = `qdrant:vf_eventbase_qdrant_wren_keeper_harbor_${CHAT_UUID}`;
const OTHER_ACCOUNT_KEY = `qdrant:vf_eventbase_qdrant_orrin_harbor_${CHAT_UUID}`;

describe("an account's persona handles", () => {
    it('are the handles its persona names give, each once, empty names left out', () => {
        expect(accountHandlesOf(['Wren', 'Wren Keeper', 'wren', '', '  ', null])).toEqual(new Set(['wren', 'wren_keeper']));
    });
});

describe('whether a collection is this account\'s', () => {
    const handles = accountHandlesOf(['Wren', 'Wren Keeper']);

    it('is when its ID names one of the account\'s persona handles, one with underscores too', () => {
        expect(isCollectionOfAccount({}, OWN_KEY, accountHandlesOf(['Wren']))).toBe(true);
        expect(isCollectionOfAccount({}, TWO_WORD_PERSONA_KEY, accountHandlesOf(['Wren Keeper']))).toBe(true);
    });

    it('is not for another account\'s collection of a chat this account imported, with no stamp and no lock', () => {
        expect(isCollectionOfAccount({ collections: { [OTHER_ACCOUNT_KEY]: { scope: 'chat', autoSync: false } } }, OTHER_ACCOUNT_KEY, handles)).toBe(false);
    });

    it('is when its metadata carries a creatorHandle, as a persona since renamed made it', () => {
        expect(isCollectionOfAccount({ collections: { [OTHER_ACCOUNT_KEY]: { creatorHandle: 'orrin' } } }, OTHER_ACCOUNT_KEY, handles)).toBe(true);
    });

    it('is when a chat of the account is locked to it, under the registry key or the bare ID, in either lock field', () => {
        const bareId = OTHER_ACCOUNT_KEY.slice('qdrant:'.length);
        expect(isCollectionOfAccount({ collections: { [OTHER_ACCOUNT_KEY]: { lockedToChatIds: ['Harbor Night'] } } }, OTHER_ACCOUNT_KEY, handles)).toBe(true);
        expect(isCollectionOfAccount({ collections: { [bareId]: { lockedToChatId: 'Harbor Night' } } }, OTHER_ACCOUNT_KEY, handles)).toBe(true);
        expect(isCollectionOfAccount({ collections: { [OTHER_ACCOUNT_KEY]: { lockedToChatIds: [] } } }, OTHER_ACCOUNT_KEY, handles)).toBe(false);
    });

    it('reads a bare ID from older versions as its own key', () => {
        expect(isCollectionOfAccount({}, OWN_KEY.slice('qdrant:'.length), handles)).toBe(true);
        expect(isCollectionOfAccount({}, OTHER_ACCOUNT_KEY.slice('qdrant:'.length), handles)).toBe(false);
    });
});
