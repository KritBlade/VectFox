// features/text-cleaning — the cleaning rules applied to text before it is vectorized or extracted (presets,
// custom patterns, reasoning and game-system block stripping), and their editor.
//
// The dialog loads on its first open, so the pipelines that clean text never load it. Everything else here is a
// re-export. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    chooseCleaningPreset,
    cleanContentOrNull,
    cleaningPresetChoices,
    cleanText,
    getCleaningSettings,
    stripGameSystemBlocks,
    stripReasoningBlocks,
} from './text-cleaning.js';

/**
 * Open Text Cleaning (text-cleaning-dialog.js), loading it on the first open.
 * @returns {Promise<void>} Resolves when it closes
 */
export async function openTextCleaningDialog() {
    const dialog = await import('./text-cleaning-dialog.js');
    return dialog.openTextCleaningDialog();
}
