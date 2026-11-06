# Dev Helper

## 1) Pipeline Architecture — Strict Path Separation

EventBase is the **exclusive** retrieval path for chat content: chat history (live and uploaded archive `.jsonl`) always goes through EventBase ingestion + retrieval. There is no chunk path for chat.

### Three pipelines, strict ownership

| Pipeline                      | Content scope                                                                                        | Owned collections                                  | Code entry point                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| **EventBase pipeline**        | Chat history only (live chat + archive`.jsonl`)                                                      | `vf_eventbase_*`, `vf_archiveevent_*`              | `eventbase-workflow.js` → `eventbase-retrieval.js`   |
| **Lorebook WI pipeline**      | Lorebooks / World Info                                                                               | `vf_lorebook_*`                                    | `world-info-integration.js` (injects `<VectFoxLorebook>`) |
| **Standard (Chunk) pipeline** | Other non-chat content — Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts | `vf_character_*`, `vf_document_*`, user collections | `chat-vectorization.js` → `queryAndMergeCollections` |

The pipelines never see each other's content. There is no overlap in collection prefixes or content types.

### Key isolation rule (`src/features/chunkbase/chat-vectorization.js` → `gatherCollectionsToQuery`)

- `vf_eventbase_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vf_archiveevent_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vf_lorebook_*` → **always** skipped by the standard pipeline (the Lorebook WI pipeline owns them)
- There is no chat chunk collection type, so nothing else needs excluding.

### Archive Chat History — Two content paths

| Path              | Content Type in UI      | Collection prefix        | Storage format                               | Retrieval                     |
| ----------------- | ----------------------- | ------------------------ | -------------------------------------------- | ----------------------------- |
| **A — EventBase** | `Chat → Upload` tab     | `vf_archiveevent_*`      | Event-shaped (same schema as live EventBase) | Phase A (EventBase re-ranker) |
| **B — Chunk**     | `Document` content type | `vf_document_*`          | Chunk-shaped                                 | Phase B (standard pipeline)   |

Archive event collections are **not** auto-locked to any chat after ingestion. Users must manually check "Active for current chat" on the collection card to activate retrieval for a given chat.

### Why this matters

Querying an EventBase collection through the standard pipeline as well would retrieve it twice per generation — once as structured events (with dedup depth) and once as raw chunks — and inject duplicate content. The strict split rules that out.

---

## 2) Extraction Level Location

Extraction levels are defined in: `src/features/keyword-search/keyword-boost.js`

Exact export name:
`EXTRACTION_LEVELS`

```javascript
export const EXTRACTION_LEVELS = {
    off: {
        label: 'Off',
        description: 'No auto-extraction, only WI trigger keys',
        enabled: false,
    },
    minimal: {
        label: 'Minimal',
        description: 'First 1500 chars, max 5 keywords',
        enabled: true,
        headerSize: 1500,
        minFrequency: 1,
        maxKeywords: 5,
    },
    balanced: {
        label: 'Balanced',
        description: 'First 5000 chars, max 12 keywords',
        enabled: true,
        headerSize: 5000,
        minFrequency: 1,
        maxKeywords: 12,
    },
    aggressive: {
        label: 'Aggressive',
        description: 'Full text scan, max 15 keywords',
        enabled: true,
        headerSize: null, // null = full text
        minFrequency: 1,
        maxKeywords: 15,
    },
};
```

## 4) EventBase Window Dedup — Fingerprint Cache

### How it works (O(1), no DB query)

Two-tier storage:

| Tier          | Where                                                              | Shape                          | When built                                                                                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| **Persisted** | `extension_settings.vectfox.eventbase_extracted_windows[chatUUID]` | Flat`string[]` of fingerprints | Written each time a window is marked;`saveSettingsDebounced()` flushes to disk              |
| **In-memory** | `_windowCacheSet` (module-scope `Map<chatUUID, Set<fingerprint>>`) | `Set<string>` per chat         | Lazily built on first access from the persisted array; mutated in-place on subsequent marks |

The persisted array is what survives a reload. The `Set` is what makes the lookup actually O(1) — `array.includes` would be O(N) and chats with thousands of windows would degrade.

- **Fingerprint format:** sorted source hashes joined by comma, e.g. `"123,456,789"` (built by `windowFingerprint(hashes)`)
- **On extraction:** `markWindowExtracted(sourceHashes, chatUUID)` — adds the fingerprint to both the in-memory Set AND the persisted array, then calls `saveSettingsDebounced()`. Called in `eventbase-workflow.js` after each successful `insertEvents`.
- **On dedup check:** `isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID)` — async signature (kept for API compat; `messageIds` and `settings` are ignored). Returns `set.has(fp)` from the in-memory Set — synchronous, O(1).
- **Quick-exit check:** `isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn)` — checks just the *last* window. Avoids building the full window list when nothing needs work. Used as a pre-flight gate before the per-window loop. A hit says nothing about earlier windows, because a run carries on past a failed one.
- **Failed windows:** `markWindowUnfinished(sourceHashes, chatUUID)` writes the fingerprint to `extension_settings.vectfox.eventbase_unfinished_windows[chatUUID]`, and `markWindowExtracted` takes it off. `getUnfinishedWindowFingerprints(chatUUID, windowSize)` reads the windows of one size, counting the hashes in each fingerprint. The re-send rules are in [Doc/collection_helper.md](collection_helper.md), under "When a window fails".
- **Cache invalidation:** `clearWindowCacheForChat(chatUUID)` drops the in-memory Set entry, the persisted array and the unfinished record for one chat. `clearExtractionCachesForChat` clears it together with the vectorization tip, and runs when an EventBase collection is deleted or imported (`clearCachesForDeletedOrImportedCollection`), so the next read and the next vectorization run go by what the collection holds now.
- **Why NOT chat_metadata:** `chat_metadata` is only saved to disk when ST saves the chat (e.g. when a message is generated). Stopping mid-vectorization and reloading Chrome would lose all fingerprints written during that run. `extension_settings` + `saveSettingsDebounced` persists immediately.

### Key files

- `src/features/eventbase/eventbase-store.js` — `markWindowExtracted`, `markWindowUnfinished`, `getUnfinishedWindowFingerprints`, `forgetUnfinishedWindowsNotInChat`, `isWindowAlreadyExtracted`, `isLastWindowExtracted`, `clearWindowCacheForChat`, `windowFingerprint`, plus the private `_windowCacheSet` map
- `src/features/eventbase/eventbase-workflow.js` — calls `isLastWindowExtracted` as the pre-flight gate, `isWindowAlreadyExtracted` per-window inside the loop, `markWindowExtracted` after `insertEvents` succeeds, and `markWindowUnfinished` for each window that fails

---

## 5) GUI Settings — Tab Placement & EventBase Relevance

Settings are grouped by which path consumes them:

| Setting                                                                                  | UI tab                      | EventBase relevant? | What it actually does                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Insert Batch Size** (default 50)                                                       | ChunkBase → Ingestion       | **No**              | Max chunks per insert request for API embedding sources (see §6); local Transformers / Ollama / llama.cpp always send 1 chunk per request. Also the client-side embedding batch size for WebLLM / KoboldCpp. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Skip Already-Visible Events** (`deduplication_depth`, default 0 = off)                                                    | Core                        | **Yes**             | Used in`eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. Also used by chunk-path retrieval in `chat-vectorization.js`. |
| **Hybrid Search & BM25 block** (Keyword Scoring Method, BM25 k1/b, Fusion Method, RRF K) | Core → Hybrid Search & BM25 | **A1/A2 only**      | These are Vectra (Standard backend) controls. On Qdrant, hybrid is always A3 server-side native — k1/b/RRF K are managed by Qdrant's`modifier: idf` and the `fusion: rrf` API, and these UI knobs have no effect. EventBase callers inject `ebSettings` with `keyword_scoring_method` overridden from `eventbase_keyword_scoring_method` (internal, defaults `'bm25'`, not in UI). See §11 for the full matrix. |
| **Query Keyword Budget** (`hybrid_keyword_level`)                                        | ChunkBase → Keyword Budget  | **No**              | Read only by`scoreResults()` (A1) and `hybridSearch()` (A2). A3 doesn't use it — the sparse-vector encoder tokenizes the full query and Qdrant handles IDF weighting. EventBase has its own importance/persist/recency re-ranker that dominates the final order anyway. |

---

## 6) Similharity Plugin — How One Insert Request Is Embedded

Plugin: `../similharity/index.js`, `getVectorsForSource(...)`. One insert request carries N texts; the embedding source decides how they are embedded (T = one embedding call):

| Source | How the N texts are embedded | Time for one request |
| --- | --- | --- |
| `openai`, `openrouter`, `togetherai`, `mistral`, `electronhub` | one batched `/embeddings` call per 100 texts (`getOpenAIBatchVector`) | about T |
| `nomicai`, `cohere` | N single-text calls in parallel (`Promise.all`) | about T, but N calls against the provider's limits |
| every other source, including `vllm` and the local `transformers` / `ollama` / `llamacpp` | one after another | about N × T |

VectFox side (`insertVectorItems` in `src/features/vector-backend/vector-api.js`):

- Local GPU sources (`transformers`, `ollama`, `llamacpp`) always send 1 item per insert request, so the 120s request timeout bounds one embedding and an item that fails to embed fails only its own request. `insert_batch_size` and the embedding API rate limit (`rate_limit_calls` / `rate_limit_interval`) do not apply to them.
- API sources send up to `insert_batch_size` items per request while `vector_group_embedding_call` is on (default) or a rate limit is set; otherwise each item is its own request, fired in parallel waves (parallel-split).
- A grouped `vllm` request therefore costs about N × T inside one request.

---

## 6.5) EventBase Ingestion — Pipelined Extract / Insert

Design: `InternalProject/Vectfox/plans/executed/eventbase-extract-insert-pipeline.md`.

The `runEventBaseIngestion` loop in `src/features/eventbase/eventbase-workflow.js` overlaps extraction and insertion. The extract phase and the insert phase use independent infrastructure (the LLM HTTP lane and the vector-store HTTP lane), so a serial loop — dispatch 8 extracts, await all, await the batched insert, next 8 — would leave each lane idle while the other works.

### How it works

`runEventBaseIngestion` runs a single-slot pipeline coordinator. At any moment, at most one extract batch AND one insert batch are in flight. When batch N's extract resolves, its result is queued; the coordinator immediately fires (a) batch N's insert AND (b) batch N+1's extract in the same iteration tick. They run concurrently. The steady-state cycle is `max(extract_phase, insert_phase)` instead of `extract_phase + insert_phase`.

Three private helpers inside `runEventBaseIngestion` hold the logic — no separate module, no exported API:

| Helper | Role |
|---|---|
| `_runOneExtractBatch(slice, batchFirstIdx)` | The per-window extract logic (Promise.allSettled on 8 LLM calls), as a function the coordinator calls as a black box. Returns `{ allEvents, hashesToMark, endsExtracted, batchResults, ... }`. |
| `_insertWithRetry(events, batchFirstIdx)` | Wraps `insertEvents` with up to 3 attempts and exponential-ish backoff (500ms / 1000ms). On exhaustion throws `EventBaseFatalError` with `code: 'insert_failed_max_retries'` carrying Qdrant's error text. UI catch in `src/features/chunkbase/content-vectorizer.js::_runEventBaseBackfill` surfaces it via `callGenericPopup`. |
| `_finalizeBatch(extractResult)` | Calls `_insertWithRetry`, then `markWindowExtracted` + `setVectorizationTip` in that order, then tally + progress updates. The state-mutation order is the "no corrupted state" invariant — we never mark a window as covered before its events are durable in Qdrant. |

### The coordinator (state machine)

Four state variables: `nextBatchFirstIdx` (cursor), `pendingExtract`, `pendingInsert`, `queuedResult`. Order is load-bearing:

```js
while (true) {
    // Dispatch INSERT FIRST so queuedResult clears, then dispatch EXTRACT
    // against the updated state. The reverse order has queuedResult block
    // the new extract in the same tick the insert is about to consume it.
    if (!pendingInsert && queuedResult !== null) { /* start insert */ }
    if (!pendingExtract && nextBatchFirstIdx < windows.length) { /* start extract */ }
    if (!pendingExtract && !pendingInsert) break;

    const winner = await Promise.race([extractKey, insertKey].filter(Boolean));
    // extract resolved → set queuedResult
    // insert resolved → fold tally, fire _updateProgressAfterFinalize
}
```

The insert-first ordering is load-bearing: checking whether an extract can start against the pre-iteration `queuedResult` blocks the new extract on the result the insert is about to drain, and the pipeline silently degrades to serial (22-second batches instead of 12).

### Throughput

LLM extract (~10–12s p50, up to ~22s p99 per window) dominates insert (~5–8s), so each insert hides under the next extract and a full run takes about 35% less wall time than a serial loop (about 25 instead of 40 minutes on a 2,382-message chat). If extract were faster than insert the win would be insert-bounded instead; either way the steady-state cycle is the longer of the two phases, not their sum.

### What this design deliberately doesn't do

- **No multi-slot queue.** Single-slot captures the full steady-state win; deeper queue would only add memory pressure and complicate abort. The slow stage always gates throughput regardless of buffer depth.
- **No speculative re-issue of slow LLM calls.** Even with perfect pipelining, one 22s window in a batch of 8 pins wall time at 22s. That is the next lever if speed matters more: race a duplicate request after a threshold and take whichever returns first, at the cost of tokens on tail windows.
- **No per-window insert.** Per-window inserts break the Similharity plugin's embedding batching and run N× slower; inserts stay coalesced per batch.
- **No data shape changes.** The pipeline does not touch the EventBase schema, the Qdrant payload or retrieval semantics.

### Abort behavior

Pressing Stop mid-pipeline waits for the in-flight insert to complete before exiting (~6s latency), then fires `progressTracker.complete(false, 'Stopped by user')`. Any in-flight extract is awaited and discarded (its events were never inserted). Any `queuedResult` is discarded (same reason). On the next run, those windows re-extract from a clean state — the fingerprint cache wasn't updated for them, so dedup correctly identifies them as new. This is the "no corrupted state" invariant in action.

### Compatibility with other code paths

The coordinator lives entirely inside `runEventBaseIngestion`. All 3 production callers (auto-sync via `synchronizeChat`, manual backfill via `vectorizeAll`, archive file upload) hit the same helper and get the pipelined behavior — they pass different flags (`isAutoSync`, `suppressAutoSyncPopup`, `parallelWindows`, `collectionIdOverride`). None of those flags interact with the extract/insert ordering. The chunk-base pipeline (lorebook / character / document / URL / wiki / YouTube via `vectorizeContent`) does not use it — it has no extract phase to overlap (chunking is synchronous and instant, and the entire chunk list is inserted in one call).

### Key files

- `src/features/eventbase/eventbase-workflow.js` — the coordinator + helpers
- `src/features/chunkbase/content-vectorizer.js::_runEventBaseBackfill` — catch branch for the `insert_failed_max_retries` popup
- `InternalProject/Vectfox/plans/executed/eventbase-extract-insert-pipeline.md` — design, edge-case table, acceptance criteria

---

## 6.8) Embedding-Call Resilience — Group / Hedge / Pipelined

Three related features sit inside `insertVectorItems` ([`src/features/vector-backend/vector-api.js`](../src/features/vector-backend/vector-api.js)) and the EventBase coordinator ([`src/features/eventbase/eventbase-workflow.js`](../src/features/eventbase/eventbase-workflow.js)). All three affect every embedding caller — EventBase ingestion AND chunk-based document vectorization in [`src/features/chunkbase/content-vectorization.js`](../src/features/chunkbase/content-vectorization.js). UI lives in the **Core tab → Embedding section** (Group + Hedge) and **EventBase tab** (Serial).

### Defaults

| Checkbox | Setting key | Default | Wire shape |
|---|---|---|---|
| Group embedding calls | `vector_group_embedding_call` | ☑ **true** | 1 POST per batch |
| Hedge slow embedding calls | `vector_hedge_after_ms` | ☑ **15000** | Duplicate fires at 15s if primary stalls |
| Serial extract→insert | `eventbase_disable_pipeline` | ☐ **false** | Pipelined extract↔insert overlap |

Group is on by default: hedge protects against connection-level stalls, and one batched POST is a smaller blast surface (1 connection per wave) than N parallel POSTs (N connections per wave) when the upstream gateway routes by connection. Turning Group off is the one-click rescue if upstream starts returning batch-wide 500s.

### Group embedding calls (`vector_group_embedding_call`)

**Checked (default):** all items in a batch ship in one POST to ST's `/api/vector/insert`. Cheaper (fewer API calls), a smaller connection surface for hedge to protect, best on healthy cloud APIs. Downside: one stuck item hangs the whole batch until hedge fires.

**Unchecked:** parallel-split — each item gets its own HTTP POST, fired in parallel waves of up to 16. Containment-focused: a stuck upstream worker only blocks that one item. N× the connection surface; on bursty cloud APIs with connection-affinity routing this can amplify routing stalls rather than escape them.

Skipped automatically for local providers (Ollama already uses batch=1) and rate-limited setups (`dynamicRateLimiter` requires serial execution). The setting is independent of hedge — see _Composition_ below.

### Hedge slow embedding calls (`vector_hedge_after_ms`)

**Checked (default = 15000ms):** if an embedding POST hasn't returned in 15s, fire a duplicate request on a fresh HTTP connection. Race-first-wins via Promise — whichever finishes first settles the call. Late losers harmlessly upsert the same Qdrant point with identical data (hash-deterministic on event_id). Helps multi-upstream gateways (OpenRouter, SiliconFlow behind the `vllm` slot) recover from connection-level routing stalls in seconds instead of waiting through ST's 120s timeout.

**Unchecked = 0ms:** disabled. Insert call goes directly without hedge wrapper.

Gated to skip `localGpuSources` (Ollama / transformers / llama.cpp / KoboldCpp) regardless of the setting — a new connection to a local single-endpoint server wouldn't change routing. UI label intentionally drops the per-provider list to keep the hint short; the runtime gate is the authoritative behavior.

**Where hedge fires (write path only).** There is exactly ONE `callWithHedge` call site: inside `insertVectorItems` ([vector-api.js:541](../src/features/vector-backend/vector-api.js#L541)) — the embedding **write** path. Everything that ingests goes through it and inherits hedge for free:

| Operation | Hedges? | Path |
|---|---|---|
| Manual **Vectorize Content** (chat → EventBase) | ✅ | `src/features/chunkbase/content-vectorizer.js` → `runEventBaseIngestion` → `insertEvents` → `insertVectorItems` |
| Manual **Vectorize Content** (chunks: lorebook / docs / URLs / wiki) | ✅ | `content-vectorization.js` → `insertVectorItems` |
| **Auto-Sync** | ✅ | `synchronizeChat` → `runEventBaseIngestion({ isAutoSync: true })` → `insertEvents` → `insertVectorItems` |
| **Retrieval / per-turn search** | ❌ | `queryCollection` → `getQueryVector` (embeds the query once, one retry on failure) → every route and fallback reuses that vector. No hedge wrapper anywhere on this path. |
| **Agent Mode** | ❌ | `agentic-retrieval.js` only calls `queryCollection` / `retrieveEvents` — it never inserts, so it never reaches the hedge. |

Note that **auto-sync is not a separate path** — it's the same `runEventBaseIngestion → insertVectorItems` chain as the manual button, just invoked with `isAutoSync: true`, so it gets the same protection: a stalled embedding write hurts equally whether the user clicked the button or an ST message event triggered it.

**Why search and Agent Mode are deliberately NOT hedged:**

1. **Read vs. write asymmetry in stall exposure.** Ingestion fires hundreds of embedding POSTs over minutes — the probability that *at least one* lands on a stuck upstream worker is high, and a single stall freezes the whole run until ST's ~120s timeout. A retrieval embeds **one** short query and returns in well under the 15s hedge threshold; the exposure window hedge is designed to catch barely exists on the read side.
2. **The 15s threshold is longer than a healthy query.** Hedge only fires *after* 15s of silence. A normal query-embed + vector search completes in a fraction of that, so in practice hedge would almost never trigger on a search even if it were wired in — it'd be dead weight on the hot path.
3. **A stalled search fails soft; a stalled ingest fails expensive.** If a retrieval embed genuinely hangs, the cost is one turn with degraded/no memory injection — annoying but self-correcting on the next message. A hung ingest wastes minutes of a long batch run and can leave the user staring at a frozen progress bar. Hedge's value is highest exactly where the blast radius is largest.
4. **Idempotency only holds for writes.** Hedge's "fire a duplicate, race-first-wins, discard the loser" trick is safe because a duplicate **write** is a no-op (hash-deterministic Qdrant upsert overwrites the same point with identical data). A duplicate **query** isn't harmful, but it also buys nothing — you'd just pay for two embeds to shave time off a path that's already fast (see #2). Agent Mode compounds this: it already fans out 1–4 parallel queries, so adding per-query hedging would multiply planner-stage API cost for no latency win on an already-parallel, already-fast stage.

**Read-path timeout.** The read path is hardened with a plain per-turn timeout rather than the hedge race — the hedge machinery (4 attempts over 60s, hedge-fatal escape, Continue-to-resume) is tuned for long write batches and would be overkill for a one-shot read. Every per-turn retrieval runs through `runBoundedRetrieval()` ([`src/features/vector-backend/bounded-retrieval.js`](../src/features/vector-backend/bounded-retrieval.js)): in `rearrangeChat()` (the generation interceptor in [`src/features/chunkbase/chat-vectorization.js`](../src/features/chunkbase/chat-vectorization.js), which ST calls as `vectfox_rearrangeChat`, the manifest's `generate_interceptor`) the EventBase retrieval (`runEventBaseRetrieval`), the summarizer injection and the chunk retrieval (`queryAndMergeCollections` → `queryCollection`: chunks, lorebooks, documents); and the Lorebook WI lookup and its dry run in [`src/features/world-info/world-info-integration.js`](../src/features/world-info/world-info-integration.js). The budget is the `retrieval_timeout_ms` setting (Core tab → Retrieval), read through `resolveRetrievalTimeoutMs()` ([src/shared/retrieval-budget.js](../src/shared/retrieval-budget.js)); its default, `RETRIEVAL_TIMEOUT_DEFAULT_MS = 15000` ([src/shared/constants.js](../src/shared/constants.js)), matches the write-side hedge threshold for one consistent "too slow" number. EventBase adds the Agent Mode budget on top (`resolveEventBaseRetrievalTimeoutMs()`).

It's a **soft** timeout (Promise.race): on expiry the turn proceeds and the message sends WITHOUT that memory source — `runBoundedRetrieval` catches the timeout or error, logs it, toasts the user, and returns the caller's fallback (the chunk path's is `[]`, so downstream injects nothing). The orphaned `fetch` keeps running until ST's server-side timeout reaps it — there is no client `AbortSignal` on the read fetches, so this is a "stop waiting", not a "cancel the request". A stall is not retried: a stalled retrieval fails soft (one turn without memory, self-corrects next message), so a single bounded attempt is the right tradeoff. A query embedding that FAILS (e.g. a provider 429 "The engine is currently overloaded") is different — it fails fast, so `getQueryVector` ([src/features/vector-backend/vector-api.js](../src/features/vector-backend/vector-api.js)) retries it once, then fails the query. That is the only retry on the read path: the query is embedded once and every route and fallback reuses that vector, so a fallback never re-embeds.

Agent Mode is covered by the same `rearrangeChat` outer bound (its fan-out `queryCollection` calls run inside that hook), and additionally bounds its planner LLM call separately via `AbortSignal.timeout(agentic_retrieval_timeout_ms)` ([agentic-retrieval.js](../src/features/eventbase/agentic-retrieval.js)) — that one IS a hard cancel because it's a fresh fetch the agent code owns directly.

**Independence from Group setting.** Hedge wraps whatever payload is on the wire — 1 item or 50 items. With Group=ON, one hedge fire rescues the entire batch. With Group=OFF, hedge fires per-item independently. Both work; Group=ON has higher ROI per hedge fire.

### Hedge-fatal escape

After 4 fresh-connection attempts in 60s with no success, `callWithHedge` throws an error with `name === 'HedgeFatalError'` and `isHedgeFatal === true`. Both `RETRY_CONFIG.shouldRetry` and `_insertWithRetry` (the outer EventBase retry in `eventbase-workflow.js`) check this flag and skip retrying — more retries would just trigger another 60s of identical hedging against the same broken upstream. User presses Continue button later to resume; the existing window-cache semantics ensure no duplicates on resume thanks to hash-deterministic Qdrant upserts.

### Serial extract→insert (`eventbase_disable_pipeline`)

**Unchecked (default):** pipelined coordinator. Batch N's insert overlaps batch N+1's extract via a single-slot queue — about 35% less wall time when extract dominates insert (the common case).

**Checked:** serial — each batch finishes embedding before the next batch starts extracting. Slightly higher event yield on very bursty cloud APIs, where pipelining can create per-key contention.

Read-site semantics: `settings?.eventbase_disable_pipeline === true` (`eventbase-workflow.js:201`). Only an explicit `true` enables serial; missing/false/undefined gives pipelined.

### Composition

| Layer | Behavior with hedge enabled |
|---|---|
| Coordinator (EventBase pipelined or serial) | Hedge-fatal bubbles up as a fatal; windows stay unmarked; user resumes via Continue. |
| Outer `_insertWithRetry` (pipelined mode) | Catches anything except AbortError AND hedge-fatal. Hedge-fatal escapes the 3-attempt outer retry budget. |
| Inner `retry` (`src/shared/retry.js`) | `shouldRetry` returns false for hedge-fatal. Otherwise retries on TimeoutError + the keyword set in `RETRY_CONFIG.shouldRetry`. |
| Hedge (`callWithHedge`) | Primary at t=0, hedge at t=15s, 30s, 45s. Hard fatal cutoff at t=60s. AbortError short-circuits the entire race so Stop button cancels within microseconds (no 60s of spam). |
| Parallel-split wave composite (Group=OFF only) | If ANY individual failure is `isHedgeFatal=true`, the composite Error inherits the flag — outer retry short-circuits instead of burning ~12min/wave on a wave certain to fail again. |
| Backend `insertVectorItems` (similharity → ST → provider → Qdrant) | One call per hedge invocation. |

### Standard-backend safety — coalesce + queue

The **Standard backend** (ST's Vectra via similharity plugin) cannot tolerate high HTTP concurrency — the plugin's response handling corrupts under concurrent load: 12 simultaneous parallel-split POSTs + hedge produce 2.1 MB truncated-JSON 500s from the plugin (`[similharity] chunks/insert error: SyntaxError: Unexpected non-whitespace character after JSON at position 2140978`) plus on-disk Vectra index corruption, likely from HTTP/2 response-buffer multiplexing.

[`src/features/vector-backend/standard.js`](../src/features/vector-backend/standard.js) absorbs concurrent calls into one batched POST per concurrency window via two layers:

1. **Coalesce** — single-item calls arriving within `COALESCE_DELAY_MS` (5ms) for the same `collectionId` get merged back into one batched POST. This keeps "1 POST per concurrency window" on this backend even when Group=OFF (parallel-split) is active. State: `_pendingCoalesce: Map<collectionId, {items, resolvers, settings, abortSignal, timer}>`.
2. **Queue** — the resulting batched POSTs serialize per-collection via a Promise chain. Handles hedge duplicates (a 15s-later hedge POST would race the primary if not serialized), multi-item callers that bypass coalesce, and any future concurrent caller. State: `_vectraWriteQueues: Map<collectionId, Promise>`.

Both maps key by `collectionId`, so unrelated collections still run in parallel. Coalesce + queue are invisible to `insertVectorItems` callers.

So standard-backend users can run all 3 features (Group / Hedge / Pipelined) at their defaults without tripping the plugin bug.

### Key files

- [`src/features/vector-backend/vector-api.js`](../src/features/vector-backend/vector-api.js) — `callWithHedge` helper + `shouldRetry` filter + `makeProcessBatch` wiring + AbortError short-circuit
- [`src/features/eventbase/eventbase-workflow.js`](../src/features/eventbase/eventbase-workflow.js) `_insertWithRetry` — hedge-fatal short-circuit; `disablePipeline` read-site
- [`src/features/vector-backend/standard.js`](../src/features/vector-backend/standard.js) — coalesce + per-collection write queue
- [`src/features/settings-panel/settings-panel.js`](../src/features/settings-panel/settings-panel.js) — Core tab → Embedding section (Group, Hedge) + EventBase tab (Serial)
- [`src/index.js`](../src/index.js) — defaults
- `InternalProject/Vectfox/plans/executed/embedding-resilience-hedge-and-diagnostics.md` — design, observed failure modes, acceptance criteria

---

## 7) Hybrid Search and EventBase

Recency on the EventBase side is the `_recencyBonus` term of the 4-weight re-ranker in [`eventbase-retrieval.js`](../src/features/eventbase/eventbase-retrieval.js), computed from `source_window_end` and `chatLength`.

### hybrid-search.js — Used indirectly (do not wire directly)

**Module:** [`src/features/vector-backend/hybrid-search.js`](../src/features/vector-backend/hybrid-search.js)
**Decision:** ✅ EventBase benefits from it — but through `queryCollection()`, not by direct call.

EventBase retrieval (`retrieveEvents()` in `src/features/eventbase/eventbase-retrieval.js`) calls `queryCollection()` directly (via an `ebSettings` shim that pins `keyword_scoring_method` to `eventbase_keyword_scoring_method || 'bm25'`). Inside `queryCollection()`, the A1/A2/A3 routing decides whether to invoke `clientSideHybridSearch()` (A2) or the backend's native hybrid (A3, `backend.hybridQuery()`). On Standard backend, EventBase is always A1 unless `eventbase_keyword_scoring_method` is explicitly set to `'hybrid'`. On Qdrant, A3 (native sparse + server-side RRF) is the **only** hybrid path; `hybrid_native_prefer` (hidden settings.json key, default `true`) switches it to A2 for testing.

Do **not** call `hybridSearch()` directly from `eventbase-retrieval.js` or `eventbase-workflow.js`. It operates at the backend/collection layer — returns raw `{ hashes, metadata }` and bypasses `queryCollection()`'s A1/A2/A3 routing, the store schema hydration, and EventBase-specific field population (`score`, `importance`, etc.).

### Summary table

| Module                                      | Add directly to EventBase? | Reason                                                                                               |
| ------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`hybrid-search.js`](../src/features/vector-backend/hybrid-search.js) | No (used indirectly)       | EventBase inherits A2/A3 hybrid automatically via`queryCollection()`. Direct calls would bypass `queryCollection()`'s routing and the store layer. |

---

## 8) Retrieval Paths — A1 / A2 / A3 Comparison

Three retrieval paths exist. The path is chosen automatically inside `queryCollection()` based on (a) backend and (b) `keyword_scoring_method`. EventBase, ChunkBase, and the Query Tester all flow through this same dispatch.

|                                                                                   | **A1 — BM25 re-rank**                                                                                | **A2 — Client-side hybrid**                                                                          | **A3 — Qdrant native** ⭐                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **When active**                                                                   | Standard backend default; or Qdrant + hidden`hybrid_native_prefer=false` + `keyword_scoring_method=bm25` | Standard backend +`keyword_scoring_method=hybrid`; or Qdrant + hidden `hybrid_native_prefer=false` + `hybrid` | Qdrant backend default — the**only** hybrid path on Qdrant                                           |
| **Where it runs**                                                                 | Browser JS                                                                                           | Browser JS                                                                                           | Qdrant server                                                                                        |
| **Candidate set (what BM25 actually scores)**                                     | ANN top-K (`topK × 2`, capped 100)                                                                   | ANN top-K × 3 (capped 100)                                                                           | **Union of dense top-K + sparse top-K** — sparse can surface rare-term docs the dense layer missed   |
| **Retrieval recall ceiling**                                                      | Vector ANN only                                                                                      | Vector ANN only (slightly wider candidate window)                                                    | **Wider** — sparse retrieval finds docs the dense layer missed                                       |
| **BM25 IDF source**                                                               | Toggle:`bm25_use_corpus_idf` — `true` (default) uses **full-corpus df values** cached in browser; `false` uses local df over candidate set only | Same toggle as A1                                                                                    | **Always full-corpus** via Qdrant's `modifier: "idf"` (server-side)                                  |
| **Sparse-vector index**                                                           | None — pure vector ANN                                                                               | None — pure vector ANN                                                                               | Yes —`text_sparse` named vector on every point, built at upsert via FNV-1a-hashed CJK tokens         |
| **Fusion algorithm**                                                              | Weighted linear:`α·vectorScore + β·BM25_norm` (after `BM25/maxBM25`)                                 | RRF (default,`hybrid_rrf_k`=60) **or** weighted; min-max normalization; +0–8% dual-signal bonus; single-signal penalty (×0.55 / ×0.60) | Qdrant-native RRF via`prefetch: [dense, sparse]`, `fusion: "rrf"`. No bonuses, no penalties, no JS post-processing. |
| **Network round-trips per query**                                                 | 1 (vector ANN); +1 one-time per session for cold corpus-stats build when toggle ON                   | Same as A1                                                                                           | **1** (single `/points/query`)                                                                       |
| **Tokenizer**                                                                     | Client-side (Intl.Segmenter / Jieba / Jieba TW / TinySegmenter)                                      | Same                                                                                                 | Client-side at query; locked**per collection** at upsert via sentinel point. Mismatch shows modal and refuses query. |
| **Knobs that apply**                                                              | `bm25_k1`, `bm25_b`, `bm25_use_corpus_idf`, `hybrid_keyword_level`                                   | Above +`hybrid_fusion_method`, `hybrid_vector_weight`, `hybrid_text_weight`, `hybrid_rrf_k`          | None of the above — Qdrant uses its internal defaults                                                |
| **Native EventBase rerank (cosine + importance + persist + recency in one call)** | n/a                                                                                                  | n/a                                                                                                  | Available when`eventbase_native_rerank=true` (default) + Qdrant ≥ 1.13                               |

### ⚠️ Standard backend: vectorScore depends on whether Similharity is installed

What `vectorScore` looks like on standard backend depends on whether the **Similharity plugin** is available — see §15 for the plugin-dependency policy. Two paths, two behaviours:

| Path                     | When                                                                                                 | What `vectorScore` looks like                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Plugin-enhanced**      | `StandardBackend.pluginAvailable === true` (the common case once the plugin is installed)            | Real cosine values come back via `/api/plugins/similharity/chunks/query`. Scores are usable for A2's fusion math. |
| **Degraded (no plugin)** | Fresh ST install without the optional plugin, or `pluginAvailable` forced `false` (TEST 009 scenario) | ST's native `/api/vector/query` computes cosine internally but **strips the scores from the response before returning**. VectFox receives only hashes and text — every `vectorScore` is `0.0000`. Hard ST-upstream limitation. |

The path is picked inside `StandardBackend.queryCollection` based on the runtime `pluginAvailable` flag; A1/A2 path selection itself is unchanged.

#### Plugin-enhanced path (the default)

- **A1 (BM25 re-rank)**: re-ranks the plugin-returned candidates via weighted-sum `0.5·vectorScore + 0.5·normalizedBM25` ([applyBM25Scoring](../src/features/keyword-search/bm25-scorer.js)). The plugin's real cosine values *are* used — this is genuine hybrid scoring, not BM25-only.
- **A2 (client-side hybrid RRF)**: takes the same real `vectorScore` and BM25 inputs as A1, but fuses them via RRF (default) plus a dual-signal bonus (+0–8%) and single-signal penalty (×0.55 vector-only / ×0.60 text-only) ([reciprocalRankFusion](../src/features/vector-backend/hybrid-search.js)). A2 outperforms A1 on the plugin-enhanced path because of the RRF + bonus/penalty math — not because the vector signal becomes "real" (it was real under A1 too).

> **What really differs between A1 and A2 on the plugin path:** both use the *same* real `vectorScore` and the *same* BM25 scoring over the *same* candidate set. The only difference is the **fusion algorithm** — A1 = flat weighted-sum 0.5/0.5, A2 = RRF with dual-signal bonus / single-signal penalty.

#### Degraded path (no plugin)

Every `vectorScore` is 0 here. Both A1 and A2 still work, but they degrade differently:

- **Effect on A1 (BM25 re-rank):** On the degraded path `vectorScore` is 0 (ST strips it), so A1's `0.5·vectorScore + 0.5·normalizedBM25` collapses to `0.5·normalizedBM25` — effectively BM25-only by *arithmetic accident*, not by design. ST's internal similarity still controls *which* candidates come back; A1 just can't use the scores ST stripped, and re-orders the candidate set by BM25.
- **Effect on A2 (client-side hybrid RRF):** A2 cannot use `vectorScore` for fusion (it's always 0), so it falls back to using ST's **rank ordering** as the vector signal instead — via the RRF formula `1 / (k + vectorRank)`. This means:
    - A result that ST placed at rank 1 gets a small RRF boost even with no BM25 match.
    - A result with a BM25 match but weak vector rank gets a small RRF penalty compared to A1.
    - Results with no BM25 match AND weak vector rank score only `rrfRankFactor × 0.25` (very low).
    - Text-only matches (BM25 > 0, vectorScore = 0) are penalized by a ×0.60 multiplier in hybrid-search.js.

**Practical difference between A1 and A2 — degraded path only:**

|                               | A1 (BM25 re-rank)   | A2 (client-side RRF)                                      |
| ----------------------------- | ------------------- | --------------------------------------------------------- |
| Uses ST's similarity ordering | ❌ — discarded      | ✅ — used as`vectorRank` in RRF                           |
| Uses BM25 scores              | ✅ — primary signal | ✅ — secondary signal, penalized ×0.60 if no vector match |
| Penalty on BM25 matches       | None                | ×0.60 (text-only path)                                    |
| Results with zero BM25 match  | Score = 0, dropped  | Score =`0.25 × rrfRankFactor` — may still appear          |
| Predictability                | High                | Lower — rank-based fusion is noisy without real scores    |

**When does the A1/A2 difference matter on the degraded path?**

- **Semantic queries (no keyword overlap):** A1 scores everything 0 — results fall back to arbitrary ordering. A2 uses ST's `vectorRank` as a fallback signal via RRF, preserving ST's internal semantic ordering even without scores. A2 degrades more gracefully here.
- **Keyword queries (BM25 matches exist):** Both paths rank primarily by BM25. A2 adds `vectorRank` as a secondary tie-breaker for results with equal BM25 scores. The ×0.60 penalty is applied uniformly to all results and does not change their relative order — it only affects absolute score values.
- **Score threshold sensitivity:** The ×0.60 penalty lowers all A2 absolute scores. If `score_threshold` is set above zero, A2 may filter out results that A1 would keep. With the default `score_threshold=0` this is not an issue.

#### Recommendation (consolidated)

| User's setup                             | Best path                            | Why                                                                                                  |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Standard + plugin installed** (common) | A2 (Hybrid)                          | Same real `vectorScore` + BM25 inputs as A1, but RRF with dual-signal bonus / single-signal penalty handles imbalanced signals better than A1's flat 0.5/0.5 weighted-sum. |
| **Standard + no plugin** (degraded)      | A2 (Hybrid) is still slightly better | A2 uses ST's rank ordering as a fallback signal; A1 ignores it entirely. The plugin-vs-no-plugin gap is much larger than the A1-vs-A2 gap here. |
| **Qdrant**                               | A3 (native sparse + server-side RRF) | The only hybrid path on Qdrant; full corpus IDF, sparse vector retrieval, no rank-based fallbacks.   |

A1 still has one use case on either standard path: simpler, more predictable scoring for debugging threshold behaviour or isolating the BM25 signal.

### ⚠️ "Corpus-wide IDF" is NOT "Corpus-wide search"

The `bm25_use_corpus_idf` toggle is the source of the most common misconception. It is worth being explicit:

| Question                                                                   | Answer                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Does ON make BM25 score all chunks in the collection?                      | **No.** BM25 still only scores the ANN top-K candidates the vector layer surfaced.                   |
| What does ON actually change?                                              | The**IDF weights** used for the per-query terms. With ON, IDF is computed from corpus-wide df values (e.g. `df(還債)=5 / N=1394`). With OFF, df is recomputed per query against just the local candidate set (e.g. `df(還債)=3 / N=40`) — which biases IDF toward zero whenever the candidates already share the term. |
| How can a doc that doesn't appear in the ANN top-K still affect the score? | It can't be a result. It can only contribute to global df values, which feed into the per-term IDF weights of docs that*are* in the candidate set. |
| What if I want true full-corpus retrieval (find docs that vector missed)?  | Use**A3 (Qdrant)**. Only that path stores a sparse-vector index over every chunk and can match by term across the full collection. The standard backend has no inverted/sparse index. |

So `bm25_use_corpus_idf` should be read as: *"Use corpus df values when computing IDF weights for the candidates BM25 is already scoring."* The toggle improves **scoring quality** within the existing recall window; it does **not** widen the recall window.

#### Cost and lifecycle of the corpus-stats cache

Implemented in [src/features/vector-backend/corpus-stats.js](../src/features/vector-backend/corpus-stats.js). When the toggle is ON:

| Aspect                                                                   | Detail                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Build trigger                                                            | Lazy — first call to`getCorpusStats(collectionId)` per session per collection. Subsequent calls hit a hot Map. |
| Build cost (measured, 1394 chunks Traditional Chinese on Intl.Segmenter) | 674 ms total: fetch=407 ms, parse=57 ms, tokenize+df=210 ms. Logged as`[CorpusStats] Built for ...` with full breakdown. |
| Sustained memory                                                         | ~400 KB per collection:`{ totalDocs, documentFrequencies: Map<term, df>, avgDocLength, builtAt }`. Chunk texts are **not** retained — only the derived statistics. |
| Auto-invalidation                                                        | Fires on`insertVectorItems` / `deleteVectorItems` / `purgeVectorIndex` (vector-api.js) and `insertChunksWithVectors` (collection-export.js import path). Lazy rebuild on next query. |
| Manual clear (force-rebuild for testing)                                 | `(await import('/scripts/extensions/third-party/VectFox/src/features/vector-backend/corpus-stats.js')).clearCorpusStatsCache()` |
| Failure mode                                                             | Best-effort. Module-load or fetch failure logs a warning and falls back to local-IDF BM25 for that query — never discards the underlying vector results. |

#### Why default ON

For typical 1-2k-chunk collections, cold build is sub-second and main-thread freeze is under 300 ms — imperceptible. Steady-state cost is one Map lookup per query token. The ranking benefit is small when EventBase's importance/persist post-rank dominates the score, but the cost is small enough that "default ON" is the right call. Users with very large collections (>10k chunks) where the build starts to bite can flip it off; the scaling threshold and mitigation options (yield-in-loop / Web Worker / server-side df) are noted in the corpus-stats.js header.

### Path selection (decision tree)

```
backend == 'qdrant' ?
  ├─ yes → hybrid_native_prefer !== false (default true) ?
  │         ├─ yes → A3
  │         └─ no  → keyword_scoring_method == 'hybrid' ? A2 : A1
  └─ no (standard/vectra) → keyword_scoring_method == 'hybrid' ? A2 : A1
```

EventBase overrides `keyword_scoring_method` with `eventbase_keyword_scoring_method` (default `'bm25'`) before dispatch, so for EventBase on Standard backend the default is **A1**, not A2.

### Settings reference (consolidated)

| Setting                                                                     | Default                   | Affects                                                        | Notes                                                                                                |
| --------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `keyword_scoring_method` (`bm25` \                                          | `hybrid`)                 | `hybrid`                                                       | ChunkBase A1/A2 selector on Standard backend                                                         |
| `eventbase_keyword_scoring_method`                                          | `bm25`                    | EventBase A1/A2 selector on Standard backend                   | Internal key, not exposed in UI. Override via`extension_settings.vectfox` in console.                |
| `hybrid_native_prefer`                                                      | `true`                    | A3 vs A1/A2 on Qdrant                                          | Hidden — not in UI. JSON-only. Flip to`false` to force client-side path on Qdrant for A/B testing.   |
| `bm25_k1`, `bm25_b`                                                         | 1.5 / 0.75                | A1 and A2 (client-side BM25 internals)                         | BM25+ TF saturation and length normalization. A3 uses Qdrant's internal defaults (these knobs don't reach the server). |
| `bm25_use_corpus_idf`                                                       | **`true`**                | A1 and A2 IDF source                                           | See "Corpus-wide IDF ≠ Corpus-wide search" above. Lazily fetches and caches`{N, df}` map for the entire collection. ~700 ms cold build, ~400 KB sustained. Auto-invalidates on writes. |
| `hybrid_keyword_level` (`minimal` / `balance` / `maximum`)                  | `balance`                 | A1 **and** A2 query keyword budget (30/50/70 tokens)           | Both A1 and A2 call `extractQueryKeywords(query, maxKeywords)` with the same `RETRIEVAL_KEYWORD_LEVELS[level]` budget. A3 unaffected (Qdrant's sparse encoder tokenizes the full query server-side). |
| `hybrid_fusion_method` (`rrf` / `weighted`)                                 | `rrf`                     | A2 fusion algorithm                                            | A1 always uses weighted linear. A3 always uses Qdrant-native RRF (this setting doesn't reach the server). |
| `hybrid_vector_weight`, `hybrid_text_weight`                                | 0.5 / 0.5                 | A2 weighted mode only                                          | Used only when`hybrid_fusion_method = 'weighted'` on Standard backend.                               |
| `hybrid_rrf_k`                                                              | 60                        | A2 RRF mode only                                               | Qdrant uses its own internal default for A3; this knob doesn't reach the server.                     |
| `cjk_tokenizer_mode` (`intl` / `jieba` / `jieba_tw` / `tiny_segmenter`)     | `intl`                    | A3 (locked per Qdrant collection at upsert via sentinel point) | Mismatch between current setting and the collection's locked tokenizer triggers a modal and refuses the query. On A1/A2 the tokenizer is also used but not locked — changing it just means inconsistent tokenization until re-vectorize. |
| `deduplication_depth`                                                       | 0 (disabled)              | All three paths                                                | EventBase context-window dedup: suppress events whose source window falls within the last N messages. Same JS path post-retrieval. |
| `eventbase_retrieval_top_k`                                                 | 10                        | All three paths                                                | Final number of events injected, plus up to 5 that Agent Mode adds; a StoryArc block keeps its own count. Internal overfetch is`top_k × 2 × 2 = 40` for A1 (`getOverfetchAmount` in keyword-boost.js). |
| `eventbase_retrieval_min_importance`                                        | 1                         | All three paths                                                | Drops events below this importance threshold after retrieval.                                        |
| `eventbase_rerank_w_cosine` / `_w_importance` / `_w_persist` / `_w_recency` | 0.55 / 0.20 / 0.15 / 0.10 | All three paths (formula coefficients)                         | A3 with`eventbase_native_rerank=true` applies them server-side via Qdrant formula; A1/A2 apply them in JS in `eventbase-retrieval.js`. |
| `eventbase_native_rerank`                                                   | `true`                    | A3 only                                                        | Pushes the 4-weight formula into the same Qdrant`/points/query` call. Requires Qdrant ≥ 1.13. Set `false` to fall back to JS post-processing. |
| `eventbase_compare_rerank`                                                  | `false`                   | A3 only                                                        | When ON alongside`eventbase_native_rerank`, runs the JS formula path in parallel for every query and logs `overlap@K` + Spearman ρ. Pure observability, doesn't change the injected events. |
| `eventbase_compare_rerank_verbose`                                          | `false`                   | A3 only                                                        | When both compare settings are ON, emits per-event score rows. Very noisy — development only.        |
| `keyword_extraction_level`, `keyword_boost_base_weight`                     | —                         | Ingestion only                                                 | Not used by any retrieval path. Lives elsewhere; listed here so people stop expecting it to affect retrieval. |

### Native Formula Rerank (A3 + Qdrant ≥ 1.13)

When `eventbase_native_rerank = true`, `_runOneLiveQuery()` in
[src/features/eventbase/eventbase-retrieval.js](../src/features/eventbase/eventbase-retrieval.js) calls
`backend.hybridQueryWithRerank()` instead of `backend.hybridQuery()`. This
issues a single Qdrant `/points/query` with the four-weight formula baked in:

```json
{
  "prefetch": [
    { "query": "<denseVector>", "limit": "<prefetchLimit>" },
    { "query": "<sparseVector>", "using": "text_sparse", "limit": "<prefetchLimit>" }
  ],
  "query": {
    "formula": {
      "sum": [
        { "mult": [0.55, { "mult": [1.0, "$score"] }] },
        { "mult": [0.20, { "div": { "left": "importance", "right": 10 } }] },
        { "mult": [0.15, { "key": "should_persist", "match": { "value": true } }] },
        { "mult": [0.10, { "exp_decay": { "x": "source_window_end", "target": "<chatLength>", "scale": "<halfLife>", "midpoint": 0.5 } }] }
      ]
    }
  },
  "filter": { "must_not": [{ "key": "type", "match": { "value": "_vectfox_meta" } }] },
  "limit": "<topK>"
}
```

`$score` is Qdrant's RRF fusion score (peaks at 1.0 when k=1 internally).
The prefetch pool is `prefetchLimit` events (default: `topK × 3`), giving the
formula access to a wider candidate set than the plain RRF top-K — this lets
high-importance/high-recency events that ranked outside the top-K in plain RRF
still surface in the final result.

**What stays client-side even with native rerank:**

- **Anchor boost** — multi-token phrase substring match (e.g. `還債的經過`)
  requires JS; Qdrant tokenizes terms individually and any-of matching would
  miss phrases.
- **Pairwise deduplication** — content-hash overlap across events.
- **Cross-collection merge** — `Promise.all` per collection, concat-dedup-trim.

**Version requirement:** Qdrant ≥ 1.13 for `formula` query support. If the
request fails with a Qdrant error, check the server version and set
`eventbase_native_rerank = false` to fall back to the JS path.

---

## 9) Retrieval Tokenization — Language-Neutral

VectFox's **retrieval** path (BM25 sparse vectors + query keyword extraction) is language-neutral. Two scripts share one set of primitives so the ingest path and the query path can never drift:

| Item              | Value                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Shared primitives | `src/features/keyword-search/script-segmentation.js` — `CJK_SPAN_RE`, `CJK_CHAR_RE`, `KANA_RE`, `LATIN_TOKEN_RE`, `NON_WORD_RE`, `localeForSpan()`, `getSegmenter()` |
| Ingest path       | `src/features/keyword-search/bm25-scorer.js` → `tokenize()` / `encodeSparseVector()` (imports the shared module)            |
| Query path        | `src/features/keyword-search/query-keyword-extractor.js` → `extractQueryKeywords()`, `isCJKToken()` (imports the shared module) |
| Stop-word source  | Per-mode selection via `src/features/keyword-search/language-modes.js` (`LANGUAGE_MODES`) + `isStopWord()` in `./stop-words.js`. Each CJK-tokenizer mode declares its `stopLocales` (e.g. `korean`→`['en','ko']`); only those locale lists are consulted. English is the always-on baseline. |

### How language neutrality works

- **Space-separated scripts** (Latin, Cyrillic, Greek, Arabic, …) tokenize via Unicode-aware matchers: `LATIN_TOKEN_RE` (`\p{L}…`) for query keywords, `NON_WORD_RE` (`[^\p{L}\p{N}_\s]`) for BM25. Accents survive (`café`, `niño`, `résumé` stay whole).
- **Space-less scripts** (CJK Han, Kana, Hangul, Thai, Lao, Myanmar, Khmer) are matched by `CJK_SPAN_RE`, routed to the right `Intl.Segmenter` locale by `localeForSpan()`, and fall back to bigrams when the API is unavailable.
- **Adding a language** = one Unicode range in `CJK_SPAN_RE`/`CJK_CHAR_RE` + one `[/range/, 'locale']` entry in `SCRIPT_LOCALE_MAP`. Nothing else changes.
- **Combining marks** (`\p{M}`) are preserved by `LATIN_TOKEN_RE`/`NON_WORD_RE`, so Indic (matras/virama) and Arabic (harakat) words tokenize as whole units instead of broken fragments.

### Per-mode stop-word selection

Stop-word filtering is **driven by the CJK Tokenizer Mode dropdown**, not a single global union. `src/features/keyword-search/language-modes.js` holds one record per mode with a `stopLocales` array; `tokenize()` (ingest) and `extractQueryKeywords()` (query) both filter via `isStopWord(token, stopLocalesForMode(mode))`. A Korean collection consults `['en','ko']` only, never the Chinese list. Traditional vs Simplified is disambiguated purely by the `jieba_tw`/`jieba` mode split.

- **Adding a language's stop list** = add `ITS_STOP_WORDS` array + one `xx: ITS_STOP_WORDS` line in `STOP_WORDS_BY_LOCALE` (`stop-words.js`) + one record in `LANGUAGE_MODES`. The dropdown, enum, and selection all derive from that array — no other edits.
- **A stop list is additive, never required** — a mode whose `stopLocales` reference no installed list just skips the filter; text still tokenizes/indexes/searches.
- **Qdrant collections vectorized under one union stop list (A3 only):** their sparse vectors may still hold other languages' stop words, while queries filter per mode (always a subset). The only tokens that can drift are another language's stop words inside this collection's text — a coincidence given character-set separation. Not a crash, not data loss, dense search unaffected; re-vectorizing aligns it, and nothing forces it. A1/A2 (standard) recompute BM25 at query time, so they are unaffected.

### Officially supported vs. works-but-unofficial

- **Officially supported: CJK + English.**
- **Works but unofficial:** accented Latin (Spanish, French, Vietnamese…), Cyrillic, Greek, Arabic, Thai, etc. tokenize correctly for BM25, but have **no language-specific stemmer** (Porter is English-only and skipped for CJK) and **no stop-word lists** beyond English + CJK. Quality is "functional, not tuned."

### Scope boundary ⚠️

This applies to **retrieval/tokenization only**. Activation **Triggers and Advanced Conditions** are language-neutral as well — see [§12](#12-trigger--condition-activation--language-neutral). Dense/vector search has always been language-neutral (embeddings are external).

**Note:** `src/features/keyword-search/query-keyword-extractor.js` is the only query keyword extractor: sparse query vectors are computed client-side and sent to the server as `sparseQueryVector`.

---

## 10) JavaScript to read these values in the Chrome console

```js
const ctx = SillyTavern.getContext();
const chatUUID = ctx.chatMetadata?.integrity || ctx.chatId;
const handleId = (ctx.name1 || 'user').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'user';
const charName = (ctx.name2 || 'chat').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'chat';
console.log({ chatUUID, handleId, charName });

// Check current chat's integrity and which EventBase collection it WOULD map to
(() => {
const md = SillyTavern.getContext().chatMetadata;
return {
integrity: md?.integrity || '(missing — using chatId fallback)',
chatFile: SillyTavern.getContext().chatId,
};
})()
```

---

## 11) Hybrid Search & BM25 — GUI Placement Matrix

Backend determines path; on Qdrant there is only one hybrid path (A3). On Standard, the user picks A1 vs A2.

- **ChunkBase** owns non-chat content only: Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts. Uses `keyword_scoring_method`.
- **EventBase** owns chat content only: Current Chat history and uploaded Archive Chat history (`.jsonl`). Uses `eventbase_keyword_scoring_method` (internal, not in UI, defaults `'bm25'`).

Both paths call `queryCollection()` but EventBase callers (`eventbase-retrieval.js`, `eventbase-workflow.js`, `eventbase-store.js`) always inject an `ebSettings` shim:

```js
const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
```

This ensures ChunkBase's `keyword_scoring_method` never leaks into EventBase queries.

### Settings × routing case

| Setting                        | Storage key                        | Applies to                   | **A1** — Standard + BM25                               | **A2** — Standard + Hybrid                             | **A3** — Qdrant native sparse + RRF                                                          |
| ------------------------------ | ---------------------------------- | ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Keyword Scoring Method         | `keyword_scoring_method`           | **ChunkBase only**           | ✅ selects A1 path                                     | ✅ selects A2 path                                     | ❌ ignored — A3 is the only Qdrant path                                                      |
| EventBase Scoring Method       | `eventbase_keyword_scoring_method` | **EventBase only**           | ✅ selects A1 path (Standard)                          | ✅ selects A2 path (Standard)                          | ❌ ignored on Qdrant                                                                         |
| BM25 k1                        | `bm25_k1`                          | Standard only                | ✅ used                                                | ✅ used                                                | ❌ Qdrant`modifier: idf` internal                                                            |
| BM25 b                         | `bm25_b`                           | Standard only                | ✅ used                                                | ✅ used                                                | ❌ Qdrant`modifier: idf` internal                                                            |
| Query Keyword Budget           | `hybrid_keyword_level`             | A1 only                      | ✅ used                                                | ❌ full query tokenized                                | ❌ sparse encoder tokenizes everything                                                       |
| Fusion Method (RRF / Weighted) | `hybrid_fusion_method`             | A2 only                      | ❌ not used (A1 always weighted)                       | ✅ used                                                | ❌ Qdrant always RRF (server-side)                                                           |
| RRF K                          | `hybrid_rrf_k`                     | A2 RRF mode only             | ❌ not used                                            | ✅ used                                                | ❌ Qdrant uses its own default                                                               |
| CJK Tokenizer Mode             | `cjk_tokenizer_mode`               | All paths                    | ✅ used for client-side BM25 tokenization (no locking) | ✅ used for client-side BM25 tokenization (no locking) | ✅ locked into collection at upsert via sentinel point; mismatch modal on query if changed   |
| Prefer Native Backend Hybrid   | `hybrid_native_prefer`             | Hidden settings escape hatch | n/a                                                    | n/a                                                    | Default`true`. Flip to `false` via settings.json to force Qdrant onto A2 for testing. No UI. |

### Key observations

1. **Qdrant has exactly one hybrid path — A3**, with no UI to pick another. A3 runs entirely server-side via Qdrant's `/points/query` endpoint with `prefetch: [dense, sparse]` and `fusion: "rrf"`.
2. **A3 uses globally-accurate IDF.** Qdrant's `modifier: "idf"` computes IDF over the true full corpus (every indexed document), not the ANN-bounded subset. This eliminates the BM25 IDF bias that A1 and A2 carry.
3. **Path routing is content-type-scoped.** ChunkBase's `keyword_scoring_method` does not affect EventBase. Changing to "Hybrid" in ChunkBase tab only switches lorebook queries.
4. **Sparse vectors are tokenizer-locked.** The CJK tokenizer mode at upsert is baked into a sentinel metadata point on each Qdrant collection. Querying after a mode change shows a modal asking the user to revert or re-vectorize.
5. **A1/A2 quality on Standard depends on the Similharity plugin.** With the plugin installed (the common case), Standard backend gets real `vectorScore` values back, so A2 fuses dense + BM25 like a "lite A3". Without the plugin, ST's native `/api/vector/query` strips scores → A2 falls back to rank-based fusion. The path selection doesn't change, but the fusion quality does. See §15 (plugin dependency policy) and §8 ("vectorScore depends on whether Similharity is installed") for the full split.

### GUI hide/show rules

| Backend                       | Visible in Core                                                                                      | Visible in ChunkBase   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| **Qdrant** (A3 — only option) | Native-active notice + CJK Tokenizer Mode dropdown (Keyword Extraction subsection).**Fusion Method and RRF K are hidden** — Qdrant ignores them. | *(no hybrid controls)* |
| **Standard + BM25** (A1)      | Keyword Scoring Method, BM25 k1, BM25 b                                                              | Query Keyword Budget   |
| **Standard + Hybrid** (A2)    | Keyword Scoring Method, BM25 k1, BM25 b, Fusion Method, RRF K                                        | *(no hybrid controls)* |

Notes:

- `hybrid_native_prefer` (default `true`) has no UI; it is an escape hatch for testing A2 against Qdrant.
- Fusion Method and RRF K Constant are hidden on Qdrant because Qdrant runs `fusion: "rrf"` server-side with its own internal k constant; exposing the controls would be misleading. They reappear when the user switches `vector_backend` to Standard (where A2 actually uses them).
- The CJK Tokenizer Mode dropdown lives in the Keyword Extraction subsection (always visible). It's the **only** Hybrid Search & BM25 control that affects A3 — it drives the sparse-vector encoder.
- Visibility is driven by [`updateNativeHybridUI()`](../src/features/settings-panel/settings-panel.js) which fires on changes to `vector_backend` and `keyword_scoring_method`. On Qdrant it always shows the Native-active notice (no toggle).

### Server-side hybrid fusion — yes, fully supported

A3 leverages **all four** of Qdrant's relevant server-side features:

| Qdrant feature                                      | A3 uses it?    | How                                                                                                  |
| --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Dense vector ANN                                    | ✅             | Default unnamed vector slot                                                                          |
| **Sparse vectors** (`modifier: "idf"`)              | ✅             | Named slot`text_sparse`, FNV-1a-hashed token indices, raw TF values; Qdrant computes IDF globally    |
| **Hybrid fusion** (`/points/query` with `prefetch`) | ✅             | Single call with`prefetch: [dense, sparse]`                                                          |
| **Native RRF** (`fusion: "rrf"`)                    | ✅             | Server-side fusion; alternative`"dbsf"` available but unused                                         |
| Reranking pipelines                                 | ✅ (EventBase) | EventBase formula rerank (cosine × RRF + importance + persist + recency) runs**server-side** via `query: { formula: { sum: [...] } }` wrapping the prefetch when `eventbase_native_rerank = true` (Qdrant ≥ 1.13). |

### Cross-reference

- Architecture plan: `InternalProject/Vectfox/plans/executed/qdrant-native-sparse-hybrid-rrf.md`.
- GUI layout plan: `InternalProject/Vectfox/plans/executed/GUI_reorganize.md` §13–§22.
- Routing code: `queryCollection()` at [src/features/vector-backend/vector-api.js](../src/features/vector-backend/vector-api.js).
- A3 client entrypoint: `hybridQuery()` at [src/features/vector-backend/qdrant.js](../src/features/vector-backend/qdrant.js).
- A3 server entrypoint: `hybridQueryNative()` at [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js).
- Sparse encoder: [src/features/vector-backend/sparse-vector-encoder.js](../src/features/vector-backend/sparse-vector-encoder.js).
- Tokenizer lock + mismatch modal: [src/features/vector-backend/tokenizer-lock.js](../src/features/vector-backend/tokenizer-lock.js).
- EventBase invocation: direct `queryCollection` calls in [src/features/eventbase/eventbase-retrieval.js](../src/features/eventbase/eventbase-retrieval.js), [src/features/eventbase/eventbase-workflow.js](../src/features/eventbase/eventbase-workflow.js).

---

## 12) Trigger / Condition Activation — Language-Neutral

Activation Triggers and Advanced Conditions (Collection Settings → Activation panel) are **language-neutral**. They work for CJK (Chinese / Japanese / Korean) stories the same as for English.

### Why it works for any language

**Triggers** and the text-matching conditions (`pattern` / `speaker` / `characterPresent` / `lorebookActive`) match against recent messages with JavaScript `String.includes()` — see `checkTriggers()` in `src/features/collections/collection-metadata.js` and `evaluatePatternCondition()` in `src/features/collections/conditional-activation.js`. Substring matching is inherently language-neutral: `"還債".includes("還債")` is `true` regardless of script or whitespace. There is no tokenization or word-boundary assumption in the plain-string path.

**Numeric / structural conditions** — Message Count, Swipe Count, Time of Day, Generation Type, Group Chat, Random Chance — never inspect text and are trivially language-independent.

**Manual always-on** — "Active for current chat" and Character lock have no language dependency.

### One caveat: user-supplied regex

A trigger or `pattern` value wrapped in `/.../` is run as a real `RegExp`. If *you* type an ASCII word-boundary (`\b`) in that regex, it will not fire between CJK characters — that is a property of the regex you wrote, not of VectFox. For CJK, prefer plain substrings, or use Unicode word boundaries with the `u` flag (e.g. `/\p{L}+/u`).

---

## 13) AgentMode — Agentic Retrieval

Optional LLM planner that runs alongside the EventBase pre-search. It sees recent chat context, not the pre-search's hits, and fans out 1-6 follow-up queries in parallel against Qdrant. **Purely additive — the pre-search keeps every seat it won, and the queries add up to 5 from outside its results.** A3 (Qdrant) only. It does not run under StoryArc mode, whose router, thread pick and block cut use the link model.

### Files

| File                                                        | Role                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [prompts-i18n.js](../src/features/eventbase/prompts-i18n.js) | Planner system prompt per language mode (`_PLANNER_PROMPTS`, read through `getAgenticPlannerPrompt(mode)`) and the user message (`buildPlannerUserMessage`: recent chat + current message). |
| [src/features/eventbase/agentic-retrieval.js](../src/features/eventbase/agentic-retrieval.js)   | Public`retrieveEventsForTurn(params)`, retrieval's one entry point, which decides a turn's path: StoryArc mode, Agent Mode or the plain search. Runs the planner alongside the pre-search and fans out its queries. Includes `_resolveAgenticLLMConfig()` for inheritance from the `chat_*` fields. |
| [src/features/eventbase/planner-seats-core.js](../src/features/eventbase/planner-seats-core.js) | `seatPlannerHits`, the pure rule for the seats the planner's queries add. |
| [src/features/eventbase/eventbase-workflow.js](../src/features/eventbase/eventbase-workflow.js) | Calls `retrieveEventsForTurn` on every turn. |
| [src/features/settings-panel/settings-panel.js](../src/features/settings-panel/settings-panel.js)                     | "AgentMode" tab (peer of Core/EventBase/etc.) with provider/model inheritance, sliders and timeouts. |

### Flow

```
retrieveEventsForTurn(params)
 ├─ StoryArc mode on → router, recipe, or the plain search. No planner
 ├─ Agent Mode off or non-Qdrant → the plain search
 └─ _retrieveWithPlanner(params)
      ├─ retrieveEvents(params)                     (the pre-search, unchanged)
      ├─ _searchPlannedQueries(params), alongside it
      │    LLM input: recent N turns + current user message
      │    LLM output: { queries: string[], rationale: string }
      │    Promise.all of queryCollection per (collection × planner-query)
      └─ seatPlannerHits(...)                       (up to 5 events from outside the pre-search's pool)
```

The result is the pre-search's events, then the added ones. There is no second rerank. An added event passes the same minimum importance, context filter and duplicate rule as the pre-search's.

### Settings (all in `src/index.js` defaults)

```js
agentic_retrieval_enabled                false       // master toggle
agent_provider                           ''          // '' → inherit chat_provider
agent_model                              ''          // '' → inherit chat_model
agent_vllm_url                           ''          // '' → inherit chat_vllm_url
agentic_retrieval_chat_depth             3           // past chat turns sent to the planner (slider 1-10)
agentic_retrieval_max_queries            6           // ceiling on planner queries (slider 1-6)
agentic_retrieval_timeout_ms             30000       // planner LLM call timeout
agentic_retrieval_query_timeout_ms       10000       // per-query fan-out timeout; a straggler is dropped
agentic_retrieval_max_tokens             2000        // planner output-token cap
```

API keys are SillyTavern's own secrets (`SECRET_KEYS.OPENROUTER`, and `CUSTOM` / `VLLM` for vLLM); VectFox has no key settings. Both timeouts run inside the EventBase retrieval bound and are added to it. Inheritance is centralized in `_resolveAgenticLLMConfig(settings)` — read it once, no scattered `||` checks elsewhere.

### Debug log shape

Lines go through `log.domain('agent', level, …)` with the `[VectFox-Agentic]` prefix, so they're greppable and distinct from `[EventBase]` / `[Qdrant]`. Steps 1, 2, 4, 10 and 11 log at `lifecycle`, the rest at `verbose`; the per-turn snippets of step 3 and the per-query lines of step 9 log at `trace`.

Per retrieval round emits, in order:

1. `mode=ON trigger=user_message_len=<N>`
2. `Past chat turns sent to planner: <depth>`
3. `Narrative context preview` — one ~50-word snippet per turn (matches what the planner actually sees, and the count equals `agentic_retrieval_chat_depth`)
4. `LLM prompt size: system+user approx <T> tokens (<a>+<b> chars)` — size only, not the prompt text (the static system prompt is in `prompts-i18n.js`; the narrative-context preview at step 3 shows the dynamic part)
5. `LLM call complete: <ms>ms` — with prompt / completion / total tokens when the provider returns usage
6. `Planner output:` followed by the full JSON response from the LLM (queries, rationale)
7. `Qdrant fanout: <N> queries × <M> collection(s) = <X> parallel calls`
8. `Qdrant fanout complete: <ms>ms`
9. `Per-query hits:` — one line per query with top score
10. `Final: <pre> pre-search seats + <added> added from <hits> planner hits`
11. `Total wall-clock: <ms>ms (LLM=<ms>ms, fanout=<ms>ms)`

Timing buckets:

- LLM call ms (measured around `callLlmForJson`)
- Qdrant fanout ms (measured around the `Promise.all` of `queryCollection` calls)
- Total ms (measured from the start of `_retrieveWithPlanner` until its seats are chosen, so it holds the pre-search too)
- Embedding batch ms — implicit inside each `queryCollection` call; not separately timed

### Failure modes — all fall back to pre-search

| Failure                                                          | Outcome                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `agentic_retrieval_enabled = false`                              | No planner; identical to the plain flow                                     |
| `vector_backend !== 'qdrant'`                                    | Skip; log`mode=SKIPPED reason=requires_qdrant_backend`                      |
| Missing model, API key or vLLM URL                               | Skip; warn `mode=SKIPPED reason=missing_model` / `missing_openrouter_api_key` / `missing_vllm_url` / `missing_vllm_api_key` |
| Planner LLM throws / times out / returns invalid JSON            | Log warn; return pre-search only                                            |
| Planner returns 0 valid queries (after`_validateAndTrimQueries`) | Log; return pre-search only                                                 |
| One of N Qdrant queries fails or exceeds `agentic_retrieval_query_timeout_ms` | That query contributes `[]` (warned); other queries still seat |
| All Qdrant queries fail                                          | No seats added; the pre-search's events stay                                |
| `liveCollectionIds` empty                                        | Skip the fanout; return pre-search                                          |

**Invariant:** AgentMode MUST NEVER produce a worse result than the plain flow. The drop-in shape of `retrieveEventsForTurn` is designed so that on any failure the return value is exactly what `retrieveEvents` would have returned.

### Debug return shape

When AgentMode runs successfully, the returned `debug` object gains:

```js
{
  agenticMode: true,
  agenticQueries: string[],     // validated planner queries that actually ran
  agenticRationale: string,     // planner's one-sentence rationale (for diagnostics)
  agenticLLMMs: number,
  agenticFanoutMs: number,
  agenticTotalMs: number,
  agenticHitCount: number,      // hits across the planner's queries, before seats were chosen
  agenticAddedSeats: number,    // events added beside the pre-search's
}
```

Benchmark and diagnostic tooling can read these fields.

---

## 14) Collections, Locks & Backend Routing

**See [Doc/collection_helper.md](./collection_helper.md).**

Everything related to collection listing, lock state, registry-key construction, backend routing for queries, and the UI checkboxes that mirror lock state is in that file.

If you are about to write code that:

- registers or looks up a collection
- reads or mutates a lock (chat or character)
- queries or deletes vectors for a specific collection
- decides which backend to route a query through
- builds the `backend:collectionId` storage key

…open `collection_helper.md` first. Reimplementing these helpers inline gets them subtly wrong; the doc lists which functions to import instead.

---

## 15) Similharity Plugin — Dependency Policy

The Similharity plugin (`/api/plugins/similharity/*`) is built for Qdrant. Its relationship with the standard backend follows strict rules.

### Cross-repo version check (where to hunt)

VectFox warns when the installed similharity server plugin is older than the version it needs. Code: `checkSimilharityVersion()` in **`src/app/network-startup.js`**, run by the network startup:

- Constant `SIMILHARITY_MIN_VERSION` is a **floor**, not an exact match (`isSimilharityVersionBehind`): a newer plugin build passes. Bump it only when VectFox needs a newer plugin feature.
- The installed version comes from the `/health` probe that `checkPluginAvailable()` already made (`getDetectedPluginVersion()`), so every plugin build reports one at no extra request.
- Below the floor, or no version reported: `log.warn(...)` + a `toastr.warning` telling the user to **restart SillyTavern so it auto-updates the server plugin**, or to reinstall it with git when it came from a ZIP. Soft warning only — init continues.
- No plugin installed → silent; that is a supported setup.

Search hint: grep `SIMILHARITY_MIN_VERSION`.

### Deployment scope — local / LAN only

**VectFox + Similharity is designed for a single-user SillyTavern install on the user's own machine (or private LAN).** It is NOT designed for:

- Public-internet exposure
- Multi-tenant deployments (untrusted users sharing one ST instance)
- Hostile-input environments

This is a deliberate scope, not an oversight. Two consequences a reviewer might flag and how we think about them:

1. **No SSRF defense on plugin embedding-relay routes.** Routes like `getVectorsForSource` accept user-configured URLs (`apiUrl`, `ollama_url`, `vllm_url`) and `fetch()` them server-side without host allowlisting. This is intentional — those URLs are legitimately set to `127.0.0.1` / RFC1918 addresses for self-hosted embedding servers. Adding allowlisting would either break legitimate localhost use OR be cosmetic-only at the plugin layer: anyone on the same LAN who can reach the qdrant port directly already has the same write/query access regardless of what the plugin does. The bigger picture is that **this whole project is designed for personal use, not multi-user**. Even Qdrant's open-source build ships without per-user authentication by default — the multi-user story requires Role-Based Access Control, which is way overkill for someone just trying to get a SillyTavern RAG running on their PC or closed LAN. Requiring it would defeat the "personal use, runs out of the box" point of this project. If your deployment context can't trust everyone on the network boundary, you need RBAC AND plugin-level allowlisting; neither alone is enough, and we're targeting the simpler scope on purpose.
2. **API keys stored plaintext in `settings.json`.** Same threat model: the user owns the machine, the keys are theirs, sharing the file means the user already failed key hygiene. ST itself uses the same pattern for most extension settings.

If you deploy ST in a context where untrusted users share the same instance — be aware of VectFox's limits. ST itself **does** support per-user data isolation via `enableUserAccounts = true` (per-user directories including `vectors/`, password auth, SSO). However, Qdrant ships without per-user authentication — a shared Qdrant instance has no concept of per-user collection ownership, so two ST users on the same Qdrant server can read and write each other's VectFox collections. Use a separate Qdrant instance per user, or container-per-user, if that matters for your deployment.

Full threat-model reasoning: `InternalProject/Vectfox/plans/executed/review-fix.md` §H-4. The plugin's own header (`similharity/index.js`) carries the same scope statement.

### Rule: plugin is Qdrant-native, optional-only on standard

| Backend               | Plugin role                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| **Qdrant**            | Required. All inserts, queries, chunk listing, and management go through the plugin. |
| **Standard (Vectra)** | Optional enhancement only. Standard backend must be fully functional without it.     |

### Standard backend — what the plugin enhances (when installed)

| Feature                       | Without plugin             | With plugin                                                               |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Insert / write                | Native`/api/vector/insert` | Plugin`/chunks/insert` — adds metadata (keywords, importance)             |
| Query / read                  | Native`/api/vector/query`  | Plugin`/chunks/query` — returns metadata alongside results                |
| Chunk listing (View Chunks)   | Not possible               | Plugin`/chunks/list` — full text + metadata                               |
| Chunk editing (text/metadata) | Not possible               | Plugin`/chunks/{hash}/text` + `/metadata`                                 |
| Stats                         | Hash count only            | Plugin`/chunks/stats` — rich stats                                        |
| Collection discovery          | Registry only              | Plugin`/collections` — filesystem scan                                    |

### The rule for new code

- **Standard backend (`src/features/vector-backend/standard.js`):** Every plugin call MUST be gated by `this.pluginAvailable`. Every gated call MUST have a native-API fallback. No unconditional plugin calls.
- **UI and other modules (outside `src/features/vector-backend/`):** Check `browserState.pluginAvailable` (UI) or make an explicit health check before calling plugin endpoints. Show a graceful message if unavailable — never throw an unhandled error.
- **Import/export (`src/features/collections/collection-export.js`):** `insertChunksWithVectors` uses native `/api/vector/insert` for standard backend unconditionally — plugin is never called for inserts on standard backend regardless of plugin availability. This is intentional: standard-backend import must work without the plugin.

### Why the separation matters

Routing standard-backend inserts through the plugin would make import depend on it: users without the plugin could not import collections. The native ST API supports pre-computed vector inserts via an `embeddings` map — there is no reason to route standard backend inserts through the plugin. The plugin's value on standard backend is read-side enhancement (metadata retrieval, chunk listing), not write-side.

### Test-suite coverage matrix — which tests run in which configuration?

The `tests/Eventbase-test.spec.js` suite runs against a live ST instance. Each test has a different relationship with the plugin and the qdrant backend. Tests that can't run on the current environment **soft-skip** (marked ⏭️ in the Playwright report via `test.skip(...)`) rather than failing — this is critical because the suite runs in **serial mode**, and a hard FAIL would halt every subsequent test. A no-plugin user running the full suite would otherwise be stuck at TEST 001 and never reach the standard-backend tests that DO work on their machine.

VectFox runs in **three distinct deployment environments**. Each unlocks a different subset of features and exercises a different code path. The test suite soft-skips tests that aren't applicable to the current environment so users on any of the three setups get a clean `npm run test:e2e` run.

### The 3 environments

| #     | Environment           | Plugin probe                                                  | Qdrant config                                       | Backend in use                                   | Who runs this                                                                            |
| ----- | --------------------- | ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **1** | **No plugin**         | `/api/plugins/similharity/health` returns no-plugin (no JSON) | —                                                   | Standard (vectra), degraded — native ST API only | Fresh ST install. The "minimum viable" deployment.                                       |
| **2** | **Plugin, no qdrant** | `/health` returns `{status: 'ok'}`                            | `qdrant_url`/`qdrant_host` empty                    | Standard (vectra), plugin-enhanced               | User installed the Similharity plugin for richer metadata/scores but doesn't run Qdrant. |
| **3** | **Plugin + qdrant**   | `/health` returns `{status: 'ok'}`                            | `qdrant_url` or `qdrant_host` set, qdrant reachable | Qdrant (full A3 hybrid path)                     | Full production deployment with the entire feature set.                                  |

### Test coverage matrix per environment

Marker key: ✅ runs, ⏭️ soft-skips, — n/a.

| Test       | Description                                                                                          | Case 1 (no plugin)       | Case 2 (plugin, no qdrant)        | Case 3 (plugin + qdrant)          |
| ---------- | ---------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- | --------------------------------- |
| **000**    | Every VectFox file loads from the deployed copy                                                      | ✅                       | ✅                                | ✅                                |
| **001**    | Qdrant lorebook                                                                                      | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **002**    | Qdrant EventBase                                                                                     | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **003**    | E2E qdrant                                                                                           | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **004**    | DB Browser qdrant                                                                                    | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **005**    | Standard lorebook                                                                                    | ✅                       | ✅ (plugin enhances)              | ✅ (plugin enhances)              |
| **006**    | Standard EventBase + parseEmbedText                                                                  | ✅                       | ✅ (plugin enhances)              | ✅ (plugin enhances)              |
| **007**    | E2E standard                                                                                         | ✅                       | ✅ (plugin enhances)              | ✅ (plugin enhances)              |
| **008**    | DB Browser standard + **plugin**                                                                     | ⏭️ no plugin            | ✅                                | ✅                                |
| **009**    | DB Browser standard, **no plugin** path                                                              | ✅                       | ✅ (forces pluginAvailable=false) | ✅ (forces pluginAvailable=false) |
| **010**    | Cross-collection lock isolation (qdrant)                                                             | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **011**    | Cross-persona activation (qdrant)                                                                    | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **012**    | Cross-backend import (qdrant ↔ standard)                                                            | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **013**    | Synthetic E2E qdrant                                                                                 | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **014**    | Auto-sync backfill: fingerprint cache prevents duplicate windows                                     | ✅                       | ✅                                | ✅                                |
| **015**    | Auto-sync window-size change: start marker filters obsolete windows                                  | ✅                       | ✅                                | ✅                                |
| **016**    | `stampAutoSyncMarker` smart placement (Branch A early-exit, B no-candidate, C empty-candidate, re-stamp overwrites) | ✅                       | ✅                                | ✅                                |
| **017**    | Pause button (`enabled=false`) blocks activation even when locked — the pause gate comes before the lock gate  | ✅                       | ✅                                | ✅                                |
| **018**    | `shouldCollectionActivate` gate chain: lock required / trigger narrows / trigger and condition both pass / lock alone | ✅                       | ✅                                | ✅                                |
| **019**    | WI / AutoSync refresh smoke: refresh paths are pure UI mirrors (locks/autoSync/enabled unchanged after 3× idempotent calls) | ✅                       | ✅                                | ✅                                |
| **020**    | Qdrant: per-chunk override is backend-first (survives ext_settings wipe)                             | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **021**    | Standard+plugin: per-chunk override is backend-first (survives ext_settings wipe)                   | ⏭️ no plugin            | ✅                                | ✅                                |
| **022**    | Standard+plugin: context/xmlTag wrapping + force link through retrieval (backend-first)              | ⏭️ no plugin            | ✅                                | ✅                                |
| **023**    | Auto-sync settle/commit lag: swipes on the active turn never extract                                 | ✅                       | ✅                                | ✅                                |
| **024**    | EventBase LLM extraction: real provider round-trip (soft-skips without a chat model)                 | ✅                       | ✅                                | ✅                                |
| **025**    | Auto-Reformat: real provider splits a multi-entity section (soft-skips without a model)              | ✅                       | ✅                                | ✅                                |
| **026**    | Acronym glossary: deployed-module grounding smoke (no LLM)                                           | ✅                       | ✅                                | ✅                                |
| **Totals** |                                                                                                      | **15 passed, 12 skipped** | **18 passed, 9 skipped**         | **27 passed, 0 skipped**          |

### Skip logic that drives the matrix

| Helper                      | Used by                    | Skip condition                                                                                       |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `skipIfQdrantUnavailable()` | TEST 001-004, 010-013, 020 | (a) Plugin probe fails, **or** (b) `qdrant_url`/`qdrant_host` not set in `extension_settings.vectfox`, **or** (c) qdrant config is set but qdrant is unreachable (emits a **WARNING** in the skip reason). |
| `skipIfNoPlugin()`          | TEST 008, 021, 022         | Plugin probe fails.                                                                                  |
| (none)                      | TEST 000, 005-007, 009, 014-019, 023-026 | These run in every environment. Split by what they exercise: **000** = every VectFox file loads from the deployed copy; **023** = settle/commit lag; **024/025** = real LLM round trips, which log `[SKIP]` when no model is configured; **026** = glossary grounding smoke; **005-007** = real backend round-trips (standard backend embedding + chat retrieval); **009** = forces `pluginAvailable=false` to exercise no-plugin native path; **014-016** = pure-function auto-sync contracts (fingerprint cache, start marker, `stampAutoSyncMarker`); **017-019** = pure in-memory collection-metadata contracts (pause button overrides lock, gate chain, refresh-path purity). 014-019 don't need the plugin nor any backend — they operate directly on `extension_settings.vectfox` state and the registry. See [collection_helper.md → Chat Auto-Sync](collection_helper.md) for the 014/015/016 contract, and the same doc's "Pause/Resume" + "Manual vs auto-sync paths" sections for the 017/019 contract. |

**The unreachable-qdrant case** (config present but server down) is a soft skip with a WARNING-flavored reason, NOT a hard failure. The reasoning:

- A common case-2 user installed qdrant once, took it down, kept the VectFox settings. They're now a pure standard-backend user.
- Hard-failing qdrant tests for these users would be confusing — nothing is "wrong" with their environment, they just don't use qdrant.
- Serial mode means one hard failure halts the rest of the suite — exactly what we don't want for a user who'd benefit from TEST 005/006/007/008/009 all passing.

If qdrant **is** actually broken (down for the wrong reason) and the user **does** care, the WARNING in the skip log is the signal. The plugin probe (`/health`) and qdrant probe (`/backend/init/qdrant`) are independent — the test framework lets the user know which gate they failed.

### Reading the matrix

- **✅** = the test exercises real code and asserts behavior.
- **"plugin enhances"** = test runs identically whether plugin is present or not, but the plugin upgrades the underlying code path (real `vectorScore` and metadata round-trip instead of degraded native fallback — see §8).
- **TEST 008's "no plugin → skip"** is by design: this test specifically validates the plugin-enhanced standard backend path. The no-plugin counterpart is TEST 009.
- **TEST 009 runs everywhere** because it forces `pluginAvailable = false` on the shared backend instance regardless of whether the plugin is actually installed. This guarantees no-plugin code-path coverage even on a fully-equipped dev machine.

**TEST 005/006/007 run end-to-end on case 1 (no plugin) too** — they are not "skip when the plugin is missing". They gate bugs that exist only without the plugin: the plugin's discovery path pre-stamps each collection's scope and the native path does not, so only these tests exercise `getCollectionMeta`'s scope resolution and the lock checkbox on a no-plugin install.

**Skip mechanism:**

- Spec-level `test.skip(condition, reason)` in [tests/Eventbase-test.spec.js](../tests/Eventbase-test.spec.js) — uses helpers `skipIfQdrantUnavailable()` and `skipIfNoPlugin()`. Marks the test ⏭️ in the Playwright report.
- In-eval defensive checks emit `[SKIP]` log lines that `assertPassed()` treats as soft-pass (no `[FAIL]`, no `[PASS]` required). Belt-and-suspenders for any case where the spec-level check doesn't fire.
- Plugin probe is cached per-page so the suite doesn't hit `/api/plugins/similharity/probe` more than once.

---

## 16) Known Pending Cleanups

### 16.1 ChunkBase phase early-gate — broaden vs current  (mainly performance issue, spending 20ms unnecessarily)

**Status**: Deferred; no code change.

`rearrangeChat` ([src/features/chunkbase/chat-vectorization.js:939](../src/features/chunkbase/chat-vectorization.js#L939)) runs **EventBase Phase A** then unconditionally falls through to **ChunkBase Phase B**. (It also early-returns above Phase A entirely when `isVectFoxEnabled(settings)` is false — that master-switch gate is orthogonal to the Phase B early-gate discussed here.) Phase B has two existing gates:

1. **Early (cheap)** at [line 1034-1041](../src/features/chunkbase/chat-vectorization.js#L1034): `hasCollections = gatherCollectionsToQuery(settings).length > 0` — passes if *any* non-EventBase collection has `enabled=true`. No lock/scope/activation check.
2. **Post-activation (expensive)** at [line 1075](../src/features/chunkbase/chat-vectorization.js#L1075): `filterActiveCollections` runs the full `shouldCollectionActivate` gate chain (pause → lock → triggers → conditions).

EventBase-only users (the typical case) hit gate 1 and short-circuit — debug log `[VECTFOX ChunkBase] No enabled ChunkBase collections ...` fires once per generation to confirm.

**What was considered**: tightening the early gate so it requires not just "enabled" but "enabled AND has some activation mechanism that could match the current context" — would avoid the keyword-extraction work at [line 1055-1062](../src/features/chunkbase/chat-vectorization.js#L1055-L1062) when a user has enabled lorebooks that aren't locked to the current chat or character.

**Why deferred**: activation requires a lock (gate 2 of `shouldCollectionActivate`), so a cheap `enabled AND (chat-locked OR character-locked)` pre-check matches every activation path. The saving is about 20ms per generation — not worth doing in isolation; revisit if/when we touch Phase B for another reason.

**Caller count**: 1 — `rearrangeChat` is the only place running the EventBase→ChunkBase ordered workflow ([src/index.js:452](../src/index.js#L452) — `vectfox_rearrangeChat` is its sole caller via ST's `generate_interceptor`). No util-extraction is needed if/when we change the gate.

**Search tag in code**: none yet. When acted on, target [src/features/chunkbase/chat-vectorization.js:1038](../src/features/chunkbase/chat-vectorization.js#L1038) (the `if (!hasCollections && !canQueryWI)` block).

---

### 16.4 Purge redundant `vectfox_chunk_meta_*` keys from `extension_settings` — pending

**Status**: Pending — run it once the backend-first reads have served real traffic for a few months (they went live 2026-06-01).
**Depends on**: Phase B of `InternalProject/Vectfox/plans/executed/chunk-metadata-read-source-fix.md` having run in real use for a while.

**Background**: per-chunk metadata (`name`, `context`, `xmlTag`, `position`, `depth`, `keywords`, `links`, `enabled`) lives in the vector backend (Vectra-via-plugin / Qdrant), the durable, portable source of truth. `extension_settings['vectfox_chunk_meta_*']` holds copies from the dual write, which Phase B of the read-source fix stopped; every reader is backend-first and keeps those copies only as a read fallback.

**What this cleanup is**: once Phase B has been live long enough that we're confident no reader still falls back to `extension_settings` for the targeted fields, write a one-shot purge that removes the now-orphaned `vectfox_chunk_meta_*` keys from `settings.json`.

**Why it waits**:

- Phase A/B keep the ext_settings **read fallback** specifically to protect any chunk whose backend payload lacks a field — chiefly chunks text-edited under the old R8 path, whose annotations live only in ext_settings (see `InternalProject/Vectfox/plans/executed/chunk-metadata-read-source-fix.md` §4.6/§5). Purging immediately would remove that safety net before we've validated the backend-first paths in real usage.
- No reconciliation pass was run (intentional — dual-write means the backend already mirrors ext_settings for everything except R8 text-edited chunks). Give the backend-first paths a few months of real traffic before pulling the fallback.

**No backfill (user decision).** We do **not** backfill the R8 orphan set before purging. Losing those chunks' annotations does not break anything — fields degrade to defaults and the chunk text is preserved. The user accepts the loss of post-import annotations on text-edited chunks (re-annotatable). So this purge can run after the soak as a straight delete, no backfill stage.

**When implementing**:

- Iterate `extension_settings.vectfox`, match the `vectfox_chunk_meta_` prefix (see `getAllChunkMetadata()` in [src/features/collections/collection-metadata.js:373](../src/features/collections/collection-metadata.js#L373)), delete those keys, `saveSettingsDebounced()`.
- Gate it: only purge fields that Phase B confirmed are backend-authoritative. If any field is still client-only (e.g. `summaries`, or some genuinely local UI state), preserve those keys/sub-fields.
- Per `CLAUDE.md`, this is migration logic — **confirm with the user before adding it**, and consider a one-time guarded run (versioned flag) rather than something that fires on every load.
- Tripwire: a user who downgrades to a pre-Phase-B build after the purge would lose their per-chunk overrides from the UI's perspective *only if* that old build read ext_settings-first — which it did. The backend still has the data; the old build just wouldn't show/use it. Acceptable, but note it in the purge's release notes.