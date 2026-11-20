/**
 * @vitest-environment jsdom
 *
 * The settings panel's AgentMode page on GUI-DNA (src/features/settings-panel/agentmode-page-markup.js): every control
 * keeps the id settings-panel.js wires it by, both provider rows start hidden for the wiring to show, each holds a
 * masked key box with its delete button, the two short ranges have a slider on their box's limits while the timeouts
 * and the token cap are boxes held to the limits the retrieval path clamps to, and the page is drawn from GUI-DNA
 * alone.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    AGENTIC_MAX_TOKENS_MAX,
    AGENTIC_MAX_TOKENS_MIN,
    AGENTIC_TIMEOUT_MAX_MS,
    AGENTIC_TIMEOUT_MIN_MS,
} from '../src/shared/constants.js';

const { agentModePageMarkup } = await import('../src/features/settings-panel/agentmode-page-markup.js');

// The ids settings-panel.js wires on the AgentMode page.
const WIRED_IDS = [
    'VectFox_agentic_retrieval_enabled', 'VectFox_agentic_max_queries', 'VectFox_agentic_chat_depth', 'VectFox_agentic_provider',
    'VectFox_agentic_model', 'VectFox_agentic_openrouter_row', 'VectFox_agentic_openrouter_apikey', 'VectFox_agentic_openrouter_apikey_clear',
    'VectFox_agentic_vllm_row', 'VectFox_agentic_vllm_url', 'VectFox_agentic_vllm_apikey', 'VectFox_agentic_vllm_apikey_clear',
    'VectFox_agentic_max_tokens', 'VectFox_agentic_timeout', 'VectFox_agentic_query_timeout',
];

const limitsOf = id => { const box = document.getElementById(id); return [box.min, box.max, box.step]; };

describe('AgentMode page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${agentModePageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('offers Same as EventBase model first and a SillyTavern profile second, and starts both provider rows hidden', () => {
        expect([...document.getElementById('VectFox_agentic_provider').options].map(option => option.value)).toEqual(['', 'connection_profile', 'openrouter', 'vllm']);
        for (const id of ['VectFox_agentic_openrouter_row', 'VectFox_agentic_vllm_row']) {
            expect(document.getElementById(id).style.display, id).toBe('none');
        }
        expect(document.getElementById('VectFox_agentic_vllm_url').closest('#VectFox_agentic_vllm_row')).not.toBeNull();
    });

    it('keeps each key box masked and unfilled by the browser, beside its delete button in its own row', () => {
        for (const [row, box, clear] of [
            ['VectFox_agentic_openrouter_row', 'VectFox_agentic_openrouter_apikey', 'VectFox_agentic_openrouter_apikey_clear'],
            ['VectFox_agentic_vllm_row', 'VectFox_agentic_vllm_apikey', 'VectFox_agentic_vllm_apikey_clear'],
        ]) {
            const keyBox = document.getElementById(box);
            expect([keyBox.type, keyBox.autocomplete, keyBox.value], box).toEqual(['password', 'off', '']);
            expect(keyBox.closest(`#${row}`), box).not.toBeNull();
            expect(document.getElementById(clear).closest(`#${row}`), clear).not.toBeNull();
            expect(document.getElementById(clear).type, clear).toBe('button');
        }
    });

    it('pairs a slider with the two short ranges only, and holds the other boxes to the limits retrieval clamps to', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_agentic_max_queries', 'VectFox_agentic_chat_depth']);
        for (const range of ranges) expect([range.min, range.max, range.step], range.dataset.vfxSliderFor).toEqual(limitsOf(range.dataset.vfxSliderFor));
        expect(limitsOf('VectFox_agentic_max_queries')).toEqual(['1', '6', '1']);
        expect(limitsOf('VectFox_agentic_chat_depth')).toEqual(['1', '10', '1']);
        for (const id of ['VectFox_agentic_timeout', 'VectFox_agentic_query_timeout']) {
            expect(limitsOf(id), id).toEqual([String(AGENTIC_TIMEOUT_MIN_MS), String(AGENTIC_TIMEOUT_MAX_MS), '1000']);
        }
        expect(limitsOf('VectFox_agentic_max_tokens')).toEqual([String(AGENTIC_MAX_TOKENS_MIN), String(AGENTIC_MAX_TOKENS_MAX), '256']);
        expect(document.getElementById('VectFox_agentic_retrieval_enabled').getAttribute('role')).toBe('switch');
    });

    it('draws only GUI-DNA classes, with the old value readouts gone', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        for (const id of ['VectFox_agentic_chat_depth_val', 'VectFox_agentic_max_queries_val']) {
            expect(document.getElementById(id), id).toBeNull();
        }
        expect([...document.querySelectorAll('[style]')].map(element => element.id)).toEqual([
            'VectFox_agentic_connection_profile_rows', 'VectFox_agentic_inherited_profile_readout', 'VectFox_agentic_openrouter_row', 'VectFox_agentic_vllm_row',
        ]);
    });
});
