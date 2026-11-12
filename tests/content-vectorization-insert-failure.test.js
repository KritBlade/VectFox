/**
 * Vectorize Content's insert (src/features/chunkbase/content-vectorization.js): an embedding insert that fails gets one
 * red toast naming the part that failed, unless another toast already says it. A connection failure has its own, and
 * a configuration failure, such as a deleted embedding profile, gets the caller's sticky configuration toast.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertVectorItemsMock = vi.hoisted(() => vi.fn());

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: {} }));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getStringHash: text => text.length }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/features/vector-backend/index.js', () => ({
    insertVectorItems: insertVectorItemsMock,
    purgeVectorIndex: vi.fn(),
    getSavedHashes: vi.fn(async () => []),
    getBackend: vi.fn(async () => ({})),
}));
vi.mock('../src/features/collections/index.js', () => ({
    setCollectionMeta: vi.fn(),
    setCollectionLock: vi.fn(),
    setCollectionCharacterLock: vi.fn(),
    saveChunkMetadata: vi.fn(),
    registerCollection: vi.fn(),
}));
vi.mock('../src/features/keyword-search/index.js', () => ({ extractLorebookKeywords: () => [], extractTextKeywords: () => [], extractBM25Keywords: () => [] }));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanContentOrNull: text => text }));
vi.mock('../src/features/chunkbase/chunking.js', () => ({ chunkText: vi.fn(async text => [text]) }));
vi.mock('../src/features/chunkbase/lorebook-content-preparer.js', () => ({ prepareLorebookContent: vi.fn() }));
vi.mock('../src/features/chunkbase/reformat-store.js', () => ({ getReformatCache: () => null }));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => () => {} }) }));

const { vectorizeContent } = await import('../src/features/chunkbase/content-vectorization.js');

const vectorizeNotes = () => vectorizeContent({
    contentType: 'document',
    source: { type: 'paste', content: 'The harbor gate opens at dawn.', name: 'Harbor notes' },
    settings: { vector_backend: 'standard', scope: 'global', keywordLevel: 'off', document_glossary_injection: false },
});

beforeEach(() => {
    globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
    insertVectorItemsMock.mockReset();
});

describe('a Vectorize Content insert that fails', () => {
    it('says the write to storage failed', async () => {
        insertVectorItemsMock.mockRejectedValue(new Error('disk full'));

        await expect(vectorizeNotes()).rejects.toThrow('disk full');

        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith('Failed to write embeddings to storage: disk full', 'VectFox');
    });

    it('leaves a configuration failure to the caller\'s sticky toast', async () => {
        const problem = 'Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.';
        insertVectorItemsMock.mockRejectedValue(Object.assign(new Error(problem), { code: 'invalid_model_config' }));

        await expect(vectorizeNotes()).rejects.toMatchObject({ code: 'invalid_model_config', message: problem });

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    it('leaves a connection failure to its own toast', async () => {
        insertVectorItemsMock.mockRejectedValue(new Error('fetch failed'));

        await expect(vectorizeNotes()).rejects.toThrow('fetch failed');

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});
