/**
 * ============================================================================
 * CORE PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's Core page on GUI-DNA: the vector backend, embedding, the model
 * that writes events, retrieval, injection, keyword scoring and keywords. Every control
 * keeps the id settings-panel.js wires it by, and a row the wiring shows and hides keeps
 * its id too. Pure: builds strings.
 * ============================================================================
 */

import { controlRow, detail, field, fieldLabel, grid, hint, input, notice, select, selectOption, textarea } from '../../shared/gui-dna/gui-dna-core.js';
import { buttonWithId, cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { clearKeyButton, keyInput } from './api-key-markup.js';

const SIMILHARITY_INSTALL_URL = 'https://github.com/KritBlade/VectFox/tree/Similharity-Plugin#step-2-install-plugin-via-git-recommended';

const HIDDEN = ' style="display:none;"';

/** The button that lists a provider's models into the select under it. */
function chooseModelButton(id) {
    return buttonWithId({ id, text: 'Choose', icon: 'fa-list' });
}

/** A field of two short numbers side by side at every width, with its hint. */
function numberPair({ caption, numbers, hintMarkup }) {
    const fields = numbers.map(({ id, text, min, placeholder }) => field([
        fieldLabel({ text, forId: id }),
        input({ id, type: 'number', min, placeholder }),
    ]));
    return field([fieldLabel({ text: caption }), grid(fields, { isPair: true }), hintMarkup], { isSpan: true });
}

function vectorBackendCard() {
    const installLink = `<a class="vfx-btn" href="${SIMILHARITY_INSTALL_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-download"></i><span>Install</span></a>`;
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-database', title: 'Vector backend', description: 'Where vectors are stored and searched.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Backend', forId: 'VectFox_vector_backend', hasHelp: true }),
                select({ id: 'VectFox_vector_backend', options: [selectOption({ value: 'standard', text: 'Standard' }), selectOption({ value: 'qdrant', text: 'Qdrant' })] }),
                hint({ text: 'Standard needs nothing more. Qdrant is a vector database and needs the Similharity plugin.' }),
                detail({ text: 'Standard keeps vectors in SillyTavern\'s own files and suits fewer than 100,000 of them. Qdrant runs as a server, local or in its cloud, and searches by vector and keyword at once.' }),
            ], { isSpan: true })}
            <div id="VectFox_qdrant_plugin_notice" class="vfx-notice is-warning vfx-span"${HIDDEN}><i class="fa-solid fa-triangle-exclamation"></i><p class="vfx-notice-text">The Similharity plugin is not installed, so Qdrant cannot be picked.</p>${installLink}</div>
            <div id="VectFox_qdrant_plugin_error" class="vfx-notice is-danger vfx-span"${HIDDEN}><i class="fa-solid fa-circle-exclamation"></i><p class="vfx-notice-text">Qdrant needs the Similharity plugin, so VectFox went back to Standard.</p></div>
            <div id="VectFox_qdrant_settings" class="vfx-grid vfx-span"${HIDDEN}>
                ${switchRow({ id: 'VectFox_qdrant_use_cloud', title: 'Use Qdrant Cloud', description: 'Off: a Qdrant server you run yourself, at the host and port below.', isSpan: true })}
                <div id="VectFox_qdrant_local_settings" class="vfx-grid-pair vfx-span">
                    ${field([fieldLabel({ text: 'Host', forId: 'VectFox_qdrant_host' }), input({ id: 'VectFox_qdrant_host', placeholder: '127.0.0.1' })])}
                    ${field([fieldLabel({ text: 'Port', forId: 'VectFox_qdrant_port' }), input({ id: 'VectFox_qdrant_port', type: 'number', placeholder: '6333' })])}
                </div>
                <div id="VectFox_qdrant_cloud_settings" class="vfx-grid vfx-span"${HIDDEN}>
                    ${field([fieldLabel({ text: 'Cluster URL', forId: 'VectFox_qdrant_url' }), input({ id: 'VectFox_qdrant_url', placeholder: 'https://xxx.cloud.qdrant.io' }), hint({ text: 'Your cluster\'s URL, from the Qdrant Cloud console.' })])}
                    ${field([fieldLabel({ text: 'API key', forId: 'VectFox_qdrant_api_key' }), keyInput({ id: 'VectFox_qdrant_api_key', placeholder: 'Your Qdrant Cloud API key' }), hint({ text: 'Kept in SillyTavern\'s secret store, where Similharity reads it on the server.' })])}
                </div>
                ${switchRow({ id: 'VectFox_qdrant_multitenancy', title: 'One shared collection', description: 'Every chat in one collection, kept apart by filters. Off: one per chat, card or lorebook.', isSpan: true })}
            </div>
        </div>
    </section>`;
}

function embeddingCard() {
    const providers = [
        selectOption({ value: 'transformers', text: 'Transformers (local)' }),
        selectOption({ value: 'ollama', text: 'Ollama' }),
        selectOption({ value: 'openrouter', text: 'OpenRouter' }),
        selectOption({ value: 'vllm', text: 'vLLM' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-microchip', title: 'Embedding', description: 'The model that turns text into vectors, and how its calls go out.' })}
        <div class="vfx-card-body vfx-grid">
            <div class="vfx-span">${notice({ status: 'warning', text: 'Changing the provider or model after vectorizing breaks retrieval. Vectorize again from scratch.' })}</div>
            ${field([
                fieldLabel({ text: 'Provider', forId: 'VectFox_source' }),
                select({ id: 'VectFox_source', options: providers }),
                hint({ text: 'Transformers runs inside SillyTavern. The others need a server or a key.' }),
            ], { isSpan: true })}
            <div id="VectFox_provider_settings" class="vfx-grid vfx-span">
                <div class="vfx-grid vfx-span" data-provider="ollama"${HIDDEN}>
                    ${switchRow({ id: 'VectFox_ollama_use_alt_endpoint', title: 'Own Ollama URL', description: 'Off: the Ollama URL in SillyTavern\'s Text Completion settings.', isSpan: true })}
                    <div id="VectFox_ollama_alt_endpoint_row" class="vfx-field"${HIDDEN}>
                        ${fieldLabel({ text: 'Ollama URL', forId: 'VectFox_ollama_alt_endpoint_url' })}
                        ${input({ id: 'VectFox_ollama_alt_endpoint_url', placeholder: 'http://127.0.0.1:11434' })}
                    </div>
                    ${field([fieldLabel({ text: 'Model', forId: 'VectFox_ollama_model' }), input({ id: 'VectFox_ollama_model', placeholder: 'mxbai-embed-large' }), hint({ text: 'The embedding model\'s name, as Ollama lists it.' })])}
                    ${switchRow({ id: 'VectFox_ollama_keep', title: 'Keep model in memory', description: 'Ollama keeps the model loaded after each call, so the next one starts sooner.', isSpan: true })}
                </div>
                <div class="vfx-grid vfx-span" data-provider="vllm"${HIDDEN}>
                    ${switchRow({ id: 'VectFox_vllm_use_alt_endpoint', title: 'Own vLLM URL', description: 'Off: the vLLM URL in SillyTavern\'s Text Completion settings.', isSpan: true })}
                    <div id="VectFox_vllm_alt_endpoint_row" class="vfx-field"${HIDDEN}>
                        ${fieldLabel({ text: 'vLLM URL', forId: 'VectFox_vllm_alt_endpoint_url' })}
                        ${input({ id: 'VectFox_vllm_alt_endpoint_url', placeholder: 'http://127.0.0.1:8000' })}
                    </div>
                    ${field([fieldLabel({ text: 'Model', forId: 'VectFox_vllm_model' }), input({ id: 'VectFox_vllm_model', placeholder: 'Model name' }), hint({ text: 'The embedding model\'s name on your vLLM server.' })])}
                    ${field([
                        fieldLabel({ text: 'API key', forId: 'VectFox_vllm_api_key', hasHelp: true }),
                        controlRow([keyInput({ id: 'VectFox_vllm_api_key', placeholder: 'Blank for a server that needs none' }), clearKeyButton('VectFox_vllm_api_key_clear')]),
                        hint({ text: 'Optional. Saving it also sets SillyTavern\'s active Custom key.' }),
                        detail({ text: 'SillyTavern keeps one active key per kind, and a manual vLLM call sends whichever is active. Applying a connection profile in SillyTavern can change it.' }),
                    ], { isSpan: true })}
                </div>
                <div class="vfx-grid vfx-span" data-provider="openrouter"${HIDDEN}>
                    ${field([
                        fieldLabel({ text: 'Model', forId: 'VectFox_openrouter_model' }),
                        controlRow([input({ id: 'VectFox_openrouter_model', placeholder: 'openai/text-embedding-3-large' }), chooseModelButton('VectFox_openrouter_model_choose')]),
                        `<select id="VectFox_openrouter_model_list" class="vfx-select" title="OpenRouter models"${HIDDEN}></select>`,
                        hint({ text: 'An embedding model\'s ID. Choose lists OpenRouter\'s embedding models.' }),
                    ], { isSpan: true })}
                    ${field([
                        fieldLabel({ text: 'API key', forId: 'VectFox_openrouter_apikey' }),
                        controlRow([keyInput({ id: 'VectFox_openrouter_apikey', placeholder: 'Paste a key to save it' }), clearKeyButton('VectFox_openrouter_apikey_clear')]),
                        hint({ text: 'SillyTavern\'s active OpenRouter key, which its own chat uses too.' }),
                    ], { isSpan: true })}
                </div>
            </div>
            ${numberPair({
                caption: 'Rate limit',
                numbers: [
                    { id: 'VectFox_rate_limit_calls', text: 'Max calls', min: 0, placeholder: '5' },
                    { id: 'VectFox_rate_limit_interval', text: 'Per seconds', min: 1, placeholder: '60' },
                ],
                hintMarkup: hint({ text: 'Most embedding calls per interval. 0: no limit. Local providers are never limited.' }),
            })}
            ${switchRow({ id: 'VectFox_vector_group_embedding_call', title: 'Group embedding calls', description: 'One request per batch, cheaper. Off: one per text, so a stuck text stalls only itself.' })}
            ${switchRow({ id: 'VectFox_vector_hedge_enabled', title: 'Hedge slow calls', description: 'A call silent for 15 s is sent again, and the first answer wins. OpenRouter and vLLM only.' })}
        </div>
    </section>`;
}

function eventModelCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-file-lines', title: 'EventBase model', description: 'The LLM that writes EventBase events, which Agent Mode and Auto-Reformat can inherit.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Provider', forId: 'VectFox_summarize_provider' }),
                select({ id: 'VectFox_summarize_provider', options: [selectOption({ value: 'openrouter', text: 'OpenRouter' }), selectOption({ value: 'vllm', text: 'vLLM' })] }),
            ], { isSpan: true })}
            <div id="VectFox_summarize_settings" class="vfx-grid vfx-span"${HIDDEN}>
                <div id="VectFox_summarize_openrouter_row" class="vfx-grid vfx-span"${HIDDEN}>
                    ${field([
                        fieldLabel({ text: 'API key', forId: 'VectFox_summarize_openrouter_apikey' }),
                        controlRow([keyInput({ id: 'VectFox_summarize_openrouter_apikey', placeholder: 'Paste a key to save it' }), clearKeyButton('VectFox_summarize_openrouter_apikey_clear')]),
                        hint({ text: 'SillyTavern\'s active OpenRouter key, shared with embedding and its own chat.' }),
                    ], { isSpan: true })}
                </div>
                <div id="VectFox_summarize_vllm_url_row" class="vfx-grid vfx-span"${HIDDEN}>
                    ${field([fieldLabel({ text: 'Base URL', forId: 'VectFox_summarize_vllm_url' }), input({ id: 'VectFox_summarize_vllm_url', placeholder: 'http://127.0.0.1:8000' }), hint({ text: 'Your OpenAI-compatible server\'s base URL.' })])}
                    ${field([
                        fieldLabel({ text: 'API key', forId: 'VectFox_summarize_vllm_apikey' }),
                        controlRow([keyInput({ id: 'VectFox_summarize_vllm_apikey', placeholder: 'Paste a key to save it' }), clearKeyButton('VectFox_summarize_vllm_apikey_clear')]),
                        hint({ text: 'Saving it sets SillyTavern\'s active Custom key, which its own chat may use.' }),
                    ])}
                </div>
                ${field([
                    fieldLabel({ text: 'Model', forId: 'VectFox_summarize_model' }),
                    controlRow([input({ id: 'VectFox_summarize_model', placeholder: 'google/gemini-flash-1.5-8b' }), chooseModelButton('VectFox_summarize_model_choose')]),
                    `<select id="VectFox_summarize_model_list" class="vfx-select" title="Provider models"${HIDDEN}></select>`,
                    hint({ text: 'Required. Choose lists the provider\'s models.' }),
                ], { isSpan: true })}
            </div>
            ${numberPair({
                caption: 'Rate limit',
                numbers: [
                    { id: 'VectFox_generation_rate_limit_calls', text: 'Max calls', min: 0, placeholder: '0' },
                    { id: 'VectFox_generation_rate_limit_interval', text: 'Per seconds', min: 1, placeholder: '60' },
                ],
                hintMarkup: hint({ text: 'Most EventBase model and Agent Mode calls per interval. 0: no limit.' }),
            })}
            ${switchRow({ id: 'VectFox_should_send_temperature', title: 'Send temperature', description: 'Turn off for a model that answers "Unsupported value: \'temperature\'".' })}
            ${switchRow({ id: 'VectFox_should_use_max_completion_tokens', title: 'Use max_completion_tokens', description: 'Turn on for a model that says to use max_completion_tokens.' })}
            ${switchRow({ id: 'VectFox_should_disable_thinking', title: 'Turn off model thinking', description: 'Reasoning effort "none"; off: "minimal". Flip it if every call says Bad Request.', isSpan: true })}
        </div>
    </section>`;
}

function retrievalCard({ retrievalTimeout }) {
    const { minMs, maxMs, defaultMs } = retrievalTimeout;
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-magnifying-glass', title: 'Retrieval', description: 'What each turn searches with, and which events it keeps.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([fieldLabel({ text: 'Query depth', forId: 'VectFox_query_depth' }), sliderNumber({ id: 'VectFox_query_depth', min: 1, max: 20, step: 1, title: 'Query depth' }), hint({ text: 'How many recent messages make up the search text.' })])}
            ${field([fieldLabel({ text: 'Start after', forId: 'VectFox_min_chat_length' }), input({ id: 'VectFox_min_chat_length', type: 'number', min: 0, max: 100, step: 1, placeholder: '0' }), hint({ text: 'Messages a chat needs before memory is injected. 0: from the first.' })])}
            ${field([
                fieldLabel({ text: 'Skip visible events', forId: 'VectFox_deduplication_depth', hasHelp: true }),
                input({ id: 'VectFox_deduplication_depth', type: 'number', min: 0, max: 500, step: 10 }),
                hint({ text: 'Drops events from the last N messages, which the AI still reads. 0: off.' }),
                detail({ text: 'Most models read only the last 3 to 6 messages in full, so a large value drops events the AI cannot see. 0, the default, is the one to keep. Dedup window gap is separate: it merges near-duplicate events.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Dedup window gap', forId: 'VectFox_eventbase_dedup_window_gap', hasHelp: true }),
                input({ id: 'VectFox_eventbase_dedup_window_gap', type: 'number', min: 0, max: 200, step: 1 }),
                hint({ text: 'EventBase: alike events closer than this many messages count as one. 0: off.' }),
                detail({ text: 'Alike means the same type and the same cast. 1 merges only duplicates from one window, and 10, the default, merges alike events within 9 messages of each other.' }),
            ])}
            ${field([fieldLabel({ text: 'Anchor boost', forId: 'VectFox_eventbase_anchor_boost' }), sliderNumber({ id: 'VectFox_eventbase_anchor_boost', min: 0, max: 0.5, step: 0.05, title: 'Anchor boost' }), hint({ text: 'EventBase: score added to an event whose keyword is in your last message.' })])}
            ${field([
                fieldLabel({ text: 'Retrieval timeout (ms)', forId: 'VectFox_retrieval_timeout_ms', hasHelp: true }),
                input({ id: 'VectFox_retrieval_timeout_ms', type: 'number', min: minMs, max: maxMs, step: 1000 }),
                hint({ text: 'How long a turn waits for memory before it sends without it.' }),
                detail({ text: `Default ${defaultMs} ms, from ${minMs / 1000} to ${maxMs / 1000} s. Raise it for a provider that is slow but works; a hung one then stalls each turn that much longer. Agent Mode's own timeouts come on top.` }),
            ])}
            <div id="VectFox_eventbase_native_rerank_wrapper" class="vfx-span">
                ${switchRow({ id: 'VectFox_eventbase_native_rerank', title: 'Re-rank in Qdrant', description: 'Qdrant weighs importance, persistence and recency in its own query. Needs Qdrant 1.13+.' })}
            </div>
            ${switchRow({ id: 'VectFox_retrieval_popup_on_start', title: 'Toast when a search starts', description: 'A toast each time a turn starts searching memory.' })}
            ${switchRow({ id: 'VectFox_retrieval_popup_on_result', title: 'Toast with the result count', description: 'A toast saying how much memory a turn found.' })}
        </div>
    </section>`;
}

function injectionCard() {
    const positions = [
        selectOption({ value: '2', text: 'Before main prompt' }),
        selectOption({ value: '0', text: 'After main prompt' }),
        selectOption({ value: '1', text: 'In chat, at a depth' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-arrow-right-to-bracket', title: 'Injection', description: 'Where VectFox\'s blocks go in the prompt.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Position', forId: 'VectFox_injection_position', hasHelp: true }),
                select({ id: 'VectFox_injection_position', options: positions }),
                hint({ text: 'In chat keeps the prompt above the chat cacheable. The other two do not.' }),
                detail({ text: 'Every VectFox block goes here: memory, summarizer and lorebook entries, except chunks whose collection or chunk sets its own. Their text changes each turn, so near the top of the prompt they stop the provider\'s prompt cache from reusing anything after them.' }),
            ])}
            <div id="VectFox_injection_depth_row" class="vfx-field"${HIDDEN}>
                ${fieldLabel({ text: 'Depth', forId: 'VectFox_injection_depth' })}
                ${input({ id: 'VectFox_injection_depth', type: 'number', min: 0, max: 50, step: 1 })}
                ${hint({ text: 'How many messages from the end of the chat the blocks go before.' })}
            </div>
        </div>
    </section>`;
}

function keywordScoringCard() {
    const methods = [
        selectOption({ value: 'bm25', text: 'BM25: re-rank the vector results' }),
        selectOption({ value: 'hybrid', text: 'Hybrid: fuse vector and BM25 scores' }),
    ];
    const fusionMethods = [
        selectOption({ value: 'rrf', text: 'RRF: by rank' }),
        selectOption({ value: 'weighted', text: 'Weighted: by score' }),
    ];
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-bolt', title: 'Keyword scoring', description: 'How keyword matches add to the vector search.' })}
        <div class="vfx-card-body vfx-grid">
            <div id="VectFox_keyword_method_section" class="vfx-grid vfx-span">
                ${field([
                    fieldLabel({ text: 'Method', forId: 'VectFox_keyword_scoring_method', hasHelp: true }),
                    select({ id: 'VectFox_keyword_scoring_method', options: methods }),
                    hint({ text: 'ChunkBase content only. Hybrid widens the vector candidates, then fuses both scores.' }),
                    detail({ text: 'Chat memory always re-ranks with BM25. Neither method scans every stored text: both score only what the vector search found.' }),
                ], { isSpan: true })}
            </div>
            <div id="VectFox_native_hybrid_info" class="vfx-span"${HIDDEN}>${notice({ status: 'info', icon: 'fa-bolt', text: 'Qdrant fuses vector and BM25 results itself. Each collection keeps the CJK tokenizer it was built with.' })}</div>
            <div id="VectFox_bm25_params" class="vfx-grid vfx-span">
                ${field([fieldLabel({ text: 'BM25 k1', forId: 'VectFox_bm25_k1' }), input({ id: 'VectFox_bm25_k1', type: 'number', min: 0.5, max: 3, step: 0.1 }), hint({ text: 'How soon a repeated word stops adding score. 1.2 to 2.0 is typical.' })])}
                ${field([fieldLabel({ text: 'BM25 b', forId: 'VectFox_bm25_b' }), input({ id: 'VectFox_bm25_b', type: 'number', min: 0, max: 1, step: 0.05 }), hint({ text: 'How much a long text is held back. 0.75 is typical.' })])}
                ${switchRow({ id: 'VectFox_bm25_use_corpus_idf', title: 'Collection-wide word rarity', description: 'Rates each word by its rarity in the whole collection. Turn off if it slows you down.', isSpan: true })}
            </div>
            <div id="VectFox_hybrid_params" class="vfx-grid vfx-span">
                ${field([
                    fieldLabel({ text: 'Fusion', forId: 'VectFox_hybrid_fusion_method' }),
                    select({ id: 'VectFox_hybrid_fusion_method', options: fusionMethods }),
                    hint({ text: 'RRF needs no tuning. Weighted mixes the two scores by the weights below.' }),
                ], { isSpan: true })}
                <div id="VectFox_hybrid_weights" class="vfx-grid-pair vfx-span"${HIDDEN}>
                    ${field([fieldLabel({ text: 'Vector weight', forId: 'VectFox_hybrid_vector_weight' }), sliderNumber({ id: 'VectFox_hybrid_vector_weight', min: 0, max: 1, step: 0.1, title: 'Vector weight' })])}
                    ${field([fieldLabel({ text: 'Text weight', forId: 'VectFox_hybrid_text_weight' }), sliderNumber({ id: 'VectFox_hybrid_text_weight', min: 0, max: 1, step: 0.1, title: 'Text weight' })])}
                </div>
                <div id="VectFox_hybrid_rrf_settings" class="vfx-field vfx-span">
                    ${fieldLabel({ text: 'RRF K', forId: 'VectFox_hybrid_rrf_k' })}
                    ${input({ id: 'VectFox_hybrid_rrf_k', type: 'number', min: 1, max: 100, step: 1 })}
                    ${hint({ text: 'Higher evens out the ranks, so lower results count for more. 60 is typical.' })}
                </div>
            </div>
        </div>
    </section>`;
}

function keywordsCard({ languageModes }) {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-tags', title: 'Keywords', description: 'How text splits into words for BM25, and which words are left out.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'CJK tokenizer', forId: 'VectFox_cjk_tokenizer_mode', hasHelp: true }),
                select({ id: 'VectFox_cjk_tokenizer_mode', options: languageModes.map(({ value, label }) => selectOption({ value, text: label })) }),
                hint({ text: 'The default suits Chinese, Korean and Latin scripts. Jieba loads only when picked.' }),
                detail({ text: 'The default uses the browser\'s own word splitter, with nothing to download. Traditional Chinese downloads a dictionary of 2 to 5 MB once. Japanese text with kana uses TinySegmenter.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Custom stopwords', forId: 'VectFox_custom_stopwords' }),
                textarea({ id: 'VectFox_custom_stopwords', rows: 2 }),
                hint({ text: 'Words left out of keywords, comma-separated. Macros such as {{char}} work.' }),
            ])}
        </div>
    </section>`;
}

/**
 * The page's content under its header.
 *
 * @param {object} options
 * @param {{value: string, label: string}[]} options.languageModes - The CJK tokenizer modes (keyword-search's LANGUAGE_MODES)
 * @param {{minMs: number, maxMs: number, defaultMs: number}} options.retrievalTimeout - The retrieval timeout's limits
 * @returns {string}
 */
export function corePageMarkup({ languageModes, retrievalTimeout }) {
    return [
        vectorBackendCard(),
        embeddingCard(),
        eventModelCard(),
        retrievalCard({ retrievalTimeout }),
        injectionCard(),
        keywordScoringCard(),
        keywordsCard({ languageModes }),
    ].join('\n');
}
