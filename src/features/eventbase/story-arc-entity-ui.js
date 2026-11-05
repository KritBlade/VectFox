/**
 * ============================================================================
 * STORY ARC ENTITY TAB, ROWS
 * ============================================================================
 * The Entity tab's list, as markup from the gene builders: a page of rows, one per
 * entity, with the Merge or Split panel under the row that opened it, as the
 * mvu-helper Roster draws them. A row's buttons carry data-entity-action and the
 * entity's name. Pure: builds strings.
 * ============================================================================
 */

import { button, controlRow, emptyState, field, hint, iconButton, listRow, pager, recordCard, select, selectOption, statusPill } from '../../shared/gui-dna/gui-dna-core.js';
import { escapeHtmlAttribute } from '../../shared/html-escape.js';

export const ENTITY_ROWS_PER_PAGE = 20;
export const ENTITY_MERGE_TARGET_ID = 'VectFox_story_arc_entity_merge_target';
export const ENTITY_SPLIT_NAME_ID = 'VectFox_story_arc_entity_split_name';
const ENTITY_NAME_CHOICES_ID = 'VectFox_story_arc_entity_names';

const ICON_BY_KIND = { people: 'fa-user', factions: 'fa-flag', places: 'fa-location-dot' };

/** A dropdown of the other names that can also be typed into, since a name can live only inside longer tags. */
function mergeTargetInput(choices) {
    const options = choices.map(name => `<option value="${escapeHtmlAttribute(name)}"></option>`).join('');
    return `<input type="text" id="${ENTITY_MERGE_TARGET_ID}" class="vfx-input" list="${ENTITY_NAME_CHOICES_ID}" placeholder="Name to keep" title="Name to keep"><datalist id="${ENTITY_NAME_CHOICES_ID}">${options}</datalist>`;
}

function mergePanel(row, nameChoices) {
    return recordCard({
        icon: 'fa-code-merge',
        text: 'Merge into another name',
        body: field([
            controlRow([
                mergeTargetInput(nameChoices.filter(name => name !== row.name)),
                button({ text: 'Merge', icon: 'fa-code-merge', kind: 'primary', data: { 'entity-action': 'merge-confirm', name: row.name } }),
                button({ text: 'Cancel', data: { 'entity-action': 'close-panel' } }),
            ]),
            hint({ text: 'Pick or type the name to keep. This name then reads as that one.' }),
        ]),
    });
}

function splitPanel(row) {
    return recordCard({
        icon: 'fa-code-branch',
        text: 'Split a name off',
        body: field([
            controlRow([
                select({ id: ENTITY_SPLIT_NAME_ID, title: 'Name to split off', options: row.otherNames.map(name => selectOption({ value: name, name })) }),
                button({ text: 'Split', icon: 'fa-code-branch', kind: 'primary', data: { 'entity-action': 'split-confirm', name: row.name } }),
                button({ text: 'Cancel', data: { 'entity-action': 'close-panel' } }),
            ]),
            hint({ text: 'That name goes back to being its own entity.' }),
        ]),
    });
}

function entityRow(row, kind) {
    const forName = action => ({ 'entity-action': action, name: row.name });
    return listRow({
        icon: ICON_BY_KIND[kind],
        name: row.name,
        sub: row.otherNames.length ? { text: 'Also known as', name: row.otherNames.join(' · ') } : null,
        pills: [statusPill({ name: `${row.eventCount} ${row.eventCount === 1 ? 'event' : 'events'}`, status: row.otherNames.length ? 'accent' : 'neutral' })],
        actions: [
            iconButton({ icon: 'fa-code-merge', title: 'Merge into another name', data: forName('merge') }),
            ...(row.otherNames.length ? [iconButton({ icon: 'fa-code-branch', title: 'Split a name off', data: forName('split') })] : []),
        ],
    });
}

/**
 * The list's markup for one page of rows.
 *
 * @param {object} params
 * @param {{name: string, otherNames: string[], eventCount: number}[]} params.rows - After any search
 * @param {string} params.kind - people, factions or places
 * @param {number} params.pageIndex
 * @param {string|null} params.mergingName - The row whose Merge panel is open
 * @param {string|null} params.splittingName - The row whose Split panel is open
 * @param {string[]} params.nameChoices - Every name a merge can target
 * @returns {{list: string, pagerMarkup: string, pageIndex: number}} pageIndex is within the pages there are
 */
export function entityListMarkup({ rows, kind, pageIndex, mergingName, splittingName, nameChoices }) {
    if (!rows.length) return { list: emptyState({ icon: 'fa-user-slash', text: 'No names here.' }), pagerMarkup: '', pageIndex: 0 };
    const pageCount = Math.ceil(rows.length / ENTITY_ROWS_PER_PAGE);
    const shownPage = Math.min(pageIndex, pageCount - 1);
    const list = rows
        .slice(shownPage * ENTITY_ROWS_PER_PAGE, (shownPage + 1) * ENTITY_ROWS_PER_PAGE)
        .map((row) => {
            const panel = row.name === mergingName ? mergePanel(row, nameChoices) : row.name === splittingName ? splitPanel(row) : '';
            return entityRow(row, kind) + panel;
        })
        .join('');
    const pagerMarkup = pageCount > 1
        ? pager({ page: shownPage, pageCount, previousData: { 'entity-action': 'page-previous' }, nextData: { 'entity-action': 'page-next' } })
        : '';
    return { list, pagerMarkup, pageIndex: shownPage };
}
