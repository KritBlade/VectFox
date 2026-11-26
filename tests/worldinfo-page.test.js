/**
 * @vitest-environment jsdom
 *
 * The settings panel's WorldInfo page on GUI-DNA (src/features/settings-panel/worldinfo-page-markup.js): three tabs on
 * the Sub-tabs gene, opening on Main, which holds LoreBase's books and model cards, LoreBase's switch first, then
 * Entity-Lore, whose card holds its switch, its two counts, Run now and the character list, and LoreBase tester; nothing
 * of the old vector search; every
 * control keeps the id its wiring uses; the page is drawn from GUI-DNA alone with none of the old debug tools; the
 * LoreBase book list says what each book of the open chat has selected and where it is locked, then Add a lorebook
 * with the books it does not load; and the tester's report says what LoreBase did on a reply (§5.10).
 */
/* global document, Node -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const {
    ENTITY_LORE_ELEMENT_ID, WORLDINFO_TAB, WORLDINFO_TABS_ID, loreBaseBooksMarkup, loreBaseReportMarkup, loreBaseReportOptions, loreBaseSetupNoticeMarkup,
    loreBaseVectorsLineText, worldInfoPageMarkup,
} = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { KEY_CALLS_AT_ONCE_MAX } = await import('../src/features/lorebase/lorebase-keys-core.js');
const { FAST_AND_CHEAP, loreBaseAccuracyOf } = await import('../src/features/lorebase/lorebase-reply-core.js');
const { LORE_BUDGET_MAX, LORE_BUDGET_MIN } = await import('../src/features/lorebase/lorebase-jev-core.js');
const { PICK_LIMIT_MAX, PICK_LIMIT_MIN } = await import('../src/features/lorebase/lorebase-pick-core.js');
const { REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS } = await import('../src/features/entity-lore/entity-lore-core.js');

// The ids settings-panel.js, lorebase-books-card.js and lorebase-tester-card.js wire on the WorldInfo page.
const WIRED_IDS = [
    'VectFox_lorebase_enabled', 'VectFox_lorebase_off_notice', 'VectFox_lorebase_books_card', 'VectFox_lorebase_books',
    'VectFox_lorebase_key_calls_at_once', 'VectFox_lorebase_generate_keys', 'VectFox_lorebase_generate_vectors', 'VectFox_lorebase_generate_all',
    'VectFox_lorebase_delete_all', 'VectFox_lorebase_books_status',
    'VectFox_lorebase_model_card', 'VectFox_lorebase_model', 'VectFox_lorebase_accuracy',
    'VectFox_lorebase_jev_connection_profile_rows', 'VectFox_lorebase_jev_connection_profile', 'VectFox_lorebase_jev_connection_profile_readout',
    'VectFox_lorebase_jev_group', 'VectFox_lorebase_jev_test_connection', 'VectFox_lorebase_lore_budget_tokens', 'VectFox_lorebase_role_picks',
    'VectFox_lorebase_role_keys', 'VectFox_lorebase_pick_limit_group', 'VectFox_lorebase_pick_limit', 'VectFox_lorebase_setup_notice', 'VectFox_lorebase_vectors_model', 'VectFox_lorebase_vectors_link',
    'VectFox_lorebase_tester_card', 'VectFox_lorebase_try_pick', 'VectFox_lorebase_report_field', 'VectFox_lorebase_report', 'VectFox_lorebase_report_body',
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

    it('opens the model card on Accuracy, offers Fast and Cheap [Jev] first and High Accuracy, and hides Jev\'s group until it is chosen (D16)', () => {
        const card = document.getElementById('VectFox_lorebase_model_card');
        expect(card.querySelector('.vfx-card-body select, .vfx-card-body input')).toBe(document.getElementById('VectFox_lorebase_accuracy'));
        expect([...document.getElementById('VectFox_lorebase_accuracy').options].map(option => [option.value, option.textContent]))
            .toEqual([['fast', 'Fast and Cheap [Jev]'], ['high', 'High Accuracy']]);
        // Each value is a choice the reply runs as itself, the default first.
        const values = [...document.getElementById('VectFox_lorebase_accuracy').options].map(option => option.value);
        expect([values.map(loreBaseAccuracyOf), values[0]]).toEqual([values, FAST_AND_CHEAP]);
        const titles = [...card.querySelectorAll('.vfx-group-title')].map(title => title.textContent.trim());
        expect(titles).toEqual(['Keys and picks', 'Keys', 'Jev']);
        expect(document.getElementById('VectFox_lorebase_role_picks').style.display).toBe('');
        expect(document.getElementById('VectFox_lorebase_role_keys').style.display).toBe('none');
        expect(document.getElementById('VectFox_lorebase_jev_group').style.display).toBe('none');
        expect(document.getElementById('VectFox_lorebase_jev_group').contains(document.getElementById('VectFox_lorebase_jev_test_connection'))).toBe(true);
    });

    it("opens the model card's body on its setup notice, hidden and empty until drawn, and ends it on the Vectors line and its button to the Core page (§7.2)", () => {
        const body = document.querySelector('#VectFox_lorebase_model_card .vfx-card-body');
        const setupNotice = document.getElementById('VectFox_lorebase_setup_notice');
        expect([body.firstElementChild, setupNotice.hidden, setupNotice.innerHTML]).toEqual([setupNotice, true, '']);
        const link = document.getElementById('VectFox_lorebase_vectors_link');
        expect(link.textContent.trim()).toBe('Set on the Core page');
        expect(body.lastElementChild.contains(link)).toBe(true);
        expect(body.lastElementChild.contains(document.getElementById('VectFox_lorebase_vectors_model'))).toBe(true);
        expect(body.lastElementChild.querySelector('.vfx-field-label').textContent).toBe('Vectors');
    });

    it('draws the setup notice only when something is missing, and names the embedding model on the Vectors line', () => {
        expect(loreBaseSetupNoticeMarkup('')).toBe('');
        document.body.innerHTML = loreBaseSetupNoticeMarkup('Choose Qdrant as the vector backend on the Core page.');
        expect(document.querySelector('.vfx-notice.is-warning')?.textContent.trim()).toBe('Choose Qdrant as the vector backend on the Core page.');
        expect(loreBaseVectorsLineText('baai/bge-m3 at OpenRouter')).toBe("baai/bge-m3 at OpenRouter, VectFox's embedding model.");
        expect(loreBaseVectorsLineText('')).toBe('No embedding model is set.');
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("holds its four cards in their tabs' order, LoreBase's books always shown, with the list empty and the door to the selection screen", () => {
        expect([...document.querySelectorAll('.vfx-card-title')].map(title => title.textContent)).toEqual(['LoreBase books', 'LoreBase model', 'Entity-Lore', 'LoreBase tester']);
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

    it('offers Entries at once beside the key buttons: a slider and its number box from 1 to the most the keys allow', () => {
        const box = document.getElementById('VectFox_lorebase_key_calls_at_once');
        const slider = document.querySelector('.vfx-range[data-vfx-slider-for="VectFox_lorebase_key_calls_at_once"]');
        expect([box.type, box.min, box.max, box.step]).toEqual(['number', '1', String(KEY_CALLS_AT_ONCE_MAX), '1']);
        expect([slider.min, slider.max]).toEqual(['1', String(KEY_CALLS_AT_ONCE_MAX)]);
        expect(document.querySelector('label[for="VectFox_lorebase_key_calls_at_once"]').textContent).toBe('Entries at once');
        const field = box.closest('.vfx-field');
        expect(field.nextElementSibling.querySelector('#VectFox_lorebase_delete_all')).not.toBeNull();
    });

    it("offers the Lore budget in Jev's group, after Jev's Test connection, from the least to the most the reply reads", () => {
        const box = document.getElementById('VectFox_lorebase_lore_budget_tokens');
        const slider = document.querySelector('.vfx-range[data-vfx-slider-for="VectFox_lorebase_lore_budget_tokens"]');
        expect([box.type, box.min, box.max, box.step]).toEqual(['number', String(LORE_BUDGET_MIN), String(LORE_BUDGET_MAX), '500']);
        expect([slider.min, slider.max]).toEqual([String(LORE_BUDGET_MIN), String(LORE_BUDGET_MAX)]);
        expect(document.querySelector('label[for="VectFox_lorebase_lore_budget_tokens"]').textContent).toBe('Lore budget');
        const group = document.getElementById('VectFox_lorebase_jev_group');
        expect(group.contains(box)).toBe(true);
        expect(document.getElementById('VectFox_lorebase_jev_test_connection').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("offers High Accuracy's Pick limit after the own model's Test connection, outside Jev's group, from the least to the most the pick reads", () => {
        const box = document.getElementById('VectFox_lorebase_pick_limit');
        const slider = document.querySelector('.vfx-range[data-vfx-slider-for="VectFox_lorebase_pick_limit"]');
        expect([box.type, box.min, box.max, box.step]).toEqual(['number', String(PICK_LIMIT_MIN), String(PICK_LIMIT_MAX), '1']);
        expect([slider.min, slider.max, slider.title]).toEqual([String(PICK_LIMIT_MIN), String(PICK_LIMIT_MAX), 'Entries']);
        expect(document.querySelector('label[for="VectFox_lorebase_pick_limit"]').textContent).toBe('Pick limit');
        expect(document.getElementById('VectFox_lorebase_pick_limit_group').contains(box)).toBe(true);
        expect(document.getElementById('VectFox_lorebase_jev_group').contains(box)).toBe(false);
        expect(document.getElementById('VectFox_lorebase_test_connection').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('offers Generate keys, Generate vectors, Generate all and Delete all in that order', () => {
        const buttons = [...document.querySelector('#VectFox_lorebase_delete_all').parentElement.querySelectorAll('button')];
        expect(buttons.map(button => button.textContent.trim())).toEqual(['Generate keys', 'Generate vectors', 'Generate all', 'Delete all']);
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

describe('WorldInfo page tabs (§2.2 of entity-lore.md)', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    });
    const cardsOn = tab => [...document.querySelectorAll(`[data-vfx-subtab-panel="${tab}"] > .vfx-card`)].map(card => card.id);

    it('are Main, Entity-Lore and LoreBase tester on the Sub-tabs gene, each with its icon, opening on Main', () => {
        const gene = document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`);
        expect([...gene.querySelectorAll('[data-vfx-subtab]')].map(tab => [tab.dataset.vfxSubtab, tab.textContent.trim(), tab.querySelector('i').className])).toEqual([
            [WORLDINFO_TAB.main, 'Main', 'fa-solid fa-sliders'],
            [WORLDINFO_TAB.entityLore, 'Entity-Lore', 'fa-solid fa-users-viewfinder'],
            [WORLDINFO_TAB.tester, 'LoreBase tester', 'fa-solid fa-flask'],
        ]);
        expect([...gene.querySelectorAll('[data-vfx-subtab-panel]')].filter(panel => !panel.hidden).map(panel => panel.dataset.vfxSubtabPanel)).toEqual([WORLDINFO_TAB.main]);
    });

    it("hold LoreBase's books and model cards on Main, Entity-Lore's card on its tab and the tester on its own", () => {
        expect(cardsOn(WORLDINFO_TAB.main)).toEqual(['VectFox_lorebase_books_card', 'VectFox_lorebase_model_card']);
        expect(cardsOn(WORLDINFO_TAB.entityLore)).toEqual(['VectFox_entity_lore_card']);
        expect(cardsOn(WORLDINFO_TAB.tester)).toEqual(['VectFox_lorebase_tester_card']);
    });

    it("hold on Entity-Lore's card its switch, Write at and Rewrite every in their ranges, Run now and the character list (§3)", () => {
        const card = document.getElementById(ENTITY_LORE_ELEMENT_ID.card);
        expect(card.querySelector('.vfx-card-desc').textContent).toBe('Writes a lorebook entry for each named character StoryArc counts often.');
        for (const id of Object.values(ENTITY_LORE_ELEMENT_ID)) expect(document.getElementById(id), id).not.toBeNull();
        const toggle = document.getElementById(ENTITY_LORE_ELEMENT_ID.enabled);
        expect(toggle.closest('.vfx-switch-row').textContent).toBe('Use Entity-LoreOff by default. Needs StoryArc mode and Use LoreBase.');
        const range = id => {
            const box = document.getElementById(id);
            return { min: Number(box.min), max: Number(box.max), slider: card.querySelector(`[data-vfx-slider-for="${id}"]`).title };
        };
        expect(range(ENTITY_LORE_ELEMENT_ID.writeAt)).toEqual({ min: WRITE_AT_EVENTS.min, max: WRITE_AT_EVENTS.max, slider: 'Events' });
        expect(range(ENTITY_LORE_ELEMENT_ID.rewriteEvery)).toEqual({ min: REWRITE_EVERY_EVENTS.min, max: REWRITE_EVERY_EVENTS.max, slider: 'Events' });
        expect([...card.querySelectorAll('.vfx-hint')].map(each => each.textContent).filter(Boolean)).toEqual([
            'A named character gets an entry once this many events name them.',
            'Their entry is written again from their whole story after this many more events.',
            'Writes every entry due now. Asks first, naming how many.',
        ]);
        expect(document.getElementById(ENTITY_LORE_ELEMENT_ID.runNow).textContent).toBe('Run now');
        expect(document.getElementById(ENTITY_LORE_ELEMENT_ID.book).hidden).toBe(true);
        expect(document.getElementById(ENTITY_LORE_ELEMENT_ID.status).hidden).toBe(true);
    });
});

describe('loreBaseBooksMarkup', () => {
    // A book as chatBookLocks lists it, holding no selection unless the test gives some, so its row draws no switcher.
    const listedBook = fields => ({ selections: [], selectionInUseId: null, ...fields });
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
                listedBook({ bookName: 'Harbor Atlas', selectedCount: 1234, isLockedToChat: true, isLockedToCharacter: true }),
                listedBook({ bookName: 'Keeper Notes', selectedCount: 1, isLockedToChat: false, isLockedToCharacter: true }),
                listedBook({ bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false }),
            ],
        })).toEqual([
            { name: 'Harbor Atlas', sub: '1,234 selected', pills: ['Locked to this chat (success)', 'Locked to this character (success)'], opens: 'Harbor Atlas', opener: 'Choose entries' },
            { name: 'Keeper Notes', sub: '1 selected', pills: ['Locked to this character (success)'], opens: 'Keeper Notes', opener: 'Choose entries' },
            { name: 'Tide Tables', sub: 'Nothing selected', pills: ['Not locked (neutral)'], opens: 'Tide Tables', opener: 'Choose entries' },
        ]);
    });

    it('adds how many selected entries have keys and vectors once they are read, each count with its unit', () => {
        expect(rowsOf({
            hasChat: true,
            books: [listedBook({ bookName: 'Harbor Atlas', selectedCount: 1234, isLockedToChat: true, isLockedToCharacter: false, keyCount: 1200, vectorCount: 0 })],
        })[0].sub).toBe('1,234 selected, 1,200 with keys, 0 with vectors');
    });

    it('offers Remove from LoreBase on the row of a book it has something to do for, and on no other', () => {
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [
                listedBook({ bookName: 'Harbor Atlas', selectedCount: 18, isLockedToChat: false, isLockedToCharacter: true, canRemove: true }),
                listedBook({ bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, canRemove: false }),
            ],
        });
        const removers = [...document.querySelectorAll('.vfx-row-actions [data-lorebase-remove]')];
        expect(removers.map(button => [button.closest('.vfx-row').querySelector('.vfx-row-name').textContent, button.dataset.lorebaseRemove, button.title]))
            .toEqual([['Harbor Atlas', 'Harbor Atlas', 'Remove from LoreBase']]);
        expect(removers[0].classList.contains('vfx-btn-danger')).toBe(true);
    });

    it('offers Unlink on the row of a book a list Unlink takes books out of loads, in red just before Remove, and on no other', () => {
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [
                listedBook({ bookName: 'Keeper Notes', selectedCount: 18, isLockedToChat: false, isLockedToCharacter: true, canRemove: true, canUnlink: false }),
                listedBook({ bookName: 'Harbor Atlas', selectedCount: 0, isLockedToChat: true, isLockedToCharacter: false, canRemove: true, canUnlink: true }),
            ],
        });
        const unlinkers = [...document.querySelectorAll('.vfx-row-actions [data-lorebase-unlink]')];
        expect(unlinkers.map(button => [button.closest('.vfx-row').querySelector('.vfx-row-name').textContent, button.dataset.lorebaseUnlink, button.title]))
            .toEqual([['Harbor Atlas', 'Harbor Atlas', 'Unlink from this chat, and remove from LoreBase']]);
        expect(unlinkers[0].classList.contains('vfx-btn-danger')).toBe(true);
        expect(unlinkers[0].querySelector('.fa-link-slash')).not.toBeNull();
        expect(unlinkers[0].nextElementSibling.dataset.lorebaseRemove).toBe('Harbor Atlas');
    });

    // The books added to the chat through LoreBase's Add to this chat (L1 of InternalProject/Vectfox/plans/entity-lore.md).
    it("says on a book only the chat's added books load that it loads while LoreBase is on alone, under what is selected", () => {
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [
                listedBook({ bookName: 'Coral Index', selectedCount: 3, isLockedToChat: true, isLockedToCharacter: false, canUnlink: true, isAddedToChat: true }),
                listedBook({ bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, canUnlink: true }),
            ],
        });
        const subsOf = row => [...row.querySelectorAll('.vfx-row-sub')].map(sub => sub.textContent);
        const [coral, tide] = document.querySelectorAll('.vfx-row');
        expect(subsOf(coral)).toEqual(['3 selected', 'Added to this chat: loads only while LoreBase is on']);
        expect(subsOf(tide)).toEqual(['Nothing selected']);
        expect(coral.querySelector('[data-lorebase-unlink]').dataset.lorebaseUnlink).toBe('Coral Index');
    });

    it('draws a book added here that SillyTavern no longer has as missing, its one action Unlink', () => {
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [listedBook({
                bookName: 'Lost <b>Charts</b>', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, canUnlink: true, isAddedToChat: true,
                isMissing: true, canRemove: true,
            })],
        });
        const row = document.querySelector('.vfx-row');
        expect(row.querySelector('.vfx-row-name').textContent).toBe('Lost <b>Charts</b>');
        expect(row.querySelector('.vfx-row-sub').textContent).toBe('Added to this chat, but SillyTavern no longer has it, so it sends nothing');
        expect([...row.querySelectorAll('.vfx-pill')].map(pill => [pill.textContent.trim(), pill.classList.contains('is-warning')]))
            .toEqual([['Missing from SillyTavern', true]]);
        const actions = [...row.querySelectorAll('.vfx-row-actions button, .vfx-row-actions select')];
        expect(actions.map(action => [action.title, action.dataset.lorebaseUnlink])).toEqual([['Unlink from this chat, and remove from LoreBase', 'Lost <b>Charts</b>']]);
        expect(document.querySelector('.vfx-row b')).toBeNull();
    });

    it('gives the trash of a book with 2 or more selections the one in use here to delete, its dropdown showing it; else Remove from LoreBase', () => {
        const TWO = [{ id: 'first', name: 'Harbor Atlas' }, { id: 'night', name: 'Night <b>watch</b>' }];
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [
                listedBook({ bookName: 'Harbor Atlas', selectedCount: 2, isLockedToChat: true, isLockedToCharacter: false, canRemove: true, selections: TWO, selectionInUseId: 'night' }),
                listedBook({ bookName: 'Keeper Notes', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, canRemove: true, selections: TWO }),
                listedBook({
                    bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: true, isLockedToCharacter: false, canRemove: true,
                    selections: [{ id: 't1', name: 'Tide Tables' }], selectionInUseId: 't1',
                }),
            ],
        });
        const trashes = [...document.querySelectorAll('.vfx-row')].map(row => {
            const trash = row.querySelector('.vfx-row-actions .fa-trash-can').closest('button');
            const { lorebaseRemove = null, lorebaseDeleteSelection = null, lorebaseSelection = null } = trash.dataset;
            return [trash.title, lorebaseRemove, lorebaseDeleteSelection, lorebaseSelection, trash.classList.contains('vfx-btn-danger')];
        });
        expect(trashes).toEqual([
            ['Delete the selection "Night <b>watch</b>"', null, 'Harbor Atlas', 'night', true],
            ['Remove from LoreBase', 'Keeper Notes', null, null, true],
            ['Remove from LoreBase', 'Tide Tables', null, null, true],
        ]);
    });

    it("leads every book's actions with Selection in use here: its selections, the one in use here chosen, then New selection; a book with none, None in use here and New selection (§1.2 of vectfox-multi-collection-per-chat.md)", () => {
        document.body.innerHTML = loreBaseBooksMarkup({
            hasChat: true,
            books: [
                listedBook({
                    bookName: 'Harbor Atlas', selectedCount: 2, isLockedToChat: true, isLockedToCharacter: false,
                    selections: [{ id: 'first', name: 'Harbor Atlas' }, { id: 'night', name: 'Night <b>watch</b>' }], selectionInUseId: 'night',
                }),
                listedBook({ bookName: 'Keeper Notes', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false, selections: [{ id: 'k1', name: 'Keeper Notes' }] }),
                listedBook({ bookName: 'Tide Tables', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false }),
            ],
        });
        const switchers = [...document.querySelectorAll('.vfx-row')].map(row => row.querySelector('.vfx-row-actions select'));
        expect(switchers.map(switcher => switcher && {
            book: switcher.dataset.lorebaseInUse, title: switcher.title, isFirst: switcher.parentElement.firstElementChild === switcher,
            options: [...switcher.options].map(option => [option.value, option.textContent, option.selected]),
        })).toEqual([
            {
                book: 'Harbor Atlas', title: 'Selection in use here', isFirst: true,
                options: [['first', 'Harbor Atlas', false], ['night', 'Night <b>watch</b>', true], ['+new', 'New selection', false]],
            },
            {
                book: 'Keeper Notes', title: 'Selection in use here', isFirst: true,
                options: [['', 'None in use here', true], ['k1', 'Keeper Notes', false], ['+new', 'New selection', false]],
            },
            {
                book: 'Tide Tables', title: 'Selection in use here', isFirst: true,
                options: [['', 'None in use here', true], ['+new', 'New selection', false]],
            },
        ]);
        expect(document.querySelector('.vfx-row b')).toBeNull();
    });

    describe("each book's state, once its keys and vectors are read (§7.1 of lorebook-multi-vector.md)", () => {
        // A book with its selection in use here, locked to this chat, as chatBookLocks gives it.
        const book = fields => listedBook({
            bookName: 'Harbor Atlas', selectedCount: 40, isLockedToChat: true, isLockedToCharacter: false, selectionInUseId: 'harbor-1', decidedCount: 40, keyCount: 40, vectorCount: 40,
            readyCount: 40, missingKeyCount: 0, missingVectorCount: 0, otherModelCount: 0, failedCount: 0, firstFailure: null, writing: null, ...fields,
        });
        const TONES = ['success', 'warning', 'danger', 'accent', 'neutral'];
        const stateOf = fields => {
            document.body.innerHTML = loreBaseBooksMarkup({ hasChat: true, books: [book(fields)] });
            const pill = document.querySelector('.vfx-row .vfx-pill');
            return {
                state: `${pill.textContent.trim()} (${TONES.find(tone => pill.classList.contains(`is-${tone}`))})`,
                lines: [...document.querySelectorAll('.vfx-row .vfx-row-sub')].map(line => line.textContent),
            };
        };

        it('says ready, or what the rest lack: keys and vectors, keys, vectors, or keys or vectors', () => {
            expect(stateOf({}).state).toBe('Ready (success)');
            expect(stateOf({ keyCount: 0, vectorCount: 0, readyCount: 0, missingKeyCount: 40, missingVectorCount: 40 }).state).toBe('40 need keys and vectors (warning)');
            expect(stateOf({ keyCount: 30, readyCount: 30, missingKeyCount: 10 }).state).toBe('10 need keys (warning)');
            expect(stateOf({ vectorCount: 1, readyCount: 1, missingVectorCount: 39 }).state).toBe('39 need vectors (warning)');
            expect(stateOf({ keyCount: 35, vectorCount: 30, readyCount: 25, missingKeyCount: 5, missingVectorCount: 10 }).state).toBe('15 need keys or vectors (warning)');
        });

        it('counts only the entries LoreBase decides, so selected ones it skips, as disabled entries, never keep a book from ready', () => {
            expect(stateOf({ selectedCount: 75, decidedCount: 23, keyCount: 23, vectorCount: 23, readyCount: 23 })).toEqual({
                state: 'Ready (success)', lines: ['75 selected, 23 with keys, 23 with vectors'],
            });
            expect(stateOf({ selectedCount: 75, decidedCount: 23, keyCount: 13, vectorCount: 23, readyCount: 13, missingKeyCount: 10 }).state)
                .toBe('10 need keys (warning)');
        });

        it('says another embedding model made its vectors, and how many failed with the first reason on a line of its own', () => {
            expect(stateOf({ vectorCount: 0, readyCount: 0, missingVectorCount: 40, otherModelCount: 40 }).state).toBe('Vectors from another embedding model (warning)');
            expect(stateOf({ keyCount: 37, readyCount: 37, missingKeyCount: 3, failedCount: 3, firstFailure: 'its answer held no list of keys' })).toEqual({
                state: '3 failed (danger)', lines: ['40 selected, 37 with keys, 40 with vectors', 'First failure: its answer held no list of keys'],
            });
        });

        it('shows the writing run on the book it writes now, with its entries done of those it writes, before anything else', () => {
            expect(stateOf({ failedCount: 3, readyCount: 37, writing: { isKeys: true, done: 12, total: 40 } })).toEqual({
                state: 'Writing keys, 12 of 40 (accent)', lines: ['40 selected, 40 with keys, 40 with vectors'],
            });
            expect(stateOf({ writing: { isKeys: false, done: 1200, total: 1221 } }).state).toBe('Vectorizing, 1,200 of 1,221 (accent)');
        });

        it('shows no state before the keys and vectors are read, nor on a book with nothing selected', () => {
            document.body.innerHTML = loreBaseBooksMarkup({ hasChat: true, books: [
                listedBook({ bookName: 'Harbor Atlas', selectedCount: 40, isLockedToChat: true, isLockedToCharacter: false }),
                book({ bookName: 'Tide Tables', selectedCount: 0, readyCount: 0 }),
            ] });
            expect([...document.querySelectorAll('.vfx-row')].map(row => [...row.querySelectorAll('.vfx-pill')].map(pill => pill.textContent.trim())))
                .toEqual([['Locked to this chat'], ['Locked to this chat']]);
        });

        it('counts the ready and waiting entries of the books locked here under the list, or says none with a selection is locked here', () => {
            const lineOf = books => {
                document.body.innerHTML = loreBaseBooksMarkup({ hasChat: true, books });
                return document.querySelector('.vfx-list + .vfx-hint')?.textContent ?? null;
            };
            expect(lineOf([
                book({ bookName: 'Harbor Atlas', selectedCount: 312, decidedCount: 312, readyCount: 312 }),
                book({ bookName: 'Keeper Notes', selectedCount: 52, decidedCount: 40, readyCount: 0, isLockedToChat: false, isLockedToCharacter: true }),
                book({ bookName: 'Tide Tables', selectedCount: 9, decidedCount: 9, readyCount: 9, isLockedToChat: false, selectionInUseId: null }),
            ])).toBe('2 books locked here: 312 entries ready, 40 entries waiting for keys or vectors.');
            expect(lineOf([book({ selectedCount: 1, decidedCount: 1, readyCount: 1 })])).toBe('1 book locked here: 1 entry ready.');
            expect(lineOf([book({ selectedCount: 75, decidedCount: 23, readyCount: 23 })])).toBe('1 book locked here: 23 entries ready.');
            expect(lineOf([book({ isLockedToChat: false, selectionInUseId: null })])).toBe('No book with selected entries is locked here, so LoreBase sends none of them.');
            expect(lineOf([listedBook({ bookName: 'Harbor Atlas', selectedCount: 40, isLockedToChat: true, isLockedToCharacter: false })])).toBeNull();
        });
    });

    it('draws Add a lorebook under the books when given the books to add: a list, and a button for each place, this chat first, and this chat alone in a group chat', () => {
        const addRow = add => {
            document.body.innerHTML = loreBaseBooksMarkup({ hasChat: true, books: [], add });
            const list = document.getElementById('VectFox_lorebase_add_book');
            return {
                label: document.querySelector('label[for="VectFox_lorebase_add_book"]')?.textContent ?? null,
                options: list ? [...list.options].map(option => [option.value, option.textContent]) : null,
                buttons: [...document.querySelectorAll('[data-lorebase-add]')].map(button => [button.dataset.lorebaseAdd, button.textContent.trim()]),
                hint: document.querySelector('.vfx-hint')?.textContent ?? null,
            };
        };
        expect(addRow({ bookNames: ['Tide Tables', 'The <b>Old</b> "Keep"'], canAddToCharacter: true })).toEqual({
            label: 'Add a lorebook',
            options: [['', 'Choose a lorebook'], ['Tide Tables', 'Tide Tables'], ['The <b>Old</b> "Keep"', 'The <b>Old</b> "Keep"']],
            buttons: [['chat', 'Add to this chat'], ['character', 'Add to this character']],
            hint: 'This chat: here only, while LoreBase is on, locked here. This character: its chats, locked to it.',
        });
        expect(document.body.textContent).toContain('This chat loads no lorebook.');
        expect(addRow({ bookNames: ['Tide Tables'], canAddToCharacter: false })).toMatchObject({
            buttons: [['chat', 'Add to this chat']],
            hint: 'A group chat has no one character, so a book goes to this chat only, while LoreBase is on, locked here.',
        });
        expect(addRow({ bookNames: [], canAddToCharacter: true })).toEqual({ label: null, options: null, buttons: [], hint: 'This chat loads every lorebook you have.' });
    });

    it('draws no Add a lorebook while no chat is open', () => {
        document.body.innerHTML = loreBaseBooksMarkup({ hasChat: false, books: [], add: { bookNames: ['Tide Tables'], canAddToCharacter: true } });
        expect(document.getElementById('VectFox_lorebase_add_book')).toBeNull();
    });

    it('shows a book named like markup as written, and opens it by that name', () => {
        expect(rowsOf({ hasChat: true, books: [listedBook({ bookName: 'The <b>Old</b> "Keep"', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false })] })[0])
            .toMatchObject({ name: 'The <b>Old</b> "Keep"', opens: 'The <b>Old</b> "Keep"' });
        expect(document.querySelector('.vfx-row b')).toBeNull();
    });
});

describe("the tester's report (§5.10)", () => {
    const lighthouse = {
        bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', basis: 'named in the chat', certain: true,
        why: 'Wren asks who keeps the lamp.', needs: 'the keeper', wholeText: 'whole',
        review: {
            uses: 'some', seconds: 4.12,
            parts: [{ text: 'The lighthouse stands on the north cliff.', isSent: true }, { text: 'It was raised after the long storm.', isSent: false }],
            sentText: 'The lighthouse stands on the north cliff.',
        },
        failure: null, isInPrompt: true,
    };
    const tidewardens = {
        bookName: 'Harbor Atlas', uid: 1, title: 'Tidewardens', basis: 'in the scene, not named', certain: false,
        why: 'The bells may ring.', needs: 'the bells', wholeText: 'whole', review: null,
        failure: 'it did not answer within 30 seconds', isInPrompt: null,
    };
    const measured = {
        id: 7, chatId: 'chat', type: 'swipe', accuracy: 'high', madeAt: Date.UTC(2026, 10, 15, 15, 42, 10),
        contentCount: 3, picks: [lighthouse, tidewardens], skipped: [{ bookName: 'Harbor Atlas', uid: 2, title: 'Old Pier' }],
        unreadItemCount: 0,
        failures: [{ step: 'review', title: 'Tidewardens', detail: 'it did not answer within 30 seconds' }],
        pickTokens: { prompt: 15070, cached: 10141 },
        seconds: { pick: 2.63, slowestReview: 4.12, total: 6.81 },
        isUnderWay: false, messageIndex: 12, swipeId: 1, isMeasuring: false, measureFailure: null,
        tokens: { sent: 412, pickedWhole: 1230, picks: [{ sent: 412, whole: 1230 }, null], promptWorldInfo: 5000 },
        keysState: 'measured', keys: { entries: 3, tokens: 3456, worldInfo: 8044 },
    };
    const drawn = report => {
        document.body.innerHTML = loreBaseReportMarkup(report);
        return {
            summary: [...document.querySelectorAll('.vfx-stack > .vfx-result > .vfx-result-line')].map(line => line.textContent),
            records: [...document.querySelectorAll('.vfx-stack > .vfx-record')].map(record => ({
                name: record.querySelector('.vfx-record-name').textContent,
                pills: [...record.querySelector('.vfx-record-header').querySelectorAll('.vfx-pill')].map(pill => pill.textContent.trim()),
                lines: [...record.querySelector('.vfx-record-body').children].filter(child => child.matches('.vfx-result'))
                    .flatMap(list => [...list.querySelectorAll('.vfx-result-line')]).map(line => line.textContent),
            })),
        };
    };

    it('says the open chat has no report yet', () => {
        expect(loreBaseReportMarkup(null)).toContain('No reply in this chat used LoreBase since the page loaded.');
    });

    it("sums the reply up: the pick, the time, the tokens against SillyTavern's keys, and each failure", () => {
        expect(drawn(measured).summary).toEqual([
            'Picked: 2 of 3 selected entries',
            "Pick read from the cache: 10,141 of the pick's 15,070 prompt tokens",
            'Time: pick 2.6 s, slowest review 4.1 s, 6.8 s in all',
            'LoreBase sent: 412 tokens, from 1,230 in the same entries whole',
            "SillyTavern's keys: 3 selected entries, 3,456 tokens",
            'World Info in the prompt: 5,000 tokens; SillyTavern alone 8,044 tokens',
            'A review failed: Tidewardens: it did not answer within 30 seconds',
        ]);
    });

    it("says on High Accuracy when the provider did not report the pick's tokens read from its cache, and nothing of it on Fast and Cheap [Jev] or a failed pick (§7.5)", () => {
        const cacheLines = report => drawn(report).summary.filter(line => line.startsWith('Pick read from the cache'));
        expect(cacheLines({ ...measured, pickTokens: { prompt: 15070, cached: null } }))
            .toEqual(["Pick read from the cache: not reported by the provider, of the pick's 15,070 prompt tokens"]);
        expect(cacheLines({ ...measured, pickTokens: { prompt: 15070, cached: 0 } })).toEqual(["Pick read from the cache: 0 of the pick's 15,070 prompt tokens"]);
        expect(cacheLines({ ...measured, pickTokens: null })).toEqual(['Pick read from the cache: not reported by the provider']);
        expect(cacheLines({ ...measured, accuracy: 'fast', pickTokens: null })).toEqual([]);
        expect(cacheLines({ ...measured, pickTokens: null, picks: [], failures: [{ step: 'pick', title: null, detail: 'it did not answer within 30 seconds' }] })).toEqual([]);
    });

    it("shows each pick with Luna's reasons and its review, its parts folded, then the entries left out", () => {
        const { records } = drawn(measured);
        expect(records).toEqual([
            {
                name: 'Lighthouse of Vell', pills: ['Certain', 'Uses some'],
                lines: ['Book: Harbor Atlas', 'Basis: named in the chat', 'Why: Wren asks who keeps the lamp.', 'Wants: the keeper', 'Sends: 1 of 2 parts, 412 of 1,230 tokens, reviewed in 4.1 s'],
            },
            {
                name: 'Tidewardens', pills: ['Might', 'Review failed'],
                lines: ['Book: Harbor Atlas', 'Basis: in the scene, not named', 'Why: The bells may ring.', 'Wants: the bells', 'Review failed: it did not answer within 30 seconds'],
            },
            { name: 'Not picked', pills: ['1'], lines: ['Old Pier'] },
        ]);
        const parts = document.querySelector('[data-lorebase-parts="0"]');
        expect([...parts.querySelectorAll('.vfx-pill')].map(pill => pill.textContent)).toEqual(['1 of 2 kept']);
        expect([...parts.querySelectorAll('.vfx-result-line')].map(line => [line.textContent, line.classList.contains('is-success')])).toEqual([
            ['The lighthouse stands on the north cliff.', true],
            ['It was raised after the long storm.', false],
        ]);
        expect(parts.querySelector('.vfx-collapse')).not.toBeNull();
        expect(document.querySelector('[data-lorebase-skipped] .vfx-collapse')).not.toBeNull();
    });

    it('shows a one-part pick as sent whole with no review (T20), with no review time', () => {
        const ferry = {
            ...lighthouse, title: 'Ferry Tolls',
            review: { uses: 'whole', seconds: null, parts: [{ text: 'The ferry costs two copper bits.', isSent: true }], sentText: 'The ferry costs two copper bits.' },
        };
        const { records } = drawn({ ...measured, picks: [ferry], failures: [], tokens: { ...measured.tokens, picks: [{ sent: 9, whole: 9 }] } });
        expect(records[0].pills).toEqual(['Certain', 'Sent whole, not reviewed']);
        expect(records[0].lines.at(-1)).toBe('Sends: 1 of 1 parts, 9 of 9 tokens, not reviewed');
    });

    it("shows Jev's rating on a Fast and Cheap [Jev] pick, which has no reasons of Luna's (D16)", () => {
        const jevPick = {
            bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', basis: undefined, certain: undefined, why: undefined, needs: undefined, yes: 0.64,
            wholeText: 'The lighthouse stands on the north cliff.', failure: null, isInPrompt: true,
            review: { uses: 'whole', seconds: null, parts: [{ text: 'The lighthouse stands on the north cliff.', isSent: true }], sentText: 'The lighthouse stands on the north cliff.' },
        };
        const { records } = drawn({ ...measured, accuracy: 'fast', picks: [jevPick], failures: [], tokens: { ...measured.tokens, picks: [{ sent: 9, whole: 9 }] } });
        expect(records[0].pills).toEqual(['Sent whole, not reviewed']);
        expect(records[0].lines).toEqual(['Book: Harbor Atlas', 'Jev rated it: 0.64', 'Sends: 1 of 1 parts, 9 of 9 tokens, not reviewed']);
    });

    it("says on Fast and Cheap [Jev] how many entries the search kept for Jev, and its seconds beside Jev's", () => {
        const searched = drawn({
            ...measured, accuracy: 'fast', contentCount: 313, search: { seats: 100, poolCount: 100 },
            seconds: { search: 0.62, pick: 0.48, slowestReview: null, total: 1.12 },
        });
        expect(searched.summary).toEqual(expect.arrayContaining([
            'Searched: Jev was asked about the 100 best of 313 entries', 'Time: search 0.6 s, pick 0.5 s, 1.1 s in all',
        ]));
        const few = drawn({ ...measured, accuracy: 'fast', contentCount: 21, search: { seats: 100, poolCount: null } });
        expect(few.summary).toContain('No search: Jev was asked about all 21 entries, as a search runs above 100');
        // A search that failed says so in the pick's failure, not as no search.
        const failed = drawn({
            ...measured, accuracy: 'fast', contentCount: 313, search: { seats: 100, poolCount: null }, picks: [], skipped: [],
            failures: [{ step: 'pick', title: null, detail: 'the search failed: Hybrid query failed' }],
        });
        expect(failed.summary.some(line => /search/u.test(line) && !line.startsWith('The pick failed'))).toBe(false);
        expect(failed.summary).toContain('The pick failed: the search failed: Hybrid query failed');
        expect(drawn(measured).summary.some(line => line.startsWith('Searched') || line.startsWith('No search'))).toBe(false);
    });

    it("marks a pick SillyTavern's World Info budget cut, and names each entry's book when the reply read several", () => {
        const cut = { ...lighthouse, isInPrompt: false };
        const skipped = [{ bookName: 'Wren Journal', uid: 4, title: 'Fog Season' }];
        const { records } = drawn({ ...measured, picks: [cut], skipped, failures: [] });
        expect(records[0].pills).toEqual(['Certain', 'Uses some', "Cut by SillyTavern's budget"]);
        expect(records[1].lines).toEqual(['Fog Season · Wren Journal']);
    });

    it("waits for the reply to end, then for SillyTavern's keys while a reply is under way", () => {
        expect(drawn({ ...measured, isUnderWay: true, tokens: null, keysState: 'unmeasured', keys: null }).summary)
            .toContain('Tokens are counted once the reply ends.');
        expect(drawn({ ...measured, keysState: 'waiting', keys: null }).summary).toEqual(expect.arrayContaining([
            "What SillyTavern's keys would send is measured when no reply is under way.",
            'World Info in the prompt: 5,000 tokens',
        ]));
        expect(drawn({ ...measured, keysState: 'unavailable', keys: null }).summary)
            .toContain("What SillyTavern's keys would send was not measured for this reply.");
    });

    it('says when the pick failed, so nothing went in', () => {
        const failed = { ...measured, picks: [], skipped: [], failures: [{ step: 'pick', title: null, detail: 'its answer could not be read' }] };
        expect(drawn(failed).summary).toContain('The pick failed: its answer could not be read');
        expect(document.body.textContent).toContain('The pick failed, so no entry went in.');
    });

    it('shows a title written like markup as written', () => {
        drawn({ ...measured, picks: [{ ...lighthouse, title: 'The <b>Old</b> Keep' }], failures: [] });
        expect(document.querySelector('.vfx-record-name').textContent).toBe('The <b>Old</b> Keep');
        expect(document.querySelector('.vfx-record b')).toBeNull();
    });

    it('lists the Reply options newest first, each by its time, its kind and its message', () => {
        const time = new Date(measured.madeAt).toLocaleTimeString('en-GB', { hour12: false });
        document.body.innerHTML = `<select>${loreBaseReportOptions([
            { ...measured, id: 9, type: 'normal', isUnderWay: true, messageIndex: null, swipeId: null },
            measured,
            { ...measured, id: 3, type: 'continue', messageIndex: 10, swipeId: 0 },
        ], 7)}</select>`;
        expect([...document.querySelectorAll('option')].map(option => [option.value, option.textContent, option.selected])).toEqual([
            ['9', `${time} · send · under way`, false],
            ['7', `${time} · swipe · message #12, swipe 2`, true],
            ['3', `${time} · continue · message #10`, false],
        ]);
    });

    it("draws a try's report: listed as a try with no reply, its tokens without SillyTavern's keys, which need a reply", () => {
        const time = new Date(measured.madeAt).toLocaleTimeString('en-GB', { hour12: false });
        const tried = {
            ...measured, type: 'try', isTry: true, messageIndex: null, swipeId: null, keysState: 'unavailable', keys: null,
            tokens: { ...measured.tokens, promptWorldInfo: null },
        };
        document.body.innerHTML = `<select>${loreBaseReportOptions([tried], 7)}</select>`;
        expect(document.querySelector('option').textContent).toBe(`${time} · try · no reply`);
        expect(drawn(tried).summary).toEqual([
            'Picked: 2 of 3 selected entries',
            "Pick read from the cache: 10,141 of the pick's 15,070 prompt tokens",
            'Time: pick 2.6 s, slowest review 4.1 s, 6.8 s in all',
            'LoreBase sent: 412 tokens, from 1,230 in the same entries whole',
            "A try sends no reply, so what SillyTavern's keys would send is not measured.",
            'A review failed: Tidewardens: it did not answer within 30 seconds',
        ]);
    });

    it("says Jev rated no entry above the cut when Fast and Cheap [Jev] picked none, and Luna picked none otherwise", () => {
        drawn({ ...measured, accuracy: 'fast', picks: [], failures: [] });
        expect(document.body.textContent).toContain('Jev rated no entry above 0.25 for this reply.');
        drawn({ ...measured, picks: [], failures: [] });
        expect(document.body.textContent).toContain('Luna picked no entry for this reply.');
    });
});
