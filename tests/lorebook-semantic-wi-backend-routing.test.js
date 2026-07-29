/**
 * Lorebook semantic World Info retrieval — backend routing contract.
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/world-info-integration.test.js:
 * that suite mocks `queryCollection` itself, so everything below it — backend
 * resolution, the Qdrant-vs-Vectra split, the HTTP call that actually retrieves
 * the chunks — is invisible to it. A routing or transport bug cannot fail it.
 *
 * This suite mocks ONLY `fetch`. Everything from getSemanticWorldInfoEntries
 * down through core-vector-api.js → hybrid-search.js → QdrantBackend /
 * StandardBackend is the real code, so it pins:
 *   - which HTTP endpoint a lorebook query actually reaches, per backend
 *   - that the BARE collection ID survives registry-key → backend resolution
 *   - that chunked lorebooks (no entryUid / no entryName) still yield entries
 *   - which score magnitudes survive world_info_threshold on each backend
 *   - what happens when the backend fails (issue #11's reported symptom)
 *
 * Motivated by GitHub issue #11 — "Qdrant backend does not trigger Semantic
 * Lorebook chunks", reported against chunked lorebooks on Qdrant while chat
 * history retrieval on the same Qdrant instance worked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// HOST MODULE MOCKS
// ============================================================================
// vitest matches mocks by resolved module ID. `tests/` and `core/` are both one
// level below the repo root, so "../../../../extensions.js" from here resolves
// to the same module the core/ files import.

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    modules: [],
    getContext: vi.fn(() => ({
        chat: [],
        groupId: null,
        name1: 'TestPersona',
        name2: 'TestCharacter',
        characterId: 'char123',
    })),
}));

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
    getCurrentChatId: vi.fn(() => 'chat123'),
    chat_metadata: { integrity: 'chat-uuid-123' },
    setExtensionPrompt: vi.fn(),
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: { GENERATION_STARTED: 'GENERATION_STARTED' },
    substituteParams: vi.fn((s) => s),
    saveSettings: vi.fn(),
    saveSettingsDebounced: vi.fn(),
    stopGeneration: vi.fn(),
}));

vi.mock('../../../../secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: vi.fn(),
    readSecretState: vi.fn(),
}));

vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', LLAMACPP: 'llamacpp', VLLM: 'vllm' },
    textgenerationwebui_settings: { server_urls: {} },
}));

vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));

vi.mock('../../../shared.js', () => ({ isWebLlmSupported: vi.fn(() => false) }));

vi.mock('../providers/webllm.js', () => ({
    getWebLlmProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
}));

// Collection discovery is exercised by tests/world-info-integration.test.js.
// Here every test passes `preloadedCollections` explicitly so the subject under
// test is the query path, not the listing/activation gate.
vi.mock('../core/collection-loader.js', () => ({
    getCollectionListing: vi.fn(() => []),
    getCollectionRegistry: vi.fn(() => []),
    checkPluginAvailable: vi.fn(async () => true),
    resetPluginAvailableCache: vi.fn(),
}));

vi.mock('../core/collection-metadata.js', () => ({
    getCollectionMeta: vi.fn(() => ({})),
    isCollectionEnabled: vi.fn(() => true),
    shouldCollectionActivate: vi.fn(async () => true),
}));

vi.mock('../core/lorebook-rename-detector.js', () => ({
    detectLorebookRenames: vi.fn(async () => []),
    showLorebookRenameModal: vi.fn(),
    openDatabaseBrowserForRename: vi.fn(),
}));

import { getSemanticWorldInfoEntries } from '../core/world-info-integration.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { invalidateCollectionMetadata } from '../core/tokenizer-lock.js';
import { resetRetrievalFailureNotifications } from '../core/model-config-notifier.js';

// ============================================================================
// FIXTURES
// ============================================================================

/** Registry keys as content-vectorization.js writes them: "<backend>:<bare id>". */
const QDRANT_LOREBOOK_KEY = 'qdrant:vf_lorebook_qdrant_testpersona_worldlore_1750000000000';
const QDRANT_LOREBOOK_ID = 'vf_lorebook_qdrant_testpersona_worldlore_1750000000000';
const VECTRA_LOREBOOK_KEY = 'vectra:vf_lorebook_standard_testpersona_worldlore_1750000000000';
const VECTRA_LOREBOOK_ID = 'vf_lorebook_standard_testpersona_worldlore_1750000000000';

const LOREBOOK_COLLECTION = {
    id: QDRANT_LOREBOOK_KEY,
    name: 'WorldLore',
    sourceName: 'WorldLore',
};

const RECENT_MESSAGES = [
    'The dragon circled the shattered spire.',
    'Tell me about the dragon of the northern reach.',
];

/**
 * A per_entry lorebook chunk: carries entryName + entryUid, so the live-lorebook
 * resolver can identify it and the title renders from the entry name.
 */
function perEntryChunk(overrides = {}) {
    return {
        hash: 111111,
        text: '# Northern Dragon\nAn ancient wyrm that guards the northern reach.',
        score: 0.83,
        metadata: {
            contentType: 'lorebook',
            sourceName: 'WorldLore',
            entryName: 'Northern Dragon',
            entryUid: 3,
            keywords: [{ text: 'dragon', weight: 1.5 }],
        },
        ...overrides,
    };
}

/**
 * A CHUNKED lorebook chunk — the configuration in issue #11.
 *
 * prepareLorebookContent() only returns `entries` for the per_entry strategy
 * (core/lorebook-content-preparer.js:44-54), so enrichChunks() never takes the
 * lorebook branch for chunked books: entryName and entryUid are null and the
 * entry's WI trigger keys are absent. Only frequency-extracted keywords remain.
 */
function chunkedChunk(overrides = {}) {
    return {
        hash: 222222,
        text: '# Northern Dragon\nAn ancient wyrm that guards the northern reach. '
            + 'Its scales are said to turn aside steel. [KEYWORDS: dragon northern wyrm]',
        score: 0.5,
        metadata: {
            contentType: 'lorebook',
            sourceName: 'WorldLore',
            entryName: null,
            entryUid: null,
            chunkIndex: 2,
            totalChunks: 9,
            keywords: [{ text: 'dragon', weight: 1.2 }, { text: 'wyrm', weight: 1.2 }],
        },
        ...overrides,
    };
}

function baseSettings(overrides = {}) {
    return {
        enabled_world_info: true,
        vector_backend: 'qdrant',
        embedding_provider: 'transformers',
        world_info_threshold: 0.3,
        world_info_top_k: 3,
        world_info_query_depth: 3,
        keyword_scoring_method: 'hybrid',
        hybrid_native_prefer: true,
        cjk_tokenizer_mode: 'intl',
        qdrant_multitenancy: false,
        qdrant_host: '127.0.0.1',
        qdrant_port: 6333,
        ...overrides,
    };
}

// ============================================================================
// FETCH ROUTER
// ============================================================================

/** Every request this test made: { url, body } — assertions read from here. */
let fetchLog = [];
/** Per-test override: (parsedBody) => canned plugin response object. */
let hybridQueryResponder;
/** Per-test override for the vector-only paths (Vectra, and Qdrant's fallback). */
let plainQueryResponder;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Internal Server Error',
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function installFetchRouter() {
    global.fetch = vi.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        fetchLog.push({ url, body });

        // --- backend bootstrap -------------------------------------------------
        if (url === '/api/plugins/similharity/health') return jsonResponse({ ok: true });
        if (url === '/api/plugins/similharity/backend/init/qdrant') return jsonResponse({ success: true });
        if (url === '/api/plugins/similharity/backend/health/qdrant') return jsonResponse({ healthy: true });
        if (url === '/api/plugins/similharity/backend/init/vectra') return jsonResponse({ success: true });
        if (url === '/api/vector/list') return jsonResponse([]);

        // --- tokenizer-mode sentinel (Qdrant native sparse path) ---------------
        if (url === '/api/plugins/similharity/chunks/collection-metadata') {
            return jsonResponse({ payload: { cjk_tokenizer_mode: 'intl' } });
        }

        // --- retrieval ---------------------------------------------------------
        if (url === '/api/plugins/similharity/chunks/hybrid-query') {
            return hybridQueryResponder(body);
        }
        if (url === '/api/plugins/similharity/chunks/query' || url === '/api/vector/query') {
            return plainQueryResponder(body);
        }

        return jsonResponse({ error: `unrouted: ${url}` }, { ok: false, status: 404 });
    });
}

/** URLs of every retrieval call made, in order. */
function queryCalls() {
    return fetchLog
        .filter(e => /chunks\/hybrid-query$|chunks\/query$|api\/vector\/query$/.test(e.url))
        .map(e => e.url);
}

beforeEach(async () => {
    fetchLog = [];
    hybridQueryResponder = () => jsonResponse({ success: true, results: [] });
    plainQueryResponder = () => jsonResponse({ success: true, results: [] });
    installFetchRouter();

    global.toastr = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() };

    // Backend instances and the tokenizer sentinel are cached across calls in
    // production; clear both so each test starts from a cold, deterministic state.
    resetBackendHealth();
    invalidateCollectionMetadata(QDRANT_LOREBOOK_ID);
    invalidateCollectionMetadata(VECTRA_LOREBOOK_ID);
    // The failure toast de-dups per session; without this only the first test that
    // triggers it would see a call.
    resetRetrievalFailureNotifications();

    const { extension_settings } = await import('../../../../extensions.js');
    extension_settings.vectfox = baseSettings();
});

afterEach(() => {
    vi.clearAllMocks();
});

// ============================================================================
// TESTS
// ============================================================================

describe('Qdrant lorebook routing', () => {
    it('sends the lorebook query to the plugin hybrid-query endpoint with the BARE collection ID', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [perEntryChunk()] });

        await getSemanticWorldInfoEntries(RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION]);

        const hybrid = fetchLog.filter(e => e.url === '/api/plugins/similharity/chunks/hybrid-query');
        expect(hybrid.length).toBeGreaterThan(0);
        expect(hybrid[0].body.backend).toBe('qdrant');
        // The "qdrant:" registry prefix must be stripped before it reaches the plugin —
        // sending the prefixed form would address a collection that does not exist.
        expect(hybrid[0].body.collectionId).toBe(QDRANT_LOREBOOK_ID);
        // Native sparse hybrid requires the browser-computed sparse query vector.
        expect(hybrid[0].body.sparseQueryVector).toBeDefined();
        expect(Array.isArray(hybrid[0].body.sparseQueryVector.indices)).toBe(true);
        // A Qdrant collection must never be queried through the Vectra path.
        expect(queryCalls()).not.toContain('/api/vector/query');
    });

    it('returns semantic entries built from the Qdrant hybrid results', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [perEntryChunk()] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toHaveLength(1);
        expect(entries[0].content).toContain('ancient wyrm');
        expect(entries[0].score).toBeCloseTo(0.83, 5);
        expect(entries[0].lorebookName).toBe('WorldLore');
        expect(entries[0].collectionId).toBe(QDRANT_LOREBOOK_ID);
        expect(entries[0].metadata.sourceName).toBe('WorldLore');
    });

    it('falls back to vector-only query when the hybrid endpoint errors', async () => {
        hybridQueryResponder = () => jsonResponse({ error: 'sparse vector not configured' }, { ok: false, status: 500 });
        plainQueryResponder = () => jsonResponse({ success: true, results: [perEntryChunk()] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(queryCalls()).toContain('/api/plugins/similharity/chunks/query');
        expect(entries).toHaveLength(1);
    });
});

describe('Chunked lorebooks (issue #11 configuration)', () => {
    it('produces entries even though chunked chunks carry no entryUid or entryName', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunkedChunk()] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toHaveLength(1);
        expect(entries[0].content).toContain('ancient wyrm');
        // No entryName: the title falls back to the extracted keywords.
        expect(entries[0].metadata.entryName).toBeNull();
        expect(entries[0].metadata.entryUid).toBeNull();
        expect(entries[0].key).toEqual([
            { text: 'dragon', weight: 1.2 },
            { text: 'wyrm', weight: 1.2 },
        ]);
    });

    it('dedups per (sourceName, entryUid) without collapsing distinct chunks of one book', async () => {
        // Every chunked chunk of a book shares sourceName and has entryUid null.
        // If the dedup key fell back to a book-level constant, a chunked lorebook
        // would collapse to a single entry no matter how many chunks matched.
        hybridQueryResponder = () => jsonResponse({
            success: true,
            results: [
                chunkedChunk({ hash: 222222, score: 0.61 }),
                chunkedChunk({ hash: 333333, score: 0.44, text: 'The spire fell in the second age.' }),
            ],
        });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toHaveLength(2);
        expect(entries.map(e => e.uid)).toEqual([222222, 333333]);
    });
});

describe('world_info_threshold across backend score scales', () => {
    // Qdrant returns rank-based RRF fusion scores, not similarities: the top hit
    // lands near 0.5-1.0 regardless of how relevant it is, and rank 4+ in a single
    // leg falls under 0.2. Vectra returns similarity-derived scores. The same
    // threshold (0.3 x 0.8 = 0.24 when hybrid is active) is applied to both.
    it('keeps hits at or above the discounted threshold and drops the ones below', async () => {
        hybridQueryResponder = () => jsonResponse({
            success: true,
            results: [
                chunkedChunk({ hash: 1, score: 0.50 }),  // rank 0, one leg  -> keep
                chunkedChunk({ hash: 2, score: 0.25 }),  // rank 2, one leg  -> keep
                chunkedChunk({ hash: 3, score: 0.20 }),  // rank 3, one leg  -> drop
            ],
        });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries.map(e => e.uid)).toEqual([1, 2]);
    });

    it('applies the 0.8 hybrid discount on Qdrant', async () => {
        // 0.26 clears 0.3 x 0.8 = 0.24 but would fail an undiscounted 0.3.
        hybridQueryResponder = () => jsonResponse({
            success: true,
            results: [chunkedChunk({ hash: 9, score: 0.26 })],
        });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toHaveLength(1);
    });
});

describe('Vectra lorebook routing (contrast case)', () => {
    it('routes a vectra-registered lorebook to the plugin query path, never to hybrid-query', async () => {
        plainQueryResponder = () => jsonResponse({ success: true, results: [perEntryChunk()] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES,
            [],
            baseSettings({ vector_backend: 'standard' }),
            null,
            [{ id: VECTRA_LOREBOOK_KEY, name: 'WorldLore', sourceName: 'WorldLore' }],
        );

        expect(queryCalls()).not.toContain('/api/plugins/similharity/chunks/hybrid-query');
        expect(queryCalls()).toContain('/api/plugins/similharity/chunks/query');
        const q = fetchLog.find(e => e.url === '/api/plugins/similharity/chunks/query');
        expect(q.body.backend).toBe('vectra');
        expect(q.body.collectionId).toBe(VECTRA_LOREBOOK_ID);
        expect(entries).toHaveLength(1);
    });
});

describe('Collection discovery gate', () => {
    // Every other test in this file passes `preloadedCollections`, which skips
    // getEnabledLorebookCollections() entirely. These two exercise it, because
    // the gate is the cheapest way to reproduce "works on one backend, silent on
    // the other" WITHOUT any backend being at fault: the two backends'
    // collections are separate registry entries with separate locks, so one can
    // pass shouldCollectionActivate() while the other does not.
    //
    // Note that getEnabledLorebookCollections()'s own docstring says gating on
    // shouldCollectionActivate "silently blocks all results" for semantic-only
    // lorebooks — yet world-info-integration.js:210 still applies it (removed in
    // ca65530, re-added in 33bb63a). These tests pin the behavior that is
    // actually shipped so a future change to it is deliberate.
    beforeEach(async () => {
        const { getCollectionListing } = await import('../core/collection-loader.js');
        getCollectionListing.mockReturnValue([{
            registryKey: QDRANT_LOREBOOK_KEY,
            collectionId: QDRANT_LOREBOOK_ID,
            backend: 'qdrant',
            meta: { enabled: true, sourceName: 'WorldLore' },
            isOwn: true,
            isActive: true,
        }]);
    });

    it('never queries a lorebook that fails shouldCollectionActivate', async () => {
        const { shouldCollectionActivate } = await import('../core/collection-metadata.js');
        shouldCollectionActivate.mockResolvedValue(false);
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunkedChunk()] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings({ world_info_retrieval_popup: true }),
        );

        expect(entries).toEqual([]);
        expect(queryCalls()).toEqual([]);          // no HTTP call at all
        expect(global.toastr.info).not.toHaveBeenCalled();
    });

    it('queries a lorebook that passes the gate', async () => {
        const { shouldCollectionActivate } = await import('../core/collection-metadata.js');
        shouldCollectionActivate.mockResolvedValue(true);
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunkedChunk()] });

        const entries = await getSemanticWorldInfoEntries(RECENT_MESSAGES, [], baseSettings());

        expect(entries).toHaveLength(1);
        expect(queryCalls()).toContain('/api/plugins/similharity/chunks/hybrid-query');
    });
});

describe('Backend failure behavior (issue #11 symptom)', () => {
    it('returns zero entries without throwing when every backend call fails', async () => {
        hybridQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
        plainQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toEqual([]);
    });

    it('surfaces a retrieval-failed toast naming the lorebook, not the success popup', async () => {
        // Issue #11's core reporting gap: a backend outage used to be byte-identical
        // to "this book had nothing relevant" — no toast, no error, no log at the
        // default level. The failure must now announce itself and name the book.
        hybridQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
        plainQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });

        await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings({ world_info_retrieval_popup: true }), null, [LOREBOOK_COLLECTION],
        );

        expect(global.toastr.error).toHaveBeenCalledWith(
            expect.stringContaining('WorldLore'),
            expect.stringContaining('Lorebook retrieval failed'),
            expect.any(Object),
        );
        // The success popup must NOT fire — nothing was retrieved.
        expect(global.toastr.info).not.toHaveBeenCalled();
    });

    it('surfaces the failure at DEFAULT settings — no debug level, no popup opt-in', async () => {
        // The whole point of the fix: a user who has changed nothing must still see
        // it. world_info_retrieval_popup defaults to false (index.js:202) and
        // debug_verbosity defaults to 'off', so neither may gate the failure path.
        // log.error/log.warn are ungated by design (core/log.js:51-54); the toast is
        // deliberately NOT behind world_info_retrieval_popup, which opts into the
        // success notice only.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        hybridQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
        plainQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });

        const settings = baseSettings();          // debug_verbosity unset, popup unset
        expect(settings.world_info_retrieval_popup).toBeUndefined();
        expect(settings.debug_verbosity).toBeUndefined();

        await getSemanticWorldInfoEntries(RECENT_MESSAGES, [], settings, null, [LOREBOOK_COLLECTION]);

        expect(global.toastr.error).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('retrieval FAILED for lorebook'),
            expect.anything(),
        );
        consoleError.mockRestore();
    });

    it('does not toast when the book is simply empty of relevant chunks', async () => {
        // The counterpart guard: a healthy backend returning zero hits is a normal
        // outcome, not an error. Toasting here would train users to ignore the toast.
        hybridQueryResponder = () => jsonResponse({ success: true, results: [] });

        const entries = await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings({ world_info_retrieval_popup: true }), null, [LOREBOOK_COLLECTION],
        );

        expect(entries).toEqual([]);
        expect(global.toastr.error).not.toHaveBeenCalled();
        expect(global.toastr.info).not.toHaveBeenCalled();
    });

    it('issues exactly two HTTP calls per query text on failure, not three', async () => {
        // Regression guard for the collapsed fallback: QdrantBackend.hybridQuery no
        // longer retries vector-only on its own, so the only degradation is
        // hybrid-search.js's client-side path. Single query text (no keywordQuery)
        // keeps the arithmetic unambiguous.
        hybridQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
        plainQueryResponder = () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 });

        await getSemanticWorldInfoEntries(
            ['a single line of context'], [], baseSettings(), null, [LOREBOOK_COLLECTION],
        );

        expect(queryCalls()).toEqual([
            '/api/plugins/similharity/chunks/hybrid-query',
            '/api/plugins/similharity/chunks/query',
        ]);
    });

    it('shows the retrieval popup when hits do come back', async () => {
        hybridQueryResponder = () => jsonResponse({ success: true, results: [chunkedChunk()] });

        await getSemanticWorldInfoEntries(
            RECENT_MESSAGES, [], baseSettings({ world_info_retrieval_popup: true }), null, [LOREBOOK_COLLECTION],
        );

        expect(global.toastr.info).toHaveBeenCalledWith(
            expect.stringContaining('Semantic WI: retrieved 1'),
            'VectFox',
        );
    });
});
