/**
 * The WorldInfo page's Entity-Lore card (InternalProject/Vectfox/plans/entity-lore.md §3), on the page's Entity-Lore
 * tab: Use Entity-Lore, which StoryArc mode and LoreBase not acting disable while it is off, and which asks Run now's
 * question as it is turned on; the notice naming what keeps Entity-Lore from running, with the button to where it is
 * fixed; Write at and Rewrite every; the line naming the chat's book; Run now; the status line, the last run's outcome
 * in this chat or why a button did nothing; and the open chat's characters, each with its state and the buttons that
 * state offers, searched by name and paged. The switch and the notice are drawn as the page opens, as LoreBase's switch
 * changes and as the chat changes; the characters are read only while the card is shown, again as its tab opens, as
 * the chat changes, as either count is set and as a run ends.
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { showSubTab } from '../../shared/gui-dna/gene-behaviours.js';
import {
    ENTITY_LORE_ACTION, ENTITY_LORE_FIX_AT, ENTITY_LORE_SETTING, allowEntityLoreAgain, entityLoreBlocker, entityLoreBookLine, entityLoreLastRunText,
    entityLoreListMarkup, entityLoreNoticeMarkup, entityLoreProblemMarkup, isEntityLoreOn, isSwitchGatedBy, lastEntityLoreRun,
    onEntityLoreRunEnded, readEntityLoreCharacters, rewriteEveryEventsOf, runEntityLoreNow, writeAtEventsOf, writeEntityLoreEntryNow,
} from '../entity-lore/index.js';
import { filterEntities } from '../eventbase/index.js';
import { editLoreBookEntry, onLoreBaseSwitchChange } from '../lorebase/index.js';
import { bindNumberSetting } from './number-setting.js';
import { showPanelTab } from './panel-shell.js';
import { ENTITY_LORE_ELEMENT_ID, WORLDINFO_TAB, WORLDINFO_TABS_ID } from './worldinfo-page-markup.js';

const LOG = '[VectFox-EntityLore]';
// The panel page that turns StoryArc mode on (panel-shell-markup.js).
const STORY_ARC_PAGE = 'storyarc';
// How long a count waits after its last change before the characters are read again, as dragging its slider changes it often.
const COUNT_READ_DELAY_MS = 600;

const card = {
    settings: null,
    // The open chat's characters as last read (readEntityLoreCharacters), or null before a reading.
    characters: null,
    // The reading under way, so an older one that ends later is not drawn.
    reading: null,
    word: '',
    pageIndex: 0,
    // Why the last button did nothing, in the chat it was pressed in, until the next run ends.
    message: null,
    countTimer: null,
};

const elementOf = id => document.getElementById(id);
const isCardShown = () => Boolean(elementOf(ENTITY_LORE_ELEMENT_ID.card)?.getClientRects().length);

/** Draw the switch and the notice from the settings as they are now. */
function paintStanding() {
    const toggle = elementOf(ENTITY_LORE_ELEMENT_ID.enabled);
    const noticeHolder = elementOf(ENTITY_LORE_ELEMENT_ID.notice);
    if (!toggle || !noticeHolder) return;
    const isOn = isEntityLoreOn(card.settings);
    const blocker = entityLoreBlocker(card.settings);
    toggle.checked = isOn;
    toggle.disabled = !isOn && isSwitchGatedBy(blocker);
    noticeHolder.innerHTML = entityLoreNoticeMarkup({ blocker, isOn });
}

/** The status line: why the last button did nothing in this chat, else this chat's last run. Hidden with neither. */
function paintStatus() {
    const status = elementOf(ENTITY_LORE_ELEMENT_ID.status);
    if (!status) return;
    const chatId = getCurrentChatId() ?? null;
    const run = lastEntityLoreRun();
    let text = '';
    if (card.message?.chatId === chatId) text = card.message.text;
    else if (run && run.chatId === chatId) text = entityLoreLastRunText(run);
    status.textContent = text;
    status.hidden = !text;
}

function showMessage(text) {
    card.message = text ? { chatId: getCurrentChatId() ?? null, text } : null;
    paintStatus();
}

/** Draw the book line and the page of characters from the last reading, after the search. */
function paintCharacters() {
    const book = elementOf(ENTITY_LORE_ELEMENT_ID.book);
    const list = elementOf(ENTITY_LORE_ELEMENT_ID.list);
    const pagerHolder = elementOf(ENTITY_LORE_ELEMENT_ID.pager);
    if (!book || !list || !pagerHolder) return;
    const { characters } = card;
    if (!characters || characters.problem) {
        book.hidden = true;
        list.innerHTML = characters ? entityLoreProblemMarkup(characters.problem) : '';
        pagerHolder.innerHTML = '';
        return;
    }
    book.textContent = entityLoreBookLine(characters);
    book.hidden = false;
    const rows = filterEntities(characters.states, card.word);
    const page = entityLoreListMarkup({ rows, pageIndex: card.pageIndex, isSearching: Boolean(card.word.trim()) });
    card.pageIndex = page.pageIndex;
    list.innerHTML = page.list;
    pagerHolder.innerHTML = page.pagerMarkup;
}

/** Read the open chat's characters, then draw them, unless a later reading started meanwhile. */
async function readCharacters() {
    const reading = {};
    card.reading = reading;
    let characters;
    try {
        characters = await readEntityLoreCharacters(card.settings);
    } catch (error) {
        log.warn(`${LOG} The card could not read this chat's characters:`, error);
        characters = { problem: "Could not read this chat's characters. See the console." };
    }
    if (card.reading !== reading) return;
    if (card.characters?.chatId !== characters.chatId) card.pageIndex = 0;
    card.characters = characters;
    paintCharacters();
}

/**
 * Draw the card for the open chat: the switch, the notice and the status line, and, while the card is shown, its
 * characters read again. Runs as the page opens, as the card's tab opens and as the chat changes.
 */
export function refreshEntityLoreCard() {
    if (!card.settings) return;
    paintStanding();
    paintStatus();
    if (isCardShown()) void readCharacters();
}

/** Run now: why nothing ran goes on the status line; a run's outcome reaches it as the run ends. */
async function runNow({ isTurningOn = false } = {}) {
    const { problem, isNothingDue } = await runEntityLoreNow();
    if (isTurningOn && isNothingDue) return;
    showMessage(problem);
}

async function turnEntityLore(isOn) {
    card.settings[ENTITY_LORE_SETTING.enabled] = isOn;
    Object.assign(extension_settings.vectfox, card.settings);
    saveSettingsDebounced();
    paintStanding();
    if (isOn) await runNow({ isTurningOn: true });
}

const REWRITE_ANYWAY_LINES = name => [
    { icon: 'fa-user-pen', text: 'Rewrite this entry anyway?' },
    { name },
    { text: 'You edited it. It is written again from the entry as you left it and from their events, in new words.' },
];

/** What one of the card's buttons does, from its data attributes. */
async function runAction({ entityLoreAction: action, name, uid, fixAt }) {
    if (action === ENTITY_LORE_ACTION.fix) {
        if (fixAt === ENTITY_LORE_FIX_AT.storyArcPage) showPanelTab(STORY_ARC_PAGE);
        if (fixAt === ENTITY_LORE_FIX_AT.worldInfoMain) showSubTab(document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`), WORLDINFO_TAB.main);
        return;
    }
    if (action === ENTITY_LORE_ACTION.previousPage || action === ENTITY_LORE_ACTION.nextPage) {
        card.pageIndex += action === ENTITY_LORE_ACTION.nextPage ? 1 : -1;
        paintCharacters();
        return;
    }
    if (action === ENTITY_LORE_ACTION.openEntry) {
        if (await editLoreBookEntry(card.characters.bookName, uid)) await readCharacters();
        return;
    }
    if (action === ENTITY_LORE_ACTION.allowAgain) {
        showMessage(allowEntityLoreAgain(name).problem);
        await readCharacters();
        return;
    }
    if (action === ENTITY_LORE_ACTION.rewriteAnyway && !await confirmPopup(REWRITE_ANYWAY_LINES(name), { okButton: 'Rewrite' })) return;
    if (action === ENTITY_LORE_ACTION.write || action === ENTITY_LORE_ACTION.rewriteAnyway) showMessage((await writeEntityLoreEntryNow(name)).problem);
}

/** Read the characters again once a count stops changing, as each state's Write at and Rewrite every come from them. */
function readAfterCountChange() {
    clearTimeout(card.countTimer);
    card.countTimer = setTimeout(() => {
        if (isCardShown()) void readCharacters();
    }, COUNT_READ_DELAY_MS);
}

/**
 * Wire the card: its switch, its two counts, Run now, its buttons, the search, the opening of its tab, LoreBase's
 * switch and each run's end. Called once, as the panel is mounted.
 * @param {object} settings - VectFox settings
 */
export function bindEntityLoreCard(settings) {
    clearTimeout(card.countTimer);
    Object.assign(card, { settings, characters: null, reading: null, word: '', pageIndex: 0, message: null, countTimer: null });
    const id = ENTITY_LORE_ELEMENT_ID;
    elementOf(id.enabled)?.addEventListener('change', (event) => {
        turnEntityLore(event.currentTarget.checked).catch(error => log.error(`${LOG} Use Entity-Lore could not be switched:`, error));
    });
    bindNumberSetting(settings, { id: id.writeAt, key: ENTITY_LORE_SETTING.writeAtEvents, initial: writeAtEventsOf(settings[ENTITY_LORE_SETTING.writeAtEvents]), isInteger: true });
    bindNumberSetting(settings, {
        id: id.rewriteEvery, key: ENTITY_LORE_SETTING.rewriteEveryEvents, initial: rewriteEveryEventsOf(settings[ENTITY_LORE_SETTING.rewriteEveryEvents]), isInteger: true,
    });
    for (const countId of [id.writeAt, id.rewriteEvery]) elementOf(countId)?.addEventListener('input', readAfterCountChange);
    elementOf(id.runNow)?.addEventListener('click', () => {
        runNow().catch(error => log.error(`${LOG} Run now failed:`, error));
    });
    elementOf(id.search)?.addEventListener('input', (event) => {
        card.word = event.currentTarget.value;
        card.pageIndex = 0;
        paintCharacters();
    });
    elementOf(id.card)?.addEventListener('click', (event) => {
        const control = event.target instanceof Element ? event.target.closest('[data-entity-lore-action]') : null;
        if (!control || control.disabled) return;
        runAction(control.dataset).catch(error => log.error(`${LOG} A button of the card failed:`, error));
    });
    document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`)?.addEventListener('vfx-subtab-change', (event) => {
        if (event.detail.tab === WORLDINFO_TAB.entityLore) refreshEntityLoreCard();
    });
    onLoreBaseSwitchChange(paintStanding);
    onEntityLoreRunEnded(() => {
        card.message = null;
        paintStatus();
        if (isCardShown()) void readCharacters();
    });
    paintStanding();
}
