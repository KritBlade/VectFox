// openai-style-embedding.js — embedding on a server's OpenAI-style /embeddings route, for the llama.cpp, KoboldCPP
// and Custom sources, which VectFox runs on a SillyTavern connection profile. The request names the server's URL, the
// model when the profile holds one, and the profile's key as an ID, `secret_id`. The key is read here, on
// SillyTavern's server, the way SillyTavern's own requests read it, so its value never reaches the browser.
//
// A request with no ID sends no key. SillyTavern's lookups read the active key when given no ID, which would send it
// to this request's server, so an ID no secret has goes in its place.

const NO_KEY_SECRET_ID = 'similharity-no-key';

/** Texts per request: SiliconFlow's limit, the lowest of the OpenAI-style embedding servers in use. */
export const OPENAI_STYLE_BATCH_LIMIT = 32;

const SOURCES = Object.freeze({
    llamacpp: { name: 'llama.cpp', textgenType: 'LLAMACPP', endpoint: (serverUrl, host) => `${host.trimV1(serverUrl)}/v1/embeddings` },
    koboldcpp: { name: 'KoboldCPP', textgenType: 'KOBOLDCPP', endpoint: (serverUrl, host) => `${host.trimV1(serverUrl)}/v1/embeddings` },
    // As SillyTavern's chat route appends /chat/completions to a Custom URL.
    custom: { name: 'Custom', textgenType: null, endpoint: serverUrl => `${serverUrl.replace(/\/+$/, '')}/embeddings` },
});

/**
 * Whether a source embeds through this file.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isOpenAiStyleEmbeddingSource(source) {
    return Object.hasOwn(SOURCES, source);
}

/**
 * What these requests use of SillyTavern: its key lookups, its URL trim and fetch.
 *
 * @returns {Promise<object>} The host getOpenAiStyleEmbeddings takes
 */
export async function loadSillyTavernEmbeddingHost() {
    const [headersModule, constantsModule, secretsModule, utilModule] = await Promise.all([
        import('../../src/additional-headers.js'),
        import('../../src/constants.js'),
        import('../../src/endpoints/secrets.js'),
        import('../../src/util.js'),
    ]);
    return {
        fetch: globalThis.fetch,
        trimV1: utilModule.trimV1,
        setAdditionalHeadersByType: headersModule.setAdditionalHeadersByType,
        readSecret: secretsModule.readSecret,
        TEXTGEN_TYPES: constantsModule.TEXTGEN_TYPES,
        SECRET_KEYS: secretsModule.SECRET_KEYS,
    };
}

/**
 * The key header for a request: the key the ID names, or none. llama.cpp and KoboldCPP read it through SillyTavern's
 * own header builder, which also adds any request overrides config.yaml sets for the server's host; Custom reads it
 * from the Custom key list, as SillyTavern's chat route does.
 */
function keyHeaders(kind, serverUrl, secretId, directories, host) {
    const id = secretId || NO_KEY_SECRET_ID;
    if (!kind.textgenType) {
        const key = host.readSecret(directories, host.SECRET_KEYS.CUSTOM, id);
        return key ? { Authorization: `Bearer ${key}` } : {};
    }
    const headers = {};
    host.setAdditionalHeadersByType(headers, host.TEXTGEN_TYPES[kind.textgenType], serverUrl, directories, id);
    return headers;
}

/** Throw before any request when the server URL does not make a URL. */
function assertUrl(endpoint, serverUrl, name) {
    try {
        new URL(endpoint);
    } catch (error) {
        throw new Error(`${name} embedding: "${serverUrl}" is not a URL.`, { cause: error });
    }
}

/** The embeddings in a reply, in the order of the texts sent. */
function embeddingsOfReply(data, count, name) {
    if (!Array.isArray(data?.data)) throw new Error(`${name} embedding: the server's reply holds no data array.`);
    const embeddings = [...data.data].sort((a, b) => a.index - b.index).map(item => item?.embedding);
    if (embeddings.length !== count || !embeddings.every(Array.isArray)) {
        throw new Error(`${name} embedding: the server returned ${embeddings.filter(Array.isArray).length} embeddings for ${count} texts.`);
    }
    return embeddings;
}

/**
 * Embed texts on an OpenAI-style server, at most OPENAI_STYLE_BATCH_LIMIT per request, in order.
 *
 * @param {string} source - llamacpp, koboldcpp or custom
 * @param {string[]} texts
 * @param {{apiUrl?: string, model?: string, secretId?: string, directories: object}} request - What the client sent,
 *   and the user's SillyTavern directories, where the key lists are
 * @param {object} host - From loadSillyTavernEmbeddingHost
 * @returns {Promise<number[][]>}
 * @throws {Error} With no server URL, before any request; with the status and the server's text when it refuses
 */
export async function getOpenAiStyleEmbeddings(source, texts, { apiUrl, model, secretId, directories }, host) {
    const kind = SOURCES[source];
    if (!kind) throw new Error(`Similharity: "${source}" does not embed on an OpenAI-style route.`);
    const serverUrl = String(apiUrl ?? '').trim();
    if (!serverUrl) throw new Error(`${kind.name} embedding: the request names no server URL.`);
    const endpoint = kind.endpoint(serverUrl, host);
    assertUrl(endpoint, serverUrl, kind.name);

    const headers = { 'Content-Type': 'application/json', ...keyHeaders(kind, serverUrl, secretId, directories, host) };
    const embeddings = [];
    for (let start = 0; start < texts.length; start += OPENAI_STYLE_BATCH_LIMIT) {
        const input = texts.slice(start, start + OPENAI_STYLE_BATCH_LIMIT);
        const response = await host.fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(model ? { input, model } : { input }),
        });
        if (!response.ok) {
            throw new Error(`${kind.name} embedding: ${response.status} ${response.statusText} ${await response.text()}`.trim());
        }
        embeddings.push(...embeddingsOfReply(await response.json(), input.length, kind.name));
    }
    return embeddings;
}
