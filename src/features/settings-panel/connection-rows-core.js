/**
 * ============================================================================
 * CONNECTION ROWS, PURE RULES
 * ============================================================================
 * What a Profile dropdown offers and what a profile readout says (connection plan
 * §1, §3), from facts connection-rows.js gathers. Pure: no host imports.
 * ============================================================================
 */

const PLACEHOLDER_TEXT = 'Choose a profile';
const DELETED_PROFILE_TEXT = '(deleted profile)';
const MANAGER_OFF_TEXT = 'Turn on Connection Manager in SillyTavern\'s extensions to choose a profile';
const NO_KEY_TEXT = 'No key stored: none is sent';

/**
 * A Profile dropdown's options. "Choose a profile" comes first and cannot be picked, so it shows only while none is
 * chosen; then the profiles offered, in SillyTavern's order. A chosen profile that is no longer offered stays selected
 * and cannot be picked again, under its name, or as "(deleted profile)" when no profile has its ID: never a silent
 * blank. With the Connection Manager off, one option says so.
 *
 * @param {object} facts
 * @param {Array<{id: string, name: string, isOffered: boolean}>} facts.profiles - Every profile, and whether this dropdown offers it
 * @param {string} facts.selectedId - The stored profile ID, '' for none
 * @param {boolean} facts.isManagerAvailable
 * @returns {Array<{value: string, text?: string, name?: string, isSelected: boolean, isDisabled: boolean}>}
 */
export function profileSelectOptions({ profiles, selectedId, isManagerAvailable }) {
    if (!isManagerAvailable) return [{ value: selectedId, text: MANAGER_OFF_TEXT, isSelected: true, isDisabled: true }];
    const chosen = selectedId ? profiles.find(profile => profile.id === selectedId) : null;
    const options = profiles
        .filter(profile => profile.isOffered || profile === chosen)
        .map(profile => ({ value: profile.id, name: profile.name || '(unnamed)', isSelected: profile === chosen, isDisabled: !profile.isOffered }));
    const deleted = selectedId && !chosen ? [{ value: selectedId, text: DELETED_PROFILE_TEXT, isSelected: true, isDisabled: true }] : [];
    return [{ value: '', text: PLACEHOLDER_TEXT, isSelected: !selectedId, isDisabled: true }, ...deleted, ...options];
}

/**
 * The readout of a chat consumer's profile: why it cannot be used, or its SillyTavern API, its model and, when it
 * stores no key, that none is sent. `inheritedFrom` names the EventBase model's profile on the first line, for Agent
 * Mode and Auto-Reformat on Same as EventBase model.
 *
 * @param {{problem: string, name?: string, api?: string, model?: string, storesKey?: boolean}} description - From describeChatConnectionProfile
 * @param {{isInherited?: boolean}} [options]
 * @returns {Array<object>} resultList lines
 */
export function chatProfileReadoutLines(description, { isInherited = false } = {}) {
    if (description.problem) return [{ name: description.problem, status: 'warning' }];
    return [
        ...(isInherited ? [{ text: 'EventBase model\'s profile', name: description.name, icon: 'fa-link' }] : []),
        { text: 'API', name: description.api },
        description.model ? { text: 'Model', name: description.model } : { text: 'Model: none named, the server answers with its own' },
        ...(description.storesKey ? [] : [{ text: NO_KEY_TEXT }]),
    ];
}

/**
 * The readout of embedding's profile: why it cannot be used, or its URL, its model, what its server needs, and, for a
 * type that sends a key by ID, that none is sent when it stores none. With no profile of the four types, how to make
 * one.
 *
 * @param {object} facts
 * @param {{url: string, model: string, storesKey: boolean, problem: string}|null} facts.resolved - From resolveEmbeddingProfile
 * @param {{serverNeeds: string, sendsKeyId: boolean}|null} facts.kind - The stored provider's profile type
 * @param {boolean} facts.hasEmbeddingProfiles - Whether SillyTavern has a profile of the four types
 * @returns {Array<object>} resultList lines
 */
export function embeddingProfileReadoutLines({ resolved, kind, hasEmbeddingProfiles }) {
    const howToMakeOne = hasEmbeddingProfiles ? [] : [{ text: 'SillyTavern has no Ollama, llama.cpp, KoboldCPP or Custom profile yet. Make one under Connection Profiles in SillyTavern.', status: 'warning' }];
    if (!resolved || !kind) return howToMakeOne;
    if (resolved.problem) return [{ name: resolved.problem, status: 'warning' }];
    return [
        { text: 'URL', name: resolved.url },
        resolved.model ? { text: 'Model', name: resolved.model } : { text: 'Model: none named, the server embeds with its own' },
        { text: 'The server needs', name: kind.serverNeeds },
        ...(kind.sendsKeyId && !resolved.storesKey ? [{ text: NO_KEY_TEXT }] : []),
    ];
}
