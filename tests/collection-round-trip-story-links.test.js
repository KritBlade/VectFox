/**
 * A collection exported and imported through the Database Browser keeps its StoryArc links.
 *
 * Runs the real exportCollection, importCollection and link graph. Only the host and the plugin's
 * chunk endpoints are faked; the fake stores points the way the plugin does, where a point's hash
 * comes from the item and its other metadata travels as sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const COLLECTION_ID = 'vf_eventbase_qdrant_rabbit_kagami_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

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
vi.mock('../../../../utils.js', () => ({
    getStringHash: vi.fn(text => [...text].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1000000007, 7)),
}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: {
        show: vi.fn(),
        updateCurrentItem: vi.fn(),
        updateChunks: vi.fn(),
        updateProgress: vi.fn(),
        updateEmbeddingProgress: vi.fn(),
        setCancelHandler: vi.fn(),
        clearCancelHandler: vi.fn(),
        complete: vi.fn(),
        addError: vi.fn(),
    },
}));
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    encodeSparseVector: vi.fn(() => ({ indices: [], values: [] })),
    getAdditionalArgs: vi.fn(),
    getSavedHashes: vi.fn(),
    getBackend: vi.fn(),
    setInsertedCollectionRegistrar: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import { purgeVectorIndex } from '../src/features/vector-backend/index.js';
import { exportCollection, importCollection } from '../src/features/collections/collection-export.js';
import { buildStoryLinkGraph, measureStoryLinkCoverage } from '../src/features/eventbase/story-arc-links-core.js';

const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter' };
const FIRST_HASH = 9007199254740001;
const SECOND_HASH = 9007199254740002;
const THIRD_HASH = 9007199254740003;

let storedItems = [];

function storedEvent(hash, text, position, storyLinks) {
    return {
        hash,
        text,
        vector: [0.1, 0.2, 0.3],
        metadata: { eventbase: true, hash, text, event_id: `event-${position}`, source_window_start: position, source_window_end: position + 1, story_links: storyLinks },
    };
}

function fakePluginFetch(url, request) {
    const body = JSON.parse(request.body);
    if (url.endsWith('/chunks/list')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, items: storedItems }) });
    }
    if (url.endsWith('/chunks/insert')) {
        const inserted = body.items.map(item => ({
            hash: item.hash,
            text: item.text,
            vector: item.vector,
            metadata: { ...item.metadata, text: item.text, hash: item.hash },
        }));
        storedItems = [...storedItems, ...inserted];
        return Promise.resolve({ ok: true, json: async () => ({ success: true, inserted: inserted.length }), text: async () => '' });
    }
    throw new Error(`Unexpected request: ${url}`);
}

function eventsAsRetrievalReadsThem() {
    return storedItems
        .filter(item => item.metadata?.eventbase === true)
        .map(item => ({ ...item.metadata, text: item.text, _hash: Number(item.hash) }));
}

describe('a Database Browser export and import of a linked collection', () => {
    let exportFile;

    beforeEach(async () => {
        vi.clearAllMocks();
        extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [], chunk_metadata: {} };
        vi.stubGlobal('fetch', fakePluginFetch);
        purgeVectorIndex.mockImplementation(async () => {
            storedItems = [];
            return true;
        });
        storedItems = [
            storedEvent(FIRST_HASH, 'the gate opens', 10, []),
            storedEvent(SECOND_HASH, 'the guard falls', 20, [{ event_id: 'event-10', type: 'continues', thread: 'the gate' }]),
            storedEvent(THIRD_HASH, 'the city answers', 30, [{ event_id: 'event-20', type: 'caused_by', thread: 'the gate' }]),
        ];
        exportFile = await exportCollection(COLLECTION_ID, SETTINGS, { backend: 'qdrant', source: 'openrouter', model: '' });
    });

    it('writes the links into the export file', () => {
        expect(exportFile.chunks.map(chunk => chunk.metadata.story_links.length)).toEqual([0, 1, 1]);
    });

    it('gives the imported points new hashes, which is why links do not name them', async () => {
        await importCollection(exportFile, SETTINGS, { overwrite: true });

        expect(eventsAsRetrievalReadsThem().map(event => event._hash)).not.toContain(FIRST_HASH);
    });

    it('keeps every link walkable after the import', async () => {
        const before = buildStoryLinkGraph(eventsAsRetrievalReadsThem());

        await importCollection(exportFile, SETTINGS, { overwrite: true });

        const after = buildStoryLinkGraph(eventsAsRetrievalReadsThem());
        expect(before.parents.size).toBe(2);
        expect(after.parents.size).toBe(2);
        expect(measureStoryLinkCoverage(eventsAsRetrievalReadsThem())).toMatchObject({ linkedCount: 2, hasUsableLinks: true });
    });
});
