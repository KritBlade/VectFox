/**
 * @vitest-environment jsdom
 *
 * The settings panel's ChunkBase page on GUI-DNA (src/features/settings-panel/chunkbase-page-markup.js): every
 * control keeps the id settings-panel.js wires it by, the two rows the wiring shows and hides start hidden with their
 * label and hint inside them, each short range has a slider on its number box's limits, and the page is drawn from
 * GUI-DNA alone.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { chunkBasePageMarkup } = await import('../src/features/settings-panel/chunkbase-page-markup.js');

// The ids settings-panel.js wires on the ChunkBase page.
const WIRED_IDS = [
    'VectFox_insert_batch_size', 'VectFox_document_glossary_injection', 'VectFox_reformat_provider', 'VectFox_reformat_model',
    'VectFox_reformat_vllm_row', 'VectFox_reformat_vllm_url', 'VectFox_reformat_batch_chars', 'VectFox_reformat_max_body_chars',
    'VectFox_reformat_name_fuzzy_threshold', 'VectFox_reformat_concurrency', 'VectFox_reformat_timeout_ms', 'VectFox_reformat_custom_prompt',
    'VectFox_topk', 'VectFox_score_threshold', 'VectFox_hybrid_keyword_budget_wrapper', 'VectFox_hybrid_keyword_level',
];

const limitsOf = id => { const box = document.getElementById(id); return [box.min, box.max, box.step]; };
const optionValues = id => [...document.querySelectorAll(`#${id} option`)].map(option => option.value);

describe('ChunkBase page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${chunkBasePageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('starts the vLLM URL row and the keyword budget hidden, each holding its own label and hint', () => {
        for (const [rowId, controlId] of [['VectFox_reformat_vllm_row', 'VectFox_reformat_vllm_url'], ['VectFox_hybrid_keyword_budget_wrapper', 'VectFox_hybrid_keyword_level']]) {
            const row = document.getElementById(rowId);
            expect(row.style.display, rowId).toBe('none');
            expect(row.querySelector(`label[for="${controlId}"]`), rowId).not.toBeNull();
            expect(row.querySelector('.vfx-hint'), rowId).not.toBeNull();
        }
    });

    it('pairs a slider with each short-range number box, on the same limits', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_insert_batch_size', 'VectFox_reformat_batch_chars', 'VectFox_reformat_max_body_chars',
            'VectFox_reformat_name_fuzzy_threshold', 'VectFox_reformat_concurrency', 'VectFox_score_threshold']);
        for (const range of ranges) {
            const box = document.getElementById(range.dataset.vfxSliderFor);
            expect(box.type).toBe('number');
            expect([range.min, range.max, range.step]).toEqual(limitsOf(box.id));
            expect((Number(box.max) - Number(box.min)) / Number(box.step)).toBeLessThanOrEqual(20);
        }
    });

    it('holds the timeout and the results per collection to their floors, and offers the provider and budget choices', () => {
        expect(limitsOf('VectFox_reformat_timeout_ms')).toEqual(['10000', '', '1000']);
        expect(limitsOf('VectFox_topk')).toEqual(['1', '', '1']);
        expect(optionValues('VectFox_reformat_provider')).toEqual(['', 'openrouter', 'vllm', 'connection_profile']);
        expect(optionValues('VectFox_hybrid_keyword_level')).toEqual(['minimal', 'balance', 'maximum']);
        expect(document.getElementById('VectFox_document_glossary_injection').type).toBe('checkbox');
        expect(document.getElementById('VectFox_reformat_custom_prompt').tagName).toBe('TEXTAREA');
    });

    it('draws only GUI-DNA classes', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
    });
});
