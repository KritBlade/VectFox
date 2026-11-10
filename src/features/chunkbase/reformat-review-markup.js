/**
 * ============================================================================
 * AUTO-REFORMAT REVIEW: MARKUP
 * ============================================================================
 * The review of Auto-Reformat's entries, drawn with the GUI-DNA genes: a top
 * bar, then a split of the source text and the entries, stacked on a phone.
 * Each entry is a record card with a Keep switch and its fields. reformat-
 * review.js wires it.
 * ============================================================================
 */

import {
    button,
    controlRow,
    field,
    fieldLabel,
    grid,
    input,
    notice,
    recordCard,
    select,
    selectOption,
    stack,
    statusPill,
    switchInput,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, pageHeader } from '../../shared/gui-dna/panel-page-genes.js';
import { ENTRY_TYPES, entryFormValues, groundingWarnings } from './reformat-review-core.js';

export const REVIEW_IDS = Object.freeze({
    root: 'vectfox_reformat_review',
    split: 'vectfox_rr_split',
    source: 'vectfox_rr_source',
    entries: 'vectfox_rr_entries',
});

/** An entry's control. */
export const entryFieldId = (entryId, name) => `vectfox_rr_${entryId}_${name}`;

const ENTRY_ICONS = { character: 'fa-user', organization: 'fa-people-group', concept: 'fa-lightbulb', location: 'fa-location-dot', item: 'fa-box', other: 'fa-shapes' };

const SPLIT_DIVIDER = '<div class="vfx-split-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize the panes"></div>';

const action = name => ({ 'rr-action': name });

const textField = (entryId, name, label, value, placeholder) => field([
    fieldLabel({ text: label, forId: entryFieldId(entryId, name) }),
    input({ id: entryFieldId(entryId, name), value, placeholder, data: { 'rr-field': name } }),
]);

/**
 * One entry: a Keep switch, its type's icon and name, a pill when it was edited, the warnings that it may be
 * invented, then its fields.
 *
 * @param {object} record - From reformatDocument(), with `_id`
 * @returns {string}
 */
export function entryCardMarkup(record) {
    const id = record._id;
    const form = entryFormValues(record);
    const warnings = groundingWarnings(record);
    const typeSelect = select({ id: entryFieldId(id, 'entry_type'), options: ENTRY_TYPES.map(type => selectOption({ value: type, name: type, isSelected: type === form.entry_type })), data: { 'rr-field': 'entry_type' } });
    const body = stack([
        warnings.length ? notice({ status: 'warning', name: warnings.join(' ') }) : '',
        grid([
            field([fieldLabel({ text: 'Type', forId: entryFieldId(id, 'entry_type') }), typeSelect]),
            textField(id, 'name', 'Name', form.name),
            textField(id, 'aliases', 'Aliases', form.aliases, 'Comma-separated'),
            textField(id, 'affiliation', 'Affiliation', form.affiliation),
            textField(id, 'traits', 'Traits', form.traits, 'Comma-separated'),
            textField(id, 'relationships', 'Relationships', form.relationships, 'Comma-separated'),
            field([
                fieldLabel({ text: 'Keywords', forId: entryFieldId(id, 'keywords') }),
                input({ id: entryFieldId(id, 'keywords'), value: form.keywords, placeholder: 'Comma-separated', data: { 'rr-field': 'keywords' } }),
            ], { isSpan: true }),
            field([
                fieldLabel({ text: 'Body', forId: entryFieldId(id, 'body') }),
                textarea({ id: entryFieldId(id, 'body'), value: form.body, rows: 5 }),
            ], { isSpan: true }),
        ]),
    ]);
    return recordCard({
        icon: ENTRY_ICONS[form.entry_type] || ENTRY_ICONS.other,
        name: form.name || 'No name',
        nameData: { 'rr-name': id },
        toggle: switchInput({ title: 'Keep this entry', isChecked: form.isKept, data: { 'rr-keep': id } }),
        pills: [
            warnings.length ? statusPill({ text: 'Check', status: 'warning', icon: 'fa-triangle-exclamation' }) : '',
            statusPill({ text: 'Edited', status: 'info', isHidden: true, data: { 'rr-edited': id } }),
        ].filter(Boolean),
        body,
        data: { 'rr-entry': id },
        isCollapsible: true,
    });
}

/**
 * The review: the top bar, the page header with how many entries came from which source, the run's warnings, then
 * the split of the source and the entries, whose foot holds the three ways out.
 *
 * @param {{sourceName: string, contentType: string, sourceText: string, warnings: string[], records: object[]}} view
 * @returns {string}
 */
export function reformatReviewMarkup({ sourceName, contentType, sourceText, warnings, records }) {
    const count = statusPill({ name: `${records.length} ${records.length === 1 ? 'entry' : 'entries'}` });
    const sourcePane = `<section class="vfx-card is-pane">`
        + cardHeader({ icon: 'fa-file-lines', title: 'Source', description: 'What Auto-Reformat read, for reference.', isCollapsible: false })
        + `<div class="vfx-card-body">${textarea({ id: REVIEW_IDS.source, value: sourceText, rows: 20, title: 'Original source' })}</div>`
        + '</section>';
    const entriesPane = `<section class="vfx-card is-pane">`
        + cardHeader({ icon: 'fa-list-check', title: 'Entries', description: 'Switch off an entry to drop it; edit any field to correct it.', isCollapsible: false })
        + `<div class="vfx-card-body">${stack([
            `<div id="${REVIEW_IDS.entries}" class="vfx-stack">${records.map(entryCardMarkup).join('')}</div>`,
            controlRow([
                `<p class="vfx-hint" data-rr-state></p>`,
                button({ text: 'Chunk by strategy', icon: 'fa-rotate-left', data: action('discard') }),
                button({ text: 'Run again', icon: 'fa-arrows-rotate', data: action('rerun') }),
                button({ text: 'Accept', icon: 'fa-check', kind: 'primary', data: action('accept') }),
            ]),
        ])}</div>`
        + '</section>';
    return `<div id="${REVIEW_IDS.root}" class="vfx-ui vfx-shell is-topbar">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Review Auto-Reformat')}</div></nav>`
        + '<main class="vfx-main"><div class="vfx-page is-workbench">'
        + pageHeader({ icon: 'fa-wand-magic-sparkles', eyebrow: `Vectorize Content / ${contentType}`, title: sourceName, subtitle: 'Nothing is stored until Accept and Vectorize.', status: count })
        + (warnings.length ? notice({ status: 'warning', name: warnings.join(' ') }) : '')
        + `<div id="${REVIEW_IDS.split}" class="vfx-split">${sourcePane}${SPLIT_DIVIDER}${entriesPane}</div>`
        + '</div></main></div>';
}
