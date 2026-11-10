/**
 * ============================================================================
 * INHERITED CONNECTION
 * ============================================================================
 * The connection of an LLM consumer that has its own Provider, Model and Base
 * URL boxes and can run on the EventBase model's: Agent Mode and Auto-Reformat.
 * Pure: reads settings, returns values.
 * ============================================================================
 */

const textOf = value => String(value ?? '').trim();

/**
 * Resolve a consumer's connection from its own boxes and the EventBase model's (Core page: chat_provider, chat_model,
 * chat_vllm_url).
 *
 * - An empty provider is "Same as EventBase model": the EventBase model's provider and Base URL. The consumer's own
 *   Base URL is left out, since its row is hidden while that option is chosen.
 * - A blank model takes the EventBase model's, whichever provider runs it. A typed one replaces only the model.
 * - A consumer that picks vLLM itself and leaves its Base URL blank takes the EventBase model's URL.
 *
 * @param {{provider?: string, model?: string, vllmUrl?: string}} own - The consumer's own boxes
 * @param {object} settings - VectFox settings
 * @returns {{provider: string, model: string, vllmUrl: string}} the provider in lower case; '' for a model or URL set nowhere
 */
export function resolveInheritedConnection(own, settings) {
    const ownProvider = textOf(own?.provider).toLowerCase();
    const isSameAsEventBaseModel = ownProvider === '';
    const eventBaseUrl = textOf(settings?.chat_vllm_url);
    return {
        provider: isSameAsEventBaseModel ? (textOf(settings?.chat_provider) || 'openrouter').toLowerCase() : ownProvider,
        model: textOf(own?.model) || textOf(settings?.chat_model),
        vllmUrl: isSameAsEventBaseModel ? eventBaseUrl : textOf(own?.vllmUrl) || eventBaseUrl,
    };
}
