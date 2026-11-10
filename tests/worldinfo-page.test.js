/**
 * @vitest-environment jsdom
 *
 * The settings panel's WorldInfo page on GUI-DNA (src/features/settings-panel/worldinfo-page-markup.js): every
 * control keeps the id settings-panel.js wires it by, the Matching card starts hidden for the wiring to show while
 * semantic activation is on, each number has a slider on its box's limits with the threshold's floor at 0.01, the
 * page is drawn from GUI-DNA alone with none of the old debug tools, and the status says what activation finds in
 * each state with the tone that state takes.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { worldInfoPageMarkup, worldInfoStatusMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');

// The ids settings-panel.js wires on the WorldInfo page.
const WIRED_IDS = [
    'VectFox_enabled_world_info', 'VectFox_wi_status', 'VectFox_world_info_settings', 'VectFox_world_info_threshold',
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

    it('starts the Matching card hidden, holding every matching control, and the status empty', () => {
        const matching = document.getElementById('VectFox_world_info_settings');
        expect(matching.classList.contains('vfx-card')).toBe(true);
        expect(matching.style.display).toBe('none');
        for (const id of ['VectFox_world_info_threshold', 'VectFox_world_info_top_k', 'VectFox_world_info_query_depth', 'VectFox_world_info_retrieval_popup']) {
            expect(document.getElementById(id).closest('#VectFox_world_info_settings'), id).not.toBeNull();
        }
        expect(document.getElementById('VectFox_enabled_world_info').closest('#VectFox_world_info_settings')).toBeNull();
        expect(document.getElementById('VectFox_wi_status').innerHTML).toBe('');
    });

    it('pairs a slider with each number, on its box\'s limits, with the threshold\'s floor at 0.01', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_world_info_threshold', 'VectFox_world_info_top_k', 'VectFox_world_info_query_depth']);
        for (const range of ranges) expect([range.min, range.max, range.step], range.dataset.vfxSliderFor).toEqual(limitsOf(range.dataset.vfxSliderFor));
        expect(limitsOf('VectFox_world_info_threshold')).toEqual(['0.01', '1', '0.01']);
        expect(limitsOf('VectFox_world_info_top_k')).toEqual(['1', '20', '1']);
        expect(limitsOf('VectFox_world_info_query_depth')).toEqual(['1', '10', '1']);
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
