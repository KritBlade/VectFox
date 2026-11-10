/**
 * @vitest-environment jsdom
 *
 * Text Cleaning's dialog on GUI-DNA (src/features/text-cleaning/text-cleaning-dialog.js), driven as a user would: every
 * control applies as it changes, with no Save; the built-ins stay locked unless the preset is Custom; a pattern that
 * does not compile stays as typed, flagged on its record, and cleaning skips it; deleting a pattern asks; one Export
 * writes the whole setup under the name typed, where the old dialog had Save Template and Export and asked the name
 * with prompt(); Import reads a setup or a list of patterns and says what it added, in the dialog.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    root: { vectfox: {} },
    answer: true,
    files: [],
    dialogs: [],
    nextId: 0,
}));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.root, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/identifiers.js', () => ({ uuidv4: () => `pattern-${++host.nextId}` }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/extension-runtime.js', () => ({ download: vi.fn() }));
vi.mock('../src/sillytavern/popup.js', () => ({
    openPanelPopup: vi.fn(root => {
        document.body.append(root);
        return new Promise((resolve) => { host.dialogs.push({ root, resolve }); });
    }),
    confirmPopup: vi.fn(async () => host.answer),
}));
vi.mock('../src/shared/pick-files.js', () => ({ pickFiles: vi.fn(async () => host.files) }));

const { openTextCleaningDialog } = await import('../src/features/text-cleaning/text-cleaning-dialog.js');
const { getActivePatterns, BUILTIN_PATTERNS } = await import('../src/features/text-cleaning/text-cleaning.js');
const { patternFromText, patternText, setupFileName } = await import('../src/features/text-cleaning/text-cleaning-dialog-core.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { download } = await import('../src/sillytavern/extension-runtime.js');

const $id = id => document.getElementById(id);
const part = name => document.querySelector(`[data-tc-part="${name}"]`);
const click = action => document.querySelector(`[data-tc-action="${action}"]`).click();
const isShown = element => element.style.display !== 'none';
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};
const record = id => document.querySelector(`[data-tc-pattern="${id}"]`);
const cleaning = () => host.root.vectfox.cleaning;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function closeDialog() {
    for (const dialog of host.dialogs.splice(0)) {
        dialog.root.remove();
        dialog.resolve();
    }
    await settle();
}

beforeEach(async () => {
    await closeDialog();
    vi.stubGlobal('$', $);
    vi.clearAllMocks();
    host.root.vectfox = {};
    host.answer = true;
    host.files = [];
    host.nextId = 0;
    document.body.innerHTML = '';
});

describe('a pattern box', () => {
    it('reads /pattern/flags or a bare pattern, which cleans case-blind everywhere', () => {
        expect(patternFromText('/<b>(.*?)<\\/b>/g')).toEqual({ pattern: '<b>(.*?)<\\/b>', flags: 'g' });
        expect(patternFromText('\\[OOC\\]')).toEqual({ pattern: '\\[OOC\\]', flags: 'gi' });
        expect(patternFromText('')).toEqual({ pattern: '', flags: 'gi' });
    });

    it('shows a stored pattern as /pattern/flags, which reads back as it was, a leading slash included', () => {
        for (const stored of [{ pattern: 'tide', flags: 'gi' }, { pattern: '/harbor', flags: 'g' }, { pattern: 'a/b', flags: 'gm' }]) {
            expect(patternFromText(patternText(stored))).toEqual(stored);
        }
        expect(patternText({ pattern: '' })).toBe('');
    });

    it('names an export after its setup', () => {
        expect(setupFileName('Harbor Rules: v2')).toBe('vectfox-cleaning-harbor-rules-v2.json');
        expect(setupFileName('   ')).toBe('vectfox-cleaning-setup.json');
    });
});

describe('cleaning with custom patterns', () => {
    it('skips a custom pattern that does not compile or is empty, so cleaning never warns per text', () => {
        host.root.vectfox.cleaning = {
            selectedPreset: 'custom',
            enabledBuiltins: [],
            customPatterns: [
                { id: 'a', name: 'Broken', pattern: '(unclosed', flags: 'g', enabled: true },
                { id: 'b', name: 'Empty', pattern: '', flags: 'gi', enabled: true },
                { id: 'c', name: 'Tide', pattern: 'tide', flags: 'gi', enabled: true },
            ],
        };
        expect(getActivePatterns().map(each => each.name)).toEqual(['Tide']);
    });
});

describe('the Text Cleaning dialog', () => {
    it('opens on the saved preset with the built-ins locked to it, and Custom unlocks them, saved at once', async () => {
        host.root.vectfox.cleaning = { selectedPreset: 'mvu_game_maker', enabledBuiltins: [], customPatterns: [] };
        void openTextCleaningDialog();
        expect($id('vectfox_tc_preset').value).toBe('mvu_game_maker');
        const boxes = [...document.querySelectorAll('[data-tc-builtin]')];
        expect(boxes.length).toBe(Object.keys(BUILTIN_PATTERNS).length);
        expect(boxes.every(box => box.disabled)).toBe(true);
        expect(isShown(part('builtins-locked'))).toBe(true);
        expect(isShown(part('custom-off'))).toBe(true);

        change($id('vectfox_tc_preset'), 'custom');
        expect(cleaning().selectedPreset).toBe('custom');
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect([...document.querySelectorAll('[data-tc-builtin]')].some(box => box.disabled)).toBe(false);
        expect(isShown(part('builtins-locked'))).toBe(false);
        expect(isShown(part('custom-off'))).toBe(false);
        expect(part('preset-description').textContent).toBe('Your own built-ins and custom patterns.');

        const first = document.querySelector('[data-tc-builtin]');
        change(first, true);
        expect(cleaning().enabledBuiltins).toEqual([first.dataset.tcBuiltin]);
    });

    it('adds a pattern, applies each field as it changes, and flags a pattern that does not compile', async () => {
        host.root.vectfox.cleaning = { selectedPreset: 'custom', enabledBuiltins: [], customPatterns: [] };
        void openTextCleaningDialog();
        expect(part('patterns').textContent).toContain('No custom patterns yet');

        click('add-pattern');
        const [added] = cleaning().customPatterns;
        const nameBox = record(added.id).querySelector('[data-tc-field="name"]');
        nameBox.value = 'Tide marks';
        nameBox.dispatchEvent(new Event('input', { bubbles: true }));
        expect(record(added.id).querySelector('[data-tc-part="pattern-name"]').textContent).toBe('Tide marks');
        change(nameBox, 'Tide marks');
        expect(cleaning().customPatterns[0].name).toBe('Tide marks');

        const patternBox = record(added.id).querySelector('[data-tc-field="pattern"]');
        change(patternBox, '/(high tide/g');
        expect(cleaning().customPatterns[0]).toMatchObject({ pattern: '(high tide', flags: 'g' });
        expect(record(added.id).querySelector('[data-tc-part="pattern-problem"]').textContent).toContain('Not a valid pattern, so cleaning skips it');

        change(patternBox, '/high tide/g');
        expect(record(added.id).querySelector('[data-tc-part="pattern-problem"]').textContent).toBe('');
        change(record(added.id).querySelector('[data-tc-field="enabled"]'), false);
        expect(cleaning().customPatterns[0].enabled).toBe(false);
    });

    it('asks before deleting a pattern, and Cancel keeps it', async () => {
        host.root.vectfox.cleaning = { selectedPreset: 'custom', enabledBuiltins: [], customPatterns: [{ id: 'gulls', name: 'Gulls', pattern: 'gull', flags: 'gi', enabled: true }] };
        void openTextCleaningDialog();
        host.answer = false;
        record('gulls').querySelector('[data-tc-action="delete-pattern"]').click();
        await settle();
        expect(confirmPopup).toHaveBeenCalledWith([{ text: 'Delete this custom pattern?' }, { text: 'Pattern:', name: 'Gulls' }], { okButton: 'Delete', isDestructive: true });
        expect(cleaning().customPatterns).toHaveLength(1);

        host.answer = true;
        record('gulls').querySelector('[data-tc-action="delete-pattern"]').click();
        await vi.waitFor(() => expect(cleaning().customPatterns).toHaveLength(0));
        expect(record('gulls')).toBeNull();
    });

    it('exports the whole setup under the name typed', () => {
        host.root.vectfox.cleaning = { selectedPreset: 'custom', enabledBuiltins: ['strip_font_tags'], customPatterns: [{ id: 'gulls', name: 'Gulls', pattern: 'gull', flags: 'gi', enabled: true }] };
        void openTextCleaningDialog();
        $id('vectfox_tc_export_name').value = 'Harbor setup';
        click('export');
        const [json, fileName, type] = download.mock.calls[0];
        expect(fileName).toBe('vectfox-cleaning-harbor-setup.json');
        expect(type).toBe('application/json');
        expect(JSON.parse(json)).toMatchObject({ name: 'Harbor setup', preset: 'custom', enabledBuiltins: ['strip_font_tags'], customPatterns: [{ name: 'Gulls', pattern: 'gull' }] });
    });

    it('imports a setup, shows what it added and skipped, and says when a file cannot be read', async () => {
        host.root.vectfox.cleaning = { selectedPreset: 'none', enabledBuiltins: [], customPatterns: [] };
        void openTextCleaningDialog();
        const setup = { name: 'Docks', preset: 'custom', enabledBuiltins: ['strip_font_tags'], customPatterns: [{ name: 'Gulls', pattern: 'gull' }, { name: 'Greedy', pattern: '(a+)+' }] };
        host.files = [{ name: 'docks.json', text: async () => JSON.stringify(setup) }];
        click('import');
        await vi.waitFor(() => expect(part('import-result').textContent).toContain('Docks'));
        expect(part('import-result').textContent).toContain('Patterns added: 1');
        expect(part('import-result').textContent).toContain('Pattern "Greedy" skipped');
        expect($id('vectfox_tc_preset').value).toBe('custom');
        expect(part('patterns').textContent).toContain('Gulls');

        host.files = [{ name: 'broken.json', text: async () => 'not json' }];
        click('import');
        await vi.waitFor(() => expect(part('import-result').textContent).toContain('This file could not be read'));
    });

    it('tests a pattern on sample text without saving it', () => {
        host.root.vectfox.cleaning = { selectedPreset: 'none', enabledBuiltins: [], customPatterns: [] };
        void openTextCleaningDialog();
        click('test');
        expect(part('test-result').textContent).toContain('Type a pattern and some sample text first.');

        $id('vectfox_tc_test_find').value = '/gulls?/gi';
        $id('vectfox_tc_test_replace').value = 'birds';
        $id('vectfox_tc_test_sample').value = 'A gull and two Gulls.';
        click('test');
        expect($id('vectfox_tc_test_result').value).toBe('A birds and two birds.');
        expect($id('vectfox_tc_test_result').readOnly).toBe(true);

        $id('vectfox_tc_test_find').value = '/(gull/g';
        click('test');
        expect(part('test-result').textContent).toContain('Not a valid pattern');
        expect(cleaning().customPatterns).toEqual([]);
    });
});
