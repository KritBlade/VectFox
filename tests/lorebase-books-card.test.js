/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase controls (src/features/settings-panel/lorebase-books-card.js, plan §5.2 and §5.9 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): LoreBase's switch shows as saved; while
 * it is off the user still chooses entries and sets the model, a notice says to do that first, and only Generate all
 * waits; turning it on can end off when the user keeps Vector Storage's World Info search, and with nothing selected
 * anywhere the status line says to choose entries next. The books card draws the open chat's books, opens the selection
 * screen on the book a row names or, from the card's own button, on the chat's first book, and draws the list again
 * once the screen closes, a screen that failed included, saying what the selection lacks. Generate all writes the
 * missing keys and vectors, or says why it cannot; Delete all asks first, and once it has deleted both turns LoreBase
 * off; the status line says how each went, and names the books a writing run locked to its chat (§4.3 and §6.1 of
 * InternalProject/Vectfox/plans/lorebook-multi-vector.md), "this chat" while it is open, a line that goes once another
 * chat is open.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    status: null, screen: null, isOn: true, willTurnOn: true, switchListener: null, writingRunListener: null, selectedBooks: [],
    settings: { vector_backend: 'qdrant' }, keyProblem: null, outcome: null, isConfirmed: true, deleted: null, chatId: null,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.isConfirmed) }));
vi.mock('../src/sillytavern/chat.js', () => ({ getCurrentChatId: () => host.chatId }));
vi.mock('../src/features/lorebase/index.js', () => ({
    chatBookLocks: vi.fn(() => host.status),
    keyWritingProblem: vi.fn(() => host.keyProblem),
    writeKeysAndVectorsOfSelections: vi.fn(async () => host.outcome),
    deleteAllKeysAndVectors: vi.fn(async () => {
        if (host.deleted instanceof Error) throw host.deleted;
        return host.deleted;
    }),
    // The screen stays open until the test closes it.
    openLoreBaseSelection: vi.fn(() => new Promise((resolve, reject) => { host.screen = { resolve, reject }; })),
    isLoreBaseSwitchedOn: () => host.isOn,
    selectedLoreBookNames: () => host.selectedBooks,
    onLoreBaseSwitchChange: listener => { host.switchListener = listener; },
    onWritingRunChange: listener => { host.writingRunListener = listener; },
    // Tells the page, as saving the switch does.
    turnLoreBaseOff: vi.fn(() => { host.isOn = false; host.switchListener?.(false); }),
    // On, unless the user keeps Vector Storage's World Info search.
    turnLoreBaseOn: vi.fn(async () => { host.isOn = host.willTurnOn; return host.isOn; }),
}));

const {
    chatBookLocks, deleteAllKeysAndVectors, openLoreBaseSelection, turnLoreBaseOff, turnLoreBaseOn, writeKeysAndVectorsOfSelections,
} = await import('../src/features/lorebase/index.js');
const { log } = await import('../src/sillytavern/log.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { bindLoreBaseBooksCard, refreshLoreBaseBooks } = await import('../src/features/settings-panel/lorebase-books-card.js');

const outcomeOf = fields => ({ keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks: 0, chatLock: null, ...fields });
const HARBOR = { bookName: 'Harbor Atlas', selectedCount: 2, isLockedToChat: true, isLockedToCharacter: false };
const KEEPER = { bookName: 'Keeper Notes', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false };
const rowsShown = () => [...document.querySelectorAll('#VectFox_lorebase_books .vfx-row')].map(row => `${row.querySelector('.vfx-row-name').textContent}: ${row.querySelector('.vfx-row-sub').textContent}`);
const opener = bookName => document.querySelector(`#VectFox_lorebase_books_card [data-lorebase-choose="${bookName}"]`);

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    host.status = { hasChat: true, books: [HARBOR, KEEPER] };
    host.isOn = true;
    host.willTurnOn = true;
    host.keyProblem = null;
    host.outcome = outcomeOf({ keysWritten: 2, vectorsWritten: 2 });
    host.chatId = 'chat-harbor';
    host.isConfirmed = true;
    host.deleted = 311;
    host.selectedBooks = ['Harbor Atlas'];
    bindLoreBaseBooksCard(host.settings);
});

const toggle = () => document.getElementById('VectFox_lorebase_enabled');
const flipSwitch = isChecked => {
    toggle().checked = isChecked;
    toggle().dispatchEvent(new Event('change'));
};
const generate = () => document.getElementById('VectFox_lorebase_generate_all');
const status = () => document.getElementById('VectFox_lorebase_books_status');
// Every LoreBase control on the books and model cards but Generate all and the cards' own collapse and help buttons.
const freeControls = () => [...document.querySelectorAll('#VectFox_lorebase_books_card, #VectFox_lorebase_model_card')]
    .flatMap(card => [...card.querySelectorAll('button, input, select, textarea')])
    .filter(control => control.id !== 'VectFox_lorebase_generate_all' && !control.matches('.vfx-collapse, .vfx-help-toggle'));
const isNoticeShown = () => !document.getElementById('VectFox_lorebase_off_notice').hidden;

describe("LoreBase's switch", () => {
    it('shows off as saved, with the notice saying to choose entries and set the model first, and only Generate all waiting', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        expect([toggle().checked, generate().disabled, isNoticeShown()]).toEqual([false, true, true]);
        expect(document.getElementById('VectFox_lorebase_off_notice').textContent).toContain('Choose entries and set LoreBase');
        expect(freeControls().length).toBeGreaterThan(4);
        expect(freeControls().filter(control => control.disabled)).toEqual([]);
    });

    it('opens the selection screen while it is off, so entries are chosen before LoreBase turns on', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        opener('Harbor Atlas').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Harbor Atlas' });
    });

    it('enables Generate all and hides the notice once turned on', async () => {
        host.isOn = false;
        await refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(generate().disabled).toBe(false));
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
            'LoreBase is on, with nothing selected yet. Choose entries: each one you turn on has its keys and vectors written then.'));
    });

    it('drops the call to choose entries once entries are chosen, and once LoreBase is turned off', async () => {
        const nothingSelected = 'LoreBase is on, with nothing selected yet. Choose entries: each one you turn on has its keys and vectors written then.';
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

    it('turns off from the switch, Generate all waiting again', async () => {
        await refreshLoreBaseBooks();
        expect(generate().disabled).toBe(false);
        flipSwitch(false);
        expect(turnLoreBaseOff).toHaveBeenCalledTimes(1);
        expect([toggle().checked, generate().disabled, isNoticeShown()]).toEqual([false, true, true]);
    });

    it("shows a change a reply's question made while the page is open", async () => {
        await refreshLoreBaseBooks();
        host.isOn = false;
        host.switchListener(false);
        expect([toggle().checked, generate().disabled]).toEqual([false, true]);
    });

    it('keeps Generate all disabled while it runs, whatever the switch shows meanwhile', async () => {
        let finish;
        writeKeysAndVectorsOfSelections.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await refreshLoreBaseBooks();
        generate().click();
        await vi.waitFor(() => expect(writeKeysAndVectorsOfSelections).toHaveBeenCalledTimes(1));
        host.switchListener(true);
        expect(generate().disabled).toBe(true);
        finish(host.outcome);
        await vi.waitFor(() => expect(generate().disabled).toBe(false));
    });
});

describe('the LoreBase books card', () => {
    it("draws the open chat's books, and draws them again for the next chat", async () => {
        await refreshLoreBaseBooks();
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);
        host.status = { hasChat: false, books: [] };
        await refreshLoreBaseBooks();
        expect(rowsShown()).toEqual([]);
        expect(document.getElementById('VectFox_lorebase_books').textContent.trim()).toBe('Open a chat to see the lorebooks it loads.');
    });

    it('opens the selection screen on the book a row names, and draws the list again once the screen closes', async () => {
        await refreshLoreBaseBooks();
        opener('Keeper Notes').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Keeper Notes' });
        host.status = { hasChat: true, books: [HARBOR, { ...KEEPER, selectedCount: 3, isLockedToCharacter: true }] };
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);

        host.screen.resolve();
        await vi.waitFor(() => expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: 3 selected']));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
    });

    it('says what the selection lacks once the screen closes, LoreBase on or off, and drops the line with nothing selected', async () => {
        const status = () => document.getElementById('VectFox_lorebase_books_status');
        const closeWith = async chosen => {
            opener('Harbor Atlas').click();
            host.screen.resolve(chosen);
            await vi.waitFor(() => expect(chatBookLocks).toHaveBeenCalled());
            await Promise.resolve();
        };
        await refreshLoreBaseBooks();
        await closeWith({ missingCount: 0, decidedCount: 313, isWriting: false });
        await vi.waitFor(() => expect(status().textContent).toBe('All 313 selected entries have keys and vectors.'));
        await closeWith({ missingCount: 12, decidedCount: 313, isWriting: false });
        await vi.waitFor(() => expect(status().textContent).toBe(
            '12 selected entries have no keys or vectors yet. LoreBase leaves them out until Generate all writes them.'));
        // A run the screen's question started writes its own lines.
        await closeWith({ missingCount: 12, decidedCount: 313, isWriting: true });
        expect(status().textContent).toBe('12 selected entries have no keys or vectors yet. LoreBase leaves them out until Generate all writes them.');
        // While LoreBase is off, turning it on writes them.
        host.isOn = false;
        await closeWith({ missingCount: 1, decidedCount: 313, isWriting: false });
        await vi.waitFor(() => expect(status().textContent).toBe('1 selected entry has no keys or vectors yet. Turn on Use LoreBase to write them.'));
        // Every entry unselected while LoreBase is off: the line goes.
        host.isOn = false;
        await closeWith({ missingCount: 0, decidedCount: 0, isWriting: false });
        await vi.waitFor(() => expect(status().hidden).toBe(true));
        // Unselected while it is on: the call to choose entries.
        host.isOn = true;
        host.selectedBooks = [];
        await closeWith({ missingCount: 0, decidedCount: 0, isWriting: false });
        await vi.waitFor(() => expect(status().textContent).toBe(
            'LoreBase is on, with nothing selected yet. Choose entries: each one you turn on has its keys and vectors written then.'));
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
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: '' });
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

describe('every key and vector at once', () => {
    const remove = () => document.getElementById('VectFox_lorebase_delete_all');

    beforeEach(() => refreshLoreBaseBooks());

    it('shows no status line until a button has run', () => {
        expect(status().hidden).toBe(true);
    });

    it('Generate all writes the missing keys and vectors of every selection and says how many', async () => {
        generate().click();
        expect(generate().disabled).toBe(true);
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the keys of 2 entries and the vectors of 2 entries.'));
        expect(writeKeysAndVectorsOfSelections).toHaveBeenCalledWith(host.settings);
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
        expect(writeKeysAndVectorsOfSelections).not.toHaveBeenCalled();
    });

    it('Delete all asks first, opening on Cancel, and deletes nothing when the user cancels', async () => {
        host.isConfirmed = false;
        remove().click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(confirmPopup.mock.calls[0][1]).toEqual({ okButton: 'Delete all', isDestructive: true });
        expect(confirmPopup.mock.calls[0][0][0].text).toBe('Delete every LoreBase key and vector you have, in every lorebook?');
        expect(confirmPopup.mock.calls[0][0].map(line => line.text).join(' ')).toContain('Keys you edited by hand are lost.');
        await Promise.resolve();
        expect(deleteAllKeysAndVectors).not.toHaveBeenCalled();
        expect(turnLoreBaseOff).not.toHaveBeenCalled();
        expect([status().hidden, toggle().checked]).toEqual([true, true]);
    });

    const deletedText = 'Deleted the keys of 311 entries and every vector: no entry has either now, and Use LoreBase is off. Turn it on to write them again.';

    it('Delete all deletes every key and vector once confirmed, turns LoreBase off, and says so', async () => {
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(deletedText));
        expect(confirmPopup.mock.calls[0][0].map(line => line.text).join(' ')).toContain('Use LoreBase turns off');
        expect(deleteAllKeysAndVectors).toHaveBeenCalledWith(host.settings);
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

    it('shows what turning LoreBase on writes in place of the delete: the entries being written, then what was written', async () => {
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(deletedText));
        host.writingRunListener({ count: 311, outcome: null });
        expect(status().textContent).toBe('Writing what 311 selected entries lack; the progress panel counts them.');
        host.writingRunListener({ count: 311, outcome: outcomeOf({ keysWritten: 309, vectorsWritten: 309, failed: 2 }) });
        expect(status().textContent).toBe('Wrote the keys of 309 entries and the vectors of 309 entries. 2 entries failed, as the toast says.');
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
