/**
 * The pure rules of embedding on a SillyTavern connection profile (connection plan §3): which embedding providers a
 * profile can carry, and what stops a profile from being used. No host imports: resolveEmbeddingProfile in
 * providers.js gathers the facts from the profile and the Similharity plugin, and acts on the answer.
 */

import { connectionProfileAvailabilityProblem } from '../../shared/connection-profile-availability.js';

/**
 * The embedding providers a profile can carry, by the provider SillyTavern maps its API to:
 *   - requiresModel: the profile must name the embedding model.
 *   - hasManualFields: the provider also runs without a profile, on fields of its own, as Ollama does.
 *   - sendsKeyId: a request names the profile's key by its ID, which only Similharity 3.4.0 or later reads, so the
 *     provider needs that plugin. SillyTavern's own embedding for these sends its active key instead.
 */
export const EMBEDDING_PROFILE_PROVIDERS = Object.freeze({
    ollama: Object.freeze({ name: 'Ollama', requiresModel: true, hasManualFields: true, sendsKeyId: false }),
    llamacpp: Object.freeze({ name: 'llama.cpp', requiresModel: false, hasManualFields: false, sendsKeyId: true }),
    koboldcpp: Object.freeze({ name: 'KoboldCPP', requiresModel: false, hasManualFields: false, sendsKeyId: true }),
    custom: Object.freeze({ name: 'Custom', requiresModel: true, hasManualFields: false, sendsKeyId: true }),
});

/**
 * Throw before a request would reach SillyTavern's own embedding routes (/api/vector/insert, query, query-multi) on a
 * profile that sends its key ID. Those routes take no key ID: on llama.cpp SillyTavern sends its active key to the URL
 * it is given, and it has no Custom source (connection plan §3, §10). Every other provider keeps those routes, which
 * let VectFox run without Similharity.
 *
 * @param {string} provider - The embedding provider
 * @param {string} instead - What the user does instead, the message's last sentence
 * @throws {Error} With `code: 'invalid_model_config'`, for a provider that sends its key ID
 */
export function refuseSillyTavernEmbeddingRoute(provider, instead) {
    const kind = embeddingProfileKind(provider);
    if (!kind?.sendsKeyId) return;
    const message = `Embedding: a ${kind.name} profile embeds only through the Similharity plugin, which sends the profile's key by its ID. ${instead}`;
    throw Object.assign(new Error(message), { code: 'invalid_model_config' });
}

/** The profile types embedding runs on, for a message. */
const PROFILE_TYPE_NAMES = new Intl.ListFormat('en', { type: 'disjunction' })
    .format(Object.values(EMBEDDING_PROFILE_PROVIDERS).map(provider => provider.name));

/**
 * What EMBEDDING_PROFILE_PROVIDERS says of a provider, or null for one no profile carries.
 *
 * @param {string} provider
 * @returns {{name: string, requiresModel: boolean, hasManualFields: boolean, sendsKeyId: boolean}|null}
 */
export function embeddingProfileKind(provider) {
    return Object.hasOwn(EMBEDDING_PROFILE_PROVIDERS, provider) ? EMBEDDING_PROFILE_PROVIDERS[provider] : null;
}

/** Why a provider that needs Similharity cannot run on the plugin SillyTavern has, or '' when it can. */
function pluginProblem(name, kind, plugin) {
    if (plugin.isCurrent) return '';
    const needs = `Embedding: profile "${name}" is a ${kind.name} profile, which embeds only through the Similharity plugin `
        + `${plugin.requiredVersion} or later`;
    if (!plugin.isFound) return `${needs}, and SillyTavern has none. Install Similharity as the VectFox README says.`;
    const found = plugin.version ? `has Similharity ${plugin.version}` : 'has a Similharity that reports no version';
    return `${needs}, and SillyTavern ${found}. ${plugin.updateInstructions}`;
}

/**
 * What stops embedding on its profile, or '' when nothing does. Each reason names the profile and where to fix it.
 *
 * @param {object} facts
 * @param {string} facts.provider - The embedding provider chosen with the profile
 * @param {string} facts.profileId - The stored embedding profile ID
 * @param {boolean} facts.isManagerAvailable - Whether the Connection Manager extension is on
 * @param {object|null} facts.profile - The profile with that ID, null when no profile has it
 * @param {string|null} facts.profileProvider - The embedding provider the profile's API maps to
 * @param {string} facts.url - The server URL the profile names
 * @param {string} facts.model - The model the profile names
 * @param {{isFound: boolean, version: string|null, isCurrent: boolean, requiredVersion: string, updateInstructions: string}} facts.plugin
 *   The Similharity plugin SillyTavern has, and the version a provider that sends a key ID needs
 * @returns {string}
 */
export function embeddingProfileProblem({ provider, profileId, isManagerAvailable, profile, profileProvider, url, model, plugin }) {
    const unavailable = connectionProfileAvailabilityProblem({ feature: 'Embedding', page: 'Core', profileId, isManagerAvailable, profile });
    if (unavailable) return unavailable;
    const name = profile.name || '(unnamed)';
    const kind = embeddingProfileKind(profileProvider);
    if (!kind) {
        return `Embedding: profile "${name}" (API "${profile.api ?? 'none'}") cannot embed: embedding runs on a profile of type `
            + `${PROFILE_TYPE_NAMES}. Choose one on the Core page.`;
    }
    if (profileProvider !== provider) {
        return `Embedding: profile "${name}" is now a ${kind.name} profile, and embedding was set up on it as `
            + `${embeddingProfileKind(provider)?.name ?? provider}. Choose the profile again on the Core page.`;
    }
    if (kind.sendsKeyId) {
        const missingPlugin = pluginProblem(name, kind, plugin);
        if (missingPlugin) return missingPlugin;
    }
    if (!url) return `Embedding: profile "${name}" names no server URL. Set one in that profile in SillyTavern.`;
    if (kind.requiresModel && !model) {
        return `Embedding: profile "${name}" names no model. Choose an embedding model in that profile in SillyTavern.`;
    }
    return '';
}
