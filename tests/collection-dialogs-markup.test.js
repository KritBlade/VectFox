/**
 * @vitest-environment jsdom
 *
 * A collection's dialogs on GUI-DNA (src/features/database-browser/collection-dialogs-markup.js): each form holds the
 * controls its wiring finds, a rule shows its kind's settings with the values the activation check uses, and every
 * value is escaped.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import {
    MODEL_SELECT_ID,
    RENAME_INPUT_ID,
    SETTINGS_IDS,
    collectionSettingsMarkup,
    conditionRuleMarkup,
    conditionRulesMarkup,
    lockDialogMarkup,
    lorebookChoicesMarkup,
    modelFormMarkup,
    renameFormMarkup,
    ruleControlId,
    ruleControlOf,
} from '../src/features/database-browser/collection-dialogs-markup.js';
import { lockDialogView } from '../src/features/database-browser/collection-settings-core.js';

function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const OPTIONS = { worldNames: ['Harbor Lore', '<b>Bold</b>'], generationTypes: ['normal', 'swipe', 'continue'] };

const LOCK = {
    switchState: { title: 'Active for this character', description: 'On: active in every chat with this character.', isDisabled: false },
    summary: { pill: '2 locks', isActiveHere: true, line: 'Active here: locked to this character.' },
};

const SETTINGS_VIEW = {
    lock: LOCK,
    triggersText: 'harbor\ntide',
    matchMode: 'all',
    scanDepth: 7,
    logic: 'OR',
    rules: [],
    context: 'Things {{char}} remembers:',
    xmlTag: 'memories',
    position: null,
    depth: null,
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
    it('holds every control its wiring finds, with the saved values', () => {
        const form = parse(collectionSettingsMarkup(SETTINGS_VIEW, OPTIONS));
        for (const id of Object.values(SETTINGS_IDS)) expect(form.querySelector(`#${id}`), id).not.toBeNull();
        expect(selectedValue(form, SETTINGS_IDS.triggers)).toBe('harbor\ntide');
        expect(selectedValue(form, SETTINGS_IDS.matchMode)).toBe('all');
        expect(selectedValue(form, SETTINGS_IDS.scanDepth)).toBe('7');
        expect(selectedValue(form, SETTINGS_IDS.logic)).toBe('OR');
        expect(selectedValue(form, SETTINGS_IDS.position)).toBe('');
        expect(form.querySelector(`#${SETTINGS_IDS.lockArea}`).textContent).toContain('2 locks');
        expect(form.querySelector(`#${SETTINGS_IDS.rules}`).textContent).toContain('No conditions yet.');
    });

    it('shows the depth only for the in-chat position', () => {
        expect(parse(collectionSettingsMarkup(SETTINGS_VIEW, OPTIONS)).querySelector(`#${SETTINGS_IDS.depthField}`).hidden).toBe(true);
        const inChat = parse(collectionSettingsMarkup({ ...SETTINGS_VIEW, position: 1, depth: 0 }, OPTIONS));
        expect(inChat.querySelector(`#${SETTINGS_IDS.depthField}`).hidden).toBe(false);
        expect(selectedValue(inChat, SETTINGS_IDS.position)).toBe('1');
        expect(selectedValue(inChat, SETTINGS_IDS.depth)).toBe('0');
    });
});

describe('a condition rule', () => {
    const rule = (type, settings = {}, negate = false) => parse(conditionRuleMarkup({ type, settings, negate }, 2, OPTIONS));

    it('finds its controls by the rule\'s place and the setting\'s name', () => {
        expect(ruleControlOf(ruleControlId(2, 'startTime'))).toEqual({ index: 2, name: 'startTime' });
        expect(ruleControlOf('vectfox_rename_input')).toBeNull();
    });

    it('carries its place, its kind and its NOT', () => {
        const record = rule('speaker', { values: ['Mira'] }, true);
        expect(record.querySelector('[data-condition-rule]').dataset.conditionRule).toBe('2');
        expect(selectedValue(record, ruleControlId(2, 'kind'))).toBe('speaker');
        expect(record.querySelector('[data-rule-check="negate"]').checked).toBe(true);
    });

    it('shows each kind\'s settings with the values the activation check uses', () => {
        const pattern = rule('keyword', { values: ['bridge'] });
        expect(selectedValue(pattern, ruleControlId(2, 'kind'))).toBe('pattern');
        expect(selectedValue(pattern, ruleControlId(2, 'patterns'))).toBe('bridge');
        expect(selectedValue(pattern, ruleControlId(2, 'scanDepth'))).toBe('10');
        expect(selectedValue(rule('messageCount'), ruleControlId(2, 'operator'))).toBe('gte');
        expect(selectedValue(rule('isGroupChat'), ruleControlId(2, 'isGroup'))).toBe('true');
        expect(selectedValue(rule('randomChance'), ruleControlId(2, 'probability'))).toBe('50');
        expect(selectedValue(rule('timeOfDay'), ruleControlId(2, 'endTime'))).toBe('23:59');
        const types = [...rule('generationType').querySelectorAll('[data-rule-generation-type]')];
        expect(types.map(box => [box.dataset.ruleGenerationType, box.checked])).toEqual([['normal', true], ['swipe', false], ['continue', false]]);
    });

    it('offers the lorebooks, escaped, and lists the chosen ones with their remove buttons', () => {
        const record = rule('lorebookActive', { values: ['Harbor Lore:12'] });
        const lorebooks = [...record.querySelectorAll(`#${ruleControlId(2, 'lorebook')} option`)].map(option => option.textContent);
        expect(lorebooks).toEqual(['Choose a lorebook', 'Harbor Lore', '<b>Bold</b>']);
        expect(record.querySelector('[data-lorebook-choices]').textContent).toContain('Harbor Lore, entry 12');
        expect(record.querySelector('[data-rule-action="remove-lorebook"]').dataset.lorebookValue).toBe('Harbor Lore:12');
        expect(parse(lorebookChoicesMarkup([])).textContent).toBe('No lorebook chosen yet.');
    });

    it('keeps a kind it does not know as it is, and lists the rules in order', () => {
        expect(rule('weather').textContent).toContain('does not know this kind of condition');
        const list = parse(conditionRulesMarkup([{ type: 'speaker' }, { type: 'pattern' }], OPTIONS));
        expect([...list.querySelectorAll('[data-condition-rule]')].map(record => record.dataset.conditionRule)).toEqual(['0', '1']);
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
