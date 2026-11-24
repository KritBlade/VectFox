/**
 * @vitest-environment jsdom
 *
 * The settings panel's PublicAPI page on GUI-DNA (src/features/settings-panel/publicapi-page-markup.js): last in the
 * rail, alone in the Development group after StoryArc; one switch, with the id settings-panel.js wires to
 * `own_request_mark_enabled`; and the page drawn from GUI-DNA alone.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { publicApiPageMarkup } = await import('../src/features/settings-panel/publicapi-page-markup.js');
const { PANEL_TABS, panelNavMarkup } = await import('../src/features/settings-panel/panel-shell-markup.js');

describe('PublicAPI page', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="rail">${panelNavMarkup()}</div><div id="page">${publicApiPageMarkup()}</div>`;
    });

    it('sits last in the rail, alone in the Development group after StoryArc', () => {
        expect(PANEL_TABS.slice(-2).map(({ name, group }) => [name, group])).toEqual([['storyarc', 'Retrieval'], ['publicapi', 'Development']]);
        const rail = [...document.querySelectorAll('#rail .vfx-nav-group, #rail [id^="VectFox_tab_"]')]
            .map(element => element.id || element.textContent.trim());
        expect(rail.slice(-3)).toEqual(['VectFox_tab_storyarc', 'Development', 'VectFox_tab_publicapi']);
    });

    it('holds one switch, the one settings-panel.js wires to own_request_mark_enabled', () => {
        const switches = [...document.querySelectorAll('#page input[type="checkbox"]')];
        expect(switches.map(element => element.id)).toEqual(['VectFox_own_request_mark_enabled']);
        expect(switches[0].getAttribute('role')).toBe('switch');
    });

    it('draws only GUI-DNA classes, with no inline style', () => {
        const classes = [...document.querySelectorAll('#page [class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        expect(document.querySelectorAll('#page [style]')).toHaveLength(0);
    });
});
