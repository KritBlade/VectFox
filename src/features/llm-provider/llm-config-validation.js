/**
 * Checks that the LLM settings shared by VectFox's LLM features (provider, model and the
 * provider's credential or URL, or the connection profile) are filled in before a run that
 * needs them starts.
 */

import { getOpenRouterApiKey } from '../../shared/api-keys.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { checkConnectionProfile } from './llm-provider-call.js';

/**
 * Validate that the LLM configuration (provider, model, credentials) is filled in.
 * The EventBase extractor uses these settings, so any vectorization that goes through
 * an LLM call requires them.
 *
 * @param {object} settings - VectFox settings object
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateLLMConfig(settings = {}) {
    const provider = (settings?.chat_provider || 'openrouter').toLowerCase();
    if (provider === CONNECTION_PROFILE_PROVIDER) {
        const check = checkConnectionProfile(settings?.chat_connection_profile_id, { feature: 'EventBase', page: 'Core' });
        return check.ok ? { ok: true } : { ok: false, reason: check.reason };
    }

    const model = (settings?.chat_model || '').trim();

    if (!model) {
        return { ok: false, reason: 'Summarization / EventBase extraction model is not set.' };
    }

    if (provider === 'openrouter') {
        const key = getOpenRouterApiKey();
        if (!key) {
            return { ok: false, reason: 'OpenRouter API key is not set.' };
        }
    } else if (provider === 'vllm') {
        const url = (settings?.chat_vllm_url || '').trim();
        if (!url) {
            return { ok: false, reason: 'vLLM Base URL is not set.' };
        }
    } else {
        return { ok: false, reason: `Unknown LLM provider: ${provider}` };
    }

    return { ok: true };
}
