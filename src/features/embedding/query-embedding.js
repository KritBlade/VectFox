/**
 * Embeds a retrieval query's text through the Similharity plugin's /get-embedding
 * route.
 *
 * A query embeds its text ONCE (src/features/vector-backend/vector-api.js getQueryVector) and hands
 * the vector to every route and fallback it tries, so no request re-embeds the
 * same text server-side. Both backends call this from embedQuery(); each passes
 * its own provider params (apiUrl for URL-based sources, and a profile's key ID),
 * which the two backends build differently.
 */

import { getRequestHeaders } from '../../sillytavern/requests.js';
import { getModelFromSettings } from './providers.js';
import { throwIfEmbeddingConfigError } from './embedding-request-failure.js';
import { warnIfEmbeddingSlow } from './embedding-latency-warning.js';
import { log } from '../../sillytavern/log.js';
import { readErrorBody } from '../../shared/server-error-text.js';

/**
 * @param {string} searchText - Query text to embed
 * @param {object} settings - VectFox settings (embedding provider and model)
 * @param {object} providerParams - Provider-specific body params from the calling backend
 * @returns {Promise<number[]>} The query vector
 */
export async function fetchQueryEmbedding(searchText, settings, providerParams) {
    const source = settings.embedding_provider || 'transformers';
    const model = getModelFromSettings(settings);
    const tStart = performance.now();
    const response = await fetch('/api/plugins/similharity/get-embedding', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ text: searchText, source, model, ...providerParams }),
    });
    if (!response.ok) {
        const errorBody = await readErrorBody(response, '(no body)');
        throwIfEmbeddingConfigError(settings, { status: response.status, responseText: errorBody });
        throw new Error(`Query embedding via '${source}' failed: ${response.status} ${response.statusText} - ${errorBody.slice(0, 300)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error(`Query embedding via '${source}' failed: plugin returned no embedding vector`);
    }
    const embedMs = performance.now() - tStart;
    log.verbose(`[VectFox] Query embedding via '${source}': ${embedMs.toFixed(0)}ms, dim=${data.embedding.length}`);
    warnIfEmbeddingSlow(embedMs, settings, 'get-embedding');
    return data.embedding;
}
