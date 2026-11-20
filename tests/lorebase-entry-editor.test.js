/**
 * @vitest-environment jsdom
 *
 * LoreBase's entry editor (src/features/lorebase/lorebase-entry-editor.js), pressed as a user would: it opens one
 * lorebook entry's title and text, saying what Save writes; Save hands the changes to the storage module, which saves
 * the entry and writes its vectors; Cancel, or a form left as it opened, saves nothing; a refused or failed save keeps
 * the dialog open with the user's text and the reason; a toast says what a save left undone; a gone entry or a book
 * that cannot be read opens nothing. The dialogs, the books, the storage module and the vectors' toast are stubbed.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SETTINGS = { vector_backend: 'qdrant' };
const host = vi.hoisted(() => ({ entries: [], decidedUids: [], readError: null, answers: [], outcomes: [], shownForms: [] }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: { vector_backend: 'qdrant' } } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // Each answer edits the form as the user would, then says whether Save was pressed.
    formPopup: vi.fn(async (lines, form) => {
        host.shownForms.push({ title: form.querySelector('#vectfox_lorebase_entry_title').value, text: form.querySelector('#vectfox_lorebase_entry_text').value,
            status: form.querySelector('#vectfox_lorebase_entry_status').textContent });
        return host.answers.shift()(form);
    }),
    noticePopup: vi.fn(async () => {}),
}));
vi.mock('../src/features/lorebase/lorebase-books.js', () => ({
    loadBookEntries: async () => {
        if (host.readError) throw host.readError;
        return host.entries;
    },
    loadDecidedEntries: async () => host.entries.filter(entry => host.decidedUids.includes(String(entry.uid))),
}));
vi.mock('../src/features/lorebase/lorebase-storage.js', () => ({
    saveEntryWithVectors: vi.fn(async () => {
        const outcome = host.outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
    }),
}));
vi.mock('../src/features/lorebase/lorebase-vectors.js', () => ({ showVectorFailures: vi.fn() }));

const { editLoreBookEntry } = await import('../src/features/lorebase/lorebase-entry-editor.js');
const { formPopup, noticePopup } = await import('../src/sillytavern/popup.js');
const { saveEntryWithVectors } = await import('../src/features/lorebase/lorebase-storage.js');
const { showVectorFailures } = await import('../src/features/lorebase/lorebase-vectors.js');
const { log } = await import('../src/sillytavern/log.js');

const BOOK = 'Harbor Atlas';
const SAVED = { isDecided: true, failure: null, vectorProblem: null };
const typeText = text => (form) => {
    form.querySelector('#vectfox_lorebase_entry_text').value = text;
    return true;
};
const press = isSaved => () => isSaved;
const linesOf = call => formPopup.mock.calls[call][0];

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { warning: vi.fn(), info: vi.fn() };
    host.entries = [{ uid: 4, comment: '[Harbor] Lighthouse', content: 'It stands at the mouth of the harbor.' }, { uid: 7, comment: 'Pier', content: 'Old.' }];
    host.decidedUids = ['4'];
    host.readError = null;
    host.answers = [];
    host.outcomes = [];
    host.shownForms = [];
});

describe("LoreBase's entry editor", () => {
    it('opens the entry\'s title and text, says what Save writes, and saves the changes, then its vectors', async () => {
        host.answers = [typeText('It stands at the harbor mouth, its lamp lit at dusk.')];
        host.outcomes = [SAVED];

        expect(await editLoreBookEntry(BOOK, '4')).toBe(true);
        expect(host.shownForms[0]).toEqual({ title: '[Harbor] Lighthouse', text: 'It stands at the mouth of the harbor.', status: '' });
        expect(linesOf(0)).toEqual([
            { icon: 'fa-pen-to-square', text: 'Edit lorebook entry:', name: 'Lighthouse' },
            { text: 'Lorebook:', name: BOOK },
            { text: 'Save writes it into the lorebook, then writes its vectors again.' },
            { text: "Its LoreBase keys stay as they are: the pencil on LoreBase's selection screen writes new ones." },
        ]);
        expect(formPopup.mock.calls[0][2]).toEqual({ okButton: 'Save', isWide: true });
        expect(saveEntryWithVectors).toHaveBeenCalledWith(BOOK, '4', { comment: '[Harbor] Lighthouse', content: 'It stands at the harbor mouth, its lamp lit at dusk.' }, SETTINGS);
        expect(showVectorFailures).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('says, for an entry LoreBase does not decide, that Save writes no vectors', async () => {
        host.answers = [typeText('Its planks are gone.')];
        host.outcomes = [{ ...SAVED, isDecided: false }];
        expect(await editLoreBookEntry(BOOK, '7')).toBe(true);
        expect(linesOf(0)[2]).toEqual({ text: "Save writes it into the lorebook. LoreBase doesn't decide this entry, so no vectors are written." });
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
    });

    it('saves nothing on Cancel, or for a form left as it opened', async () => {
        host.answers = [press(false)];
        expect(await editLoreBookEntry(BOOK, '4')).toBe(false);
        host.answers = [press(true)];
        expect(await editLoreBookEntry(BOOK, '4')).toBe(false);
        expect(saveEntryWithVectors).not.toHaveBeenCalled();
    });

    it("keeps the dialog open with the user's text and the reason when a save is refused, and saves on the next Save", async () => {
        const refusal = new Error('LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.');
        host.answers = [typeText('A new lamp.'), press(true)];
        host.outcomes = [refusal, SAVED];

        expect(await editLoreBookEntry(BOOK, '4')).toBe(true);
        expect(formPopup).toHaveBeenCalledTimes(2);
        expect(host.shownForms[1]).toEqual({ title: '[Harbor] Lighthouse', text: 'A new lamp.', status: `Not saved: ${refusal.message}` });
        expect(saveEntryWithVectors).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'), refusal);
    });

    it('says what a save left undone: vectors that failed, vectors it cannot write here, an entry LoreBase no longer decides', async () => {
        const failure = { title: 'Lighthouse', detail: 'upstream timeout' };
        host.answers = [typeText('One.'), typeText('Two.'), typeText('')];
        host.outcomes = [{ ...SAVED, failure }, { ...SAVED, vectorProblem: 'LoreBase keeps the vectors of each entry in Qdrant.' }, { ...SAVED, isDecided: false }];

        await editLoreBookEntry(BOOK, '4');
        expect(showVectorFailures).toHaveBeenCalledWith(BOOK, [failure]);
        await editLoreBookEntry(BOOK, '4');
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            '"Lighthouse" is saved, but its vectors were not written: LoreBase keeps the vectors of each entry in Qdrant.', 'VectFox — LoreBase', { timeOut: 15000 });
        await editLoreBookEntry(BOOK, '4');
        expect(globalThis.toastr.info).toHaveBeenCalledWith('"Lighthouse" is saved. LoreBase no longer decides it, so its vectors were not written again.', 'VectFox — LoreBase');
    });

    it('opens nothing, and says why, when the entry is gone or the book cannot be read', async () => {
        expect(await editLoreBookEntry(BOOK, '9')).toBe(false);
        expect(noticePopup.mock.calls[0][0]).toEqual([{ icon: 'fa-triangle-exclamation', text: 'Lorebook "Harbor Atlas" has no entry 9 any more.' }]);

        host.readError = new Error('no such lorebook');
        expect(await editLoreBookEntry(BOOK, '4')).toBe(false);
        expect(noticePopup.mock.calls[1][0]).toEqual([
            { icon: 'fa-triangle-exclamation', text: 'Lorebook "Harbor Atlas" could not be read.' }, { name: 'no such lorebook' },
        ]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'), host.readError);
        expect(formPopup).not.toHaveBeenCalled();
        expect(document.body.innerHTML).toBe('');
    });
});
