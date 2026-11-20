/**
 * Clean up locks, the collections' part (src/features/collections/collection-lock-cleanup-core.js): the chat locks on
 * chats that no longer exist, the old single lock among them; the character locks past the end of the character list,
 * a lock of another form kept; nothing judged of a kind with no test for it; and chat_lock_index rebuilt from the chat
 * locks left, under each record's own key, with the entries it removes and adds counted.
 */
import { describe, expect, it } from 'vitest';
import { chatLocksOf, planCollectionLockCleanup } from '../src/features/collections/collection-lock-cleanup-core.js';

const HARBOR = 'qdrant:vf_eventbase_qdrant_wren_harbor';
const LIGHTHOUSE = 'qdrant:vf_eventbase_qdrant_wren_lighthouse';
const DELETED = 'qdrant:vf_eventbase_qdrant_wren_deleted';
const presentIn = chatIds => chatId => chatIds.includes(chatId);
const EVERY_CHAT = presentIn(['Wren - harbor', 'Wren - lighthouse']);

describe("a collection record's chat locks", () => {
    it('reads the list, then the single lock saved before it when the list lacks it', () => {
        expect(chatLocksOf({ lockedToChatIds: ['Wren - harbor'], lockedToChatId: 'Wren - old' })).toEqual(['Wren - harbor', 'Wren - old']);
        expect(chatLocksOf({ lockedToChatIds: ['Wren - harbor'], lockedToChatId: 'Wren - harbor' })).toEqual(['Wren - harbor']);
        expect(chatLocksOf({ lockedToChatId: 'Wren - old' })).toEqual(['Wren - old']);
        expect(chatLocksOf(null)).toEqual([]);
    });
});

describe('Clean up locks on the collections', () => {
    it('removes the chat locks on chats that no longer exist, the old single lock included, and keeps the others', () => {
        const records = {
            [HARBOR]: { lockedToChatIds: ['Wren - harbor', 'Wren - gone'], lockedToChatId: 'Wren - older' },
            [LIGHTHOUSE]: { lockedToChatIds: ['Wren - lighthouse'] },
        };
        const plan = planCollectionLockCleanup(records, {}, { isChatPresent: EVERY_CHAT, characterCount: 3 });

        expect(plan.goneChatLockCount).toBe(2);
        expect(plan.updates).toEqual({ [HARBOR]: { lockedToChatIds: ['Wren - harbor'], lockedToChatId: null } });
        expect(plan.lockIndex).toEqual({ 'Wren - harbor': [HARBOR], 'Wren - lighthouse': [LIGHTHOUSE] });
    });

    it('judges no chat lock when the chat list could not be read whole, and indexes every chat lock', () => {
        const records = { [HARBOR]: { lockedToChatIds: ['Wren - harbor', 'Wren - gone'] } };
        const plan = planCollectionLockCleanup(records, {}, { isChatPresent: null, characterCount: 3 });

        expect(plan.goneChatLockCount).toBe(0);
        expect(plan.updates).toEqual({});
        expect(plan.lockIndex).toEqual({ 'Wren - harbor': [HARBOR], 'Wren - gone': [HARBOR] });
    });

    it("removes the character locks past the character list's end, and keeps those within it and any of another form", () => {
        const records = { [HARBOR]: { lockedToCharacterIds: ['0', '2', '3', 7, '-1', 'wren.png'] } };
        const plan = planCollectionLockCleanup(records, {}, { isChatPresent: EVERY_CHAT, characterCount: 3 });

        expect(plan.goneCharacterLockCount).toBe(3);
        expect(plan.updates).toEqual({ [HARBOR]: { lockedToCharacterIds: ['0', '2', 'wren.png'] } });
    });

    it('judges no character lock with no character list', () => {
        const records = { [HARBOR]: { lockedToCharacterIds: ['0', '9'] } };
        const plan = planCollectionLockCleanup(records, {}, { isChatPresent: EVERY_CHAT, characterCount: 0 });

        expect(plan.goneCharacterLockCount).toBe(0);
        expect(plan.updates).toEqual({});
    });

    it("rebuilds the chat lock index from the records' chat locks, counting the entries it removes and adds", () => {
        const records = {
            [HARBOR]: { lockedToChatIds: ['Wren - harbor'] },
            [LIGHTHOUSE]: { lockedToChatIds: ['Wren - lighthouse'] },
        };
        const savedIndex = {
            // A repeated entry, and one for a collection with no record.
            'Wren - harbor': [HARBOR, HARBOR, DELETED],
            // A chat none of the records is locked to.
            'Wren - gone': [HARBOR],
            // Not a list: it holds no entry, and the rebuilt index drops it.
            'Wren - lighthouse': 'not a list',
        };
        const plan = planCollectionLockCleanup(records, savedIndex, { isChatPresent: EVERY_CHAT, characterCount: 3 });

        expect(plan.lockIndex).toEqual({ 'Wren - harbor': [HARBOR], 'Wren - lighthouse': [LIGHTHOUSE] });
        expect(plan.indexEntriesRemoved).toBe(3);
        expect(plan.indexEntriesAdded).toBe(1);
        expect(plan.goneChatLockCount).toBe(0);
    });

    it('indexes a lock under the key its record is saved under, a bare collection ID included', () => {
        const records = { vf_eventbase_qdrant_wren_bare: { lockedToChatIds: ['Wren - harbor'] } };
        const plan = planCollectionLockCleanup(records, { 'Wren - harbor': ['vf_eventbase_qdrant_wren_bare'] }, { isChatPresent: EVERY_CHAT, characterCount: 3 });

        expect(plan.lockIndex).toEqual({ 'Wren - harbor': ['vf_eventbase_qdrant_wren_bare'] });
        expect(plan.indexEntriesRemoved).toBe(0);
        expect(plan.indexEntriesAdded).toBe(0);
    });

    it('changes nothing when every lock names what exists and the index matches the locks', () => {
        const records = { [HARBOR]: { lockedToChatIds: ['Wren - harbor'], lockedToCharacterIds: ['1'] }, [LIGHTHOUSE]: {} };
        const plan = planCollectionLockCleanup(records, { 'Wren - harbor': [HARBOR] }, { isChatPresent: EVERY_CHAT, characterCount: 3 });

        expect(plan).toEqual({
            updates: {}, goneChatLockCount: 0, goneCharacterLockCount: 0, lockIndex: { 'Wren - harbor': [HARBOR] },
            indexEntriesRemoved: 0, indexEntriesAdded: 0,
        });
    });

    it('reads no record and no saved index as nothing to clean up', () => {
        expect(planCollectionLockCleanup(undefined, undefined, { isChatPresent: EVERY_CHAT, characterCount: 3 })).toEqual({
            updates: {}, goneChatLockCount: 0, goneCharacterLockCount: 0, lockIndex: {}, indexEntriesRemoved: 0, indexEntriesAdded: 0,
        });
    });
});
