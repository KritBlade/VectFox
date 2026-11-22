/**
 * The header every file VectFox exports opens with (§1 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): the export format's version, when the file was made, and that VectFox made it.
 * A collection export, a StoryArc links file and LoreBase's keys and vectors files all open with it. Pure.
 */

// The export format's version; an import reads the files of its major version (validateImportData).
const EXPORT_VERSION = '1.0.0';

/**
 * A new file's header, dated now.
 * @returns {{version: string, exportDate: string, generator: string}}
 */
export function exportFileHeader() {
    return { version: EXPORT_VERSION, exportDate: new Date().toISOString(), generator: 'VectFox' };
}
