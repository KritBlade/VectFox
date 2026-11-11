/**
 * An LLM consumer's Test connection (connection plan §1): one short fixed message, never chat text, sent on the
 * connection the consumer resolves for its own calls, with room and time for that one reply.
 */

import { postChatCompletion } from './llm-provider-call.js';

/** What every connection test sends: a fixed line, so a test never carries chat text. */
export const CONNECTION_TEST_PROMPT = 'This is a connection test from VectFox. Reply with the single word OK.';

/** Room for a model that thinks before it answers, so a working connection does not come back as an empty reply. */
export const CONNECTION_TEST_MAX_TOKENS = 1024;

export const CONNECTION_TEST_TIMEOUT_MS = 60000;

/**
 * Send the test message on a connection a consumer resolved, for a consumer whose own call cannot carry it (Agent
 * Mode's and StoryArc's ask for JSON). It raises no toast of its own: the button reports the result.
 *
 * @param {object} route - provider, model, vllmUrl, connectionProfileId and connectionProfilePage, as resolved
 * @param {{contextLabel: string, parameterStyle?: object}} options - The feature's name, and its request switches
 * @returns {Promise<{content: string, cutReason: string|null}>}
 * @throws {import('./llm-provider-call.js').LlmCallError} What a call on that connection throws
 */
export async function sendConnectionTest(route, { contextLabel, parameterStyle = {} }) {
    const { content, cutReason } = await postChatCompletion({
        messages: [{ role: 'user', content: CONNECTION_TEST_PROMPT }],
        model: route.model,
        provider: route.provider,
        vllmUrl: route.vllmUrl || '',
        connectionProfileId: route.connectionProfileId || '',
        connectionProfilePage: route.connectionProfilePage || '',
        maxTokens: CONNECTION_TEST_MAX_TOKENS,
        temperature: 0,
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
        contextLabel,
        shouldNotifyProviderFailure: false,
        ...parameterStyle,
    });
    return { content, cutReason };
}
