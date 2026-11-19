/**
 * @vitest-environment jsdom
 *
 * The settings panel's WorldInfo page on GUI-DNA (src/features/settings-panel/worldinfo-page-markup.js): LoreBase's
 * three cards, its switch first, and nothing of the old vector search; every control keeps the id its wiring uses; the
 * page is drawn from GUI-DNA alone with none of the old debug tools; the LoreBase book list says what each book of
 * the open chat has selected and where it is locked; and the tester's report says what LoreBase did on a reply (§5.10).
 */
/* global document, Node -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { loreBaseBooksMarkup, loreBaseReportMarkup, loreBaseReportOptions, worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { KEY_CALLS_AT_ONCE_MAX } = await import('../src/features/lorebase/lorebase-keys-core.js');
const { FAST_AND_CHEAP, loreBaseAccuracyOf } = await import('../src/features/lorebase/lorebase-reply-core.js');

// The ids settings-panel.js, lorebase-books-card.js and lorebase-tester-card.js wire on the WorldInfo page.
const WIRED_IDS = [
    'VectFox_lorebase_enabled', 'VectFox_lorebase_off_notice', 'VectFox_lorebase_books_card', 'VectFox_lorebase_books',
    'VectFox_lorebase_key_calls_at_once', 'VectFox_lorebase_generate_keys', 'VectFox_lorebase_generate_vectors', 'VectFox_lorebase_generate_all',
    'VectFox_lorebase_delete_all', 'VectFox_lorebase_books_status',
    'VectFox_lorebase_model_card', 'VectFox_lorebase_model', 'VectFox_lorebase_accuracy',
    'VectFox_lorebase_jev_connection_profile_rows', 'VectFox_lorebase_jev_connection_profile', 'VectFox_lorebase_jev_connection_profile_readout',
    'VectFox_lorebase_jev_group', 'VectFox_lorebase_jev_test_connection', 'VectFox_lorebase_role_picks', 'VectFox_lorebase_role_keys',
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

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("holds LoreBase's three cards, its books always shown, with the list empty and the door to the selection screen", () => {
        expect([...document.querySelectorAll('.vfx-card-title')].map(title => title.textContent)).toEqual(['LoreBase books', 'LoreBase model', 'LoreBase tester']);
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

    it('adds how many selected entries have keys and vectors once they are read, each count with its unit', () => {
        expect(rowsOf({
            hasChat: true,
            books: [{ bookName: 'Harbor Atlas', selectedCount: 1234, isLockedToChat: true, isLockedToCharacter: false, keyCount: 1200, vectorCount: 0 }],
        })[0].sub).toBe('1,234 selected, 1,200 with keys, 0 with vectors');
    });

    it('shows a book named like markup as written, and opens it by that name', () => {
        expect(rowsOf({ hasChat: true, books: [{ bookName: 'The <b>Old</b> "Keep"', selectedCount: 0, isLockedToChat: false, isLockedToCharacter: false }] })[0])
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
            'Time: pick 2.6 s, slowest review 4.1 s, 6.8 s in all',
            'LoreBase sent: 412 tokens, from 1,230 in the same entries whole',
            "SillyTavern's keys: 3 selected entries, 3,456 tokens",
            'World Info in the prompt: 5,000 tokens; SillyTavern alone 8,044 tokens',
            'A review failed: Tidewardens: it did not answer within 30 seconds',
        ]);
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
