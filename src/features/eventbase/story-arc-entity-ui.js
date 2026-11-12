/**
 * ============================================================================
 * STORY ARC ENTITY TAB, ROWS
 * ============================================================================
 * The Entity tab's list, as markup from the gene builders: a page of rows, one per
 * entity, with the Merge or Split panel under the row that opened it, as the
 * mvu-helper Roster draws them. A row's buttons carry data-entity-action and the
 * entity's name. Hidden names have a list of their own, where each row can be shown
 * again. Pure: builds strings.
 * ============================================================================
 */

import { button, controlRow, emptyState, field, hint, iconButton, listRow, notice, pager, recordCard, select, selectOption, statusPill } from '../../shared/gui-dna/gui-dna-core.js';
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

function entityRow(row, kind, isShowingHidden) {
    const forName = action => ({ 'entity-action': action, name: row.name });
    const actions = isShowingHidden
        ? [button({ text: 'Show again', icon: 'fa-eye', data: forName('unhide') })]
        : [
            iconButton({ icon: 'fa-code-merge', title: 'Merge into another name', data: forName('merge') }),
            ...(row.otherNames.length ? [iconButton({ icon: 'fa-code-branch', title: 'Split a name off', data: forName('split') })] : []),
            iconButton({ icon: 'fa-eye-slash', title: 'Hide this name from the list', data: forName('hide') }),
        ];
    return listRow({
        icon: ICON_BY_KIND[kind],
        name: row.name,
        sub: row.otherNames.length ? { text: 'Also known as', name: row.otherNames.join(' · ') } : null,
        pills: [statusPill({ name: `${row.eventCount} ${row.eventCount === 1 ? 'event' : 'events'}`, status: row.otherNames.length ? 'accent' : 'neutral' })],
        actions,
    });
}

/**
 * The button that opens the list of hidden names and goes back from it: none while this kind hides no name.
 *
 * @param {object} params
 * @param {boolean} params.isShowingHidden - Whether the list shows the hidden names
 * @param {boolean} params.hasHiddenNames - Whether this kind hides any name
 * @returns {string}
 */
export function hiddenNamesButton({ isShowingHidden, hasHiddenNames }) {
    if (!hasHiddenNames) return '';
    return isShowingHidden
        ? button({ text: 'Back to names', icon: 'fa-arrow-left', data: { 'entity-action': 'toggle-hidden' } })
        : button({ text: 'Show hidden', icon: 'fa-eye', data: { 'entity-action': 'toggle-hidden' } });
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
 * @param {string[]} params.nameChoices - The names of the kind shown, all of them whatever the search, which the
 *        Merge panel offers as the name to keep; any other name can still be typed
 * @param {boolean} [params.isShowingHidden] - The rows are hidden names, each with Show again and no panel
 * @returns {{list: string, pagerMarkup: string, pageIndex: number}} pageIndex is within the pages there are
 */
export function entityListMarkup({ rows, kind, pageIndex, mergingName, splittingName, nameChoices, isShowingHidden = false }) {
    const hiddenNotice = isShowingHidden
        ? notice({ status: 'info', text: 'Hidden names. StoryArc still reads them in every search. Show again puts a name back on the list.' })
        : '';
    if (!rows.length) return { list: hiddenNotice + emptyState({ icon: 'fa-user-slash', text: 'No names here.' }), pagerMarkup: '', pageIndex: 0 };
    const pageCount = Math.ceil(rows.length / ENTITY_ROWS_PER_PAGE);
    const shownPage = Math.min(pageIndex, pageCount - 1);
    const list = rows
        .slice(shownPage * ENTITY_ROWS_PER_PAGE, (shownPage + 1) * ENTITY_ROWS_PER_PAGE)
        .map((row) => {
            if (isShowingHidden) return entityRow(row, kind, true);
            const panel = row.name === mergingName ? mergePanel(row, nameChoices) : row.name === splittingName ? splitPanel(row) : '';
            return entityRow(row, kind, false) + panel;
        })
        .join('');
    const pagerMarkup = pageCount > 1
        ? pager({ page: shownPage, pageCount, previousData: { 'entity-action': 'page-previous' }, nextData: { 'entity-action': 'page-next' } })
        : '';
    return { list: hiddenNotice + list, pagerMarkup, pageIndex: shownPage };
}
