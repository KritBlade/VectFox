/**
 * The checks every consumer of a SillyTavern connection profile makes before it reads anything from the profile: one is
 * chosen, SillyTavern's Connection Manager extension is on, and the profile still exists (connection plan §1, §4). The
 * chat consumers (features/llm-provider) and embedding (features/embedding) each add the checks of what they need from
 * the profile, so the three messages read the same everywhere.
 */

/**
 * Why a consumer cannot use its connection profile at all, or '' when it can read the profile.
 *
 * @param {object} facts
 * @param {string} facts.feature - Names the consumer in the message: 'EventBase', 'Embedding', …
 * @param {string} facts.page - The page whose Provider row chooses the profile
 * @param {string} facts.profileId - The stored profile ID
 * @param {boolean} facts.isManagerAvailable - Whether the Connection Manager extension is on
 * @param {object|null} facts.profile - The profile with that ID, null when no profile has it
 * @returns {string}
 */
export function connectionProfileAvailabilityProblem({ feature, page, profileId, isManagerAvailable, profile }) {
    if (!profileId) return `${feature}: no connection profile is chosen. Choose one on the ${page} page.`;
    if (!isManagerAvailable) {
        return `${feature}: SillyTavern's Connection Manager extension is off, so no connection profile can be used. `
            + `Turn it on in SillyTavern's Extensions, or choose another provider on the ${page} page.`;
    }
    if (!profile) return `${feature}: its connection profile was deleted in SillyTavern. Choose another on the ${page} page.`;
    return '';
}
