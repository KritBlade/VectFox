/**
 * ============================================================================
 * VECTFOX - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Kritblade
 * ============================================================================
 */

import { eventSource, event_types } from './sillytavern/events.js';
import { extension_prompt_types } from './sillytavern/prompt-injection.js';
import { ModuleWorkerWrapper, debounce, debounce_timeout } from './sillytavern/extension-runtime.js';
import { extension_settings } from './sillytavern/settings.js';

// VectFox modules - Core
import {
    followChatRenameOfCollections,
    migrateOldEnabledKeys,
    registerCollection,
    setDeletedOrImportedCollectionCleanup,
} from './features/collections/index.js';
import {
    clearCachesForDeletedOrImportedCollection, followCollectionInUse, refreshWorldInfoEntryDepthCache, runEventBaseReplyStep,
    setEventBaseListeners, synchronizeChat,
} from './features/eventbase/index.js';
import { setLlmCallFinishedListener, setOwnRequestMarker } from './features/llm-provider/index.js';
import { setInsertedCollectionRegistrar, setPurgedCollectionListener } from './features/vector-backend/index.js';
import { migrateLegacyApiKeys } from './shared/api-keys.js';
import { migration_setting_name_for_connection } from './app/settings-migration-connection-setting-names.js';
import { migration_embedding_source_key } from './app/settings-migration-embedding-provider-key.js';
import { migration_remove_semantic_world_info_settings } from './app/settings-migration-semantic-world-info-settings.js';
import { migration_remove_chunkbase_settings } from './app/settings-migration-chunkbase-settings.js';
import { migration_remove_retired_collection_fields } from './app/settings-migration-collection-retired-fields.js';
import { migration_eventbase_progress_into_collections } from './app/settings-migration-eventbase-progress.js';
import { forcedSettingValueIds, migration_apply_forced_setting_values } from './app/settings-migration-forced-values.js';
import { log } from './sillytavern/log.js';
import {
    CONNECTION_PROFILE_PROVIDER,
    RETRIEVAL_TIMEOUT_DEFAULT_MS,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,
    AGENTIC_MAX_TOKENS_DEFAULT,
    STORY_ARC_MAX_TOKENS_DEFAULT,
} from './shared/constants.js';
import { setMessageSource } from './shared/chat-messages.js';
import { isVectFoxEnabled } from './shared/feature-gate.js';
import { followGenerations } from './shared/last-generation.js';
import { runNetworkStartup } from './app/network-startup.js';

// VectFox modules - UI
import { mountSettingsPanel, mountWandMenu, refreshAutoSyncCheckbox, scheduleManualConnectionNotice } from './features/settings-panel/index.js';
import { initializeDatabaseBrowser } from './features/database-browser/index.js';
import { KEY_CALLS_AT_ONCE_DEFAULT, LORE_BUDGET_DEFAULT, PICK_LIMIT_DEFAULT, initializeLoreBase, prepareLoreBesideRetrieval } from './features/lorebase/index.js';
import { initializeReplyLore } from './features/reply-lore/index.js';
import { ENTITY_LORE_SETTING, REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS, onEventBaseRunEnded } from './features/entity-lore/index.js';
import {
    announceCollectionInUseChanged, announceEventBaseEventsRemoved, announceEventBaseRunEnded, announceLlmCallFinished,
    announcePublicApiReady, announcePurgedCollection, askMessageSources, markOwnRequestWhenSwitchedOn, publishPublicApi,
} from './features/public-api/index.js';
import { CJK_TOKENIZER_MODES, setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded } from './features/keyword-search/index.js';

// Calls a lower layer makes into a higher one, wired here before anything can delete or insert.
setDeletedOrImportedCollectionCleanup(clearCachesForDeletedOrImportedCollection);
setInsertedCollectionRegistrar(registerCollection);
// What EventBase, the vector backend and the LLM calls tell the public API, which sends it on as vectfox_* events, the
// public API's mark on the signal of each LLM call's request, written while the PublicAPI page's switch is on, and the
// message sources other extensions register, which story order asks about each message it reads. An EventBase run that
// ends is told to Entity-Lore too, which writes the entries it made due, the public API's failure leaving it told.
setEventBaseListeners({
    onRunEnded: (run) => {
        try {
            announceEventBaseRunEnded(run);
        } finally {
            onEventBaseRunEnded(run);
        }
    },
    onEventsRemoved: announceEventBaseEventsRemoved,
    onCollectionInUseChanged: announceCollectionInUseChanged,
});
setPurgedCollectionListener(announcePurgedCollection);
setLlmCallFinishedListener(announceLlmCallFinished);
setOwnRequestMarker(markOwnRequestWhenSwitchedOn);
setMessageSource(askMessageSources);

// Default settings
const defaultSettings = {
    // Master switch — when false, VectFox does no automatic runtime work
    // (retrieval injection, auto-sync, LoreBase's picks). Default ON.
    // Single source of truth for reads: src/shared/feature-gate.js::isVectFoxEnabled.
    enabled: true,

    // The palette the settings panel and its dialogs wear: 'dark' (Night Slate) | 'light' (Soft Silver)
    panel_theme: 'dark',

    // Core vector settings
    // A new install starts on the SillyTavern profile option with none chosen: Custom with no profile ID, which the
    // Core page shows as that option, and which embeds nothing until a profile is chosen.
    embedding_provider: 'custom', // transformers | ollama | openrouter | vllm; on a connection profile, the profile's type: ollama | llamacpp | koboldcpp | custom
    embedding_connection_profile_id: '', // the SillyTavern connection profile embedding runs on: always on llamacpp, koboldcpp and custom, and on ollama while set
    vector_backend: 'qdrant', // Backend: 'standard' (ST Vectra) | 'qdrant'
    qdrant_host: '127.0.0.1',
    qdrant_port: 6333,
    qdrant_url: '',
    // Qdrant API key: not a setting. It lives in SillyTavern's secret_state slot 'api_key_qdrant', which
    // the Similharity plugin reads server-side; the UI learns whether it is set from
    // /api/plugins/similharity/qdrant/key-status. migrateLegacyApiKeys() moves a plaintext
    // settings.qdrant_api_key into the slot on load, and a default here would bring the field back (see
    // the OpenRouter key below). Reader: fetchQdrantApiKeyPresence in src/shared/api-keys.js.
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    embedding_ollama_url: '',
    embedding_ollama_url_override: false,
    // No Ollama key: SillyTavern has no Ollama secret and sends no Ollama auth header.
    // migrateLegacyApiKeys() deletes a leftover settings.ollama_api_key.
    embedding_vllm_url: '',
    embedding_vllm_url_override: false,
    rate_limit_calls: 60,
    rate_limit_interval: 60, // seconds
    // Summarizer (EventBase extraction) + Agent Mode planner share ONE
    // chat-completions rate budget, independent of the embedding limit above.
    // 0 = no throttle. See src/features/eventbase/generation-rate-limiter.js.
    generation_rate_limit_calls: 0,
    generation_rate_limit_interval: 60, // seconds

    // VEC-6: Batch insert optimization
    insert_batch_size: 50, // Texts per embedding request while inserting (insertVectorItems)
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    electronhub_model: 'text-embedding-3-small',
    embedding_openrouter_model: 'openai/text-embedding-3-large',
    // OpenRouter key: SillyTavern's shared SECRET_KEYS.OPENROUTER slot, not a setting. Reader:
    // getOpenRouterApiKey in src/shared/api-keys.js. No key field may be declared in these defaults:
    // start-up merges them into the store after migrateLegacyApiKeys() runs, which would write a
    // declared empty field back after that deletes it.
    cohere_model: 'embed-english-v3.0',
    embedding_ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    embedding_vllm_model: '',
    // vLLM key: written to two SillyTavern slots so one key serves both sides: SECRET_KEYS.CUSTOM (chat,
    // through chat_completion_source 'custom') and SECRET_KEYS.VLLM (embedding, through SillyTavern's
    // vector handler). Not a setting; migrateLegacyApiKeys() moves a plaintext vllm_api_key into both
    // slots. Reader: getCustomApiKey in src/shared/api-keys.js (presence and masked value only; the key
    // stays server-side).
    google_model: 'text-embedding-005',

    // Chat vectorization
    depth: 2,
    // Placement of every VectFox block (memory, summarizer). Their text changes each
    // turn, so In-Chat keeps it below the static prompt and leaves that prefix cacheable.
    position: extension_prompt_types.IN_CHAT,
    protect: 5,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    retrieval_popup_on_start: true,    // Show popup when retrieval starts
    retrieval_popup_on_result: true,   // Show popup with number of retrieved results
    // How long one turn may spend on any single retrieval (EventBase, the
    // summarizer injection) before it proceeds without that memory.
    // Agent Mode ADDS its own planner + fanout timeouts on top of this for the
    // EventBase path — see src/shared/retrieval-budget.js. UI: Core page → Retrieval.
    retrieval_timeout_ms: RETRIEVAL_TIMEOUT_DEFAULT_MS,
    query: 2,

    // Deduplication settings
    // Recent-context skip: drop candidate events whose source_window_end falls within
    // the last N messages of the chat — assumption is that the LLM already sees those
    // messages in raw form. In practice this assumption breaks because actual visible
    // chat context is typically ~3-6 messages (depends on context budget / system prompt /
    // other extensions). Default 0 = filter disabled, never skip. Power users can opt in
    // to a small value (e.g. 3-10) if their setup has predictable raw-context visibility.
    deduplication_depth: 0,

    // Keyword scoring method for retrieval (standard backend only; ignored when native hybrid active)
    keyword_scoring_method: 'hybrid', // 'bm25' (fast re-rank of ANN top-K) | 'hybrid' (candidate-limited hybrid fusion over expanded vector results)

    // BM25 parameters
    bm25_k1: 1.5,  // Term frequency saturation (1.2-2.0 typical)
    bm25_b: 0.75,  // Length normalization (0-1, 0.75 typical)
    // IDF source for client-side BM25 (A1/A2 paths only — A3/Qdrant always uses corpus IDF).
    // true  → df values computed once per session over the full collection (cached, ~700ms
    //         cold build for ~1.4k chunks, then sub-ms lookups). Rare-term IDF stays accurate.
    // false → df values computed only over the ANN candidate set per query (no build cost).
    //         Rare terms can look common locally → discrimination is weaker for rare-term queries.
    // Measured cost on a 1394-chunk Traditional Chinese collection: 674 ms cold build,
    // 210 ms of which is main-thread tokenize. Memory: ~400 KB cached df map per collection.
    // Note: this is "corpus IDF *weights*", not "corpus *search*". BM25 still scores only
    // the ANN top-K candidates — the toggle does not expand retrieval recall.
    bm25_use_corpus_idf: true,

    // Query keyword budget for retrieval (A1 and A2 paths)
    hybrid_keyword_level: 'balance', // 'minimal' (30) | 'balance' (50) | 'maximum' (70)

    // Summarization before vectorization
    chat_provider: CONNECTION_PROFILE_PROVIDER, // 'connection_profile', 'openrouter' or 'vllm'; a new install starts on a profile, none chosen
    has_shown_manual_connection_retirement_notice: false, // the notice that manual OpenRouter and vLLM retire, shown once per install
    chat_connection_profile_id: '', // the SillyTavern connection profile, read only while chat_provider is 'connection_profile'
    // summarize_openrouter_api_key and summarize_vllm_api_key are not in defaults: migrateLegacyApiKeys()
    // moves them into SECRET_KEYS.OPENROUTER and into SECRET_KEYS.CUSTOM (chat side) + SECRET_KEYS.VLLM
    // (embedding side), and a default here would bring them back (see the OpenRouter key above).
    // Readers: src/shared/api-keys.js.
    chat_model: '',              // Model ID for summarization (e.g. 'google/gemini-flash-1.5-8b')
    chat_vllm_url: '',           // vLLM base URL for summarization (e.g. 'http://127.0.0.1:8000')
    summarize_prompt: '',             // Custom prompt template (empty = use built-in default)

    // Chat-completion request shape — applies to EVERY LLM feature (summarizer,
    // EventBase extraction, Agent Mode, StoryArc, LoreBase), because one install talks
    // to one chat endpoint family. Reasoning models (gpt-5.x, o1/o3/o4 and hosted
    // builds on them) reject `temperature` and `max_tokens` outright; these two
    // switches reshape the body for them. Reader: resolveModelParameterStyle()
    // in src/features/llm-provider/llm-provider-call.js. Defaults keep the classic OpenAI shape.
    should_send_temperature: true,            // false = omit `temperature` from the request entirely
    should_use_max_completion_tokens: false,  // true = send `max_completion_tokens` instead of `max_tokens`
    should_disable_thinking: true,            // true sends `reasoning_effort: 'none'`, false sends 'minimal', or 'low' for StoryArc's router

    // Hybrid Search fusion settings.
    // A1 (BM25 re-rank, Vectra) reads hybrid_fusion_method/weights when invoked via A2 client-side hybrid.
    // A3 (Qdrant native sparse + RRF) ignores them — fusion is server-side via Qdrant /points/query.
    hybrid_fusion_method: 'rrf',        // 'rrf' (Reciprocal Rank Fusion) or 'weighted' — A2 only
    hybrid_vector_weight: 0.5,          // Weight for vector scores (0-1) — A2 weighted mode only
    hybrid_text_weight: 0.5,            // Weight for text/BM25 scores (0-1) — A2 weighted mode only
    hybrid_rrf_k: 60,                   // RRF constant — A2 only (Qdrant uses its own default)
    hybrid_native_prefer: true,         // KEPT (no UI): A3 vs A2 selector for backends that support both. Default = prefer native.

    // RAG page: the text before, and the tag around, the events and chunks VectFox injects.
    // Summarizer Injection carries its own tag; LoreBase's entries go in through SillyTavern's World Info.
    rag_context: '',      // Goes before them; ST macros work
    rag_xml_tag: 'VectFoxMemory',      // Wraps them; empty sends them unwrapped

    // Collection-level metadata (managed by collection-metadata.js)
    collections: {},

    // Collection registry (list of known collection IDs)
    vectfox_collection_registry: [],

    // LoreBase (lorebook plan B6): its own model, a profile none chosen on a new install, and its Accuracy (plan D6)
    lorebase_provider: CONNECTION_PROFILE_PROVIDER,
    lorebase_model: 'openai/gpt-6-luna',    // the model the route trials ran; read only on OpenRouter or vLLM
    lorebase_connection_profile_id: '',     // read only while lorebase_provider is 'connection_profile'
    lorebase_accuracy: 'fast',              // 'fast', Fast and Cheap [Jev], asks Jev (plan D16); 'high', High Accuracy, is Luna's pick and reviews
    lorebase_jev_connection_profile_id: '', // Jev's SillyTavern profile, read only on 'fast'
    lorebase_lore_budget_tokens: LORE_BUDGET_DEFAULT, // Lore budget on the WorldInfo page: the most tokens Jev's picks send a reply, read only on 'fast'
    lorebase_pick_limit: PICK_LIMIT_DEFAULT, // Pick limit on the WorldInfo page: the most entries the pick names a reply, 1 to 12, read only on 'high'
    lorebase_enabled: false,                // LoreBase's switch on the WorldInfo page: off until the user turns it on
    lorebase_key_calls_at_once: KEY_CALLS_AT_ONCE_DEFAULT, // Entries at once on the WorldInfo page: entries keyed at once, 1 to 8

    // Entity-Lore (entity-lore plan §8): its switch on the WorldInfo page's Entity-Lore tab, off until the user turns it on, and its two counts
    [ENTITY_LORE_SETTING.enabled]: false,
    [ENTITY_LORE_SETTING.writeAtEvents]: WRITE_AT_EVENTS.default,           // Write at: a named character's entry is written at this many events, 3 to 50
    [ENTITY_LORE_SETTING.rewriteEveryEvents]: REWRITE_EVERY_EVENTS.default, // Rewrite every: written again after this many more events, 10 to 100

    // How text splits into words for BM25
    cjk_tokenizer_mode: CJK_TOKENIZER_MODES.intl, // intl | jieba | jieba_tw | tiny_segmenter

    // EventBase workflow
    // Legacy fields (eventbase_provider, eventbase_model, eventbase_openrouter_api_key,
    // eventbase_vllm_url, eventbase_vllm_api_key) were unified into the Core
    // `summarize_*` keys. The init block below copies any leftover values from
    // those fields into `summarize_*` then deletes them, so they no longer
    // need defaults here. Pre-existing installs that already had values move
    // forward cleanly; new installs never see the fields at all.
    eventbase_temperature: 0.2,
    eventbase_max_tokens: 2048,
    eventbase_timeout_ms: 60000,
    eventbase_window_size: 2,                     // Chat messages per extraction window
    eventbase_window_overlap: 0,                  // Window overlap to avoid edge cuts
    // Independent auto-sync window, owned by the AutoSync tab. Expressed in TURNS
    // (1 turn = 2 messages: 1 user + 1 AI reply); messageCount = turns * 2. Auto-sync
    // uses this instead of eventbase_window_size, so its cadence is independent of the
    // one-off Vectorize Content window. Range 1-20. Default 1 (most reactive).
    eventbase_autosync_window_turns: 1,
    // Settle/commit lag: when true, auto-sync does NOT extract the active (still-
    // swipeable) last turn — it waits until a newer message supersedes it. Kills
    // duplicate embeddings from re-rolls/swipes (only the kept, superseded turn is
    // ever extracted) and cuts wasted extraction calls. ON by default and harmless:
    // the held-back turn is always the newest message, so it is always inside ST's
    // live context window already — retrieval never needs it. Manual Vectorize
    // Content ignores this and still covers the whole chat. See
    // InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
    eventbase_autosync_settle_lag: true,
    // Summarizer Injection (Feature B): when enabled, inject the most recent N
    // EventBase events (by source_window_end desc) into the prompt every turn,
    // wrapped in <VectFoxSummarizer> tags — word-for-word-ish recent-turn memory,
    // independent of semantic retrieval. Only meaningful with auto-sync active, so
    // it lives on the AutoSync tab and forces the auto-sync window to 1 turn while on.
    summarizer_injection_enabled: false,
    summarizer_injection_count: 15,               // recent events to inject; range 1-50
    // When on (default), each injected event also includes its structured fields
    // (cause, result, characters, locations, items, DateTime, concepts, keywords,
    // open_threads, message index) beneath the summary line. Off = summary only.
    summarizer_injection_full_detail: true,
    // Safety cap (characters) on the whole <VectFoxSummarizer> block. Full-detail ×
    // many events can balloon the prompt past the model's context and kill generation
    // (the model returns ~0 tokens). When the requested events exceed this budget, the
    // OLDEST overflow is dropped (most-recent always kept); the latest event is always
    // included even if it alone exceeds the cap. 0 = no cap. Default ~4-6.5k tokens.
    summarizer_injection_max_chars: 10000,
    // Ghosting: when enabled AND Summarizer Injection is on, keep the most recent N
    // messages verbatim and take the older already-vectorized messages out of the
    // OUTGOING prompt only, every summary kept. The chat file + UI are untouched and the
    // effect resets every generation (nothing to undo, branch-safe). Trades raw old
    // context for token savings, leaning on EventBase memory (summarizer injection +
    // semantic retrieval) for the messages taken out. "Keep last N" auto-scales to any
    // chat length (the count taken out is tip − N), so a 50-reply and a 5000-reply chat
    // use the same setting. Gated to Summarizer Injection because that forces auto-sync
    // window=1, guaranteeing every message below the vectorization tip is extracted
    // before it could be taken out.
    eventbase_ghost_enabled: false,
    eventbase_ghost_keep_recent: 1,               // recent messages kept verbatim; everything older that's vectorized is taken out. range 1-50 (Summarizer Injection's recent events cover the messages taken out)
    eventbase_ghost_batch_size: 1,                // messages the take-out boundary moves by: 1 moves it every turn; above 1 it waits for a whole batch, so the prompt's opening stays the same for a provider's prompt cache. range 1-100
    eventbase_min_importance_store: 3,            // Drop events below this importance before storing
    eventbase_max_events_per_window: 3,           // Hard cap on events returned per LLM call
    eventbase_retrieval_top_k: 10,                // Events to retrieve per generation
    eventbase_retrieval_min_importance: 1,        // Minimum importance for retrieval
    eventbase_score_threshold: 0,                 // Similarity floor for every event search (ChatHistory page → EventBase retrieval); 0 keeps every match
    eventbase_injection_format: 'densetext',      // Injection format: 'densetext' or 'jsonarray'
    eventbase_retrieval_filters_enabled: true,
    eventbase_autosync_popup: true,               // Show popup toast when auto-sync extraction runs
    autosync_show_progress_modal: false,          // Show progress modal popup during auto-sync (default: silent)
    chat_lock_index: {},                          // Reverse index: chatId -> [collectionId, ...] for O(1) tab lookups
    // ─── Logging (src/sillytavern/log.js) ───────────────────────────────
    // Verbosity dropdown — single noise floor for the whole pipeline.
    // 'off' (default) | 'lifecycle' | 'verbose' | 'trace'. Errors/warnings
    // always fire regardless. See InternalProject/Vectfox/plans/executed/logging-levels-and-classification.md.
    debug_verbosity: 'off',
    // Orthogonal per-subsystem deep-dives, independent of debug_verbosity.
    // Each key is a name that log.domain() in src/sillytavern/log.js takes. All default off.
    debug_domain: {
        raw_llm: false,     // per-window raw LLM text + parser candidate dumps
        qdrant: false,      // native hybrid keyword/fusion diagnostics
        standard: false,    // similharity plugin internals
        injection: false,   // What got injected, where, why
        agent: false,       // agent-mode planner / per-query hits
        story_arc: false,   // StoryArc: the Route rule of each turn, and the search text with other names
        rerank: false,      // native vs JS re-rank comparison
    },
    // eventbase_debug_logging, eventbase_raw_llm_debug and debug_vectorizing_log
    // are read by nothing: src/sillytavern/log.js gates on debug_verbosity and
    // debug_domain only.
    eventbase_debug_logging: false,
    eventbase_raw_llm_debug: false,
    vector_group_embedding_call: true,           // Path-agnostic insert toggle. true = legacy batched POST (1 POST per batch, cheaper, default — proven safe in production wire conditions when paired with hedge). false = parallel-split (1 POST per item, failure-contained, but N× the connection surface area which can amplify upstream routing stalls). Affects every call to insertVectorItems (EventBase ingestion AND content/document vectorization).
    vector_hedge_after_ms: 15000,                // 0 = hedge disabled. Default 15000 (15s) fires a duplicate request when an embedding POST hasn't returned by the threshold; race-first-wins. Helps multi-upstream gateways (OpenRouter, SiliconFlow via vllm slot) recover from connection-level routing stalls in seconds instead of 120s. Skipped for local providers (ollama/transformers/llamacpp/koboldcpp). See InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md §6.
    eventbase_disable_pipeline: false,           // false = pipelined extract↔insert (default, ~35% faster). true = serial (each batch finishes embedding before the next starts extracting; safer on slower vector DB backends). Read-site (eventbase-workflow.js) treats anything except explicit true as pipelined.
    eventbase_debug_qdrant_backend: false,
    debug_vectorizing_log: false,
    eventbase_custom_prompt: '',                  // Custom extraction prompt (empty = use built-in default)
    // Re-rank weights (sum is normalized to 1.0 at runtime)
    eventbase_rerank_w_cosine: 0.55,
    eventbase_rerank_w_importance: 0.20,
    eventbase_rerank_w_persist: 0.15,
    eventbase_rerank_w_recency: 0.10,

    // Anchor boost: flat additive bonus when an event's keyword appears verbatim
    // in the user's last message. Rescues historically-distant events the user
    // explicitly asks about. Slider 0.00-0.50, default 0.20 (selected from
    // 4-run grid benchmarking — see InternalProject/Vectfox/plans/executed/agentic-retrieval-plan.md notes).
    // 0 = disabled.
    eventbase_anchor_boost: 0.20,
    // Dedup temporal proximity: events N or more messages apart are treated as
    // distinct (kept). Slider 0-200, default 10. 0 = dedup fully disabled;
    // 10 catches same-window duplicates plus near-adjacent extraction artifacts
    // (windows 0-9 apart) while keeping genuinely distinct scenes 10+ msgs away.
    eventbase_dedup_window_gap: 10,

    // Native rerank: push importance filter + dedup-depth filter + weighted-sum
    // scoring into Qdrant via a formula query, in the same /query call as the
    // dense+sparse RRF hybrid. A3 (Qdrant) only — Standard backend ignores this.
    // On by default ("Re-rank in Qdrant" on the Core page). Requires Qdrant 1.13+;
    // falls back to the JS re-rank pipeline when the route returns an error.
    // See InternalProject/Vectfox/plans/executed/qdrant-native-eventbase-rerank-formula.md.
    eventbase_native_rerank: true,
    // Compare mode: when native rerank is on, also run the JS pipeline in
    // parallel and log per-(collection,queryText) rank correlation + overlap.
    // Doubles per-collection cost when on — debug only. Requires
    // eventbase_debug_logging to surface logs.
    eventbase_compare_rerank: false,
    // Verbose compare-mode logging: also print per-event score breakdowns for
    // events present in both top-K lists.
    eventbase_compare_rerank_verbose: false,

    // ─── AgentMode (Agentic Retrieval) ──────────────────────────────────
    // Optional LLM planner that reads recent chat alongside the pre-search and
    // emits 1-6 follow-up queries which fan out in parallel against Qdrant. Their
    // hits add seats beside the pre-search's, which keeps all its own. Does not run
    // under StoryArc mode. A3 (Qdrant) only.
    agentic_retrieval_enabled: false,                  // Master toggle (default OFF)
    story_arc_mode_enabled: false,                     // StoryArc mode: routes questions about the story's past to time-ordered searches. AgentMode's planner does not run under it
    story_arc_link_provider: CONNECTION_PROFILE_PROVIDER, // StoryArc's own model, a profile none chosen on a new install: a link needs a model that thinks,
    story_arc_link_model: 'openai/gpt-6-luna',         // which AgentMode's planner does not
    story_arc_link_connection_profile_id: '',          // read only while story_arc_link_provider is 'connection_profile'
    story_arc_block_scale: 0.5,                        // Block size slider, 0.4 to 1.0: a block has 2.5 × this × √events seats, and keeps 4/3 × this × √events lines
    story_arc_max_tokens: STORY_ARC_MAX_TOKENS_DEFAULT, // Max tokens slider, 1,000 to 32,000: the output cap of each call on the link model, thinking included
    agent_provider: '',                    // '' → Same as EventBase model: chat_provider and chat_vllm_url, or its profile
    agent_connection_profile_id: '',       // read only while agent_provider is 'connection_profile'
    agent_model: '',                       // '' → chat_model, whichever provider runs the planner
    // agentic_retrieval_openrouter_api_key and agentic_retrieval_vllm_api_key
    // are NOT in defaults — same Object.assign re-introduction reason as the
    // other legacy *_api_key slots above. Migration drains them into
    // SECRET_KEYS.OPENROUTER and SECRET_KEYS.CUSTOM + SECRET_KEYS.VLLM
    // (dual-write for vLLM, see embedding/chat split in api-keys.js header).
    agent_vllm_url: '',                    // read only while agent_provider is 'vllm' ('' → chat_vllm_url); StoryArc's link model on vLLM reads it first too
    agentic_retrieval_chat_depth: 3,                   // # of past chat turns sent to planner (slider 1-10)
    agentic_retrieval_max_queries: 6,                  // Hard ceiling on planner output (slider 1-6)
    // Both timeouts run INSIDE the EventBase retrieval bound and are ADDED to it
    // (src/shared/retrieval-budget.js), so raising either really does buy the planner
    // more time instead of being silently capped by the outer budget.
    agentic_retrieval_timeout_ms: AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,       // Planner LLM call timeout (matches summarize default; some models need >5s)
    agentic_retrieval_query_timeout_ms: AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,   // Per-query fanout timeout — drop a straggling Qdrant call so one slow embed/search doesn't stall retrieval
    // Planner output-token cap. A thinking model spends this on reasoning before
    // it writes any JSON, so too low = truncated output = agent mode silently
    // falls back to pre-search. UI: AgentMode tab.
    agentic_retrieval_max_tokens: AGENTIC_MAX_TOKENS_DEFAULT,

    // ─── PublicAPI (Development) ────────────────────────────────────────
    // VectFox's mark on the signal of each LLM call's request, which a usage tracker reads. Off until the user turns
    // it on: nothing else reads it (src/features/public-api/public-api.js).
    own_request_mark_enabled: false,

    // ─── Hidden / Power-User ────────────────────────────────────────────
    // SUPERADMIN MODE — no GUI toggle. Set to true by hand-editing settings.json
    // (the `vectfox` block under SillyTavern's extension_settings) to enable.
    // When true, the Database Browser bypasses ALL persona / handle ID filtering
    // and shows EVERY collection on the server regardless of creatorHandle. Locking
    // a foreign collection then works normally. Intended for dev / debugging /
    // multi-persona admin scenarios. Do not expose in the UI — this is a tripwire,
    // not a feature.
    superadmin: false,

    // The forced setting values already applied, by ID. A new install records every push as applied, so none replays
    // over a newer default; see src/app/settings-migration-forced-values.js.
    forced_setting_values_applied: forcedSettingValueIds(),
};

// Runtime settings: the defaults until start-up makes this extension_settings.vectfox itself.
let settings = { ...defaultSettings };

// Module worker for automatic syncing
const moduleWorker = new ModuleWorkerWrapper(() => synchronizeChat(settings, _lastChatTriggerEvent));

// Most recent SillyTavern event that triggered the debounced chat-event handler.
// Read by synchronizeChat to suppress the auto-sync popup on MESSAGE_SENT (so the
// popup only appears after the AI's reply arrives, never mid-generation).
// If the debounce coalesces SENT+RECEIVED within one window, the later event wins.
let _lastChatTriggerEvent = null;

// Chat event handler (debounced). Each registration below sets the trigger flag
// before invoking this, so the debounced fire knows what coalesced into it.
const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * The generation interceptor, which SillyTavern runs after slash commands and never on a dry run: EventBase's reply
 * step (retrieval, the Summarizer and ghosting), and side by side with it LoreBase's pick and reviews, whose picks are
 * held for SillyTavern's World Info scan once both are done. The chat and context size are the scan's, which LoreBase's
 * tester keeps.
 */
async function vectfox_rearrangeChat(chat, contextSize, _abort, type) {
    await prepareLoreBesideRetrieval(type, settings, () => runEventBaseReplyStep(chat, settings, type), { chat, maxContext: contextSize });
}

// Export to window for ST to call
window['vectfox_rearrangeChat'] = vectfox_rearrangeChat;

// The VectFox object other extensions call, there from now on; it says it is ready when initialization ends, below.
publishPublicApi();

/**
 * Initialize VectFox extension
 */
jQuery(async () => {
    log.lifecycle('VectFox: Initializing...');

    // Load saved settings
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = defaultSettings;
    }

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        log.lifecycle(`VectFox: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // Migrate legacy EventBase LLM overrides → unified Core chat settings.
    // Copy any non-empty legacy value into the corresponding chat_* field
    // (only if chat_* is still empty — never clobber), then DELETE the
    // legacy field unconditionally. Previous version copied but left the
    // legacy keys behind as stale empty strings in settings.json.
    // (Targets are the post-rename `chat_*` names — see the connection-key
    // rename migration just below; this maps eventbase_* straight to chat_*.)
    const _ebs = extension_settings.vectfox;
    const _ebLegacyMap = [
        ['eventbase_model', 'chat_model'],
        ['eventbase_provider', 'chat_provider'],
        ['eventbase_openrouter_api_key', 'summarize_openrouter_api_key'],
        ['eventbase_vllm_url', 'chat_vllm_url'],
        ['eventbase_vllm_api_key', 'summarize_vllm_api_key'],
    ];
    let _ebMutated = false;
    for (const [legacy, canonical] of _ebLegacyMap) {
        if (!Object.prototype.hasOwnProperty.call(_ebs, legacy)) continue;
        const v = _ebs[legacy];
        if (!_ebs[canonical] && typeof v === 'string' && v.trim().length > 0) {
            _ebs[canonical] = v;
        }
        delete _ebs[legacy];
        _ebMutated = true;
    }
    if (_ebMutated) {
        // Persist deletions synchronously, not debounced: migrations run once at
        // init, and a reload before a debounced save flushes would leave the
        // deleted legacy fields in settings.json although extension_settings.vectfox
        // is clean in memory.
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Rename the connection keys that predate the `<consumer>_<provider>_<field>` scheme (embedding_* /
    // chat_* / agent_*): summarize_*, agentic_retrieval_*, *_alt_endpoint_url and *_model. Runs after the
    // eventbase → chat copy above, so the keys that copy leaves are renamed too. Idempotent, in-memory
    // only. See src/app/settings-migration-connection-setting-names.js and
    // InternalProject/Vectfox/plans/executed/settings-naming-convention-migration.md. The `source` →
    // `embedding_provider` rename is its own migration, below.
    const _connRename = migration_setting_name_for_connection(extension_settings.vectfox);
    if (_connRename.migrated > 0) {
        log.lifecycle(`VectFox: Renamed ${_connRename.migrated} connection setting key(s): ${_connRename.keys.join(', ')}`);
        // Persist immediately (not debounced) — same reload-safety reason as the
        // eventbase block above (R5 in the plan's crash-safety checklist).
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Rename the embedding key `source` → `embedding_provider`. Idempotent, in-memory only.
    // See src/app/settings-migration-embedding-provider-key.js.
    const _srcRename = migration_embedding_source_key(extension_settings.vectfox);
    if (_srcRename.migrated > 0) {
        log.lifecycle('VectFox: Renamed embedding `source` → `embedding_provider`');
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Delete the settings of the vectorized lorebook search LoreBase replaced. Idempotent.
    // See src/app/settings-migration-semantic-world-info-settings.js.
    const _semanticWorldInfoRemoval = migration_remove_semantic_world_info_settings(extension_settings.vectfox);
    if (_semanticWorldInfoRemoval.migrated > 0) {
        log.lifecycle(`VectFox: Removed ${_semanticWorldInfoRemoval.migrated} semantic World Info setting(s): ${_semanticWorldInfoRemoval.keys.join(', ')}`);
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Delete the settings only ChunkBase read, with every per-chunk metadata key, and the fields of each collection's
    // metadata that retired with it and with triggers and conditions. Idempotent. See
    // src/app/settings-migration-chunkbase-settings.js and src/app/settings-migration-collection-retired-fields.js.
    const _chunkBaseRemoval = migration_remove_chunkbase_settings(extension_settings.vectfox);
    const _collectionFieldRemoval = migration_remove_retired_collection_fields(extension_settings.vectfox);
    if (_chunkBaseRemoval.migrated > 0 || _collectionFieldRemoval.migrated > 0) {
        log.lifecycle(`VectFox: Removed ${_chunkBaseRemoval.keys.length} ChunkBase setting(s) (${_chunkBaseRemoval.keys.join(', ')}), ${_chunkBaseRemoval.chunkMetadataCount} per-chunk metadata key(s), and ${_collectionFieldRemoval.migrated} retired field(s) from ${_collectionFieldRemoval.collectionCount} collection(s)`);
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Copy how far EventBase has read each chat, stored per chat until now, into the record of each of the chat's
    // collections, before anything reads it; an empty registry waits for the next start. Idempotent. See
    // src/app/settings-migration-eventbase-progress.js.
    const _eventBaseProgressCopy = migration_eventbase_progress_into_collections(extension_settings.vectfox);
    if (_eventBaseProgressCopy.storeCount > 0) {
        log.lifecycle(`VectFox: Copied EventBase's pointer of ${_eventBaseProgressCopy.chatCount} chat(s) onto ${_eventBaseProgressCopy.migrated} collection(s), dropped ${_eventBaseProgressCopy.droppedChatCount} chat(s) no collection holds, and deleted ${_eventBaseProgressCopy.storeCount} per-chat store(s)`);
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Apply each forced setting value this install has not applied yet, over any value the user saved, once per push.
    // Last of the settings migrations, so a push names a key in its newest shape; before the defaults merge, so an
    // existing install with no record applies every push. See src/app/settings-migration-forced-values.js.
    const _forcedValues = migration_apply_forced_setting_values(extension_settings.vectfox);
    if (_forcedValues.migrated > 0) {
        log.lifecycle(`VectFox: Applied ${_forcedValues.migrated} forced setting value(s) (${_forcedValues.ids.join(', ')}), changing ${_forcedValues.keys.length ? _forcedValues.keys.join(', ') : 'no saved value'}`);
        const { saveSettings } = await import('./sillytavern/settings.js');
        await saveSettings();
    }

    // Move plaintext *_api_key values from settings.json into SillyTavern's secret_state. Runs after the
    // eventbase → summarize copy above, so a key set only as eventbase_* is moved too. Idempotent: an
    // empty field is a no-op. Design: src/shared/api-keys.js and §H-1 of
    // InternalProject/Vectfox/plans/executed/review-fix.md.
    try {
        await migrateLegacyApiKeys();
    } catch (err) {
        log.warn('[VectFox] migrateLegacyApiKeys failed:', err?.message || err);
        // Non-fatal: nothing reads a plaintext key, and the next start moves what this one did not.
    }

    // `settings` IS the store, never a copy of it. Collection locks, the collection registry and
    // other values are written straight to extension_settings.vectfox, and every panel handler runs
    // Object.assign(extension_settings.vectfox, settings), so a copy would undo them with its
    // page-load values. The defaults go in only now because the migrations above decide by which
    // keys are missing.
    settings = Object.assign(extension_settings.vectfox, { ...defaultSettings, ...extension_settings.vectfox });

    // Initialize CJK tokenizer mode before any extraction happens.
    setCjkTokenizerMode(settings.cjk_tokenizer_mode || CJK_TOKENIZER_MODES.intl);
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba) {
        ensureJiebaTokenizerLoaded().then((ok) => {
            if (ok) {
                log.lifecycle('VectFox CJK: Jieba tokenizer initialized');
            } else {
                log.warn('VectFox CJK: Jieba tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba_tw) {
        ensureJiebaTwLoaded().then((ok) => {
            if (ok) {
                log.lifecycle('VectFox CJK: Jieba TW tokenizer initialized');
            } else {
                log.warn('VectFox CJK: Jieba TW tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }

    // The settings panel, in SillyTavern's Extensions drawer
    mountSettingsPanel('extensions_settings2', settings, { runNetworkStartup });

    // VectFox's row in SillyTavern's wand menu: Menu opens the panel, Last reply's lore the latest reply's entries
    mountWandMenu();

    // Once SillyTavern has loaded: the one-time notice that manual OpenRouter and vLLM retire
    scheduleManualConnectionNotice(settings);

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // The last generation past its slash commands, so LoreBase's pick and EventBase's reply step know a quiet-to-loud one
    followGenerations();

    // The collection the open chat uses, so the public API says when it changes
    followCollectionInUse(settings);

    // LoreBase settles Vector Storage's World Info search before a reply, and arms each World Info scan
    initializeLoreBase();

    // The latest reply's lorebook entries, for the wand menu's Last reply's lore
    initializeReplyLore();

    // Off-box startup work (discovery, EventBase index backfill, plugin version check).
    // Master switch OFF → skip it entirely; the switch re-runs this when turned back ON,
    // so no page reload is needed. Fire-and-forget, as it was when inlined here.
    if (isVectFoxEnabled(settings)) {
        runNetworkStartup(settings);
    } else {
        log.lifecycle('VectFox: master switch OFF — skipping backend/network startup');
    }

    // Register event handlers. Each wrapper stamps _lastChatTriggerEvent so that
    // when the debounce fires, synchronizeChat knows which event coalesced last —
    // currently only used to suppress the auto-sync popup on MESSAGE_SENT.
    // Master switch OFF → nothing is scheduled. synchronizeChat checks the switch
    // again when the debounce fires, covering a switch-off inside that window.
    const trigger = (name) => () => {
        if (!isVectFoxEnabled(settings)) return;
        _lastChatTriggerEvent = name;
        onChatEvent();
    };
    eventSource.on(event_types.MESSAGE_DELETED, trigger('MESSAGE_DELETED'));
    eventSource.on(event_types.MESSAGE_SENT, trigger('MESSAGE_SENT'));
    eventSource.on(event_types.MESSAGE_RECEIVED, trigger('MESSAGE_RECEIVED'));
    eventSource.on(event_types.MESSAGE_SWIPED, trigger('MESSAGE_SWIPED'));

    // When chat changes, refresh UI state to match settings. Also runs while the master
    // switch is OFF so the panel shows the current chat; refreshAutoSyncCheckbox then
    // reads cached state only and never calls the backend.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (isVectFoxEnabled(settings)) log.lifecycle('VectFox: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
    });
    // A renamed chat keeps its collections' locks (§2.2 of vectfox-multi-collection-per-chat.md).
    eventSource.on(event_types.CHAT_RENAMED, followChatRenameOfCollections);

    // Keep the ghosting WI-scan floor accurate: refresh the cached deepest per-entry World
    // Info scanDepth whenever the active books or WI settings change (off the hot path, so
    // applyGhosting never takes out a message a deep-scanning WI entry still needs to read).
    // Debounced — WORLDINFO_UPDATED can fire in bursts while editing, and each refresh loads
    // lore. Initial call is direct so the floor is correct before the first generation.
    // The refresh does nothing while the master switch is OFF; switching ON re-runs it.
    const refreshWiDepth = () => refreshWorldInfoEntryDepthCache(settings);
    refreshWiDepth();
    const refreshWiDepthDebounced = debounce(refreshWiDepth, debounce_timeout.relaxed);
    eventSource.on(event_types.CHAT_CHANGED, refreshWiDepthDebounced);
    eventSource.on(event_types.WORLDINFO_UPDATED, refreshWiDepthDebounced);
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, refreshWiDepthDebounced);

    // Last: VectFox.isReady() turns true, the public calls answer from the settings, and vectfox_ready goes out once
    announcePublicApiReady(settings);

    log.lifecycle('VectFox: ✅ Initialized successfully');
});

/**
 * Lifecycle hook: called by SillyTavern after a successful extension update.
 * Forces a full page reload so the browser fetches the new JS/CSS files
 * instead of serving stale cached versions.
 */
export async function onUpdate() {
    log.lifecycle('VectFox: Update detected — reloading page to clear module cache');
    location.reload();
}
