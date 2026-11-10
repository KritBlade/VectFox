/**
 * Text Cleaning's dialog markup on GUI-DNA (text-cleaning-dialog.js wires it): one page of cards. The preset; the
 * built-in patterns, which only Custom lets the user pick; the custom patterns, each a record with its switch; import
 * and export of the whole setup; and a tester for one pattern. Every control applies as it changes.
 *
 * Hooks: data-tc-action on buttons, data-tc-part on what the wiring paints, data-tc-builtin on a built-in's box and
 * data-tc-pattern (its id) on a custom pattern's record, with data-tc-field on that record's controls.
 */

import {
    button,
    checkList,
    emptyState,
    field,
    fieldLabel,
    grid,
    iconButton,
    input,
    notice,
    recordCard,
    resultList,
    select,
    selectOption,
    stack,
    switchInput,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, pageHeader } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtml } from '../../shared/html-escape.js';
import { patternText } from './text-cleaning-dialog-core.js';

export const CLEANING_IDS = Object.freeze({
    root: 'vectfox_text_cleaning',
    preset: 'vectfox_tc_preset',
    exportName: 'vectfox_tc_export_name',
    testFind: 'vectfox_tc_test_find',
    testReplace: 'vectfox_tc_test_replace',
    testSample: 'vectfox_tc_test_sample',
    testResult: 'vectfox_tc_test_result',
});

/** The name the export box starts with. */
export const DEFAULT_SETUP_NAME = 'My cleaning setup';

const HIDDEN = ' style="display:none;"';
const action = name => ({ 'tc-action': name });
const patternFieldId = (patternId, name) => `vectfox_tc_${name}_${patternId}`;

function card({ icon, title, description, actions = '', body }) {
    return `<section class="vfx-card">${cardHeader({ icon, title, description, actions })}<div class="vfx-card-body">${body}</div></section>`;
}

function presetCard({ presets, selectedPreset }) {
    const chosen = presets.find(preset => preset.id === selectedPreset);
    return card({
        icon: 'fa-list-check',
        title: 'Preset',
        description: 'The patterns that clean text before it is vectorized or read.',
        body: field([
            fieldLabel({ text: 'Preset', forId: CLEANING_IDS.preset }),
            select({ id: CLEANING_IDS.preset, options: presets.map(preset => selectOption({ value: preset.id, name: preset.name, isSelected: preset.id === selectedPreset })) }),
            `<p class="vfx-hint" data-tc-part="preset-description">${escapeHtml(chosen?.description ?? '')}</p>`,
        ]),
    });
}

/**
 * The built-in patterns' boxes, ticked as the preset has them; the wiring disables them unless the preset is Custom.
 *
 * @param {{builtins: {id: string, name: string}[], activeIds: string[]}} view
 * @returns {string}
 */
export function builtinListMarkup({ builtins, activeIds }) {
    return checkList({ items: builtins.map(builtin => ({ name: builtin.name, isChecked: activeIds.includes(builtin.id), data: { 'tc-builtin': builtin.id } })) });
}

function builtinsCard(view) {
    return card({
        icon: 'fa-shield-halved',
        title: 'Built-in patterns',
        description: 'Ticked as the preset has them; Custom lets you pick.',
        body: stack([
            `<div data-tc-part="builtins">${builtinListMarkup(view)}</div>`,
            `<p class="vfx-hint" data-tc-part="builtins-locked"${view.isCustom ? HIDDEN : ''}>Choose Custom above to pick these yourself.</p>`,
        ]),
    });
}

/**
 * One custom pattern: its switch, its name in the header and Delete, over its name, pattern and replacement.
 *
 * @param {{id: string, name: string, pattern: string, flags: string, replacement?: string, enabled?: boolean}} stored
 * @param {string} problem - Why its pattern does not compile, '' when it does
 * @returns {string}
 */
export function customPatternMarkup(stored, problem = '') {
    const nameId = patternFieldId(stored.id, 'name');
    const patternId = patternFieldId(stored.id, 'pattern');
    const replacementId = patternFieldId(stored.id, 'replacement');
    return recordCard({
        icon: 'fa-code',
        name: stored.name || 'Unnamed',
        nameData: { 'tc-part': 'pattern-name' },
        toggle: switchInput({ title: 'Use this pattern', isChecked: stored.enabled !== false, data: { 'tc-field': 'enabled' } }),
        actions: [iconButton({ icon: 'fa-trash', title: 'Delete pattern', isDanger: true, data: action('delete-pattern') })],
        data: { 'tc-pattern': stored.id },
        body: grid([
            field([fieldLabel({ text: 'Name', forId: nameId }), input({ id: nameId, value: stored.name, data: { 'tc-field': 'name' } })]),
            field([fieldLabel({ text: 'Replace with', forId: replacementId }), input({ id: replacementId, value: stored.replacement || '', placeholder: 'Empty removes the match', data: { 'tc-field': 'replacement' } })]),
            field([
                fieldLabel({ text: 'Pattern', forId: patternId }),
                input({ id: patternId, value: patternText(stored), placeholder: '/pattern/flags', isCode: true, data: { 'tc-field': 'pattern' } }),
                `<div data-tc-part="pattern-problem">${patternProblemMarkup(problem)}</div>`,
            ], { isSpan: true }),
        ]),
    });
}

/** Why a pattern does not compile, which keeps cleaning from using it; '' when it compiles. */
export function patternProblemMarkup(problem) {
    return problem ? notice({ status: 'danger', text: 'Not a valid pattern, so cleaning skips it', name: problem }) : '';
}

/** The custom patterns, or a line saying there are none. */
export function customPatternListMarkup(patterns, problemOf) {
    if (!patterns.length) return emptyState({ icon: 'fa-code', text: 'No custom patterns yet. Add one, or import a file.' });
    return stack(patterns.map(stored => customPatternMarkup(stored, problemOf(stored))));
}

function customPatternsCard({ customPatterns, isCustom, problemOf }) {
    return card({
        icon: 'fa-code',
        title: 'Custom patterns',
        description: 'Your own patterns, in /pattern/flags or bare.',
        actions: iconButton({ icon: 'fa-plus', title: 'Add pattern', data: action('add-pattern') }),
        body: `<div data-tc-part="custom-off"${isCustom ? HIDDEN : ''}>${notice({ status: 'info', text: 'Custom patterns clean only while the preset is Custom.' })}</div>`
            + `<div data-tc-part="patterns">${customPatternListMarkup(customPatterns, problemOf)}</div>`,
    });
}

/** What an import added and skipped. */
export function importResultMarkup({ setupName, count, warnings }) {
    const heading = setupName ? { text: 'Imported setup', name: setupName } : { text: 'Imported patterns' };
    return resultList({
        heading,
        lines: [
            { status: 'success', text: 'Patterns added', name: String(count) },
            ...warnings.map(name => ({ status: 'warning', name })),
        ],
    });
}

/** Why a file could not be imported. */
export function importFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'This file could not be read', name: reason });
}

function shareCard() {
    return card({
        icon: 'fa-right-left',
        title: 'Import and export',
        description: 'Export writes the preset, ticked built-ins and your patterns.',
        body: stack([
            field([fieldLabel({ text: 'Name', forId: CLEANING_IDS.exportName }), input({ id: CLEANING_IDS.exportName, value: DEFAULT_SETUP_NAME })]),
            `<div class="vfx-control-row">${button({ text: 'Import', icon: 'fa-file-import', data: action('import') })}${button({ text: 'Export', icon: 'fa-file-export', data: action('export') })}</div>`,
            `<div data-tc-part="import-result"></div>`,
        ]),
    });
}

/** A test's outcome: the sample as the pattern leaves it, why the pattern does not compile, or what the test lacks. */
export function testResultMarkup({ result = '', problem = '', isMissingInput = false }) {
    if (isMissingInput) return notice({ status: 'warning', text: 'Type a pattern and some sample text first.' });
    if (problem) return notice({ status: 'danger', text: 'Not a valid pattern', name: problem });
    return field([fieldLabel({ text: 'Result', forId: CLEANING_IDS.testResult }), textarea({ id: CLEANING_IDS.testResult, value: result, rows: 4, isCode: true })]);
}

function testerCard() {
    return card({
        icon: 'fa-vial',
        title: 'Test a pattern',
        description: 'Runs one pattern on sample text; nothing is saved.',
        body: grid([
            field([fieldLabel({ text: 'Pattern', forId: CLEANING_IDS.testFind }), input({ id: CLEANING_IDS.testFind, placeholder: '/pattern/flags', isCode: true })]),
            field([fieldLabel({ text: 'Replace with', forId: CLEANING_IDS.testReplace }), input({ id: CLEANING_IDS.testReplace, placeholder: 'Empty removes the match' })]),
            field([fieldLabel({ text: 'Sample text', forId: CLEANING_IDS.testSample }), textarea({ id: CLEANING_IDS.testSample, rows: 4 })], { isSpan: true }),
            field([`<div class="vfx-control-row">${button({ text: 'Test', icon: 'fa-play', kind: 'primary', data: action('test') })}</div>`, '<div data-tc-part="test-result"></div>'], { isSpan: true }),
        ]),
    });
}

/**
 * The whole dialog.
 *
 * @param {{presets: object[], selectedPreset: string, isCustom: boolean, builtins: object[], activeIds: string[],
 *   customPatterns: object[], problemOf: (stored: object) => string}} view
 * @returns {string}
 */
export function textCleaningMarkup(view) {
    return `<div id="${CLEANING_IDS.root}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Text Cleaning')}</div></nav>`
        + '<main class="vfx-main"><div class="vfx-page">'
        + pageHeader({ icon: 'fa-broom', eyebrow: 'VectFox / Text Cleaning', title: 'Text Cleaning', subtitle: 'Cleans text before it is vectorized or read by EventBase.' })
        + presetCard(view)
        + builtinsCard(view)
        + customPatternsCard(view)
        + shareCard()
        + testerCard()
        + '</div></main></div>';
}
