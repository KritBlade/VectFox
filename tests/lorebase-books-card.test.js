/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase controls (src/features/settings-panel/lorebase-books-card.js, plan §5.2 and §5.9 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): LoreBase's switch shows as saved, and
 * while it is off every other LoreBase control on the page is disabled with a notice saying why; turning it on can end
 * off when the user keeps Vector Storage's World Info search. The books card draws the open chat's books, opens the
 * selection screen on the book a row names or, from the card's own button, on the chat's first book, and draws the
 * list again once the screen closes, a screen that failed included.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ status: null, screen: null, isOn: true, willTurnOn: true, switchListener: null }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/features/lorebase/index.js', () => ({
    chatBookLocks: vi.fn(() => host.status),
    // The screen stays open until the test closes it.
    openLoreBaseSelection: vi.fn(() => new Promise((resolve, reject) => { host.screen = { resolve, reject }; })),
    isLoreBaseSwitchedOn: () => host.isOn,
    onLoreBaseSwitchChange: listener => { host.switchListener = listener; },
    turnLoreBaseOff: vi.fn(() => { host.isOn = false; }),
    // On, unless the user keeps Vector Storage's World Info search.
    turnLoreBaseOn: vi.fn(async () => { host.isOn = host.willTurnOn; return host.isOn; }),
}));

const { chatBookLocks, openLoreBaseSelection, turnLoreBaseOff, turnLoreBaseOn } = await import('../src/features/lorebase/index.js');
const { log } = await import('../src/sillytavern/log.js');
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
    bindLoreBaseBooksCard();
});

const toggle = () => document.getElementById('VectFox_lorebase_enabled');
const flipSwitch = isChecked => {
    toggle().checked = isChecked;
    toggle().dispatchEvent(new Event('change'));
};
// Every LoreBase control on the page but the switch and the cards' own collapse and help buttons.
const waitingControls = () => [...document.querySelectorAll('#VectFox_lorebase_books_card, #VectFox_lorebase_model_card')]
    .flatMap(card => [...card.querySelectorAll('button, input, select, textarea')])
    .filter(control => control.id !== 'VectFox_lorebase_enabled' && !control.matches('.vfx-collapse, .vfx-help-toggle'));
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
