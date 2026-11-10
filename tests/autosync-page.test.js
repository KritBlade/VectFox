/**
 * @vitest-environment jsdom
 *
 * The settings panel's AutoSync page on GUI-DNA (src/features/settings-panel/autosync-page-markup.js): every control
 * keeps the id settings-panel.js wires it by, the window hold and the ghosting note start hidden, the cards the wiring
 * hides on Standard without the plugin carry their ids, only the window has a slider, the other numbers carry the
 * limits the wiring holds them to, the page is drawn from GUI-DNA alone, and the auto-sync status says what auto-sync
 * is doing in each state with the tone that state takes.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { autoSyncPageMarkup, autoSyncStatusMarkup } = await import('../src/features/settings-panel/autosync-page-markup.js');

// The ids settings-panel.js wires on the AutoSync page.
const WIRED_IDS = [
    'VectFox_autosync_enabled', 'VectFox_autosync_status', 'VectFox_eventbase_autosync_window_turns', 'VectFox_autosync_window_lock_hint',
    'VectFox_autosync_popup', 'VectFox_autosync_show_progress_modal', 'VectFox_summarizer_injection_group', 'VectFox_summarizer_injection_enabled',
    'VectFox_summarizer_injection_count', 'VectFox_summarizer_injection_max_chars', 'VectFox_summarizer_injection_full_detail',
    'VectFox_eventbase_ghost_group', 'VectFox_eventbase_ghost_needs_summarizer', 'VectFox_eventbase_ghost_enabled', 'VectFox_eventbase_ghost_keep_recent',
    'VectFox_eventbase_ghost_readout',
];

const limitsOf = id => { const box = document.getElementById(id); return [box.min, box.max, box.step]; };

describe('AutoSync page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${autoSyncPageMarkup()}</div>`;
    });

    it('gives every wired control its own id, once', () => {
        for (const id of WIRED_IDS) expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('starts the window hold and the ghosting note hidden, and the status empty for the wiring to fill', () => {
        expect(document.getElementById('VectFox_autosync_window_lock_hint').style.display).toBe('none');
        expect(document.getElementById('VectFox_eventbase_ghost_needs_summarizer').style.display).toBe('none');
        expect(document.getElementById('VectFox_autosync_status').innerHTML).toBe('');
        expect(document.querySelector('#VectFox_eventbase_ghost_readout .vfx-notice-text')).not.toBeNull();
    });

    it('puts Summarizer Injection and Ghosting on cards of their own, for the wiring to hide together', () => {
        for (const id of ['VectFox_summarizer_injection_group', 'VectFox_eventbase_ghost_group']) {
            expect(document.getElementById(id).classList.contains('vfx-card'), id).toBe(true);
        }
        expect(document.getElementById('VectFox_summarizer_injection_enabled').closest('#VectFox_summarizer_injection_group')).not.toBeNull();
        expect(document.getElementById('VectFox_eventbase_ghost_keep_recent').closest('#VectFox_eventbase_ghost_group')).not.toBeNull();
    });

    it('gives only the window a slider, on its box\'s limits, and holds the other numbers to theirs', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_eventbase_autosync_window_turns']);
        expect([ranges[0].min, ranges[0].max, ranges[0].step]).toEqual(limitsOf('VectFox_eventbase_autosync_window_turns'));
        expect(limitsOf('VectFox_eventbase_autosync_window_turns')).toEqual(['1', '20', '1']);
        expect(limitsOf('VectFox_summarizer_injection_count')).toEqual(['1', '50', '1']);
        expect(limitsOf('VectFox_summarizer_injection_max_chars')).toEqual(['0', '100000', '500']);
        expect(limitsOf('VectFox_eventbase_ghost_keep_recent')).toEqual(['0', '100', '1']);
        for (const id of ['VectFox_autosync_enabled', 'VectFox_autosync_popup', 'VectFox_autosync_show_progress_modal', 'VectFox_summarizer_injection_enabled',
            'VectFox_summarizer_injection_full_detail', 'VectFox_eventbase_ghost_enabled']) {
            expect(document.getElementById(id).getAttribute('role'), id).toBe('switch');
        }
    });

    it('draws only GUI-DNA classes, with no value labels beside the numbers', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        expect(document.querySelector('[id$="_val"]')).toBeNull();
    });
});

describe('autoSyncStatusMarkup', () => {
    const linesOf = (status) => {
        document.body.innerHTML = autoSyncStatusMarkup(status);
        return [...document.querySelectorAll('.vfx-result-line')].map(line => ({
            tone: ['success', 'warning'].find(tone => line.classList.contains(`is-${tone}`)) ?? 'plain',
            text: line.textContent.trim(),
        }));
    };
    const live = { isVectFoxOn: true, isOnForChat: true, chatMessageCount: 40, vectorizedCount: 38 };

    it('warns with no chat or no events yet, and shows no counts', () => {
        expect(linesOf({ state: 'no-chat', isVectFoxOn: true })).toEqual([{ tone: 'warning', text: 'No chat open.' }]);
        expect(linesOf({ state: 'no-collection', isVectFoxOn: true })).toEqual([{ tone: 'warning', text: 'Not vectorized yet. Turning auto-sync on starts it.' }]);
    });

    it('says plainly when auto-sync is paused or off, with the counts', () => {
        expect(linesOf({ ...live, state: 'fully-vectorized', isVectFoxOn: false })).toEqual([
            { tone: 'plain', text: 'Paused while VectFox is off.' },
            { tone: 'plain', text: 'Chat: 40 messages · vectorized: 38 messages' },
        ]);
        expect(linesOf({ ...live, state: 'partial', isOnForChat: false })[0]).toEqual({ tone: 'plain', text: 'Off for this chat.' });
    });

    it('marks an up-to-date chat as success, naming a latest turn that waits to settle', () => {
        expect(linesOf({ ...live, state: 'fully-vectorized', isLatestTurnSettling: true })).toEqual([
            { tone: 'success', text: 'Up to date.' },
            { tone: 'plain', text: 'Chat: 40 messages · vectorized: 38 messages · the latest turn waits to settle' },
        ]);
    });

    it('warns about failed windows before a plain backlog, counting them', () => {
        expect(linesOf({ ...live, state: 'partial', unfinishedWindowCount: 1 })[0]).toEqual({ tone: 'warning', text: '1 window failed and holds no events. Resume in Vectorize Content sends them again.' });
        expect(linesOf({ ...live, state: 'partial', unfinishedWindowCount: 3 })[0].text).toBe('3 windows failed and hold no events. Resume in Vectorize Content sends them again.');
        expect(linesOf({ ...live, state: 'partial' })[0]).toEqual({ tone: 'warning', text: 'Behind. The next auto-sync catches up.' });
    });

    it('explains vectorization that reaches past the chat, with the gap', () => {
        expect(linesOf({ ...live, state: 'vectorization-ahead', markerValue: 52 })).toEqual([
            { tone: 'warning', text: 'Vectorization reaches past this chat\'s end, so there is nothing to sync.' },
            { tone: 'plain', text: 'Chat: 40 messages · vectorized: 52 messages (12 ahead)' },
            { tone: 'plain', text: 'Messages may have been deleted, or the events came from a longer copy of this chat. Auto-sync resumes once the chat reaches 52 messages.' },
        ]);
    });

    it('gives the state line an icon and the counts none', () => {
        document.body.innerHTML = autoSyncStatusMarkup({ ...live, state: 'fully-vectorized' });
        const lines = [...document.querySelectorAll('.vfx-result-line')];
        expect(lines.map(line => line.querySelectorAll('i').length)).toEqual([1, 0]);
    });
});
