/**
 * @vitest-environment jsdom
 *
 * The settings panel's WorldInfo page on GUI-DNA (src/features/settings-panel/worldinfo-page-markup.js): LoreBase's
 * two cards, its switch first, and nothing of the old vector search; every control keeps the id its wiring uses; the
 * page is drawn from GUI-DNA alone with none of the old debug tools; and the LoreBase book list says what each book of
 * the open chat has selected and where it is locked.
 */
/* global document, Node -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { loreBaseBooksMarkup, worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');

// The ids settings-panel.js and lorebase-books-card.js wire on the WorldInfo page.
const WIRED_IDS = [
    'VectFox_lorebase_enabled', 'VectFox_lorebase_off_notice', 'VectFox_lorebase_books_card', 'VectFox_lorebase_books',
    'VectFox_lorebase_model_card', 'VectFox_lorebase_model', 'VectFox_lorebase_accuracy',
];
// The old vector search's controls, deleted with it.
const OLD_SEARCH_IDS = [
    'VectFox_enabled_world_info', 'VectFox_wi_status', 'VectFox_world_info_settings', 'VectFox_world_info_top_k',
    'VectFox_world_info_query_depth', 'VectFox_world_info_retrieval_popup', 'VectFox_world_info_threshold',
];

describe('WorldInfo page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("holds LoreBase's two cards, its books always shown, with the list empty and the door to the selection screen", () => {
        expect([...document.querySelectorAll('.vfx-card-title')].map(title => title.textContent)).toEqual(['LoreBase books', 'LoreBase model']);
        const books = document.getElementById('VectFox_lorebase_books_card');
        expect(books.style.display).toBe('');
        expect(document.getElementById('VectFox_lorebase_books').innerHTML).toBe('');
        expect(document.getElementById('VectFox_lorebase_books').getAttribute('aria-live')).toBe('polite');
        const opener = books.querySelector('.vfx-btn[data-lorebase-choose]');
        expect([opener.textContent.trim(), opener.dataset.lorebaseChoose, opener.classList.contains('vfx-btn-primary')]).toEqual(['Choose entries', '', true]);
    });

    it("opens the books card on LoreBase's switch, off, before the list", () => {
        const body = document.querySelector('#VectFox_lorebase_books_card .vfx-card-body');
        const toggle = document.getElementById('VectFox_lorebase_enabled');
        expect(body.querySelector('input, button, select')).toBe(toggle);
        expect([toggle.type, toggle.checked]).toEqual(['checkbox', false]);
        expect(body.textContent).toContain('Use LoreBase');
        expect(document.getElementById('VectFox_lorebase_off_notice').compareDocumentPosition(document.getElementById('VectFox_lorebase_books')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps none of the old vector search's controls", () => {
        for (const id of OLD_SEARCH_IDS) expect(document.getElementById(id), id).toBeNull();
    });

    it('draws only GUI-DNA classes, with none of the old debug tools or unwired boxes', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        for (const id of ['VectFox_wi_test_input', 'VectFox_wi_test_btn', 'VectFox_wi_dump_registry', 'VectFox_wi_apply_first', 'VectFox_enabled_for_all', 'VectFox_max_entries']) {
            expect(document.getElementById(id), id).toBeNull();
        }
    });
});

describe('loreBaseBooksMarkup', () => {
    const rowsOf = status => {
        document.body.innerHTML = loreBaseBooksMarkup(status);
        return [...document.querySelectorAll('.vfx-row')].map(row => ({
            name: row.querySelector('.vfx-row-name').textContent,
            sub: row.querySelector('.vfx-row-sub').textContent,
            pills: [...row.querySelectorAll('.vfx-pill')].map(pill => `${pill.textContent.trim()} (${['success', 'neutral'].find(tone => pill.classList.contains(`is-${tone}`))})`),
            opens: row.querySelector('.vfx-row-actions [data-lorebase-choose]').dataset.lorebaseChoose,
            opener: row.querySelector('.vfx-row-actions [data-lorebase-choose]').title,
        }));
    };

    it('asks for a chat while none is open, and says so when the chat loads no lorebook', () => {
        expect(rowsOf({ hasChat: false, books: [] })).toEqual([]);
        expect(document.body.textContent.trim()).toBe('Open a chat to see the lorebooks it loads.');
        expect(rowsOf({ hasChat: true, books: [] })).toEqual([]);
        expect(document.body.textContent.trim()).toBe('This chat loads no lorebook.');
    });

    it('lists each book with what is selected in it and where it is locked, each row opening the screen on its book', () => {
        expect(rowsOf({
            hasChat: true,
            books: [
                { bookName: 'Harbor Atlas', selectedCount: 1234, isLockedToChat: true, isLockedToCharacter: true },
                { bookName: 'Keeper Notes', selectedCount: 1, isLockedToChat: false, isLockedToCharacter: true },
                { bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false },
            ],
        })).toEqual([
            { name: 'Harbor Atlas', sub: '1,234 selected', pills: ['Locked to this chat (success)', 'Locked to this character (success)'], opens: 'Harbor Atlas', opener: 'Choose entries' },
            { name: 'Keeper Notes', sub: '1 selected', pills: ['Locked to this character (success)'], opens: 'Keeper Notes', opener: 'Choose entries' },
            { name: 'Tide Tables', sub: 'Nothing selected', pills: ['Not locked (neutral)'], opens: 'Tide Tables', opener: 'Choose entries' },
        ]);
    });

    it('shows a book named like markup as written, and opens it by that name', () => {
        expect(rowsOf({ hasChat: true, books: [{ bookName: 'The <b>Old</b> "Keep"', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false }] })[0])
            .toMatchObject({ name: 'The <b>Old</b> "Keep"', opens: 'The <b>Old</b> "Keep"' });
        expect(document.querySelector('.vfx-row b')).toBeNull();
    });
});
