/**
 * @vitest-environment jsdom
 *
 * StoryArc page: showing, hiding and showing again, and moving between its tabs, on the page's real code and markup,
 * with GUI-DNA's gene behaviours bound around it, as the panel binds them, so its Sub-tabs switch as they do there.
 * The rail shows and hides it (settings-panel/panel-shell.js). Its web is drawn when the LinkGraph tab shows, since a
 * web drawn in a hidden tab lays out at no size, and stops on any other tab. A web that finishes drawing after the page
 * hid is closed, so nothing is left running for the next show.
 */
/* global document, KeyboardEvent -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';
import { storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';
import { bindGeneBehaviours } from '../src/shared/gui-dna/gene-behaviours.js';

const host = vi.hoisted(() => ({ drawStoryWeb: vi.fn() }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: () => {}, warn: () => {} } }));
vi.mock('../src/features/eventbase/story-arc-web.js', () => ({ drawStoryWeb: host.drawStoryWeb }));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    readChatStoryEvents: async () => ({ events: [], registryKey: 'a-collection', problem: '' }),
}));
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({
    readEntityMerges: () => ({}),
    saveEntityMerges: () => {},
    readHiddenEntityNames: () => [],
    saveHiddenEntityNames: () => {},
}));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));

const madeUpWeb = () => ({ destroy: vi.fn(), setPaused: vi.fn() });
const openTab = tab => document.querySelector(`[data-vfx-subtab="${tab}"]`).click();
const isPanelShown = tab => !document.querySelector(`[data-vfx-subtab-panel="${tab}"]`).hidden;

let showStoryArcPage;
let hideStoryArcPage;

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('$', $);
    host.drawStoryWeb.mockReset();
    host.drawStoryWeb.mockImplementation(async () => madeUpWeb());
    // A new root each test, so the behaviours bound on it are bound once.
    document.body.innerHTML = `<div id="panel">${storyArcPageMarkup()}</div>`;
    bindGeneBehaviours(document.getElementById('panel'));
    let wireStoryArcPage;
    ({ showStoryArcPage, hideStoryArcPage, wireStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js'));
    wireStoryArcPage({});
});

describe('StoryArc page on the rail, on the LinkGraph tab', () => {
    beforeEach(() => openTab('linkgraph'));

    it('draws its web each time it shows', async () => {
        await showStoryArcPage();
        hideStoryArcPage();
        await showStoryArcPage();
        expect(host.drawStoryWeb).toHaveBeenCalledTimes(2);
    });

    it('draws once when shown twice without hiding', async () => {
        await showStoryArcPage();
        await showStoryArcPage();
        expect(host.drawStoryWeb).toHaveBeenCalledTimes(1);
    });

    it('closes the web when it hides', async () => {
        const web = madeUpWeb();
        host.drawStoryWeb.mockResolvedValueOnce(web);
        await showStoryArcPage();
        hideStoryArcPage();
        expect(web.destroy).toHaveBeenCalledTimes(1);
    });

    it('closes a web that finishes drawing after the page hid, and leaves nothing for the next show', async () => {
        const toast = { error: vi.fn() };
        vi.stubGlobal('toastr', toast);
        let finishDrawing;
        host.drawStoryWeb.mockReturnValueOnce(new Promise((resolve) => {
            finishDrawing = resolve;
        }));
        const firstShow = showStoryArcPage();
        await vi.waitFor(() => expect(host.drawStoryWeb).toHaveBeenCalledTimes(1));
        hideStoryArcPage();

        const lateWeb = madeUpWeb();
        finishDrawing(lateWeb);
        await firstShow;
        expect(lateWeb.destroy).toHaveBeenCalledTimes(1);
        expect(toast.error).not.toHaveBeenCalled();

        await showStoryArcPage();
        hideStoryArcPage();
        expect(lateWeb.destroy).toHaveBeenCalledTimes(1);
    });
});

describe('StoryArc page tabs', () => {
    it('are Main, LinkGraph and Entity, with the story web only on LinkGraph', () => {
        expect([...document.querySelectorAll('[data-vfx-subtab]')].map(tab => tab.textContent.trim())).toEqual(['Main', 'LinkGraph', 'Entity']);
        const web = document.getElementById('VectFox_story_arc_web');
        expect(web.closest('[data-vfx-subtab-panel]').dataset.vfxSubtabPanel).toBe('linkgraph');
    });

    it('switch with the arrow keys too, drawing the web when the keys reach LinkGraph', async () => {
        await showStoryArcPage();
        document.querySelector('[data-vfx-subtab="main"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

        expect(isPanelShown('linkgraph')).toBe(true);
        expect(document.activeElement.dataset.vfxSubtab).toBe('linkgraph');
        await vi.waitFor(() => expect(host.drawStoryWeb).toHaveBeenCalledTimes(1));
    });

    it('open on Main, which draws no web', async () => {
        await showStoryArcPage();

        expect(isPanelShown('main')).toBe(true);
        expect(isPanelShown('linkgraph')).toBe(false);
        expect(host.drawStoryWeb).not.toHaveBeenCalled();
    });

    it('draw the web when LinkGraph first shows, once, and into its shown panel', async () => {
        await showStoryArcPage();
        openTab('linkgraph');

        await vi.waitFor(() => expect(host.drawStoryWeb).toHaveBeenCalledTimes(1));
        expect(host.drawStoryWeb.mock.calls[0][0].id).toBe('VectFox_story_arc_web');
        expect(isPanelShown('linkgraph')).toBe(true);
        openTab('entity');
        openTab('linkgraph');
        await Promise.resolve();
        expect(host.drawStoryWeb).toHaveBeenCalledTimes(1);
    });

    it('pause the web on another tab and run it again on LinkGraph', async () => {
        const web = madeUpWeb();
        host.drawStoryWeb.mockResolvedValueOnce(web);
        openTab('linkgraph');
        await showStoryArcPage();
        expect(web.setPaused).toHaveBeenLastCalledWith(false);

        openTab('main');
        expect(web.setPaused).toHaveBeenLastCalledWith(true);
        openTab('linkgraph');
        expect(web.setPaused).toHaveBeenLastCalledWith(false);
    });

    it('pause a web that finishes drawing after LinkGraph was left, and draw no second one on return', async () => {
        const web = madeUpWeb();
        let finishDrawing;
        host.drawStoryWeb.mockReturnValueOnce(new Promise((resolve) => {
            finishDrawing = resolve;
        }));
        openTab('linkgraph');
        const shown = showStoryArcPage();
        await vi.waitFor(() => expect(host.drawStoryWeb).toHaveBeenCalledTimes(1));
        openTab('main');
        openTab('linkgraph');
        openTab('entity');

        finishDrawing(web);
        await shown;
        expect(web.setPaused).toHaveBeenLastCalledWith(true);
        expect(host.drawStoryWeb).toHaveBeenCalledTimes(1);
    });
});
