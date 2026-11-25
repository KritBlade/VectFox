/**
 * A far-behind vectorization tip gets checked against the backend.
 *
 * SillyTavern saves the whole settings file from whichever tab saves last, so a tab left open or a
 * restored backup can put back a tip from long before the collection's events. A known tip is
 * otherwise never re-read, so the panel shows the old number, ticking Auto-sync offers to re-extract
 * a backlog that does not exist, and ghosting takes out only the messages below it.
 *
 * Runs the real ensureVectorizationTip and the real pointer, kept in each collection's record, with only the backend
 * and the host faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ name1: 'Rabbit', name2: 'Kagami', chat: [] })),
}));
vi.mock('../../../../../script.js', () => ({
    characters: [],
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(() => ({})),
    getCurrentChatId: vi.fn(() => 'chat.jsonl'),
}));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    encodeSparseVector: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(),
    setInsertedCollectionRegistrar: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import { log } from '../src/sillytavern/log.js';
import { getBackend } from '../src/features/vector-backend/index.js';
import {
    FAR_BEHIND_WINDOW_COUNT,
    countWindowsBehind,
    ensureVectorizationTip,
    getVectorizationTip,
    isWindowAlreadyExtracted,
    markWindowExtracted,
    setVectorizationTip,
} from '../src/features/eventbase/eventbase-store.js';

const SETTINGS = { vector_backend: 'qdrant' };
const SYNC_PROGRESS = { commitBoundary: 2620, windowSize: 2 };
const OLD_WINDOW = [11, 22];

let collectionCount = 0;

/** The registry key of a collection no test used yet: the check runs once per collection per page load. */
const freshCollectionKey = () => `qdrant:vf_eventbase_qdrant_rabbit_kagami_chat-${++collectionCount}`;
const collectionIdOf = registryKey => registryKey.slice('qdrant:'.length);

/** A collection whose pointer stops at this tip. */
function collectionWithSavedTip(tip) {
    const registryKey = freshCollectionKey();
    markWindowExtracted(OLD_WINDOW, registryKey);
    setVectorizationTip(registryKey, tip);
    return registryKey;
}

function backendHolding(events) {
    const listChunks = vi.fn().mockResolvedValue({
        items: events.map(({ end, createdAt }) => ({ metadata: { source_window_end: end, created_at: createdAt } })),
    });
    getBackend.mockResolvedValue({ listChunks });
    return listChunks;
}

/** What one run leaves: a window of 2 messages at a time, each newer than the one before. */
function eventsOfOneRun(lastEnd, startTime = 1000) {
    const events = [];
    for (let end = 1; end <= lastEnd; end += 2) events.push({ end, createdAt: startTime + end });
    return events;
}

function pointerOf(registryKey) {
    return {
        tip: getVectorizationTip(registryKey),
        savedTip: extension_settings.vectfox.collections?.[registryKey]?.eventbaseProgress?.vectorizationTip,
        isWindowRemembered: isWindowAlreadyExtracted(OLD_WINDOW, registryKey),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.vectfox = {};
});

describe('countWindowsBehind', () => {
    it('counts whole Auto-sync windows between the tip and the sync boundary', () => {
        expect(countWindowsBehind(2620, 224, 2)).toBe(1198);
        expect(countWindowsBehind(2620, 2611, 2)).toBe(4);
        expect(countWindowsBehind(2620, 2620, 2)).toBe(0);
    });

    it('counts nothing when the tip is past the boundary', () => {
        expect(countWindowsBehind(2620, 2626, 2)).toBe(0);
    });
});

describe('a tip far behind the chat', () => {
    it('is raised to what the collection holds, and the window record goes with it', async () => {
        backendHolding(eventsOfOneRun(2619));
        const registryKey = collectionWithSavedTip(224);

        const tip = await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS);

        expect(tip).toBe(2620);
        expect(pointerOf(registryKey)).toEqual({ tip: 2620, savedTip: 2620, isWindowRemembered: false });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('224'));
    });

    it('is checked from exactly the far-behind line, at this Auto-sync window size', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));

        const fourWindowsBehind = collectionWithSavedTip(2620 - 2 * (FAR_BEHIND_WINDOW_COUNT - 1));
        expect(await ensureVectorizationTip(fourWindowsBehind, SETTINGS, SYNC_PROGRESS)).toBe(2612);
        expect(listChunks).not.toHaveBeenCalled();

        const fiveWindowsBehind = collectionWithSavedTip(2620 - 2 * FAR_BEHIND_WINDOW_COUNT);
        expect(await ensureVectorizationTip(fiveWindowsBehind, SETTINGS, SYNC_PROGRESS)).toBe(2620);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('goes by the window size in use, not by a message count', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const tenMessageWindows = { commitBoundary: 2620, windowSize: 10 };

        const fortyMessagesBehind = collectionWithSavedTip(2580);
        await ensureVectorizationTip(fortyMessagesBehind, SETTINGS, tenMessageWindows);
        expect(listChunks).not.toHaveBeenCalled();

        const fiftyMessagesBehind = collectionWithSavedTip(2570);
        await ensureVectorizationTip(fiftyMessagesBehind, SETTINGS, tenMessageWindows);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('stays when the collection agrees, because the backlog is real', async () => {
        backendHolding(eventsOfOneRun(223));
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('is never lowered, because windows with no events leave nothing in the collection', async () => {
        backendHolding(eventsOfOneRun(99));
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('is read once per collection per page load', async () => {
        const listChunks = backendHolding(eventsOfOneRun(223));
        const registryKey = collectionWithSavedTip(224);

        await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS);
        await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS);

        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('is read once when two status refreshes overlap', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const registryKey = collectionWithSavedTip(224);

        await Promise.all([
            ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS),
            ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS),
        ]);

        expect(listChunks).toHaveBeenCalledTimes(1);
        expect(getVectorizationTip(registryKey)).toBe(2620);
    });

    it('is kept with a warning when the read fails, and the next status read tries again', async () => {
        const failure = new Error('backend down');
        getBackend.mockResolvedValue({ listChunks: vi.fn().mockRejectedValue(failure) });
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(collectionIdOf(registryKey)), failure);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });

        backendHolding(eventsOfOneRun(2619));
        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(2620);
    });

    it('stays when the backend lists no positions, as Standard does without the plugin', async () => {
        const listChunks = vi.fn().mockResolvedValue({ items: [{ hash: 1 }, { hash: 2 }] });
        getBackend.mockResolvedValue({ listChunks });
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('is raised when older events carry no time', async () => {
        backendHolding(eventsOfOneRun(2619).map(({ end }) => ({ end })));
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(2620);
    });
});

describe('a Vectorize stopped part way', () => {
    // It reads the chat again from the start, replacing each window's events as it reaches the window,
    // so older events still reach past its tip. Its tip is the run's own progress, and Resume has to
    // carry on from there.
    const olderEvents = eventsOfOneRun(2619);

    it('keeps its tip and window record', async () => {
        backendHolding([...olderEvents, ...eventsOfOneRun(223, 9000)]);
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('keeps them when the page died before the last batch was saved', async () => {
        backendHolding([...olderEvents, ...eventsOfOneRun(239, 9000)]);
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(pointerOf(registryKey)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });
});

describe('reads that give no sync progress', () => {
    it('trust a known tip and stay off the backend', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const registryKey = collectionWithSavedTip(224);

        expect(await ensureVectorizationTip(registryKey, SETTINGS)).toBe(224);
        expect(listChunks).not.toHaveBeenCalled();
    });

    it('still probe a cold collection once, keeping the result in memory only', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const coldKey = freshCollectionKey();

        expect(await ensureVectorizationTip(coldKey, SETTINGS)).toBe(2620);
        expect(await ensureVectorizationTip(coldKey, SETTINGS)).toBe(2620);

        expect(listChunks).toHaveBeenCalledTimes(1);
        expect(listChunks).toHaveBeenCalledWith(collectionIdOf(coldKey), SETTINGS, expect.anything());
        expect(extension_settings.vectfox.collections?.[coldKey]).toBeUndefined();
    });

    it('report no tip for a cold collection that is empty', async () => {
        backendHolding([]);

        expect(await ensureVectorizationTip(freshCollectionKey(), SETTINGS)).toBeNull();
    });
});
