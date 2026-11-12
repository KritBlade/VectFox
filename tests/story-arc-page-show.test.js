/**
 * @vitest-environment jsdom
 *
 * StoryArc page: showing, hiding and showing again, and moving between its tabs, on the page's real code and markup.
 * The rail shows and hides it (settings-panel/panel-shell.js). Its web is drawn when the LinkGraph tab shows, since a
 * web drawn in a hidden tab lays out at no size, and stops on any other tab. A web that finishes drawing after the page
 * hid is closed, so nothing is left running for the next show.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';

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
const openTab = tab => document.querySelector(`[data-story-arc-tab="${tab}"]`).click();
const isPanelShown = tab => document.querySelector(`[data-story-arc-panel="${tab}"]`).style.display !== 'none';

let showStoryArcPage;
let hideStoryArcPage;

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    host.drawStoryWeb.mockReset();
    host.drawStoryWeb.mockImplementation(async () => madeUpWeb());
    document.body.innerHTML = storyArcPageMarkup();
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
        expect([...document.querySelectorAll('[data-story-arc-tab]')].map(tab => tab.textContent.trim())).toEqual(['Main', 'LinkGraph', 'Entity']);
        const web = document.getElementById('VectFox_story_arc_web');
        expect(web.closest('[data-story-arc-panel]').dataset.storyArcPanel).toBe('linkgraph');
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
