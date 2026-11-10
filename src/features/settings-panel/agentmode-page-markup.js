/**
 * ============================================================================
 * AGENTMODE PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's AgentMode page on GUI-DNA: the Agent Mode switch, the
 * model its planner runs on, and the time limits it and StoryArc mode share.
 * Every control keeps the id settings-panel.js wires it by, and a row the wiring
 * shows and hides keeps its id too. Pure: builds strings.
 * ============================================================================
 */

import {
    AGENTIC_MAX_TOKENS_DEFAULT,
    AGENTIC_MAX_TOKENS_MAX,
    AGENTIC_MAX_TOKENS_MIN,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,
    AGENTIC_TIMEOUT_MAX_MS,
    AGENTIC_TIMEOUT_MIN_MS,
} from '../../shared/constants.js';
import { controlRow, detail, field, fieldLabel, hint, input } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { clearKeyButton, keyInput } from './api-key-markup.js';
import { inheritedProviderSelect } from './provider-select-markup.js';

const HIDDEN = ' style="display:none;"';

const secondsOf = milliseconds => milliseconds / 1000;

function agentModeCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-robot', title: 'Agent Mode', description: 'An LLM planner writes searches beside the normal one on each reply. Qdrant only.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_agentic_retrieval_enabled', title: 'Use Agent Mode', description: 'Adds up to 5 events the normal search missed. StoryArc mode, when on, runs instead.', isSpan: true })}
            ${field([
                fieldLabel({ text: 'Searches per reply', forId: 'VectFox_agentic_max_queries' }),
                sliderNumber({ id: 'VectFox_agentic_max_queries', min: 1, max: 6, step: 1, title: 'Searches' }),
                hint({ text: 'The most searches the planner may write. Each one is a Qdrant call per collection.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Chat turns read', forId: 'VectFox_agentic_chat_depth', hasHelp: true }),
                sliderNumber({ id: 'VectFox_agentic_chat_depth', min: 1, max: 10, step: 1, title: 'Turns' }),
                hint({ text: 'Recent messages the planner reads. Fewer make its call faster and cheaper.' }),
                detail({ text: 'StoryArc mode\'s router reads up to 2 of them besides your message, with Agent Mode on or off, so keep 3 or more for it.' }),
            ])}
        </div>
    </section>`;
}

function plannerModelCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-microchip', title: 'Planner model', description: 'The LLM that writes the searches. A blank field uses the Event model\'s, on Core.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Provider', forId: 'VectFox_agentic_provider' }),
                inheritedProviderSelect('VectFox_agentic_provider'),
                hint({ text: 'Same as Event model uses the provider set in Core → Event model.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Model', forId: 'VectFox_agentic_model' }),
                input({ id: 'VectFox_agentic_model', placeholder: 'Blank uses the Event model\'s' }),
                hint({ text: 'Blank uses the model set in Core → Event model.' }),
            ])}
            <div id="VectFox_agentic_openrouter_row" class="vfx-grid vfx-span"${HIDDEN}>
                ${field([
                    fieldLabel({ text: 'API key', forId: 'VectFox_agentic_openrouter_apikey' }),
                    controlRow([keyInput({ id: 'VectFox_agentic_openrouter_apikey', placeholder: 'Paste a key to save it' }), clearKeyButton('VectFox_agentic_openrouter_apikey_clear')]),
                    hint({ text: 'One OpenRouter key serves all of VectFox: saving it here saves it on Core too.' }),
                ], { isSpan: true })}
            </div>
            <div id="VectFox_agentic_vllm_row" class="vfx-grid vfx-span"${HIDDEN}>
                ${field([
                    fieldLabel({ text: 'Base URL', forId: 'VectFox_agentic_vllm_url', hasHelp: true }),
                    input({ id: 'VectFox_agentic_vllm_url', placeholder: 'Blank uses the Event model\'s' }),
                    hint({ text: 'Blank uses the Event model\'s URL.' }),
                    detail({ text: 'StoryArc\'s link model uses this URL too when it runs on vLLM.' }),
                ])}
                ${field([
                    fieldLabel({ text: 'API key', forId: 'VectFox_agentic_vllm_apikey' }),
                    controlRow([keyInput({ id: 'VectFox_agentic_vllm_apikey', placeholder: 'Paste a key to save it' }), clearKeyButton('VectFox_agentic_vllm_apikey_clear')]),
                    hint({ text: 'Saving it sets SillyTavern\'s active Custom key, which its own chat may use.' }),
                ])}
            </div>
            ${field([
                fieldLabel({ text: 'Max output tokens', forId: 'VectFox_agentic_max_tokens', hasHelp: true }),
                input({ id: 'VectFox_agentic_max_tokens', type: 'number', min: AGENTIC_MAX_TOKENS_MIN, max: AGENTIC_MAX_TOKENS_MAX, step: 256 }),
                hint({ text: 'Raise it for a model that reasons: its thinking counts against this cap.' }),
                detail({ text: `Default ${AGENTIC_MAX_TOKENS_DEFAULT}, from ${AGENTIC_MAX_TOKENS_MIN} to ${AGENTIC_MAX_TOKENS_MAX}. The planner answers in a short JSON list, but a model that reasons can spend the whole cap thinking, and an empty answer leaves the reply with the normal search. Turn off model thinking, on Core, only asks a model not to reason.` }),
            ])}
        </div>
    </section>`;
}

function timeoutsCard() {
    const range = `from ${secondsOf(AGENTIC_TIMEOUT_MIN_MS)} to ${secondsOf(AGENTIC_TIMEOUT_MAX_MS)} s`;
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-stopwatch', title: 'Timeouts', description: 'Both add to Core → Retrieval timeout. StoryArc mode uses them too.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Planner timeout (ms)', forId: 'VectFox_agentic_timeout', hasHelp: true }),
                input({ id: 'VectFox_agentic_timeout', type: 'number', min: AGENTIC_TIMEOUT_MIN_MS, max: AGENTIC_TIMEOUT_MAX_MS, step: 1000 }),
                hint({ text: 'How long the planner call may run before the reply goes without its searches.' }),
                detail({ text: `Default ${AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS} ms, ${range}. Raise it for a slow model. StoryArc mode's router, thread pick and block cut each get this long.` }),
            ])}
            ${field([
                fieldLabel({ text: 'Search timeout (ms)', forId: 'VectFox_agentic_query_timeout', hasHelp: true }),
                input({ id: 'VectFox_agentic_query_timeout', type: 'number', min: AGENTIC_TIMEOUT_MIN_MS, max: AGENTIC_TIMEOUT_MAX_MS, step: 1000 }),
                hint({ text: 'How long one planned search may run. A slower one is dropped; the rest still count.' }),
                detail({ text: `Default ${AGENTIC_QUERY_TIMEOUT_DEFAULT_MS} ms, ${range}. The searches run at once, so the reply waits on the slowest. StoryArc mode's searches use it too.` }),
            ])}
        </div>
    </section>`;
}

/**
 * The AgentMode page's cards: Agent Mode, Planner model and Timeouts.
 *
 * @returns {string}
 */
export function agentModePageMarkup() {
    return agentModeCard() + plannerModelCard() + timeoutsCard();
}
