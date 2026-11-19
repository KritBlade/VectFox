/**
 * Embeds a retrieval query's text through the Similharity plugin's /get-embedding
 * route, or several query texts in one request through its /batch-embeddings
 * route (LoreBase's two searches a reply).
 *
 * A query embeds its text ONCE (src/features/vector-backend/vector-api.js getQueryVector) and hands
 * the vector to every route and fallback it tries, so no request re-embeds the
 * same text server-side. Both backends call this from embedQuery(); each passes
 * its own provider params (apiUrl for URL-based sources, and a profile's key ID),
 * which the two backends build differently.
 *
 * A text over the provider's piece size is still embedded, with a console warning naming its size: every search that
 * embeds a person's or a chat's text cuts it with searchPieces first, so the warning names one that did not.
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
import { getModelFromSettings } from './providers.js';
import { throwIfEmbeddingConfigError } from './embedding-request-failure.js';
import { warnIfEmbeddingSlow } from './embedding-latency-warning.js';
import { log } from '../../sillytavern/log.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { searchTokens } from './search-pieces-core.js';
import { searchPieceTokensOf } from './search-pieces.js';

/**
 * Send an embedding request to a Similharity route, with the settings' source and model and the backend's provider
 * params, and read its answer.
 * @param {string} route - The route under /api/plugins/similharity/
 * @param {object} texts - The body's text field: {text} or {texts}
 * @param {object} settings - VectFox settings (embedding provider and model)
 * @param {object} providerParams - Provider-specific body params from the calling backend
 * @returns {Promise<object>} The answer, parsed
 * @throws {Error} When the request fails; a wrong setup with `code: 'invalid_model_config'`
 */
async function postEmbeddingRequest(route, texts, settings, providerParams) {
    const source = settings.embedding_provider || 'transformers';
    const response = await fetch(`/api/plugins/similharity/${route}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ ...texts, source, model: getModelFromSettings(settings), ...providerParams }),
    });
    if (!response.ok) {
        const errorBody = await readErrorBody(response, '(no body)');
        throwIfEmbeddingConfigError(settings, { status: response.status, responseText: errorBody });
        throw new Error(`Query embedding via '${source}' failed: ${response.status} ${response.statusText} - ${errorBody.slice(0, 300)}`);
    }
    return response.json();
}

/**
 * @param {string} searchText - Query text to embed
 * @param {object} settings - VectFox settings (embedding provider and model)
 * @param {object} providerParams - Provider-specific body params from the calling backend
 * @returns {Promise<number[]>} The query vector
 */
export async function fetchQueryEmbedding(searchText, settings, providerParams) {
    const source = settings.embedding_provider || 'transformers';
    const pieceTokens = searchPieceTokensOf(settings);
    const textTokens = searchTokens(String(searchText ?? ''));
    if (textTokens > pieceTokens) {
        log.warn(`VectFox: a search text of about ${Math.round(textTokens)} tokens reached '${source}' whole, over its piece size of ${pieceTokens}; the search that sent it does not cut it with searchPieces`);
    }
    const tStart = performance.now();
    const data = await postEmbeddingRequest('get-embedding', { text: searchText }, settings, providerParams);
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error(`Query embedding via '${source}' failed: plugin returned no embedding vector`);
    }
    const embedMs = performance.now() - tStart;
    log.verbose(`[VectFox] Query embedding via '${source}': ${embedMs.toFixed(0)}ms, dim=${data.embedding.length}`);
    warnIfEmbeddingSlow(embedMs, settings, 'get-embedding');
    return data.embedding;
}

/**
 * Embed several query texts in one request, through Similharity's /batch-embeddings, which sends them as one batch
 * where the source takes one, and one at a time where it does not.
 * @param {string[]} searchTexts - Each within the provider's piece size
 * @param {object} settings - VectFox settings (embedding provider and model)
 * @param {object} providerParams - Provider-specific body params from the calling backend
 * @returns {Promise<number[][]>} One vector for each text, in their order
 */
export async function fetchQueryEmbeddings(searchTexts, settings, providerParams) {
    const source = settings.embedding_provider || 'transformers';
    const tStart = performance.now();
    const data = await postEmbeddingRequest('batch-embeddings', { texts: searchTexts }, settings, providerParams);
    const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
    if (embeddings.length !== searchTexts.length || embeddings.some(vector => !Array.isArray(vector) || vector.length === 0)) {
        throw new Error(`Query embedding via '${source}' failed: the plugin returned ${embeddings.length} vectors for ${searchTexts.length} texts`);
    }
    const embedMs = performance.now() - tStart;
    log.verbose(`[VectFox] Query embedding of ${searchTexts.length} texts via '${source}': ${embedMs.toFixed(0)}ms, dim=${embeddings[0].length}`);
    warnIfEmbeddingSlow(embedMs, settings, 'batch-embeddings');
    return embeddings;
}
