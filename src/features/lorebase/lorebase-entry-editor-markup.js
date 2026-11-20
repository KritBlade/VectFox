/**
 * LoreBase's entry editor, its markup (the user, 2026-11-20): the dialog's lines, and its form of one lorebook entry's
 * title and text with the line that says why a save failed. lorebase-entry-editor.js finds each control by its id in
 * ENTRY_EDITOR_IDS. Every value is escaped by the builders. Pure: builds strings.
 */
import { field, fieldLabel, input, stack, textarea } from '../../shared/gui-dna/gui-dna-core.js';

/** The ids lorebase-entry-editor.js finds the form's controls by. */
export const ENTRY_EDITOR_IDS = Object.freeze({
    title: 'vectfox_lorebase_entry_title',
    text: 'vectfox_lorebase_entry_text',
    status: 'vectfox_lorebase_entry_status',
});

const ids = ENTRY_EDITOR_IDS;

/**
 * The lines over the form: the entry and its lorebook, what Save writes, and that its LoreBase keys stay.
 * @param {{title: string, bookName: string, isDecided: boolean}} view - isDecided: whether LoreBase decides the entry
 * @returns {object[]}
 */
export function entryEditorLines({ title, bookName, isDecided }) {
    return [
        { icon: 'fa-pen-to-square', text: 'Edit lorebook entry:', name: title },
        { text: 'Lorebook:', name: bookName },
        isDecided
            ? { text: 'Save writes it into the lorebook, then writes its vectors again.' }
            : { text: "Save writes it into the lorebook. LoreBase doesn't decide this entry, so no vectors are written." },
        { text: "Its LoreBase keys stay as they are: the pencil on LoreBase's selection screen writes new ones." },
    ];
}

/**
 * The form: the entry's title, as SillyTavern's Title/Memo holds it, its text, and the line that says why a save failed.
 * @param {{comment?: string, content?: string}} entry - The book's entry, as loadWorldInfo returns it
 * @returns {string}
 */
export function entryEditorMarkup(entry) {
    return stack([
        field([fieldLabel({ text: 'Title', forId: ids.title }), input({ id: ids.title, value: String(entry.comment ?? '') })]),
        field([fieldLabel({ text: 'Text', forId: ids.text }), textarea({ id: ids.text, value: String(entry.content ?? ''), rows: 16 })]),
        `<p id="${ids.status}" class="vfx-hint" aria-live="polite"></p>`,
    ]);
}
