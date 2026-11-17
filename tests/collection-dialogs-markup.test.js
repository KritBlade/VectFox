/**
 * @vitest-environment jsdom
 *
 * A collection's dialogs on GUI-DNA (src/features/database-browser/collection-dialogs-markup.js): each form holds the
 * controls its wiring finds, Collection Settings holds the lock alone, and every value is escaped.
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
    summary: { pill: '2 locks', isActiveHere: true, line: 'Active here: locked to this character.' },
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
    });
});

describe('Manage locks', () => {
    it('lists the locks, marks the ones here, escapes them, and offers only the locks it can add', () => {
        const body = parse(lockDialogMarkup(lockDialogView({
            chatLocks: ['<i>Mira</i> - 1'],
            characterLocks: ['4'],
            chatId: '<i>Mira</i> - 1',
            characterId: '7',
            characterNameOf: () => '<b>Tomas</b>',
        })));
        expect(body.querySelector('i:not(.fa-solid)')).toBeNull();
        expect(body.querySelector('b')).toBeNull();
        expect([...body.querySelectorAll('[data-lock-action^="remove"]')].map(button => [button.dataset.lockAction, button.dataset.lockId]))
            .toEqual([['remove-chat', '<i>Mira</i> - 1'], ['remove-character', '4']]);
        expect(body.textContent).toContain('This chat');
        expect(body.querySelector('[data-lock-action="add-chat"]').disabled).toBe(true);
        expect(body.querySelector('[data-lock-action="add-character"]').disabled).toBe(false);
        // The dialog's own button is its one primary action (GUI-DNA: at most one per card).
        expect(body.querySelector('.vfx-btn-primary')).toBeNull();
    });

    it('says when there are no locks yet', () => {
        const body = parse(lockDialogMarkup(lockDialogView({ chatLocks: [], characterLocks: [], chatId: null, characterId: null, characterNameOf: String })));
        expect(body.textContent).toContain('No chat locks yet.');
        expect(body.textContent).toContain('No character locks yet.');
    });
});
