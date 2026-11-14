/**
 * LoreBase's requests to Similharity for a book's index in Qdrant. Every point carries the index ID in the tenant
 * field `content_type`, with "One shared collection" on or off, so every read and delete is scoped to the index and a
 * delete finds a passage by its hash whatever its point ID. The plugin embeds each passage with the embedding the user
 * set, as every VectFox insert does.
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
import { getModelFromSettings } from '../embedding/index.js';
import { encodeSparseVector, getPluginProviderParams, qdrantTarget } from '../vector-backend/index.js';
import { readErrorBody } from '../../shared/server-error-text.js';

const PLUGIN = '/api/plugins/similharity';
// Passages per insert request; each is embedded by the plugin, as VectFox's live inserts are batched.
const INSERT_BATCH = 100;

/** The Qdrant collection holding a LoreBase index, and the tenant filter that keeps a request to it. */
export function indexTarget(indexId, settings) {
    return { collectionId: qdrantTarget(indexId, settings).collectionId, filters: { content_type: indexId } };
}

async function post(route, body, failure) {
    const response = await fetch(`${PLUGIN}${route}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) {
        throw new Error(`LoreBase: ${failure}: ${response.status} ${response.statusText} - ${await readErrorBody(response, 'No response body')}`);
    }
    return response.json();
}

/**
 * The passages an index holds, by hash.
 * @param {string} indexId
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<number, object>>} Each passage's payload, by its hash
 */
export async function listIndexPassages(indexId, settings) {
    const target = indexTarget(indexId, settings);
    const data = await post('/chunks/list', {
        backend: 'qdrant',
        collectionId: target.collectionId,
        filters: target.filters,
        source: settings.embedding_provider || 'transformers',
        model: getModelFromSettings(settings),
        limit: 0,
    }, `could not list the passages of ${indexId}`);
    return new Map((data.items || []).map(item => [Number(item.hash), item.metadata || {}]));
}

/**
 * Store passages in an index; the plugin embeds each one.
 * @param {string} indexId
 * @param {Array<{id: string, hash: number, text: string, index: number, metadata: object}>} passages
 * @param {object} settings - VectFox settings
 */
export async function storePassages(indexId, passages, settings) {
    const target = indexTarget(indexId, settings);
    const providerFields = await getPluginProviderParams(settings);
    for (let start = 0; start < passages.length; start += INSERT_BATCH) {
        const batch = passages.slice(start, start + INSERT_BATCH);
        await post('/chunks/insert', {
            backend: 'qdrant',
            collectionId: target.collectionId,
            items: batch.map(passage => ({ ...passage, sparseVector: encodeSparseVector(passage.text) })),
            source: settings.embedding_provider || 'transformers',
            model: getModelFromSettings(settings),
            nativeSparse: true,
            cjkTokenizerMode: settings.cjk_tokenizer_mode,
            ...providerFields,
        }, `could not store ${batch.length} passages in ${indexId}`);
    }
}

/**
 * Delete passages from an index by their hashes.
 * @param {string} indexId
 * @param {number[]} hashes
 * @param {object} settings - VectFox settings
 */
export async function deletePassages(indexId, hashes, settings) {
    const target = indexTarget(indexId, settings);
    await post('/chunks/delete', {
        backend: 'qdrant',
        collectionId: target.collectionId,
        filters: target.filters,
        hashes,
        source: settings.embedding_provider || 'transformers',
        model: getModelFromSettings(settings),
    }, `could not delete ${hashes.length} passages from ${indexId}`);
}

/**
 * Delete a whole index: its own Qdrant collection, or with "One shared collection" on, its tenant's points.
 * @param {string} indexId
 * @param {object} settings - VectFox settings
 */
export async function deleteIndex(indexId, settings) {
    const target = indexTarget(indexId, settings);
    await post('/chunks/purge', {
        backend: 'qdrant',
        collectionId: target.collectionId,
        source: settings.embedding_provider || 'transformers',
        model: getModelFromSettings(settings),
        ...(settings.qdrant_multitenancy ? { filters: target.filters } : {}),
    }, `could not delete ${indexId}`);
}

/**
 * One hybrid search per book, pooled per entry and ranked per book (plan §5.6), in one request to the plugin.
 * @param {Array<{book: string, indexId: string}>} books
 * @param {number[]} queryVector
 * @param {string} queryText - For the sparse (keyword) leg
 * @param {object} settings - VectFox settings
 * @param {{prefetchLimit?: number, entriesPerBook?: number, passagesPerEntry?: number}} [limits]
 * @returns {Promise<Array<{book: string, entries: Array<object>}>>}
 */
export async function searchIndexes(books, queryVector, queryText, settings, limits = {}) {
    const data = await post('/lorebase/search', {
        backend: 'qdrant',
        targets: books.map(({ book, indexId }) => ({ label: book, ...indexTarget(indexId, settings) })),
        queryVector,
        sparseQueryVector: encodeSparseVector(queryText),
        prefetchLimit: limits.prefetchLimit ?? 300,
        entriesPerBook: limits.entriesPerBook ?? 10,
        passagesPerEntry: limits.passagesPerEntry ?? 3,
    }, 'the lorebook search failed');
    return (data.results || []).map(result => ({ book: result.label, entries: result.entries || [] }));
}
