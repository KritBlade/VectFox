/**
 * ============================================================================
 * INHERITED PROVIDER SELECT, STATIC MARKUP
 * ============================================================================
 * The Provider select of an LLM consumer that can run on the EventBase model's
 * connection, Auto-Reformat (ChunkBase page) and Agent Mode (AgentMode page), and the
 * hint under it, which the wiring hides while the consumer runs on a profile.
 * Pure: builds strings.
 * ============================================================================
 */

import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { hint, select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';

/**
 * A Provider select whose first option, Same as EventBase model (value ''), runs on the EventBase model's provider and
 * Base URL, or its profile (llm-provider's resolveInheritedConnection); the second runs on a SillyTavern profile.
 *
 * @param {string} id - The id settings-panel.js wires the select by
 * @returns {string}
 */
export function inheritedProviderSelect(id) {
    return select({
        id,
        options: [
            selectOption({ value: '', text: 'Same as EventBase model' }),
            selectOption({ value: CONNECTION_PROFILE_PROVIDER, text: 'SillyTavern profile' }),
            selectOption({ value: 'openrouter', text: 'OpenRouter' }),
            selectOption({ value: 'vllm', text: 'vLLM' }),
        ],
    });
}

/**
 * The hint under an inherited Provider select, `${id}_hint`. It says a typed Model applies, so the wiring hides it while
 * the consumer runs on a profile, which supplies the model.
 *
 * @param {string} id - The select's id
 * @returns {string}
 */
export function inheritedProviderHint(id) {
    return `<div id="${id}_hint">${hint({ text: 'Same as EventBase model uses its provider, URL and key. A typed Model still applies.' })}</div>`;
}
