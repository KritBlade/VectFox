/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase controls (src/features/settings-panel/lorebase-books-card.js, plan §5.2 and §5.9 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md, §3.4 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): LoreBase's switch shows as saved; while it is off the user still chooses
 * entries and sets the model, a notice says to do that first, and only the Generate buttons wait; turning it on can end
 * off when the user keeps Vector Storage's World Info search, and with nothing selected anywhere the status line says
 * to choose entries next. The books card draws the open chat's books, then how many of each book's selected entries
 * have keys and vectors, opens the selection screen on the book a row names or, from the card's own button, on the
 * chat's first book, and draws the list again once the screen closes, a screen that failed included, saying what the
 * selection lacks of each kind and, while LoreBase is on, which Generate button writes it. Add a lorebook (§6 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md) lists the books the chat does not load, adds the chosen one
 * to this chat or to this character, says where it went or why it was not, and opens the screen on it. Generate keys, Generate
 * vectors and Generate all write the missing ones of their kinds, or say why they cannot; Delete all asks first, and
 * once it has deleted both turns LoreBase off; Remove from LoreBase on a book's row runs LoreBase's one confirm and
 * removal, leaving the book in the chat, and Unlink runs them and unlinks the book; each then says what went and what
 * still loads the book, or why it was not removed or unlinked, and draws the list again; on a row showing one of its
 * several selections the trash deletes that selection alone, through LoreBase's one selection delete; the status line
 * says how each went, one entry as one, and names the
 * books a writing run locked to its chat (§4.3 and §6.1 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md),
 * "this chat" while it is open, a line that goes once another chat is open.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    status: null, screen: null, isOn: true, willTurnOn: true, turnOnMissing: null, switchListener: null, writingRunListener: null, writingProgressListener: null,
    chatLocksMovedListener: null,
    selectedBooks: [], settings: { vector_backend: 'qdrant' }, keyProblem: null, outcome: null, isConfirmed: true, deleted: null, chatId: null,
    counts: null, add: null, added: null, removed: null, deletedSelection: null, useError: null,
    // The books LoreBase holds anything of, so their rows offer Remove from LoreBase.
    removable: new Set(),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.isConfirmed) }));
vi.mock('../src/sillytavern/chat.js', () => ({ getCurrentChatId: () => host.chatId }));
vi.mock('../src/features/lorebase/index.js', async () => ({
    describeRemovedLoreBook: (await import('../src/features/lorebase/lorebase-files-core.js')).describeRemovedLoreBook,
    kindsLacking: (await import('../src/features/lorebase/lorebase-storage-core.js')).kindsLacking,
    // What was removed, null on Cancel, or the error that refused it.
    removeLoreBookAfterConfirm: vi.fn(async () => {
        if (host.removed instanceof Error) throw host.removed;
        return host.removed;
    }),
    // The selection deleted, null on Cancel, or the error that refused it.
    deleteLoreSelectionAfterConfirm: vi.fn(async () => {
        if (host.deletedSelection instanceof Error) throw host.deletedSelection;
        return host.deletedSelection;
    }),
    KEYS: 'keys',
    VECTORS: 'vectors',
    BOTH_KINDS: ['keys', 'vectors'],
    chatBookLocks: vi.fn(() => host.status),
    booksToAdd: vi.fn(() => host.add),
    // Where the book was locked, or the error that stopped it.
    addLoreBookToChat: vi.fn(async () => {
        if (host.added instanceof Error) throw host.added;
        return host.added;
    }),
    storedCountsOfBooks: vi.fn(async () => host.counts),
    removableLoreBookNames: vi.fn(async bookNames => new Set(bookNames.filter(bookName => host.removable.has(bookName)))),
    // The switcher's two actions: a selection put in use here, or the error that refused it; a new selection made.
    useLoreSelectionHere: vi.fn(() => {
        if (host.useError) throw host.useError;
    }),
    newLoreSelectionHere: vi.fn(() => ({ id: 'made', name: 'Harbor Atlas 2' })),
    writingProblem: vi.fn(() => host.keyProblem),
    writeMissing: vi.fn(async () => host.outcome),
    deleteStored: vi.fn(async () => {
        if (host.deleted instanceof Error) throw host.deleted;
        return host.deleted;
    }),
    // The screen stays open until the test closes it.
    openLoreBaseSelection: vi.fn(() => new Promise((resolve, reject) => { host.screen = { resolve, reject }; })),
    isLoreBaseSwitchedOn: () => host.isOn,
    selectedLoreBookNames: () => host.selectedBooks,
    onLoreBaseSwitchChange: listener => { host.switchListener = listener; },
    onWritingRunChange: listener => { host.writingRunListener = listener; },
    onWritingProgress: listener => { host.writingProgressListener = listener; },
    onLoreBookChatLocksMoved: listener => { host.chatLocksMovedListener = listener; },
    // Tells the page, as saving the switch does.
    turnLoreBaseOff: vi.fn(() => { host.isOn = false; host.switchListener?.(false); }),
    // On, unless the user keeps Vector Storage's World Info search, with what the selection lacks.
    turnLoreBaseOn: vi.fn(async () => { host.isOn = host.willTurnOn; return { isOn: host.isOn, missing: host.turnOnMissing }; }),
}));

const {
    addLoreBookToChat, chatBookLocks, deleteLoreSelectionAfterConfirm, deleteStored, newLoreSelectionHere, openLoreBaseSelection,
    removeLoreBookAfterConfirm, storedCountsOfBooks, turnLoreBaseOff, turnLoreBaseOn, useLoreSelectionHere, writeMissing, writingProblem,
} = await import('../src/features/lorebase/index.js');
const { log } = await import('../src/sillytavern/log.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { bindLoreBaseBooksCard, refreshLoreBaseBooks } = await import('../src/features/settings-panel/lorebase-books-card.js');

const outcomeOf = fields => ({ keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null, ...fields });
// A book's counts as storedCountsOfBooks gives them: Harbor Atlas's, whose 2 selected entries LoreBase both decides.
const countsOf = fields => ({
    decidedCount: 2, keyCount: 0, vectorCount: 0, readyCount: 0, missingKeyCount: 0, missingVectorCount: 0, otherModelCount: 0, failedCount: 0,
    firstFailure: null, ...fields,
});
const HARBOR = {
    bookName: 'Harbor Atlas', selectedCount: 2, isLockedToChat: true, isLockedToCharacter: false, selections: [{ id: 'first', name: 'Harbor Atlas' }],
    selectionInUseId: 'first',
};
const KEEPER = { bookName: 'Keeper Notes', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, selections: [], selectionInUseId: null };
const rowsShown = () => [...document.querySelectorAll('#VectFox_lorebase_books .vfx-row')].map(row => `${row.querySelector('.vfx-row-name').textContent}: ${row.querySelector('.vfx-row-sub').textContent}`);
const opener = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-choose="${bookName}"]`);
const remover = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-remove="${bookName}"]`);
const unlinker = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-unlink="${bookName}"]`);

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    host.status = { hasChat: true, books: [HARBOR, KEEPER] };
    host.removable = new Set();
    host.isOn = true;
    host.willTurnOn = true;
    host.turnOnMissing = { missingCount: 0, missingKeyCount: 0, missingVectorCount: 0, decidedCount: 0, isWriting: false };
    host.keyProblem = null;
    host.outcome = outcomeOf({ keysWritten: 2, vectorsWritten: 2 });
    host.chatId = 'chat-harbor';
    host.isConfirmed = true;
    host.deleted = 311;
    host.selectedBooks = ['Harbor Atlas'];
    host.counts = new Map([['Harbor Atlas', countsOf({ keyCount: 2, vectorCount: 1, readyCount: 1, missingVectorCount: 1 })]]);
    host.add = { bookNames: ['Tide Tables', 'Voyage Log'], canAddToCharacter: true };
    host.added = { characterAvatar: 'keeper-orrin.png' };
    host.removed = { bookName: 'Harbor Atlas', keysDeleted: 2, partsDeleted: 5 };
    host.deletedSelection = { bookName: 'Harbor Atlas', selectionName: 'Night watch' };
    host.useError = null;
    bindLoreBaseBooksCard(host.settings);
});

const toggle = () => document.getElementById('VectFox_lorebase_enabled');
const flipSwitch = isChecked => {
    toggle().checked = isChecked;
    toggle().dispatchEvent(new Event('change'));
};
const generate = () => document.getElementById('VectFox_lorebase_generate_all');
const generateKeys = () => document.getElementById('VectFox_lorebase_generate_keys');
const generateVectors = () => document.getElementById('VectFox_lorebase_generate_vectors');
const generateButtons = () => [generateKeys(), generateVectors(), generate()];
const status = () => document.getElementById('VectFox_lorebase_books_status');
// Every LoreBase control on the books and model cards but the Generate buttons and the cards' own collapse and help buttons.
const freeControls = () => [...document.querySelectorAll('#VectFox_lorebase_books_card, #VectFox_lorebase_model_card')]
    .flatMap(card => [...card.querySelectorAll('button, input, select, textarea')])
    .filter(control => !control.id.startsWith('VectFox_lorebase_generate_') && !control.matches('.vfx-collapse, .vfx-help-toggle'));
const isNoticeShown = () => !document.getElementById('VectFox_lorebase_off_notice').hidden;

describe("LoreBase's switch", () => {
    it('shows off as saved, with the notice saying to choose entries and set up the model card first, and only the Generate buttons waiting', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        expect([toggle().checked, ...generateButtons().map(button => button.disabled), isNoticeShown()]).toEqual([false, true, true, true, true]);
        expect(document.getElementById('VectFox_lorebase_off_notice').textContent)
            .toContain('Choose entries and set up the LoreBase model card, then turn on Use LoreBase');
        expect(freeControls().length).toBeGreaterThan(4);
        expect(freeControls().filter(control => control.disabled)).toEqual([]);
    });

    it('opens the selection screen while it is off, so entries are chosen before LoreBase turns on', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        opener('Harbor Atlas').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Harbor Atlas', selectionId: null });
    });

    it('enables the Generate buttons and hides the notice once turned on', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(generateButtons().map(button => button.disabled)).toEqual([false, false, false]));
        expect(turnLoreBaseOn).toHaveBeenCalledTimes(1);
        expect([toggle().checked, isNoticeShown()]).toEqual([true, false]);
    });

    it('says to choose entries next when turned on with nothing selected in any lorebook, and nothing with a selection', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(turnLoreBaseOn).toHaveBeenCalledTimes(1));
        expect(status().hidden).toBe(true);

        host.isOn = false;
        host.selectedBooks = [];
        flipSwitch(true);
        await vi.waitFor(() => expect(status().textContent).toBe(
            'LoreBase is on, with nothing selected yet. Choose entries: when you close the selection screen, LoreBase asks to write the keys and vectors of the entries you turned on.'));
    });

    it('drops the call to choose entries once entries are chosen, and once LoreBase is turned off', async () => {
        const nothingSelected = 'LoreBase is on, with nothing selected yet. Choose entries: when you close the selection screen, LoreBase asks to write the keys and vectors of the entries you turned on.';
        const switchOnWithNothing = async () => {
            host.isOn = false;
            host.selectedBooks = [];
            flipSwitch(true);
            await vi.waitFor(() => expect(status().textContent).toBe(nothingSelected));
        };
        await refreshLoreBaseBooks();
        await switchOnWithNothing();
        opener('Harbor Atlas').click();
        host.selectedBooks = ['Harbor Atlas'];
        host.screen.resolve();
        await vi.waitFor(() => expect(status().hidden).toBe(true));

        await switchOnWithNothing();
        flipSwitch(false);
        expect([status().hidden, status().textContent]).toEqual([true, '']);
    });

    it("shows off again when the user keeps Vector Storage's World Info search, saying nothing of the selection", async () => {
        host.isOn = false;
        host.willTurnOn = false;
        host.selectedBooks = [];
        await refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(turnLoreBaseOn).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(toggle().checked).toBe(false));
        expect([generate().disabled, status().hidden]).toEqual([true, true]);
    });

    it("says what the selection lacks once the switch's question is answered, in place of the last run's line, and leaves a run it started its own line", async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        host.writingRunListener({ count: 358, outcome: outcomeOf({ keysWritten: 29, stopped: 329 }) });
        expect(status().textContent).toBe('Wrote the keys of 29 entries. Stopped before 329 entries.');
        // Leave off.
        host.willTurnOn = false;
        host.turnOnMissing = { missingCount: 358, missingKeyCount: 358, missingVectorCount: 358, decidedCount: 358, isWriting: false };
        flipSwitch(true);
        await vi.waitFor(() => expect(status().textContent)
            .toBe('358 selected entries have no keys, and 358 entries have no vectors yet. Turn on Use LoreBase to write them.'));
        expect(toggle().checked).toBe(false);
        // Write keys and vectors: the run's line stays.
        host.willTurnOn = true;
        host.turnOnMissing = { ...host.turnOnMissing, isWriting: true };
        turnLoreBaseOn.mockImplementationOnce(async () => {
            host.isOn = true;
            host.writingRunListener({ count: 358, outcome: null });
            return { isOn: true, missing: host.turnOnMissing };
        });
        flipSwitch(true);
        await vi.waitFor(() => expect(toggle().checked).toBe(true));
        expect(status().textContent).toBe('Writing what 358 selected entries lack; the progress panel counts them.');
        // Keys and vectors that could not be read, or LoreBase off Qdrant: the line goes, the notice having said why.
        host.isOn = false;
        host.willTurnOn = false;
        host.turnOnMissing = null;
        flipSwitch(true);
        await vi.waitFor(() => expect(status().hidden).toBe(true));
    });

    it('turns off from the switch, the Generate buttons waiting again', async () => {
        await refreshLoreBaseBooks();
        expect(generate().disabled).toBe(false);
        flipSwitch(false);
        expect(turnLoreBaseOff).toHaveBeenCalledTimes(1);
        expect([toggle().checked, ...generateButtons().map(button => button.disabled), isNoticeShown()]).toEqual([false, true, true, true, true]);
    });

    it("shows a change a reply's question made while the page is open", async () => {
        await refreshLoreBaseBooks();
        host.isOn = false;
        host.switchListener(false);
        expect([toggle().checked, generate().disabled]).toEqual([false, true]);
    });

    it('keeps every Generate button disabled while one runs, whatever the switch shows meanwhile', async () => {
        let finish;
        writeMissing.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await refreshLoreBaseBooks();
        generateVectors().click();
        await vi.waitFor(() => expect(writeMissing).toHaveBeenCalledTimes(1));
        host.switchListener(true);
        expect(generateButtons().map(button => button.disabled)).toEqual([true, true, true]);
        finish(host.outcome);
        await vi.waitFor(() => expect(generateButtons().map(button => button.disabled)).toEqual([false, false, false]));
    });
});

describe('the LoreBase books card', () => {
    it("draws the open chat's books, and draws them again for the next chat", async () => {
        await refreshLoreBaseBooks();
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected, 2 with keys, 1 with vectors', 'Keeper Notes: Nothing selected']);
        host.status = { hasChat: false, books: [] };
        await refreshLoreBaseBooks();
        expect(rowsShown()).toEqual([]);
        expect(document.getElementById('VectFox_lorebase_books').textContent.trim()).toBe('Open a chat to see the lorebooks it loads.');
    });

    // SillyTavern opens the renamed chat (CHAT_CHANGED) before CHAT_RENAMED, so the list was drawn with the lock on the old name.
    it('draws the list again once a chat rename moved a selection\'s lock to the new name', async () => {
        host.status = { hasChat: true, books: [{ ...HARBOR, selectedCount: 0, isLockedToChat: false, selectionInUseId: null }, KEEPER] };
        await refreshLoreBaseBooks();
        expect(rowsShown()[0]).toBe('Harbor Atlas: Nothing selected');

        host.status = { hasChat: true, books: [HARBOR, KEEPER] };
        host.chatLocksMovedListener();
        await vi.waitFor(() => expect(rowsShown()[0]).toBe('Harbor Atlas: 2 selected, 2 with keys, 1 with vectors'));
    });

    it('opens the selection screen on the book a row names, and draws the list again once the screen closes', async () => {
        await refreshLoreBaseBooks();
        opener('Keeper Notes').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Keeper Notes', selectionId: null });
        host.status = { hasChat: true, books: [HARBOR, { ...KEEPER, selectedCount: 3, isLockedToCharacter: true }] };
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected, 2 with keys, 1 with vectors', 'Keeper Notes: Nothing selected']);

        host.screen.resolve();
        await vi.waitFor(() => expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected, 2 with keys, 1 with vectors', 'Keeper Notes: 3 selected']));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
    });

    it('counts the keys and vectors of the books with a selection, through the settings the card was bound with', async () => {
        await refreshLoreBaseBooks();
        expect(storedCountsOfBooks).toHaveBeenCalledWith([{ bookName: 'Harbor Atlas', selectionId: 'first' }], host.settings);
        host.status = { hasChat: true, books: [KEEPER] };
        await refreshLoreBaseBooks();
        expect(storedCountsOfBooks).toHaveBeenCalledTimes(1);
    });

    it("offers Remove from LoreBase on the rows of the books LoreBase holds anything of, as the Database Browser lists them, read after the list is drawn", async () => {
        host.removable = new Set(['Keeper Notes']);
        await refreshLoreBaseBooks();
        const { removableLoreBookNames } = await import('../src/features/lorebase/index.js');
        expect(removableLoreBookNames).toHaveBeenLastCalledWith(['Harbor Atlas', 'Keeper Notes'], host.settings);
        expect([remover('Harbor Atlas'), remover('Keeper Notes')?.title]).toEqual([null, 'Remove from LoreBase']);
    });

    it('keeps the rows without counts when the keys and vectors cannot be read, and logs why', async () => {
        const failure = new Error('Similharity could not read LoreBase\'s keys (HTTP 500)');
        storedCountsOfBooks.mockRejectedValueOnce(failure);
        await refreshLoreBaseBooks();
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be counted'), failure);
    });

    it('says what the selection lacks once the screen closes, and the Generate button that writes it while LoreBase is on, and drops the line with nothing selected', async () => {
        const status = () => document.getElementById('VectFox_lorebase_books_status');
        const closeWith = async chosen => {
            opener('Harbor Atlas').click();
            host.screen.resolve(chosen);
            await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalled());
            await Promise.resolve();
        };
        await refreshLoreBaseBooks();
        const lacking = (missingKeyCount, missingVectorCount, fields = {}) => ({
            missingCount: Math.max(missingKeyCount, missingVectorCount), missingKeyCount, missingVectorCount, decidedCount: 313, isWriting: false, ...fields,
        });
        await closeWith(lacking(0, 0));
        await vi.waitFor(() => expect(status().textContent).toBe('All 313 selected entries have keys and vectors.'));
        await closeWith(lacking(12, 5));
        const twelveAndFive = '12 selected entries have no keys, and 5 entries have no vectors yet. LoreBase leaves them out until Generate all writes them.';
        await vi.waitFor(() => expect(status().textContent).toBe(twelveAndFive));
        // A run the screen's question started writes its own lines.
        await closeWith(lacking(12, 5, { isWriting: true }));
        expect(status().textContent).toBe(twelveAndFive);
        // Lacking one kind names its own Generate button, one entry as one.
        await closeWith(lacking(3, 0));
        await vi.waitFor(() => expect(status().textContent).toBe('3 selected entries have no keys yet. LoreBase leaves them out until Generate keys writes them.'));
        await closeWith(lacking(0, 1));
        await vi.waitFor(() => expect(status().textContent).toBe('1 selected entry has no vectors yet. LoreBase leaves it out until Generate vectors writes them.'));
        // While LoreBase is off, turning it on writes them.
        host.isOn = false;
        await closeWith(lacking(0, 1));
        await vi.waitFor(() => expect(status().textContent).toBe('1 selected entry has no vectors yet. Turn on Use LoreBase to write them.'));
        // Every entry unselected while LoreBase is off: the line goes.
        host.isOn = false;
        await closeWith({ ...lacking(0, 0), decidedCount: 0 });
        await vi.waitFor(() => expect(status().hidden).toBe(true));
        // Unselected while it is on: the call to choose entries.
        host.isOn = true;
        host.selectedBooks = [];
        await closeWith({ ...lacking(0, 0), decidedCount: 0 });
        await vi.waitFor(() => expect(status().textContent).toBe(
            'LoreBase is on, with nothing selected yet. Choose entries: when you close the selection screen, LoreBase asks to write the keys and vectors of the entries you turned on.'));
        // Keys and vectors that could not be read: the line goes, the screen's notice having said why.
        await closeWith(null);
        await vi.waitFor(() => expect(status().hidden).toBe(true));
    });

    it('draws only the newest refresh, so a slow load never draws a chat left since', async () => {
        let finishFirst;
        chatBookLocks.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
        const first = refreshLoreBaseBooks();
        host.status = { hasChat: true, books: [KEEPER] };
        await refreshLoreBaseBooks();
        finishFirst({ hasChat: true, books: [HARBOR, KEEPER] });
        await first;
        expect(rowsShown()).toEqual(['Keeper Notes: Nothing selected']);
    });

    it('logs a list that could not be drawn, and keeps the page', async () => {
        const failure = new Error('no lorebooks');
        chatBookLocks.mockRejectedValueOnce(failure);
        await refreshLoreBaseBooks();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('book list could not be drawn'), failure);
    });

    it("opens the screen on the chat's first book from the card's own button", () => {
        document.querySelector('#VectFox_lorebase_books_card .vfx-card-body > .vfx-control-row [data-lorebase-choose]').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: '', selectionId: null });
    });

    it('logs a screen that failed, and still draws the list again', async () => {
        await refreshLoreBaseBooks();
        opener('Harbor Atlas').click();
        const failure = new Error('no dialog');
        host.screen.reject(failure);

        await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining('selection screen'), failure));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
    });
});

describe('Add a lorebook', () => {
    const bookList = () => document.getElementById('VectFox_lorebase_add_book');
    const addButtons = () => [...document.querySelectorAll('#VectFox_lorebase_books [data-lorebase-add]')];
    const addTo = (place, bookName) => {
        bookList().value = bookName;
        addButtons().find(button => button.dataset.lorebaseAdd === place).click();
    };

    it('lists the books the chat does not load under its books, with a button for each place, this chat first, and this chat alone in a group chat', async () => {
        await refreshLoreBaseBooks();
        expect([...bookList().options].map(option => `${option.value}: ${option.textContent}`))
            .toEqual([': Choose a lorebook', 'Tide Tables: Tide Tables', 'Voyage Log: Voyage Log']);
        expect(addButtons().map(button => `${button.dataset.lorebaseAdd}: ${button.textContent.trim()}`))
            .toEqual(['chat: Add to this chat', 'character: Add to this character']);

        host.add = { bookNames: ['Voyage Log'], canAddToCharacter: false };
        await refreshLoreBaseBooks();
        expect(addButtons().map(button => button.dataset.lorebaseAdd)).toEqual(['chat']);

        host.add = { bookNames: [], canAddToCharacter: true };
        await refreshLoreBaseBooks();
        expect(bookList()).toBeNull();
        expect(document.getElementById('VectFox_lorebase_books').textContent).toContain('This chat loads every lorebook you have.');
    });

    it('says to choose a lorebook first, adding nothing', async () => {
        await refreshLoreBaseBooks();
        addTo('character', '');
        expect(status().textContent).toBe('Choose a lorebook to add first.');
        expect(addLoreBookToChat).not.toHaveBeenCalled();
    });

    it('adds the chosen book to this character, says so, draws the list again and opens the selection screen on it, keeping the line once the screen closes with nothing to say', async () => {
        await refreshLoreBaseBooks();
        let finishAdding;
        addLoreBookToChat.mockImplementationOnce(() => new Promise(resolve => { finishAdding = resolve; }));
        addTo('character', 'Voyage Log');
        expect(addLoreBookToChat).toHaveBeenCalledWith('Voyage Log', 'character');
        // The Add buttons wait while it is added.
        expect(addButtons().every(button => button.disabled)).toBe(true);

        finishAdding({ characterAvatar: 'keeper-orrin.png' });
        await vi.waitFor(() => expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Voyage Log', selectionId: null }));
        const added = 'Added "Voyage Log" to this character, and locked it to the character.';
        expect(status().textContent).toBe(added);
        expect(chatBookLocks).toHaveBeenCalledTimes(2);

        // Nothing chosen with LoreBase off: the screen says nothing of the selection, so the line stays.
        host.isOn = false;
        host.screen.resolve({ missingCount: 0, missingKeyCount: 0, missingVectorCount: 0, decidedCount: 0, isWriting: false });
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(status().textContent).toBe(added));
        expect(status().hidden).toBe(false);
    });

    it('adds the chosen book to this chat, locked to this chat, saying it loads while LoreBase is on, a line that goes once another chat is open', async () => {
        host.added = { chatId: 'chat-harbor' };
        await refreshLoreBaseBooks();
        addTo('chat', 'Tide Tables');
        expect(addLoreBookToChat).toHaveBeenCalledWith('Tide Tables', 'chat');
        await vi.waitFor(() => expect(status().textContent).toBe('Added "Tide Tables" to this chat, and locked it to this chat. It loads while LoreBase is on.'));
        host.screen.resolve(null);
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(3));

        host.chatId = 'chat-other';
        await refreshLoreBaseBooks();
        expect(status().hidden).toBe(true);
    });

    it('says why a book was not added, logs it, opens no screen, and lets the buttons be pressed again', async () => {
        const failure = new Error('SillyTavern did not add "Voyage Log" to this character\'s lorebooks.');
        host.added = failure;
        await refreshLoreBaseBooks();
        addTo('character', 'Voyage Log');
        await vi.waitFor(() => expect(status().textContent).toBe(`Not added: ${failure.message}`));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"Voyage Log" was not added'), failure);
        expect(openLoreBaseSelection).not.toHaveBeenCalled();
        expect(addButtons().some(button => button.disabled)).toBe(false);
    });
});

describe('the Generate buttons and Delete all', () => {
    const remove = () => document.getElementById('VectFox_lorebase_delete_all');

    beforeEach(() => refreshLoreBaseBooks());

    it('shows no status line until a button has run', () => {
        expect(status().hidden).toBe(true);
    });

    it('Generate all writes the missing keys and vectors of every selection and says how many', async () => {
        generate().click();
        expect(generate().disabled).toBe(true);
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the keys of 2 entries and the vectors of 2 entries.'));
        expect(writeMissing).toHaveBeenCalledWith(host.settings, ['keys', 'vectors']);
        expect(writingProblem).toHaveBeenCalledWith(host.settings, ['keys', 'vectors']);
        expect([status().hidden, generate().disabled]).toEqual([false, false]);
    });

    it('Generate all names the entries that failed or were stopped and the books it could not read, or that none was missing', async () => {
        host.outcome = outcomeOf({ vectorsWritten: 3, failed: 1, stopped: 5, unreadBooks: 2 });
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the vectors of 3 entries. 1 entry failed, as the toast says. '
            + 'Stopped before 5 entries. 2 lorebooks could not be read; the console says why.'));
        host.outcome = outcomeOf({ failed: 2 });
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote no keys or vectors. 2 entries failed, as the toast says.'));
        host.outcome = outcomeOf({});
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe('No selected entry was missing keys or vectors.'));
    });

    it('Generate all writes nothing when keys cannot be written, and says why', async () => {
        host.keyProblem = 'LoreBase keeps the keys its model writes for each entry in Qdrant. Choose Qdrant as the vector backend first.';
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not written: ${host.keyProblem}`));
        expect(writeMissing).not.toHaveBeenCalled();
    });

    it('Generate keys and Generate vectors write one kind each, and say when no entry was missing it', async () => {
        host.outcome = outcomeOf({});
        generateKeys().click();
        expect(status().textContent).toBe('Counting the selected entries without keys.');
        await vi.waitFor(() => expect(status().textContent).toBe('No selected entry was missing keys.'));
        expect(writeMissing).toHaveBeenLastCalledWith(host.settings, ['keys']);
        expect(writingProblem).toHaveBeenLastCalledWith(host.settings, ['keys']);

        generateVectors().click();
        expect(status().textContent).toBe('Counting the selected entries without vectors.');
        await vi.waitFor(() => expect(status().textContent).toBe('No selected entry was missing vectors.'));
        expect(writeMissing).toHaveBeenLastCalledWith(host.settings, ['vectors']);
        host.outcome = outcomeOf({ vectorsWritten: 21 });
        generateVectors().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the vectors of 21 entries.'));
    });

    it('a Generate button that fails says Not written, with the reason, and logs it by its name', async () => {
        const failure = new Error('LoreBase is already writing keys or vectors; the progress panel shows them.');
        writeMissing.mockRejectedValueOnce(failure);
        generateVectors().click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not written: ${failure.message}`));
        expect(log.error).toHaveBeenCalledWith('LoreBase: Generate vectors failed:', failure);
        expect(generateVectors().disabled).toBe(false);
    });

    it('Delete all asks first, opening on Cancel, and deletes nothing when the user cancels', async () => {
        host.isConfirmed = false;
        remove().click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(confirmPopup.mock.calls[0][1]).toEqual({ okButton: 'Delete all', isDestructive: true });
        expect(confirmPopup.mock.calls[0][0][0].text).toBe('Delete every LoreBase key and vector you have, in every lorebook?');
        expect(confirmPopup.mock.calls[0][0].map(line => line.text).join(' ')).toContain('Keys you edited by hand are lost.');
        await Promise.resolve();
        expect(deleteStored).not.toHaveBeenCalled();
        expect(turnLoreBaseOff).not.toHaveBeenCalled();
        expect([status().hidden, toggle().checked]).toEqual([true, true]);
    });

    const deletedText = 'Deleted the keys of 311 entries and every vector: no entry has either now, and Use LoreBase is off. Turn it on to write them again.';

    it('Delete all deletes every key and vector once confirmed, turns LoreBase off, and says so', async () => {
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(deletedText));
        expect(confirmPopup.mock.calls[0][0].map(line => line.text).join(' ')).toContain('Use LoreBase turns off');
        expect(deleteStored).toHaveBeenCalledWith(['keys', 'vectors'], host.settings);
        expect(turnLoreBaseOff).toHaveBeenCalledTimes(1);
        expect([toggle().checked, generate().disabled, isNoticeShown(), remove().disabled]).toEqual([false, true, true, false]);
    });

    it('Delete all while LoreBase is off leaves it off, and says the same', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(deletedText));
        expect(turnLoreBaseOff).not.toHaveBeenCalled();
    });

    it('shows what turning LoreBase on writes in place of the delete: the entries being written, one as one, then what was written', async () => {
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(deletedText));
        host.writingRunListener({ count: 311, outcome: null });
        expect(status().textContent).toBe('Writing what 311 selected entries lack; the progress panel counts them.');
        host.writingRunListener({ count: 311, outcome: outcomeOf({ keysWritten: 309, vectorsWritten: 309, failed: 2 }) });
        expect(status().textContent).toBe('Wrote the keys of 309 entries and the vectors of 309 entries. 2 entries failed, as the toast says.');
        host.writingRunListener({ count: 1, outcome: null });
        expect(status().textContent).toBe('Writing what 1 selected entry lacks; the progress panel counts it.');
    });

    it('names the books a run locked to this chat, draws the list again, and drops the line once another chat is open', async () => {
        host.outcome = outcomeOf({ keysWritten: 313, chatLock: { chatId: 'chat-harbor', bookNames: ['Harbor Atlas'] } });
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the keys of 313 entries. Locked "Harbor Atlas" to this chat.'));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
        host.writingRunListener({
            count: 4,
            outcome: outcomeOf({ keysWritten: 4, chatLock: { chatId: 'chat-harbor', bookNames: ['Harbor Atlas', 'Keeper Notes', 'Tide Tables'] } }),
        });
        expect(status().textContent).toBe('Wrote the keys of 4 entries. Locked "Harbor Atlas", "Keeper Notes", and "Tide Tables" to this chat.');

        await refreshLoreBaseBooks();
        expect(status().hidden).toBe(false);
        host.chatId = 'chat-wren';
        await refreshLoreBaseBooks();
        expect([status().hidden, status().textContent]).toEqual([true, '']);
    });

    it('says a run that ends in another chat locked its books to the chat open when the writing began, and keeps that line', async () => {
        host.chatId = 'chat-wren';
        host.writingRunListener({
            count: 2,
            outcome: outcomeOf({ keysWritten: 2, chatLock: { chatId: 'chat-harbor', bookNames: ['Harbor Atlas', 'Keeper Notes'] } }),
        });
        expect(status().textContent).toBe('Wrote the keys of 2 entries. Locked "Harbor Atlas" and "Keeper Notes" to the chat open when the writing began.');
        host.chatId = 'chat-harbor';
        await refreshLoreBaseBooks();
        expect(status().hidden).toBe(false);
    });

    it('a delete that fails says Not deleted, with the reason, logs it, and leaves LoreBase on', async () => {
        host.deleted = new Error('LoreBase is still writing keys or vectors; the progress panel shows them.');
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Not deleted: LoreBase is still writing keys or vectors; the progress panel shows them.'));
        expect(log.warn).toHaveBeenCalledWith('LoreBase: Delete all failed:', host.deleted);
        expect(turnLoreBaseOff).not.toHaveBeenCalled();
        expect(toggle().checked).toBe(true);
    });
});

describe("each book's state on the card (§7.1 of lorebook-multi-vector.md)", () => {
    const LOCK_PILLS = ['Locked to this chat', 'Locked to this character', 'Not locked'];
    const stateOf = bookName => {
        const row = [...document.querySelectorAll('#VectFox_lorebase_books .vfx-row')].find(candidate => candidate.querySelector('.vfx-row-name').textContent === bookName);
        return [...row.querySelectorAll('.vfx-pill')].map(pill => pill.textContent.trim()).find(text => !LOCK_PILLS.includes(text)) ?? null;
    };

    it('shows the writing run on the row of the book it writes now, then the counts read again once the run ends', async () => {
        await refreshLoreBaseBooks();
        expect(stateOf('Harbor Atlas')).toBe('1 need vectors');
        const addList = document.getElementById('VectFox_lorebase_add_book');
        addList.value = 'Voyage Log';
        host.writingProgressListener({ bookName: 'Harbor Atlas', kind: 'vectors', done: 0, total: 1 });
        expect(stateOf('Harbor Atlas')).toBe('Vectorizing, 0 of 1');
        host.writingProgressListener({ bookName: 'Keeper Notes', kind: 'keys', done: 1, total: 3 });
        expect(stateOf('Harbor Atlas')).toBe('1 need vectors');
        // Only the rows are drawn again as the run moves, so a lorebook being chosen to add stays chosen.
        expect([document.getElementById('VectFox_lorebase_add_book'), addList.value]).toEqual([addList, 'Voyage Log']);
        host.counts = new Map([['Harbor Atlas', countsOf({ keyCount: 2, vectorCount: 2, readyCount: 2 })]]);
        host.writingRunListener({ count: 1, outcome: outcomeOf({ vectorsWritten: 1 }) });
        host.writingProgressListener(null);
        await vi.waitFor(() => expect(stateOf('Harbor Atlas')).toBe('Ready'));
        expect(storedCountsOfBooks).toHaveBeenCalledTimes(2);
    });

    it("keeps a row's state while the same chat's list is drawn again, until the new counts are read, and drops it when they cannot be", async () => {
        await refreshLoreBaseBooks();
        let answerCounts;
        storedCountsOfBooks.mockImplementationOnce(() => new Promise(resolve => { answerCounts = resolve; }));
        const refreshing = refreshLoreBaseBooks();
        await vi.waitFor(() => expect(storedCountsOfBooks).toHaveBeenCalledTimes(2));
        expect(stateOf('Harbor Atlas')).toBe('1 need vectors');
        answerCounts(new Map([['Harbor Atlas', countsOf({ keyCount: 2, vectorCount: 2, readyCount: 2 })]]));
        await refreshing;
        expect(stateOf('Harbor Atlas')).toBe('Ready');
        storedCountsOfBooks.mockRejectedValueOnce(new Error('Similharity is down'));
        await refreshLoreBaseBooks();
        expect(stateOf('Harbor Atlas')).toBeNull();
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);
    });
});

describe('Remove from LoreBase and Unlink on a book row', () => {
    const WRITING = 'LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.';

    beforeEach(() => {
        host.status = { hasChat: true, books: [{ ...HARBOR, canUnlink: true }, { ...KEEPER, canUnlink: false }] };
        host.removable = new Set(['Harbor Atlas']);
    });

    it('removes the book from LoreBase once confirmed, unlinking nothing, says what went, and draws the list again', async () => {
        await refreshLoreBaseBooks();
        expect(remover('Keeper Notes')).toBeNull();
        chatBookLocks.mockClear();
        remover('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe('Removed "Harbor Atlas" from LoreBase, with the keys of 2 entries and the vectors of 5 parts.'));
        expect(removeLoreBookAfterConfirm).toHaveBeenCalledWith('Harbor Atlas', host.settings, { shouldUnlink: false });
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(1));
    });

    it('unlinks the book once confirmed, removing it from LoreBase too, says both, and draws the list again', async () => {
        host.removed = { bookName: 'Harbor Atlas', keysDeleted: 2, partsDeleted: 5, unlinkedFrom: ['chatBook'], stillLoadedBy: [] };
        await refreshLoreBaseBooks();
        expect(unlinker('Keeper Notes')).toBeNull();
        chatBookLocks.mockClear();
        unlinker('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe('Unlinked "Harbor Atlas" from this chat\'s Chat Lorebook, and removed it from '
            + 'LoreBase, with the keys of 2 entries and the vectors of 5 parts.'));
        expect(removeLoreBookAfterConfirm).toHaveBeenCalledWith('Harbor Atlas', host.settings, { shouldUnlink: true });
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(1));
    });

    it('says nothing on Cancel, and why when it is refused', async () => {
        host.removed = null;
        await refreshLoreBaseBooks();
        remover('Harbor Atlas').click();
        unlinker('Harbor Atlas').click();
        await vi.waitFor(() => expect(removeLoreBookAfterConfirm).toHaveBeenCalledTimes(2));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(status().textContent).toBe('');

        host.removed = new Error(WRITING);
        remover('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not removed: ${WRITING}`));
        unlinker('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not unlinked: ${WRITING}`));
    });
});

describe('the trash on a book row whose dropdown shows one of its several selections', () => {
    const TWO = [{ id: 'first', name: 'Harbor Atlas' }, { id: 'night', name: 'Night watch' }];
    const selectionTrash = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-delete-selection="${bookName}"]`);

    beforeEach(() => {
        host.status = { hasChat: true, books: [{ ...HARBOR, selections: TWO, selectionInUseId: 'night' }] };
        host.removable = new Set(['Harbor Atlas']);
    });

    it('deletes that selection alone once confirmed, never the book, says so, and draws the list again', async () => {
        await refreshLoreBaseBooks();
        expect(remover('Harbor Atlas')).toBeNull();
        chatBookLocks.mockClear();
        selectionTrash('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe('Deleted the selection "Night watch" of "Harbor Atlas". Its other selections stay.'));
        expect(deleteLoreSelectionAfterConfirm).toHaveBeenCalledWith('Harbor Atlas', 'night', host.settings);
        expect(removeLoreBookAfterConfirm).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(1));
    });

    it('says nothing on Cancel, and why when it is refused', async () => {
        host.deletedSelection = null;
        await refreshLoreBaseBooks();
        selectionTrash('Harbor Atlas').click();
        await vi.waitFor(() => expect(deleteLoreSelectionAfterConfirm).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(status().textContent).toBe('');

        const refusal = '"Night watch" is the only selection of "Harbor Atlas": Remove from LoreBase removes the book.';
        host.deletedSelection = new Error(refusal);
        selectionTrash('Harbor Atlas').click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not deleted: ${refusal}`));
    });
});

describe("Selection in use here (§1.2 of vectfox-multi-collection-per-chat.md)", () => {
    const switcherOf = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-in-use="${bookName}"]`);
    const choose = (bookName, value) => {
        switcherOf(bookName).value = value;
        switcherOf(bookName).dispatchEvent(new Event('change', { bubbles: true }));
    };
    const TWO_SELECTIONS = [{ id: 'first', name: 'Harbor Atlas' }, { id: 'night', name: 'Night watch' }];

    beforeEach(() => {
        host.status = { hasChat: true, books: [{ ...HARBOR, selections: TWO_SELECTIONS }, { ...KEEPER, selections: [{ id: 'k1', name: 'Keeper Notes' }], selectionInUseId: null }] };
    });

    it("leads a book's row with its selections, the one in use here chosen, then New selection; with none in use, None in use here", async () => {
        await refreshLoreBaseBooks();
        expect([...switcherOf('Harbor Atlas').options].map(option => [option.value, option.textContent, option.selected])).toEqual([
            ['first', 'Harbor Atlas', true], ['night', 'Night watch', false], ['+new', 'New selection', false],
        ]);
        expect(switcherOf('Harbor Atlas').title).toBe('Selection in use here');
        expect(switcherOf('Harbor Atlas').closest('.vfx-row-actions').firstElementChild).toBe(switcherOf('Harbor Atlas'));
        expect([...switcherOf('Keeper Notes').options].map(option => [option.value, option.textContent, option.selected])).toEqual([
            ['', 'None in use here', true], ['k1', 'Keeper Notes', false], ['+new', 'New selection', false],
        ]);
    });

    it('draws None in use here and New selection for a book with no selection, as after its trash, whose New selection makes its first and opens the screen on it', async () => {
        host.status = { hasChat: true, books: [KEEPER] };
        await refreshLoreBaseBooks();
        expect([...switcherOf('Keeper Notes').options].map(option => [option.value, option.textContent, option.selected])).toEqual([
            ['', 'None in use here', true], ['+new', 'New selection', false],
        ]);
        newLoreSelectionHere.mockReturnValueOnce({ id: 'first-made', name: 'Keeper Notes' });
        choose('Keeper Notes', '+new');
        expect(newLoreSelectionHere).toHaveBeenCalledWith('Keeper Notes');
        expect(status().textContent).toBe('Made "Keeper Notes" and put it in use in this chat.');
        await vi.waitFor(() => expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Keeper Notes', selectionId: 'first-made' }));
    });

    it('puts the selection chosen in use in this chat, says so, draws the list again, and drops the line once another chat is open', async () => {
        await refreshLoreBaseBooks();
        chatBookLocks.mockClear();
        choose('Harbor Atlas', 'night');
        expect(useLoreSelectionHere).toHaveBeenCalledWith('Harbor Atlas', 'night');
        expect(status().textContent).toBe('"Night watch" is in use in this chat now.');
        await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalledTimes(1));

        host.chatId = 'chat-other';
        await refreshLoreBaseBooks();
        expect(status().hidden).toBe(true);
    });

    it('makes a new selection with New selection, says so, opens the selection screen on it, and drops the line once another chat is open', async () => {
        await refreshLoreBaseBooks();
        choose('Harbor Atlas', '+new');
        expect(newLoreSelectionHere).toHaveBeenCalledWith('Harbor Atlas');
        expect(status().textContent).toBe('Made "Harbor Atlas 2" and put it in use in this chat.');
        await vi.waitFor(() => expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Harbor Atlas', selectionId: 'made' }));
        expect(useLoreSelectionHere).not.toHaveBeenCalled();

        host.chatId = 'chat-other';
        await refreshLoreBaseBooks();
        expect(status().hidden).toBe(true);
    });

    it('says why nothing changed when the selection could not be put in use', async () => {
        await refreshLoreBaseBooks();
        host.useError = new Error('Open a chat to choose the selection it uses.');
        choose('Harbor Atlas', 'night');
        expect(status().textContent).toBe('Not changed: Open a chat to choose the selection it uses.');
        expect(log.warn).toHaveBeenCalledWith('LoreBase: the selection in use of lorebook "Harbor Atlas" was not changed:', host.useError);
    });
});
