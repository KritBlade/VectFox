/**
 * Searches the LoreBase indexes of the books a turn may use (plan §5.6): one query embedding, then one hybrid search
 * per book in a single request, pooled per entry and ranked per book, since one search across books let one book
 * crowd another out. A book whose index was built with another embedding model is left out (§5.4): a model of the
 * same vector size returns wrong scores with no error.
 */

import { getModelFromSettings } from '../embedding/index.js';
import { getBackend, getQueryVector } from '../vector-backend/index.js';
import { getLoreBook } from './lorebase-books.js';
import { searchIndexes } from './lorebase-client.js';

/**
 * The best entries of each book for a query, each with its best passages.
 * @param {string[]} bookNames
 * @param {string} queryText
 * @param {object} settings - VectFox settings
 * @param {{queryVector?: number[]|null, limits?: object}} [options] - queryVector: the turn's embedding, when the
 *   caller has it, so one embedding serves every book
 * @returns {Promise<Array<{book: string, entries: Array<object>}>>}
 */
export async function searchLoreBooks(bookNames, queryText, settings, { queryVector = null, limits = {} } = {}) {
    const embeddingSource = settings.embedding_provider || 'transformers';
    const embeddingModel = getModelFromSettings(settings);
    const books = bookNames
        .map(book => ({ book, index: getLoreBook(book)?.index }))
        .filter(({ index }) => index?.id && index.embeddingSource === embeddingSource && index.embeddingModel === embeddingModel);
    if (books.length === 0) return [];
    const vector = queryVector ?? await getQueryVector(await getBackend(settings), queryText, settings);
    return searchIndexes(books.map(({ book, index }) => ({ book, indexId: index.id })), vector, queryText, settings, limits);
}
