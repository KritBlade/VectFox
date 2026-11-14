/**
 * Brings a book's LoreBase index in line with the book (plan §5.4): the picked entries are cut into passages, the
 * passages the index lacks are embedded and stored, and the ones the book no longer has are deleted, so an edit
 * re-embeds only what it changed. New passages are stored before old ones go, so a failure part way leaves an index
 * with extra passages, never a hole.
 */

import { getModelFromSettings } from '../embedding/index.js';
import { getCurrentUserHandle } from '../../sillytavern/user.js';
import { loadWorldInfo } from '../../sillytavern/world-info.js';
import { getLoreBook, recordLoreBookIndex } from './lorebase-books.js';
import { deleteIndex, deletePassages, listIndexPassages, storePassages } from './lorebase-client.js';
import { loreBaseIndexId, passageHash, passagePointId } from './lorebase-identity.js';
import { entryPassages } from './lorebase-splitter.js';

/** What a sync throws when the book's index was built with another embedding model than the one set now (D7). */
export const MODEL_CHANGED = 'lorebase_model_changed';

/**
 * The passages a book's picked entries cut into, as the index stores them, by hash.
 * @param {string} bookName
 * @param {{entries: Object<string, object>}} book - The lorebook as SillyTavern loads it
 * @param {Object<string, object>} picks - The record's picks, by entry uid
 * @param {string} indexId
 * @returns {Map<number, {id: string, hash: number, text: string, index: number, metadata: object}>}
 */
export function bookPassages(bookName, book, picks, indexId) {
    const passages = new Map();
    for (const uid of Object.keys(picks)) {
        const entry = book.entries?.[uid];
        if (!entry || !String(entry.content || '').trim()) continue;
        const { title, passages: cut } = entryPassages(entry);
        for (const passage of cut) {
            const hash = passageHash(entry.uid, passage.embeddingText);
            passages.set(hash, {
                id: passagePointId(indexId, hash),
                hash,
                text: passage.embeddingText,
                index: passage.passageIndex,
                metadata: {
                    content_type: indexId,
                    lorebookName: bookName,
                    entryUid: entry.uid,
                    entryKey: `${bookName}\u001f${entry.uid}`,
                    entryName: title,
                    sectionName: passage.section,
                    passageIndex: passage.passageIndex,
                    passageCount: passage.passageCount,
                    tokens: passage.tokens,
                },
            });
        }
    }
    return passages;
}

/**
 * Sync one book's index with the book.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @param {{rebuild?: boolean}} [options] - rebuild: delete the index first, as a change of embedding model needs
 * @returns {Promise<{indexId: string, stored: number, deleted: number, kept: number}|null>} null when nothing is picked
 * @throws {Error} With `code: MODEL_CHANGED` when the index was built with another model and rebuild is not set
 */
export async function syncLoreBook(bookName, settings, { rebuild = false } = {}) {
    const record = getLoreBook(bookName);
    if (!record || Object.keys(record.picks).length === 0) return null;
    if (settings.vector_backend !== 'qdrant') {
        throw new Error(`LoreBase: "${bookName}" can be vectorized on the Qdrant backend only, and VectFox is set to ${settings.vector_backend || 'standard'}.`);
    }
    const embeddingSource = settings.embedding_provider || 'transformers';
    const embeddingModel = getModelFromSettings(settings);
    const built = record.index;
    if (built && !rebuild && (built.embeddingSource !== embeddingSource || built.embeddingModel !== embeddingModel)) {
        const error = new Error(`LoreBase: "${bookName}" was vectorized with ${built.embeddingSource} ${built.embeddingModel || '(default)'}, `
            + `and VectFox now embeds with ${embeddingSource} ${embeddingModel || '(default)'}, so it must be vectorized again before it is searched.`);
        error.code = MODEL_CHANGED;
        throw error;
    }
    const book = await loadWorldInfo(bookName);
    if (!book) throw new Error(`LoreBase: SillyTavern has no lorebook named "${bookName}".`);

    const indexId = loreBaseIndexId(bookName, settings.vector_backend, getCurrentUserHandle());
    if (rebuild) await deleteIndex(indexId, settings);
    const live = bookPassages(bookName, book, record.picks, indexId);
    const stored = rebuild ? new Map() : await listIndexPassages(indexId, settings);
    const toStore = [...live.values()].filter(passage => !stored.has(passage.hash));
    const toDelete = [...stored.keys()].filter(hash => !live.has(hash));
    if (toStore.length) await storePassages(indexId, toStore, settings);
    if (toDelete.length) await deletePassages(indexId, toDelete, settings);
    recordLoreBookIndex(bookName, { id: indexId, backend: 'qdrant', embeddingSource, embeddingModel, passageCount: live.size });
    return { indexId, stored: toStore.length, deleted: toDelete.length, kept: live.size - toStore.length };
}
