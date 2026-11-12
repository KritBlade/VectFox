/**
 * ============================================================================
 * MANUAL CONNECTION NOTICE, PURE RULES
 * ============================================================================
 * Which Provider dropdowns hold manual OpenRouter or vLLM, which a release three
 * months after this one removes, and what the one-time notice says about them
 * (connection plan row N1, §7). Pure: no host imports.
 * ============================================================================
 */

import { CHAT_CONSUMER_CONNECTIONS, ownProviderOf } from './connection-rows-core.js';

/** The manual providers that retire, by the value a Provider dropdown saves, with the name it shows. */
const RETIRING_PROVIDER_NAMES = new Map([['openrouter', 'OpenRouter'], ['vllm', 'vLLM']]);

const EMBEDDING = 'Embedding';

/**
 * Every Provider dropdown on manual OpenRouter or vLLM: each LLM consumer whose own dropdown holds one, then embedding.
 * Agent Mode and Auto-Reformat on Same as EventBase model are not named, since they move with the EventBase model.
 *
 * @param {object} settings - VectFox settings
 * @returns {Array<{feature: string, page: string, provider: string}>} provider as its dropdown names it
 */
export function manualConnections(settings) {
    const chatConnections = CHAT_CONSUMER_CONNECTIONS.map(consumer => ({
        feature: consumer.feature,
        page: consumer.page,
        provider: RETIRING_PROVIDER_NAMES.get(ownProviderOf(consumer, settings)),
    }));
    const embedding = {
        feature: EMBEDDING,
        page: 'Core',
        provider: RETIRING_PROVIDER_NAMES.get(String(settings?.embedding_provider ?? '').trim().toLowerCase()),
    };
    return [...chatConnections, embedding].filter(connection => connection.provider);
}

/**
 * The notice's lines (popup-core.js): what goes away and why, what runs on it now, how to move each, and, while
 * embedding is one of them, what embedding needs and what happens to the vectors already stored.
 *
 * @param {Array<{feature: string, page: string, provider: string}>} connections - From manualConnections, at least one
 * @param {{vectorBackend: string}} options - vectorBackend, the backend VectFox stores on: 'qdrant' or 'standard'
 * @returns {object[]}
 */
export function manualConnectionNoticeLines(connections, { vectorBackend }) {
    const embedding = connections.find(connection => connection.feature === EMBEDDING);
    const embeddingLines = embedding ? [
        { text: 'Embedding needs an Ollama, llama.cpp, KoboldCPP or Custom profile.' },
        ...(embedding.provider === 'OpenRouter'
            ? [{ text: 'For OpenRouter, make a Custom profile with the URL https://openrouter.ai/api/v1/embeddings, so SillyTavern lists its embedding models.' }]
            : []),
        vectorBackend === 'qdrant'
            ? { text: 'You are on Qdrant, so a profile with the same embedding model keeps your stored vectors.' }
            : { text: 'You are on the Standard backend, so a profile starts an empty store. Vectorize your chats again after you move.' },
    ] : [];
    return [
        { icon: 'fa-triangle-exclamation', text: 'Manual OpenRouter and vLLM are going away.' },
        { text: 'A VectFox release 3 months after this one removes the OpenRouter and vLLM options from every Provider dropdown.' },
        { text: 'I am moving VectFox to SillyTavern connection profiles, so it uses the model, URL and key you already set up in SillyTavern.' },
        { text: 'These run on one now:' },
        ...connections.map(connection => ({
            icon: 'fa-plug',
            parts: [{ name: connection.feature }, { text: ' runs on ' }, { name: connection.provider }, { text: ', on the ' }, { name: connection.page }, { text: ' page.' }],
        })),
        { text: 'To move one, save a profile under Connection Profiles in SillyTavern. Then choose SillyTavern profile in that Provider dropdown and pick your profile. Test connection tells you if it works.' },
        ...embeddingLines,
        { text: 'Until then, nothing changes. I show this only once.' },
    ];
}
