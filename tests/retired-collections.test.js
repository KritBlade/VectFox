/**
 * The start-up deletion of the collections VectFox no longer reads (src/app/retired-collections.js, D5 and §4.5 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): once SillyTavern has loaded it runs the
 * old lorebook collections' part, then the part for the collections of Vectorize Content's retired sources, and shows
 * one notice holding the lorebook lines, then the content lines; it shows nothing when neither part deleted anything.
 * A second call while a run is going joins it, and an error from either part is logged, never thrown. Both parts are
 * replaced here, so each returns the lines a test gives it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ appReadyListeners: [] }));

vi.mock('../src/features/collections/index.js', () => ({ deleteRetiredContentCollections: vi.fn(async () => []) }));
vi.mock('../src/features/lorebase/index.js', () => ({ deleteOldLorebookCollections: vi.fn(async () => []) }));
vi.mock('../src/sillytavern/events.js', () => ({
    event_types: { APP_READY: 'app_ready' },
    eventSource: { once: vi.fn((type, listener) => { if (type === 'app_ready') host.appReadyListeners.push(listener); }) },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ noticePopup: vi.fn(async () => {}) }));

const { deleteRetiredContentCollections } = await import('../src/features/collections/index.js');
const { deleteOldLorebookCollections } = await import('../src/features/lorebase/index.js');
const { eventSource } = await import('../src/sillytavern/events.js');
const { log } = await import('../src/sillytavern/log.js');
const { noticePopup } = await import('../src/sillytavern/popup.js');
const { deleteRetiredCollections } = await import('../src/app/retired-collections.js');

const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'transformers' };
const LOREBOOK_LINES = [{ icon: 'fa-circle-info', text: 'The old lorebook collections are gone.' }, { icon: 'fa-book', name: 'Harbor Atlas' }];
const CONTENT_LINES = [{ icon: 'fa-circle-info', text: 'The collections of the retired sources are gone.' }, { parts: [{ text: 'From documents: ' }, { name: 2 }] }];

/** SillyTavern finishes loading: every APP_READY listener runs. */
function appIsReady() {
    for (const listener of host.appReadyListeners.splice(0)) listener();
}

/** Start a run, let SillyTavern finish loading, and wait for the run to end. */
async function runAtStart() {
    const running = deleteRetiredCollections(SETTINGS);
    appIsReady();
    return running;
}

/** A promise with its resolve outside, to hold a part open. */
function heldOpen() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

beforeEach(() => {
    vi.clearAllMocks();
    host.appReadyListeners = [];
    vi.mocked(deleteOldLorebookCollections).mockReset().mockResolvedValue([]);
    vi.mocked(deleteRetiredContentCollections).mockReset().mockResolvedValue([]);
    vi.mocked(noticePopup).mockReset().mockResolvedValue(undefined);
});

describe('deleting the collections VectFox no longer reads', () => {
    it('waits for SillyTavern to load before either part runs', async () => {
        const running = deleteRetiredCollections(SETTINGS);
        await Promise.resolve();
        expect(deleteOldLorebookCollections).not.toHaveBeenCalled();
        expect(deleteRetiredContentCollections).not.toHaveBeenCalled();

        appIsReady();
        await running;
        expect(deleteOldLorebookCollections).toHaveBeenCalledWith(SETTINGS);
        expect(deleteRetiredContentCollections).toHaveBeenCalledWith(SETTINGS);
    });

    it('runs the lorebook part first, and the content part once it is done', async () => {
        const lorebookPart = heldOpen();
        vi.mocked(deleteOldLorebookCollections).mockReturnValue(lorebookPart.promise);

        const running = runAtStart();
        await vi.waitFor(() => expect(deleteOldLorebookCollections).toHaveBeenCalledTimes(1));
        expect(deleteRetiredContentCollections).not.toHaveBeenCalled();

        lorebookPart.resolve([]);
        await running;
        expect(deleteRetiredContentCollections).toHaveBeenCalledTimes(1);
    });

    it('shows one notice with the lorebook lines, then the content lines', async () => {
        vi.mocked(deleteOldLorebookCollections).mockResolvedValue(LOREBOOK_LINES);
        vi.mocked(deleteRetiredContentCollections).mockResolvedValue(CONTENT_LINES);

        await runAtStart();

        expect(noticePopup).toHaveBeenCalledTimes(1);
        expect(noticePopup).toHaveBeenCalledWith([...LOREBOOK_LINES, ...CONTENT_LINES]);
    });

    it('shows the notice with the lines of the one part that deleted something', async () => {
        vi.mocked(deleteRetiredContentCollections).mockResolvedValue(CONTENT_LINES);
        await runAtStart();
        expect(noticePopup).toHaveBeenCalledWith(CONTENT_LINES);

        vi.mocked(noticePopup).mockClear();
        vi.mocked(deleteOldLorebookCollections).mockResolvedValue(LOREBOOK_LINES);
        vi.mocked(deleteRetiredContentCollections).mockResolvedValue([]);
        await runAtStart();
        expect(noticePopup).toHaveBeenCalledWith(LOREBOOK_LINES);
    });

    it('shows nothing when neither part deleted anything', async () => {
        await runAtStart();
        expect(deleteOldLorebookCollections).toHaveBeenCalledTimes(1);
        expect(deleteRetiredContentCollections).toHaveBeenCalledTimes(1);
        expect(noticePopup).not.toHaveBeenCalled();
    });

    it('joins a run already going rather than deleting twice, and starts afresh once it ended', async () => {
        vi.mocked(deleteOldLorebookCollections).mockResolvedValue(LOREBOOK_LINES);
        const first = deleteRetiredCollections(SETTINGS);
        const second = deleteRetiredCollections(SETTINGS);
        expect(second).toBe(first);
        appIsReady();
        await first;
        expect(eventSource.once).toHaveBeenCalledTimes(1);
        expect(deleteOldLorebookCollections).toHaveBeenCalledTimes(1);
        expect(deleteRetiredContentCollections).toHaveBeenCalledTimes(1);
        expect(noticePopup).toHaveBeenCalledTimes(1);

        const later = deleteRetiredCollections(SETTINGS);
        expect(later).not.toBe(first);
        appIsReady();
        await later;
        expect(deleteOldLorebookCollections).toHaveBeenCalledTimes(2);
    });

    it('logs an error from either part, or from the notice, and never throws', async () => {
        const lorebookError = new Error('the lorebook part broke');
        vi.mocked(deleteOldLorebookCollections).mockRejectedValueOnce(lorebookError);
        await expect(runAtStart()).resolves.toBeUndefined();
        expect(log.error).toHaveBeenLastCalledWith('VectFox: deleting the collections VectFox no longer reads failed:', lorebookError);
        expect(noticePopup).not.toHaveBeenCalled();

        const contentError = new Error('the content part broke');
        vi.mocked(deleteOldLorebookCollections).mockResolvedValue(LOREBOOK_LINES);
        vi.mocked(deleteRetiredContentCollections).mockRejectedValueOnce(contentError);
        await expect(runAtStart()).resolves.toBeUndefined();
        expect(log.error).toHaveBeenLastCalledWith('VectFox: deleting the collections VectFox no longer reads failed:', contentError);
        expect(noticePopup).not.toHaveBeenCalled();

        const noticeError = new Error('the notice could not open');
        vi.mocked(noticePopup).mockRejectedValueOnce(noticeError);
        await expect(runAtStart()).resolves.toBeUndefined();
        expect(log.error).toHaveBeenLastCalledWith('VectFox: deleting the collections VectFox no longer reads failed:', noticeError);
        expect(log.error).toHaveBeenCalledTimes(3);
    });
});
