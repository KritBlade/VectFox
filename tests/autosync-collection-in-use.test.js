/**
 * @vitest-environment jsdom
 *
 * Collection in use here on the AutoSync page (src/features/settings-panel/autosync-collection-in-use.js, §1.2 of
 * vectfox-multi-collection-per-chat.md), chosen as a user would: a collection chosen is put in use through EventBase's one
 * lock function, then the page is drawn again and the collections are said to have changed; "None in use here" does
 * nothing; New collection opens Vectorize Content on New collection, putting nothing in use.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const eventbase = vi.hoisted(() => ({ useChatCollection: vi.fn(), openContentVectorizer: vi.fn() }));
vi.mock('../src/features/eventbase/index.js', () => ({ ...eventbase }));

const { bindCollectionInUse } = await import('../src/features/settings-panel/autosync-collection-in-use.js');
const { AUTOSYNC_IN_USE_ID, autoSyncCollectionMarkup } = await import('../src/features/settings-panel/autosync-page-markup.js');
const { IN_USE_NEW } = await import('../src/features/settings-panel/in-use-switcher-markup.js');

const SETTINGS = { vector_backend: 'qdrant' };
const redraw = vi.fn(async () => {});
const updated = vi.fn();
const choose = value => {
    const list = document.getElementById(AUTOSYNC_IN_USE_ID);
    list.value = value;
    list.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('$', $);
    document.body.innerHTML = '<div id="VectFox_autosync_collection"></div>';
    bindCollectionInUse(SETTINGS, redraw);
    document.getElementById('VectFox_autosync_collection').innerHTML = autoSyncCollectionMarkup([
        { registryKey: 'qdrant:first', name: 'Harbor Keeper', isLockedHere: false },
        { registryKey: 'qdrant:later', name: 'Harbor Keeper 2', isLockedHere: false },
    ]);
    document.addEventListener('vectfox:collections-updated', updated);
});

describe('Collection in use here', () => {
    it('puts the collection chosen in use, draws the page again, and says the collections changed', async () => {
        choose('qdrant:later');
        await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
        expect(eventbase.useChatCollection).toHaveBeenCalledWith('qdrant:later');
        expect(redraw).toHaveBeenCalledWith(SETTINGS);
        expect(eventbase.useChatCollection.mock.invocationCallOrder[0]).toBeLessThan(redraw.mock.invocationCallOrder[0]);
        document.removeEventListener('vectfox:collections-updated', updated);
    });

    it('does nothing on None in use here', async () => {
        choose('');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(eventbase.useChatCollection).not.toHaveBeenCalled();
        expect(redraw).not.toHaveBeenCalled();
        document.removeEventListener('vectfox:collections-updated', updated);
    });

    it('opens Vectorize Content on New collection, drawing the dropdown back to the collection in use, and puts nothing in use', async () => {
        choose(IN_USE_NEW);
        await vi.waitFor(() => expect(eventbase.openContentVectorizer).toHaveBeenCalledWith({ isOnNewCollection: true }));
        expect(redraw).toHaveBeenCalledWith(SETTINGS);
        expect(eventbase.useChatCollection).not.toHaveBeenCalled();
        expect(updated).not.toHaveBeenCalled();
        document.removeEventListener('vectfox:collections-updated', updated);
    });
});
