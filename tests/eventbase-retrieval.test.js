/**
 * EventBase Retrieval Tests
 *
 * Primary purpose: REGRESSION GUARD for the "log is not defined" class of bug.
 * retrieveEvents() once referenced `log` (via log.enabled) without importing it,
 * throwing "ReferenceError: log is not defined" the moment the function ran —
 * but only at message-send time, never at import time, so npm test stayed green
 * and it shipped. This test CALLS retrieveEvents so any missing import / runtime
 * reference error inside the function body surfaces as a failure here.
 *
 * Isolation strategy (important — do NOT replace with a global vitest alias):
 * the modules eventbase-retrieval.js and eventbase-search.js read are mocked below,
 * and the SillyTavern host modules the vector-backend barrel still reaches are
 * empty mocks. This keeps the blast radius to this one file and needs no
 * vitest.config.js change. See [[project_vitest_host_stub]] for why the global
 * alias approach was abandoned (it collided with other tests' vi.mock calls).
 *
 * It also guards the similarity threshold: re-ranked events read their similarity
 * from a plain search, and Standard's query gets EventBase's threshold, never ChunkBase's.
 *
 * NOTE on mocking ./log.js: the `import { log }` line must still EXIST in the
 * source for the `log` binding to resolve to this mock. If someone deletes that
 * import again, `log` becomes an undefined reference and the call-time tests
 * below throw — exactly the regression we are guarding against.
 * 
 * npx vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath C:\tmp\vitest-out.txt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mock every DIRECT dependency of src/features/eventbase/eventbase-retrieval.js ---
const queryCollectionMock = vi.fn();
const getQueryVectorMock = vi.fn();
vi.mock('../src/features/vector-backend/vector-api.js', () => ({
    queryCollection: (...a) => queryCollectionMock(...a),
    getQueryVector: (...a) => getQueryVectorMock(...a),
}));

/** A distinct fake embedding per query text, so tests can tell which vector went where. */
const vectorFor = (text) => [text.length, 0.5];

// The native-rerank path's backend: none, so the plain path runs, except where the
// similarity threshold tests hand it a Qdrant backend.
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackendForCollection: vi.fn(async () => null),
    getBackend: vi.fn(async () => null),
}));

vi.mock('../src/shared/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((id) => ({ backend: null, collectionId: id })),
    resolveBackendForCollection: vi.fn((id) => ({ backend: id.includes(':') ? id.split(':')[0] : null, collectionId: id })),
}));

vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({
    parseEmbedText: vi.fn(() => ({})),
}));

const checkPluginAvailableMock = vi.fn(async () => true);
vi.mock('../src/shared/similharity-plugin.js', () => ({
    checkPluginAvailable: (...a) => checkPluginAvailableMock(...a),
}));

// Permissive log stub: every level is a no-op, predicates return false so the
// debug branches stay quiet. Mocking this avoids loading log.js -> extensions.js
// while STILL requiring the `import { log }` line to exist in the source.
vi.mock('../src/sillytavern/log.js', () => ({
    log: {
        enabled: () => false,
        domainEnabled: () => false,
        error: () => {},
        warn: () => {},
        lifecycle: () => {},
        verbose: () => {},
        trace: () => {},
        domain: () => {},
    },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../extensions.js', () => ({}));
vi.mock('../../../../../script.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { retrieveEvents } from '../src/features/eventbase/eventbase-retrieval.js';
import { getBackend } from '../src/features/vector-backend/backend-registry.js';

const baseSettings = {
    vector_backend: 'standard',
    eventbase_retrieval_top_k: 8,
    eventbase_retrieval_min_importance: 1,
};

function makeEvent(i, overrides = {}) {
    return {
        event_id: `evt_${i}`,
        event_type: `type_${i}`,
        text: `Event number ${i} happened in the story.`,
        importance: 5,
        should_persist: false,
        source_window_end: i,
        score: 0.9 - i * 0.01,
        keywords: [`kw${i}`],
        ...overrides,
    };
}

beforeEach(() => {
    queryCollectionMock.mockReset();
    getQueryVectorMock.mockReset();
    getQueryVectorMock.mockImplementation(async (_backend, text) => vectorFor(text));
    checkPluginAvailableMock.mockReset();
    checkPluginAvailableMock.mockResolvedValue(true);
});

describe('retrieveEvents', () => {
    it('runs without throwing a ReferenceError (missing-import regression guard)', async () => {
        // THE guard: the original bug threw "ReferenceError: log is not defined"
        // on the first line of the function body. This call would have failed.
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        await expect(retrieveEvents({
            searchText: 'what happened to the hero',
            keywordQuery: 'hero',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        })).resolves.not.toThrow();
    });

    it('returns the {events, debug} shape', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        const result = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(result).toBeTypeOf('object');
        expect(Array.isArray(result.events)).toBe(true);
        expect(result.debug).toBeTypeOf('object');
    });

    it('returns ranked events from the live query (non-empty path)', async () => {
        const metadata = [makeEvent(1), makeEvent(2), makeEvent(3)];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { events, debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(queryCollectionMock).toHaveBeenCalled();
        expect(events.length).toBeGreaterThan(0);
        expect(debug.rawCount).toBeGreaterThan(0);
    });

    it('embeds each query text once and passes that vector to every collection\'s query', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a', 'standard:vf_eventbase_b'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        // Two query texts × two collections = four queries, but only two embeddings.
        expect(getQueryVectorMock).toHaveBeenCalledTimes(2);
        expect(queryCollectionMock).toHaveBeenCalledTimes(4);
        for (const [, queryText, , , queryVector] of queryCollectionMock.mock.calls) {
            expect(queryVector).toEqual(vectorFor(queryText));
        }
    });

    it('fails only the live query, not the whole retrieval, when the query embedding fails', async () => {
        getQueryVectorMock.mockRejectedValue(new Error("Query embedding via 'openrouter' failed: 500"));

        const { debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a'],
            additionalCandidates: [makeEvent(10)],
            skipLiveQuery: false,
        });

        expect(queryCollectionMock).not.toHaveBeenCalled(); // no route can run without the vector
        expect(debug.archiveCandidates).toBe(1);
        expect(debug.failedSearchCount).toBe(2);
        expect(debug.searchFailureMessage).toBe("Query embedding via 'openrouter' failed: 500");
        expect(debug.setupFailureMessage).toBe('');
    });

    // Searching again fails the same way until the setup is fixed, so the turn says what to fix.
    it('names the search that failed on its setup, such as a deleted embedding profile', async () => {
        const problem = 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.';
        getQueryVectorMock.mockImplementation(async (_backend, text) => {
            if (text === 'story') throw new Error("Query embedding via 'openrouter' failed: 500");
            throw Object.assign(new Error(problem), { code: 'invalid_model_config' });
        });

        const { debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(debug.failedSearchCount).toBe(2);
        expect(debug.setupFailureMessage).toBe(problem);
    });

    it('still runs the other text\'s queries when one query text fails to embed', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });
        getQueryVectorMock.mockImplementation(async (_backend, text) => {
            if (text === 'story') throw new Error("Query embedding via 'openrouter' failed: 500");
            return vectorFor(text);
        });

        const { debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(queryCollectionMock).toHaveBeenCalledTimes(1);
        expect(queryCollectionMock.mock.calls[0][1]).toBe('story recap');
        expect(debug.failedSearchCount).toBe(1);
    });

    it('counts a live query that fails after its text embedded', async () => {
        queryCollectionMock.mockImplementation(async (_collectionId, text) => {
            if (text === 'story') throw new Error('Qdrant answered 500');
            return { hashes: [], metadata: [] };
        });

        const { debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(debug.failedSearchCount).toBe(1);
        expect(debug.searchFailureMessage).toBe('Qdrant answered 500');
    });

    it('counts no failed search when every query text embeds and every query answers', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        const { debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_a'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(debug.failedSearchCount).toBe(0);
        expect(debug.searchFailureMessage).toBe('');
        expect(debug.setupFailureMessage).toBe('');
    });

    it('skips the live query and folds in archive candidates without calling the backend', async () => {
        const archive = [makeEvent(10), makeEvent(11)];

        const { events, debug } = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: [],
            additionalCandidates: archive,
            skipLiveQuery: true,
        });

        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(debug.archiveCandidates).toBe(2);
        expect(Array.isArray(events)).toBe(true);
    });

    it('collapses duplicate events (same identity) from several searches into one', async () => {
        // Several searches can surface the SAME stored event.
        // Five identical copies (event_id evt_1, score 0.89) + one distinct event
        // arrive via additionalCandidates. Without identity-dedup the similarity
        // score-override escape hatch (0.89 >= 0.75) lets the duplicates through and
        // the "final" list is mostly one event repeated (observed 2026-06-02).
        const candidates = [
            makeEvent(1), makeEvent(1), makeEvent(1), makeEvent(1), makeEvent(1),
            makeEvent(2),
        ];

        const { events } = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: [],
            additionalCandidates: candidates,
            skipLiveQuery: true,
        });

        const ids = events.map(e => e.event_id);
        expect(ids.length).toBe(new Set(ids).size);                 // no repeated identity
        expect(ids.filter(id => id === 'evt_1').length).toBe(1);    // the duplicated event appears once
    });

    it('filters out events below minimum importance', async () => {
        const metadata = [
            makeEvent(1, { importance: 9 }),
            makeEvent(2, { importance: 1 }),
        ];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { debug } = await retrieveEvents({
            searchText: 'q',
            keywordQuery: 'q',
            chatLength: 100,
            settings: { ...baseSettings, eventbase_retrieval_min_importance: 5 },
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        // Only the importance-9 event survives the >=5 filter.
        expect(debug.afterImportanceFilter).toBe(1);
    });
});

describe('retrieveEvents: the similarity threshold', () => {
    const qdrantSettings = { ...baseSettings, vector_backend: 'qdrant', eventbase_native_rerank: true };
    const prefetchLimit = baseSettings.eventbase_retrieval_top_k * 2 * 4;
    let backend;

    const retrieve = (settings, liveCollectionIds = ['qdrant:vf_eventbase_x']) => retrieveEvents({
        searchText: 'the duel at the bridge',
        keywordQuery: 'the duel',
        chatLength: 100,
        settings,
        liveCollectionIds,
        additionalCandidates: [],
        skipLiveQuery: false,
    });

    beforeEach(() => {
        const reranked = [1, 2, 3].map(i => makeEvent(i, { rerankApplied: true }));
        backend = {
            hybridQueryWithRerank: vi.fn(async () => ({ hashes: [1, 2, 3], metadata: reranked })),
            queryCollection: vi.fn(async () => ({ hashes: [1, 2], metadata: [{ hash: 1, score: 0.6 }, { hash: 2, score: 0.2 }] })),
        };
        vi.mocked(getBackend).mockResolvedValue(backend);
    });

    afterEach(() => {
        vi.mocked(getBackend).mockResolvedValue(null);
    });

    it('reads re-ranked events\' similarity from a plain search as wide as the re-rank\'s, and drops those below it', async () => {
        const { events } = await retrieve({ ...qdrantSettings, eventbase_score_threshold: 0.3 });
        expect(events.map(event => event.event_id)).toEqual(['evt_1']);
        expect(backend.queryCollection.mock.calls.map(call => call[2])).toEqual([prefetchLimit, prefetchLimit]);
        expect(backend.hybridQueryWithRerank.mock.calls.map(call => call[5])).toEqual([{ prefetchLimit }, { prefetchLimit }]);
    });

    it('runs no plain search at threshold 0, where every re-ranked event stays', async () => {
        const { events } = await retrieve(qdrantSettings);
        expect(backend.queryCollection).not.toHaveBeenCalled();
        expect(events).toHaveLength(3);
    });

    it('falls back to the plain path when the similarity search fails, which still applies the threshold', async () => {
        backend.queryCollection.mockRejectedValue(new Error('Qdrant answered 500'));
        queryCollectionMock.mockResolvedValue({ hashes: [1, 2], metadata: [makeEvent(1, { score: 0.6 }), makeEvent(2, { score: 0.2 })] });
        const { events } = await retrieve({ ...qdrantSettings, eventbase_score_threshold: 0.3 });
        expect(events.map(event => event.event_id)).toEqual(['evt_1']);
    });

    it('sends Standard\'s query EventBase\'s threshold, never ChunkBase\'s', async () => {
        vi.mocked(getBackend).mockResolvedValue(null);
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });
        await retrieve({ ...baseSettings, score_threshold: 0.25 }, ['standard:vf_eventbase_x']);
        expect(queryCollectionMock.mock.calls.map(call => call[3].score_threshold)).toEqual([0, 0]);
    });
});
