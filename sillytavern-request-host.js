// sillytavern-request-host.js — what the plugin's own requests to a provider use of SillyTavern: its key lookups and
// key list names, its URL trim, its header builder and fetch. The embedding routes for llama.cpp, KoboldCPP and Custom
// (openai-style-embedding.js) and LoreBase's decisions route (lorebase-decisions.js) read a key here, on SillyTavern's
// server, the way SillyTavern's own requests read it, so its value never reaches the browser. vLLM embedding
// (vllm-embedding.js) has its own loader, as it sends the saved key through SillyTavern's own vLLM function, and a
// SillyTavern that cannot load that function fails vLLM alone.

/**
 * SillyTavern's request helpers, loaded from its server modules.
 *
 * @returns {Promise<{fetch: Function, trimV1: Function, setAdditionalHeadersByType: Function, readSecret: Function,
 *   TEXTGEN_TYPES: object, SECRET_KEYS: object}>}
 */
export async function loadSillyTavernRequestHost() {
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
 * SillyTavern's vLLM embedding function, which sends the saved vLLM key, and what a request with its own key needs:
 * the URL trim and join that function uses, and fetch.
 *
 * @returns {Promise<{getVllmBatchVector: Function, trimV1: Function, urlJoin: Function, fetch: Function}>}
 */
export async function loadVllmRequestHost() {
    const [vllmVectorsModule, utilModule, urlJoinModule] = await Promise.all([
        import('../../src/vectors/vllm-vectors.js'),
        import('../../src/util.js'),
        import('url-join'),
    ]);
    return {
        getVllmBatchVector: vllmVectorsModule.getVllmBatchVector,
        trimV1: utilModule.trimV1,
        urlJoin: urlJoinModule.default,
        fetch: globalThis.fetch,
    };
}
