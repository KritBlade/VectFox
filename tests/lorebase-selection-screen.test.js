/**
 * @vitest-environment jsdom
 *
 * LoreBase's selection screen (src/features/lorebase/lorebase-selection-screen.js, plan §5.2 of InternalProject/Vectfox/
 * plans/lorebook-semantic-overhaul-passage-index.md), driven as a user would while it is open: it opens on the chat's
 * book with the chat's books first; each row's toggle, a category's toggle and the bulk bar save the selection at
 * once; ticks follow the filters and shift-click; a row's eye button shows its entry and saves nothing; the locks and
 * the pins save; opening a book keeps its uids for the new marks and drops deleted ones from the selection.
 */
/* global document, MouseEvent -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ books: {}, worldNames: [], globalBooks: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, noticePopup: vi.fn() }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // The dialog door: the screen is on the page while it is open.
    openPanelPopup: vi.fn(root => {
        document.body.append(root);
        return new Promise(() => {});
    }),
    noticePopup: host.noticePopup,
}));
vi.mock('../src/sillytavern/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    getWorldInfoSettings: () => ({ world_info: { charLore: [] } }),
    loadWorldInfo: vi.fn(async name => host.books[name] ?? null),
    selected_world_info: host.globalBooks,
    world_names: host.worldNames,
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => host.chatId }));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getCharaFilename: () => 'keeper-orrin' }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));

const { openLoreBaseSelection } = await import('../src/features/lorebase/lorebase-selection-screen.js');

const HARBOR = {
    entries: {
        0: { uid: 0, comment: '[Harbor] Lighthouse of Vell', key: ['lighthouse'], content: '[Keepers]\nOrrin keeps the lamp.\n[Secrets]\nThe map is in the lamp room.' },
        1: { uid: 1, comment: '[Harbor] Tidewardens', key: ['tidewarden'], content: 'The tidewardens read the harbor bells.' },
        2: { uid: 2, comment: '[Harbor] Tide clock [POST]', key: ['clock'], content: 'Counts the tides.' },
        3: { uid: 3, comment: '[Harbor] Harbor Bell', key: ['bell'], content: 'The harbor bell.', constant: true },
        4: { uid: 4, comment: 'Fog Season', key: ['fog'], content: 'Fog closes the strait each spring.' },
    },
};
const $id = id => document.getElementById(id);
const rowUids = () => [...document.querySelectorAll('[data-lorebase-entry]')].map(element => element.dataset.lorebaseEntry);
const actionButton = (name, extra = '') => document.querySelector(`[data-lorebase-action="${name}"]${extra}`);
const entryToggle = uid => document.querySelector(`[data-lorebase-action="toggle-entry"][data-lorebase-uid="${uid}"]`);
const tickBox = uid => document.querySelector(`[data-lorebase-tick="${uid}"]`);
const record = (name = 'Harbor Atlas') => host.settings.vectfox.lorebase_books?.[name];
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};
const shiftClick = element => element.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

async function openScreen(options) {
    void openLoreBaseSelection(options);
    await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
}

beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('$', $);
    host.books = { 'Harbor Atlas': structuredClone(HARBOR), 'Voyage Log': { entries: { 7: { uid: 7, comment: 'Route', key: ['route'], content: 'The route north.' } } } };
    host.worldNames.splice(0, host.worldNames.length, 'Voyage Log', 'Harbor Atlas', 'Zeta Notes');
    host.globalBooks.splice(0, host.globalBooks.length);
    host.chatId = 'chat-harbor';
    host.context = { characters: { 3: { name: 'Keeper Orrin', avatar: 'keeper-orrin.png', data: { extensions: { world: 'Harbor Atlas' } } } }, characterId: '3', chatMetadata: {}, powerUserSettings: {} };
    host.settings.vectfox = {};
    host.noticePopup.mockReset();
});

describe('opening the screen', () => {
    it("opens on the chat's book, listed first, with every entry off, and keeps the uids it holds", async () => {
        await openScreen();
        expect([...$id('vectfox_lorebase_book').options].map(option => option.value)).toEqual(['Harbor Atlas', 'Voyage Log', 'Zeta Notes']);
        expect($id('vectfox_lorebase_book').options[0].textContent).toBe('Harbor Atlas (this chat)');
        expect(rowUids()).toEqual(['0', '1', '2', '3', '4']);
        expect(document.querySelectorAll('[data-lorebase-action="toggle-entry"][aria-pressed="true"]')).toHaveLength(0);
        expect([...document.querySelectorAll('[data-lorebase-entry]')].some(element => element.textContent.includes('New'))).toBe(false);
        expect(record().seenUids).toEqual(['0', '1', '2', '3', '4']);
        expect($id('vectfox_lorebase_summary').textContent).toBe("LoreBase decides no entry of this book: SillyTavern's keys decide them all.");
    });

    it('marks an entry added since the last opening as new, and drops deleted entries from the selection', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': { selectedUids: ['1', '9'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [], seenUids: ['0', '1', '2', '3'] } };
        await openScreen();
        const newRows = [...document.querySelectorAll('[data-lorebase-entry]')].filter(element => element.textContent.includes('New'));
        expect(newRows.map(element => element.dataset.lorebaseEntry)).toEqual(['4']);
        expect(record().selectedUids).toEqual(['1']);
    });
});

describe('choosing entries', () => {
    it("saves a row's toggle at once and counts what the pick reads, and never turns on an entry SillyTavern keeps", async () => {
        await openScreen();
        entryToggle('1').click();
        expect(record().selectedUids).toEqual(['1']);
        expect(entryToggle('1').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-lorebase-selected-count]').textContent).toBe('1 selected');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/^Luna reads 1 title from this book, about \d+ tokens on every pick\.$/);
        expect(entryToggle('3').disabled).toBe(true);
        expect(tickBox('3').disabled).toBe(true);
    });

    it('turns a whole category on but its engine entry, reads it in words, and turns it off again', async () => {
        await openScreen();
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        expect(record().selectedUids.sort()).toEqual(['0', '1']);
        expect($id('vectfox_lorebase_categories').textContent).toContain('All on');
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        expect(record().selectedUids).toEqual([]);
        expect($id('vectfox_lorebase_categories').textContent).not.toContain('All on');
    });

    it('acts on the ticked rows only: tick all matching skips the engine entry, shift-click ticks a range, the bar turns them on or off', async () => {
        await openScreen();
        expect(actionButton('turn-on').disabled).toBe(true);
        actionButton('tick-all').click();
        expect(['0', '1', '2', '3', '4'].filter(uid => tickBox(uid).checked)).toEqual(['0', '1', '4']);
        actionButton('untick-all').click();
        tickBox('0').click();
        shiftClick(tickBox('2'));
        expect(['0', '1', '2', '3', '4'].filter(uid => tickBox(uid).checked)).toEqual(['0', '1', '2']);
        actionButton('turn-on').click();
        expect(record().selectedUids.sort()).toEqual(['0', '1', '2']);
        tickBox('0').click();
        actionButton('turn-off').click();
        expect(record().selectedUids).toEqual(['0']);
    });

    it('filters the rows by text and category, and tick all matching ticks only the rows the filters let through', async () => {
        await openScreen();
        const search = $id('vectfox_lorebase_search');
        search.value = 'harbor bells';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(rowUids()).toEqual(['1']));
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(rowUids()).toHaveLength(5));
        actionButton('show-category', '[data-lorebase-category=""]').click();
        expect(rowUids()).toEqual(['4']);
        actionButton('tick-all').click();
        actionButton('show-all-categories').click();
        expect(['0', '1', '2', '3', '4'].filter(uid => tickBox(uid).checked)).toEqual(['4']);
    });
});

describe('showing an entry', () => {
    it('shows any entry whole and read-only, saying why bulk selection skips an engine and why SillyTavern keeps one, and saves nothing', async () => {
        await openScreen();
        const before = structuredClone(record());
        actionButton('show-entry', '[data-lorebase-uid="2"]').click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(1));
        const [engineLines, { body, isWide }] = host.noticePopup.mock.calls[0];
        expect(engineLines).toEqual([
            { icon: 'fa-file-lines', name: 'Tide clock [POST]' },
            { text: 'Category:', name: '[Harbor]' },
            { text: 'Keys:', name: 'clock' },
            { text: 'Tokens:', name: expect.stringMatching(/^\d+$/) },
            { icon: 'fa-gears', text: "Engine: its comment marks it as a game engine's entry, not lore." },
            { icon: 'fa-circle-info', text: "Tick all matching and a category's toggle skip it: turn it on with its own toggle." },
        ]);
        expect(body.value).toBe('Counts the tides.');
        expect(body.readOnly).toBe(true);
        expect(isWide).toBe(true);

        const keptButton = actionButton('show-entry', '[data-lorebase-uid="3"]');
        expect(keptButton.disabled).toBe(false);
        keptButton.click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(2));
        const [keptLines] = host.noticePopup.mock.calls[1];
        expect(keptLines).toContainEqual({ icon: 'fa-lock', text: 'Constant: SillyTavern sends it on every reply, so LoreBase cannot decide it.' });
        expect(keptLines.some(line => line.icon === 'fa-circle-info')).toBe(false);
        expect(record()).toEqual(before);
    });
});

describe('locks, pins and books', () => {
    it('locks the book to the open chat and to its character by its avatar file, and says when either cannot be set', async () => {
        await openScreen();
        change($id('vectfox_lorebase_lock_chat'), true);
        change($id('vectfox_lorebase_lock_character'), true);
        expect(record()).toMatchObject({ lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        change($id('vectfox_lorebase_lock_chat'), false);
        expect(record().lockedToChatIds).toEqual([]);

        document.body.innerHTML = '';
        host.chatId = undefined;
        host.context = { ...host.context, characterId: undefined };
        await openScreen({ bookName: 'Harbor Atlas' });
        expect($id('vectfox_lorebase_lock_chat').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_character').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_notice').textContent).toContain('Open a chat to lock this book');

        // A group chat: the chat can be locked, and no one character.
        document.body.innerHTML = '';
        host.chatId = 'chat-harbor-crew';
        await openScreen({ bookName: 'Harbor Atlas' });
        expect($id('vectfox_lorebase_lock_chat').disabled).toBe(false);
        expect($id('vectfox_lorebase_lock_character').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_notice').textContent).toContain('A group chat has no one character');
    });

    it("pins a section of the entries the pick reads", async () => {
        await openScreen();
        entryToggle('0').click();
        const secrets = document.querySelector('[data-lorebase-pin="Secrets"]');
        change(secrets, true);
        expect(record().pinnedSections).toEqual(['Secrets']);
    });

    it('shows another book when one is chosen, its ticks starting empty', async () => {
        await openScreen();
        tickBox('1').click();
        change($id('vectfox_lorebase_book'), 'Voyage Log');
        await vi.waitFor(() => expect(rowUids()).toEqual(['7']));
        expect(document.querySelector('[data-lorebase-ticked-count]').textContent).toBe('0 ticked');
        expect(record('Voyage Log').seenUids).toEqual(['7']);
    });
});
