/**
 * @vitest-environment jsdom
 *
 * The settings panel's AutoSync page on GUI-DNA (src/features/settings-panel/autosync-page-markup.js): every control
 * keeps the id settings-panel.js wires it by, the window hold and the ghosting note start hidden, the cards the wiring
 * hides on Standard without the plugin carry their ids, the window, the event count, the messages kept and the batch size have a
 * slider on their box's limits, the size cap carries its own, the page is drawn from GUI-DNA alone, the auto-sync status says what auto-sync
 * is doing in each state with the tone that state takes, and Collection in use here lists the open chat's own collections,
 * then New collection (§1.2 of vectfox-multi-collection-per-chat.md).
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { AUTOSYNC_IN_USE_ID, autoSyncCollectionMarkup, autoSyncPageMarkup, autoSyncStatusMarkup } = await import('../src/features/settings-panel/autosync-page-markup.js');
const { IN_USE_NEW } = await import('../src/features/settings-panel/in-use-switcher-markup.js');

// The ids settings-panel.js wires on the AutoSync page.
const WIRED_IDS = [
    'VectFox_autosync_collection', 'VectFox_autosync_enabled', 'VectFox_autosync_status', 'VectFox_eventbase_autosync_window_turns', 'VectFox_autosync_window_lock_hint',
    'VectFox_autosync_popup', 'VectFox_autosync_show_progress_modal', 'VectFox_summarizer_injection_group', 'VectFox_summarizer_injection_enabled',
    'VectFox_summarizer_injection_count', 'VectFox_summarizer_injection_max_chars', 'VectFox_summarizer_injection_full_detail',
    'VectFox_eventbase_ghost_group', 'VectFox_eventbase_ghost_needs_summarizer', 'VectFox_eventbase_ghost_enabled', 'VectFox_eventbase_ghost_keep_recent',
    'VectFox_eventbase_ghost_batch_size', 'VectFox_eventbase_ghost_readout',
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
        for (const id of ['VectFox_eventbase_ghost_keep_recent', 'VectFox_eventbase_ghost_batch_size']) {
            expect(document.getElementById(id).closest('#VectFox_eventbase_ghost_group'), id).not.toBeNull();
        }
    });

    it('pairs a slider with the window, the event count, the messages kept and the batch size, on their boxes\' limits', () => {
        const ranges = [...document.querySelectorAll('.vfx-range[data-vfx-slider-for]')];
        expect(ranges.map(range => range.dataset.vfxSliderFor)).toEqual(['VectFox_eventbase_autosync_window_turns', 'VectFox_summarizer_injection_count',
            'VectFox_eventbase_ghost_keep_recent', 'VectFox_eventbase_ghost_batch_size']);
        for (const range of ranges) expect([range.min, range.max, range.step], range.dataset.vfxSliderFor).toEqual(limitsOf(range.dataset.vfxSliderFor));
        expect(limitsOf('VectFox_eventbase_autosync_window_turns')).toEqual(['1', '20', '1']);
        expect(limitsOf('VectFox_summarizer_injection_count')).toEqual(['1', '50', '1']);
        expect(limitsOf('VectFox_eventbase_ghost_keep_recent')).toEqual(['1', '50', '1']);
        expect(limitsOf('VectFox_eventbase_ghost_batch_size')).toEqual(['1', '100', '1']);
        expect(limitsOf('VectFox_summarizer_injection_max_chars')).toEqual(['0', '100000', '500']);
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

describe('Collection in use here (§1.2 of vectfox-multi-collection-per-chat.md)', () => {
    const drawn = (collections, inUseKey) => {
        document.body.innerHTML = autoSyncCollectionMarkup(collections, inUseKey);
        const list = document.getElementById(AUTOSYNC_IN_USE_ID);
        return list && {
            label: document.querySelector(`label[for="${AUTOSYNC_IN_USE_ID}"]`)?.textContent,
            options: [...list.options].map(option => [option.value, option.textContent, option.selected]),
        };
    };

    it("lists the chat's own collections by name, the one in use chosen, then New collection", () => {
        expect(drawn([
            { registryKey: 'qdrant:first', name: '💬 Chat: Harbor Keeper', isLockedHere: false },
            { registryKey: 'qdrant:later', name: 'Harbor <b>Keeper</b> 2', isLockedHere: true },
        ], 'qdrant:later')).toEqual({
            label: 'Collection in use here',
            options: [
                ['qdrant:first', '💬 Chat: Harbor Keeper', false],
                ['qdrant:later', 'Harbor <b>Keeper</b> 2', true],
                [IN_USE_NEW, 'New collection', false],
            ],
        });
        expect(document.querySelector('b')).toBeNull();
    });

    it('opens on None in use here while none is in use, and draws nothing for a chat with no collection', () => {
        expect(drawn([{ registryKey: 'qdrant:first', name: 'Harbor Keeper', isLockedHere: false }]).options)
            .toEqual([['', 'None in use here', true], ['qdrant:first', 'Harbor Keeper', false], [IN_USE_NEW, 'New collection', false]]);
        expect(autoSyncCollectionMarkup([])).toBe('');
    });

    it('opens on None in use here with two locked to the chat, which the route counts as none in use, so either can be chosen', () => {
        expect(drawn([
            { registryKey: 'qdrant:first', name: 'Harbor Keeper', isLockedHere: true },
            { registryKey: 'qdrant:later', name: 'Harbor Keeper 2', isLockedHere: true },
        ], null).options).toEqual([
            ['', 'None in use here', true],
            ['qdrant:first', 'Harbor Keeper', false],
            ['qdrant:later', 'Harbor Keeper 2', false],
            [IN_USE_NEW, 'New collection', false],
        ]);
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

    it("warns, in the one route's words, that EventBase reads and writes nothing while none of the chat's collections is in use, pointing at the dropdown above", () => {
        const noneInUseText = 'No collection is in use in this chat, so EventBase reads and writes nothing here.';
        expect(linesOf({ state: 'none-locked', isVectFoxOn: true, noneInUseText })).toEqual([
            { tone: 'warning', text: `${noneInUseText} Choose one above.` },
        ]);
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

    it('says a chat is shorter than what EventBase read, and what auto-sync, ghosting and Sync chat do then', () => {
        expect(linesOf({ ...live, state: 'vectorization-ahead', vectorizedCount: 52 })).toEqual([
            { tone: 'warning', text: 'This chat is shorter than what EventBase read.' },
            { tone: 'plain', text: 'Chat: 40 messages · read: 52 messages' },
            { tone: 'plain', text: 'Messages were deleted, a summary replaced some, or the events came from a longer copy of this chat. Auto-sync goes on with the chat\'s new messages, and ghosting takes nothing out until the chat passes 52 messages. Sync chat on the Action page reads what EventBase has not read.' },
        ]);
    });

    it('gives the state line an icon and the counts none', () => {
        document.body.innerHTML = autoSyncStatusMarkup({ ...live, state: 'fully-vectorized' });
        const lines = [...document.querySelectorAll('.vfx-result-line')];
        expect(lines.map(line => line.querySelectorAll('i').length)).toEqual([1, 0]);
    });
});
