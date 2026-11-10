/**
 * ============================================================================
 * EVENTBASE PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's EventBase page on GUI-DNA: how the EventBase model turns the chat
 * into events, which stored events retrieval brings back, how they are scored, and the
 * prompt that extracts them. Every control keeps the id settings-panel.js wires it by.
 * Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, input, select, selectOption, textarea } from '../../shared/gui-dna/gui-dna-core.js';
import { buttonWithId, cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

/** A 1-to-10 importance, as the EventBase model rates each event. */
function importanceSlider(id) {
    return sliderNumber({ id, min: 1, max: 10, step: 1, title: 'Importance' });
}

function extractionCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-wand-magic-sparkles', title: 'Extraction', description: 'How the EventBase model turns each window of the chat into events.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Min importance to store', forId: 'VectFox_eventbase_min_importance_store' }),
                importanceSlider('VectFox_eventbase_min_importance_store'),
                hint({ text: 'Events the model rates below this are dropped before they are stored.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Max events per window', forId: 'VectFox_eventbase_max_events_per_window' }),
                sliderNumber({ id: 'VectFox_eventbase_max_events_per_window', min: 1, max: 10, step: 1, title: 'Max events' }),
                hint({ text: 'The most events one window may give. A filler scene may give fewer or none.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Temperature', forId: 'VectFox_eventbase_temperature' }),
                input({ id: 'VectFox_eventbase_temperature', type: 'number', min: 0, max: 2, step: 0.05 }),
                hint({ text: 'Sent only while Send temperature is on (Core → EventBase model).' }),
            ])}
            ${field([
                fieldLabel({ text: 'Max output tokens', forId: 'VectFox_eventbase_max_tokens', hasHelp: true }),
                input({ id: 'VectFox_eventbase_max_tokens', type: 'number', min: 256, max: 32768, step: 64 }),
                hint({ text: 'The reply\'s cap. A thinking model spends it before it writes any events.' }),
                detail({ text: 'Raise it when extraction fails with "used its entire token limit without answering".' }),
            ])}
            ${field([
                fieldLabel({ text: 'Extraction timeout (ms)', forId: 'VectFox_eventbase_timeout_ms' }),
                input({ id: 'VectFox_eventbase_timeout_ms', type: 'number', min: 5000, max: 300000, step: 1000 }),
                hint({ text: 'How long one window\'s extraction call may run. Raise it for a slow model.' }),
            ])}
            ${switchRow({ id: 'VectFox_eventbase_disable_pipeline', title: 'Wait for each batch', description: 'Slower: each batch is stored before the next is extracted. Off is the faster default.', isSpan: true })}
        </div>
    </section>`;
}

function retrievalCard() {
    const formats = [
        selectOption({ value: 'jsonarray', text: 'JSONArray' }),
        selectOption({ value: 'densetext', text: 'DenseText' }),
        selectOption({ value: 'summaryonly', text: 'Summary only' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-filter', title: 'Retrieval', description: 'Which stored events reach the prompt, and how they are written there.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Events per reply', forId: 'VectFox_eventbase_retrieval_top_k' }),
                sliderNumber({ id: 'VectFox_eventbase_retrieval_top_k', min: 1, max: 32, step: 1, title: 'Events' }),
                hint({ text: 'How many events go into the prompt for each reply, after the re-rank.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Min importance to retrieve', forId: 'VectFox_eventbase_retrieval_min_importance' }),
                importanceSlider('VectFox_eventbase_retrieval_min_importance'),
                hint({ text: 'Events the model rated below this are never brought back.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Similarity threshold', forId: 'VectFox_eventbase_score_threshold', hasHelp: true }),
                sliderNumber({ id: 'VectFox_eventbase_score_threshold', min: 0, max: 1, step: 0.05, title: 'Threshold' }),
                hint({ text: 'Events less similar to the query than this are dropped. 0 keeps them all.' }),
                detail({ text: 'Every event search uses it, Agent Mode and StoryArc included. It drops an event on similarity alone, so an important or recent event that matched weakly goes too. 1 keeps only exact matches.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Injection format', forId: 'VectFox_eventbase_injection_format' }),
                select({ id: 'VectFox_eventbase_injection_format', options: formats }),
                hint({ text: 'DenseText writes compact lines, JSONArray every field, Summary only the least.' }),
            ])}
        </div>
    </section>`;
}

function rerankWeightsCard() {
    const weights = [
        { id: 'VectFox_eventbase_rerank_w_cosine', text: 'Cosine', hintMarkup: hint({ text: 'How close the event\'s meaning is to the current turn.' }) },
        { id: 'VectFox_eventbase_rerank_w_importance', text: 'Importance', hintMarkup: hint({ text: 'The importance the model gave the event when it stored it.' }) },
        { id: 'VectFox_eventbase_rerank_w_persist', text: 'Persist', hintMarkup: hint({ text: 'A bonus for events the model expects to matter later.' }) },
        { id: 'VectFox_eventbase_rerank_w_recency', text: 'Recency', hintMarkup: hint({ text: 'Newer events score higher.' }) },
    ];
    const reset = buttonWithId({ id: 'VectFox_eventbase_reset_weights', text: 'Reset to defaults', icon: 'fa-rotate-left' });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-scale-balanced', title: 'Re-rank weights', description: 'How retrieved events are scored. The four are saved adding up to 1.', actions: reset })}
        <div class="vfx-card-body vfx-grid">
            <div id="VectFox_eventbase_cosine_plugin_warning" class="vfx-notice is-warning vfx-span"${HIDDEN}><i class="fa-solid fa-triangle-exclamation"></i><p class="vfx-notice-text">Cosine is off: Standard without the Similharity plugin returns no vector scores, so its share goes to the other three.</p></div>
            ${weights.map(({ id, text, hintMarkup }) => field([
                fieldLabel({ text, forId: id }),
                input({ id, type: 'number', min: 0, max: 1, step: 0.05 }),
                hintMarkup,
            ])).join('')}
        </div>
    </section>`;
}

function extractionPromptCard() {
    const reset = buttonWithId({ id: 'VectFox_eventbase_prompt_reset', text: 'Reset to default', icon: 'fa-rotate-left' });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-file-pen', title: 'Extraction prompt', description: 'The whole prompt sent for each window. Empty sends the built-in one.', actions: reset })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Prompt', forId: 'VectFox_eventbase_custom_prompt', hasHelp: true }),
                textarea({ id: 'VectFox_eventbase_custom_prompt', rows: 12, isCode: true }),
                hint({ text: '{{text}} marks where the chat excerpt goes, {{maxCount}} the event cap.' }),
                detail({ text: 'Until you edit it, the box shows the built-in prompt for the CJK tokenizer on the Core page. Reset to default goes back to it.' }),
            ], { isSpan: true })}
        </div>
    </section>`;
}

/**
 * The EventBase page's cards: Extraction, Retrieval, Re-rank weights and Extraction prompt.
 *
 * @returns {string}
 */
export function eventBasePageMarkup() {
    return extractionCard() + retrievalCard() + rerankWeightsCard() + extractionPromptCard();
}
