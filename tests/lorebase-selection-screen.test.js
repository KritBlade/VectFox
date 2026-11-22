/**
 * @vitest-environment jsdom
 *
 * LoreBase's selection screen (src/features/lorebase/lorebase-selection-screen.js, plan §5.2 of InternalProject/Vectfox/
 * plans/executed/lorebook-semantic-overhaul-passage-index.md), driven as a user would while it is open: it opens on the chat's
 * book with the chat's books first; each row's toggle, a category's toggle and the bulk bar save the selection at
 * once; ticks follow the filters and shift-click; a row's eye button shows its entry and saves nothing; the locks and
 * the pins save; opening a book keeps its uids for the new marks, drops deleted ones from the selection and reads its
 * vectors from Qdrant again. Turning entries on only selects them, writing no keys and needing no model; once the screen
 * closes, it deletes the vectors of the entries turned off, and while LoreBase is on asks to write the keys and vectors
 * the selected entries lack under the progress panel, turning LoreBase off on no only when no entry is ready (§4.3 and
 * §4.4 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md); while LoreBase is off it asks nothing. Each selected
 * row shows where its keys stand, and Regenerate keys writes the ticked entries' keys anew on the panel (D17).
 */
/* global document, MouseEvent -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    books: {}, worldNames: [], globalBooks: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, noticePopup: vi.fn(),
    formPopup: vi.fn(), confirmPopup: vi.fn(), closeScreen: null,
    // The key store: each entry's state by "book/uid", why keys cannot be written, its listeners, the missing keys it
    // counts once the screen closes, and the writings asked.
    keyStates: new Map(), storedKeyUids: new Set(), keyProblem: null, keyListeners: new Set(), pending: null,
    regenerateKeys: vi.fn(), saveEditedKeys: vi.fn(), regenerateKeysOfEntries: vi.fn(async () => ({})),
    writeMissing: vi.fn(async () => ({})), selectedEntriesNotReady: vi.fn(async () => host.pending),
    // The ready entries of the chat's other books in use here, by book, as the WorldInfo page counts them.
    otherReadyCounts: new Map(), storedCountsOfBooks: vi.fn(async books => new Map(books
        .filter(book => host.otherReadyCounts.has(book.bookName)).map(book => [book.bookName, { readyCount: host.otherReadyCounts.get(book.bookName) }]))),
    // The vectors: the books read as the screen opens one, and those pruned as it closes; each entry's state by
    // "book/uid", every one ready unless a test sets it, and their listeners.
    readBookVectors: vi.fn(async () => new Map()), pruneBookVectors: vi.fn(async () => {}), vectorStates: new Map(), vectorListeners: new Set(),
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
    characterLorebooks: () => [],
    loadWorldInfo: vi.fn(async name => host.books[name] ?? null),
    selected_world_info: host.globalBooks,
    world_names: host.worldNames,
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => host.chatId }));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getCharaFilename: () => 'keeper-orrin' }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-keys.js', () => ({
    keyStateOf: (bookName, uid) => host.keyStates.get(`${bookName}/${uid}`) ?? { status: 'missing' },
    // Keys are stored once written; host.storedKeyUids holds those kept while they are written anew.
    hasStoredKeys: (bookName, uid) => host.keyStates.get(`${bookName}/${uid}`)?.status === 'ready' || host.storedKeyUids.has(`${bookName}/${uid}`),
    onKeyStateChange: listener => {
        host.keyListeners.add(listener);
        return () => host.keyListeners.delete(listener);
    },
    readBookKeys: async () => ({}),
    regenerateKeys: host.regenerateKeys,
    saveEditedKeys: host.saveEditedKeys,
}));
// What writing needs (lorebase-setup.js), the screen's Regenerate keys and its closing question alike.
vi.mock('../src/features/lorebase/lorebase-setup.js', () => ({ keyWritingProblem: () => host.keyProblem, writingProblem: () => host.keyProblem }));
vi.mock('../src/features/lorebase/lorebase-storage.js', () => ({
    regenerateKeysOfEntries: host.regenerateKeysOfEntries,
    writeMissing: host.writeMissing,
    selectedEntriesNotReady: host.selectedEntriesNotReady,
    storedCountsOfBooks: host.storedCountsOfBooks,
}));
vi.mock('../src/features/lorebase/lorebase-vectors.js', () => ({
    readBookVectors: host.readBookVectors,
    pruneBookVectors: host.pruneBookVectors,
    vectorStateOf: (bookName, entry) => host.vectorStates.get(`${bookName}/${entry.uid}`) ?? { status: 'ready' },
    hasStoredCurrentVectors: (bookName, entry) => (host.vectorStates.get(`${bookName}/${entry.uid}`) ?? { status: 'ready' }).status === 'ready',
    onVectorStateChange: listener => {
        host.vectorListeners.add(listener);
        return () => host.vectorListeners.delete(listener);
    },
}));

const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
const { openLoreBaseSelection } = await import('../src/features/lorebase/lorebase-selection-screen.js');
const { summaryText } = await import('../src/features/lorebase/lorebase-selection-markup.js');
const { oneSelectionRecord } = await import('./lorebase-book-record.js');

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
// The book's first selection, the one the screen shows on a book of one selection.
const selection = (name = 'Harbor Atlas') => record(name)?.selections?.[0];
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
    host.writeMissing.mockClear();
    host.selectedEntriesNotReady.mockClear();
    host.readBookVectors.mockClear();
    host.pruneBookVectors.mockClear();
    host.pending = { books: [], count: 0, readyCount: 0, decidedCount: 0, unreadBooks: 0 };
    host.regenerateKeys.mockReset();
    host.saveEditedKeys.mockReset();
    vi.mocked(notifyInvalidModel).mockClear();
    host.keyStates = new Map();
    host.storedKeyUids = new Set();
    host.otherReadyCounts = new Map();
    host.storedCountsOfBooks.mockClear();
    host.keyProblem = null;
    host.keyListeners.clear();
    host.vectorStates = new Map();
    host.vectorListeners.clear();
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
        expect($id('vectfox_lorebase_summary').textContent).toBe("LoreBase decides no entry in this selection: where it is in use, SillyTavern's keys decide them all.");
    });

    it('counts in the book list the selected entries LoreBase decides, as the WorldInfo page does, never one SillyTavern keeps', async () => {
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1', '3'] }), 'Voyage Log': oneSelectionRecord({ selectedUids: ['7'] }),
        };
        await openScreen();
        expect([...$id('vectfox_lorebase_book').options].map(option => option.textContent))
            .toEqual(['Harbor Atlas (this chat), 1 selected', 'Voyage Log, 1 selected', 'Zeta Notes']);
    });

    it('marks an entry added since the last opening as new, and drops deleted entries from the selection', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1', '9'], seenUids: ['0', '1', '2', '3'] }) };
        await openScreen();
        const newRows = [...document.querySelectorAll('[data-lorebase-entry]')].filter(element => element.textContent.includes('New'));
        expect(newRows.map(element => element.dataset.lorebaseEntry)).toEqual(['4']);
        expect(selection().selectedUids).toEqual(['1']);
    });
});

describe('keys (D17)', () => {
    const rowText = uid => document.querySelector(`[data-lorebase-entry="${uid}"]`).textContent;
    const tellKeyListeners = bookName => host.keyListeners.forEach(listener => listener(bookName));

    it('writes no keys for an entry turned on, and its row follows where its keys stand', async () => {
        await openScreen();
        entryToggle('1').click();
        expect(selection().selectedUids).toEqual(['1']);
        expect([host.regenerateKeysOfEntries.mock.calls, host.writeMissing.mock.calls]).toEqual([[], []]);
        expect(rowText('1')).toContain('No keys yet');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/Closing this screen asks to write the missing ones\.$/);

        host.keyStates.set('Harbor Atlas/1', { status: 'writing' });
        tellKeyListeners('Harbor Atlas');
        expect(rowText('1')).toContain('Writing keys');

        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens', 'harbor bells'] });
        tellKeyListeners('Harbor Atlas');
        expect(rowText('1')).toContain('LoreBase keys: tidewardens, harbor bells');
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys and vectors: 1 ready.');
    });

    it('writes no keys for the entries the bulk bar and a category turn on', async () => {
        await openScreen();
        entryToggle('0').click();
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        tickBox('4').click();
        actionButton('turn-on').click();
        expect(selection().selectedUids).toEqual(['0', '1', '4']);
        expect([host.regenerateKeysOfEntries.mock.calls, host.writeMissing.mock.calls]).toEqual([[], []]);
    });

    it("shows a failed entry's reason on its row", async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1'] }) };
        host.keyStates.set('Harbor Atlas/1', { status: 'failed', detail: 'its answer held no list of keys' });
        await openScreen();
        expect(rowText('1')).toContain('Keys failed');
        expect(rowText('1')).toContain('its answer held no list of keys');
        expect($id('vectfox_lorebase_summary').textContent).toContain('1 failed');
    });

    it('shows No keys found on a row the model found nothing to key in, counted as written', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1'] }) };
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: [] });
        await openScreen();
        expect(rowText('1')).toContain('No keys found');
        expect(rowText('1')).not.toContain('LoreBase keys');
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys and vectors: 1 ready.');
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

    it('counts an entry ready on the keys it has while they are written anew, as a reply sends it, and never one whose vectors are not read', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['0', '1'] }) };
        host.keyStates.set('Harbor Atlas/0', { status: 'writing' });
        host.storedKeyUids.add('Harbor Atlas/0');
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens'] });
        host.vectorStates.set('Harbor Atlas/1', { status: 'unknown' });
        await openScreen();
        expect(rowText('0')).toContain('Writing keys');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/Keys and vectors: 1 ready\.$/);
    });

    it('leaves an entry disabled in SillyTavern out of Regenerate keys and the keys pencil, as every writing does', async () => {
        host.books['Harbor Atlas'].entries[1].disable = true;
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['0', '1'] }) };
        await openScreen();
        expect(actionButton('edit-keys', '[data-lorebase-uid="0"]')).not.toBeNull();
        expect(actionButton('edit-keys', '[data-lorebase-uid="1"]')).toBeNull();
        tickBox('1').click();
        actionButton('regenerate-keys').click();
        expect(host.regenerateKeysOfEntries).not.toHaveBeenCalled();
        expect(host.noticePopup.mock.calls[0][0][0].text).toContain('LoreBase writes keys only for entries it decides.');
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
            host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1'] }) };
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
            await vi.waitFor(() => expect(host.saveEditedKeys).toHaveBeenCalledWith('Harbor Atlas', expect.objectContaining({ uid: 1, comment: '[Harbor] Tidewardens' }), ['tidewardens', 'bell ringers']));
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
            expect(host.saveEditedKeys).toHaveBeenCalledWith('Harbor Atlas', expect.objectContaining({ uid: 1 }), ['bells']);
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
        expect(selection().selectedUids).toEqual(['1', '0']);
        host.settings.vectfox.lorebase_enabled = false;
        tickBox('4').click();
        actionButton('turn-on').click();
        expect([...selection().selectedUids].sort()).toEqual(['0', '1', '4']);
        expect(host.noticePopup).not.toHaveBeenCalled();
    });

    it('while LoreBase is off, the footer says turning it on asks to write the keys', async () => {
        host.settings.vectfox.lorebase_enabled = false;
        await openScreen();
        entryToggle('1').click();
        tickBox('4').click();
        actionButton('turn-on').click();
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/Keys and vectors: 0 ready, 2 not written yet\. Turning on Use LoreBase asks to write them\.$/);
    });
});

describe('closing the screen (D17, §4.3 and §4.4 of lorebook-multi-vector.md)', () => {
    const closeAndAnswer = async () => {
        const opened = openLoreBaseSelection();
        await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
        entryToggle('1').click();
        host.closeScreen();
        return opened;
    };
    const missingTwo = {
        books: [{ bookName: 'Harbor Atlas', decidedEntries: [{ uid: 1 }, { uid: 4 }], keyEntries: [{ uid: 1 }], vectorEntries: [{ uid: 1 }, { uid: 4 }] }],
        count: 2, readyCount: 0, decidedCount: 5, unreadBooks: 0,
    };
    const someReady = { ...missingTwo, readyCount: 3 };

    it('asks to write the missing keys and vectors while LoreBase is on, and writes them under the progress panel on yes', async () => {
        host.pending = missingTwo;
        host.confirmPopup.mockResolvedValueOnce(true);
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: true });
        const [lines, buttons] = host.confirmPopup.mock.calls[0];
        expect(lines[1]).toEqual({ text: 'Selected entries without keys or vectors:', name: '2' });
        expect(lines.at(-1).text).toBe('Write them now? A progress panel shows the writing. Without them, LoreBase turns off.');
        expect(buttons).toEqual({ okButton: 'Write keys and vectors', cancelButton: 'Turn LoreBase off' });
        expect(host.writeMissing).toHaveBeenCalledWith(host.settings.vectfox, ['keys', 'vectors'], { pending: missingTwo, booksWithChosenLocks: [] });
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
    });

    it('tells the writing which books had their lock set on the screen, so it keeps those locks as the user set them', async () => {
        host.pending = missingTwo;
        host.confirmPopup.mockResolvedValueOnce(true);
        const opened = openLoreBaseSelection();
        await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
        entryToggle('1').click();
        change($id('vectfox_lorebase_lock_chat'), true);
        change($id('vectfox_lorebase_lock_chat'), false);
        // Another book shown, its lock left as it was.
        change($id('vectfox_lorebase_book'), 'Voyage Log');
        await vi.waitFor(() => expect(rowUids()).toEqual(['7']));
        host.closeScreen();

        expect(await opened).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: true });
        expect(host.writeMissing).toHaveBeenCalledWith(host.settings.vectfox, ['keys', 'vectors'], { pending: missingTwo, booksWithChosenLocks: ['Harbor Atlas'] });
        expect(selection().lockedToChatIds).toEqual([]);
    });

    it('writes nothing on Turn LoreBase off with no entry ready, turns it off, and says how many are missing', async () => {
        host.pending = missingTwo;
        host.confirmPopup.mockResolvedValueOnce(false);
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: false });
        expect(host.writeMissing).not.toHaveBeenCalled();
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);
    });

    it('keeps LoreBase on with the ready entries on Not now, writing nothing', async () => {
        host.pending = someReady;
        host.confirmPopup.mockResolvedValueOnce(false);
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: false });
        const [lines, buttons] = host.confirmPopup.mock.calls[0];
        expect(lines.at(-1).text).toBe('Write them now? A progress panel shows the writing. Until they are written, LoreBase goes on with the 3 entries that are ready.');
        expect(buttons).toEqual({ okButton: 'Write keys and vectors', cancelButton: 'Not now' });
        expect(host.writeMissing).not.toHaveBeenCalled();
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
    });

    it('asks nothing when every selected entry is ready, and keeps LoreBase on', async () => {
        host.pending = { books: [], count: 0, readyCount: 5, decidedCount: 5, unreadBooks: 0 };
        expect(await closeAndAnswer()).toEqual({ missingCount: 0, missingKeyCount: 0, missingVectorCount: 0, decidedCount: 5, isWriting: false });
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(host.confirmPopup).not.toHaveBeenCalled();
    });

    it('while LoreBase is off, counts what is missing for the books card and asks nothing', async () => {
        host.settings.vectfox.lorebase_enabled = false;
        host.pending = missingTwo;
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: false });
        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(host.noticePopup).not.toHaveBeenCalled();
        expect(host.writeMissing).not.toHaveBeenCalled();
    });

    it('turns LoreBase off, saying why, when the keys and vectors cannot be read; while it is off, says nothing', async () => {
        const failure = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down");
        host.selectedEntriesNotReady.mockRejectedValueOnce(failure);
        expect(await closeAndAnswer()).toBeNull();
        expect(host.noticePopup.mock.calls[0][0]).toEqual([
            { icon: 'fa-key', text: 'LoreBase could not read the keys and vectors of its selected entries, so it turns off.' },
            { name: failure.message },
        ]);
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);

        host.selectedEntriesNotReady.mockRejectedValueOnce(failure);
        expect(await closeAndAnswer()).toBeNull();
        expect(host.noticePopup).toHaveBeenCalledTimes(1);
    });

    it("says why when LoreBase's model cannot write the missing keys yet, asks nothing, and turns LoreBase off with no entry ready", async () => {
        host.pending = missingTwo;
        host.keyProblem = 'Choose a model for LoreBase first.';
        expect(await closeAndAnswer()).toEqual({ missingCount: 2, missingKeyCount: 1, missingVectorCount: 2, decidedCount: 5, isWriting: false });
        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(host.noticePopup.mock.calls[0][0]).toContainEqual({ text: 'LoreBase cannot write them yet. Without them, LoreBase turns off.' });
        expect(host.noticePopup.mock.calls[0][0].at(-1)).toEqual({ name: 'Choose a model for LoreBase first.' });
        expect(host.settings.vectfox.lorebase_enabled).toBe(false);
    });

    it('keeps LoreBase on with the ready entries when its model cannot write the missing keys yet', async () => {
        host.pending = someReady;
        host.keyProblem = 'Choose a model for LoreBase first.';
        await closeAndAnswer();
        expect(host.noticePopup.mock.calls[0][0]).toContainEqual({
            text: 'LoreBase cannot write them yet. Until they are written, LoreBase goes on with the 3 entries that are ready.',
        });
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
    });

    it("on Qdrant, reads the shown book's vectors as it opens and deletes the vectors of entries turned off as it closes", async () => {
        host.settings.vectfox.vector_backend = 'qdrant';
        await closeAndAnswer();
        expect(host.readBookVectors).toHaveBeenCalledWith(['Harbor Atlas'], host.settings.vectfox);
        expect(host.pruneBookVectors).toHaveBeenCalledWith('Harbor Atlas', host.settings.vectfox);
    });

    it('prunes no book whose selection did not change, and reads no vectors off Qdrant', async () => {
        host.settings.vectfox.vector_backend = 'qdrant';
        const opened = openLoreBaseSelection();
        await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
        host.closeScreen();
        await opened;
        expect(host.pruneBookVectors).not.toHaveBeenCalled();

        host.settings.vectfox.vector_backend = 'standard';
        host.readBookVectors.mockClear();
        await closeAndAnswer();
        expect(host.readBookVectors).not.toHaveBeenCalled();
        expect(host.pruneBookVectors).not.toHaveBeenCalled();
    });
});

describe('choosing entries', () => {
    it("saves a row's toggle at once and counts what the pick reads, and never turns on an entry SillyTavern keeps", async () => {
        await openScreen();
        entryToggle('1').click();
        expect(selection().selectedUids).toEqual(['1']);
        expect(entryToggle('1').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-lorebase-selected-count]').textContent).toBe('1 selected');
        expect($id('vectfox_lorebase_summary').textContent).toMatch(
            /^The pick reads 0 titles and their keys from this book, about 0 tokens on every pick\. Keys and vectors: 0 ready, 1 not written yet\. 1 selected entry sends nothing until its keys and vectors are written\. Closing this screen asks to write the missing ones\.$/);
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens'] });
        host.keyListeners.forEach(listener => listener('Harbor Atlas'));
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/^The pick reads 1 title and their keys from this book, about \d+ tokens on every pick\. Keys and vectors: 1 ready\.$/);
        expect(entryToggle('3').disabled).toBe(true);
        expect(tickBox('3').disabled).toBe(true);
    });

    it('turns a whole category on but its engine entry, reads it in words, and turns it off again', async () => {
        await openScreen();
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        expect(selection().selectedUids.sort()).toEqual(['0', '1']);
        expect($id('vectfox_lorebase_categories').textContent).toContain('All on');
        actionButton('toggle-category', '[data-lorebase-category="[Harbor]"]').click();
        expect(selection().selectedUids).toEqual([]);
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
        expect(selection().selectedUids.sort()).toEqual(['0', '1', '2']);
        tickBox('0').click();
        actionButton('turn-off').click();
        expect(selection().selectedUids).toEqual(['0']);
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

    it('says on its row and in its dialog that SillyTavern keeps an entry an @@activate or @@dont_activate line opens', async () => {
        host.books['Harbor Atlas'].entries[1].content = '@@dont_activate\nThe tidewardens read the harbor bells.';
        host.books['Harbor Atlas'].entries[4].content = '@@activate\nFog closes the strait each spring.';
        await openScreen();
        const rowOf = uid => document.querySelector(`[data-lorebase-entry="${uid}"]`);
        expect([rowOf('1').textContent.includes('@@dont_activate'), rowOf('4').textContent.includes('@@activate')]).toEqual([true, true]);
        expect([tickBox('1').disabled, tickBox('4').disabled]).toEqual([true, true]);
        actionButton('show-entry', '[data-lorebase-uid="4"]').click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(1));
        expect(host.noticePopup.mock.calls[0][0]).toContainEqual({
            icon: 'fa-lock', text: '@@activate: this line at its top has SillyTavern send it on every reply, so LoreBase cannot decide it.',
        });
        actionButton('show-entry', '[data-lorebase-uid="1"]').click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(2));
        expect(host.noticePopup.mock.calls[1][0]).toContainEqual({
            icon: 'fa-lock', text: '@@dont_activate: this line at its top keeps SillyTavern from ever sending it, so LoreBase cannot decide it.',
        });
    });

    it('says what the pick sees of an entry with no title, keys or review, true on both choices', async () => {
        host.books['Harbor Atlas'].entries[5] = { uid: 5, comment: '', key: [], content: `<% if (tide) { %>${'The harbor tide rises at dusk. '.repeat(400)}<% } %>`, disable: true };
        await openScreen();
        expect($id('vectfox_lorebase_entries_notice').textContent.trim())
            .toBe('The pick sees an entry with no title only as "entry" and its UID, with its keys. Give it a title in World Info.');
        actionButton('show-entry', '[data-lorebase-uid="5"]').click();
        await vi.waitFor(() => expect(host.noticePopup).toHaveBeenCalledTimes(1));
        const lines = host.noticePopup.mock.calls[0][0];
        expect(lines).toEqual(expect.arrayContaining([
            { icon: 'fa-power-off', text: 'Disabled in SillyTavern: it is never sent, and LoreBase never picks it.' },
            { icon: 'fa-code', text: 'Template code: when it is picked, LoreBase sends it whole, never trimmed.' },
            { icon: 'fa-key', text: 'No keys: LoreBase needs none, as it reads the title and the keys its own model writes.' },
            { icon: 'fa-ruler-horizontal', text: 'Long: on High Accuracy, the review saves the most tokens on an entry this size. Fast and Cheap [Jev] sends it whole, within the lore budget.' },
            { icon: 'fa-heading', text: 'No title: the pick sees it only as "entry" and its UID, with its keys. Give it a title in World Info.' },
        ]));
        expect(JSON.stringify(lines)).not.toContain('Luna');
    });
});

describe('locks, pins and books', () => {
    it('locks the selection shown to the open chat and to its character by its avatar file, and says when either cannot be set', async () => {
        await openScreen();
        change($id('vectfox_lorebase_lock_chat'), true);
        change($id('vectfox_lorebase_lock_character'), true);
        expect(selection()).toMatchObject({ lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        change($id('vectfox_lorebase_lock_chat'), false);
        expect(selection().lockedToChatIds).toEqual([]);

        document.body.innerHTML = '';
        host.chatId = undefined;
        host.context = { ...host.context, characterId: undefined };
        await openScreen({ bookName: 'Harbor Atlas' });
        expect($id('vectfox_lorebase_lock_chat').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_character').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_notice').textContent).toContain('Open a chat to lock this selection');

        // A group chat no member of which loads the book: the chat can be locked, and no one character.
        document.body.innerHTML = '';
        host.chatId = 'chat-harbor-crew';
        await openScreen({ bookName: 'Harbor Atlas' });
        expect($id('vectfox_lorebase_lock_chat').disabled).toBe(false);
        expect($id('vectfox_lorebase_lock_character').disabled).toBe(true);
        expect($id('vectfox_lorebase_lock_notice').textContent).toContain('In this group chat no one member loads this lorebook');

        // Between replies in a group whose member Keeper Orrin loads the book: Lock to this character is Keeper Orrin's.
        document.body.innerHTML = '';
        host.context = { ...host.context, groupId: 'harbor-crew', groups: [{ id: 'harbor-crew', members: ['keeper-orrin.png'], disabled_members: [] }] };
        await openScreen({ bookName: 'Harbor Atlas' });
        expect([$id('vectfox_lorebase_lock_character').disabled, $id('vectfox_lorebase_lock_character').checked]).toEqual([false, true]);
        expect($id('vectfox_lorebase_lock_notice').textContent).toContain('In this group chat this is the lorebook of Keeper Orrin');
        change($id('vectfox_lorebase_lock_character'), false);
        expect(selection().lockedToCharacterAvatars).toEqual([]);
    });

    it("pins a section of the entries the pick reads", async () => {
        await openScreen();
        entryToggle('0').click();
        const secrets = document.querySelector('[data-lorebase-pin="Secrets"]');
        change(secrets, true);
        expect(selection().pinnedSections).toEqual(['Secrets']);
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

describe("a book's selections (§3.7 of vectfox-multi-collection-per-chat.md)", () => {
    const selectionList = () => $id('vectfox_lorebase_selection_list');
    const turnedOn = () => [...document.querySelectorAll('[data-lorebase-action="toggle-entry"][aria-pressed="true"]')].map(button => button.dataset.lorebaseUid);
    const withTwoSelections = () => {
        const harbor = oneSelectionRecord({ selectedUids: ['0'], lockedToChatIds: ['chat-harbor'] });
        harbor.selections.push({ id: 'second', name: 'Night watch', selectedUids: ['1', '4'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': harbor };
    };
    const renameTo = name => async (lines, form) => {
        form.querySelector('#vectfox_lorebase_rename_selection').value = name;
        return true;
    };

    it('opens on the one in use here, lists them all with that one marked, and shows another chosen without putting it in use', async () => {
        withTwoSelections();
        await openScreen();
        expect([...selectionList().options].map(option => [option.value, option.textContent, option.selected]))
            .toEqual([['first', 'First (in use here)', true], ['second', 'Night watch', false]]);
        expect(turnedOn()).toEqual(['0']);

        change(selectionList(), 'second');
        expect(turnedOn()).toEqual(['1', '4']);
        expect($id('vectfox_lorebase_lock_chat').checked).toBe(false);
        // An entry turned on changes the selection shown alone.
        entryToggle('2').click();
        expect(record().selections.map(each => each.selectedUids)).toEqual([['0'], ['1', '2', '4']]);
        expect(record().selections[0].lockedToChatIds).toEqual(['chat-harbor']);
    });

    it('opens on the selection named, and on a book never opened makes its first, named after the book', async () => {
        withTwoSelections();
        await openScreen({ bookName: 'Harbor Atlas', selectionId: 'second' });
        expect(selectionList().value).toBe('second');

        document.body.innerHTML = '';
        await openScreen({ bookName: 'Voyage Log' });
        expect(record('Voyage Log').selections).toEqual([expect.objectContaining({ name: 'Voyage Log', selectedUids: [] })]);
        expect([...selectionList().options].map(option => option.textContent)).toEqual(['Voyage Log']);
        expect(actionButton('delete-selection').disabled).toBe(true);
    });

    it('drops deleted entries from every selection of the book as it opens', async () => {
        withTwoSelections();
        record().selections[1].selectedUids.push('9');
        await openScreen();
        expect(record().selections.map(each => each.selectedUids)).toEqual([['0'], ['1', '4']]);
    });

    it('makes a new selection from the one shown with New selection, puts it in use here and shows it', async () => {
        withTwoSelections();
        await openScreen();
        change(selectionList(), 'second');
        actionButton('new-selection').click();
        const made = record().selections[2];
        expect(made).toMatchObject({ name: 'Harbor Atlas 2', selectedUids: ['1', '4'], lockedToChatIds: ['chat-harbor'] });
        expect(record().selections[0].lockedToChatIds).toEqual([]);
        expect(selectionList().value).toBe(made.id);
        expect(selectionList().selectedOptions[0].textContent).toBe('Harbor Atlas 2 (in use here)');
        expect($id('vectfox_lorebase_lock_chat').checked).toBe(true);
        expect(turnedOn()).toEqual(['1', '4']);
    });

    it('renames the selection shown, and saves nothing on Cancel or an empty name', async () => {
        withTwoSelections();
        await openScreen();
        host.formPopup.mockImplementationOnce(renameTo('  Day watch '));
        actionButton('rename-selection').click();
        await vi.waitFor(() => expect(record().selections[0].name).toBe('Day watch'));
        expect(selectionList().options[0].textContent).toBe('Day watch (in use here)');

        host.formPopup.mockImplementationOnce(renameTo('   '));
        actionButton('rename-selection').click();
        host.formPopup.mockResolvedValueOnce(false);
        actionButton('rename-selection').click();
        await vi.waitFor(() => expect(host.formPopup).toHaveBeenCalledTimes(3));
        expect(record().selections[0].name).toBe('Day watch');
    });

    it("deletes the selection shown once confirmed, pruning the book's vectors then, shows the book's next, and keeps the last", async () => {
        host.settings.vectfox.vector_backend = 'qdrant';
        withTwoSelections();
        const opened = openLoreBaseSelection();
        await vi.waitFor(() => expect(rowUids().length).toBeGreaterThan(0));
        host.confirmPopup.mockResolvedValueOnce(false);
        actionButton('delete-selection').click();
        await vi.waitFor(() => expect(host.confirmPopup).toHaveBeenCalledTimes(1));
        expect(record().selections).toHaveLength(2);

        host.confirmPopup.mockResolvedValueOnce(true);
        actionButton('delete-selection').click();
        await vi.waitFor(() => expect(record().selections.map(each => each.id)).toEqual(['second']));
        const [lines, buttons] = host.confirmPopup.mock.calls[1];
        expect(lines).toEqual(expect.arrayContaining([{ text: 'Delete this selection?' }, { text: 'Selection:', name: 'First' }]));
        expect(buttons).toEqual({ okButton: 'Delete', isDestructive: true });
        // The one selection delete, the WorldInfo row's trash's too, prunes as it deletes, the screen still open.
        expect(host.pruneBookVectors).toHaveBeenCalledWith('Harbor Atlas', host.settings.vectfox);
        expect(selectionList().value).toBe('second');
        expect(turnedOn()).toEqual(['1', '4']);
        expect(actionButton('delete-selection').disabled).toBe(true);

        host.closeScreen();
        await opened;
    });
});

describe('vectors on each row, the readiness filter, and the footer on Fast and Cheap [Jev] (§7.3 of lorebook-multi-vector.md)', () => {
    const rowText = uid => document.querySelector(`[data-lorebase-entry="${uid}"]`).textContent;
    const selectHarbor = (uids, locks = {}) => {
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': oneSelectionRecord({ selectedUids: uids, ...locks }),
        };
    };
    const tellVectorListeners = bookName => host.vectorListeners.forEach(listener => listener(bookName));

    it("shows each selected row's vectors beside its keys: missing, another model's, being written, or failed with the reason, redrawn as they change", async () => {
        selectHarbor(['0', '1', '4']);
        host.keyStates.set('Harbor Atlas/0', { status: 'ready', keys: ['lighthouse'] });
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens'] });
        host.vectorStates.set('Harbor Atlas/0', { status: 'missing' });
        host.vectorStates.set('Harbor Atlas/1', { status: 'other-model' });
        await openScreen();
        expect(rowText('0')).toContain('No vectors yet');
        expect(rowText('0')).toContain('LoreBase keys: lighthouse');
        expect(rowText('1')).toContain('Vectors from another model');
        expect(rowText('4')).toContain('No keys yet');
        host.vectorStates.set('Harbor Atlas/0', { status: 'writing' });
        tellVectorListeners('Harbor Atlas');
        expect(rowText('0')).toContain('Vectorizing');
        host.vectorStates.set('Harbor Atlas/0', { status: 'failed', detail: 'the embedding server refused' });
        tellVectorListeners('Harbor Atlas');
        expect(rowText('0')).toContain('Vectors failed: the embedding server refused');
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys and vectors: 0 ready, 1 failed, 2 not written yet.');
        tellVectorListeners('Voyage Log');
        expect(rowText('0')).toContain('Vectors failed');
    });

    it('shows only the ready entries, or only those without keys or vectors, the rest of the filters kept', async () => {
        selectHarbor(['0', '1', '4']);
        host.keyStates.set('Harbor Atlas/0', { status: 'ready', keys: ['lighthouse'] });
        host.keyStates.set('Harbor Atlas/1', { status: 'writing' });
        await openScreen();
        expect([...$id('vectfox_lorebase_readiness').options].map(option => option.textContent)).toEqual(['Ready or not', 'Ready', 'Without keys or vectors']);
        change($id('vectfox_lorebase_readiness'), 'ready');
        expect(rowUids()).toEqual(['0']);
        change($id('vectfox_lorebase_readiness'), 'not-ready');
        expect(rowUids()).toEqual(['1', '4']);
        change($id('vectfox_lorebase_readiness'), 'any');
        expect(rowUids()).toEqual(['0', '1', '2', '3', '4']);
    });

    it('gives a selected entry disabled in SillyTavern no keys or vectors to wait for, as LoreBase skips it, in its row, the summary and the filter', async () => {
        host.books['Harbor Atlas'].entries[1].disable = true;
        selectHarbor(['0', '1']);
        host.keyStates.set('Harbor Atlas/0', { status: 'ready', keys: ['lighthouse'] });
        await openScreen();
        expect(rowText('1')).toContain('Disabled');
        expect(rowText('1')).not.toMatch(/No keys|yet|Vectorizing|failed|another model/);
        expect($id('vectfox_lorebase_summary').textContent).toContain('Keys and vectors: 1 ready.');
        change($id('vectfox_lorebase_readiness'), 'not-ready');
        expect(rowUids()).toEqual([]);
    });

    it('says on Fast and Cheap [Jev] how many ready entries taking part in this chat Jev is asked about, as the reply counts them, or that the selection shown takes no part', async () => {
        host.settings.vectfox.lorebase_accuracy = 'fast';
        selectHarbor(['0', '1'], { lockedToChatIds: ['chat-harbor'] });
        // Voyage Log, in the global list, has its selection in use here too, 99 of its entries ready.
        host.globalBooks.push('Voyage Log');
        host.settings.vectfox.lorebase_books['Voyage Log'] = oneSelectionRecord({ selectedUids: ['7'], lockedToChatIds: ['chat-harbor'] });
        host.otherReadyCounts.set('Voyage Log', 99);
        host.keyStates.set('Harbor Atlas/0', { status: 'ready', keys: ['lighthouse'] });
        await openScreen({ bookName: 'Harbor Atlas' });
        await vi.waitFor(() => expect($id('vectfox_lorebase_summary').textContent)
            .toMatch(/^Jev is asked about every one of the 100 ready entries taking part in this chat, on every reply\./));
        host.keyStates.set('Harbor Atlas/1', { status: 'ready', keys: ['tidewardens'] });
        host.keyListeners.forEach(listener => listener('Harbor Atlas'));
        expect($id('vectfox_lorebase_summary').textContent)
            .toMatch(/^Jev is asked about the 100 a search finds best of the 101 ready entries taking part in this chat, on every reply\./);
        change($id('vectfox_lorebase_lock_chat'), false);
        expect($id('vectfox_lorebase_summary').textContent).toMatch(/^This selection takes no part in this chat, so Jev is never asked about its entries here\./);
    });

    it("words the footer's rule: the search's best 100 above 100, none ready, the rule alone while the count is not known, and the pick's titles on High Accuracy", () => {
        const footer = { decidedCount: 52, entryCount: 40, titleTokens: 600 };
        expect(summaryText(footer, { isFastAndCheap: true, takingPart: { count: 313, isSelectionTakingPart: true } }))
            .toBe('Jev is asked about the 100 a search finds best of the 313 ready entries taking part in this chat, on every reply.');
        expect(summaryText(footer, { isFastAndCheap: true, takingPart: { count: 100, isSelectionTakingPart: true } }))
            .toBe('Jev is asked about every one of the 100 ready entries taking part in this chat, on every reply.');
        expect(summaryText(footer, { isFastAndCheap: true, takingPart: { count: 0, isSelectionTakingPart: true } }))
            .toBe('No entry taking part in this chat is ready yet, so Jev is asked about none until their keys and vectors are written.');
        expect(summaryText(footer, { isFastAndCheap: true, takingPart: null }))
            .toBe('Jev is asked about every ready entry of the books a chat locks, up to 100 in all, and above that about the 100 a search finds best, on every reply.');
        expect(summaryText(footer, { isFastAndCheap: false, takingPart: { count: 313, isSelectionTakingPart: true } }))
            .toBe('The pick reads 40 titles and their keys from this book, about 600 tokens on every pick.');
        expect(summaryText({ decidedCount: 0, entryCount: 0, titleTokens: 0 }, { isFastAndCheap: true }))
            .toBe("LoreBase decides no entry in this selection: where it is in use, SillyTavern's keys decide them all.");
    });
});
