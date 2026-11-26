/**
 * ============================================================================
 * ENTITY-LORE, THE CARD'S CONTENT
 * ============================================================================
 * What the WorldInfo page's Entity-Lore card draws from a reading of the open
 * chat (InternalProject/Vectfox/plans/entity-lore.md §3): the notice naming
 * what keeps Entity-Lore from running, with the button to where it is fixed;
 * the line naming the chat's book; the last run's line; and the character
 * list, a page of rows, each with its event count, its state and the buttons
 * that state offers. A button carries data-entity-lore-action, and a row's its
 * character's name and entry uid. Pure: builds strings.
 * ============================================================================
 */

import { button, emptyState, iconButton, listRow, notice, pager, statusPill } from '../../shared/gui-dna/gui-dna-core.js';
import { ENTITY_LORE_FIX_AT, ENTITY_LORE_NEED, ENTITY_STATE, EXCLUSION } from './entity-lore-core.js';

export const ENTITY_LORE_ROWS_PER_PAGE = 20;
/** What a button of the card does, as its data-entity-lore-action says. */
export const ENTITY_LORE_ACTION = Object.freeze({
    write: 'write',
    rewriteAnyway: 'rewrite-anyway',
    openEntry: 'open-entry',
    allowAgain: 'allow-again',
    previousPage: 'page-previous',
    nextPage: 'page-next',
    fix: 'fix',
});

const eventsText = count => `${count} ${count === 1 ? 'event' : 'events'}`;

const FIX_BUTTONS = {
    [ENTITY_LORE_FIX_AT.storyArcPage]: { text: 'Open StoryArc', icon: 'fa-timeline' },
    [ENTITY_LORE_FIX_AT.worldInfoMain]: { text: 'Open Main', icon: 'fa-sliders' },
};

/**
 * Whether what keeps Entity-Lore from running disables its switch while it is off (§3): StoryArc mode, or LoreBase,
 * not acting. LoreBase's model not set leaves the switch free, as the notice says what to set.
 * @param {{need: string}|null} blocker - From entityLoreBlocker
 * @returns {boolean}
 */
export function isSwitchGatedBy(blocker) {
    return Boolean(blocker) && blocker.need !== ENTITY_LORE_NEED.loreBaseModel;
}

/**
 * The notice over the card's settings (§3): with Entity-Lore off, what to turn on first; on, that it is paused and
 * why. Each with the button to where it is fixed, when one place of the panel fixes it. Nothing while nothing keeps it.
 * @param {{blocker: {reason: string, fix: string, fixAt: string|null}|null, isOn: boolean}} standing - blocker from
 *   entityLoreBlocker, isOn from isEntityLoreOn
 * @returns {string}
 */
export function entityLoreNoticeMarkup({ blocker, isOn }) {
    if (!blocker) return '';
    const fixButton = FIX_BUTTONS[blocker.fixAt];
    const action = fixButton ? button({ ...fixButton, data: { 'entity-lore-action': ENTITY_LORE_ACTION.fix, 'fix-at': blocker.fixAt } }) : '';
    return isOn
        ? notice({ status: 'warning', text: 'Entity-Lore is paused', name: blocker.reason, action })
        : notice({ status: 'info', name: blocker.fix, action });
}

/**
 * The line naming the chat's book (§3): the book it writes into, added to this chat; before the first entry, the book
 * that entry makes; and a book the user unlinked from the chat, which the next entry adds again.
 * @param {{bookName: string, isBookMade: boolean, isBookInChat: boolean}} book - From readEntityLoreCharacters
 * @returns {string}
 */
export function entityLoreBookLine({ bookName, isBookMade, isBookInChat }) {
    if (!isBookMade) return `The first entry creates ${bookName} and adds it to this chat.`;
    if (!isBookInChat) return `Writes into ${bookName}, which the next entry adds to this chat again.`;
    return `Writes into ${bookName}, added to this chat.`;
}

/**
 * The status line after a run (§3), as the progress panel ended on it.
 * @param {{text: string}} run - From lastEntityLoreRun
 * @returns {string}
 */
export function entityLoreLastRunText(run) {
    return `Last run: ${run.text}.`;
}

const EXCLUSION_TEXTS = {
    [EXCLUSION.chatCharacter]: "This chat's character",
    [EXCLUSION.persona]: 'Your persona',
    [EXCLUSION.lorebook]: 'Already in a lorebook',
    [EXCLUSION.cardDescription]: 'In the character card',
};

// Each state's pill (§3's table).
const STATE_PILLS = {
    [ENTITY_STATE.waiting]: row => ({ name: `Waiting, ${row.eventCount} of ${eventsText(row.writeAt)}`, icon: 'fa-hourglass-half' }),
    [ENTITY_STATE.due]: () => ({ text: 'Due', icon: 'fa-pen-nib', status: 'accent' }),
    [ENTITY_STATE.written]: row => ({ name: `Written at ${eventsText(row.writtenAtEvents)}`, icon: 'fa-check', status: 'success' }),
    [ENTITY_STATE.rewriteDue]: () => ({ text: 'Rewrite due', icon: 'fa-rotate', status: 'accent' }),
    [ENTITY_STATE.editedByUser]: () => ({ text: 'Edited by you', icon: 'fa-user-pen', status: 'warning' }),
    [ENTITY_STATE.deletedByUser]: () => ({ text: 'Deleted by you', icon: 'fa-trash-can' }),
    [ENTITY_STATE.notNamed]: () => ({ text: 'Not a named character', icon: 'fa-user-slash' }),
    [ENTITY_STATE.sameAs]: row => ({ name: `Same as ${row.sameAs}`, icon: 'fa-link' }),
    [ENTITY_STATE.excluded]: row => ({ text: EXCLUSION_TEXTS[row.exclusion], icon: 'fa-ban' }),
};

const actionData = (row, action) => ({ 'entity-lore-action': action, name: row.name, uid: row.uid });
const openEntryButton = row => iconButton({ icon: 'fa-pen-to-square', title: 'Open entry', data: actionData(row, ENTITY_LORE_ACTION.openEntry) });
const rewriteNowButtons = row => [
    openEntryButton(row),
    button({ text: 'Rewrite now', icon: 'fa-rotate', data: actionData(row, ENTITY_LORE_ACTION.write) }),
];
const allowAgainButton = row => [button({ text: 'Allow again', icon: 'fa-rotate-left', data: actionData(row, ENTITY_LORE_ACTION.allowAgain) })];

// Each state's buttons (§3's table); a state with none is left out.
const STATE_ACTIONS = {
    [ENTITY_STATE.due]: row => [button({ text: 'Write now', icon: 'fa-pen-nib', data: actionData(row, ENTITY_LORE_ACTION.write) })],
    [ENTITY_STATE.written]: rewriteNowButtons,
    [ENTITY_STATE.rewriteDue]: rewriteNowButtons,
    [ENTITY_STATE.editedByUser]: row => [
        openEntryButton(row),
        button({ text: 'Rewrite anyway', icon: 'fa-rotate', data: actionData(row, ENTITY_LORE_ACTION.rewriteAnyway) }),
    ],
    [ENTITY_STATE.deletedByUser]: allowAgainButton,
    [ENTITY_STATE.notNamed]: allowAgainButton,
    [ENTITY_STATE.sameAs]: allowAgainButton,
};

function characterRow(row) {
    const sub = [
        row.otherNames.length ? { text: 'Also known as', name: row.otherNames.join(' · ') } : null,
        row.state === ENTITY_STATE.sameAs ? { text: "To count the two as one, merge their names on StoryArc's Entity tab." } : null,
    ].filter(Boolean);
    return listRow({
        icon: 'fa-user',
        name: row.name,
        sub,
        pills: [statusPill({ name: eventsText(row.eventCount) }), statusPill(STATE_PILLS[row.state](row))],
        actions: STATE_ACTIONS[row.state]?.(row) ?? [],
    });
}

/**
 * The character list's page of rows (§3): each person StoryArc counts, the most events first as listEntities orders
 * them, with the count, the state's pill and the state's buttons; the pager when there is more than one page. An empty
 * state when no row is left, for the search or for the chat.
 * @param {{rows: object[], pageIndex: number, isSearching: boolean}} list - rows from readEntityLoreCharacters, after any search
 * @returns {{list: string, pagerMarkup: string, pageIndex: number}} pageIndex is within the pages there are
 */
export function entityLoreListMarkup({ rows, pageIndex, isSearching }) {
    if (!rows.length) {
        const text = isSearching ? 'No name matches the search.' : 'StoryArc counts no person in this chat yet.';
        return { list: emptyState({ icon: 'fa-user-slash', text }), pagerMarkup: '', pageIndex: 0 };
    }
    const pageCount = Math.ceil(rows.length / ENTITY_LORE_ROWS_PER_PAGE);
    const shownPage = Math.min(Math.max(pageIndex, 0), pageCount - 1);
    const list = rows.slice(shownPage * ENTITY_LORE_ROWS_PER_PAGE, (shownPage + 1) * ENTITY_LORE_ROWS_PER_PAGE).map(characterRow).join('');
    const pagerMarkup = pageCount > 1
        ? pager({
            page: shownPage, pageCount,
            previousData: { 'entity-lore-action': ENTITY_LORE_ACTION.previousPage }, nextData: { 'entity-lore-action': ENTITY_LORE_ACTION.nextPage },
        })
        : '';
    return { list, pagerMarkup, pageIndex: shownPage };
}

/**
 * What the list shows when the chat's characters could not be read: why, as readEntityLoreCharacters says it.
 * @param {string} problem
 * @returns {string}
 */
export function entityLoreProblemMarkup(problem) {
    return notice({ status: 'info', name: problem });
}
