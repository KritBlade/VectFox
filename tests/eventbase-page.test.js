/**
 * @vitest-environment jsdom
 *
 * The settings panel's EventBase page on GUI-DNA (src/features/settings-panel/eventbase-page-markup.js): every
 * control keeps the id settings-panel.js wires it by, the cosine warning starts hidden, each importance, the event
 * count and the similarity threshold have a slider on their number box's limits, the other numbers carry the limits
 * the wiring holds them to, and the page is drawn from GUI-DNA alone.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { eventBasePageMarkup } = await import('../src/features/settings-panel/eventbase-page-markup.js');

// The ids settings-panel.js wires on the EventBase page.
const WIRED_IDS = [
    'VectFox_eventbase_min_importance_store', 'VectFox_eventbase_max_events_per_window', 'VectFox_eventbase_temperature',
    'VectFox_eventbase_max_tokens', 'VectFox_eventbase_timeout_ms', 'VectFox_eventbase_disable_pipeline', 'VectFox_eventbase_retrieval_top_k',
    'VectFox_eventbase_retrieval_min_importance', 'VectFox_eventbase_score_threshold', 'VectFox_eventbase_injection_format', 'VectFox_eventbase_cosine_plugin_warning',
    'VectFox_eventbase_rerank_w_cosine', 'VectFox_eventbase_rerank_w_importance', 'VectFox_eventbase_rerank_w_persist',
    'VectFox_eventbase_rerank_w_recency', 'VectFox_eventbase_reset_weights', 'VectFox_eventbase_prompt_reset', 'VectFox_eventbase_custom_prompt',
];

const limitsOf = id => { const box = document.getElementById(id); return [box.min, box.max, box.step]; };

describe('EventBase page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${eventBasePageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('starts the cosine warning hidden, for the wiring to show on Standard without the plugin', () => {
        expect(document.getElementById('VectFox_eventbase_cosine_plugin_warning').style.display).toBe('none');
    });

    it('pairs a slider with each importance, the event cap and the similarity threshold, on the same limits', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_eventbase_min_importance_store', 'VectFox_eventbase_max_events_per_window', 'VectFox_eventbase_retrieval_min_importance', 'VectFox_eventbase_score_threshold']);
        expect(limitsOf('VectFox_eventbase_score_threshold')).toEqual(['0', '1', '0.05']);
        for (const range of ranges) {
            const box = document.getElementById(range.dataset.vfxSliderFor);
            expect(box.type).toBe('number');
            expect([range.min, range.max, range.step]).toEqual(limitsOf(box.id));
            expect((Number(box.max) - Number(box.min)) / Number(box.step)).toBeLessThanOrEqual(20);
        }
    });

    it('puts the limits the wiring holds each number to in its box', () => {
        expect(limitsOf('VectFox_eventbase_temperature')).toEqual(['0', '2', '0.05']);
        expect(limitsOf('VectFox_eventbase_max_tokens')).toEqual(['256', '32768', '64']);
        expect(limitsOf('VectFox_eventbase_timeout_ms')).toEqual(['5000', '300000', '1000']);
        expect(limitsOf('VectFox_eventbase_retrieval_top_k')).toEqual(['1', '32', '1']);
        for (const id of ['VectFox_eventbase_rerank_w_cosine', 'VectFox_eventbase_rerank_w_importance', 'VectFox_eventbase_rerank_w_persist', 'VectFox_eventbase_rerank_w_recency']) {
            expect(limitsOf(id), id).toEqual(['0', '1', '0.05']);
        }
    });

    it('offers the three injection formats, and puts each reset button in its card\'s header', () => {
        expect([...document.querySelectorAll('#VectFox_eventbase_injection_format option')].map(option => option.value)).toEqual(['jsonarray', 'densetext', 'summaryonly']);
        for (const id of ['VectFox_eventbase_reset_weights', 'VectFox_eventbase_prompt_reset']) {
            expect(document.getElementById(id).closest('.vfx-card-header'), id).not.toBeNull();
        }
        expect(document.getElementById('VectFox_eventbase_custom_prompt').tagName).toBe('TEXTAREA');
    });

    it('draws only GUI-DNA classes and no box for the summarize timeout nothing reads', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        expect(document.getElementById('VectFox_summarize_timeout_ms')).toBeNull();
    });
});
