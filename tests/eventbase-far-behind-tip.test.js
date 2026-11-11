/**
 * A far-behind vectorization tip gets checked against the backend.
 *
 * SillyTavern saves the whole settings file from whichever tab saves last, so a tab left open or a
 * restored backup can put back a tip from long before the collection's events. A known tip is
 * otherwise never re-read, so the panel shows the old number, ticking Auto-sync offers to re-extract
 * a backlog that does not exist, and ghosting blanks only the messages below it.
 *
 * Runs the real ensureVectorizationTip and the real records, with only the backend and the host faked.
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

const COLLECTION_ID = 'vf_eventbase_qdrant_rabbit_kagami_test';
const SETTINGS = { vector_backend: 'qdrant' };
const SYNC_PROGRESS = { commitBoundary: 2620, windowSize: 2 };
const OLD_WINDOW = [11, 22];

let chatCount = 0;

/** A chat whose saved records stop at this tip. Each test takes its own: the check runs once per chat per page load. */
function chatWithSavedTip(tip) {
    const chatUUID = `chat-${++chatCount}`;
    markWindowExtracted(OLD_WINDOW, chatUUID);
    setVectorizationTip(chatUUID, tip);
    return chatUUID;
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

async function recordsOf(chatUUID) {
    return {
        tip: getVectorizationTip(chatUUID),
        savedTip: extension_settings.vectfox.eventbase_vectorization_tip?.[chatUUID],
        isWindowRemembered: await isWindowAlreadyExtracted(OLD_WINDOW, null, SETTINGS, chatUUID),
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
        const chatUUID = chatWithSavedTip(224);

        const tip = await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS);

        expect(tip).toBe(2620);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 2620, savedTip: 2620, isWindowRemembered: false });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('224'));
    });

    it('is checked from exactly the far-behind line, at this Auto-sync window size', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));

        const fourWindowsBehind = chatWithSavedTip(2620 - 2 * (FAR_BEHIND_WINDOW_COUNT - 1));
        expect(await ensureVectorizationTip(fourWindowsBehind, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(2612);
        expect(listChunks).not.toHaveBeenCalled();

        const fiveWindowsBehind = chatWithSavedTip(2620 - 2 * FAR_BEHIND_WINDOW_COUNT);
        expect(await ensureVectorizationTip(fiveWindowsBehind, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(2620);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('goes by the window size in use, not by a message count', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const tenMessageWindows = { commitBoundary: 2620, windowSize: 10 };

        const fortyMessagesBehind = chatWithSavedTip(2580);
        await ensureVectorizationTip(fortyMessagesBehind, COLLECTION_ID, SETTINGS, tenMessageWindows);
        expect(listChunks).not.toHaveBeenCalled();

        const fiftyMessagesBehind = chatWithSavedTip(2570);
        await ensureVectorizationTip(fiftyMessagesBehind, COLLECTION_ID, SETTINGS, tenMessageWindows);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('stays when the collection agrees, because the backlog is real', async () => {
        backendHolding(eventsOfOneRun(223));
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('is never lowered, because windows with no events leave nothing in the collection', async () => {
        backendHolding(eventsOfOneRun(99));
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('is read once per chat per page load', async () => {
        const listChunks = backendHolding(eventsOfOneRun(223));
        const chatUUID = chatWithSavedTip(224);

        await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS);
        await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS);

        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('is read once when two status refreshes overlap', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const chatUUID = chatWithSavedTip(224);

        await Promise.all([
            ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS),
            ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS),
        ]);

        expect(listChunks).toHaveBeenCalledTimes(1);
        expect(getVectorizationTip(chatUUID)).toBe(2620);
    });

    it('is kept with a warning when the read fails, and the next status read tries again', async () => {
        const failure = new Error('backend down');
        getBackend.mockResolvedValue({ listChunks: vi.fn().mockRejectedValue(failure) });
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(COLLECTION_ID), failure);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });

        backendHolding(eventsOfOneRun(2619));
        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(2620);
    });

    it('stays when the backend lists no positions, as Standard does without the plugin', async () => {
        const listChunks = vi.fn().mockResolvedValue({ items: [{ hash: 1 }, { hash: 2 }] });
        getBackend.mockResolvedValue({ listChunks });
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('is raised when older events carry no time', async () => {
        backendHolding(eventsOfOneRun(2619).map(({ end }) => ({ end })));
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(2620);
    });
});

describe('a Reset & Vectorize stopped part way', () => {
    // It keeps the existing events and re-extracts from the start, so older events still reach past
    // its tip. Its tip is the run's own progress, and Resume has to carry on from there.
    const olderEvents = eventsOfOneRun(2619);

    it('keeps its tip and window record', async () => {
        backendHolding([...olderEvents, ...eventsOfOneRun(223, 9000)]);
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });

    it('keeps them when the page died before the last batch was saved', async () => {
        backendHolding([...olderEvents, ...eventsOfOneRun(239, 9000)]);
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS, SYNC_PROGRESS)).toBe(224);
        expect(await recordsOf(chatUUID)).toEqual({ tip: 224, savedTip: 224, isWindowRemembered: true });
    });
});

describe('reads that give no sync progress', () => {
    it('trust a known tip and stay off the backend', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));
        const chatUUID = chatWithSavedTip(224);

        expect(await ensureVectorizationTip(chatUUID, COLLECTION_ID, SETTINGS)).toBe(224);
        expect(listChunks).not.toHaveBeenCalled();
    });

    it('still probe a cold chat once, keeping the result in memory only', async () => {
        const listChunks = backendHolding(eventsOfOneRun(2619));

        expect(await ensureVectorizationTip('cold-chat', COLLECTION_ID, SETTINGS)).toBe(2620);
        expect(await ensureVectorizationTip('cold-chat', COLLECTION_ID, SETTINGS)).toBe(2620);

        expect(listChunks).toHaveBeenCalledTimes(1);
        expect(extension_settings.vectfox.eventbase_vectorization_tip?.['cold-chat']).toBeUndefined();
    });

    it('report no tip for a cold chat whose collection is empty', async () => {
        backendHolding([]);

        expect(await ensureVectorizationTip('empty-chat', COLLECTION_ID, SETTINGS)).toBeNull();
    });
});
