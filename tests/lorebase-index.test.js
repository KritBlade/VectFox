/**
 * LoreBase's index (plan §5.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): one
 * stable index per book and account, the picks and locks kept per book, a sync that embeds only what an edit changed
 * and deletes what is gone, and a search that leaves out a book built with another embedding model. Similharity is a
 * fetch stub that keeps the stored passages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ handle: 'default-user', books: {}, stored: new Map(), requests: [] }));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/user.js', () => ({ getCurrentUserHandle: () => host.handle }));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: vi.fn(async name => host.books[name] ?? null) }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ name1: 'Tester' }), getCurrentChatId: () => 'chat-1', chat_metadata: {} }));
vi.mock('../src/features/embedding/index.js', () => ({ getModelFromSettings: settings => settings.model ?? 'baai/bge-m3' }));
vi.mock('../src/features/vector-backend/index.js', async () => ({
    encodeSparseVector: () => ({ indices: [1], values: [1] }),
    getPluginProviderParams: async () => ({}),
    qdrantTarget: (await import('../src/features/vector-backend/qdrant-target.js')).qdrantTarget,
    getBackend: async () => ({}),
    getQueryVector: vi.fn(async () => [0.9, 0.1]),
}));

const { extension_settings } = await import('../src/sillytavern/settings.js');
const { getQueryVector } = await import('../src/features/vector-backend/index.js');
const { loreBaseIndexId, passageHash, passagePointId } = await import('../src/features/lorebase/lorebase-identity.js');
const {
    ACTIVATION, MODEL_CHANGED, getLoreBook, isLoreBookLocked, searchLoreBooks, setLoreBookLock, setLoreBookPicks, syncLoreBook,
} = await import('../src/features/lorebase/index.js');

const BOOK = 'Harbor Lore';
const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'custom', qdrant_multitenancy: false };
const ok = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) });
const requestsTo = route => host.requests.filter(request => request.url.endsWith(route));

beforeEach(() => {
    extension_settings.vectfox = {};
    host.handle = 'default-user';
    host.stored = new Map();
    host.requests = [];
    host.books = {
        [BOOK]: {
            entries: {
                1: { uid: 1, comment: '[Harbor] Keeper Orrin', content: 'Orrin trims the lamp at dusk.\n## Speech\nHe speaks in short words.' },
                2: { uid: 2, comment: '[Harbor] The Bell', content: 'The bell rings at the ninth hour.' },
                3: { uid: 3, comment: '[Harbor] Unpicked', content: 'Nobody picked this entry.' },
            },
        },
    };
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        host.requests.push({ url, body });
        if (url.endsWith('/chunks/list')) {
            return ok({ items: [...host.stored.values()].filter(item => item.metadata.content_type === body.filters.content_type).map(item => ({ hash: item.hash, metadata: item.metadata })) });
        }
        if (url.endsWith('/chunks/insert')) {
            for (const item of body.items) host.stored.set(item.hash, item);
            return ok({ success: true });
        }
        if (url.endsWith('/chunks/delete')) {
            for (const hash of body.hashes) host.stored.delete(hash);
            return ok({ success: true });
        }
        if (url.endsWith('/chunks/purge')) {
            host.stored.clear();
            return ok({ success: true });
        }
        if (url.endsWith('/lorebase/search')) return ok({ results: body.targets.map(target => ({ label: target.label, entries: [] })) });
        throw new Error(`unexpected request ${url}`);
    }));
});

describe('stable names', () => {
    it('names a book\'s index by backend, account and book, with no timestamp, and the same each time', () => {
        const id = loreBaseIndexId('Date_A_Live_V1.4 (Most Recent)', 'qdrant', 'default-user');
        expect(id).toMatch(/^vf_lorebase_qdrant_default_user_date_a_live_v1_4_most_recent_[0-9a-z]+$/);
        expect(loreBaseIndexId('Date_A_Live_V1.4 (Most Recent)', 'qdrant', 'default-user')).toBe(id);
        expect(loreBaseIndexId('Date_A_Live_V1.4 (Most Recent)', 'qdrant', 'rabbit')).not.toBe(id);
        expect(loreBaseIndexId('A.B', 'qdrant', 'default-user')).not.toBe(loreBaseIndexId('A B', 'qdrant', 'default-user'));
    });

    it('gives the same text in two entries two passages, and each passage a UUID from its index', () => {
        expect(passageHash(1, 'The bell rings.')).not.toBe(passageHash(2, 'The bell rings.'));
        const id = passagePointId('vf_lorebase_qdrant_a_book_1', passageHash(1, 'The bell rings.'));
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(passagePointId('vf_lorebase_qdrant_a_book_2', passageHash(1, 'The bell rings.'))).not.toBe(id);
    });
});

describe('the book record', () => {
    it('keeps picks and locks per book, and refuses an activation LoreBase does not have', () => {
        setLoreBookPicks(BOOK, { 1: { split: true, activation: ACTIVATION.KEYS_AND_VECTFOX }, 2: {} });
        setLoreBookLock(BOOK, { chatId: 'chat-1' }, true);

        expect(getLoreBook(BOOK).picks).toEqual({ 1: { split: true, activation: 'keys_and_vectfox' }, 2: { split: false, activation: 'keys' } });
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-1' })).toBe(true);
        expect(isLoreBookLocked(BOOK, { chatId: 'chat-2', characterId: '7' })).toBe(false);
        expect(Object.keys(extension_settings.vectfox)).toEqual(['lorebase_books']);
        expect(() => setLoreBookPicks(BOOK, { 1: { activation: 'always' } })).toThrow('is not one of keys, keys_and_vectfox, vectfox_only');
    });
});

describe('sync', () => {
    it('stores the picked entries\' passages, each with its ID, hash and tenant, and nothing of an unpicked entry', async () => {
        setLoreBookPicks(BOOK, { 1: {}, 2: {} });

        const result = await syncLoreBook(BOOK, SETTINGS);

        const indexId = loreBaseIndexId(BOOK, 'qdrant', 'default-user');
        expect(result).toEqual({ indexId, stored: 3, deleted: 0, kept: 0 });
        const items = requestsTo('/chunks/insert').flatMap(request => request.body.items);
        expect(items.every(item => item.metadata.content_type === indexId && /^[0-9a-f-]{36}$/.test(item.id))).toBe(true);
        expect(items.map(item => item.metadata.entryUid).sort()).toEqual([1, 1, 2]);
        expect(items.find(item => item.metadata.sectionName === 'Speech').text).toBe('Keeper Orrin / Speech — ## Speech\nHe speaks in short words.');
        expect(getLoreBook(BOOK).index).toMatchObject({ id: indexId, embeddingSource: 'custom', embeddingModel: 'baai/bge-m3', passageCount: 3 });
    });

    it('after an edit, embeds only the changed passage and deletes the one it replaced', async () => {
        setLoreBookPicks(BOOK, { 1: {}, 2: {} });
        await syncLoreBook(BOOK, SETTINGS);
        host.requests = [];
        host.books[BOOK].entries[2].content = 'The bell rings at the tenth hour.';

        const result = await syncLoreBook(BOOK, SETTINGS);

        expect(result).toMatchObject({ stored: 1, deleted: 1, kept: 2 });
        expect(requestsTo('/chunks/insert')[0].body.items.map(item => item.text)).toEqual(['The Bell — The bell rings at the tenth hour.']);
        expect(requestsTo('/chunks/delete')[0].body.filters).toEqual({ content_type: loreBaseIndexId(BOOK, 'qdrant', 'default-user') });
    });

    it('stops before searching a book vectorized with another model, and rebuilds it from scratch when asked', async () => {
        setLoreBookPicks(BOOK, { 1: {}, 2: {} });
        await syncLoreBook(BOOK, SETTINGS);

        await expect(syncLoreBook(BOOK, { ...SETTINGS, model: 'qwen/qwen3-embedding-8b' })).rejects.toMatchObject({ code: MODEL_CHANGED });

        host.requests = [];
        const result = await syncLoreBook(BOOK, { ...SETTINGS, model: 'qwen/qwen3-embedding-8b' }, { rebuild: true });
        expect(requestsTo('/chunks/purge')).toHaveLength(1);
        expect(requestsTo('/chunks/list')).toHaveLength(0);
        expect(result).toMatchObject({ stored: 3, deleted: 0 });
        expect(getLoreBook(BOOK).index.embeddingModel).toBe('qwen/qwen3-embedding-8b');
    });

    it('does nothing for a book with nothing picked, and refuses the Standard backend', async () => {
        expect(await syncLoreBook(BOOK, SETTINGS)).toBeNull();
        setLoreBookPicks(BOOK, { 1: {} });
        await expect(syncLoreBook(BOOK, { ...SETTINGS, vector_backend: 'standard' })).rejects.toThrow('on the Qdrant backend only');
        expect(host.requests).toEqual([]);
    });
});

describe('search', () => {
    it('searches each book in one request with its tenant, and leaves out a book built with another model', async () => {
        setLoreBookPicks(BOOK, { 1: {} });
        await syncLoreBook(BOOK, SETTINGS);
        setLoreBookPicks('Old Book', { 1: {} });
        extension_settings.vectfox.lorebase_books['Old Book'].index = { id: 'vf_lorebase_qdrant_default_user_old_1', embeddingSource: 'custom', embeddingModel: 'old-model' };

        const results = await searchLoreBooks([BOOK, 'Old Book', 'Never Picked'], 'the bell', SETTINGS, { queryVector: [0.4, 0.6] });

        expect(results).toEqual([{ book: BOOK, entries: [] }]);
        const [search] = requestsTo('/lorebase/search');
        expect(search.body.targets).toEqual([{ label: BOOK, collectionId: loreBaseIndexId(BOOK, 'qdrant', 'default-user'), filters: { content_type: loreBaseIndexId(BOOK, 'qdrant', 'default-user') } }]);
        expect(search.body.queryVector).toEqual([0.4, 0.6]);
        expect(getQueryVector).not.toHaveBeenCalled();
    });
});
