/**
 * @vitest-environment jsdom
 *
 * The settings panel's Core page on GUI-DNA (src/features/settings-panel/core-page-markup.js) and the number boxes on
 * it (number-setting.js): every control keeps the id settings-panel.js wires it by, the rows the wiring shows and hides
 * start hidden, a slider sits beside each short-range number box, and a number box saves a typed value held to its
 * limits, saves nothing while half-typed, and shows the saved value once left.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({ extensionSettings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));

vi.mock('../src/sillytavern/settings.js', () => ({
    extension_settings: host.extensionSettings,
    saveSettingsDebounced: host.saveSettingsDebounced,
}));

const { corePageMarkup } = await import('../src/features/settings-panel/core-page-markup.js');
const { bindNumberSetting } = await import('../src/features/settings-panel/number-setting.js');

const LANGUAGE_MODES = [{ value: 'intl', label: 'Default' }, { value: 'jieba', label: 'Jieba' }];
const markup = () => corePageMarkup({ languageModes: LANGUAGE_MODES, retrievalTimeout: { minMs: 5000, maxMs: 120000, defaultMs: 30000 } });

// The ids settings-panel.js wires on the Core page.
const WIRED_IDS = [
    'VectFox_vector_backend', 'VectFox_qdrant_plugin_notice', 'VectFox_qdrant_plugin_error', 'VectFox_qdrant_settings', 'VectFox_qdrant_use_cloud',
    'VectFox_qdrant_local_settings', 'VectFox_qdrant_host', 'VectFox_qdrant_port', 'VectFox_qdrant_cloud_settings', 'VectFox_qdrant_url',
    'VectFox_qdrant_api_key', 'VectFox_qdrant_multitenancy', 'VectFox_source', 'VectFox_provider_settings', 'VectFox_ollama_use_alt_endpoint',
    'VectFox_ollama_alt_endpoint_row', 'VectFox_ollama_alt_endpoint_url', 'VectFox_ollama_model', 'VectFox_ollama_keep', 'VectFox_vllm_use_alt_endpoint',
    'VectFox_vllm_alt_endpoint_row', 'VectFox_vllm_alt_endpoint_url',
    'VectFox_vllm_model', 'VectFox_vllm_api_key', 'VectFox_vllm_api_key_clear', 'VectFox_openrouter_model', 'VectFox_openrouter_model_choose',
    'VectFox_openrouter_model_list', 'VectFox_openrouter_apikey', 'VectFox_openrouter_apikey_clear', 'VectFox_rate_limit_calls', 'VectFox_rate_limit_interval',
    'VectFox_vector_group_embedding_call', 'VectFox_vector_hedge_enabled', 'VectFox_summarize_provider', 'VectFox_summarize_settings',
    'VectFox_summarize_openrouter_row', 'VectFox_summarize_openrouter_apikey', 'VectFox_summarize_openrouter_apikey_clear', 'VectFox_summarize_vllm_url_row',
    'VectFox_summarize_vllm_url', 'VectFox_summarize_vllm_apikey', 'VectFox_summarize_vllm_apikey_clear', 'VectFox_summarize_model',
    'VectFox_summarize_model_choose', 'VectFox_summarize_model_list', 'VectFox_generation_rate_limit_calls', 'VectFox_generation_rate_limit_interval',
    'VectFox_should_send_temperature', 'VectFox_should_use_max_completion_tokens', 'VectFox_should_disable_thinking', 'VectFox_query_depth',
    'VectFox_min_chat_length', 'VectFox_deduplication_depth', 'VectFox_eventbase_dedup_window_gap', 'VectFox_eventbase_anchor_boost',
    'VectFox_retrieval_timeout_ms', 'VectFox_eventbase_native_rerank_wrapper', 'VectFox_eventbase_native_rerank', 'VectFox_retrieval_popup_on_start',
    'VectFox_retrieval_popup_on_result', 'VectFox_injection_position', 'VectFox_injection_depth_row', 'VectFox_injection_depth',
    'VectFox_keyword_method_section', 'VectFox_keyword_scoring_method', 'VectFox_native_hybrid_info', 'VectFox_bm25_params', 'VectFox_bm25_k1',
    'VectFox_bm25_b', 'VectFox_bm25_use_corpus_idf', 'VectFox_hybrid_params', 'VectFox_hybrid_fusion_method', 'VectFox_hybrid_weights',
    'VectFox_hybrid_vector_weight', 'VectFox_hybrid_text_weight', 'VectFox_hybrid_rrf_settings', 'VectFox_hybrid_rrf_k', 'VectFox_cjk_tokenizer_mode',
    'VectFox_custom_stopwords',
];

describe('Core page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${markup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('starts every row the wiring shows on demand hidden', () => {
        const startsHidden = ['VectFox_qdrant_plugin_notice', 'VectFox_qdrant_plugin_error', 'VectFox_qdrant_settings', 'VectFox_qdrant_cloud_settings',
            'VectFox_summarize_settings', 'VectFox_summarize_openrouter_row', 'VectFox_summarize_vllm_url_row', 'VectFox_openrouter_model_list',
            'VectFox_summarize_model_list', 'VectFox_injection_depth_row', 'VectFox_native_hybrid_info', 'VectFox_hybrid_weights',
            'VectFox_ollama_alt_endpoint_row', 'VectFox_vllm_alt_endpoint_row'];
        for (const id of startsHidden) expect(document.getElementById(id).style.display, id).toBe('none');
        const providers = [...document.querySelectorAll('#VectFox_provider_settings > [data-provider]')];
        expect(providers.map(block => block.dataset.provider)).toEqual(['ollama', 'vllm', 'openrouter']);
        expect(providers.every(block => block.style.display === 'none')).toBe(true);
    });

    it('pairs a slider with each short-range number box, on the same limits', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_query_depth', 'VectFox_eventbase_anchor_boost', 'VectFox_hybrid_vector_weight', 'VectFox_hybrid_text_weight']);
        for (const range of ranges) {
            const box = document.getElementById(range.dataset.vfxSliderFor);
            expect(box.type).toBe('number');
            expect([range.min, range.max, range.step]).toEqual([box.min, box.max, box.step]);
            expect((Number(box.max) - Number(box.min)) / Number(box.step)).toBeLessThanOrEqual(20);
        }
    });

    it('keeps keys masked, offers the tokenizer modes it is given, and puts the timeout limits in the box', () => {
        for (const id of ['VectFox_qdrant_api_key', 'VectFox_vllm_api_key', 'VectFox_openrouter_apikey', 'VectFox_summarize_openrouter_apikey', 'VectFox_summarize_vllm_apikey']) {
            expect(document.getElementById(id).type, id).toBe('password');
            expect(document.getElementById(id).getAttribute('autocomplete'), id).toBe('off');
        }
        expect([...document.querySelectorAll('#VectFox_cjk_tokenizer_mode option')].map(option => option.value)).toEqual(['intl', 'jieba']);
        const timeout = document.getElementById('VectFox_retrieval_timeout_ms');
        expect([timeout.min, timeout.max]).toEqual(['5000', '120000']);
        expect(document.querySelector('#VectFox_retrieval_timeout_ms ~ .vfx-detail').textContent).toContain('Default 30000 ms, from 5 to 120 s');
    });
});

describe('bindNumberSetting', () => {
    let settings;

    beforeEach(() => {
        vi.stubGlobal('$', $);
        host.saveSettingsDebounced.mockReset();
        document.body.innerHTML = '<input type="number" id="a_box" min="1" max="20" step="1">';
        settings = { query: 4 };
        host.extensionSettings.vectfox = settings;
        bindNumberSetting(settings, { id: 'a_box', key: 'query', initial: settings.query, isInteger: true });
    });

    const type = (value) => $('#a_box').val(value).trigger('input');

    it('shows the saved value, and saves what is typed', () => {
        expect($('#a_box').val()).toBe('4');
        type('7');
        expect(settings.query).toBe(7);
        expect(host.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('holds a typed value to the box\'s limits, and shows the saved value once the user leaves the box', () => {
        type('99');
        expect(settings.query).toBe(20);
        $('#a_box').trigger('change');
        expect($('#a_box').val()).toBe('20');
        type('0');
        expect(settings.query).toBe(1);
    });

    it('saves nothing while the box is empty, and gives the saved value back once left', () => {
        type('');
        expect(settings.query).toBe(4);
        expect(host.saveSettingsDebounced).not.toHaveBeenCalled();
        $('#a_box').trigger('change');
        expect($('#a_box').val()).toBe('4');
    });

    it('drops a fraction where the setting must be whole, and keeps one where it takes one', () => {
        type('6.9');
        expect(settings.query).toBe(6);
        document.body.insertAdjacentHTML('beforeend', '<input type="number" id="a_weight" min="0" max="1" step="0.1">');
        bindNumberSetting(settings, { id: 'a_weight', key: 'weight', initial: 0.5 });
        $('#a_weight').val('0.3').trigger('input');
        expect(settings.weight).toBe(0.3);
    });
});
