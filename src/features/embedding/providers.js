/**
 * ============================================================================
 * VectFox EMBEDDING PROVIDERS
 * ============================================================================
 * Single source of truth for embedding providers and their configurations.
 * Import this anywhere you need provider information.
 *
 * @author VectFox
 * ============================================================================
 */

import { SECRET_KEYS } from '../../sillytavern/secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../sillytavern/connection-settings.js';
import {
    connectionProfileEmbeddingProvider,
    connectionProfileServerUrl,
    findConnectionProfile,
    isConnectionManagerAvailable,
} from '../../sillytavern/connection-profiles.js';
import { EMBEDDING_PROFILE_PROVIDERS, embeddingProfileProblem } from './embedding-profile-core.js';

/**
 * All supported embedding providers
 * This is the canonical list - update here and it applies everywhere
 */
export const EMBEDDING_PROVIDERS = {
    // Local providers (no API key needed)
    transformers: {
        name: 'Local (Transformers)',
        local: true,
        requiresModel: false,
        requiresApiKey: false,
        requiresUrl: false,
    },

    // Local server providers (need URL)
    ollama: {
        name: 'Ollama',
        local: true,
        requiresModel: true,
        modelField: 'embedding_ollama_model',
        requiresApiKey: false,
        requiresUrl: true,
    },
    // llamacpp: { name: 'llama.cpp', local: true, requiresModel: false, requiresApiKey: false, requiresUrl: true },
    // koboldcpp: { name: 'KoboldCpp', local: true, requiresModel: false, requiresApiKey: false, requiresUrl: true },
    vllm: {
        name: 'vLLM',
        local: true,
        requiresModel: true,
        modelField: 'embedding_vllm_model',
        requiresApiKey: false,
        requiresUrl: true,
    },

    // Cloud providers (need API key)
    // openai: { name: 'OpenAI', local: false, requiresModel: true, modelField: 'openai_model', requiresApiKey: true, secretKey: SECRET_KEYS.OPENAI, requiresUrl: false },
    // cohere: { name: 'Cohere', local: false, requiresModel: true, modelField: 'cohere_model', requiresApiKey: true, secretKey: SECRET_KEYS.COHERE, requiresUrl: false },
    // togetherai: { name: 'TogetherAI', local: false, requiresModel: true, modelField: 'togetherai_model', requiresApiKey: true, secretKey: SECRET_KEYS.TOGETHERAI, requiresUrl: false },
    openrouter: {
        name: 'OpenRouter',
        local: false,
        requiresModel: true,
        modelField: 'embedding_openrouter_model',
        requiresApiKey: true,
        secretKey: SECRET_KEYS.OPENROUTER,
        requiresUrl: false,
    },
    // mistral: { name: 'MistralAI', local: false, requiresModel: true, modelField: 'mistral_model', requiresApiKey: true, secretKey: SECRET_KEYS.MISTRALAI, requiresUrl: false },
    // nomicai: { name: 'NomicAI', local: false, requiresModel: false, requiresApiKey: true, secretKey: SECRET_KEYS.NOMICAI, requiresUrl: false },
    // palm: { name: 'Google AI Studio', local: false, requiresModel: true, modelField: 'google_model', requiresApiKey: true, secretKey: SECRET_KEYS.MAKERSUITE, requiresUrl: false },
    // vertexai: { name: 'Google Vertex AI', local: false, requiresModel: true, modelField: 'google_model', requiresApiKey: true, secretKey: SECRET_KEYS.VERTEXAI, requiresUrl: false },
    // electronhub: { name: 'Electron Hub', local: false, requiresModel: true, modelField: 'electronhub_model', requiresApiKey: true, secretKey: SECRET_KEYS.ELECTRONHUB, requiresUrl: false },
    // extras: { name: 'Extras (deprecated)', local: false, requiresModel: false, requiresApiKey: false, requiresUrl: true, deprecated: true },
};

/**
 * Check if a provider ID is valid
 */
export function isValidProvider(providerId) {
    return providerId in EMBEDDING_PROVIDERS;
}

/**
 * Get provider config by ID
 */
export function getProviderConfig(providerId) {
    return EMBEDDING_PROVIDERS[providerId] || null;
}

/**
 * Get the model field name for a provider
 */
export function getModelField(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.modelField || null;
}

/**
 * The SillyTavern connection profile embedding runs on, with what it supplies, or null while embedding runs on a
 * manual provider: no profile ID is stored, or the provider is not one a profile carries (connection plan §3).
 * `problem` says why the profile cannot be used, '' when it can.
 *
 * @param {object} settings - VectFox settings
 * @returns {{profileName: string, url: string, model: string, problem: string}|null}
 */
export function resolveEmbeddingProfile(settings) {
    const profileId = String(settings?.embedding_connection_profile_id ?? '').trim();
    if (!profileId || !Object.hasOwn(EMBEDDING_PROFILE_PROVIDERS, settings?.embedding_provider)) return null;
    const isManagerAvailable = isConnectionManagerAvailable();
    const profile = findConnectionProfile(profileId);
    const url = profile ? connectionProfileServerUrl(profile) : '';
    const model = String(profile?.model ?? '').trim();
    const profileProvider = profile ? connectionProfileEmbeddingProvider(profile) : null;
    return {
        profileName: profile?.name ?? '',
        url,
        model,
        problem: embeddingProfileProblem({ profileId, isManagerAvailable, profile, profileProvider, url, model }),
    };
}

/**
 * The embedding model's name for the active provider. Settings keep one field per provider
 * (`embedding_openrouter_model`, `embedding_ollama_model`, …), never a flat `settings.model`, so every request
 * that names a model reads it here, and an insert and a later list or query name the same one.
 *
 * On a connection profile it is the model the profile names, even while the profile cannot be used, so a request that
 * carries only the source and model still finds what that model stored. Every request that also needs the server's
 * URL stops at resolveProviderApiUrl instead.
 *
 * @param {object} settings - VectFox settings
 * @param {string} [fallback=''] - Returned when the provider has no model field, or no model is set
 * @returns {string}
 */
export function getModelFromSettings(settings, fallback = '') {
    const onProfile = resolveEmbeddingProfile(settings);
    if (onProfile) return onProfile.model || fallback;
    const modelField = getModelField(settings?.embedding_provider);
    if (!modelField) return fallback;
    return settings[modelField] || fallback;
}

/**
 * Get the secret key constant for a provider
 */
export function getSecretKey(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.secretKey || null;
}

/**
 * Check if provider requires an API key
 */
export function requiresApiKey(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.requiresApiKey || false;
}

/**
 * Check if provider requires a custom URL
 */
export function requiresUrl(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.requiresUrl || false;
}

/**
 * The embedding server's base URL for a URL-based provider, which every request that needs it reads here.
 *
 * On a connection profile, the URL the profile names. A profile that cannot be used throws instead, before any
 * request: it never falls back to the provider's own URL fields, SillyTavern's server URL or the plugin's default.
 *
 * On a manual provider, the URL the provider's own fields hold (`embedding_ollama_url_override` and
 * `embedding_ollama_url`, `embedding_vllm_url_override` and `embedding_vllm_url`) when its own URL is switched on,
 * or else SillyTavern's Text Completion server URL for that type. llamacpp and koboldcpp, not in EMBEDDING_PROVIDERS,
 * have no fields of their own and read the unprefixed `use_alt_endpoint` and `alt_endpoint_url`.
 *
 * @param {object} settings - VectFox settings
 * @param {string} [source=settings.embedding_provider] - Provider id (defaults to active source)
 * @returns {string|undefined} Base URL, or undefined for providers that take no URL.
 *   May be an empty string when the provider is URL-based but nothing is configured.
 * @throws {Error} With `code: 'invalid_model_config'`, when embedding runs on a profile that cannot be used
 */
export function resolveProviderApiUrl(settings, source = settings?.embedding_provider) {
    const onProfile = source === settings?.embedding_provider ? resolveEmbeddingProfile(settings) : null;
    if (onProfile) {
        if (onProfile.problem) throw Object.assign(new Error(onProfile.problem), { code: 'invalid_model_config' });
        return onProfile.url;
    }
    switch (source) {
        case 'ollama':
            return settings.embedding_ollama_url_override
                ? settings.embedding_ollama_url
                : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
        case 'vllm':
            return settings.embedding_vllm_url_override
                ? settings.embedding_vllm_url
                : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
        case 'llamacpp':
            return settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
        case 'koboldcpp':
            return settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
        default:
            return undefined;
    }
}
