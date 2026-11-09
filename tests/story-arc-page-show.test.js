/**
 * @vitest-environment jsdom
 *
 * StoryArc page: showing, hiding and showing again, on the page's real code and markup. The rail shows and hides it
 * (settings-panel/panel-shell.js); its web draws only while it shows, and a web that finishes drawing after the page
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
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({ readEntityMerges: () => ({}), saveEntityMerges: () => {} }));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));

const madeUpWeb = () => ({ destroy: vi.fn(), setPaused: vi.fn() });

describe('StoryArc page on the rail', () => {
    let showStoryArcPage;
    let hideStoryArcPage;

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        host.drawStoryWeb.mockReset();
        host.drawStoryWeb.mockImplementation(async () => madeUpWeb());
        document.body.innerHTML = storyArcPageMarkup();
        ({ showStoryArcPage, hideStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js'));
    });

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
