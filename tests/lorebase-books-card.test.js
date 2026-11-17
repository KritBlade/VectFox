/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase controls (src/features/settings-panel/lorebase-books-card.js, plan §5.2 and §5.9 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): LoreBase's switch shows as saved, and
 * while it is off every other LoreBase control on the page but Delete all keys is disabled with a notice saying why;
 * turning it on can end off when the user keeps Vector Storage's World Info search. The books card draws the open
 * chat's books, opens the selection screen on the book a row names or, from the card's own button, on the chat's first
 * book, and draws the list again once the screen closes, a screen that failed included. Generate all keys writes the
 * missing keys, or says why it cannot; Delete all keys asks first; the status line says how each went.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    status: null, screen: null, isOn: true, willTurnOn: true, switchListener: null,
    settings: { vector_backend: 'qdrant' }, keyProblem: null, totals: null, isConfirmed: true, deleted: null,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.isConfirmed) }));
vi.mock('../src/features/lorebase/index.js', () => ({
    chatBookLocks: vi.fn(() => host.status),
    keyWritingProblem: vi.fn(() => host.keyProblem),
    writeKeysOfSelections: vi.fn(async () => host.totals),
    deleteAllKeys: vi.fn(async () => {
        if (host.deleted instanceof Error) throw host.deleted;
        return host.deleted;
    }),
    // The screen stays open until the test closes it.
    openLoreBaseSelection: vi.fn(() => new Promise((resolve, reject) => { host.screen = { resolve, reject }; })),
    isLoreBaseSwitchedOn: () => host.isOn,
    onLoreBaseSwitchChange: listener => { host.switchListener = listener; },
    turnLoreBaseOff: vi.fn(() => { host.isOn = false; }),
    // On, unless the user keeps Vector Storage's World Info search.
    turnLoreBaseOn: vi.fn(async () => { host.isOn = host.willTurnOn; return host.isOn; }),
}));

const {
    chatBookLocks, deleteAllKeys, openLoreBaseSelection, turnLoreBaseOff, turnLoreBaseOn, writeKeysOfSelections,
} = await import('../src/features/lorebase/index.js');
const { log } = await import('../src/sillytavern/log.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { bindLoreBaseBooksCard, refreshLoreBaseBooks } = await import('../src/features/settings-panel/lorebase-books-card.js');

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
    host.totals = { written: 2, failed: 0, unreadBooks: 0 };
    host.isConfirmed = true;
    host.deleted = 311;
    bindLoreBaseBooksCard(host.settings);
});

const toggle = () => document.getElementById('VectFox_lorebase_enabled');
const flipSwitch = isChecked => {
    toggle().checked = isChecked;
    toggle().dispatchEvent(new Event('change'));
};
// Every LoreBase control on the page but the switch, Delete all keys and the cards' own collapse and help buttons.
const waitingControls = () => [...document.querySelectorAll('#VectFox_lorebase_books_card, #VectFox_lorebase_model_card')]
    .flatMap(card => [...card.querySelectorAll('button, input, select, textarea')])
    .filter(control => !['VectFox_lorebase_enabled', 'VectFox_lorebase_delete_keys'].includes(control.id)
        && !control.matches('.vfx-collapse, .vfx-help-toggle'));
const disabledStates = () => [...new Set(waitingControls().map(control => control.disabled))];
const isNoticeShown = () => !document.getElementById('VectFox_lorebase_off_notice').hidden;

describe("LoreBase's switch", () => {
    it('shows off as saved, every other LoreBase control on the page disabled, and the notice saying why', () => {
        host.isOn = false;
        refreshLoreBaseBooks();
        expect(toggle().checked).toBe(false);
        expect(waitingControls().length).toBeGreaterThan(4);
        expect(disabledStates()).toEqual([true]);
        expect(isNoticeShown()).toBe(true);
        expect(document.getElementById('VectFox_lorebase_off_notice').textContent).toContain('Turn on Use LoreBase');
        expect([...document.querySelectorAll('#VectFox_lorebase_books_card .vfx-collapse')].every(button => !button.disabled)).toBe(true);
    });

    it('opens no selection screen from a disabled row', () => {
        host.isOn = false;
        refreshLoreBaseBooks();
        opener('Harbor Atlas').click();
        expect(openLoreBaseSelection).not.toHaveBeenCalled();
    });

    it('enables the controls and hides the notice once turned on', async () => {
        host.isOn = false;
        refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(disabledStates()).toEqual([false]));
        expect(turnLoreBaseOn).toHaveBeenCalledTimes(1);
        expect([toggle().checked, isNoticeShown()]).toEqual([true, false]);
    });

    it("shows off again when the user keeps Vector Storage's World Info search", async () => {
        host.isOn = false;
        host.willTurnOn = false;
        refreshLoreBaseBooks();
        flipSwitch(true);
        await vi.waitFor(() => expect(turnLoreBaseOn).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(toggle().checked).toBe(false));
        expect(disabledStates()).toEqual([true]);
    });

    it('turns off from the switch, disabling the controls again', () => {
        refreshLoreBaseBooks();
        expect(disabledStates()).toEqual([false]);
        flipSwitch(false);
        expect(turnLoreBaseOff).toHaveBeenCalledTimes(1);
        expect([toggle().checked, disabledStates(), isNoticeShown()]).toEqual([false, [true], true]);
    });

    it('keeps Delete all keys working while it is off, as turning LoreBase on writes keys, and Generate all keys waiting', () => {
        host.isOn = false;
        refreshLoreBaseBooks();
        expect(document.getElementById('VectFox_lorebase_delete_keys').disabled).toBe(false);
        expect(document.getElementById('VectFox_lorebase_generate_keys').disabled).toBe(true);
    });

    it("shows a change a reply's question made while the page is open", () => {
        refreshLoreBaseBooks();
        host.isOn = false;
        host.switchListener(false);
        expect([toggle().checked, disabledStates()]).toEqual([false, [true]]);
    });
});

describe('the LoreBase books card', () => {
    it("draws the open chat's books, and draws them again for the next chat", () => {
        refreshLoreBaseBooks();
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);
        host.status = { hasChat: false, books: [] };
        refreshLoreBaseBooks();
        expect(rowsShown()).toEqual([]);
        expect(document.getElementById('VectFox_lorebase_books').textContent.trim()).toBe('Open a chat to see the lorebooks it loads.');
    });

    it('opens the selection screen on the book a row names, and draws the list again once the screen closes', async () => {
        refreshLoreBaseBooks();
        opener('Keeper Notes').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: 'Keeper Notes' });
        host.status = { hasChat: true, books: [HARBOR, { ...KEEPER, selectedCount: 3, isLockedToCharacter: true }] };
        expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: Nothing selected']);

        host.screen.resolve();
        await vi.waitFor(() => expect(rowsShown()).toEqual(['Harbor Atlas: 2 selected', 'Keeper Notes: 3 selected']));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
    });

    it("opens the screen on the chat's first book from the card's own button", () => {
        document.querySelector('#VectFox_lorebase_books_card .vfx-card-body > .vfx-control-row [data-lorebase-choose]').click();
        expect(openLoreBaseSelection).toHaveBeenCalledWith({ bookName: '' });
    });

    it('logs a screen that failed, and still draws the list again', async () => {
        refreshLoreBaseBooks();
        opener('Harbor Atlas').click();
        const failure = new Error('no dialog');
        host.screen.reject(failure);

        await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining('selection screen'), failure));
        expect(chatBookLocks).toHaveBeenCalledTimes(2);
    });
});

describe('every key at once', () => {
    const status = () => document.getElementById('VectFox_lorebase_keys_status');
    const generate = () => document.getElementById('VectFox_lorebase_generate_keys');
    const remove = () => document.getElementById('VectFox_lorebase_delete_keys');

    beforeEach(() => refreshLoreBaseBooks());

    it('shows no status line until a button has run', () => {
        expect(status().hidden).toBe(true);
    });

    it('Generate all keys writes the missing keys of every selection and says how many', async () => {
        generate().click();
        expect(generate().disabled).toBe(true);
        await vi.waitFor(() => expect(status().textContent).toBe('Wrote the keys of 2 entries.'));
        expect(writeKeysOfSelections).toHaveBeenCalledWith(host.settings);
        expect([status().hidden, generate().disabled]).toEqual([false, false]);
    });

    it('Generate all keys names the entries that failed and the books it could not read, or that none was missing', async () => {
        host.totals = { written: 3, failed: 1, unreadBooks: 2 };
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe(
            'Wrote the keys of 3 entries. 1 entry failed, as the toast says. 2 lorebooks could not be read; the console says why.'));
        host.totals = { written: 0, failed: 0, unreadBooks: 0 };
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe('No selected entry was missing keys.'));
    });

    it('Generate all keys writes nothing when keys cannot be written, and says why', async () => {
        host.keyProblem = 'LoreBase keeps the keys its model writes for each entry in Qdrant. Choose Qdrant as the vector backend first.';
        generate().click();
        await vi.waitFor(() => expect(status().textContent).toBe(`Not written: ${host.keyProblem}`));
        expect(writeKeysOfSelections).not.toHaveBeenCalled();
    });

    it('Delete all keys asks first, opening on Cancel, and deletes nothing when the user cancels', async () => {
        host.isConfirmed = false;
        remove().click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(confirmPopup.mock.calls[0][1]).toEqual({ okButton: 'Delete all keys', isDestructive: true });
        expect(confirmPopup.mock.calls[0][0].map(line => line.text).join(' ')).toContain('Keys you edited by hand are lost.');
        await Promise.resolve();
        expect(deleteAllKeys).not.toHaveBeenCalled();
        expect(status().hidden).toBe(true);
    });

    it('Delete all keys deletes every key once confirmed, and says how many', async () => {
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe(
            'Deleted the keys of 311 entries. Selected entries send nothing until Generate all keys.'));
        expect(deleteAllKeys).toHaveBeenCalledTimes(1);
        expect(remove().disabled).toBe(false);
    });

    it('a delete that fails says Not deleted, with the reason, and logs it', async () => {
        host.deleted = new Error('LoreBase is writing keys. Delete them once it is done.');
        remove().click();
        await vi.waitFor(() => expect(status().textContent).toBe('Not deleted: LoreBase is writing keys. Delete them once it is done.'));
        expect(log.warn).toHaveBeenCalledWith('LoreBase: Delete all keys failed:', host.deleted);
    });
});
