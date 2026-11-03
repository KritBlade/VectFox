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
    // webllm: { name: 'WebLLM Extension', local: true, requiresModel: true, modelField: 'webllm_model', requiresApiKey: false, requiresUrl: false },

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
 * Resolve the actual model value from settings for the active provider.
 *
 * The settings object uses provider-specific field names — `embedding_openrouter_model`,
 * `embedding_ollama_model`, `embedding_vllm_model`, etc. — not a flat `settings.model`. Code that
 * sends a `model` field to the plugin API (chunks/insert, chunks/list,
 * chunks/query) MUST use this function. Reading `settings.model` directly
 * returns an empty string for every real provider and leads to insert/query
 * model-bucket mismatches (chunks land under model='' while queries look up
 * the real name → 0-result silent failures).
 *
 * The query path in src/features/vector-backend/standard.js + src/features/vector-backend/qdrant.js already routes
 * through this — keep insert/list/import paths in sync by calling it here.
 *
 * @param {object} settings - VectFox settings
 * @param {string} [fallback=''] - Returned when the provider has no model field
 *   or the value is empty/unset.
 * @returns {string}
 */
export function getModelFromSettings(settings, fallback = '') {
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
 * Resolve the embedding base URL for a URL-based local provider.
 *
 * Single source of truth for "alternative endpoint" resolution. The settings UI
 * writes PER-PROVIDER keys (`embedding_ollama_url_override`/`embedding_ollama_url`,
 * `embedding_vllm_url_override`/`embedding_vllm_url`) — these are the canonical
 * values. Earlier code scattered across backends + diagnostics read the legacy
 * unprefixed `use_alt_endpoint`/`alt_endpoint_url` keys, which the UI never
 * writes, so the alt endpoint silently read as OFF and requests fell back to
 * localhost (GitHub issue #6). Route every apiUrl read through here instead.
 *
 * llamacpp/koboldcpp have no per-provider keys (they are currently commented out
 * of EMBEDDING_PROVIDERS); they keep the legacy unprefixed keys so their behavior
 * is unchanged. Add prefixed keys here if they are ever re-enabled.
 *
 * @param {object} settings - VectFox settings
 * @param {string} [source=settings.embedding_provider] - Provider id (defaults to active source)
 * @returns {string|undefined} Base URL, or undefined for providers that take no URL.
 *   May be an empty string when the provider is URL-based but nothing is configured.
 */
export function resolveProviderApiUrl(settings, source = settings?.embedding_provider) {
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
