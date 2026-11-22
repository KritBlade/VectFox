// vllm-embedding.js — embedding on a vLLM server's /v1/embeddings route, at most OPENAI_STYLE_BATCH_LIMIT texts per
// request, the embeddings in the order of the texts. With no key in the request, each batch goes through SillyTavern's
// own getVllmBatchVector, which sends the vLLM key saved in SillyTavern; its one-text getVllmVector is that function
// given one text. VectFox sends no key, so its requests go this way. A key in the request, which VectFox sent only
// from 13 to 25 May 2026, is sent in place of the saved one.
//
// A refusal passes on its status and a fixed hint, never the server's reply, which can quote the key it refused.

import { OPENAI_STYLE_BATCH_LIMIT } from './openai-style-embedding.js';
import { errorFreeOfServerReply, errorWithoutServerReply, serverFailureText } from './server-failure-text.js';
import { assertSendableHeaders } from './request-safety.js';

/** One batch with the key the request gives, on the route getVllmBatchVector uses, in the order of the texts. */
async function embedWithRequestKey(input, { apiUrl, model, apiKey }, host) {
    const url = new URL(host.urlJoin(host.trimV1(apiUrl), '/v1/embeddings'));
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    assertSendableHeaders(headers, 'vLLM');
    const response = await host.fetch(url, { method: 'POST', headers, body: JSON.stringify({ input, model }) });
    if (!response.ok) {
        const failure = serverFailureText({ status: response.status, statusText: response.statusText, reply: await response.text() });
        throw errorFreeOfServerReply(`VLLM: Failed to get vector for text: ${failure}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw errorFreeOfServerReply('VLLM: API response was not an array');
    return [...data.data].sort((a, b) => a.index - b.index).map(item => item?.embedding);
}

/** One batch's embeddings, any error freed of the server's reply as the one-text route frees it. */
async function embedBatch(input, request, host) {
    try {
        if (request.apiKey) return await embedWithRequestKey(input, request, host);
        return await host.getVllmBatchVector(input, request.apiUrl, request.model, request.directories);
    } catch (error) {
        throw errorWithoutServerReply(error);
    }
}

/**
 * Embed texts on vLLM.
 *
 * @param {string[]} texts
 * @param {{apiUrl: string, model: string, apiKey?: string, directories: object}} request - The server URL and model the
 *   client sent, the key it sent if any, and the user's SillyTavern directories, where the saved key is
 * @param {object} host - From loadVllmRequestHost (sillytavern-request-host.js)
 * @returns {Promise<number[][]>} One embedding per text, in the order of the texts
 * @throws {Error} With the status and a fixed hint when the server refuses, never its reply; and when a reply holds
 *   another number of embeddings than the texts sent, which would put an embedding on the wrong text
 */
export async function getVllmEmbeddings(texts, request, host) {
    const embeddings = [];
    for (let start = 0; start < texts.length; start += OPENAI_STYLE_BATCH_LIMIT) {
        const input = texts.slice(start, start + OPENAI_STYLE_BATCH_LIMIT);
        const batch = await embedBatch(input, request, host);
        if (!Array.isArray(batch) || batch.length !== input.length || !batch.every(Array.isArray)) {
            const returned = Array.isArray(batch) ? batch.filter(Array.isArray).length : 0;
            throw errorFreeOfServerReply(`VLLM: the server returned ${returned} embeddings for ${input.length} texts.`);
        }
        embeddings.push(...batch);
    }
    return embeddings;
}
