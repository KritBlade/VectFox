/**
 * @vitest-environment jsdom
 *
 * LoreBase's selection screen (src/features/lorebase/lorebase-selection-screen.js, plan §5.2 of InternalProject/Vectfox/
 * plans/lorebook-semantic-overhaul-passage-index.md), driven as a user would while it is open: it opens on the chat's
 * book with the chat's books first; each row's toggle, a category's toggle and the bulk bar save the selection at
 * once; ticks follow the filters and shift-click; a row's eye button shows its entry and saves nothing; the locks and
 * the pins save; opening a book keeps its uids for the new marks and drops deleted ones from the selection. Turning
 * entries on only selects them, writing no keys and needing no model; once the screen closes while LoreBase is on, it
 * asks to write the selected entries' missing keys under the progress panel, and while LoreBase is off asks nothing.
 * Each selected row shows where its keys stand, and Regenerate keys writes the ticked entries' keys anew on the panel
 * (D17).
 */
/* global document, MouseEvent -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    books: {}, worldNames: [], globalBooks: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, noticePopup: vi.fn(),
    formPopup: vi.fn(), confirmPopup: vi.fn(), closeScreen: null,
    // The key store: each entry's state by "book/uid", why keys cannot be written, its listeners, the missing keys it
    // counts once the screen closes, and the writings asked.
    keyStates: new Map(), keyProblem: null, keyListeners: new Set(), pending: null,
    regenerateKeys: vi.fn(), saveEditedKeys: vi.fn(), regenerateKeysOfEntries: vi.fn(async () => ({})),
    writeKeysOfSelections: vi.fn(async () => ({})), selectedEntriesWithoutKeys: vi.fn(async () => host.pending),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // The dialog door: the screen is on the page while it is open.
    openPanelPopup: vi.fn(root => {
        document.body.append(root);
        return new Promise(resolve => {
            host.closeScreen = () => {
                root.remove();
                resolve();
            };
        });
    }),
    noticePopup: host.noticePopup,
    formPopup: host.formPopup,
    confirmPopup: host.confirmPopup,
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyInvalidModel: vi.fn() }));
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
vi.mock('../src/features/lorebase/lorebase-keys.js', () => ({
    keyStateOf: (bookName, uid) => host.keyStates.get(`${bookName}/${uid}`) ?? { status: 'missing' },
    keyWritingProblem: () => host.keyProblem,
    onKeyStateChange: listener => {
        host.keyListeners.add(listener);
        return () => host.keyListeners.delete(listener);
    },
    readBookKeys: async () => ({}),
    regenerateKeys: host.regenerateKeys,
    saveEditedKeys: host.saveEditedKeys,
    regenerateKeysOfEntries: host.regenerateKeysOfEntries,
    writeKeysOfSelections: host.writeKeysOfSelections,
    selectedEntriesWithoutKeys: host.selectedEntriesWithoutKeys,
}));

const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
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
    host.settings.vectfox = { lorebase_enabled: true };
    host.noticePopup.mockReset();
    host.formPopup.mockReset();
    host.confirmPopup.mockReset();
    host.regenerateKeysOfEntries.mockClear();
    host.writeKeysOfSelections.mockClear();
    host.selectedEntriesWithoutKeys.mockClear();
    host.pending = { books: [], count: 0, decidedCount: 0, unreadBooks: 0 };
    host.regenerateKeys.mockReset();
    host.saveEditedKeys.mockReset();
    vi.mocked(notifyInvalidModel).mockClear();
    host.keyStates = new Map();
    host.keyProblem = null;
    host.keyListeners.clear();
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

describe('keys (D17)', () => {
    const rowText = uid => document.querySelector(`[data-lorebase-entry="${uid}"]`).textContent;
    const tellKeyListeners = bookName => host.keyListeners.forEach(listener => listener(bookName));

    it('writes no keys for an entry turned on, and its row follows where its keys stand', async () => {
        await openScreen();
        entryToggle('1').click();
        expect(record().selectedUids).toEqual(['1']);
        expect([host.regenerateKeysOfEntries.mock.calls, host.writeKeysOfSelections.mock.calls]).toEqual([[], []]);
        expect(rowText('1')).toContain('No keys yet');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/Closing this screen asks to write the missing ones\.$/);

        host.keyStates.set('Harbor Atlas/1', { status: 'writing' });
        tellKeyListeners('Harbor Atlas');
        expect(rowText('1')).toContain('Writing keys');

        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens', 'harbor bells'] });
        tellKeyListeners('Harbor Atlas');
        expect(rowText('1')).toContain('LoreBase keys: tidewardens, harbor bells');
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys: 1 written.');
    });

    it('writes no keys for the entries the bulk bar and a category turn on', async () => {
        await openScreen();
        entryToggle('0').click();
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        tickBox('4').click();
        actionButton('turn-on').click();
        expect(record().selectedUids).toEqual(['0', '1', '4']);
        expect([host.regenerateKeysOfEntries.mock.calls, host.writeKeysOfSelections.mock.calls]).toEqual([[], []]);
    });

    it("shows a failed entry's reason on its row", async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': { selectedUids: ['1'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } };
        host.keyStates.set('Harbor Atlas/1', { status: 'failed', detail: 'its answer held no list of keys' });
        await openScreen();
        expect(rowText('1')).toContain('Keys failed');
        expect(rowText('1')).toContain('its answer held no list of keys');
        expect($id('vectfox_lorebase_summary').textContent).toContain('1 failed');
    });

    it('shows No keys found on a row the model found nothing to key in, counted as written', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': { selectedUids: ['1'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } };
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: [] });
        await openScreen();
        expect(rowText('1')).toContain('No keys found');
        expect(rowText('1')).not.toContain('LoreBase keys');
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys: 1 written.');
    });

    it('writes the ticked entries that are on anew with Regenerate keys, and only those', async () => {
        await openScreen();
        entryToggle('0').click();
        entryToggle('1').click();
        tickBox('1').click();
        tickBox('4').click();
        expect(actionButton('regenerate-keys').textContent).toContain('Regenerate keys');
        actionButton('regenerate-keys').click();
        expect(host.regenerateKeysOfEntries).toHaveBeenCalledTimes(1);
        const [bookName, entries] = host.regenerateKeysOfEntries.mock.calls[0];
        expect([bookName, entries.map(each => String(each.uid))]).toEqual(['Harbor Atlas', ['1']]);
    });

    it('says why Regenerate keys did not run, as when another run is on the progress panel', async () => {
        host.regenerateKeysOfEntries.mockRejectedValueOnce(new Error('LoreBase is already writing keys on the progress panel. Wait for it, or press Stop there.'));
        await openScreen();
        entryToggle('1').click();
        tickBox('1').click();
        actionButton('regenerate-keys').click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(1));
        expect(host.noticePopup.mock.calls[0][0][0].text).toContain('already writing keys');
    });

    describe("editing an entry's keys", () => {
        const pencil = uid => document.querySelector(`[data-lorebase-action="edit-keys"][data-lorebase-uid="${uid}"]`);
        const box = form => form.querySelector('#vectfox_lorebase_keys_editor');
        const status = form => form.querySelector('#vectfox_lorebase_keys_editor_status').textContent;
        const selectTidewardens = () => {
            host.settings.vectfox.lorebase_books = { 'Harbor Atlas': { selectedUids: ['1'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] } };
            host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens', 'harbor bells'] });
        };

        it('offers the pencil on selected rows only, not while their keys are written, and saves the keys typed, one per line', async () => {
            selectTidewardens();
            await openScreen();
            expect(pencil('0')).toBeNull();
            expect(pencil('1').disabled).toBe(false);

            host.formPopup.mockImplementationOnce(async (lines, form) => {
                expect(box(form).value).toBe('tidewardens\nharbor bells');
                expect(lines[0].name).toBe('Tidewardens');
                box(form).value = ' tidewardens \n\nbell ringers\ntidewardens';
                return true;
            });
            pencil('1').click();
            await vi.waitFor(() => expect(host.saveEditedKeys).toHaveBeenCalledWith('Harbor Atlas', '1', ['tidewardens', 'bell ringers']));
            expect(host.formPopup).toHaveBeenCalledTimes(1);

            host.keyStates.set('Harbor Atlas/1', { status: 'writing' });
            tellKeyListeners('Harbor Atlas');
            expect(pencil('1').disabled).toBe(true);
        });

        it('keeps the dialog open with the text typed and the reason when the keys cannot be stored, or the save failed', async () => {
            selectTidewardens();
            host.saveEditedKeys.mockRejectedValueOnce(new Error('Similharity could not write LoreBase\'s keys (HTTP 500): Qdrant is down'));
            const seen = [];
            host.formPopup.mockImplementation(async (lines, form) => {
                seen.push(status(form));
                if (seen.length === 1) box(form).value = '  \n';
                if (seen.length === 2) box(form).value = 'bells';
                return seen.length < 3;
            });
            await openScreen();
            pencil('1').click();
            await vi.waitFor(() => expect(host.formPopup).toHaveBeenCalledTimes(3));
            expect(seen).toEqual([
                '',
                "An entry needs at least one key. Regenerate asks LoreBase's model for them.",
                "Not saved: Similharity could not write LoreBase's keys (HTTP 500): Qdrant is down",
            ]);
            expect(host.saveEditedKeys).toHaveBeenCalledTimes(1);
            expect(host.saveEditedKeys).toHaveBeenCalledWith('Harbor Atlas', '1', ['bells']);
        });

        it("fills the box from LoreBase's model with Regenerate, to read before Save keys, and says when the model fails", async () => {
            selectTidewardens();
            host.regenerateKeys.mockResolvedValueOnce(['tidewardens', 'harbor bells', 'bell code']);
            host.regenerateKeys.mockResolvedValueOnce([]);
            const failure = Object.assign(new Error('The model openai/gpt-7 does not exist.'), { kind: 'model_config' });
            host.regenerateKeys.mockRejectedValueOnce(failure);
            host.formPopup.mockImplementationOnce(async (lines, form) => {
                const regenerate = form.querySelector('[data-lorebase-keys-regenerate]');
                regenerate.click();
                await vi.waitFor(() => expect(box(form).value).toBe('tidewardens\nharbor bells\nbell code'));
                expect(status(form)).toBe("3 keys from LoreBase's model. Read them, then Save keys, or Cancel to keep the old ones.");
                regenerate.click();
                await vi.waitFor(() => expect(status(form)).toBe(
                    "LoreBase's model found nothing in this entry to key. Type keys to save, or Cancel to keep the old ones."));
                expect(box(form).value).toBe('tidewardens\nharbor bells\nbell code');
                regenerate.click();
                await vi.waitFor(() => expect(status(form)).toBe('No new keys: The model openai/gpt-7 does not exist.'));
                expect(box(form).value).toBe('tidewardens\nharbor bells\nbell code');
                return false;
            });
            await openScreen();
            pencil('1').click();
            await vi.waitFor(() => expect(host.regenerateKeys).toHaveBeenCalledTimes(3));
            await vi.waitFor(() => expect(notifyInvalidModel).toHaveBeenCalledWith('The model openai/gpt-7 does not exist.'));
            expect(host.regenerateKeys.mock.calls[0][0].uid).toBe(1);
            expect(host.saveEditedKeys).not.toHaveBeenCalled();
        });
    });

    it('selects entries with no model or Qdrant yet, asking nothing, LoreBase on or off', async () => {
        host.keyProblem = 'LoreBase keeps the keys its model writes for each entry in Qdrant. Choose Qdrant as the vector backend first.';
        await openScreen();
        entryToggle('1').click();
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        expect(record().selectedUids).toEqual(['1', '0']);
        host.settings.vectfox.lorebase_enabled = false;
        tickBox('4').click();
        actionButton('turn-on').click();
        expect([...record().selectedUids].sort()).toEqual(['0', '1', '4']);
        expect(host.noticePopup).not.toHaveBeenCalled();
    });

    it('while LoreBase is off, the footer says turning it on asks to write the keys', async () => {
        host.settings.vectfox.lorebase_enabled = false;
        await openScreen();
        entryToggle('1').click();
        tickBox('4').click();
        actionButton('turn-on').click();
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/Keys: 0 written, 2 not written yet\. Turning on Use LoreBase asks to write them\.$/);
    });
});

describe('closing the screen (D17)', () => {
    const closeAndAnswer = async () => {
        const opened = openLoreBaseSelection();
        await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
        entryToggle('1').click();
        host.closeScreen();
        return opened;
    };
    const missingTwo = { books: [{ bookName: 'Harbor Atlas', entries: [{ uid: 1 }, { uid: 4 }] }], count: 2, decidedCount: 5, unreadBooks: 0 };

    it('asks to write the missing keys while LoreBase is on, and writes them under the progress panel on Write keys', async () => {
        host.pending = missingTwo;
        host.confirmPopup.mockResolvedValueOnce(true);
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, decidedCount: 5, isWriting: true });
        const [lines, buttons] = host.confirmPopup.mock.calls[0];
        expect(lines[1]).toEqual({ text: 'Selected entries with no keys:', name: '2' });
        expect(lines.at(-1).text).toBe('Write them now? A progress panel shows the writing. Without them, LoreBase turns off.');
        expect(buttons).toEqual({ okButton: 'Write keys', cancelButton: 'Turn LoreBase off' });
        expect(host.writeKeysOfSelections).toHaveBeenCalledWith(host.settings.vectfox, missingTwo);
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
    });

    it('writes nothing on Turn LoreBase off, turns it off, and says how many are missing', async () => {
        host.pending = missingTwo;
        host.confirmPopup.mockResolvedValueOnce(false);
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, decidedCount: 5, isWriting: false });
        expect(host.writeKeysOfSelections).not.toHaveBeenCalled();
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);
    });

    it('asks nothing when every selected entry has keys, and keeps LoreBase on', async () => {
        host.pending = { books: [], count: 0, decidedCount: 5, unreadBooks: 0 };
        expect(await closeAndAnswer()).toEqual({ missingCount: 0, decidedCount: 5, isWriting: false });
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(host.confirmPopup).not.toHaveBeenCalled();
    });

    it('while LoreBase is off, counts the missing keys for the books card and asks nothing', async () => {
        host.settings.vectfox.lorebase_enabled = false;
        host.pending = missingTwo;
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, decidedCount: 5, isWriting: false });
        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(host.noticePopup).not.toHaveBeenCalled();
        expect(host.writeKeysOfSelections).not.toHaveBeenCalled();
    });

    it('turns LoreBase off, saying why, when the keys cannot be read; while it is off, says nothing', async () => {
        const failure = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down");
        host.selectedEntriesWithoutKeys.mockRejectedValueOnce(failure);
        expect(await closeAndAnswer()).toBeNull();
        expect(host.noticePopup.mock.calls[0][0]).toEqual([
            { icon: 'fa-key', text: 'LoreBase could not read the keys of its selected entries, so it turns off.' },
            { name: failure.message },
        ]);
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);

        host.selectedEntriesWithoutKeys.mockRejectedValueOnce(failure);
        expect(await closeAndAnswer()).toBeNull();
        expect(host.noticePopup).toHaveBeenCalledTimes(1);
    });

    it("says why when LoreBase's model cannot write the missing keys yet, asks nothing, and turns LoreBase off", async () => {
        host.pending = missingTwo;
        host.keyProblem = 'Choose a model for LoreBase first.';
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, decidedCount: 5, isWriting: false });
        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(host.noticePopup.mock.calls[0][0]).toContainEqual({ text: "LoreBase's model cannot write them yet, so LoreBase turns off." });
        expect(host.noticePopup.mock.calls[0][0].at(-1)).toEqual({ name: 'Choose a model for LoreBase first.' });
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);
    });
});

describe('choosing entries', () => {
    it("saves a row's toggle at once and counts what the pick reads, and never turns on an entry SillyTavern keeps", async () => {
        await openScreen();
        entryToggle('1').click();
        expect(record().selectedUids).toEqual(['1']);
        expect(entryToggle('1').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-lorebase-selected-count]').textContent).toBe('1 selected');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(
            /^The pick reads 1 title and their keys from this book, about \d+ tokens on every pick\. Keys: 0 written, 1 not written yet\. 1 selected entry sends nothing until its keys are written\. Closing this screen asks to write the missing ones\.$/);
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
