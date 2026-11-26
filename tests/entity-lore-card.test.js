/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's Entity-Lore card (src/features/settings-panel/entity-lore-card.js, §3 of
 * InternalProject/Vectfox/plans/entity-lore.md), with Entity-Lore's rules and rows as they are and its run, LoreBase and
 * SillyTavern mocked as they behave.
 *
 * Guards that:
 *   - the switch shows as saved, disabled while StoryArc or LoreBase keeps it off, free while it is on, with the notice;
 *     turning it on saves it and asks Run now's question, saying nothing when nothing is due,
 *   - the characters are read only while the card is shown, again as its tab opens, and drawn with the book line,
 *     searched by name and paged,
 *   - each row's button does what its state offers: Write now and Rewrite now write that entry, Rewrite anyway asks
 *     first, Allow again forgets the name, Open entry opens LoreBase's editor, each reading the characters again,
 *   - the notice's button opens the StoryArc page or the Main tab,
 *   - the status line says why a button did nothing, else this chat's last run, and a run's end reads the rows again.
 *
 * Names are made up and match no story.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {}, chatId: 'Harbor Tales - 2026-01-01', characters: null, lastRun: null, runEnded: null, loreBaseSwitchChanged: null,
    isYes: true, isEntrySaved: true,
}));

vi.mock('../src/sillytavern/chat.js', () => ({ getCurrentChatId: () => host.chatId }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.isYes) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/features/settings-panel/number-setting.js', () => ({ bindNumberSetting: vi.fn() }));
vi.mock('../src/features/settings-panel/panel-shell.js', () => ({ showPanelTab: vi.fn() }));
vi.mock('../src/features/eventbase/index.js', async () => {
    const entities = await import('../src/features/eventbase/story-arc-entity-core.js');
    return { filterEntities: entities.filterEntities };
});
vi.mock('../src/features/lorebase/index.js', () => ({
    editLoreBookEntry: vi.fn(async () => host.isEntrySaved),
    onLoreBaseSwitchChange: (listener) => { host.loreBaseSwitchChanged = listener; },
}));
vi.mock('../src/features/entity-lore/index.js', async () => {
    const core = await import('../src/features/entity-lore/entity-lore-core.js');
    const ui = await import('../src/features/entity-lore/entity-lore-ui.js');
    return {
        ...core,
        ...ui,
        allowEntityLoreAgain: vi.fn(() => ({ problem: null })),
        entityLoreBlocker: settings => core.entityLoreBlocker({
            loreBaseReason: settings.lorebase_enabled ? null : 'Use LoreBase is off.',
            isLoreBaseSwitchedOn: settings.lorebase_enabled === true,
            isStoryArcActive: settings.story_arc_mode_enabled === true,
            modelProblem: null,
        }),
        lastEntityLoreRun: () => host.lastRun,
        onEntityLoreRunEnded: (listener) => { host.runEnded = listener; },
        readEntityLoreCharacters: vi.fn(async () => host.characters),
        runEntityLoreNow: vi.fn(async () => ({ problem: 'No entry is due now.', isNothingDue: true })),
        writeEntityLoreEntryNow: vi.fn(async () => ({ problem: null })),
    };
});

const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { showPanelTab } = await import('../src/features/settings-panel/panel-shell.js');
const { editLoreBookEntry } = await import('../src/features/lorebase/index.js');
const { allowEntityLoreAgain, readEntityLoreCharacters, runEntityLoreNow, writeEntityLoreEntryNow } = await import('../src/features/entity-lore/index.js');
const { ENTITY_LORE_ELEMENT_ID, WORLDINFO_TAB, WORLDINFO_TABS_ID, worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { showSubTab } = await import('../src/shared/gui-dna/gene-behaviours.js');
const { bindEntityLoreCard, refreshEntityLoreCard } = await import('../src/features/settings-panel/entity-lore-card.js');

const BOOK = 'VectFox NPCs - Harbor Tales - 2026-01-01';
const elementOf = id => document.getElementById(id);
const toggle = () => elementOf(ENTITY_LORE_ELEMENT_ID.enabled);
const noticeText = () => elementOf(ENTITY_LORE_ELEMENT_ID.notice).textContent;
const status = () => elementOf(ENTITY_LORE_ELEMENT_ID.status);
const rowNames = () => [...document.querySelectorAll(`#${ENTITY_LORE_ELEMENT_ID.list} .vfx-row-name`)].map(name => name.textContent);
const buttonFor = (name, text) => [...document.querySelectorAll(`#${ENTITY_LORE_ELEMENT_ID.list} button`)]
    .find(button => button.dataset.name === name && (button.textContent || button.title) === text);
const showCard = () => {
    elementOf(ENTITY_LORE_ELEMENT_ID.card).getClientRects = () => [{ width: 1, height: 1 }];
};
const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });
const character = (name, state, extra = {}) => ({ name, otherNames: [], eventCount: 12, state, ...extra });

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    Object.assign(host, {
        settings: { entity_lore_enabled: false, story_arc_mode_enabled: true, lorebase_enabled: true },
        chatId: 'Harbor Tales - 2026-01-01',
        characters: {
            chatId: 'Harbor Tales - 2026-01-01', bookName: BOOK, isBookMade: true, isBookInChat: true,
            states: [
                character('Tamsin', 'due'), character('Hollis', 'written', { uid: '2', writtenAtEvents: 12 }),
                character('Brannoc', 'edited_by_user', { uid: '3', writtenAtEvents: 10 }), character('the ferryman', 'not_named'),
            ],
        },
        lastRun: null, isYes: true, isEntrySaved: true,
    });
    bindEntityLoreCard(host.settings);
});

describe('the switch and the notice', () => {
    it('shows the switch as saved, disabled while StoryArc or LoreBase keeps it off, free while on, with the notice', () => {
        expect(toggle().checked).toBe(false);
        expect(toggle().disabled).toBe(false);
        expect(noticeText()).toBe('');

        host.settings.story_arc_mode_enabled = false;
        refreshEntityLoreCard();
        expect(toggle().disabled).toBe(true);
        expect(noticeText()).toBe('Turn on StoryArc mode first. Entity-Lore counts characters in its events.Open StoryArc');

        host.settings.entity_lore_enabled = true;
        refreshEntityLoreCard();
        expect(toggle().disabled).toBe(false);
        expect(noticeText()).toBe('Entity-Lore is paused: StoryArc mode is off.Open StoryArc');
    });

    it('draws the switch again as LoreBase is switched', () => {
        host.settings.lorebase_enabled = false;
        host.loreBaseSwitchChanged();
        expect(toggle().disabled).toBe(true);
        expect(noticeText()).toBe("Turn on Use LoreBase on the Main tab first. Entity-Lore's entries go through LoreBase.Open Main");
    });

    it("saves the switch, and turned on asks Run now's question, saying nothing when nothing is due", async () => {
        toggle().checked = true;
        toggle().dispatchEvent(new Event('change'));
        await settle();
        expect(host.settings.entity_lore_enabled).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect(runEntityLoreNow).toHaveBeenCalledTimes(1);
        expect(status().hidden).toBe(true);

        toggle().checked = false;
        toggle().dispatchEvent(new Event('change'));
        await settle();
        expect(host.settings.entity_lore_enabled).toBe(false);
        expect(runEntityLoreNow).toHaveBeenCalledTimes(1);
    });

    it("opens the StoryArc page or the Main tab from the notice's button", () => {
        host.settings.story_arc_mode_enabled = false;
        refreshEntityLoreCard();
        elementOf(ENTITY_LORE_ELEMENT_ID.notice).querySelector('button').click();
        expect(showPanelTab).toHaveBeenCalledWith('storyarc');

        const gene = document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`);
        showSubTab(gene, WORLDINFO_TAB.entityLore);
        host.settings = Object.assign(host.settings, { story_arc_mode_enabled: true, lorebase_enabled: false });
        refreshEntityLoreCard();
        elementOf(ENTITY_LORE_ELEMENT_ID.notice).querySelector('button').click();
        expect(gene.querySelector(`[data-vfx-subtab-panel="${WORLDINFO_TAB.main}"]`).hidden).toBe(false);
    });
});

describe('the characters', () => {
    it('are read only while the card is shown, and again as its tab opens', async () => {
        refreshEntityLoreCard();
        expect(readEntityLoreCharacters).not.toHaveBeenCalled();
        showCard();
        showSubTab(document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`), WORLDINFO_TAB.entityLore);
        await settle();
        expect(readEntityLoreCharacters).toHaveBeenCalledTimes(1);
        expect(rowNames()).toEqual(['Tamsin', 'Hollis', 'Brannoc', 'the ferryman']);
        expect(elementOf(ENTITY_LORE_ELEMENT_ID.book).hidden).toBe(false);
        expect(elementOf(ENTITY_LORE_ELEMENT_ID.book).textContent).toBe(`Writes into ${BOOK}, added to this chat.`);
    });

    it('are searched by name and paged', async () => {
        host.characters.states = Array.from({ length: 25 }, (_, index) => character(`Hand ${index + 1}`, 'waiting', { writeAt: 30 }));
        showCard();
        refreshEntityLoreCard();
        await settle();
        expect(rowNames()).toHaveLength(20);
        elementOf(ENTITY_LORE_ELEMENT_ID.pager).querySelector('[data-entity-lore-action="page-next"]').click();
        await settle();
        expect(rowNames()).toEqual(['Hand 21', 'Hand 22', 'Hand 23', 'Hand 24', 'Hand 25']);
        const search = elementOf(ENTITY_LORE_ELEMENT_ID.search);
        search.value = 'hand 1';
        search.dispatchEvent(new Event('input'));
        expect(rowNames()).toEqual(['Hand 1', ...Array.from({ length: 10 }, (_, index) => `Hand ${index + 10}`)]);
    });

    it("say why they could not be read, with no book line", async () => {
        host.characters = { problem: 'This chat has no stored events yet.' };
        showCard();
        refreshEntityLoreCard();
        await settle();
        expect(elementOf(ENTITY_LORE_ELEMENT_ID.list).textContent).toBe('This chat has no stored events yet.');
        expect(elementOf(ENTITY_LORE_ELEMENT_ID.book).hidden).toBe(true);
    });
});

describe("a row's buttons", () => {
    beforeEach(async () => {
        showCard();
        refreshEntityLoreCard();
        await settle();
        readEntityLoreCharacters.mockClear();
    });

    it("write that character's entry: Write now and Rewrite now at once, Rewrite anyway once the user says yes", async () => {
        buttonFor('Tamsin', 'Write now').click();
        buttonFor('Hollis', 'Rewrite now').click();
        await settle();
        expect(writeEntityLoreEntryNow.mock.calls).toEqual([['Tamsin'], ['Hollis']]);

        host.isYes = false;
        buttonFor('Brannoc', 'Rewrite anyway').click();
        await settle();
        expect(confirmPopup.mock.calls[0][0][1]).toEqual({ name: 'Brannoc' });
        expect(writeEntityLoreEntryNow).toHaveBeenCalledTimes(2);
        host.isYes = true;
        buttonFor('Brannoc', 'Rewrite anyway').click();
        await settle();
        expect(writeEntityLoreEntryNow).toHaveBeenLastCalledWith('Brannoc');
    });

    it("forget a name on Allow again and open an entry in LoreBase's editor, each reading the rows again", async () => {
        buttonFor('the ferryman', 'Allow again').click();
        await settle();
        expect(allowEntityLoreAgain).toHaveBeenCalledWith('the ferryman');
        expect(readEntityLoreCharacters).toHaveBeenCalledTimes(1);

        buttonFor('Hollis', 'Open entry').click();
        await settle();
        expect(editLoreBookEntry).toHaveBeenCalledWith(BOOK, '2');
        expect(readEntityLoreCharacters).toHaveBeenCalledTimes(2);
        host.isEntrySaved = false;
        buttonFor('Hollis', 'Open entry').click();
        await settle();
        expect(readEntityLoreCharacters).toHaveBeenCalledTimes(2);
    });
});

describe('the status line', () => {
    it("says why a button did nothing, else this chat's last run, and reads the rows again as a run ends", async () => {
        host.lastRun = { chatId: 'Another Chat', text: '2 entries written', isClean: true };
        refreshEntityLoreCard();
        expect(status().hidden).toBe(true);

        host.lastRun = { chatId: host.chatId, text: '2 entries written', isClean: true };
        refreshEntityLoreCard();
        expect(status().textContent).toBe('Last run: 2 entries written.');

        runEntityLoreNow.mockResolvedValueOnce({ problem: 'Entity-Lore is writing already; the progress panel shows it.' });
        elementOf(ENTITY_LORE_ELEMENT_ID.runNow).click();
        await settle();
        expect(status().textContent).toBe('Entity-Lore is writing already; the progress panel shows it.');

        showCard();
        host.lastRun = { chatId: host.chatId, text: '1 entry written, 1 failed (see the console)', isClean: false };
        host.runEnded();
        await settle();
        expect(status().textContent).toBe('Last run: 1 entry written, 1 failed (see the console).');
        expect(readEntityLoreCharacters).toHaveBeenCalled();
    });
});
