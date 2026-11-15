/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase books card (src/features/settings-panel/lorebase-books-card.js, plan §5.2 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): it draws the open chat's books, opens the
 * selection screen on the book a row names or, from the card's own button, on the chat's first book, and draws the
 * list again once the screen closes, a screen that failed included.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ status: null, screen: null }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/features/lorebase/index.js', () => ({
    chatBookLocks: vi.fn(() => host.status),
    // The screen stays open until the test closes it.
    openLoreBaseSelection: vi.fn(() => new Promise((resolve, reject) => { host.screen = { resolve, reject }; })),
}));

const { chatBookLocks, openLoreBaseSelection } = await import('../src/features/lorebase/index.js');
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
    bindLoreBaseBooksCard();
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
