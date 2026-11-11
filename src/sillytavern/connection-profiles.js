// connection-profiles.js — SillyTavern's Connection Manager profiles, for a chat call or embedding that runs on one:
// whether the Connection Manager is on, a profile by ID, whether SillyTavern can send a request on it and of which kind,
// the request itself through SillyTavern's ConnectionManagerRequestService, and its reply as text; for embedding, the
// provider a profile's API is, the server URL it names and the ID of its key. The only file that touches that service
// or a profile's key ID or URL (connection plan §6, credential invariant 4). SillyTavern's server, or Similharity on
// it, resolves the key from the ID; no key value ever reaches VectFox.
//
// SillyTavern's context comes from its page global, read at each call, so importing this file loads nothing of
// SillyTavern's and the chat-call modules that import it stay loadable on their own.
import { log } from './log.js';

const getContext = () => globalThis.SillyTavern.getContext();

const CONNECTION_MANAGER = 'connection-manager';

// What a profile with no stored key sends as its secret_id: an ID no secret has, so SillyTavern finds none and sends no
// key. With no ID at all SillyTavern would read the list's active key and send it to this profile's URL (plan §2).
const NO_KEY_SECRET_ID = 'vectfox-no-key';

/** The kind of request a profile sends: SillyTavern's Chat Completion or Text Completion API. */
export const CONNECTION_PROFILE_API = Object.freeze({ chat: 'chat', text: 'text' });
const API_OF_SELECTED = { openai: CONNECTION_PROFILE_API.chat, textgenerationwebui: CONNECTION_PROFILE_API.text };

/** Whether the Connection Manager extension is on, so its profiles can be used. */
export function isConnectionManagerAvailable() {
    const context = getContext();
    return !context.extensionSettings?.disabledExtensions?.includes(CONNECTION_MANAGER)
        && Boolean(context.ConnectionManagerRequestService);
}

/**
 * A profile by its ID, or null when no profile has it.
 *
 * @param {string} profileId
 * @returns {object|null}
 */
export function findConnectionProfile(profileId) {
    if (!profileId) return null;
    const profiles = getContext().extensionSettings?.connectionManager?.profiles;
    return (Array.isArray(profiles) ? profiles : []).find(profile => profile?.id === profileId) ?? null;
}

/**
 * Whether SillyTavern can send a request on this profile. Asked per profile: SillyTavern's own check throws on an API
 * it does not know, so one such profile would otherwise fail every profile asked with it.
 *
 * @param {object} profile
 * @returns {boolean}
 */
export function isConnectionProfileSupported(profile) {
    try {
        return getContext().ConnectionManagerRequestService.isProfileSupported(profile);
    } catch (error) {
        log.warn(`Connection profile "${profile?.name ?? '(unnamed)'}" has an API SillyTavern does not know (${profile?.api}):`, error);
        return false;
    }
}

/**
 * Which request a profile sends, chat or text, or null for an API that sends neither.
 *
 * @param {object} profile
 * @returns {string|null} A CONNECTION_PROFILE_API value
 */
export function connectionProfileApi(profile) {
    const selected = getContext().CONNECT_API_MAP?.[profile?.api]?.selected;
    return API_OF_SELECTED[selected] ?? null;
}

/**
 * The embedding provider a profile's API is, as SillyTavern maps it: a Text Completion type such as `ollama`, or a
 * Chat Completion source such as `custom`. null for an API SillyTavern does not know.
 *
 * @param {object} profile
 * @returns {string|null}
 */
export function connectionProfileEmbeddingProvider(profile) {
    const api = getContext().CONNECT_API_MAP?.[profile?.api];
    return api?.type ?? api?.source ?? null;
}

/**
 * The server URL a profile names, where an embedding profile's server answers. '' when it names none.
 *
 * @param {object} profile
 * @returns {string}
 */
export function connectionProfileServerUrl(profile) {
    return String(profile?.['api-url'] ?? '').trim();
}

/**
 * The key field of an embedding request on a llama.cpp, KoboldCPP or Custom profile: the ID of the key the profile
 * stores, which Similharity reads on SillyTavern's server. Empty with no stored key, and Similharity then sends none.
 *
 * @param {object} profile
 * @returns {{secret_id?: string}}
 */
export function connectionProfileEmbeddingKeyField(profile) {
    return connectionProfileStoresKey(profile) ? { secret_id: String(profile['secret-id']) } : {};
}

/**
 * Whether the profile names a stored key. Presence only: the key itself stays on SillyTavern's server.
 *
 * @param {object} profile
 * @returns {boolean}
 */
export function connectionProfileStoresKey(profile) {
    return Boolean(profile?.['secret-id']);
}

/**
 * Send one chat request on a profile through SillyTavern, which adds the profile's URL and key itself. It never
 * applies the profile, so SillyTavern's own connection and active key stay as they are. No preset is sent:
 * `includePreset` would add the preset's sampling and flags. The raw reply comes back, so its finish reason and usage
 * survive.
 *
 * @param {object} profile
 * @param {Array<{role: string, content: string}>} messages
 * @param {number|undefined} maxTokens - undefined when the payload carries max_completion_tokens instead
 * @param {{timeoutMs: number, overridePayload: object}} request - overridePayload from the request-shape builder
 * @returns {Promise<any>} The provider's raw reply
 * @throws {Error} SillyTavern's own errors: a bare one before the request, or 'API request failed' with the cause
 */
export async function sendConnectionProfileRequest(profile, messages, maxTokens, { timeoutMs, overridePayload }) {
    const payload = connectionProfileStoresKey(profile) ? overridePayload : { ...overridePayload, secret_id: NO_KEY_SECRET_ID };
    return getContext().ConnectionManagerRequestService.sendRequest(profile.id, messages, maxTokens, {
        stream: false,
        extractData: false,
        includePreset: false,
        includeInstruct: true,
        signal: AbortSignal.timeout(timeoutMs),
    }, payload);
}

/**
 * The reply's text, read the way SillyTavern reads the profile's API: OpenAI-style choices, Claude's content array,
 * Cohere's message, and Text Completion's text, llama.cpp's content and Ollama's response.
 *
 * @param {object} profile
 * @param {any} data - The raw reply from sendConnectionProfileRequest
 * @returns {string}
 */
export function connectionProfileReplyText(profile, data) {
    const context = getContext();
    return String(context.extractMessageFromData(data, context.CONNECT_API_MAP?.[profile?.api]?.selected ?? null) ?? '');
}
