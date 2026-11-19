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
    connectionProfileKeyIdField,
    connectionProfileServerUrl,
    connectionProfileSource,
    connectionProfileStoresKey,
    findConnectionProfile,
    isConnectionManagerAvailable,
} from '../../sillytavern/connection-profiles.js';
import { checkPluginAvailable, PLUGIN_UPDATE_INSTRUCTIONS, similharityStanding } from '../../shared/similharity-plugin.js';
import { embeddingProfileKind, embeddingProfileProblem } from './embedding-profile-core.js';

/**
 * All supported embedding providers
 * This is the canonical list - update here and it applies everywhere
 *
 * searchPieceTokens: the most a search text may measure (search-pieces-core.js searchTokens) to be embedded whole; a
 * longer one is searched in pieces of this size (InternalProject/Vectfox/plans/executed/search-text-pieces.md §2).
 * Each sits under the provider's limit with room for the measure's error.
 */
export const EMBEDDING_PROVIDERS = {
    // Local providers (no API key needed)
    transformers: {
        name: 'Local (Transformers)',
        // jina, SillyTavern's shipped default, crashes near 6,000 tokens; transformers.js does not cut it.
        searchPieceTokens: 4000,
        local: true,
        requiresModel: false,
        requiresApiKey: false,
        requiresUrl: false,
    },

    // Local server providers (need URL)
    ollama: {
        name: 'Ollama',
        // SillyTavern asks Ollama to cut at the model's context, 2,048 for nomic-embed-text by default.
        searchPieceTokens: 2000,
        local: true,
        requiresModel: true,
        modelField: 'embedding_ollama_model',
        requiresApiKey: false,
        requiresUrl: true,
    },
    vllm: {
        name: 'vLLM',
        // The model's own length decides, 8,192 for bge-m3.
        searchPieceTokens: 6000,
        local: true,
        requiresModel: true,
        modelField: 'embedding_vllm_model',
        requiresApiKey: false,
        requiresUrl: true,
    },

    // On a SillyTavern connection profile only, which names the server's URL, the model and the key (connection
    // plan §3), so they have no fields of their own.
    llamacpp: {
        name: 'llama.cpp',
        // A default server rejects more than its physical batch, 512 tokens.
        searchPieceTokens: 500,
        local: true,
        requiresModel: false,
        requiresApiKey: false,
        requiresUrl: true,
    },
    koboldcpp: {
        name: 'KoboldCPP',
        // Its embedding limit is not documented; as low as llama.cpp, on which it is built.
        searchPieceTokens: 500,
        local: true,
        requiresModel: false,
        requiresApiKey: false,
        requiresUrl: true,
    },
    custom: {
        name: 'Custom (OpenAI-compatible)',
        // The embedding model's length: 8,192 for bge-m3 and OpenAI's text-embedding-3.
        searchPieceTokens: 6000,
        local: false,
        requiresModel: true,
        requiresApiKey: false,
        requiresUrl: true,
    },

    // Cloud providers (need API key)
    // openai: { name: 'OpenAI', local: false, requiresModel: true, modelField: 'openai_model', requiresApiKey: true, secretKey: SECRET_KEYS.OPENAI, requiresUrl: false },
    // cohere: { name: 'Cohere', local: false, requiresModel: true, modelField: 'cohere_model', requiresApiKey: true, secretKey: SECRET_KEYS.COHERE, requiresUrl: false },
    // togetherai: { name: 'TogetherAI', local: false, requiresModel: true, modelField: 'togetherai_model', requiresApiKey: true, secretKey: SECRET_KEYS.TOGETHERAI, requiresUrl: false },
    openrouter: {
        name: 'OpenRouter',
        // Most of its embedding models take 8,192 tokens or more.
        searchPieceTokens: 6000,
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

/** The Similharity plugin SillyTavern has, as a profile that sends a key ID needs it. */
function similharityForProfileEmbedding() {
    return { ...similharityStanding(), updateInstructions: PLUGIN_UPDATE_INSTRUCTIONS };
}

/**
 * The SillyTavern connection profile embedding runs on, with what it supplies, or null while embedding runs on a
 * manual provider: the provider is not one a profile carries, or it is Ollama with no profile ID stored (connection
 * plan §3). llama.cpp, KoboldCPP and Custom run only on a profile, so with no ID stored they answer with that problem.
 * `problem` says why the profile cannot be used, '' when it can. The Similharity check reads the probe's settled
 * result, so a caller about to send a request waits for checkPluginAvailable() first, as
 * embeddingProfileRequestFields does.
 *
 * @param {object} settings - VectFox settings
 * @returns {{profileName: string, url: string, model: string, storesKey: boolean, problem: string}|null}
 */
export function resolveEmbeddingProfile(settings) {
    const provider = settings?.embedding_provider;
    const kind = embeddingProfileKind(provider);
    const profileId = String(settings?.embedding_connection_profile_id ?? '').trim();
    if (!kind || (!profileId && kind.hasManualFields)) return null;
    const isManagerAvailable = isConnectionManagerAvailable();
    const profile = findConnectionProfile(profileId);
    const url = profile ? connectionProfileServerUrl(profile) : '';
    const model = String(profile?.model ?? '').trim();
    const profileProvider = profile ? connectionProfileSource(profile) : null;
    return {
        profileName: profile?.name ?? '',
        url,
        model,
        storesKey: profile ? connectionProfileStoresKey(profile) : false,
        problem: embeddingProfileProblem({
            provider, profileId, isManagerAvailable, profile, profileProvider, url, model,
            plugin: similharityForProfileEmbedding(),
        }),
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
 * Why VectFox's embedding model cannot embed now, or '' when it can: no provider, one VectFox does not know, a
 * connection profile that cannot be used, or no model where the provider needs one. A profile's Similharity check reads
 * the probe's settled result, so a caller that must be sure waits for checkPluginAvailable() first, as the diagnostics
 * check does.
 *
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function embeddingSetupProblem(settings) {
    const source = settings?.embedding_provider;
    if (!source) return 'No embedding provider selected';
    const config = getProviderConfig(source);
    if (!config) return `Unknown provider: ${source}`;
    const onProfile = resolveEmbeddingProfile(settings);
    if (onProfile?.problem) return onProfile.problem;
    if (config.requiresModel && !getModelFromSettings(settings)) return `${config.name} selected but no model configured`;
    return '';
}

/**
 * VectFox's embedding model in words, for a page that names it: the model and its provider, or the SillyTavern profile
 * it runs on; a provider that takes no model name runs its own default, and one that needs a name says none is set.
 *
 * @param {object} settings - VectFox settings
 * @returns {string} '' when no known provider is set
 */
export function embeddingModelName(settings) {
    const config = getProviderConfig(settings?.embedding_provider);
    if (!config) return '';
    const onProfile = resolveEmbeddingProfile(settings);
    if (onProfile) return `${onProfile.model || "the server's model"} on the SillyTavern profile "${onProfile.profileName}"`;
    const model = getModelFromSettings(settings);
    if (model) return `${model} at ${config.name}`;
    return config.requiresModel ? `${config.name}, with no model set` : `${config.name}'s default model`;
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
 * request, as does a llama.cpp, KoboldCPP or Custom profile below the Similharity floor in manifest.json: it never falls back to
 * the provider's own URL fields, SillyTavern's server URL or the plugin's default.
 *
 * On a manual provider, the URL the provider's own fields hold (`embedding_ollama_url_override` and
 * `embedding_ollama_url`, `embedding_vllm_url_override` and `embedding_vllm_url`) when its own URL is switched on,
 * or else SillyTavern's Text Completion server URL for that type.
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
        default:
            return undefined;
    }
}

/**
 * What an embedding request on a llama.cpp, KoboldCPP or Custom profile names besides the source and model: the
 * profile's server URL, and its key's ID when it stores a key. Empty for every other provider. Every params builder
 * spreads it, so a profile that cannot be used, or one below the Similharity floor in manifest.json, stops before any
 * request.
 * It waits for the Similharity probe first, so the plugin check never reads a probe that has not settled.
 *
 * @param {object} settings - VectFox settings
 * @returns {Promise<object>} apiUrl, and the key field connectionProfileKeyIdField gives
 * @throws {Error} With `code: 'invalid_model_config'`, from resolveProviderApiUrl
 */
export async function embeddingProfileRequestFields(settings) {
    if (!embeddingProfileKind(settings?.embedding_provider)?.sendsKeyId) return {};
    await checkPluginAvailable();
    const apiUrl = resolveProviderApiUrl(settings);
    const profile = findConnectionProfile(String(settings.embedding_connection_profile_id ?? '').trim());
    return { apiUrl, ...connectionProfileKeyIdField(profile) };
}
