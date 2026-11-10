/**
 * The question a search raises when a Qdrant collection was made with another CJK tokenizer than VectFox is set to
 * (src/features/vector-backend/tokenizer-lock.js), met as a reply meets it: Agent Mode's planner sends several searches
 * at once, and EventBase search passes each its own copy of the settings (eventSearchSettings). One question answers
 * them all: Revert switches the setting once and every search goes on; Cancel stops them all and the reply once; and a
 * Revert saves the CJK tokenizer alone, never the rest of a search's copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: vi.fn(() => ({})) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {} }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: { server_urls: {} } }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {} }));
vi.mock('../src/shared/similharity-plugin.js', () => ({ checkPluginAvailable: vi.fn(async () => true), resetPluginAvailableCache: vi.fn() }));
vi.mock('../src/features/embedding/providers.js', () => ({ getModelField: vi.fn(() => null), getModelFromSettings: vi.fn(() => 'test-model') }));
vi.mock('../src/shared/constants.js', () => ({
    VECTOR_LIST_LIMIT: 10000,
    RETRIEVAL_TIMEOUT_DEFAULT_MS: 15000,
    RETRIEVAL_TIMEOUT_MIN_MS: 3000,
    RETRIEVAL_TIMEOUT_MAX_MS: 120000,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS: 30000,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS: 10000,
    AGENTIC_TIMEOUT_MIN_MS: 1000,
    AGENTIC_TIMEOUT_MAX_MS: 60000,
}));

const host = vi.hoisted(() => ({ answers: [], root: { vectfox: {} } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    POPUP_TYPE: { TEXT: 1 },
    // Each question waits until the test answers it, as the user does.
    callGenericPopup: vi.fn(() => new Promise(resolve => host.answers.push(resolve))),
    waitForOtherPopupsToClose: vi.fn(async () => {}),
}));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.root, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/generation.js', () => ({ stopGeneration: vi.fn() }));
// The real sparse encoder runs on this tokenize. Searches sent together import it at once, and vitest can hand one of
// two simultaneous first imports of a mocked module the real file, so the test mocks only what the encoder imports.
vi.mock('../src/features/keyword-search/index.js', () => ({
    CJK_TOKENIZER_MODES: { intl: 'intl', jieba: 'jieba', jieba_tw: 'jieba_tw' },
    setCjkTokenizerMode: vi.fn(),
    ensureJiebaTokenizerLoaded: vi.fn(async () => true),
    ensureJiebaTwLoaded: vi.fn(async () => true),
    tokenize: vi.fn(text => String(text).toLowerCase().split(/\s+/).filter(Boolean)),
}));

const { QdrantBackend } = await import('../src/features/vector-backend/qdrant.js');
const { invalidateCollectionMetadata } = await import('../src/features/vector-backend/tokenizer-lock.js');
const { callGenericPopup } = await import('../src/sillytavern/popup.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { stopGeneration } = await import('../src/sillytavern/generation.js');
const { setCjkTokenizerMode, ensureJiebaTwLoaded } = await import('../src/features/keyword-search/index.js');

const COLLECTION_ID = 'vf_eventbase_qdrant_rabbit_harbor_67d28099-167f-4c07-a7cb-1b62e44f43d0';
const REVERT = 1;
const CANCEL = 0;
const SAVED_SETTINGS = { cjk_tokenizer_mode: 'intl', score_threshold: 0.25, keyword_scoring_method: 'keyword_boost', eventbase_score_threshold: 0 };
// What EventBase search hands each search: a copy with its own threshold and keyword method (eventSearchSettings).
const searchCopy = () => ({ ...host.root.vectfox, keyword_scoring_method: 'bm25', score_threshold: host.root.vectfox.eventbase_score_threshold });

const backend = new QdrantBackend();
const search = settings => backend.hybridQueryWithRerank(COLLECTION_ID, 'where is the gate', 5, settings, {}, {}, [0.1, 0.2]);
const rerankRequests = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/chunks/hybrid-query-rerank')).length;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

beforeEach(() => {
    vi.clearAllMocks();
    host.answers.length = 0;
    host.root.vectfox = { ...SAVED_SETTINGS };
    invalidateCollectionMetadata(COLLECTION_ID);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/chunks/collection-metadata')) return { ok: true, json: async () => ({ payload: { cjk_tokenizer_mode: 'jieba_tw' } }) };
        if (String(url).endsWith('/chunks/hybrid-query-rerank')) return { ok: true, json: async () => ({ results: [{ hash: 7, text: 'The gate stood open.', score: 0.5 }] }) };
        throw new Error(`unexpected request ${url}`);
    }));
});

describe('a reply whose searches meet a collection made with another CJK tokenizer', () => {
    // One Revert once had to be pressed twice: each search had asked its own question.
    it('asks once for searches sent together, and Revert lets every one go on', async () => {
        const searches = [search(searchCopy()), search(searchCopy())];
        await vi.waitFor(() => expect(host.answers.length).toBeGreaterThan(0));
        await settle();
        expect(callGenericPopup).toHaveBeenCalledTimes(1);

        host.answers.forEach(answer => answer(REVERT));
        const results = await Promise.all(searches);
        expect(results.map(result => result.hashes)).toEqual([[7], [7]]);
        expect(rerankRequests()).toBe(2);
        expect(host.root.vectfox.cjk_tokenizer_mode).toBe('jieba_tw');
        expect(setCjkTokenizerMode).toHaveBeenCalledTimes(1);
        expect(ensureJiebaTwLoaded).toHaveBeenCalledTimes(1);
    });

    it('does not ask again for a search whose settings were copied before the Revert', async () => {
        const staleCopy = searchCopy();
        const first = search(searchCopy());
        await vi.waitFor(() => expect(host.answers.length).toBe(1));
        host.answers[0](REVERT);
        await first;

        expect((await search(staleCopy)).hashes).toEqual([7]);
        expect(callGenericPopup).toHaveBeenCalledTimes(1);
    });

    it('stops every search and the reply once on Cancel', async () => {
        const searches = [search(searchCopy()), search(searchCopy())];
        await vi.waitFor(() => expect(host.answers.length).toBeGreaterThan(0));
        await settle();
        host.answers.forEach(answer => answer(CANCEL));

        const results = await Promise.all(searches);
        expect(results).toEqual([{ hashes: [], metadata: [] }, { hashes: [], metadata: [] }]);
        expect(rerankRequests()).toBe(0);
        expect(stopGeneration).toHaveBeenCalledTimes(1);
        expect(host.root.vectfox.cjk_tokenizer_mode).toBe('intl');
    });

    // A Revert once copied the search's whole copy into the saved settings, so ChunkBase's similarity threshold and
    // keyword method took EventBase's.
    it('saves only the CJK tokenizer on Revert', async () => {
        const first = search(searchCopy());
        await vi.waitFor(() => expect(host.answers.length).toBe(1));
        host.answers[0](REVERT);
        await first;

        expect(host.root.vectfox).toEqual({ ...SAVED_SETTINGS, cjk_tokenizer_mode: 'jieba_tw' });
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });
});
