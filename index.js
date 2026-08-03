/**
 * ============================================================================
 * VECTFOX - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import {
    eventSource,
    event_types,
    extension_prompt_types,
} from '../../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
} from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

// VectFox modules - Core
import { synchronizeChat, rearrangeChat } from './core/chat-vectorization.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, cleanupCorruptedCollections } from './core/collection-loader.js';
import { migrateLegacyApiKeys } from './core/api-keys.js';
import { migration_setting_name_for_connection } from './Migration/mg_setting_name_for_connection.js';
import { migration_embedding_source_key } from './Migration/mg_embedding_source_key.js';
import { migration_world_info_threshold_rrf_workaround, WORLD_INFO_THRESHOLD_DEFAULT } from './Migration/mg_world_info_threshold_rrf_workaround.js';
import { log } from './core/log.js';
import { isVectFoxEnabled } from './core/feature-gate.js';
import { runNetworkStartup } from './core/network-startup.js';

// VectFox modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox } from './ui/ui-manager.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { initializeWorldInfoIntegration } from './core/world-info-integration.js';
import { refreshWorldInfoEntryDepthCache } from './core/summarizer-injection.js';
import { CJK_TOKENIZER_MODES, setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded } from './core/bm25-scorer.js';

// SillyTavern display label — NOT the settings key. For settings, use 'vectfox' (lowercase).
const MODULE_NAME = 'VectFox';

// Default settings
const defaultSettings = {
    // Master switch — when false, VectFox does no automatic runtime work
    // (retrieval injection, auto-sync, lorebook WI injection). Default ON.
    // Single source of truth for reads: core/feature-gate.js::isVectFoxEnabled.
    enabled: true,

    // Core vector settings
    embedding_provider: 'transformers', // embedding provider selection (was `source` pre-Phase-B)
    vector_backend: 'qdrant', // Backend: 'standard' (ST Vectra) | 'qdrant'
    qdrant_host: '127.0.0.1',
    qdrant_port: 6333,
    qdrant_url: '',
    // Qdrant API key: stored in ST's secret_state custom slot 'api_key_qdrant'
    // post-2026-05-26 migration. NOT in defaults — keeping it here would cause
    // the Object.assign re-introduction loop documented on the vLLM keys. The
    // Similharity plugin reads the slot server-side; the UI presence indicator
    // round-trips via /api/plugins/similharity/qdrant/key-status. Migration
    // drains any legacy settings.qdrant_api_key plaintext on first load.
    // Reader: core/api-keys.js::getQdrantApiKey (transition-fallback only),
    // core/api-keys.js::fetchQdrantApiKeyPresence (canonical presence check).
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    embedding_ollama_url: '',
    embedding_ollama_url_override: false,
    // ollama_api_key removed 2026-05-26: ST has no SECRET_KEYS.OLLAMA and no
    // ollama auth path in additional-headers.js — the field was dead code on
    // both sides. Migration in core/api-keys.js drains-and-deletes any
    // leftover plaintext from settings.json on first load post-upgrade.
    embedding_vllm_url: '',
    embedding_vllm_url_override: false,
    rate_limit_calls: 60,
    rate_limit_interval: 60, // seconds
    // Summarizer (EventBase extraction) + Agent Mode planner share ONE
    // chat-completions rate budget, independent of the embedding limit above.
    // 0 = disabled (no throttle, today's behavior). See core/generation-rate-limiter.js.
    generation_rate_limit_calls: 0,
    generation_rate_limit_interval: 60, // seconds

    // VEC-6: Batch insert optimization
    insert_batch_size: 50, // Chunks per insert batch (50-100 recommended)
    document_glossary_injection: true, // Document content type only: prepend "Full Name (ACRONYM)" definitions to chunks that reference a bare acronym without it. See core/glossary-extractor.js.
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    electronhub_model: 'text-embedding-3-small',
    embedding_openrouter_model: 'openai/text-embedding-3-large',
    // OpenRouter key: stored in SECRET_KEYS.OPENROUTER (ST's shared slot, not in
    // defaults). Reader: core/api-keys.js::getOpenRouterApiKey. The legacy
    // plaintext slot used to live here as `openrouter_api_key: ''` but kept
    // re-appearing in settings.json — every UI handler does
    // Object.assign(extension_settings.vectfox, settings) which would re-add
    // any default-declared empty field after migrateLegacyApiKeys() deleted it.
    cohere_model: 'embed-english-v3.0',
    embedding_ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    embedding_vllm_model: '',
    // vLLM key: stored in ST's SECRET_KEYS.CUSTOM (chat-side, via
    // chat_completion_source: 'custom' proxy) AND SECRET_KEYS.VLLM
    // (embedding-side, via ST's vector handler). Dual-write from VectFox UI
    // preserves the "one shared key" UX. NO plaintext field in settings.json
    // post-2026-05-26. Migration drains any legacy `vllm_api_key` plaintext
    // into both slots on first load. Reader: core/api-keys.js::getCustomApiKey
    // (presence/masked-value indicator only; real key lives server-side).
    webllm_model: '',
    google_model: 'text-embedding-005',

    // Chat vectorization
    enabled_chats: true,
    chunking_strategy: 'per_message', // per_message, conversation_turns, message_batch, adaptive
    batch_size: 4, // Messages per batch for message_batch strategy
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 5,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    // Number of top results to retrieve from vector DB (top-K)
    top_k: 10,
    retrieval_popup_on_start: true,    // Show popup when retrieval starts
    retrieval_popup_on_result: true,   // Show popup with number of retrieved results
    query: 2,
    chunk_size: 500, // For adaptive strategy only
    score_threshold: 0.25,

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

    // Keyword extraction level for INGESTION (chat history vectorization) — not retrieval
    keyword_extraction_level: 'balanced', // 'off', 'minimal', 'balanced', 'aggressive'

    // Summarization before vectorization
    chat_provider: 'openrouter', // 'openrouter', 'vllm'
    // summarize_openrouter_api_key and summarize_vllm_api_key are NOT in
    // defaults — they're legacy plaintext fields drained by
    // migrateLegacyApiKeys() into SECRET_KEYS.OPENROUTER and
    // SECRET_KEYS.CUSTOM (chat-side) + SECRET_KEYS.VLLM (embedding-side)
    // respectively. Keeping them here would cause the same Object.assign
    // re-introduction loop documented above on the embedding-side keys.
    // Readers: core/api-keys.js helpers.
    chat_model: '',              // Model ID for summarization (e.g. 'google/gemini-flash-1.5-8b')
    chat_vllm_url: '',           // vLLM base URL for summarization (e.g. 'http://127.0.0.1:8000')
    summarize_prompt: '',             // Custom prompt template (empty = use built-in default)
    summarize_timeout_ms: 30000,      // Per-call timeout for one "Summarize Before Store" request (ms). Separate from eventbase_timeout_ms (extraction); both share the same model. UI: EventBase tab.

    // Chat-completion request shape — applies to EVERY LLM feature (summarizer,
    // EventBase extraction, Auto-Reformat, Agent Mode), because one install talks
    // to one chat endpoint family. Reasoning models (gpt-5.x, o1/o3/o4 and hosted
    // builds on them) reject `temperature` and `max_tokens` outright; these two
    // switches reshape the body for them. Reader: resolveModelParameterStyle()
    // in core/llm-provider-call.js. Defaults keep the classic OpenAI shape.
    should_send_temperature: true,            // false = omit `temperature` from the request entirely
    should_use_max_completion_tokens: false,  // true = send `max_completion_tokens` instead of `max_tokens`

    // Hybrid Search fusion settings.
    // A1 (BM25 re-rank, Vectra) reads hybrid_fusion_method/weights when invoked via A2 client-side hybrid.
    // A3 (Qdrant native sparse + RRF) ignores them — fusion is server-side via Qdrant /points/query.
    hybrid_fusion_method: 'rrf',        // 'rrf' (Reciprocal Rank Fusion) or 'weighted' — A2 only
    hybrid_vector_weight: 0.5,          // Weight for vector scores (0-1) — A2 weighted mode only
    hybrid_text_weight: 0.5,            // Weight for text/BM25 scores (0-1) — A2 weighted mode only
    hybrid_rrf_k: 60,                   // RRF constant — A2 only (Qdrant uses its own default)
    hybrid_native_prefer: true,         // KEPT (no UI): A3 vs A2 selector for backends that support both. Default = prefer native.

    // RAG Prompt Context (Global level)
    // Wraps ALL injected content with context prompts and/or XML tags
    rag_context: '',      // Natural language context shown before all RAG content
    rag_xml_tag: 'VectFoxMemory',      // XML tag to wrap all RAG content (e.g., "retrieved_context")

    // Collection-level metadata (managed by collection-metadata.js)
    collections: {},

    // Collection registry (list of known collection IDs)
    vectfox_collection_registry: [],

    // World Info Integration
    enabled_world_info: false,          // Enable semantic WI activation
    world_info_threshold: 0.3,          // Score threshold for WI activation
    world_info_top_k: 3,                // Max entries to activate per lorebook
    world_info_query_depth: 3,          // Recent messages to use for query
    world_info_retrieval_popup: false,  // Show popup toast when WI lorebook entries are retrieved
    world_info_respect_entry_disable: true, // Semantic WI: drop hits whose live lorebook entry is disabled (see resolveLiveEntries)

    // Keyword Extraction
    custom_stopwords: '',               // Custom stopwords (comma-separated)
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
    // plans/autosync-settle-lag.md.
    eventbase_autosync_settle_lag: true,
    // Summarizer Injection (Feature B): when enabled, inject the most recent N
    // EventBase events (by source_window_end desc) into the prompt every turn,
    // wrapped in <VectFoxSummarizer> tags — word-for-word-ish recent-turn memory,
    // independent of semantic retrieval. Only meaningful with auto-sync active, so
    // it lives on the AutoSync tab and forces the auto-sync window to 1 turn while on.
    summarizer_injection_enabled: false,
    summarizer_injection_count: 20,               // recent events to inject; range 1-50
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
    // Ghosting (ephemeral prompt wipe): when enabled AND Summarizer Injection is on,
    // keep the most recent N messages verbatim and blank ALL older already-vectorized
    // messages from the OUTGOING prompt only. The chat file + UI are untouched and the
    // effect resets every generation (nothing to undo, branch-safe — mirrors the proven
    // interceptor-wipe pattern). Trades raw old context for token savings, leaning on
    // EventBase memory (summarizer injection + semantic retrieval) for the wiped span.
    // "Keep last N" auto-scales to any chat length (wipe count = tip − N), so a 50-reply
    // and a 5000-reply chat use the same setting. Gated to Summarizer Injection because
    // that forces auto-sync window=1, guaranteeing every message below the vectorization
    // tip is extracted before it could be wiped.
    eventbase_ghost_enabled: false,
    eventbase_ghost_keep_recent: 10,              // recent messages kept verbatim; everything older that's vectorized is wiped. range 0-100 (summarizer injects ~20 events to cover the wiped span)
    // Per-chat marker: auto-sync only processes windows whose start >= marker.
    // Stamped at "max(source_window_end across existing events) + 1" when auto-sync
    // is enabled on a non-empty collection, or at current chat length when collection
    // is empty. Prevents the windowFingerprint cache from triggering a full re-extraction
    // when the user changes window_size before enabling auto-sync.
    // Keyed by chat UUID.
    eventbase_autosync_start_marker: {},
    // Per-chat record of the window_size that was last used for a successful extraction
    // run. Used by the Vectorize Content → Continue path to detect window-size changes
    // and warn the user before triggering a full re-extraction.
    // Keyed by chat UUID.
    eventbase_last_used_window_size: {},
    // Per-chat persisted vectorization tip (= max(source_window_end)+1, the first
    // uncovered message). Persisted so the "N msgs vectorized" display is correct
    // immediately after a reload WITHOUT a backend probe — benefits standard+plugin
    // and qdrant+plugin users. Keyed by chat UUID. See core/eventbase-store.js.
    eventbase_vectorization_tip: {},
    eventbase_min_importance_store: 3,            // Drop events below this importance before storing
    eventbase_max_events_per_window: 3,           // Hard cap on events returned per LLM call
    eventbase_retrieval_top_k: 10,                // Events to retrieve per generation
    eventbase_retrieval_min_importance: 1,        // Minimum importance for retrieval
    eventbase_injection_format: 'densetext',      // Injection format: 'densetext' or 'jsonarray'
    eventbase_retrieval_filters_enabled: true,
    eventbase_autosync_popup: true,               // Show popup toast when auto-sync extraction runs
    autosync_show_progress_modal: false,          // Show progress modal popup during auto-sync (default: silent)
    chat_lock_index: {},                          // Reverse index: chatId -> [collectionId, ...] for O(1) tab lookups
    // ─── Logging (core/log.js) ──────────────────────────────────────────
    // Verbosity dropdown — single noise floor for the whole pipeline.
    // 'off' (default) | 'lifecycle' | 'verbose' | 'trace'. Errors/warnings
    // always fire regardless. See plans/logging-levels-and-classification.md.
    debug_verbosity: 'off',
    // Orthogonal per-subsystem deep-dives, independent of debug_verbosity.
    // Keys must match LOG_DOMAINS in core/log.js. All default off.
    debug_domain: {
        raw_llm: false,     // per-window raw LLM text + parser candidate dumps
        qdrant: false,      // native hybrid keyword/fusion diagnostics
        standard: false,    // similharity plugin internals
        injection: false,   // Chunk Path: what got injected, where, why
        agent: false,       // agent-mode planner / per-query hits
        rerank: false,      // native vs JS re-rank comparison
    },
    // Legacy debug flags below are KEPT as settings keys (some non-log code
    // still reads eventbase_compare_rerank etc.), but the pure log-gate flags
    // (eventbase_debug_logging, debug_vectorizing_log, *_debug, ...) are no
    // longer consulted for logging — core/log.js ignores them. No migration
    // shim (user decision 2026-05-30).
    eventbase_debug_logging: false,
    eventbase_raw_llm_debug: false,              // Raw LLM reply + parser candidate logs (very noisy, per-window)
    vector_group_embedding_call: true,           // Path-agnostic insert toggle. true = legacy batched POST (1 POST per batch, cheaper, default — proven safe in production wire conditions when paired with hedge). false = parallel-split (1 POST per item, failure-contained, but N× the connection surface area which can amplify upstream routing stalls). Affects every call to insertVectorItems (EventBase ingestion AND content/document vectorization).
    vector_hedge_after_ms: 15000,                // 0 = hedge disabled. Default 15000 (15s) fires a duplicate request when an embedding POST hasn't returned by the threshold; race-first-wins. Helps multi-upstream gateways (OpenRouter, SiliconFlow via vllm slot) recover from connection-level routing stalls in seconds instead of 120s. Skipped for local providers (ollama/transformers/llamacpp/koboldcpp). See plans/embedding-resilience-hedge-and-diagnostics.md §6.
    eventbase_disable_pipeline: false,           // false = pipelined extract↔insert (default, ~35% faster). true = serial (each batch finishes embedding before the next starts extracting; safer on slower vector DB backends). Read-site (eventbase-workflow.js) treats anything except explicit true as pipelined.
    eventbase_debug_qdrant_backend: false,
    debug_vectorizing_log: false,                // Verbose vectorization progress logs in console
    eventbase_custom_prompt: '',                  // Custom extraction prompt (empty = use built-in default)
    // Re-rank weights (sum is normalized to 1.0 at runtime)
    eventbase_rerank_w_cosine: 0.55,
    eventbase_rerank_w_importance: 0.20,
    eventbase_rerank_w_persist: 0.15,
    eventbase_rerank_w_recency: 0.10,

    // Anchor boost: flat additive bonus when an event's keyword appears verbatim
    // in the user's last message. Rescues historically-distant events the user
    // explicitly asks about. Slider 0.00-0.50, default 0.20 (selected from
    // 4-run grid benchmarking — see plans/agentic-retrieval-plan.md notes).
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
    // Default off until eval window passes. Requires Qdrant 1.13+; falls back
    // gracefully to the JS re-rank pipeline when the route returns an error.
    // See plans/qdrant-native-eventbase-rerank-formula.md.
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
    // Optional LLM planner step that consumes pre-search candidates plus
    // recent chat context and emits 1-4 follow-up queries which fan out in
    // parallel against Qdrant. Purely additive — never replaces the existing
    // flow. A3 (Qdrant) only. See plans/agentic-retrieval-plan.md.
    agentic_retrieval_enabled: false,                  // Master toggle (default OFF)
    agent_provider: '',                    // '' → inherit chat_provider
    agent_model: '',                       // '' → inherit chat_model
    // agentic_retrieval_openrouter_api_key and agentic_retrieval_vllm_api_key
    // are NOT in defaults — same Object.assign re-introduction reason as the
    // other legacy *_api_key slots above. Migration drains them into
    // SECRET_KEYS.OPENROUTER and SECRET_KEYS.CUSTOM + SECRET_KEYS.VLLM
    // (dual-write for vLLM, see embedding/chat split in api-keys.js header).
    agent_vllm_url: '',                    // '' → inherit chat_vllm_url
    agentic_retrieval_chat_depth: 3,                   // # of past chat turns sent to planner (slider 1-10)
    agentic_retrieval_candidates_to_show: 12,          // Pre-search slice shown to planner (slider 5-20)
    agentic_retrieval_max_queries: 6,                  // Hard ceiling on planner output (slider 1-6)
    agentic_retrieval_timeout_ms: 30000,               // Planner LLM call timeout (matches summarize default; some models need >5s)
    agentic_retrieval_query_timeout_ms: 10000,         // Per-query fanout timeout — drop a straggling Qdrant call so one slow embed/search doesn't stall retrieval
    agentic_filters_enabled: true,                     // Apply planner-emitted *_any / importance_gte filters (Phase 1.5)

    // ─── Auto-Reformat (Document/URL/Wiki) ──────────────────────────────
    // Optional, per-session LLM pass offered in Vectorize Content for
    // Document/URL/Wiki sources. Reads the source, classifies content into
    // named-entity vs. topic/lore records via a self-tagged schema, and
    // emits the final chunks directly (bypassing the mechanical strategy
    // picker for that run) once the user reviews and accepts a full
    // before/after diff. See core/reformat-schema.js / reformat-extractor.js
    // / reformat-store.js. Independent from EventBase (chat's LLM pipeline)
    // by design — no shared pipeline code, only generic utilities.
    reformat_provider: '',              // '' → inherit chat_provider (Core → LLM Summarization)
    reformat_model: '',                 // '' → inherit chat_model
    reformat_vllm_url: '',              // '' → inherit chat_vllm_url
    reformat_batch_chars: 6000,         // Target input chars per LLM call (packer)
    reformat_max_output_tokens: 8000,
    reformat_temperature: 0.2,
    reformat_timeout_ms: 90000,
    reformat_concurrency: 2,            // Parallel batch chains
    reformat_max_body_chars: 2000,      // Oversize-entity ceiling — falls back to the adaptive splitter above this
    reformat_name_fuzzy_threshold: 0.8, // Hallucination guardrail — min similarity to count a name as source-grounded
    reformat_custom_prompt: '',

    // ─── Hidden / Power-User ────────────────────────────────────────────
    // SUPERADMIN MODE — no GUI toggle. Set to true by hand-editing settings.json
    // (the `vectfox` block under SillyTavern's extension_settings) to enable.
    // When true, the Database Browser bypasses ALL persona / handle ID filtering
    // and shows EVERY collection on the server regardless of creatorHandle. Locking
    // a foreign collection then works normally. Intended for dev / debugging /
    // multi-persona admin scenarios. Do not expose in the UI — this is a tripwire,
    // not a feature.
    superadmin: false,
};

// Runtime settings (merged with saved settings)
let settings = { ...defaultSettings };

// Module worker for automatic syncing
const moduleWorker = new ModuleWorkerWrapper(() => synchronizeChat(settings, getBatchSize(), _lastChatTriggerEvent));

// Batch size based on provider
const getBatchSize = () => ['transformers', 'ollama'].includes(settings.embedding_provider) ? 1 : 5;

// Most recent SillyTavern event that triggered the debounced chat-event handler.
// Read by synchronizeChat to suppress the auto-sync popup on MESSAGE_SENT (so the
// popup only appears after the AI's reply arrives, never mid-generation).
// If the debounce coalesces SENT+RECEIVED within one window, the later event wins.
let _lastChatTriggerEvent = null;

// Chat event handler (debounced). Each registration below sets the trigger flag
// before invoking this, so the debounced fire knows what coalesced into it.
const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * Generation interceptor - searches and injects relevant messages
 */
async function vectfox_rearrangeChat(chat, _contextSize, _abort, type) {
    await rearrangeChat(chat, settings, type);
}

// Export to window for ST to call
window['vectfox_rearrangeChat'] = vectfox_rearrangeChat;

/**
 * Action: Sync Chat — shortcut to the Vectorize Content screen.
 *
 * Rather than running a parallel `vectorizeAll` here, this just opens the
 * Vectorize Content modal (chat tab), whose "Resume" button is the single,
 * mobile-tested vectorization path. Keeping Sync Chat as a shortcut to that
 * screen — instead of its own code — removes the risk of the two drifting.
 */
async function onVectorizeAllClick() {
    const { openContentVectorizer } = await import('./ui/content-vectorizer.js');
    openContentVectorizer('chat');
}

/**
 * Action: Full purge - wipes ALL vector data and settings
 */
async function onPurgeClick() {
    const confirmed = confirm(
        'WARNING: This will delete ALL vector data and reset VectFox settings.\n\n' +
        'This cannot be undone. Continue?'
    );

    if (!confirmed) {
        toastr.info('Purge cancelled');
        return;
    }

    try {
        const { getRequestHeaders } = await import('../../../../script.js');

        // 1. Delete entire vectors folder
        await fetch('/api/plugins/similharity/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        // 2. Clear extension_settings.vectfox
        for (const key in extension_settings.vectfox) {
            if (key !== 'enabled') {
                delete extension_settings.vectfox[key];
            }
        }

        // 3. Save settings
        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        toastr.success('All vector data purged', 'Purge Complete');

    } catch (error) {
        log.error('VectFox: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message);
    }
}

/**
 * Action: Cleanup corrupted/ST-native collections from disk
 */
async function onCleanupCorruptedClick() {
    const confirmed = confirm(
        'This deletes corrupted prefix-stacked collections and ST-native file_* attachments\n' +
        'from disk. Useful when reply latency is dominated by ghost collections.\n\n' +
        'Cannot be undone. Continue?'
    );
    if (!confirmed) {
        toastr.info('Cleanup cancelled');
        return;
    }

    try {
        const result = await cleanupCorruptedCollections();
        if (result.total === 0) {
            toastr.info('No corrupted or ST-native file collections found');
            return;
        }

        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        const failed = result.purged.filter(p => !p.ok).length;
        const succeeded = result.purged.length - failed;
        const summary = `Purged ${succeeded}/${result.total} (${result.corruption} corrupted, ${result.stFile} ST-native file). ${failed > 0 ? failed + ' failed.' : ''}`;
        if (failed === 0) {
            toastr.success(summary, 'Cleanup Complete');
        } else {
            toastr.warning(summary, 'Cleanup Partial');
        }
    } catch (error) {
        log.error('VectFox: Cleanup failed:', error);
        toastr.error('Cleanup failed: ' + error.message);
    }
}

/**
 * Action: Run diagnostics - opens the diagnostics modal
 */
function onRunDiagnosticsClick() {
    openDiagnosticsModal();
}

/**
 * Initialize VectFox extension
 */
jQuery(async () => {
    log.lifecycle('VectFox: Initializing...');

    // Load saved settings
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = defaultSettings;
    }

    // Merge saved settings with defaults
    settings = {
        ...defaultSettings,
        ...extension_settings.vectfox,
        collections: {
            ...defaultSettings.collections,
            ...extension_settings.vectfox.collections
        }
    };

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
        // Persist deletions synchronously (NOT debounced). Migrations are
        // one-shot at init and the user may reload before a debounced save
        // would flush — leaving settings.json with stale legacy fields even
        // though extension_settings.vectfox is clean in memory. Confirmed
        // 2026-05-26 against a user whose summarize_openrouter_api_key /
        // summarize_vllm_api_key persisted on disk across multiple reloads
        // because the debounced save never fired before page close.
        const { saveSettings } = await import('../../../../script.js');
        await saveSettings();
    }

    // Connection-setting naming convention (Phase A) — rename the convention-less
    // LLM/embedding keys to the `<consumer>_<provider>_<field>` scheme
    // (embedding_* / chat_* / agent_*). Runs AFTER the eventbase→chat copy above
    // so any legacy summarize_* / agentic_retrieval_* / *_alt_endpoint_url +
    // *_model keys still on disk are renamed here. Idempotent, in-memory only,
    // no I/O. See Migration/mg_setting_name_for_connection.js +
    // plans/settings-naming-convention-migration.md. (Phase B — `source` →
    // `embedding_provider` — is a separate migration, intentionally not here.)
    const _connRename = migration_setting_name_for_connection(extension_settings.vectfox);
    if (_connRename.migrated > 0) {
        log.lifecycle(`VectFox: Renamed ${_connRename.migrated} connection setting key(s): ${_connRename.keys.join(', ')}`);
        // Persist immediately (not debounced) — same reload-safety reason as the
        // eventbase block above (R5 in the plan's crash-safety checklist).
        const { saveSettings } = await import('../../../../script.js');
        await saveSettings();
    }

    // Phase B: rename the highest-churn embedding key `source` → `embedding_provider`.
    // Separate migration from Phase A (its blast radius spans nearly every backend/
    // query/UI path). Idempotent, in-memory only. See Migration/mg_embedding_source_key.js.
    const _srcRename = migration_embedding_source_key(extension_settings.vectfox);
    if (_srcRename.migrated > 0) {
        log.lifecycle('VectFox: Renamed embedding `source` → `embedding_provider`');
        const { saveSettings } = await import('../../../../script.js');
        await saveSettings();
    }

    // One-time reset of world_info_threshold values tuned against raw RRF scores
    // (the 0.0x workaround for issue #11). Qdrant hybrid now returns cosine, so a
    // 0.0x gate would flip from "makes Qdrant work" to "inject everything".
    // Run-once via stamp — see Migration/mg_world_info_threshold_rrf_workaround.js.
    const _thresholdReset = migration_world_info_threshold_rrf_workaround(extension_settings.vectfox);
    if (_thresholdReset.migrated) {
        log.lifecycle(`VectFox: Reset world_info_threshold ${_thresholdReset.from} → ${WORLD_INFO_THRESHOLD_DEFAULT} (value was a workaround for the pre-cosine RRF score scale)`);
        try {
            toastr.info(
                `Your Lorebook similarity threshold (${_thresholdReset.from}) was a workaround for a scoring bug that is now fixed — scores are real 0-1 similarities on every backend. It has been reset to the default ${WORLD_INFO_THRESHOLD_DEFAULT}.`,
                'VectFox — setting updated',
                { timeOut: 15000 },
            );
        } catch (_) { /* toastr unavailable (headless) — the log line stands alone */ }
    }
    if (_thresholdReset.stamped) {
        const { saveSettings } = await import('../../../../script.js');
        await saveSettings();
    }

    // H-1 one-shot migration (2026-05-24): move plaintext *_api_key values
    // from settings.json to ST secret_state. Runs AFTER the eventbase →
    // summarize copy above so any user who only had eventbase_* set gets
    // the value migrated correctly. Idempotent: empty fields = no-op.
    // See plans/review-fix.md §H-1 and core/api-keys.js for the full design.
    try {
        await migrateLegacyApiKeys();
    } catch (err) {
        log.warn('[VectFox] migrateLegacyApiKeys failed:', err?.message || err);
        // Non-fatal — readers fall back to legacy plaintext slots if migration didn't complete.
    }

    // CRITICAL: re-sync the local `settings` from the now-cleaned
    // extension_settings.vectfox. The spread at line 412 captured the PRE-
    // migration state including any legacy *_api_key empty strings the user
    // had on disk. Every UI handler does Object.assign(extension_settings.vectfox,
    // settings) — without this re-sync, the first UI interaction copies the
    // legacy fields back into extension_settings.vectfox and they get saved
    // again, defeating the migration. Tracked symptom: settings.json kept the
    // empty summarize_openrouter_api_key / summarize_vllm_api_key fields even
    // after migration logged success on every reload.
    settings = {
        ...defaultSettings,
        ...extension_settings.vectfox,
        collections: {
            ...defaultSettings.collections,
            ...extension_settings.vectfox.collections,
        },
    };

    // Migrate empty rag_xml_tag to default value
    if (!settings.rag_xml_tag) {
        settings.rag_xml_tag = 'VectFoxMemory';
        extension_settings.vectfox.rag_xml_tag = 'VectFoxMemory';
    }

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

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
        onPurge: onPurgeClick,
        onCleanupCorrupted: onCleanupCorruptedClick,
        onRunDiagnostics: onRunDiagnosticsClick,
    });

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize visualizer
    initializeVisualizer();

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // Initialize world info integration hooks
    initializeWorldInfoIntegration();

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
    const trigger = (name) => () => { _lastChatTriggerEvent = name; onChatEvent(); };
    eventSource.on(event_types.MESSAGE_DELETED, trigger('MESSAGE_DELETED'));
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, trigger('MESSAGE_SENT'));
    eventSource.on(event_types.MESSAGE_RECEIVED, trigger('MESSAGE_RECEIVED'));
    eventSource.on(event_types.MESSAGE_SWIPED, trigger('MESSAGE_SWIPED'));

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.embedding_provider === 'webllm' && manifest?.display_name === 'WebLLM') {
            log.lifecycle('VectFox: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        log.lifecycle('VectFox: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
    });

    // Keep the ghosting WI-scan floor accurate: refresh the cached deepest per-entry World
    // Info scanDepth whenever the active books or WI settings change (off the hot path, so
    // applyGhosting never blanks a message a deep-scanning WI entry still needs to read).
    // Debounced — WORLDINFO_UPDATED can fire in bursts while editing, and each refresh loads
    // lore. Initial call is direct so the floor is correct before the first generation.
    refreshWorldInfoEntryDepthCache();
    const refreshWiDepthDebounced = debounce(refreshWorldInfoEntryDepthCache, debounce_timeout.relaxed);
    eventSource.on(event_types.CHAT_CHANGED, refreshWiDepthDebounced);
    eventSource.on(event_types.WORLDINFO_UPDATED, refreshWiDepthDebounced);
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, refreshWiDepthDebounced);

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
