/**
 * @vitest-environment jsdom
 *
 * A collection's dialogs on GUI-DNA (src/features/database-browser/collection-dialogs-markup.js): each form holds the
 * controls its wiring finds, Collection Settings holds the lock alone and says which locks of the other kind it never
 * reads, Manage locks offers the kind the collection's scope reads and lists the other kind as not read, and every
 * value is escaped.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import {
    MODEL_SELECT_ID,
    RENAME_INPUT_ID,
    SETTINGS_IDS,
    collectionSettingsMarkup,
    lockDialogMarkup,
    modelFormMarkup,
    renameFormMarkup,
} from '../src/features/database-browser/collection-dialogs-markup.js';
import { lockDialogView } from '../src/features/database-browser/collection-settings-core.js';

function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const LOCK = {
    switchState: { title: 'Active for this character', description: 'On: active in every chat with this character.', isDisabled: false },
    summary: { pill: '2 locks', isActiveHere: true, line: 'Active here: locked to this character.', unreadLine: null },
};

const selectedValue = (fragment, id) => fragment.querySelector(`#${id}`).value;

describe('Rename and Switch model', () => {
    it('Rename holds the name, escaped', () => {
        const form = parse(renameFormMarkup('<b>Mira</b>\'s road'));
        expect(form.querySelector(`#${RENAME_INPUT_ID}`).value).toBe('<b>Mira</b>\'s road');
        expect(form.querySelector('b')).toBeNull();
    });

    it('Switch model lists each model with its chunks, the one in use chosen', () => {
        const form = parse(modelFormMarkup([
            { path: '', name: '', chunkCount: 1 },
            { path: 'bge-m3', name: 'bge-m3', chunkCount: 54 },
        ], 'bge-m3'));
        const options = [...form.querySelectorAll(`#${MODEL_SELECT_ID} option`)].map(option => option.textContent);
        expect(options).toEqual(['(default) (1 chunk)', 'bge-m3 (54 chunks)']);
        expect(selectedValue(form, MODEL_SELECT_ID)).toBe('bge-m3');
    });
});

describe('Collection Settings', () => {
    it('holds the lock alone: its switch, Manage locks, the lock count and whether one matches here', () => {
        const form = parse(collectionSettingsMarkup({ lock: LOCK }));
        for (const id of Object.values(SETTINGS_IDS)) expect(form.querySelector(`#${id}`), id).not.toBeNull();
        expect([...form.querySelectorAll('input, select, textarea')].map(control => control.id)).toEqual([SETTINGS_IDS.lockSwitch]);
        const area = form.querySelector(`#${SETTINGS_IDS.lockArea}`);
        expect(area.querySelector('.vfx-switch-title').textContent).toBe('Active for this character');
        expect(area.querySelector('[data-settings-action="manage-locks"]')).not.toBeNull();
        expect([...area.querySelectorAll('.vfx-pill')].map(pill => [pill.textContent, pill.classList.contains('is-success')])).toEqual([['2 locks', true]]);
        expect(area.textContent).toContain('Active here: locked to this character.');
        expect(area.querySelectorAll('.vfx-hint')).toHaveLength(1);
    });

    it('says which locks of the other kind the collection keeps but never reads', () => {
        const unreadLine = '1 chat lock does nothing: a character collection reads character locks only.';
        const area = parse(collectionSettingsMarkup({ lock: { ...LOCK, summary: { ...LOCK.summary, unreadLine } } }))
            .querySelector(`#${SETTINGS_IDS.lockArea}`);
        expect([...area.querySelectorAll('.vfx-hint')].map(hint => hint.textContent)).toEqual(['Active here: locked to this character.', unreadLine]);
    });
});

describe('Manage locks', () => {
    it('on a chat collection lists its chat locks, marks this chat, escapes them, and offers a chat lock alone', () => {
        const body = parse(lockDialogMarkup(lockDialogView({
            isCharacterScope: false,
            chatLocks: ['<i>Mira</i> - 1'],
            characterLocks: [],
            chatId: '<i>Mira</i> - 1',
            characterId: '7',
            characterNameOf: () => 'Tomas',
        })));
        expect(body.querySelector('i:not(.fa-solid)')).toBeNull();
        expect([...body.querySelectorAll('[data-lock-action^="remove"]')].map(button => [button.dataset.lockAction, button.dataset.lockId]))
            .toEqual([['remove-chat', '<i>Mira</i> - 1']]);
        expect(body.textContent).toContain('This chat');
        expect(body.querySelector('[data-lock-action="add-chat"]').disabled).toBe(true);
        expect(body.querySelector('[data-lock-action="add-character"]')).toBeNull();
        expect(body.textContent).not.toContain('Character locks');
        // The dialog's own button is its one primary action (GUI-DNA: at most one per card).
        expect(body.querySelector('.vfx-btn-primary')).toBeNull();
    });

    it('lists a character lock saved on a chat collection as not read, escaped, with its Remove and nothing to add one', () => {
        const body = parse(lockDialogMarkup(lockDialogView({
            isCharacterScope: false, chatLocks: [], characterLocks: ['4'], chatId: 'Mira - 1', characterId: '4', characterNameOf: () => '<b>Tomas</b>',
        })));
        expect(body.querySelector('b')).toBeNull();
        expect(body.textContent).toContain('Character locks, not read');
        expect([...body.querySelectorAll('.vfx-pill')].map(pill => [pill.textContent, pill.classList.contains('is-warning')])).toEqual([['Not read', true]]);
        expect(body.textContent).toContain('1 character lock does nothing: a chat collection reads chat locks only.');
        expect([...body.querySelectorAll('[data-lock-action^="remove"]')].map(button => [button.dataset.lockAction, button.dataset.lockId]))
            .toEqual([['remove-character', '4']]);
        expect(body.querySelector('[data-lock-action="add-character"]')).toBeNull();
        expect(body.querySelector('[data-lock-action="add-chat"]').disabled).toBe(false);
    });

    it('on a character collection offers a character lock alone', () => {
        const body = parse(lockDialogMarkup(lockDialogView({
            isCharacterScope: true, chatLocks: [], characterLocks: [], chatId: 'Mira - 1', characterId: 0, characterNameOf: String,
        })));
        expect(body.querySelector('[data-lock-action="add-character"]').disabled).toBe(false);
        expect(body.querySelector('[data-lock-action="add-chat"]')).toBeNull();
        expect(body.textContent).toContain('No character locks yet.');
    });

    it('says when there are no locks yet', () => {
        const body = parse(lockDialogMarkup(lockDialogView({
            isCharacterScope: false, chatLocks: [], characterLocks: [], chatId: null, characterId: null, characterNameOf: String,
        })));
        expect(body.textContent).toContain('No chat locks yet.');
        expect(body.textContent).not.toContain('No character locks yet.');
    });
});
