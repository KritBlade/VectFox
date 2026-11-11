/**
 * The pure rules of a chat call on a SillyTavern connection profile (connection plan §1, §2, §4): which profile a
 * consumer uses, the request's closed set of override keys, what is wrong with a profile before a call, and what a
 * failed call means. No host imports: the profile branch in llm-provider-call.js gathers the facts and acts on the
 * answers.
 */

import { connectionProfileAvailabilityProblem } from '../../shared/connection-profile-availability.js';
import { connectionProfileKeyMessage, namesKeyProblem } from '../../shared/connection-profile-key-failure.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { getModelConfigErrorMessage } from '../../shared/model-http-errors.js';
import { isConnectionError } from '../../shared/model-config-notifier.js';
import { resolveInheritedConnection } from './inherited-connection.js';

const textOf = value => String(value ?? '').trim();

/**
 * The keys a profile request may override, by the kind of request (plan §2). Closed: SillyTavern spreads the override
 * last, so any other key could replace the profile's URL or API and send its key to another host. Text Completion gets
 * less, as SillyTavern forwards its body to most servers as it is. The wrapper adds one more key, for a profile that
 * stores no key: the ID that matches none.
 */
export const CONNECTION_PROFILE_OVERRIDE_KEYS = Object.freeze({
    chat: Object.freeze(['temperature', 'max_completion_tokens', 'reasoning_effort', 'response_format']),
    text: Object.freeze(['temperature']),
});

/**
 * The profile a chat consumer runs on, or '' when it runs on a manual provider. Agent Mode and Auto-Reformat take it
 * through resolveInheritedConnection, so on Same as EventBase model they use the EventBase model's profile.
 *
 * @param {object} settings - VectFox settings
 * @param {'eventbase'|'agent'|'reformat'|'storyarc'} consumer
 * @returns {string}
 */
export function resolveConnectionProfileId(settings, consumer) {
    switch (consumer) {
        case 'eventbase':
            return textOf(settings?.chat_provider) === CONNECTION_PROFILE_PROVIDER ? textOf(settings?.chat_connection_profile_id) : '';
        case 'storyarc':
            return textOf(settings?.story_arc_link_provider) === CONNECTION_PROFILE_PROVIDER
                ? textOf(settings?.story_arc_link_connection_profile_id) : '';
        case 'agent':
        case 'reformat': {
            const prefix = consumer === 'agent' ? 'agent' : 'reformat';
            const connection = resolveInheritedConnection({
                provider: settings?.[`${prefix}_provider`],
                connectionProfileId: settings?.[`${prefix}_connection_profile_id`],
            }, settings);
            return connection.provider === CONNECTION_PROFILE_PROVIDER ? connection.connectionProfileId : '';
        }
        default:
            throw new Error(`Unknown chat consumer: ${consumer}`);
    }
}

/**
 * The request's max-token argument and override keys, from the same switches the manual path reads
 * (resolveModelParameterStyle). Chat Completion: temperature when it is sent, max_completion_tokens in place of the
 * max-token argument when chosen, reasoning_effort and response_format when given. Text Completion: temperature only.
 * Only the keys CONNECTION_PROFILE_OVERRIDE_KEYS lists for the API leave this function.
 *
 * @param {object} request
 * @param {'chat'|'text'} request.api - From the wrapper's connectionProfileApi
 * @param {number} request.maxTokens
 * @param {number} request.temperature
 * @param {boolean} request.sendTemperature
 * @param {string} request.tokenLimitParameter - 'max_tokens' or 'max_completion_tokens'
 * @param {string|null} request.reasoningEffort
 * @param {object|null} request.responseFormat
 * @returns {{maxTokens: number|undefined, overridePayload: object}}
 */
export function connectionProfileRequestShape({ api, maxTokens, temperature, sendTemperature, tokenLimitParameter, reasoningEffort, responseFormat }) {
    const isCompletionTokenLimit = api === 'chat' && tokenLimitParameter === 'max_completion_tokens';
    const wanted = {
        ...(sendTemperature ? { temperature } : {}),
        ...(isCompletionTokenLimit ? { max_completion_tokens: maxTokens } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    const allowed = CONNECTION_PROFILE_OVERRIDE_KEYS[api] ?? [];
    const overridePayload = Object.fromEntries(Object.entries(wanted).filter(([key]) => allowed.includes(key)));
    return { maxTokens: isCompletionTokenLimit ? undefined : maxTokens, overridePayload };
}

/**
 * What stops a call on a profile before it starts, or '' when nothing does. Each reason names the feature and where to
 * fix it.
 *
 * @param {object} facts
 * @param {string} facts.feature - 'EventBase', 'Agent Mode', …
 * @param {string} facts.page - The page whose Provider row chooses the profile
 * @param {string} facts.profileId
 * @param {boolean} facts.isManagerAvailable
 * @param {object|null} facts.profile
 * @param {boolean} facts.isSupported
 * @param {'chat'|'text'|null} facts.api
 * @returns {string}
 */
export function connectionProfileProblem({ feature, page, profileId, isManagerAvailable, profile, isSupported, api }) {
    const unavailable = connectionProfileAvailabilityProblem({ feature, page, profileId, isManagerAvailable, profile });
    if (unavailable) return unavailable;
    const name = profile.name || '(unnamed)';
    if (!isSupported || !api) {
        return `${feature}: SillyTavern can't send requests on profile "${name}" (API "${profile.api ?? 'none'}"). `
            + `Choose a Chat Completion or Text Completion profile on the ${page} page.`;
    }
    if (api === 'chat' && !textOf(profile.model)) {
        return `${feature}: profile "${name}" names no model. Choose a model in that profile in SillyTavern.`;
    }
    return '';
}

// What SillyTavern's server says when the reply it got could not be read as JSON: Node's own parse errors, and
// node-fetch's.
const NOT_AN_API_REPLY = /is not valid JSON|in JSON at position|Unexpected end of JSON input|invalid json response body/i;

/**
 * What a failed profile request means (plan §4), first match wins:
 *   1. Not SillyTavern's 'API request failed' (Connection Manager off, profile gone, unknown API): model_config.
 *   2. A timeout or abort: rethrow its cause, as the manual path does.
 *   3. 'Response not OK', all a Text Completion failure or a missing key leaves: model_config, the key message when
 *      the profile stores no key, else a pointer to the SillyTavern server console.
 *   4. Text naming a key problem, authorization included: model_config with the key message.
 *   5. Text saying the reply was not JSON, as when the profile's URL serves a web page: model_config, pointing at
 *      the URL.
 *   6. A model or configuration error: model_config.
 *   7. A connection failure: connection.
 *   8. Anything else, a moderation block on one window included: upstream_error.
 * model_config is the kind that raises the sticky toast and pauses auto-sync; an auth kind would fail in silence.
 *
 * @param {Error} error - What sendRequest threw
 * @param {{feature: string, profileName: string, model: string, storesKey: boolean}} context
 * @returns {{kind: 'model_config'|'connection'|'upstream_error', message: string, detail: string}|{kind: 'rethrow', cause: Error}}
 */
export function classifyConnectionProfileFailure(error, { feature, profileName, model, storesKey }) {
    const cause = error?.cause;
    if (error?.message !== 'API request failed' || !cause) {
        const detail = textOf(error?.message) || String(error);
        return { kind: 'model_config', message: `${feature}: profile "${profileName}" could not be used: ${detail}`, detail };
    }
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') return { kind: 'rethrow', cause };

    const detail = (textOf(cause.message) || String(cause)).replace(/\s+/g, ' ').slice(0, 300);
    if (detail === 'Response not OK') {
        return {
            kind: 'model_config',
            detail,
            message: storesKey
                ? `${feature}: SillyTavern got no usable reply on profile "${profileName}". The reason is in the SillyTavern server console.`
                : connectionProfileKeyMessage({ feature, profileName, storesKey }),
        };
    }
    if (namesKeyProblem(detail)) {
        return { kind: 'model_config', detail, message: connectionProfileKeyMessage({ feature, profileName, storesKey }) };
    }
    if (NOT_AN_API_REPLY.test(detail)) {
        return {
            kind: 'model_config',
            detail,
            message: `${feature}: the server of profile "${profileName}" answered with a web page or other text, not an API reply. `
                + 'Check the URL saved in that profile in SillyTavern.',
        };
    }
    if (getModelConfigErrorMessage({ contextLabel: feature, provider: profileName, model, status: null, responseText: detail, enforceStatusGate: false })) {
        return { kind: 'model_config', detail, message: `${feature}: profile "${profileName}" reports a model or configuration error for model "${model}": ${detail}` };
    }
    if (isConnectionError(detail)) {
        return { kind: 'connection', detail, message: `${feature}: couldn't reach the server of profile "${profileName}" — ${detail}` };
    }
    return { kind: 'upstream_error', detail, message: `${feature}: profile "${profileName}" rejected the request — ${detail}` };
}
