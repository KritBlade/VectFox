/**
 * ============================================================================
 * AUTO-REFORMAT REVIEW
 * ============================================================================
 * The review of Auto-Reformat's entries before anything is stored, in its own
 * dialog over Vectorize Content (reformat-review-markup.js draws it, reformat-
 * review-core.js holds its rules). It runs before any collection exists, so it
 * only collects the user's decisions: Accept hands the kept, edited entries to
 * Vectorize Content, which freezes them; Chunk by strategy and closing drop the
 * draft; Run again asks for a new one. Leaving a draft with edits asks first.
 * ============================================================================
 */

import { closePanelPopup, confirmPopup, openPanelPopup } from '../../sillytavern/popup.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import { acceptedEntries, entryFromForm, isEntryEdited } from './reformat-review-core.js';
import { REVIEW_IDS, entryFieldId, reformatReviewMarkup } from './reformat-review-markup.js';

const FORM_FIELDS = ['entry_type', 'name', 'aliases', 'affiliation', 'traits', 'relationships', 'keywords', 'body'];

/**
 * Open the review of Auto-Reformat's entries. Resolves once the dialog is open.
 *
 * @param {object} params
 * @param {object[]} params.chunks - Validated records from reformatDocument(), each with entry_type, name, aliases,
 *   affiliation, traits, relationships, keywords and body, and _nameGrounded/_ungroundedAliases from its guard
 * @param {string[]} [params.warnings] - The run's warnings: truncation, failed batches
 * @param {string} [params.sourceText] - The source as Auto-Reformat read it
 * @param {string} [params.sourceName]
 * @param {string} [params.contentType] - The content type's name, for the header
 * @param {(acceptedRecords: object[]) => void} params.onAccept - The kept entries, edited, not yet split for size
 * @param {() => void} params.onDiscard - The draft was dropped: chunk by strategy
 * @param {() => void} params.onRerun - Make a new draft
 */
export function openReformatReview({ chunks, warnings = [], sourceText = '', sourceName = '', contentType = '', onAccept, onDiscard, onRerun }) {
    const records = (chunks || []).map((chunk, index) => ({ ...chunk, _id: index, _accepted: true }));
    const template = document.createElement('template');
    template.innerHTML = reformatReviewMarkup({ sourceName, contentType, sourceText, warnings, records });
    const root = template.content.firstElementChild;
    root.querySelector(`#${REVIEW_IDS.source}`).readOnly = true;
    const review = { root, records, leaving: null };
    bindGeneBehaviours(root);
    bindReview(review, { onAccept, onDiscard, onRerun });

    void openPanelPopup(root, { canClose: () => (review.leaving ? true : confirmLosingEdits(review)) }).then(() => {
        // Closing without one of the three ways out drops the draft, as Chunk by strategy does.
        (review.leaving ?? onDiscard)?.();
    });
}

/** An entry's form as it stands. */
function formOf(root, id) {
    const form = {};
    for (const name of FORM_FIELDS) form[name] = root.querySelector(`#${entryFieldId(id, name)}`)?.value ?? '';
    form.isKept = root.querySelector(`[data-rr-keep="${id}"]`)?.checked ?? true;
    return form;
}

const isAnyEntryEdited = review => review.records.some(record => isEntryEdited(record, formOf(review.root, record._id)));

/** Whether the draft may be left: yes with no edits, else when the user lets the edits go. */
async function confirmLosingEdits(review) {
    if (!isAnyEntryEdited(review)) return true;
    return Boolean(await confirmPopup([
        { text: 'Leave this review without accepting?' },
        { text: 'Lost: the edits made to its entries.' },
        { text: 'Leave drops the draft. Cancel goes back to it.' },
    ], { okButton: 'Leave', isDestructive: true }));
}

/** Close the review the way the user chose, after asking when edits would be lost. */
async function leaveReview(review, then) {
    if (!(await confirmLosingEdits(review))) return;
    review.leaving = then;
    await closePanelPopup(review.root);
}

function accept(review, onAccept) {
    const entries = review.records.map(record => entryFromForm(record, formOf(review.root, record._id)));
    const { kept, problem } = acceptedEntries(entries);
    const state = review.root.querySelector('[data-rr-state]');
    if (problem) {
        state.textContent = problem;
        return;
    }
    review.leaving = () => onAccept?.(kept);
    void closePanelPopup(review.root);
}

/** Mark an entry edited, and keep its card's name on its Name box. */
function refreshEntry(review, id) {
    const record = review.records.find(each => each._id === id);
    const form = formOf(review.root, id);
    // The pill is hidden as the DNA hides it, by display; written only when it changes, as each write costs a style pass.
    const editedPill = review.root.querySelector(`[data-rr-edited="${id}"]`);
    const display = isEntryEdited(record, form) ? '' : 'none';
    if (editedPill.style.display !== display) editedPill.style.display = display;
    review.root.querySelector(`[data-rr-name="${id}"]`).textContent = form.name.trim() || 'No name';
    review.root.querySelector('[data-rr-state]').textContent = '';
}

function bindReview(review, { onAccept, onDiscard, onRerun }) {
    const { root } = review;
    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-rr-action]');
        if (!button) return;
        const name = button.dataset.rrAction;
        if (name === 'accept') accept(review, onAccept);
        if (name === 'discard') void leaveReview(review, () => onDiscard?.());
        if (name === 'rerun') void leaveReview(review, () => onRerun?.());
    });
    const onEdit = (event) => {
        const entry = event.target.closest('[data-rr-entry]');
        if (entry) refreshEntry(review, Number(entry.dataset.rrEntry));
    };
    root.addEventListener('input', onEdit);
    root.addEventListener('change', onEdit);
}
