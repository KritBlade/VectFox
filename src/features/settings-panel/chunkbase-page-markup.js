/**
 * ============================================================================
 * CHUNKBASE PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's ChunkBase page on GUI-DNA: how content is embedded and
 * stored, the optional Auto-Reformat pass, and which chunks retrieval brings back.
 * Every control keeps the id settings-panel.js wires it by, and a row the wiring
 * shows and hides keeps its id too. Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, input, select, selectOption, textarea } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

function ingestionCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-file-import', title: 'Ingestion', description: 'How content is embedded and stored.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Insert batch size', forId: 'VectFox_insert_batch_size', hasHelp: true }),
                sliderNumber({ id: 'VectFox_insert_batch_size', min: 10, max: 100, step: 10, title: 'Batch size' }),
                hint({ text: 'Chunks per embedding request. Local servers always send one.' }),
                detail({ text: 'It counts only while Group embedding calls is on or an embedding rate limit is set (Core → Embedding). Events come in small batches, so it barely touches them.' }),
            ])}
            ${switchRow({ id: 'VectFox_document_glossary_injection', title: 'Acronym glossary', description: 'Documents only: a chunk that uses a bare acronym gets its full name in front.', isSpan: true })}
        </div>
    </section>`;
}

function autoReformatCard() {
    const providers = [
        selectOption({ value: '', text: 'Same as Event model' }),
        selectOption({ value: 'openrouter', text: 'OpenRouter' }),
        selectOption({ value: 'vllm', text: 'vLLM' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-pen-to-square', title: 'Auto-Reformat', description: 'Optional. Rewrites a document, page or wiki into entries you review before storing.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Provider', forId: 'VectFox_reformat_provider' }),
                select({ id: 'VectFox_reformat_provider', options: providers }),
                hint({ text: 'Same as Event model uses the provider set in Core → Event model.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Model', forId: 'VectFox_reformat_model' }),
                input({ id: 'VectFox_reformat_model', placeholder: 'Blank uses the Event model\'s' }),
                hint({ text: 'Blank uses the model set in Core → Event model.' }),
            ])}
            <div id="VectFox_reformat_vllm_row" class="vfx-field vfx-span"${HIDDEN}>
                ${fieldLabel({ text: 'Base URL', forId: 'VectFox_reformat_vllm_url' })}
                ${input({ id: 'VectFox_reformat_vllm_url', placeholder: 'Blank uses the Event model\'s' })}
                ${hint({ text: 'Blank uses the Event model\'s URL. The key is the one saved there.' })}
            </div>
            ${field([
                fieldLabel({ text: 'Batch size (chars)', forId: 'VectFox_reformat_batch_chars' }),
                sliderNumber({ id: 'VectFox_reformat_batch_chars', min: 2000, max: 12000, step: 500, title: 'Batch size' }),
                hint({ text: 'Source text per LLM call. Lower it if the model cuts its reply short.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Max entry size (chars)', forId: 'VectFox_reformat_max_body_chars' }),
                sliderNumber({ id: 'VectFox_reformat_max_body_chars', min: 500, max: 5000, step: 250, title: 'Max entry size' }),
                hint({ text: 'A longer entry is split into chunks, so one big entity is not one giant chunk.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Name check strictness', forId: 'VectFox_reformat_name_fuzzy_threshold', hasHelp: true }),
                sliderNumber({ id: 'VectFox_reformat_name_fuzzy_threshold', min: 0.5, max: 1, step: 0.05, title: 'Strictness' }),
                hint({ text: 'How closely an entry\'s name must match the source before review flags it.' }),
                detail({ text: 'Higher flags more entries as possibly made up by the model, with some false alarms on close rewordings.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Parallel batches', forId: 'VectFox_reformat_concurrency' }),
                sliderNumber({ id: 'VectFox_reformat_concurrency', min: 1, max: 6, step: 1, title: 'Parallel batches' }),
                hint({ text: 'LLM calls at once when a source needs several batches.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Timeout (ms)', forId: 'VectFox_reformat_timeout_ms' }),
                input({ id: 'VectFox_reformat_timeout_ms', type: 'number', min: 10000, step: 1000 }),
                hint({ text: 'How long one LLM call may run. Raise it for a slow model.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Custom prompt', forId: 'VectFox_reformat_custom_prompt', hasHelp: true }),
                textarea({ id: 'VectFox_reformat_custom_prompt', rows: 6, isCode: true }),
                hint({ text: 'Empty uses the built-in prompt. {{text}} marks where the source text goes.' }),
                detail({ text: 'The reply must be a JSON array of entries with entry_type, name, aliases, affiliation, traits, relationships, keywords and body. {{continuationNote}} marks where a split section lists the entries already taken from it.' }),
            ], { isSpan: true })}
        </div>
    </section>`;
}

function retrievalCard() {
    const budgets = [
        selectOption({ value: 'minimal', text: '30' }),
        selectOption({ value: 'balance', text: '50' }),
        selectOption({ value: 'maximum', text: '70' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-filter', title: 'Retrieval', description: 'Which chunks each query brings back.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Results per collection', forId: 'VectFox_topk' }),
                input({ id: 'VectFox_topk', type: 'number', min: 1, step: 1 }),
                hint({ text: 'The most chunks one collection may give per reply. Filters can leave fewer.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Similarity threshold', forId: 'VectFox_score_threshold' }),
                sliderNumber({ id: 'VectFox_score_threshold', min: 0, max: 1, step: 0.05, title: 'Threshold' }),
                hint({ text: 'Chunks scoring below this are dropped. Events have their own, on the EventBase page.' }),
            ])}
            <div id="VectFox_hybrid_keyword_budget_wrapper" class="vfx-field vfx-span"${HIDDEN}>
                ${fieldLabel({ text: 'Query keyword budget', forId: 'VectFox_hybrid_keyword_level' })}
                ${select({ id: 'VectFox_hybrid_keyword_level', options: budgets })}
                ${hint({ text: 'The most keywords taken from your query for keyword scoring, CJK words first.' })}
            </div>
        </div>
    </section>`;
}

/**
 * The ChunkBase page's cards: Ingestion, Auto-Reformat and Retrieval.
 *
 * @returns {string}
 */
export function chunkBasePageMarkup() {
    return ingestionCard() + autoReformatCard() + retrievalCard();
}
