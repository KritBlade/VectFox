/**
 * @vitest-environment jsdom
 *
 * A collection's dialogs (src/features/database-browser/collection-dialogs.js), driven as a user would while each is
 * open: Rename and Switch model save only on their action; Collection Settings saves what its form holds, edits rules in
 * place, writes a lock only when its switch was moved (character 0 included), and writes nothing on Cancel; Manage locks
 * acts at once and says whether it changed anything.
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
    getCollectionTriggers: vi.fn(),
    getCollectionConditions: vi.fn(),
    setCollectionConditions: vi.fn(),
    getCollectionLocks: vi.fn(),
    setCollectionLock: vi.fn(),
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

const loadWorldInfo = vi.hoisted(() => vi.fn());

vi.mock('../src/features/collections/index.js', () => ({ ...collections, VALID_GENERATION_TYPES: ['normal', 'swipe'] }));
vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: () => ({ characterId: 0, characters: [{ name: 'Mira' }] }),
    getCurrentChatId: () => 'Mira - 1',
}));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo, world_names: ['Harbor Lore'] }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), lifecycle: vi.fn() } }));
// The dialog doors: the form or body is on the page while the test acts on it, as it is while the dialog is open.
vi.mock('../src/sillytavern/popup.js', () => ({
    formPopup: vi.fn(async (lines, form) => {
        document.body.append(form);
        await host.onForm?.(form);
        form.remove();
        return host.answer;
    }),
    noticePopup: vi.fn(async (lines, { body }) => {
        document.body.append(body);
        await host.onNotice?.(body);
        body.remove();
    }),
}));

const { editCollectionSettings, manageCollectionLocks, renameCollection, switchCollectionModel } =
    await import('../src/features/database-browser/collection-dialogs.js');

const KEY = 'qdrant:vf_lorebook_harbor';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { warning: vi.fn() });
    for (const mock of Object.values(collections)) mock.mockReset();
    loadWorldInfo.mockReset();
    host.answer = true;
    host.onForm = null;
    host.onNotice = null;
    collections.getCollectionMeta.mockImplementation(() => ({ scope: 'character', ...host.meta }));
    collections.getCollectionTriggers.mockReturnValue({ triggers: ['harbor'], matchMode: 'any', scanDepth: 5, caseSensitive: false });
    collections.getCollectionConditions.mockReturnValue({ enabled: false, logic: 'AND', rules: [] });
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
    it('saves what the form holds, with a rule edited in place', async () => {
        const updated = vi.fn();
        document.addEventListener('vectfox:collections-updated', updated);
        host.onForm = (form) => {
            form.querySelector('#vectfox_triggers_input').value = 'harbor, tide\nstorm';
            form.querySelector('[data-settings-action="add-rule"]').click();
            change(form.querySelector('#vectfox_rule_0_kind'), 'messageCount');
            change(form.querySelector('#vectfox_rule_0_count'), '5');
            change(form.querySelector('#vectfox_rule_0_operator'), 'lte');
            change(form.querySelector('[data-condition-rule="0"] [data-rule-check="negate"]'), true);
            form.querySelector('#vectfox_conditions_enabled').checked = true;
            change(form.querySelector('#vectfox_collection_position'), '1');
            expect(form.querySelector('#vectfox_collection_depth_field').hidden).toBe(false);
            form.querySelector('#vectfox_collection_depth').value = '0';
            form.querySelector('#vectfox_collection_xml_tag').value = 'my notes!';
        };
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(true);
        expect(collections.setCollectionMeta).toHaveBeenCalledWith(KEY, expect.objectContaining({
            triggers: ['harbor', 'tide', 'storm'], triggerMatchMode: 'any', triggerScanDepth: 5, xmlTag: 'mynotes', position: 1, depth: 0,
        }));
        expect(collections.setCollectionConditions).toHaveBeenCalledWith(KEY, {
            enabled: true,
            logic: 'AND',
            rules: [{ type: 'messageCount', negate: true, settings: { count: 5, operator: 'lte' } }],
        });
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

    it('locks to character 0 when the switch is moved on', async () => {
        host.onForm = (form) => {
            const lockSwitch = form.querySelector('#vectfox_always_active');
            expect(lockSwitch.disabled).toBe(false);
            lockSwitch.checked = true;
        };
        await editCollectionSettings(KEY, 'Harbor');
        expect(collections.setCollectionCharacterLock).toHaveBeenCalledWith(KEY, '0');
    });

    it('writes a chat lock for a chat-scoped collection', async () => {
        host.meta = { scope: 'chat' };
        host.onForm = form => { form.querySelector('#vectfox_always_active').checked = true; };
        await editCollectionSettings(KEY, 'Harbor');
        expect(collections.setCollectionLock).toHaveBeenCalledWith(KEY, 'Mira - 1');
    });

    it('writes nothing on Cancel, but answers that a lock changed in Manage locks', async () => {
        host.answer = false;
        host.onForm = form => form.querySelector('#vectfox_triggers_input').value = 'changed';
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(false);
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
        expect(collections.setCollectionConditions).not.toHaveBeenCalled();

        host.onNotice = body => body.querySelector('[data-lock-action="add-chat"]').click();
        host.onForm = async (form) => {
            form.querySelector('[data-settings-action="manage-locks"]').click();
            await settle();
        };
        expect(await editCollectionSettings(KEY, 'Harbor')).toBe(true);
        expect(collections.setCollectionLock).toHaveBeenCalledWith(KEY, 'Mira - 1');
        expect(collections.setCollectionMeta).not.toHaveBeenCalled();
    });

    it('picks a whole lorebook or one entry for a Lorebook active rule, and removes one', async () => {
        loadWorldInfo.mockResolvedValue({ entries: { 3: { uid: 3, comment: 'The lighthouse' } } });
        collections.getCollectionConditions.mockReturnValue({ enabled: true, logic: 'AND', rules: [{ type: 'lorebookActive', settings: {} }] });
        host.onForm = async (form) => {
            const rule = form.querySelector('[data-condition-rule="0"]');
            change(form.querySelector('#vectfox_rule_0_lorebook'), 'Harbor Lore');
            await settle();
            expect([...form.querySelectorAll('#vectfox_rule_0_entry option')].map(option => option.textContent)).toEqual(['The whole lorebook', 'The lighthouse']);
            form.querySelector('#vectfox_rule_0_entry').value = '3';
            rule.querySelector('[data-rule-action="add-lorebook"]').click();
            form.querySelector('#vectfox_rule_0_lorebook').value = 'Harbor Lore';
            rule.querySelector('[data-rule-action="add-lorebook"]').click();
            expect(rule.querySelector('[data-lorebook-choices]').textContent).toContain('Harbor Lore, entry 3');
            rule.querySelector('[data-rule-action="remove-lorebook"][data-lorebook-value="Harbor Lore:3"]').click();
        };
        await editCollectionSettings(KEY, 'Harbor');
        expect(loadWorldInfo).toHaveBeenCalledWith('Harbor Lore');
        expect(collections.setCollectionConditions.mock.calls[0][1].rules[0].settings.values).toEqual(['Harbor Lore']);
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
});
