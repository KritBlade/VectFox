// features/text-cleaning — the cleaning rules applied to text before it is vectorized or extracted (presets,
// custom patterns, reasoning and game-system block stripping), and their editor.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { openTextCleaningModal } from './text-cleaning-ui.js';
export {
    CLEANING_PRESETS,
    cleanContentOrNull,
    cleanText,
    getCleaningSettings,
    saveCleaningSettings,
    stripGameSystemBlocks,
    stripReasoningBlocks,
} from './text-cleaning.js';
