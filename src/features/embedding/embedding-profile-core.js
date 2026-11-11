/**
 * The pure rules of embedding on a SillyTavern connection profile (connection plan §3): which embedding providers a
 * profile can carry, and what stops a profile from being used. No host imports: resolveEmbeddingProfile in
 * providers.js gathers the facts from the profile and acts on the answer.
 */

import { connectionProfileAvailabilityProblem } from '../../shared/connection-profile-availability.js';

/**
 * The embedding providers a profile can carry, by the provider SillyTavern maps its API to, each with whether its
 * profile must name the embedding model.
 */
export const EMBEDDING_PROFILE_PROVIDERS = Object.freeze({
    ollama: Object.freeze({ name: 'Ollama', requiresModel: true }),
});

/** The profile types embedding runs on, for a message. */
const PROFILE_TYPE_NAMES = new Intl.ListFormat('en', { type: 'disjunction' })
    .format(Object.values(EMBEDDING_PROFILE_PROVIDERS).map(provider => provider.name));

/**
 * What stops embedding on its profile, or '' when nothing does. Each reason names the profile and where to fix it.
 *
 * @param {object} facts
 * @param {string} facts.profileId - The stored embedding profile ID
 * @param {boolean} facts.isManagerAvailable - Whether the Connection Manager extension is on
 * @param {object|null} facts.profile - The profile with that ID, null when no profile has it
 * @param {string|null} facts.profileProvider - The embedding provider the profile's API maps to
 * @param {string} facts.url - The server URL the profile names
 * @param {string} facts.model - The model the profile names
 * @returns {string}
 */
export function embeddingProfileProblem({ profileId, isManagerAvailable, profile, profileProvider, url, model }) {
    const unavailable = connectionProfileAvailabilityProblem({ feature: 'Embedding', page: 'Core', profileId, isManagerAvailable, profile });
    if (unavailable) return unavailable;
    const name = profile.name || '(unnamed)';
    const kind = Object.hasOwn(EMBEDDING_PROFILE_PROVIDERS, profileProvider) ? EMBEDDING_PROFILE_PROVIDERS[profileProvider] : null;
    if (!kind) {
        return `Embedding: profile "${name}" (API "${profile.api ?? 'none'}") cannot embed: embedding runs on a profile of type `
            + `${PROFILE_TYPE_NAMES}. Choose one on the Core page.`;
    }
    if (!url) return `Embedding: profile "${name}" names no server URL. Set one in that profile in SillyTavern.`;
    if (kind.requiresModel && !model) {
        return `Embedding: profile "${name}" names no model. Choose an embedding model in that profile in SillyTavern.`;
    }
    return '';
}
