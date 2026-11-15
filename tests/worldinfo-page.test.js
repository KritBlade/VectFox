/**
 * @vitest-environment jsdom
 *
 * The settings panel's WorldInfo page on GUI-DNA (src/features/settings-panel/worldinfo-page-markup.js): its cards in
 * order, LoreBase's first; every control keeps the id its wiring uses; the Matching card starts hidden for the wiring
 * to show while semantic activation is on, with a slider on each number box's limits and no similarity threshold; the
 * page is drawn from GUI-DNA alone with none of the old debug tools; the LoreBase book list says what each book of the
 * open chat has selected and where it is locked; and the activation status says what activation finds in each state
 * with the tone that state takes.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { loreBaseBooksMarkup, worldInfoPageMarkup, worldInfoStatusMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');

// The ids settings-panel.js and lorebase-books-card.js wire on the WorldInfo page.
const WIRED_IDS = [
    'VectFox_lorebase_books_card', 'VectFox_lorebase_books', 'VectFox_enabled_world_info', 'VectFox_wi_status', 'VectFox_world_info_settings',
    'VectFox_world_info_top_k', 'VectFox_world_info_query_depth', 'VectFox_world_info_retrieval_popup',
];

const limitsOf = id => { const box = document.getElementById(id); return [box.min, box.max, box.step]; };

describe('WorldInfo page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("puts LoreBase's cards first, its books always shown, with the list empty and the door to the selection screen", () => {
        expect([...document.querySelectorAll('.vfx-card-title')].map(title => title.textContent)).toEqual(['LoreBase books', 'LoreBase model', 'Semantic activation', 'Matching']);
        const books = document.getElementById('VectFox_lorebase_books_card');
        expect(books.style.display).toBe('');
        expect(document.getElementById('VectFox_lorebase_books').innerHTML).toBe('');
        expect(document.getElementById('VectFox_lorebase_books').getAttribute('aria-live')).toBe('polite');
        const opener = books.querySelector('.vfx-btn[data-lorebase-choose]');
        expect([opener.textContent.trim(), opener.dataset.lorebaseChoose, opener.classList.contains('vfx-btn-primary')]).toEqual(['Choose entries', '', true]);
    });

    it('starts the Matching card hidden, holding every matching control, and the status empty', () => {
        const matching = document.getElementById('VectFox_world_info_settings');
        expect(matching.classList.contains('vfx-card')).toBe(true);
        expect(matching.style.display).toBe('none');
        for (const id of ['VectFox_world_info_top_k', 'VectFox_world_info_query_depth', 'VectFox_world_info_retrieval_popup']) {
            expect(document.getElementById(id).closest('#VectFox_world_info_settings'), id).not.toBeNull();
        }
        expect(document.getElementById('VectFox_enabled_world_info').closest('#VectFox_world_info_settings')).toBeNull();
        expect(document.getElementById('VectFox_wi_status').innerHTML).toBe('');
    });

    it("pairs a slider with each number, on its box's limits, and has no similarity threshold", () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_world_info_top_k', 'VectFox_world_info_query_depth']);
        for (const range of ranges) expect([range.min, range.max, range.step], range.dataset.vfxSliderFor).toEqual(limitsOf(range.dataset.vfxSliderFor));
        expect(limitsOf('VectFox_world_info_top_k')).toEqual(['1', '20', '1']);
        expect(limitsOf('VectFox_world_info_query_depth')).toEqual(['1', '10', '1']);
        expect(document.getElementById('VectFox_world_info_threshold')).toBeNull();
        for (const id of ['VectFox_enabled_world_info', 'VectFox_world_info_retrieval_popup']) {
            expect(document.getElementById(id).getAttribute('role'), id).toBe('switch');
        }
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

describe('worldInfoStatusMarkup', () => {
    const linesOf = (status) => {
        document.body.innerHTML = worldInfoStatusMarkup(status);
        return [...document.querySelectorAll('.vfx-result-line')].map(line => ({
            tone: ['success', 'warning'].find(tone => line.classList.contains(`is-${tone}`)) ?? 'plain',
            text: line.textContent.trim(),
        }));
    };

    it('warns, naming where to go, when no lorebook is vectorized or none is locked to the chat', () => {
        expect(linesOf({ state: 'no-lorebooks' })).toEqual([{ tone: 'warning', text: 'No lorebook vectorized yet. Vectorize Content on the Action page stores one.' }]);
        expect(linesOf({ state: 'none-active' })).toEqual([{ tone: 'warning', text: 'No lorebook is locked to this chat. Lock one in Database Browser → Collection Settings.' }]);
    });

    it('names the active lorebooks as written, without reading them as markup', () => {
        expect(linesOf({ state: 'active', names: ['Harbor Town', 'The <b>Old</b> Keep'] })).toEqual([{ tone: 'success', text: 'Active for this chat: Harbor Town, The <b>Old</b> Keep' }]);
        expect(document.querySelector('.vfx-result-line b')).toBeNull();
    });
});
