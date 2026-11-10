/**
 * ============================================================================
 * INHERITED PROVIDER SELECT, STATIC MARKUP
 * ============================================================================
 * The Provider select of an LLM consumer that can run on the EventBase model's
 * connection: Auto-Reformat (ChunkBase page) and Agent Mode (AgentMode page).
 * Pure: builds strings.
 * ============================================================================
 */

import { select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';

/**
 * A Provider select whose first option, Same as EventBase model (value ''), runs on the EventBase model's provider and
 * Base URL (llm-provider's resolveInheritedConnection).
 *
 * @param {string} id - The id settings-panel.js wires the select by
 * @returns {string}
 */
export function inheritedProviderSelect(id) {
    return select({
        id,
        options: [
            selectOption({ value: '', text: 'Same as EventBase model' }),
            selectOption({ value: 'openrouter', text: 'OpenRouter' }),
            selectOption({ value: 'vllm', text: 'vLLM' }),
        ],
    });
}
