/**
 * Whether a chat consumer's connection can run, and the sentence for one that cannot (connection plan §1, §3). Agent
 * Mode, StoryArc and LoreBase resolve their connections here, so manual OpenRouter and vLLM are checked in this file
 * alone and retire from it (connection plan D1).
 */
import { getOpenRouterApiKey } from '../../shared/api-keys.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { checkConnectionProfile } from './llm-provider-call.js';

// The reason of a connection whose SillyTavern profile cannot be used; its `problem` says why and where to fix it.
const CONNECTION_PROFILE_REASON = 'connection_profile';
const UNKNOWN_PROVIDER_PREFIX = 'unknown_provider_';

// What each manual-provider reason means, and where it is fixed. Every consumer shares the keys and the vLLM URL.
const MANUAL_PROVIDER_FIXES = {
    missing_openrouter_api_key: 'it runs on OpenRouter and no OpenRouter key is saved. Enter the key on the AgentMode or Core page.',
    missing_vllm_url: 'it runs on vLLM with no URL. Set Base URL on the AgentMode page, or under EventBase model on the Core page.',
};

/**
 * Check that an LLM connection is filled in, and return what a call needs. On a SillyTavern connection profile the
 * profile supplies the model, URL and key, so only the profile is checked.
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} [params.model]
 * @param {string} [params.vllmUrl]
 * @param {string} [params.connectionProfileId]
 * @param {string} params.feature - Names the feature in a profile's problem
 * @param {string} params.page - The page that chooses the profile, named in its problem
 * @returns {{ok: true, provider: string, model: string, vllmUrl?: string, connectionProfileId?: string,
 *     connectionProfilePage?: string}|{ok: false, reason: string, problem?: string}}
 */
export function resolveLlmConnection({ provider: providerName, model: modelName, vllmUrl: rawVllmUrl, connectionProfileId = '', feature, page }) {
    const provider = String(providerName ?? '').toLowerCase();
    if (provider === CONNECTION_PROFILE_PROVIDER) {
        const check = checkConnectionProfile(connectionProfileId, { feature, page });
        if (!check.ok) return { ok: false, reason: CONNECTION_PROFILE_REASON, problem: check.reason };
        return { ok: true, provider, model: check.profile.model || '', connectionProfileId, connectionProfilePage: page };
    }

    const model = (modelName || '').trim();

    if (!model) {
        return { ok: false, reason: 'missing_model' };
    }

    if (provider === 'openrouter') {
        // One shared OpenRouter key (SECRET_KEYS.OPENROUTER): the Embedding, EventBase model and
        // Agent Mode key boxes all write that slot. Only whether it is saved is checked here: SillyTavern's
        // proxy reads the key itself. See src/shared/api-keys.js.
        if (!getOpenRouterApiKey()) {
            return { ok: false, reason: 'missing_openrouter_api_key' };
        }
        return { ok: true, provider, model };
    }

    if (provider === 'vllm') {
        const vllmUrl = (rawVllmUrl || '').trim();
        if (!vllmUrl) {
            return { ok: false, reason: 'missing_vllm_url' };
        }
        // The key is optional, as a server such as KoboldCpp needs none. SillyTavern's chat-completions proxy reads
        // SECRET_KEYS.CUSTOM server-side and sends its active key when one is saved, and no key when none is. A
        // server that needs a key and gets none refuses the call, as it refuses a wrong one.
        return { ok: true, provider, model, vllmUrl };
    }

    return { ok: false, reason: `unknown_provider_${provider}` };
}

/**
 * The vLLM URL a consumer with no URL row of its own runs on (StoryArc, LoreBase): the AgentMode page's, else the Core
 * page's EventBase model's, each only while its page runs on vLLM. A page on another provider hides its row, so a URL
 * left there would take the vLLM key to a server no page shows.
 *
 * @param {object} settings
 * @returns {string} '' when no page shows a vLLM URL
 */
export function shownVllmUrl(settings) {
    const isOnVllm = provider => String(provider ?? '').trim().toLowerCase() === 'vllm';
    const agentUrl = isOnVllm(settings.agent_provider) ? String(settings.agent_vllm_url ?? '').trim() : '';
    const eventBaseUrl = isOnVllm(settings.chat_provider) ? String(settings.chat_vllm_url ?? '').trim() : '';
    return agentUrl || eventBaseUrl;
}

/**
 * The sentence for a consumer's connection that cannot run: what is wrong and where to fix it, then what happens
 * until it is fixed, when anything does.
 *
 * @param {{feature: string, page: string, missingModelFix: string, consequence: string, isOn?: boolean}} consumer -
 *   `missingModelFix` says how its missing model is fixed, as the clause after the feature's name; `consequence` is ''
 *   when nothing happens until then; `isOn` is false for a feature that is off, whose sentence then names it without
 *   saying it is on
 * @param {string} reason - From resolveLlmConnection
 * @param {string} [problem] - From resolveLlmConnection, for a profile that cannot be used
 * @returns {string}
 */
export function describeConnectionProblem({ feature, page, missingModelFix, consequence, isOn = true }, reason, problem = '') {
    const withConsequence = sentence => (consequence ? `${sentence} ${consequence}` : sentence);
    if (reason === CONNECTION_PROFILE_REASON) return withConsequence(problem);
    let fix = MANUAL_PROVIDER_FIXES[reason] ?? `its connection cannot run (${reason}). Check the ${page} page.`;
    if (reason === 'missing_model') fix = missingModelFix;
    else if (reason.startsWith(UNKNOWN_PROVIDER_PREFIX)) fix = `its provider "${reason.slice(UNKNOWN_PROVIDER_PREFIX.length)}" is not one VectFox knows. Pick a provider on the ${page} page.`;
    return withConsequence(isOn ? `${feature} is on, but ${fix}` : `${feature}: ${fix}`);
}
