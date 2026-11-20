/**
 * LoreBase's entry editor (the user, 2026-11-20): one lorebook entry's title and text in a dialog, opened by Edit entry
 * on a chunk the Database Browser's Chunk Visualizer shows. Save writes them into the lorebook through SillyTavern, then
 * the entry's vectors when LoreBase decides it (saveEntryWithVectors); a save refused or failed keeps the dialog open
 * with the user's text and the reason. A toast says what a save left undone. Its LoreBase keys stay as they are.
 */
import { log } from '../../sillytavern/log.js';
import { formPopup, noticePopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { loadBookEntries, loadDecidedEntries } from './lorebase-books.js';
import { ENTRY_EDITOR_IDS as ids, entryEditorLines, entryEditorMarkup } from './lorebase-entry-editor-markup.js';
import { entryTitle } from './lorebase-splitter.js';
import { saveEntryWithVectors } from './lorebase-storage.js';
import { showVectorFailures } from './lorebase-vectors.js';

const LOREBASE_TOAST = 'VectFox — LoreBase';
const hasUid = uid => entry => String(entry.uid) === String(uid);

/**
 * Say what a save left undone: vectors that failed or cannot be written here, or vectors not written again because
 * LoreBase no longer decides the entry as saved.
 * @param {string} bookName
 * @param {string} title - The entry's title as saved
 * @param {Awaited<ReturnType<typeof saveEntryWithVectors>>} outcome
 * @param {boolean} wasDecided - Whether LoreBase decided the entry when the dialog opened
 */
function reportSave(bookName, title, outcome, wasDecided) {
    // toastr is SillyTavern's page global, absent where no page is loaded.
    if (outcome.failure) {
        showVectorFailures(bookName, [outcome.failure]);
    } else if (outcome.vectorProblem) {
        globalThis.toastr?.warning(`"${title}" is saved, but its vectors were not written: ${outcome.vectorProblem}`, LOREBASE_TOAST, { timeOut: 15000 });
    } else if (wasDecided && !outcome.isDecided) {
        globalThis.toastr?.info(`"${title}" is saved. LoreBase no longer decides it, so its vectors were not written again.`, LOREBASE_TOAST);
    }
}

/**
 * Edit one entry of a lorebook in a dialog: its title and text. Save writes them, then its vectors when LoreBase decides
 * it; a form left as it opened saves nothing.
 * @param {string} bookName
 * @param {string} uid - The entry's uid
 * @returns {Promise<boolean>} Whether the entry was saved
 */
export async function editLoreBookEntry(bookName, uid) {
    let entry;
    let isDecided;
    try {
        entry = (await loadBookEntries(bookName)).find(hasUid(uid));
        isDecided = (await loadDecidedEntries(bookName)).some(hasUid(uid));
    } catch (error) {
        log.warn(`LoreBase: lorebook "${bookName}" could not be read to edit its entry ${uid}:`, error);
        await noticePopup([{ icon: 'fa-triangle-exclamation', text: `Lorebook "${bookName}" could not be read.` }, { name: String(error?.message || error) }]);
        return false;
    }
    if (!entry) {
        await noticePopup([{ icon: 'fa-triangle-exclamation', text: `Lorebook "${bookName}" has no entry ${uid} any more.` }]);
        return false;
    }
    const holder = document.createElement('div');
    holder.innerHTML = entryEditorMarkup(entry);
    const form = holder.firstElementChild;
    const status = form.querySelector(`#${ids.status}`);
    const lines = entryEditorLines({ title: entryTitle(entry), bookName, isDecided });
    for (;;) {
        // No control takes the focus: the dialog would select its whole text, which a key press would replace.
        if (!await formPopup(lines, form, { okButton: 'Save', isWide: true })) return false;
        const fields = { comment: form.querySelector(`#${ids.title}`).value, content: form.querySelector(`#${ids.text}`).value };
        if (fields.comment === String(entry.comment ?? '') && fields.content === String(entry.content ?? '')) return false;
        try {
            const outcome = await saveEntryWithVectors(bookName, uid, fields, extension_settings.vectfox);
            reportSave(bookName, entryTitle({ ...entry, ...fields }), outcome, isDecided);
            return true;
        } catch (error) {
            log.warn(`LoreBase: entry ${uid} of lorebook "${bookName}" could not be saved:`, error);
            status.textContent = `Not saved: ${String(error?.message || error)}`;
        }
    }
}
