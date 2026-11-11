/**
 * What a connection profile's key failure says, the same for every consumer that sends a profile's key by its ID: the
 * chat consumers (features/llm-provider) and embedding on a llama.cpp, KoboldCPP or Custom profile
 * (features/embedding). Connection plan §4: the reply's text names a key problem, and the message tells the user
 * which profile's key to fix in SillyTavern.
 */

const KEY_PROBLEM = /unauthorized|authori[sz]ation|api key|api_key|apikey|authentication|credential/i;

/**
 * Whether a failure's text names a key problem, a rejected or missing key or authorization.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function namesKeyProblem(text) {
    return KEY_PROBLEM.test(String(text ?? ''));
}

/**
 * The key toast's two messages, by whether the profile stores a key.
 *
 * @param {object} facts
 * @param {string} facts.feature - Names the consumer: 'EventBase', 'Embedding', …
 * @param {string} facts.profileName
 * @param {boolean} facts.storesKey - Whether the profile names a stored key
 * @returns {string}
 */
export function connectionProfileKeyMessage({ feature, profileName, storesKey }) {
    return storesKey
        ? `${feature}: the provider rejected the API key for profile "${profileName}", or that key was deleted in SillyTavern. `
            + 'Check the key saved in that profile in SillyTavern.'
        : `${feature}: the provider needs an API key, and profile "${profileName}" stores none, so VectFox sent none. `
            + 'Select the key in SillyTavern and update the profile.';
}
