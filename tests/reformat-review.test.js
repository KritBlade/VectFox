/**
 * @vitest-environment jsdom
 *
 * The Auto-Reformat review (src/features/chunkbase/reformat-review.js, its core and markup), driven as a user would:
 * Accept hands over the kept entries as edited, and says which kept ones lack a name or a body where the old review
 * dropped them silently; leaving a draft with edits, by closing or Run again, asks first, where the old review threw
 * the edits away; closing a draft without edits drops it, as Chunk by strategy does.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ answer: true, dialogs: [] }));

vi.mock('../src/sillytavern/popup.js', () => ({
    openPanelPopup: vi.fn((root, { canClose } = {}) => {
        document.body.append(root);
        return new Promise((resolve) => { host.dialogs.push({ root, canClose, resolve }); });
    }),
    closePanelPopup: vi.fn(async (root) => {
        const dialog = host.dialogs.find(each => each.root === root);
        if (!dialog || (dialog.canClose && !(await dialog.canClose()))) return;
        host.dialogs.splice(host.dialogs.indexOf(dialog), 1);
        root.remove();
        dialog.resolve();
    }),
    confirmPopup: vi.fn(async () => host.answer),
}));

const { openReformatReview } = await import('../src/features/chunkbase/reformat-review.js');
const { closePanelPopup, confirmPopup } = await import('../src/sillytavern/popup.js');
const { acceptedEntries, entryFormValues, entryFromForm, groundingWarnings, isEntryEdited } = await import('../src/features/chunkbase/reformat-review-core.js');

const RECORDS = [
    { entry_type: 'character', name: 'Keeper', aliases: ['Old Keeper'], affiliation: 'Harbor', traits: ['patient'], relationships: [], keywords: ['gate'], body: 'Rules the harbor.', _nameGrounded: true },
    { entry_type: 'location', name: 'Lighthouse', aliases: [], affiliation: '', traits: [], relationships: [], keywords: [], body: 'Stands on the cliff.', _nameGrounded: false, _ungroundedAliases: [] },
];

const handlers = { onAccept: vi.fn(), onDiscard: vi.fn(), onRerun: vi.fn() };
const open = () => openReformatReview({ chunks: RECORDS, warnings: ['Batch 2 was cut short.'], sourceText: 'The keeper rules the harbor.', sourceName: 'Harbor notes', contentType: 'document', ...handlers });
const action = name => document.querySelector(`[data-rr-action="${name}"]`);
const type = (id, value) => {
    const box = document.getElementById(id);
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
    vi.stubGlobal('$', $);
    for (const dialog of [...host.dialogs]) {
        dialog.root.remove();
        dialog.resolve();
    }
    host.dialogs.length = 0;
    await settle();
    document.body.innerHTML = '';
    host.answer = true;
    vi.clearAllMocks();
});

describe('an entry\'s rules', () => {
    it('shows lists comma-separated, reads them back split, and tells an edit', () => {
        const form = entryFormValues({ ...RECORDS[0], _accepted: true });
        expect(form).toMatchObject({ aliases: 'Old Keeper', traits: 'patient', isKept: true });
        expect(isEntryEdited({ ...RECORDS[0], _accepted: true }, form)).toBe(false);
        expect(isEntryEdited({ ...RECORDS[0], _accepted: true }, { ...form, isKept: false })).toBe(true);
        expect(entryFromForm(RECORDS[0], { ...form, aliases: ' Old Keeper , Warden ,', name: ' Keeper ' })).toMatchObject({ aliases: ['Old Keeper', 'Warden'], name: 'Keeper' });
    });

    it('warns about a name or aliases not in the source, and keeps only complete kept entries', () => {
        expect(groundingWarnings(RECORDS[1])).toEqual(['"Lighthouse" is not in the source: check it was not invented.']);
        expect(groundingWarnings({ name: 'X', _nameGrounded: true, _ungroundedAliases: ['Y'] })).toEqual(['Not in the source: Y.']);
        expect(acceptedEntries([{ name: 'A', body: 'b', _accepted: false }]).problem).toBe('Keep at least one entry, or choose Chunk by strategy.');
        expect(acceptedEntries([{ name: 'A', body: '', _accepted: true }, { name: 'B', body: 'b', _accepted: true }]).problem).toBe('A kept entry needs a name and a body: A.');
    });
});

describe('the review', () => {
    it('hands over the kept entries as edited on Accept', async () => {
        open();
        type('vectfox_rr_0_name', 'Harbor Keeper');
        const keep = document.querySelector('[data-rr-keep="1"]');
        keep.checked = false;
        keep.dispatchEvent(new Event('change', { bubbles: true }));
        expect(document.querySelector('[data-rr-name="0"]').textContent).toBe('Harbor Keeper');
        expect(document.querySelector('[data-rr-edited="0"]').style.display).toBe('');

        action('accept').click();
        await vi.waitFor(() => expect(handlers.onAccept).toHaveBeenCalledTimes(1));
        expect(handlers.onAccept.mock.calls[0][0].map(entry => entry.name)).toEqual(['Harbor Keeper']);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(handlers.onDiscard).not.toHaveBeenCalled();
    });

    // The old review dropped such an entry from the accepted set without a word.
    it('names a kept entry with no body instead of dropping it', async () => {
        open();
        type('vectfox_rr_1_body', '');
        action('accept').click();
        await settle();
        expect(document.querySelector('[data-rr-state]').textContent).toBe('A kept entry needs a name and a body: Lighthouse.');
        expect(handlers.onAccept).not.toHaveBeenCalled();
        expect(host.dialogs).toHaveLength(1);
    });

    // The old review's X and Run again threw the edits away without asking.
    it('asks before Run again or closing loses edits, and Cancel stays', async () => {
        open();
        type('vectfox_rr_0_body', 'Rules the harbor and the gate.');
        host.answer = false;
        action('rerun').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        await closePanelPopup(document.getElementById('vectfox_reformat_review'));
        expect(confirmPopup).toHaveBeenCalledTimes(2);
        expect(host.dialogs).toHaveLength(1);
        expect(handlers.onRerun).not.toHaveBeenCalled();

        host.answer = true;
        action('rerun').click();
        await vi.waitFor(() => expect(handlers.onRerun).toHaveBeenCalledTimes(1));
        expect(handlers.onDiscard).not.toHaveBeenCalled();
    });

    it('drops a draft without edits on close, asking nothing', async () => {
        open();
        await closePanelPopup(document.getElementById('vectfox_reformat_review'));
        await vi.waitFor(() => expect(handlers.onDiscard).toHaveBeenCalledTimes(1));
        expect(confirmPopup).not.toHaveBeenCalled();
    });

    it('shows the source read-only beside the entries, with the run\'s warnings', () => {
        open();
        expect(document.getElementById('vectfox_rr_source').readOnly).toBe(true);
        expect(document.getElementById('vectfox_reformat_review').textContent).toContain('Batch 2 was cut short.');
        expect(document.querySelectorAll('[data-rr-entry]')).toHaveLength(2);
    });
});
