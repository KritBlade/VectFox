/**
 * @vitest-environment jsdom
 *
 * A collection's dialogs (src/features/database-browser/collection-dialogs.js), driven as a user would while each is
 * open: Rename and Switch model save only on their action; Collection Settings writes the lock of the collection's
 * scope only when its switch was moved (character 0 included), writes no other metadata, and writes nothing on Cancel;
 * Manage locks acts at once and says whether it changed anything. A chat lock goes through EventBase's
 * lockCollectionToOpenChat, which puts one of the chat's own collections in use there (eventbase-collection-in-use.test.js).
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    answer: true,
    onForm: null,
    onNotice: null,
    isActive: false,
    meta: {},
}));

const collections = vi.hoisted(() => ({
    getCollectionMeta: vi.fn(),
    setCollectionMeta: vi.fn(),
    getCollectionLocks: vi.fn(),
    removeCollectionLock: vi.fn(),
    isCollectionLockedToChat: vi.fn(),
    getCollectionLockCount: vi.fn(),
    getCollectionCharacterLocks: vi.fn(),
    setCollectionCharacterLock: vi.fn(),
    removeCollectionCharacterLock: vi.fn(),
    isCollectionLockedToCharacter: vi.fn(),
    getCollectionCharacterLockCount: vi.fn(),
    isCollectionActiveForContext: vi.fn(),
}));

vi.mock('../src/features/collections/index.js', () => ({ ...collections }));
const eventbase = vi.hoisted(() => ({ lockCollectionToOpenChat: vi.fn() }));
vi.mock('../src/features/eventbase/index.js', () => ({ ...eventbase }));
vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: () => ({ characterId: 0, characters: [{ name: 'Mira' }] }),
    getCurrentChatId: () => 'Mira - 1',
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), lifecycle: vi.fn() } }));
// The dialog doors: the form or body is on the page while the test acts on it, as it is while the dialog is open, and
// leaves it however the test's step ends, so no id stays behind for the next test to find.
vi.mock('../src/sillytavern/popup.js', () => ({
    formPopup: vi.fn(async (lines, form) => {
        document.body.append(form);
        try {
            await host.onForm?.(form);
        } finally {
            form.remove();
        }
        return host.answer;
    }),
    noticePopup: vi.fn(async (lines, { body }) => {
        document.body.append(body);
        try {
            await host.onNotice?.(body);
        } finally {
            body.remove();
        }
    }),
}));

const { editCollectionSettings, manageCollectionLocks, renameCollection, switchCollectionModel } =
    await import('../src/features/database-browser/collection-dialogs.js');

const KEY = 'qdrant:vf_lorebook_harbor';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    vi.stubGlobal('$', $);
    for (const mock of Object.values(collections)) mock.mockReset();
    eventbase.lockCollectionToOpenChat.mockReset();
    host.answer = true;
    host.onForm = null;
    host.onNotice = null;
    collections.getCollectionMeta.mockImplementation(() => ({ scope: 'character', ...host.meta }));
    collections.getCollectionLocks.mockReturnValue([]);
    collections.getCollectionCharacterLocks.mockReturnValue([]);
    collections.getCollectionLockCount.mockReturnValue(0);
    collections.getCollectionCharacterLockCount.mockReturnValue(0);
    collections.isCollectionActiveForContext.mockImplementation(() => host.isActive);
    host.isActive = false;
    host.meta = {};
});

describe('Rename', () => {
    it('saves nothing for a name left as it was, so an automatic name is not kept as a typed one', async () => {
        expect(await renameCollection(KEY, 'Lorebook: harbor')).toBe(false);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });

    it('saves the name typed, or the automatic name for an empty box, and nothing on Cancel', async () => {
        host.onForm = form => { form.querySelector('#vectfox_rename_input').value = '  Harbor notes '; };
        expect(await renameCollection(KEY, 'Old name')).toBe(true);
        expect(collections.setCollectionMeta).toHaveBeenLastCalledWith(KEY, { displayName: 'Harbor notes' });
        host.onForm = form => { form.querySelector('#vectfox_rename_input').value = ''; };
        await renameCollection(KEY, 'Harbor notes');
        expect(collections.setCollectionMeta).toHaveBeenLastCalledWith(KEY, { displayName: null });
        host.answer = false;
        collections.setCollectionMeta.mockClear();
        expect(await renameCollection(KEY, 'Harbor notes')).toBe(false);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });
});

describe('Switch model', () => {
    const collection = () => ({ id: 'vf_x', registryKey: KEY, name: 'X', model: 'a', chunkCount: 3, models: [{ path: 'a', chunkCount: 3 }, { path: 'b', chunkCount: 9 }] });

    it('saves another model and shows its chunks, and does nothing when the model stays', async () => {
        const switched = collection();
        host.onForm = form => { form.querySelector('#vectfox_model_select').value = 'b'; };
        expect(await switchCollectionModel(switched)).toBe(true);
        expect(collections.setCollectionMeta).toHaveBeenCalledWith(KEY, { preferredModel: 'b' });
        expect([switched.model, switched.chunkCount]).toEqual(['b', 9]);
        host.onForm = null;
        collections.setCollectionMeta.mockClear();
        expect(await switchCollectionModel(collection())).toBe(false);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });
});

describe('Collection Settings', () => {
    it('locks to character 0 when the switch is moved on, writes no other metadata, and says the collections changed', async () => {
        const updated = vi.fn();
        document.addEventListener('vectfox:collections-updated', updated);
        host.onForm = (form) => {
            const lockSwitch = form.querySelector('#vectfox_always_active');
            expect(lockSwitch.disabled).toBe(false);
            lockSwitch.checked = true;
        };
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(true);
        expect(collections.setCollectionCharacterLock).toHaveBeenCalledWith(KEY, '0');
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
        expect(updated).toHaveBeenCalledTimes(1);
        document.removeEventListener('vectfox:collections-updated', updated);
    });

    it('writes no lock when the switch was not moved, though it shows on for a lock of the other kind', async () => {
        host.isActive = true;
        host.onForm = form => expect(form.querySelector('#vectfox_always_active').checked).toBe(true);
        await editCollectionSettings(KEY, 'Harbor');
        expect(collections.setCollectionCharacterLock).not.toHaveBeenCalled();
        expect(collections.removeCollectionCharacterLock).not.toHaveBeenCalled();
    });

    it('writes a chat lock for a chat-scoped collection', async () => {
        host.meta = { scope: 'chat' };
        host.onForm = form => { form.querySelector('#vectfox_always_active').checked = true; };
        await editCollectionSettings(KEY, 'Harbor');
        expect(eventbase.lockCollectionToOpenChat).toHaveBeenCalledWith(KEY);
    });

    it('writes nothing on Cancel, but answers that a lock changed in Manage locks', async () => {
        host.meta = { scope: 'chat' };
        host.answer = false;
        host.onForm = form => { form.querySelector('#vectfox_always_active').checked = true; };
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(false);
        expect(collections.setCollectionCharacterLock).not.toHaveBeenCalled();
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();

        host.onNotice = body => body.querySelector('[data-lock-action="add-chat"]').click();
        host.onForm = async (form) => {
            form.querySelector('[data-settings-action="manage-locks"]').click();
            await settle();
        };
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(true);
        expect(eventbase.lockCollectionToOpenChat).toHaveBeenCalledWith(KEY);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });
});

describe('Manage locks', () => {
    it('acts at once on each button, repaints, and says whether anything changed', async () => {
        collections.getCollectionCharacterLocks.mockReturnValue(['0']);
        host.onNotice = (body) => {
            expect(body.textContent).toContain('Mira');
            expect(body.querySelector('[data-lock-action="add-character"]').disabled).toBe(true);
            body.querySelector('[data-lock-action="remove-character"]').click();
        };
        expect(await manageCollectionLocks(KEY, 'Harbor')).toBe(true);
        expect(collections.removeCollectionCharacterLock).toHaveBeenCalledWith(KEY, '0');
        host.onNotice = null;
        expect(await manageCollectionLocks(KEY, 'Harbor')).toBe(false);
    });

    it('on a chat collection offers a chat lock alone, and removes a character lock it never reads', async () => {
        host.meta = { scope: 'chat' };
        collections.getCollectionCharacterLocks.mockReturnValue(['0']);
        host.onNotice = (body) => {
            expect(body.querySelector('[data-lock-action="add-character"]')).toBeNull();
            expect(body.textContent).toContain('Not read');
            body.querySelector('[data-lock-action="add-chat"]').click();
            body.querySelector('[data-lock-action="remove-character"]').click();
        };
        expect(await manageCollectionLocks(KEY, 'Harbor')).toBe(true);
        expect(eventbase.lockCollectionToOpenChat).toHaveBeenCalledWith(KEY);
        expect(collections.removeCollectionCharacterLock).toHaveBeenCalledWith(KEY, '0');
        expect(collections.setCollectionCharacterLock).not.toHaveBeenCalled();
    });
});
