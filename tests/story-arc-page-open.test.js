/**
 * @vitest-environment jsdom
 *
 * StoryArc page: opening, closing and opening again, on the page's real code and markup. The door to SillyTavern's
 * popup keeps its order on close: the dialog leaves the document, and only then does the wait for the close end. The
 * button's handler logs a failure and shows nothing, so a page that cannot open again looks like a dead button.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORY_ARC_PAGE_HOLDER_ID, STORY_ARC_PAGE_ID, storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';

const host = vi.hoisted(() => ({
    closeDialog: null,
    openPanelPopup: vi.fn(),
    drawStoryWeb: vi.fn(),
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { error: () => {}, warn: () => {} } }));
vi.mock('../src/sillytavern/popup.js', () => ({ openPanelPopup: host.openPanelPopup }));
vi.mock('../src/features/eventbase/story-arc-web.js', () => ({ drawStoryWeb: host.drawStoryWeb }));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    readChatStoryEvents: async () => ({ events: [], registryKey: 'a-collection', problem: '' }),
}));
vi.mock('../src/features/eventbase/story-arc-entities.js', () => ({ readEntityMerges: () => ({}), saveEntityMerges: () => {} }));
vi.mock('../src/features/eventbase/story-arc-retrieval.js', () => ({ findStoryWebEvents: async () => ({}) }));

const madeUpWeb = () => ({ destroy: vi.fn(), setPaused: vi.fn() });

describe('openStoryArcPage', () => {
    let openStoryArcPage;
    let holder;
    let root;
    let failures;

    /** What the button does, up to the web being drawn or asked for. */
    async function clickOpenButton(drawCount) {
        const closed = openStoryArcPage(() => {}).catch(error => failures.push(error));
        await vi.waitFor(() => expect(host.drawStoryWeb).toHaveBeenCalledTimes(drawCount));
        return { closed };
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        failures = [];
        host.drawStoryWeb.mockReset();
        host.drawStoryWeb.mockImplementation(async () => madeUpWeb());
        host.openPanelPopup.mockReset();
        host.openPanelPopup.mockImplementation(panel => new Promise((resolve) => {
            const dialog = document.createElement('dialog');
            dialog.append(panel);
            document.body.append(dialog);
            host.closeDialog = () => {
                dialog.remove();
                resolve();
            };
        }));
        document.body.innerHTML = storyArcPageMarkup();
        holder = document.getElementById(STORY_ARC_PAGE_HOLDER_ID);
        root = document.getElementById(STORY_ARC_PAGE_ID);
        ({ openStoryArcPage } = await import('../src/features/eventbase/story-arc-page.js'));
    });

    it('opens again after it is closed', async () => {
        const firstOpen = await clickOpenButton(1);
        expect(root.closest('dialog')).not.toBeNull();
        host.closeDialog();
        await firstOpen.closed;

        const secondOpen = await clickOpenButton(2);
        expect(host.openPanelPopup).toHaveBeenCalledTimes(2);
        expect(host.openPanelPopup).toHaveBeenLastCalledWith(root);
        expect(root.closest('dialog')).not.toBeNull();
        host.closeDialog();
        await secondOpen.closed;

        expect(failures).toEqual([]);
    });

    it('goes back to its holder on close, and closes the web', async () => {
        const web = madeUpWeb();
        host.drawStoryWeb.mockResolvedValueOnce(web);
        const { closed } = await clickOpenButton(1);
        await vi.waitFor(() => expect(web.setPaused).toHaveBeenCalled());

        host.closeDialog();
        await closed;

        expect(document.getElementById(STORY_ARC_PAGE_ID)).toBe(root);
        expect(holder.contains(root)).toBe(true);
        expect(web.destroy).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
    });

    it('goes back to its holder even when closing the web fails, and reports the failure', async () => {
        const closingFailure = new Error('the web could not close');
        const web = madeUpWeb();
        web.destroy.mockImplementationOnce(() => {
            throw closingFailure;
        });
        host.drawStoryWeb.mockResolvedValueOnce(web);
        const { closed } = await clickOpenButton(1);
        await vi.waitFor(() => expect(web.setPaused).toHaveBeenCalled());

        host.closeDialog();
        await closed;

        expect(holder.contains(root)).toBe(true);
        expect(failures).toEqual([closingFailure]);
    });

    it('closes a web that finishes drawing after the page closed, and leaves nothing for the next open', async () => {
        const toast = { error: vi.fn() };
        vi.stubGlobal('toastr', toast);
        let finishDrawing;
        host.drawStoryWeb.mockReturnValueOnce(new Promise((resolve) => {
            finishDrawing = resolve;
        }));
        const firstOpen = await clickOpenButton(1);
        host.closeDialog();
        await firstOpen.closed;

        const lateWeb = madeUpWeb();
        finishDrawing(lateWeb);
        await vi.waitFor(() => expect(lateWeb.destroy).toHaveBeenCalledTimes(1));
        expect(toast.error).not.toHaveBeenCalled();

        const secondOpen = await clickOpenButton(2);
        host.closeDialog();
        await secondOpen.closed;
        expect(lateWeb.destroy).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
    });
});
