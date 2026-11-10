/**
 * ============================================================================
 * VectFox TEXT CLEANING DIALOG
 * ============================================================================
 * Text Cleaning's dialog (text-cleaning-dialog-markup.js draws it), opened from the panel's Action page and from
 * Vectorize Content. Every control applies as it changes, so there is no Save: the preset, the built-ins Custom picks,
 * each custom pattern's switch, name, pattern and replacement. A pattern that does not compile stays as typed, flagged
 * on its record, and cleaning skips it. Its handlers are delegated on its root.
 *
 * @author Kritblade
 * ============================================================================
 */

import { saveSettingsDebounced } from '../../sillytavern/settings.js';
import { confirmPopup, openPanelPopup } from '../../sillytavern/popup.js';
import { download } from '../../sillytavern/extension-runtime.js';
import { log } from '../../sillytavern/log.js';
import { pickFiles } from '../../shared/pick-files.js';
import { bindGeneBehaviours, setShown } from '../../shared/gui-dna/gene-behaviours.js';
import {
    BUILTIN_PATTERNS,
    CLEANING_PRESETS,
    CUSTOM_PRESET_ID,
    addCustomPattern,
    chooseCleaningPreset,
    cleaningPresetChoices,
    cleaningSetupFile,
    getCleaningSettings,
    importPatterns,
    patternProblem,
    removeCustomPattern,
    saveCleaningSettings,
    testPattern,
    updateCustomPattern,
} from './text-cleaning.js';
import {
    CLEANING_IDS,
    DEFAULT_SETUP_NAME,
    builtinListMarkup,
    customPatternListMarkup,
    importFailedMarkup,
    importResultMarkup,
    patternProblemMarkup,
    testResultMarkup,
    textCleaningMarkup,
} from './text-cleaning-dialog-markup.js';
import { patternFromText, setupFileName } from './text-cleaning-dialog-core.js';

/** The open dialog's root, so a second open while it shows does not draw another. */
let openRoot = null;

const problemOf = stored => patternProblem(stored.pattern, stored.flags);
const isCustomPreset = settings => !settings.selectedPreset || settings.selectedPreset === CUSTOM_PRESET_ID;

/** The built-ins that clean now: the preset's own, or under Custom the ones the user ticked. */
function activeBuiltinIds(settings) {
    return isCustomPreset(settings) ? (settings.enabledBuiltins || []) : (CLEANING_PRESETS[settings.selectedPreset]?.patterns || []);
}

function dialogView() {
    const settings = getCleaningSettings();
    return {
        presets: cleaningPresetChoices(),
        selectedPreset: settings.selectedPreset || CUSTOM_PRESET_ID,
        isCustom: isCustomPreset(settings),
        builtins: Object.values(BUILTIN_PATTERNS),
        activeIds: activeBuiltinIds(settings),
        customPatterns: settings.customPatterns || [],
        problemOf,
    };
}

const partOf = (root, name) => root.querySelector(`[data-tc-part="${name}"]`);

/**
 * Open Text Cleaning. Resolves when it closes, so a surface that shows the preset can show it again.
 *
 * @returns {Promise<void>}
 */
export async function openTextCleaningDialog() {
    if (openRoot) return;
    const template = document.createElement('template');
    template.innerHTML = textCleaningMarkup(dialogView());
    const root = template.content.firstElementChild;
    openRoot = root;
    bindGeneBehaviours(root);
    bindDialog(root);
    showPresetState(root);
    try {
        await openPanelPopup(root);
    } finally {
        openRoot = null;
    }
}

/** The preset's description, the built-ins it ticks (locked unless Custom), and whether custom patterns clean. */
function showPresetState(root) {
    const view = dialogView();
    root.querySelector(`#${CLEANING_IDS.preset}`).value = view.selectedPreset;
    partOf(root, 'preset-description').textContent = view.presets.find(preset => preset.id === view.selectedPreset)?.description ?? '';
    partOf(root, 'builtins').innerHTML = builtinListMarkup(view);
    for (const box of root.querySelectorAll('[data-tc-builtin]')) box.disabled = !view.isCustom;
    setShown(partOf(root, 'builtins-locked'), !view.isCustom);
    setShown(partOf(root, 'custom-off'), !view.isCustom);
}

function showCustomPatterns(root) {
    partOf(root, 'patterns').innerHTML = customPatternListMarkup(getCleaningSettings().customPatterns || [], problemOf);
}

function bindDialog(root) {
    root.addEventListener('change', (event) => {
        const control = event.target;
        if (control.id === CLEANING_IDS.preset) {
            chooseCleaningPreset(control.value);
            showPresetState(root);
            return;
        }
        if (control.dataset.tcBuiltin !== undefined) return saveBuiltinChoice(root);
        const record = control.closest('[data-tc-pattern]');
        if (record && control.dataset.tcField) applyPatternField(record, control);
    });
    // A pattern's header follows its name box as it is typed.
    root.addEventListener('input', (event) => {
        if (event.target.dataset.tcField !== 'name') return;
        const header = event.target.closest('[data-tc-pattern]')?.querySelector('[data-tc-part="pattern-name"]');
        if (header) header.textContent = event.target.value || 'Unnamed';
    });
    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-tc-action]');
        if (!button) return;
        switch (button.dataset.tcAction) {
            case 'add-pattern': return addPattern(root);
            case 'delete-pattern': return void deletePattern(root, button.closest('[data-tc-pattern]'));
            case 'import': return void importSetup(root);
            case 'export': return exportSetup(root);
            case 'test': return runTest(root);
            default: return undefined;
        }
    });
}

/** Under Custom, the ticked built-ins are the ones that clean. */
function saveBuiltinChoice(root) {
    const settings = getCleaningSettings();
    settings.enabledBuiltins = [...root.querySelectorAll('[data-tc-builtin]')].filter(box => box.checked).map(box => box.dataset.tcBuiltin);
    saveCleaningSettings(settings);
    saveSettingsDebounced();
}

function applyPatternField(record, control) {
    const id = record.dataset.tcPattern;
    switch (control.dataset.tcField) {
        case 'enabled':
            updateCustomPattern(id, { enabled: control.checked });
            break;
        case 'name':
            updateCustomPattern(id, { name: control.value });
            break;
        case 'replacement':
            updateCustomPattern(id, { replacement: control.value });
            break;
        case 'pattern': {
            const { pattern, flags } = patternFromText(control.value);
            updateCustomPattern(id, { pattern, flags });
            partOf(record, 'pattern-problem').innerHTML = patternProblemMarkup(patternProblem(pattern, flags));
            break;
        }
        default:
            return;
    }
    saveSettingsDebounced();
}

function addPattern(root) {
    const id = addCustomPattern({ name: 'New pattern', pattern: '', replacement: '', flags: 'gi' });
    saveSettingsDebounced();
    showCustomPatterns(root);
    const added = [...root.querySelectorAll('[data-tc-pattern]')].find(each => each.dataset.tcPattern === id);
    added?.querySelector('[data-tc-field="pattern"]')?.focus();
}

async function deletePattern(root, record) {
    if (!record) return;
    const name = record.querySelector('[data-tc-field="name"]')?.value || 'Unnamed';
    const isConfirmed = await confirmPopup([{ text: 'Delete this custom pattern?' }, { text: 'Pattern:', name }], { okButton: 'Delete', isDestructive: true });
    if (!isConfirmed) return;
    removeCustomPattern(record.dataset.tcPattern);
    saveSettingsDebounced();
    showCustomPatterns(root);
}

/** Read a setup or a file of patterns: an imported setup sets the preset and built-ins too. */
async function importSetup(root) {
    const [file] = await pickFiles({ accept: '.json' });
    if (!file) return;
    const result = importPatterns(await file.text());
    const resultSlot = partOf(root, 'import-result');
    if (!result.success) {
        log.warn(`VectFox Text Cleaning: ${file.name} could not be imported:`, result.error);
        resultSlot.innerHTML = importFailedMarkup(result.error);
        return;
    }
    saveSettingsDebounced();
    showPresetState(root);
    showCustomPatterns(root);
    resultSlot.innerHTML = importResultMarkup({ setupName: result.isTemplate ? result.templateName : '', count: result.count, warnings: result.warnings || [] });
    log.lifecycle(`VectFox Text Cleaning: imported ${result.count} pattern(s) from ${file.name}`);
}

function exportSetup(root) {
    const name = root.querySelector(`#${CLEANING_IDS.exportName}`).value.trim() || DEFAULT_SETUP_NAME;
    download(cleaningSetupFile(name), setupFileName(name), 'application/json');
    log.lifecycle(`VectFox Text Cleaning: exported the setup "${name}"`);
}

function runTest(root) {
    const { pattern, flags } = patternFromText(root.querySelector(`#${CLEANING_IDS.testFind}`).value);
    const replacement = root.querySelector(`#${CLEANING_IDS.testReplace}`).value;
    const sample = root.querySelector(`#${CLEANING_IDS.testSample}`).value;
    const slot = partOf(root, 'test-result');
    if (!pattern || !sample) {
        slot.innerHTML = testResultMarkup({ isMissingInput: true });
        return;
    }
    const outcome = testPattern(pattern, flags, replacement, sample);
    slot.innerHTML = testResultMarkup(outcome.success ? { result: outcome.result } : { problem: outcome.error });
    const result = slot.querySelector(`#${CLEANING_IDS.testResult}`);
    if (result) result.readOnly = true;
}
