/**
 * ============================================================================
 * INHERITED CONNECTION
 * ============================================================================
 * The connection of an LLM consumer that has its own Provider, Model and Base
 * URL boxes and can run on the EventBase model's: Agent Mode and Auto-Reformat.
 * Pure: reads settings, returns values.
 * ============================================================================
 */

import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';

const textOf = value => String(value ?? '').trim();

/**
 * Resolve a consumer's connection from its own boxes and the EventBase model's (Core page: chat_provider, chat_model,
 * chat_vllm_url, chat_connection_profile_id).
 *
 * - An empty provider is "Same as EventBase model": the EventBase model's whole connection, its provider and Base URL,
 *   or on a profile its profile. The consumer's own Base URL and profile are left out, since their rows are hidden while
 *   that option is chosen.
 * - A blank model takes the EventBase model's, whichever provider runs it. A typed one replaces only the model.
 * - A consumer that picks vLLM itself and leaves its Base URL blank takes the EventBase model's URL.
 * - While the EventBase model runs on a profile, its Model and Base URL rows are hidden, so a blank box reads nothing
 *   from them and fails with a reason instead of using a value nobody can see.
 * - On a profile there is no model or URL to resolve: the profile supplies both.
 *
 * @param {{provider?: string, model?: string, vllmUrl?: string, connectionProfileId?: string}} own - The consumer's own boxes
 * @param {object} settings - VectFox settings
 * @returns {{provider: string, model: string, vllmUrl: string, connectionProfileId: string}} the provider in lower case;
 *          '' for a model, URL or profile set nowhere
 */
export function resolveInheritedConnection(own, settings) {
    const ownProvider = textOf(own?.provider).toLowerCase();
    const isSameAsEventBaseModel = ownProvider === '';
    const eventBaseProvider = (textOf(settings?.chat_provider) || 'openrouter').toLowerCase();
    const isEventBaseOnProfile = eventBaseProvider === CONNECTION_PROFILE_PROVIDER;
    const provider = isSameAsEventBaseModel ? eventBaseProvider : ownProvider;

    if (provider === CONNECTION_PROFILE_PROVIDER) {
        const profileId = isSameAsEventBaseModel ? settings?.chat_connection_profile_id : own?.connectionProfileId;
        return { provider, model: '', vllmUrl: '', connectionProfileId: textOf(profileId) };
    }

    const eventBaseModel = isEventBaseOnProfile ? '' : textOf(settings?.chat_model);
    const eventBaseUrl = isEventBaseOnProfile ? '' : textOf(settings?.chat_vllm_url);
    return {
        provider,
        model: textOf(own?.model) || eventBaseModel,
        vllmUrl: isSameAsEventBaseModel ? eventBaseUrl : textOf(own?.vllmUrl) || eventBaseUrl,
        connectionProfileId: '',
    };
}
