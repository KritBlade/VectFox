# Dev Helper

## 1) Pipeline Architecture — Strict Path Separation

EventBase is the **exclusive** retrieval path for chat content. The legacy `eventbase_enabled` toggle has been removed — chat history (live and uploaded archive `.jsonl`) is hard-routed through EventBase ingestion + retrieval. Legacy chunking for chat is no longer supported.

### Two pipelines, strict ownership

| Pipeline                      | Content scope                                                                                        | Owned collections                                  | Code entry point                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| **EventBase pipeline**        | Chat history only (live chat + archive`.jsonl`)                                                      | `vectfox_eventbase_*`, `vectfox_archiveevent_*`    | `eventbase-workflow.js` → `eventbase-retrieval.js`   |
| **Standard (Chunk) pipeline** | Non-chat content only — Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts | `vf_lorebook_*`, `vf_document_*`, user collections | `chat-vectorization.js` → `queryAndMergeCollections` |

The two paths never see each other's content. There is no overlap in collection prefixes or content types.

### Key isolation rule (`core/chat-vectorization.js` → `gatherCollectionsToQuery`)

- `vectfox_eventbase_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vectfox_archiveevent_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vectfox_chat_*` — **no longer minted.** The `VECTFOX_CHAT` prefix constant was removed by the 2026-04 cleanup (`plans/executed/delete-dead-chunk-chat-and-temporal-decay.md`), so no code path creates these. The 2026-05 cleanup (`plans/remove-chunk-chat.md`) deleted the last preview-only consumer (`prepareChatContent`). No production user has `vf_chat_*` data — the product shipped EventBase-only for chat. `gatherCollectionsToQuery` has no explicit `vf_chat_*` exclusion (the prefix constant doesn't exist to check against), but the absence is moot.

### Archive Chat History — Two content paths

| Path              | Content Type in UI      | Collection prefix        | Storage format                               | Retrieval                     |
| ----------------- | ----------------------- | ------------------------ | -------------------------------------------- | ----------------------------- |
| **A — EventBase** | `Chat → Upload` tab     | `vectfox_archiveevent_*` | Event-shaped (same schema as live EventBase) | Phase A (EventBase re-ranker) |
| **B — Chunk**     | `Document` content type | `vectfox_document_*`     | Chunk-shaped                                 | Phase B (standard pipeline)   |

Archive event collections are **not** auto-locked to any chat after ingestion. Users must manually check "Active for current chat" on the collection card to activate retrieval for a given chat.

### Why this matters

Before the toggle removal, `vectfox_eventbase_*` collections could be included in the standard pipeline when EventBase was OFF, causing them to be queried twice per generation: once by the EventBase pipeline (structured event retrieval with dedup-depth) and once by the standard pipeline (raw chunk retrieval). The standard pipeline query was always redundant and could inject duplicate content. With the toggle gone, this class of bug is structurally impossible.

---

## 2) Extraction Level Location

Extraction levels are defined in: `core/keyword-boost.js`

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

## 3) Default Summarizer Token/Timeout Constants

Located in: `core/summarizer.js`

Exact constant names:

- `DEFAULT_MAX_TOKENS`
- `DEFAULT_TIMEOUT_MS`

---

## 4) EventBase Window Dedup — Fingerprint Cache

### Problem with old approach

`isWindowAlreadyExtracted` used a semantic DB query (`queryCollection(..., 50, ...)`) to check if a window was already extracted. This was:

- Capped at 50 results → missed already-extracted windows if >50 events in DB
- Slow — requires embedding a dummy query + ANN search on every window

### Current approach (O(1), no DB query)

Two-tier storage:

| Tier          | Where                                                              | Shape                          | When built                                                                                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| **Persisted** | `extension_settings.vectfox.eventbase_extracted_windows[chatUUID]` | Flat`string[]` of fingerprints | Written each time a window is marked;`saveSettingsDebounced()` flushes to disk              |
| **In-memory** | `_windowCacheSet` (module-scope `Map<chatUUID, Set<fingerprint>>`) | `Set<string>` per chat         | Lazily built on first access from the persisted array; mutated in-place on subsequent marks |

The persisted array is what survives a reload. The `Set` is what makes the lookup actually O(1) — `array.includes` would be O(N) and chats with thousands of windows would degrade.

- **Fingerprint format:** sorted source hashes joined by comma, e.g. `"123,456,789"` (built by `windowFingerprint(hashes)`)
- **On extraction:** `markWindowExtracted(sourceHashes, chatUUID)` — adds the fingerprint to both the in-memory Set AND the persisted array, then calls `saveSettingsDebounced()`. Called in `eventbase-workflow.js` after each successful `insertEvents`.
- **On dedup check:** `isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID)` — async signature (kept for API compat; `messageIds` and `settings` are ignored). Returns `set.has(fp)` from the in-memory Set — synchronous, O(1).
- **Quick-exit check:** `isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn)` — checks just the *last* window. Windows process tail-to-head in order, so a hit means everything earlier is done too. Avoids building the full window list when nothing needs work. Used as a pre-flight gate before the per-window loop.
- **Cache invalidation:** `clearWindowCacheForChat(chatUUID)` — drops both the in-memory Set entry and the persisted array for one chat. Called when an EventBase collection is deleted, so the next vectorization run starts fresh.
- **Why NOT chat_metadata:** `chat_metadata` is only saved to disk when ST saves the chat (e.g. when a message is generated). Stopping mid-vectorization and reloading Chrome would lose all fingerprints written during that run. `extension_settings` + `saveSettingsDebounced` persists immediately.

### Key files

- `core/eventbase-store.js` — `markWindowExtracted`, `isWindowAlreadyExtracted`, `isLastWindowExtracted`, `clearWindowCacheForChat`, `windowFingerprint`, plus the private `_windowCacheSet` map
- `core/eventbase-workflow.js` — calls `isLastWindowExtracted` as the pre-flight gate, `isWindowAlreadyExtracted` per-window inside the loop, and `markWindowExtracted` after `insertEvents` succeeds

### Migration note

Windows extracted before this fix have no fingerprint in cache. First run after update will attempt to re-insert them — both backends are idempotent on `hash`: Qdrant overwrites same-ID points and Vectra's plugin upserts by hash, so no duplicates are created. All future runs use the cache correctly.

---

## 5) GUI Settings — Tab Placement & EventBase Relevance

After the Phase 2 GUI reorg, settings are grouped by which path consumes them:

| Setting                                                                                  | UI tab                      | EventBase relevant? | What it actually does                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Insert Batch Size** (default 50)                                                       | ChunkBase → Ingestion       | **No**              | Max chunks per insert request for API embedding sources (see §6); local Transformers / Ollama / llama.cpp always send 1 chunk per request. Also the client-side embedding batch size for WebLLM / KoboldCpp. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Dedup Depth** (default 50 messages)                                                    | Core                        | **Yes**             | Used in`eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. Also used by chunk-path retrieval in `chat-vectorization.js`. |
| **Hybrid Search & BM25 block** (Keyword Scoring Method, BM25 k1/b, Fusion Method, RRF K) | Core → Hybrid Search & BM25 | **A1/A2 only**      | These are Vectra (Standard backend) controls. On Qdrant, hybrid is always A3 server-side native — k1/b/RRF K are managed by Qdrant's`modifier: idf` and the `fusion: rrf` API, and these UI knobs have no effect. EventBase callers inject `ebSettings` with `keyword_scoring_method` overridden from `eventbase_keyword_scoring_method` (internal, defaults `'bm25'`, not in UI). See §13 for the full matrix. |
| **Query Keyword Budget** (`hybrid_keyword_level`)                                        | ChunkBase → Keyword Budget  | **No**              | Read only by`scoreResults()` (A1) and `hybridSearch()` (A2). A3 doesn't use it — the sparse-vector encoder tokenizes the full query and Qdrant handles IDF weighting. EventBase has its own importance/persist/recency re-ranker that dominates the final order anyway. |

---

## 6) Similharity Plugin — How One Insert Request Is Embedded

Plugin: `../similharity/index.js`, `getVectorsForSource(...)`. One insert request carries N texts; the embedding source decides how they are embedded (T = one embedding call):

| Source | How the N texts are embedded | Time for one request |
| --- | --- | --- |
| `openai`, `openrouter`, `togetherai`, `mistral`, `electronhub` | one batched `/embeddings` call per 100 texts (`getOpenAIBatchVector`) | about T |
| `nomicai`, `cohere` | N single-text calls in parallel (`Promise.all`) | about T, but N calls against the provider's limits |
| every other source, including `vllm` and the local `transformers` / `ollama` / `llamacpp` | one after another | about N × T |

VectFox side (`insertVectorItems` in `core/core-vector-api.js`):

- Local GPU sources (`transformers`, `ollama`, `llamacpp`) always send 1 item per insert request, so the 120s request timeout bounds one embedding and an item that fails to embed fails only its own request. `insert_batch_size` and the embedding API rate limit (`rate_limit_calls` / `rate_limit_interval`) do not apply to them.
- API sources send up to `insert_batch_size` items per request while `vector_group_embedding_call` is on (default) or a rate limit is set; otherwise each item is its own request, fired in parallel waves (parallel-split).
- A grouped `vllm` request therefore costs about N × T inside one request.

---

## 6.5) EventBase Ingestion — Pipelined Extract / Insert (since 2026-05-29)

Plan: [`plans/eventbase-extract-insert-pipeline.md`](../plans/eventbase-extract-insert-pipeline.md).

The `runEventBaseIngestion` loop in `core/eventbase-workflow.js` used to be a strict serial barrier:

```
dispatch 8 extracts in parallel → await all → await batched insert → next 8
```

Extract phase and insert phase touch completely independent infrastructure (the LLM HTTP lane vs the Qdrant HTTP lane). The serial barrier was code structure, not a real constraint — it left ~6s of Qdrant idle time on every cycle (insert finishes, extract waits) AND ~6s of LLM-lane idle time (extracts finish, insert waits).

### What we changed

Introduced a single-slot pipeline coordinator inside `runEventBaseIngestion`. At any moment, at most one extract batch AND one insert batch are in flight. When batch N's extract resolves, its result is queued; the coordinator immediately fires (a) batch N's insert AND (b) batch N+1's extract in the same iteration tick. They run concurrently. Steady-state cycle becomes `max(extract_phase, insert_phase)` instead of `extract_phase + insert_phase`.

Three private helpers inside `runEventBaseIngestion` keep the change localized — no new module, no exported API:

| Helper | Role |
|---|---|
| `_runOneExtractBatch(slice, batchFirstIdx)` | Existing per-window extract logic (Promise.allSettled on 8 LLM calls), moved verbatim into a function so the coordinator can call it as a black box. Returns `{ allEvents, hashesToMark, endsExtracted, batchResults, ... }`. |
| `_insertWithRetry(events, batchFirstIdx)` | Wraps `insertEvents` with up to 3 attempts and exponential-ish backoff (500ms / 1000ms). On exhaustion throws `EventBaseFatalError` with `code: 'insert_failed_max_retries'` carrying Qdrant's error text. UI catch in `ui/content-vectorizer.js::_runEventBaseBackfill` surfaces it via `callGenericPopup`. |
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

The insert-first-then-extract ordering is a **bug we shipped on the first try and had to fix**. The original version checked `canStartExtract` against the pre-iteration snapshot of `queuedResult`, so when batch N's extract finished and queued its result, the next iteration's extract was blocked by the same queuedResult that was about to drain. This made the pipeline silently regress to serial behavior — 22-second batches instead of 12. The fix (commit on Dev) is the order shown above.

### Measured impact (2026-05-29, 2382-msg reference chat)

Pre-pipeline baseline: ~40 minutes wall time, ~1.7 events/sec.

With pipelining, measured over a 34-batch sample at 24% of the run on a representative 2382-message chat:

| Metric | Value |
|---|---|
| Median per-batch delta | 9.5s |
| Mean per-batch delta | 10.4s |
| p90 per-batch delta | 14.8s |
| Stdev | 3.8s |

Projected full-run wall time: **~25 minutes** vs. ~40 minutes baseline — roughly **35% faster**. The math works because LLM extract (~10-12s p50, up to ~22s p99 per window) dominates Qdrant insert (~5-8s) — extract > insert is the regime where pipelining gives maximum benefit (insert hides under next extract).

If extract were faster than insert (which never happens with the current LLM provider mix), pipelining would still help but the win would be insert-bounded instead of extract-bounded. Either way the math holds: steady-state cycle is the longer of the two, not the sum.

### What this design deliberately doesn't do

- **No multi-slot queue.** Single-slot captures the full steady-state win; deeper queue would only add memory pressure and complicate abort. The slow stage always gates throughput regardless of buffer depth.
- **No speculative re-issue of slow LLM calls.** Even with perfect pipelining, one 22s window in a batch of 8 pins wall time at 22s. That's the next lever if speed becomes critical again — race a duplicate request after some threshold, take whichever returns first. Costs tokens on tail windows only. Tracked as a non-goal in the plan's §7.
- **No per-window insert.** Tried in prod history before this change and was N× slower because per-window inserts blow up the Similharity plugin's embedding batching. Stays coalesced per-batch.
- **No data shape changes.** Same EventBase schema, same Qdrant payload, same retrieval semantics. Old events untouched. Zero re-indexing.

### Abort behavior — preserved

Pressing Stop mid-pipeline waits for the in-flight insert to complete before exiting (~6s latency), then fires `progressTracker.complete(false, 'Stopped by user')`. Any in-flight extract is awaited and discarded (its events were never inserted). Any `queuedResult` is discarded (same reason). On the next run, those windows re-extract from a clean state — the fingerprint cache wasn't updated for them, so dedup correctly identifies them as new. This is the "no corrupted state" invariant in action.

### Compatibility with other code paths

The change lives entirely inside `runEventBaseIngestion`. All 3 production callers (auto-sync via `synchronizeChat`, manual backfill via `vectorizeAll`, archive file upload) hit the same helper and get the pipelined behavior for free — they just pass different flags (`isAutoSync`, `suppressAutoSyncPopup`, `parallelWindows`, `collectionIdOverride`). None of those flags interact with the extract/insert ordering. The chunk-base pipeline (lorebook / character / document / URL / wiki / YouTube via `vectorizeContent`) is completely untouched — it has no extract phase to overlap (chunking is synchronous and instant, and the entire chunk list is inserted in one call).

### Key files

- `core/eventbase-workflow.js` — the coordinator + helpers
- `ui/content-vectorizer.js::_runEventBaseBackfill` — catch branch for the `insert_failed_max_retries` popup
- `plans/eventbase-extract-insert-pipeline.md` — full design doc, edge-case table, and acceptance criteria

---

## 6.8) Embedding-Call Resilience — Group / Hedge / Pipelined (since 2026-05-30)

Three related features sit inside `insertVectorItems` ([`core/core-vector-api.js`](core/core-vector-api.js)) and the EventBase coordinator ([`core/eventbase-workflow.js`](core/eventbase-workflow.js)). All three affect every embedding caller — EventBase ingestion AND chunk-based document vectorization in [`core/content-vectorization.js`](core/content-vectorization.js). UI lives in the **Core tab → Embedding section** (Group + Hedge) and **EventBase tab** (Serial).

### Final defaults shipped 2026-05-30 (fresh install)

| Checkbox | Setting key | Default | Wire shape |
|---|---|---|---|
| Group embedding calls | `vector_group_embedding_call` | ☑ **true** | 1 POST per batch (legacy production shape) |
| Hedge slow embedding calls | `vector_hedge_after_ms` | ☑ **15000** | Duplicate fires at 15s if primary stalls |
| Serial extract→insert | `eventbase_disable_pipeline` | ☐ **false** | Pipelined extract↔insert overlap |

Defaults flipped twice during 2026-05-30 development. Started with Group=false (parallel-split) on the theory that per-item containment beats batched POSTs. After a 14-batch / 132-event / 141.2s run on standard backend with all 3 features ON showed Group=ON+hedge produced 14/14 primary wins (max 15.3s, median ~4.8s, only one hedge brush), Group was flipped to ON as the new default. The empirical insight: hedge protects against connection-level stalls, and a single batched POST is a smaller blast surface (1 connection per wave) than N parallel POSTs (N connections per wave) when the upstream gateway has connection-affinity routing. Group=OFF remains the one-click rescue path if upstream starts returning batch-wide 500s.

### Group embedding calls (`vector_group_embedding_call`)

**Checked (default):** all items in a batch ship in one POST to ST's `/api/vector/insert`. Matches the legacy production wire shape — cheaper (saves API call count), smaller connection surface for hedge to protect, optimal on healthy cloud APIs. Downside: one stuck item hangs the whole batch (the 555s-monster failure mode observed pre-fix 2026-05-30).

**Unchecked:** parallel-split — each item gets its own HTTP POST, fired in parallel waves of up to 16. Containment-focused: a stuck upstream worker only blocks that one item. N× the connection surface; on bursty cloud APIs with connection-affinity routing this can amplify routing stalls rather than escape them.

Skipped automatically for local providers (Ollama already uses batch=1) and rate-limited setups (`dynamicRateLimiter` requires serial execution). The setting is independent of hedge — see _Composition_ below.

### Hedge slow embedding calls (`vector_hedge_after_ms`)

**Checked (default = 15000ms):** if an embedding POST hasn't returned in 15s, fire a duplicate request on a fresh HTTP connection. Race-first-wins via Promise — whichever finishes first settles the call. Late losers harmlessly upsert the same Qdrant point with identical data (hash-deterministic on event_id). Helps multi-upstream gateways (OpenRouter, SiliconFlow behind the `vllm` slot) recover from connection-level routing stalls in seconds instead of waiting through ST's 120s timeout.

**Unchecked = 0ms:** disabled. Insert call goes directly without hedge wrapper.

Gated to skip `localGpuSources` (Ollama / transformers / llama.cpp / KoboldCpp) regardless of the setting — a new connection to a local single-endpoint server wouldn't change routing. UI label intentionally drops the per-provider list to keep the hint short; the runtime gate is the authoritative behavior.

**Where hedge fires (write path only).** There is exactly ONE `callWithHedge` call site: inside `insertVectorItems` ([core-vector-api.js:861](core/core-vector-api.js#L861)) — the embedding **write** path. Everything that ingests goes through it and inherits hedge for free:

| Operation | Hedges? | Path |
|---|---|---|
| Manual **Vectorize Content** (chat → EventBase) | ✅ | `ui/content-vectorizer.js` → `runEventBaseIngestion` → `insertEvents` → `insertVectorItems` |
| Manual **Vectorize Content** (chunks: lorebook / docs / URLs / wiki) | ✅ | `content-vectorization.js` → `insertVectorItems` |
| **Auto-Sync** | ✅ | `synchronizeChat` → `runEventBaseIngestion({ isAutoSync: true })` → `insertEvents` → `insertVectorItems` |
| **Retrieval / per-turn search** | ❌ | `queryCollection` → `getQueryVector` (embeds the query once, one retry on failure) → every route and fallback reuses that vector. No hedge wrapper anywhere on this path. |
| **Agent Mode** | ❌ | `agentic-retrieval.js` only calls `queryCollection` / `retrieveEvents` — it never inserts, so it never reaches the hedge. |

Note that **auto-sync is not a separate path** — it's the same `runEventBaseIngestion → insertVectorItems` chain as the manual button, just invoked with `isAutoSync: true`. It was originally built to rescue the manual Vectorize Content run, but auto-sync gets the same protection automatically, which is desirable: a stalled embedding write hurts equally whether the user clicked the button or an ST message event triggered it.

**Why search and Agent Mode are deliberately NOT hedged:**

1. **Read vs. write asymmetry in stall exposure.** Ingestion fires hundreds of embedding POSTs over minutes — the probability that *at least one* lands on a stuck upstream worker is high, and a single stall freezes the whole run until ST's ~120s timeout. A retrieval embeds **one** short query and returns in well under the 15s hedge threshold; the exposure window hedge is designed to catch barely exists on the read side.
2. **The 15s threshold is longer than a healthy query.** Hedge only fires *after* 15s of silence. A normal query-embed + vector search completes in a fraction of that, so in practice hedge would almost never trigger on a search even if it were wired in — it'd be dead weight on the hot path.
3. **A stalled search fails soft; a stalled ingest fails expensive.** If a retrieval embed genuinely hangs, the cost is one turn with degraded/no memory injection — annoying but self-correcting on the next message. A hung ingest wastes minutes of a long batch run and can leave the user staring at a frozen progress bar. Hedge's value is highest exactly where the blast radius is largest.
4. **Idempotency only holds for writes.** Hedge's "fire a duplicate, race-first-wins, discard the loser" trick is safe because a duplicate **write** is a no-op (hash-deterministic Qdrant upsert overwrites the same point with identical data). A duplicate **query** isn't harmful, but it also buys nothing — you'd just pay for two embeds to shave time off a path that's already fast (see #2). Agent Mode compounds this: it already fans out 1–4 parallel queries, so adding per-query hedging would multiply planner-stage API cost for no latency win on an already-parallel, already-fast stage.

**Read-path timeout (shipped 2026-05-31).** The read path is hardened with a plain per-turn timeout rather than the hedge race — the hedge machinery (4 attempts over 60s, hedge-fatal escape, Continue-to-resume) is tuned for long write batches and would be overkill for a one-shot read. `rearrangeChat()` (the generation interceptor in [`core/chat-vectorization.js`](core/chat-vectorization.js), wired to ST via `window.vectfox_rearrangeChat`) wraps BOTH per-turn retrieval calls — `runEventBaseRetrieval` (EventBase / chat memory) and `queryAndMergeCollections` → `queryActiveCollections` (chunk / lorebook / docs) — in `AsyncUtils.timeout(promise, RETRIEVAL_TIMEOUT_MS, …)`. `RETRIEVAL_TIMEOUT_MS = 15000` ([core/constants.js](core/constants.js)) matches the write-side hedge threshold for one consistent "too slow" number.

It's a **soft** timeout (Promise.race): on expiry the turn proceeds and the message sends WITHOUT that memory source — both call sites wrap the await in try/catch (EventBase logs and continues; the chunk path sets `chunks = []` so downstream injects nothing). The orphaned `fetch` keeps running until ST's server-side timeout reaps it — there is no client `AbortSignal` on the read fetches (see the timeout table above), so this is a "stop waiting", not a "cancel the request". A stall is not retried: a stalled retrieval fails soft (one turn without memory, self-corrects next message), so a single bounded attempt is the right tradeoff. A query embedding that FAILS (e.g. a provider 429 "The engine is currently overloaded") is different — it fails fast, so `getQueryVector` ([core/core-vector-api.js](core/core-vector-api.js)) retries it once, then fails the query. That is the only retry on the read path: the query is embedded once and every route and fallback reuses the vector, so a fallback never re-embeds (each fallback used to, which stacked up to four embedding calls per failed query).

Agent Mode is covered by the same `rearrangeChat` outer bound (its fan-out `queryCollection` calls run inside that hook), and additionally bounds its planner LLM call separately via `AbortSignal.timeout(agentic_retrieval_timeout_ms)` ([agentic-retrieval.js](core/agentic-retrieval.js)) — that one IS a hard cancel because it's a fresh fetch the agent code owns directly.

**Independence from Group setting.** Hedge wraps whatever payload is on the wire — 1 item or 50 items. With Group=ON, one hedge fire rescues the entire batch. With Group=OFF, hedge fires per-item independently. Both work; Group=ON has higher ROI per hedge fire.

### Hedge-fatal escape

After 4 fresh-connection attempts in 60s with no success, `callWithHedge` throws an error with `name === 'HedgeFatalError'` and `isHedgeFatal === true`. Both `RETRY_CONFIG.shouldRetry` and `_insertWithRetry` (the outer EventBase retry in `eventbase-workflow.js`) check this flag and skip retrying — more retries would just trigger another 60s of identical hedging against the same broken upstream. User presses Continue button later to resume; the existing window-cache semantics ensure no duplicates on resume thanks to hash-deterministic Qdrant upserts.

### Serial extract→insert (`eventbase_disable_pipeline`)

**Unchecked (default):** pipelined coordinator. Batch N's insert overlaps batch N+1's extract via a single-slot queue. ~35% faster wall time when extract dominates insert (the common case). An earlier 2026-05-30 A/B showed pipelined producing ~44% fewer events/window than serial (0.98 vs 1.74) and the gap was originally hypothesized as cloud-API per-key concurrency contention — but it was actually a hedge bug: hedge timers kept firing during in-flight inserts that were still making progress, and the redundant waves wiped events out of the queue. Bug fixed; pipelined is the safe default now.

**Checked:** serial — each batch finishes embedding before the next batch starts extracting. Safer if a future regression reintroduces the queue-wipe class of bug, and slightly higher event-yield on very bursty cloud APIs where pipelining can still create per-key contention.

Read-site semantics: `settings?.eventbase_disable_pipeline === true` (line 129 of `eventbase-workflow.js`). Only an explicit `true` enables serial; missing/false/undefined gives pipelined.

### Composition

| Layer | Behavior with hedge enabled |
|---|---|
| Coordinator (EventBase pipelined or serial) | Hedge-fatal bubbles up as a fatal; windows stay unmarked; user resumes via Continue. |
| Outer `_insertWithRetry` (pipelined mode) | Catches anything except AbortError AND hedge-fatal. Hedge-fatal escapes the 3-attempt outer retry budget. |
| Inner `AsyncUtils.retry` | `shouldRetry` returns false for hedge-fatal. Otherwise retries on TimeoutError + the keyword set in `RETRY_CONFIG.shouldRetry`. |
| Hedge (`callWithHedge`) | Primary at t=0, hedge at t=15s, 30s, 45s. Hard fatal cutoff at t=60s. AbortError short-circuits the entire race so Stop button cancels within microseconds (no 60s of spam). |
| Parallel-split wave composite (Group=OFF only) | If ANY individual failure is `isHedgeFatal=true`, the composite Error inherits the flag — outer retry short-circuits instead of burning ~12min/wave on a wave certain to fail again. |
| Backend `insertVectorItems` (similharity → ST → provider → Qdrant) | One call per hedge invocation. |

### Standard-backend safety — coalesce + queue (replaces earlier 3-knob enforcement)

The **Standard backend** (ST's Vectra via similharity plugin) cannot tolerate high HTTP concurrency — the plugin's response handling corrupts under concurrent load. Observed 2026-05-30 pre-fix: 12 simultaneous parallel-split POSTs + hedge produced 2.1 MB truncated-JSON 500s from the plugin (`[similharity] chunks/insert error: SyntaxError: Unexpected non-whitespace character after JSON at position 2140978`) plus on-disk Vectra index corruption. Likely HTTP/2 response-buffer multiplexing.

**Earlier fix (removed):** forced `vector_hedge_after_ms=0` + `eventbase_disable_pipeline=true` via the Vector Backend `<select>` change handler. Worked but disabled features the user wanted. Removed.

**Current fix (shipped 2026-05-30):** [`backends/standard.js`](backends/standard.js) absorbs concurrent calls into the production wire shape via two layers:

1. **Coalesce** — single-item calls arriving within `COALESCE_DELAY_MS` (5ms) for the same `collectionId` get merged back into one batched POST. This restores the production "1 POST per concurrency window" shape on this backend even when Group=OFF (parallel-split) is active. State: `_pendingCoalesce: Map<collectionId, {items, resolvers, settings, abortSignal, timer}>`.
2. **Queue** — the resulting batched POSTs serialize per-collection via a Promise chain. Handles hedge duplicates (a 15s-later hedge POST would race the primary if not serialized), multi-item callers that bypass coalesce, and any future concurrent caller. State: `_vectraWriteQueues: Map<collectionId, Promise>`.

Both maps key by `collectionId`, so unrelated collections still run in parallel. Public `insertVectorItems` is unchanged — coalesce + queue are transparent. Existing standard backend users see zero wire-shape difference from production: still 1 batched POST per concurrency window.

Result: standard backend users can run all 3 features (Group / Hedge / Pipelined) at their default values without tripping the plugin bug. Verified 2026-05-30 on a 14-batch run, 0 plugin 500s.

### Empirical evidence (2026-05-30 verification run)

Standard backend, OpenRouter embeddings, Group=ON + Hedge=ON + Pipelined=ON, concurrency=8:

| Metric | Value |
|---|---|
| Windows processed | 112 / 1062 (user stopped early) |
| Events extracted | 132 |
| Wall time | 141.2s |
| Throughput | 2.8 events/s |
| Insert batches | 14 |
| Hedge fires | 0 |
| Hedge threshold brushes | 1 (15.3s, primary still won) |
| Plugin 500s | 0 |
| TimeoutErrors | 0 |
| Median primary win | ~4.8s |

Confirms standard backend safety + Group=ON+hedge optimal pairing.

### Key files

- [`core/core-vector-api.js`](core/core-vector-api.js) — `callWithHedge` helper + `shouldRetry` filter + `makeProcessBatch` wiring + AbortError short-circuit
- [`core/eventbase-workflow.js`](core/eventbase-workflow.js) `_insertWithRetry` — hedge-fatal short-circuit; `disablePipeline` read-site
- [`backends/standard.js`](backends/standard.js) — coalesce + per-collection write queue
- [`ui/ui-manager.js`](ui/ui-manager.js) — Core tab → Embedding section (Group, Hedge) + EventBase tab (Serial)
- [`index.js`](index.js) — defaults
- [`plans/embedding-resilience-hedge-and-diagnostics.md`](plans/embedding-resilience-hedge-and-diagnostics.md) — full design history, observed failure modes, and acceptance criteria

---

## 7) Module Integration Analysis — EventBase Compatibility

Analysis of whether non-EventBase modules should be integrated into the EventBase pipeline.

### temporal-decay.js — DELETED

The whole `core/temporal-decay.js` subsystem (and `tests/temporal-decay.test.js`) was removed. It only operated on chunks with `metadata.source === 'chat'` — a stamp produced exclusively by the legacy chunk-based chat path that EventBase replaced. EventBase events never carried that stamp, so the subsystem was unreachable from the EventBase pipeline. Recency on the EventBase side is — and always was — handled by the `_recencyBonus` term inside the 4-weight re-ranker formula in [`eventbase-store.js`](core/eventbase-store.js) (computed from `source_window_end` and `chatLength`). Mentioned here only because the rest of this document used to cross-reference the old module.

### hybrid-search.js — Used indirectly (do not wire directly)

**Module:** [`core/hybrid-search.js`](core/hybrid-search.js)
**Decision:** ✅ EventBase benefits from it — but through `queryCollection()`, not by direct call.

EventBase calls `queryEvents()` → `queryCollection()` (via an `ebSettings` shim that pins `keyword_scoring_method` to `eventbase_keyword_scoring_method || 'bm25'`). Inside `queryCollection()`, the A1/A2/A3 routing decides whether to invoke `clientSideHybridSearch()` (A2) or the backend's native hybrid (A3, `backend.hybridQuery()`). On Standard backend, EventBase is always A1 unless `eventbase_keyword_scoring_method` is explicitly set to `'hybrid'`. On Qdrant, A3 (native sparse + server-side RRF) is the **only** hybrid path — the previous user-toggle was removed after the A/B/C testing picked native_rrf as the winner. `hybrid_native_prefer` remains as a hidden settings.json escape hatch (default `true`) for testing A2 without UI.

Do **not** call `hybridSearch()` directly from `eventbase-retrieval.js` or `eventbase-workflow.js`. It operates at the backend/collection layer — returns raw `{ hashes, metadata }` and bypasses `queryEvents()`, the store schema hydration, and EventBase-specific field population (`score`, `importance`, etc.).

### Summary table

| Module                                      | Add directly to EventBase? | Reason                                                                                               |
| ------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `core/temporal-decay.js`                    | n/a — module deleted       | Subsystem only fired on`source: 'chat'` chunks (legacy chunk path). Recency on EventBase is handled by `_recencyBonus` inside the 4-weight formula. |
| [`hybrid-search.js`](core/hybrid-search.js) | No (used indirectly)       | EventBase inherits A2/A3 hybrid automatically via`queryCollection()`. Direct calls would bypass `queryEvents()` and the store layer. |

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

- **A1 (BM25 re-rank)**: re-ranks the plugin-returned candidates via weighted-sum `0.5·vectorScore + 0.5·normalizedBM25` ([applyBM25Scoring](../core/bm25-scorer.js)). The plugin's real cosine values *are* used — this is genuine hybrid scoring, not BM25-only.
- **A2 (client-side hybrid RRF)**: takes the same real `vectorScore` and BM25 inputs as A1, but fuses them via RRF (default) plus a dual-signal bonus (+0–8%) and single-signal penalty (×0.55 vector-only / ×0.60 text-only) ([reciprocalRankFusion](../core/hybrid-search.js)). A2 outperforms A1 on the plugin-enhanced path because of the RRF + bonus/penalty math — not because the vector signal becomes "real" (it was real under A1 too).

> **What really differs between A1 and A2 on the plugin path:** both use the *same* real `vectorScore` and the *same* BM25 scoring over the *same* candidate set. The only difference is the **fusion algorithm** — A1 = flat weighted-sum 0.5/0.5, A2 = RRF with dual-signal bonus / single-signal penalty. "A1 ignores vectorScore" was a long-standing doc error; corrected 2026-05-26.

#### Degraded path (no plugin)

The historical "always-zero vectorScore" behavior. Both A1 and A2 still work, but they degrade differently:

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
| What does ON actually change?                                              | The**IDF weights** used for the per-query terms. With ON, IDF is computed from corpus-wide df values (e.g. `df(贖身)=5 / N=1394`). With OFF, df is recomputed per query against just the local candidate set (e.g. `df(贖身)=3 / N=40`) — which biases IDF toward zero whenever the candidates already share the term. |
| How can a doc that doesn't appear in the ANN top-K still affect the score? | It can't be a result. It can only contribute to global df values, which feed into the per-term IDF weights of docs that*are* in the candidate set. |
| What if I want true full-corpus retrieval (find docs that vector missed)?  | Use**A3 (Qdrant)**. Only that path stores a sparse-vector index over every chunk and can match by term across the full collection. The standard backend has no inverted/sparse index. |

So `bm25_use_corpus_idf` should be read as: *"Use corpus df values when computing IDF weights for the candidates BM25 is already scoring."* The toggle improves **scoring quality** within the existing recall window; it does **not** widen the recall window.

#### Cost and lifecycle of the corpus-stats cache

Implemented in [core/corpus-stats.js](../core/corpus-stats.js). When the toggle is ON:

| Aspect                                                                   | Detail                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Build trigger                                                            | Lazy — first call to`getCorpusStats(collectionId)` per session per collection. Subsequent calls hit a hot Map. |
| Build cost (measured, 1394 chunks Traditional Chinese on Intl.Segmenter) | 674 ms total: fetch=407 ms, parse=57 ms, tokenize+df=210 ms. Logged as`[CorpusStats] Built for ...` with full breakdown. |
| Sustained memory                                                         | ~400 KB per collection:`{ totalDocs, documentFrequencies: Map<term, df>, avgDocLength, builtAt }`. Chunk texts are **not** retained — only the derived statistics. |
| Auto-invalidation                                                        | Fires on`insertVectorItems` / `deleteVectorItems` / `purgeVectorIndex` (core-vector-api.js) and `insertChunksWithVectors` (collection-export.js import path). Lazy rebuild on next query. |
| Manual clear (force-rebuild for testing)                                 | `(await import('/scripts/extensions/third-party/VectFox/core/corpus-stats.js')).clearCorpusStatsCache()` |
| Failure mode                                                             | Best-effort. Module-load or fetch failure logs a warning and falls back to local-IDF BM25 for that query — never discards the underlying vector results. See [feedback memory: optional enhancements must degrade]. |

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
| `eventbase_retrieval_top_k`                                                 | 10                        | All three paths                                                | Final number of events injected. Internal overfetch is`top_k × 2 × 2 = 40` for A1 (see §8 Retrieval Paths + keyword-boost.js:1304). |
| `eventbase_retrieval_min_importance`                                        | 1                         | All three paths                                                | Drops events below this importance threshold after retrieval.                                        |
| `eventbase_rerank_w_cosine` / `_w_importance` / `_w_persist` / `_w_recency` | 0.55 / 0.20 / 0.15 / 0.10 | All three paths (formula coefficients)                         | A3 with`eventbase_native_rerank=true` applies them server-side via Qdrant formula; A1/A2 apply them in JS in `eventbase-retrieval.js`. |
| `eventbase_native_rerank`                                                   | `true`                    | A3 only                                                        | Pushes the 4-weight formula into the same Qdrant`/points/query` call. Requires Qdrant ≥ 1.13. Set `false` to fall back to JS post-processing. |
| `eventbase_compare_rerank`                                                  | `false`                   | A3 only                                                        | When ON alongside`eventbase_native_rerank`, runs the JS formula path in parallel for every query and logs `overlap@K` + Spearman ρ. Pure observability, doesn't change the injected events. |
| `eventbase_compare_rerank_verbose`                                          | `false`                   | A3 only                                                        | When both compare settings are ON, emits per-event score rows. Very noisy — development only.        |
| `keyword_extraction_level`, `keyword_boost_base_weight`                     | —                         | Ingestion only                                                 | Not used by any retrieval path. Lives elsewhere; listed here so people stop expecting it to affect retrieval. |
| `hybrid_search_enabled`                                                     | —                         | Removed                                                        | Setting deleted. Hybrid is always available; path chosen by backend +`keyword_scoring_method`.       |

### Native Formula Rerank (A3 + Qdrant ≥ 1.13)

When `eventbase_native_rerank = true`, `_runOneLiveQuery()` in
[core/eventbase-retrieval.js](../core/eventbase-retrieval.js) calls
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

**What stays client-side even in 6a:**

- **Anchor boost** — multi-token phrase substring match (e.g. `贖身的儀式`)
  requires JS; Qdrant tokenizes terms individually and any-of matching would
  miss phrases.
- **Pairwise deduplication** — content-hash overlap across events.
- **Cross-collection merge** — `Promise.all` per collection, concat-dedup-trim.

**Version requirement:** Qdrant ≥ 1.13 for `formula` query support. If the
request fails with a Qdrant error, check the server version and set
`eventbase_native_rerank = false` to fall back to the JS path.

---

## 9) Retrieval Tokenization — Language-Neutral (since 2026-05-29)

VectFox's **retrieval** path (BM25 sparse vectors + query keyword extraction) is now language-neutral. Two scripts share one set of primitives so the ingest path and the query path can never drift:

| Item              | Value                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Shared primitives | `core/script-segmentation.js` — `CJK_SPAN_RE`, `CJK_CHAR_RE`, `KANA_RE`, `LATIN_TOKEN_RE`, `NON_WORD_RE`, `localeForSpan()`, `getSegmenter()` |
| Ingest path       | `core/bm25-scorer.js` → `tokenize()` / `encodeSparseVector()` (imports the shared module)            |
| Query path        | `core/query-keyword-extractor.js` → `extractQueryKeywords()`, `isCJKToken()` (imports the shared module) |
| Stop-word source  | Per-mode selection via `core/language-modes.js` (`LANGUAGE_MODES`) + `isStopWord()` in `./stop-words.js`. Each CJK-tokenizer mode declares its `stopLocales` (e.g. `korean`→`['en','ko']`); only those locale lists are consulted. English is the always-on baseline. `DEFAULT_STOP_WORD_SET` (English + CJK union) is kept only as back-compat/fallback. |

### How language neutrality works

- **Space-separated scripts** (Latin, Cyrillic, Greek, Arabic, …) tokenize via Unicode-aware matchers: `LATIN_TOKEN_RE` (`\p{L}…`) for query keywords, `NON_WORD_RE` (`[^\p{L}\p{N}_\s]`) for BM25. Accents survive (`café`, `niño`, `résumé` are no longer stripped to `caf`, `nio`, `resum`).
- **Space-less scripts** (CJK Han, Kana, Hangul, Thai, Lao, Myanmar, Khmer) are matched by `CJK_SPAN_RE`, routed to the right `Intl.Segmenter` locale by `localeForSpan()`, and fall back to bigrams when the API is unavailable.
- **Adding a language** = one Unicode range in `CJK_SPAN_RE`/`CJK_CHAR_RE` + one `[/range/, 'locale']` entry in `SCRIPT_LOCALE_MAP`. Nothing else changes.
- **Combining marks** (`\p{M}`) are preserved by `LATIN_TOKEN_RE`/`NON_WORD_RE`, so Indic (matras/virama) and Arabic (harakat) words tokenize as whole units instead of broken fragments.

### Per-mode stop-word selection (since 2026-05-31)

Stop-word filtering is **driven by the CJK Tokenizer Mode dropdown**, not a single global union. `core/language-modes.js` holds one record per mode with a `stopLocales` array; `tokenize()` (ingest) and `extractQueryKeywords()` (query) both filter via `isStopWord(token, stopLocalesForMode(mode))`. A Korean collection consults `['en','ko']` only — never the ~2200 Chinese entries it used to. Traditional vs Simplified is disambiguated purely by the `jieba_tw`/`jieba` mode split.

- **Adding a language's stop list** = add `ITS_STOP_WORDS` array + one `xx: ITS_STOP_WORDS` line in `STOP_WORDS_BY_LOCALE` (`stop-words.js`) + one record in `LANGUAGE_MODES`. The dropdown, enum, and selection all derive from that array — no other edits.
- **A stop list is additive, never required** — a mode whose `stopLocales` reference no installed list just skips the filter; text still tokenizes/indexes/searches.
- **Migration note (A3/Qdrant only):** existing Qdrant sparse vectors were built with the old union stop list; queries now filter per-mode (always a subset of the union). The only tokens that can drift are another language's stop words appearing inside this collection's text — a coincidence given character-set separation. Not a crash, not data loss, dense search unaffected; self-heals on re-vectorize. A1/A2 (standard) recompute BM25 at query time → zero impact. No version-gating or forced re-vectorize (decision 2026-05-31).

### Officially supported vs. works-but-unofficial

- **Officially supported: CJK + English.** Their tokens are byte-identical to the pre-2026-05-29 behavior, so no re-indexing is required.
- **Works but unofficial:** accented Latin (Spanish, French, Vietnamese…), Cyrillic, Greek, Arabic, Thai, etc. now tokenize correctly for BM25, but have **no language-specific stemmer** (Porter is English-only and skipped for CJK) and **no stop-word lists** beyond English + CJK. Quality is "functional, not tuned." Pre-existing collections in these scripts would need re-indexing to match the new tokens.

### Scope boundary ⚠️

This applies to **retrieval/tokenization only**. Activation **Triggers and Advanced Conditions are still English-only and will be demised in future version** — see [§12](#12-trigger--condition-activation--english-only). Dense/vector search has always been language-neutral (embeddings are external).

**Note:** the old `similharity/index.js` copy of `extractQueryKeywords` was deleted (it was dead code — sparse vectors are computed client-side and passed to the server as `sparseQueryVector`). `core/query-keyword-extractor.js` is now the single source of truth; there is no longer a function to keep in sync.

---

## 10) javascript to get these variables in chrome console

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

1. **Qdrant has exactly one hybrid path — A3.** The A/B/C testing in [plans/qdrant-native-sparse-hybrid-rrf.md](../plans/qdrant-native-sparse-hybrid-rrf.md) picked native sparse + native RRF as the winner; the dropdown and the "Prefer Native Backend Hybrid" checkbox were both removed. A3 runs entirely server-side via Qdrant's `/points/query` endpoint with `prefetch: [dense, sparse]` and `fusion: "rrf"`.
2. **A3 uses globally-accurate IDF.** Qdrant's `modifier: "idf"` computes IDF over the true full corpus (every indexed document), not the ANN-bounded subset. This eliminates the BM25 IDF bias that A1 and A2 carry.
3. **Path routing is content-type-scoped.** ChunkBase's `keyword_scoring_method` no longer affects EventBase. Changing to "Hybrid" in ChunkBase tab only switches lorebook queries.
4. **Sparse vectors are tokenizer-locked.** The CJK tokenizer mode at upsert is baked into a sentinel metadata point on each Qdrant collection. Querying after a mode change shows a modal asking the user to revert or re-vectorize.
5. **A1/A2 quality on Standard depends on the Similharity plugin.** With the plugin installed (the common case), Standard backend gets real `vectorScore` values back, so A2 fuses dense + BM25 like a "lite A3". Without the plugin, ST's native `/api/vector/query` strips scores → A2 falls back to rank-based fusion. The path selection doesn't change, but the fusion quality does. See §15 (plugin dependency policy) and §8 ("vectorScore depends on whether Similharity is installed") for the full split.

### GUI hide/show rules

| Backend                       | Visible in Core                                                                                      | Visible in ChunkBase   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| **Qdrant** (A3 — only option) | Native-active notice + CJK Tokenizer Mode dropdown (Keyword Extraction subsection).**Fusion Method and RRF K are hidden** — Qdrant ignores them. | *(no hybrid controls)* |
| **Standard + BM25** (A1)      | Keyword Scoring Method, BM25 k1, BM25 b                                                              | Query Keyword Budget   |
| **Standard + Hybrid** (A2)    | Keyword Scoring Method, BM25 k1, BM25 b, Fusion Method, RRF K                                        | *(no hybrid controls)* |

Notes:

- "Prefer Native Backend Hybrid" checkbox was removed. The setting `hybrid_native_prefer` still exists in defaults (`true`) as an escape hatch for testing A2 against Qdrant without UI.
- Fusion Method and RRF K Constant are hidden on Qdrant because Qdrant runs `fusion: "rrf"` server-side with its own internal k constant; exposing the controls would be misleading. They reappear when the user switches `vector_backend` to Standard (where A2 actually uses them).
- The CJK Tokenizer Mode dropdown lives in the Keyword Extraction subsection (always visible). It's the **only** Hybrid Search & BM25 control that affects A3 — it drives the sparse-vector encoder.
- Visibility is driven by [`updateNativeHybridUI()`](../ui/ui-manager.js) which fires on changes to `vector_backend` and `keyword_scoring_method`. On Qdrant it always shows the Native-active notice (no toggle).

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

- Architecture/cleanup plan: [plans/qdrant-native-sparse-hybrid-rrf.md](../plans/qdrant-native-sparse-hybrid-rrf.md).
- GUI reorg plan: [plans/GUI_reorganize.md](../plans/GUI_reorganize.md) §13–§22 (Phase 2).
- Routing code: `queryCollection()` at [core/core-vector-api.js](../core/core-vector-api.js).
- A3 client entrypoint: `hybridQuery()` at [backends/qdrant.js](../backends/qdrant.js).
- A3 server entrypoint: `hybridQueryNative()` at [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js).
- Sparse encoder: [core/sparse-vector-encoder.js](../core/sparse-vector-encoder.js).
- Tokenizer lock + mismatch modal: [core/tokenizer-lock.js](../core/tokenizer-lock.js).
- EventBase invocation: `queryEvents()` at [core/eventbase-store.js](../core/eventbase-store.js) and direct `queryCollection` calls in [core/eventbase-retrieval.js](../core/eventbase-retrieval.js), [core/eventbase-workflow.js](../core/eventbase-workflow.js).

---

## 12) Trigger / Condition Activation — Language-Neutral

Activation Triggers and Advanced Conditions (Collection Settings → Activation panel) are **language-neutral**. They work for CJK (Chinese / Japanese / Korean) stories the same as for English.

### Why it works for any language

**Triggers** and the text-matching conditions (`pattern` / `speaker` / `characterPresent` / `lorebookActive`) match against recent messages with JavaScript `String.includes()` — see `checkTriggers()` in `core/collection-metadata.js` and `evaluatePatternCondition()` in `core/conditional-activation.js`. Substring matching is inherently language-neutral: `"贖身".includes("贖身")` is `true` regardless of script or whitespace. There is no tokenization or word-boundary assumption in the plain-string path.

**Numeric / structural conditions** — Message Count, Swipe Count, Time of Day, Generation Type, Group Chat, Random Chance, plus the chunk-only Recency / Frequency / Score Threshold — never inspect text and are trivially language-independent.

**Manual always-on** — "Active for current chat" and Character lock have no language dependency.

### One caveat: user-supplied regex

A trigger or `pattern` value wrapped in `/.../` is run as a real `RegExp`. If *you* type an ASCII word-boundary (`\b`) in that regex, it will not fire between CJK characters — that is a property of the regex you wrote, not of VectFox. For CJK, prefer plain substrings, or use Unicode word boundaries with the `u` flag (e.g. `/\p{L}+/u`).

### Removed: the Emotion condition (2026-06-02)

The **Emotion** condition and the standalone **Cotton-Tales emotion classifier** were removed. They were the only genuinely English-locked paths in the extension: the condition relied on a hardcoded English `EMOTION_KEYWORDS` list plus the English-trained Character Expressions sprite classifier, and the Cotton-Tales classifier recommended English-only transformers.js models. With them gone, the activation system has **10** condition types (was 11) and no language-dependent code remains. The multilingual sparse-search stack (`language-modes.js`, `stop-words.js`, `bm25-scorer.js`) is unaffected.

---

## 13) AgentMode — Agentic Retrieval

Optional LLM-planner step that runs between EventBase pre-search and re-rank. Sees the pre-search candidates plus recent chat context, then fans out 1-4 follow-up queries in parallel against Qdrant. **Purely additive — never replaces the existing flow.** A3 (Qdrant) only.

Plan document: [plans/executed/agentic-retrieval-plan.md](../plans/executed/agentic-retrieval-plan.md).

### Files

| File                                                        | Role                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [core/agentic-prompt.js](../core/agentic-prompt.js)         | System prompt + 2 few-shot examples (1 English, 1 CJK`贖身` case). Also builds the user-message portion (recent chat + current message + candidate summaries). |
| [core/agentic-retrieval.js](../core/agentic-retrieval.js)   | Public`retrieveEventsWithAgent(params)`. Runs pre-search, calls planner LLM, fans out queries, merges, re-feeds through canonical re-ranker. Includes `_resolveAgenticLLMConfig()` for inheritance from summarize_* fields. |
| [core/eventbase-workflow.js](../core/eventbase-workflow.js) | Switches between`retrieveEvents` and `retrieveEventsWithAgent` based on `settings.agentic_retrieval_enabled`. |
| [ui/ui-manager.js](../ui/ui-manager.js)                     | "AgentMode" tab (peer of Core/EventBase/etc.) with provider/model inheritance, sliders, debug toggle. |

### Flow

```
retrieveEventsWithAgent(params)
 ├─ STAGE 1 — retrieveEvents(params)              (existing pre-search, unchanged)
 ├─ STAGE 2 — early-exit if disabled or non-Qdrant → return pre-search
 ├─ STAGE 3 — _callPlanner({system, user, llmCfg, timeoutMs})
 │    LLM input: recent N turns + current user message + top-K candidate summaries
 │    LLM output: { queries: string[], filters?: {...}, rationale: string }
 ├─ STAGE 4 — Promise.all of queryCollection per (collection × planner-query)
 └─ STAGE 5 — retrieveEvents({skipLiveQuery: true, additionalCandidates: [...]})
              re-runs 4-weight rerank / dedup / context-dedup / top-K trim
```

### Planner-emitted filter application (Phase 1.5 — shipped)

- **Planner-emitted filters ARE applied** to queries. The planner emits `characters_any`, `locations_any`, `factions_any`, `items_any`, `concepts_any`, `event_type_any`, and `importance_gte`, validated and clamped by [`agentic-retrieval.js::_validateAndClampFilters`](../core/agentic-retrieval.js) (arrays capped to a reasonable max, `importance_gte` clamped to 1–10), then translated by Similharity's [`_buildHybridFilter`](../../similharity/qdrant-backend.js) into Qdrant payload `should` clauses (for `*_any` — OR within and across fields) and a `must` clause (for `importance_gte`). Both the non-rerank and formula-rerank Qdrant query paths apply them.

### Settings (all in `index.js` defaults)

```js
agentic_retrieval_enabled                false       // master toggle
agentic_retrieval_provider               ''          // '' → inherit summarize_provider
agentic_retrieval_model                  ''          // '' → inherit summarize_model
agentic_retrieval_openrouter_api_key     ''          // '' → inherit summarize_openrouter_api_key
agentic_retrieval_vllm_url               ''          // '' → inherit summarize_vllm_url
agentic_retrieval_vllm_api_key           ''          // '' → inherit summarize_vllm_api_key
agentic_retrieval_chat_depth             5           // slider 3-15
agentic_retrieval_candidates_to_show     12          // slider 5-20
agentic_retrieval_max_queries            6           // slider 1-6
agentic_retrieval_timeout_ms             30000       // hard timeout for planner call (matches summarize default)
agentic_retrieval_debug_logging          false       // separate from eventbase_debug_logging
```

Inheritance is centralized in `_resolveAgenticLLMConfig(settings)` — read it once, no scattered `||` checks elsewhere.

### Debug log shape (when `agentic_retrieval_debug_logging` is true)

All lines prefixed `[vectfoxPlus-Agentic]` so they're greppable and distinct from `[EventBase]` / `[Qdrant]`.

Per retrieval round emits, in order:

1. `mode=ON trigger=user_message_len=<N>`
2. `Pre-search returned <N> candidates (top score=<x.xx>)`
3. `Past chat turns sent to planner: <depth>`
4. `Narrative context preview` — one ~50-word snippet per turn (matches what the planner actually sees, and the count equals `agentic_retrieval_chat_depth`)
5. `LLM prompt size: system+user approx <T> tokens (<a>+<b> chars)` — size only, not the prompt text (it's noisy and the static system prompt is already in `core/agentic-prompt.js`; the narrative-context preview at step 4 already shows the dynamic part)
6. `LLM call complete: <ms>ms`
7. `Planner output:` followed by the full JSON response from the LLM (queries, filters, rationale)
8. `Qdrant fanout: <N> queries × <M> collections = <X> parallel calls`
9. `Qdrant fanout complete: <ms>ms`
10. `Per-query hits:` — one line per query with top score
11. `Agentic-only hits (not already in pre-search): <N>`
12. `Final merged candidates: <pre> + <agentic> = <total> → <final> after rerank/dedup/trim`
13. `Total wall-clock for agent overhead: <ms>ms (LLM=<ms>ms, fanout=<ms>ms)`

Timing buckets:

- LLM call ms (measured around `_callPlanner`)
- Qdrant fanout ms (measured around the `Promise.all` of `queryCollection` calls)
- Total agent overhead ms (measured from agent-stage entry through stage 5 return)
- Embedding batch ms — implicit inside each `queryCollection` call; not separately timed in Phase 1

### Failure modes — all fall back to pre-search

| Failure                                                          | Outcome                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `agentic_retrieval_enabled = false`                              | Skip stages 2-5; identical to today                                         |
| `vector_backend !== 'qdrant'`                                    | Skip; log`mode=SKIPPED reason=requires_qdrant_backend`                      |
| Missing model or API key                                         | Skip; log`mode=SKIPPED reason=missing_model` / `missing_openrouter_api_key` |
| Planner LLM throws / times out / returns invalid JSON            | Log warn; return pre-search only                                            |
| Planner returns 0 valid queries (after`_validateAndTrimQueries`) | Log; return pre-search only                                                 |
| One of N Qdrant queries fails                                    | Per-promise`.catch(err) → []`; other queries still merge                    |
| All Qdrant queries fail                                          | `agenticHits = []`; pre-search events still feed stage 5 re-rank            |
| `liveCollectionIds` empty                                        | Skip stages 4-5; return pre-search                                          |

**Invariant:** AgentMode MUST NEVER produce a worse result than today's flow. The drop-in shape of `retrieveEventsWithAgent` is designed so that on any failure the return value is exactly what `retrieveEvents` would have returned.

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
  agenticHitCount: number,      // events the agentic stage contributed before merge/rerank
}
```

Use these fields in future benchmark / diagnostic tooling.

---

## 14) Collections, Locks & Backend Routing

**See [Doc/collection_helper.md](./collection_helper.md).**

Originally lived inline as a 400-line section here. It outgrew the surrounding doc and was split out 2026-05-23 so the rest of `dev_helper.md` stays scannable. Everything related to collection listing, lock state, registry-key construction, backend routing for queries, and the UI checkboxes that mirror lock state is in that file.

If you are about to write code that:

- registers or looks up a collection
- reads or mutates a lock (chat or character)
- queries or deletes vectors for a specific collection
- decides which backend to route a query through
- builds the `backend:collectionId` storage key

…open `collection_helper.md` first. Every helper has been reimplemented inline at least once with subtly wrong behavior; the doc lists which functions to import instead.

---

## 15) Similharity Plugin — Dependency Policy

The Similharity plugin (`/api/plugins/similharity/*`) was built for Qdrant. Its relationship with the standard backend follows strict rules.

### Cross-repo version check (where to hunt)

VectFox warns when the installed similharity server plugin doesn't match the version VectFox expects. Code lives in **`index.js`** inside the `jQuery(async () => …)` init block, marked **`// D5: Cross-repo version check`**:

- Constant `SIMILHARITY_EXPECTED_VERSION` (keep in sync with `manifest.json` `version`).
- Fetches `/api/plugins/similharity/version`, compares `pluginVersion` with **exact `!==`** (not semver `<`).
- On mismatch: `log.warn(...)` + a `toastr.warning` telling the user to **restart SillyTavern so it auto-updates the server plugin**. Soft warning only — init continues.
- Plugin not installed → silently ignored (`catch`), since that's a separate concern.

Search hint: grep `SIMILHARITY_EXPECTED_VERSION` or `D5:`.

### Deployment scope — local / LAN only

**VectFox + Similharity is designed for a single-user SillyTavern install on the user's own machine (or private LAN).** It is NOT designed for:

- Public-internet exposure
- Multi-tenant deployments (untrusted users sharing one ST instance)
- Hostile-input environments

This is a deliberate scope, not an oversight. Two consequences a reviewer might flag and how we think about them:

1. **No SSRF defense on plugin embedding-relay routes.** Routes like `getVectorsForSource` accept user-configured URLs (`apiUrl`, `ollama_url`, `vllm_url`) and `fetch()` them server-side without host allowlisting. This is intentional — those URLs are legitimately set to `127.0.0.1` / RFC1918 addresses for self-hosted embedding servers. Adding allowlisting would either break legitimate localhost use OR be cosmetic-only at the plugin layer: anyone on the same LAN who can reach the qdrant port directly already has the same write/query access regardless of what the plugin does. The bigger picture is that **this whole project is designed for personal use, not multi-user**. Even Qdrant's open-source build ships without per-user authentication by default — the multi-user story requires Role-Based Access Control, which is way overkill for someone just trying to get a SillyTavern RAG running on their PC or closed LAN. Requiring it would defeat the "personal use, runs out of the box" point of this project. If your deployment context can't trust everyone on the network boundary, you need RBAC AND plugin-level allowlisting; neither alone is enough, and we're targeting the simpler scope on purpose.
2. **API keys stored plaintext in `settings.json`.** Same threat model: the user owns the machine, the keys are theirs, sharing the file means the user already failed key hygiene. ST itself uses the same pattern for most extension settings.

If you deploy ST in a context where untrusted users share the same instance — be aware of VectFox's limits. ST itself **does** support per-user data isolation via `enableUserAccounts = true` (per-user directories including `vectors/`, password auth, SSO). However, Qdrant ships without per-user authentication — a shared Qdrant instance has no concept of per-user collection ownership, so two ST users on the same Qdrant server can read and write each other's VectFox collections. Use a separate Qdrant instance per user, or container-per-user, if that matters for your deployment.

Documented 2026-05-24 in response to external code review (jotbird audit, item H-4). Full threat-model reasoning in `plans/review-fix.md §H-4`. The plugin's own header in `h:\Github\Dev\similharity\index.js` carries an identical scope statement.

### Rule: plugin is Qdrant-native, optional-only on standard

| Backend               | Plugin role                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| **Qdrant**            | Required. All inserts, queries, chunk listing, and management go through the plugin. |
| **Standard (Vectra)** | Optional enhancement only. Standard backend must be fully functional without it.     |

### Standard backend — what the plugin enhances (when installed)

| Feature                       | Without plugin             | With plugin                                                               |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Insert / write                | Native`/api/vector/insert` | Plugin`/chunks/insert` — adds metadata (keywords, importance, conditions) |
| Query / read                  | Native`/api/vector/query`  | Plugin`/chunks/query` — returns metadata alongside results                |
| Chunk listing (View Chunks)   | Not possible               | Plugin`/chunks/list` — full text + metadata                               |
| Chunk editing (text/metadata) | Not possible               | Plugin`/chunks/{hash}/text` + `/metadata`                                 |
| Stats                         | Hash count only            | Plugin`/chunks/stats` — rich stats                                        |
| Collection discovery          | Registry only              | Plugin`/collections` — filesystem scan                                    |

### The rule for new code

- **Standard backend (`backends/standard.js`):** Every plugin call MUST be gated by `this.pluginAvailable`. Every gated call MUST have a native-API fallback. No unconditional plugin calls.
- **UI and core modules (outside `backends/`):** Check `browserState.pluginAvailable` (UI) or make an explicit health check before calling plugin endpoints. Show a graceful message if unavailable — never throw an unhandled error.
- **Import/export (`core/collection-export.js`):** `insertChunksWithVectors` uses native `/api/vector/insert` for standard backend unconditionally — plugin is never called for inserts on standard backend regardless of plugin availability. This is intentional: the plugin insert path was originally there by mistake.

### Why the separation matters

Using the plugin for standard backend inserts created a hidden dependency: users without the plugin couldn't import collections. The native ST API supports pre-computed vector inserts via an `embeddings` map — there is no reason to route standard backend inserts through the plugin. The plugin's value on standard backend is read-side enhancement (metadata retrieval, chunk listing), not write-side.

### Test-suite coverage matrix — which tests run in which configuration?

The `tests/Eventbase-test.spec.js` suite runs against a live ST instance. Each test has a different relationship with the plugin and the qdrant backend. Tests that can't run on the current environment **soft-skip** (marked ⏭️ in the Playwright report via `test.skip(...)`) rather than failing — this is critical because the suite runs in **serial mode**, and a hard FAIL would halt every subsequent test. A no-plugin user running the full suite would otherwise be stuck at TEST 001 and never reach the standard-backend tests that DO work on their machine.

Three environment requirements to consider:

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
| **017**    | Pause button (`enabled=false`) blocks activation even when locked — priority 1 overrides priority 4  | ✅                       | ✅                                | ✅                                |
| **018**    | `shouldCollectionActivate` priority chain: triggers (P2) / conditions (P3) / character lock (P5) / nothing | ✅                       | ✅                                | ✅                                |
| **019**    | WI / AutoSync refresh smoke: refresh paths are pure UI mirrors (locks/autoSync/enabled unchanged after 3× idempotent calls) | ✅                       | ✅                                | ✅                                |
| **020**    | Qdrant: per-chunk override is backend-first (survives ext_settings wipe)                             | ⏭️ no plugin            | ⏭️ no qdrant config              | ✅                                |
| **021**    | Standard+plugin: per-chunk override is backend-first (survives ext_settings wipe)                   | ⏭️ no plugin            | ✅                                | ✅                                |
| **022**    | Standard+plugin: context/xmlTag wrapping + condition filter through retrieval (backend-first)        | ⏭️ no plugin            | ✅                                | ✅                                |
| **Totals** |                                                                                                      | **10 passed, 12 skipped** | **13 passed, 9 skipped**         | **22 passed, 0 skipped**          |

### Skip logic that drives the matrix

| Helper                      | Used by                    | Skip condition                                                                                       |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `skipIfQdrantUnavailable()` | TEST 001-004, 010-013, 020 | (a) Plugin probe fails, **or** (b) `qdrant_url`/`qdrant_host` not set in `extension_settings.vectfox`, **or** (c) qdrant config is set but qdrant is unreachable (emits a **WARNING** in the skip reason). |
| `skipIfNoPlugin()`          | TEST 008, 021, 022         | Plugin probe fails.                                                                                  |
| (none)                      | TEST 005-007, 009, 014-019 | These run in every environment. Split by what they exercise: **005-007** = real backend round-trips (standard backend embedding + chat retrieval); **009** = forces `pluginAvailable=false` to exercise no-plugin native path; **014-016** = pure-function auto-sync contracts (fingerprint cache, start marker, `stampAutoSyncMarker`); **017-019** = pure in-memory collection-metadata contracts (pause button overrides lock, priority chain, refresh-path purity). 014-019 don't need the plugin nor any backend — they operate directly on `extension_settings.vectfox` state and the registry. See [collection_helper.md → Chat Auto-Sync](collection_helper.md) for the 014/015/016 contract, and the same doc's "Pause/Resume" + "Manual vs auto-sync paths" sections for the 017/019 contract. |

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

**Critical insight (2026-05-24):** TEST 005/006/007 are **not** "plugin optional" in the sense of "if plugin missing, skip." They run end-to-end on case 1 (no plugin) too — and they're the regression gate that caught the no-plugin scope-resolution bug. See the case study below.

### Why this coverage matters — case study (2026-05-24)

When a no-plugin user reported "I can't lock a collection — the checkbox doesn't stick," the root cause was a 3-line chain:

1. `defaultCollectionMeta.scope = 'unknown'` (the string, not falsy)
2. `getCollectionMeta` returns the default object when no stored meta exists (no-plugin discovery path doesn't pre-stamp scope)
3. `storedMeta.scope || parsedMeta.scope` at [collection-loader.js:1007](../core/collection-loader.js#L1007) — `'unknown'` is truthy → OR short-circuits → correctly-parsed `'chat'` is ignored → `saveActivation` has no branch for `scope='unknown'` → silent no-op on the lock write.

With-plugin users didn't hit this because the plugin's discovery path pre-stamps proper scope before `getCollectionMeta` ever returns the default. The bug was strictly no-plugin. It existed for an extended period without surfacing because no test exercised "no-plugin user clicks the lock checkbox."

TEST 005 caught it the moment it started running on a no-plugin machine (the dry-run query returned 0 entries because the collection wasn't actually locked). This is exactly the value proposition of broad no-plugin coverage.

Fix landed 2026-05-24: default changed to `null`, with a defensive `!== 'unknown'` check at the load site for legacy collections that already have `'unknown'` saved on disk.

**Skip mechanism:**

- Spec-level `test.skip(condition, reason)` in [tests/Eventbase-test.spec.js](../tests/Eventbase-test.spec.js) — uses helpers `skipIfQdrantUnavailable()` and `skipIfNoPlugin()`. Marks the test ⏭️ in the Playwright report.
- In-eval defensive checks emit `[SKIP]` log lines that `assertPassed()` treats as soft-pass (no `[FAIL]`, no `[PASS]` required). Belt-and-suspenders for any case where the spec-level check doesn't fire.
- Plugin probe is cached per-page so the suite doesn't hit `/api/plugins/similharity/probe` more than once.

---

## 16) Known Pending Cleanups

### 16.1 ChunkBase phase early-gate — broaden vs current  (mainly performance issue, spending 20ms unnecessarily)

**Status**: Deferred — investigated 2026-05-17, no code change yet. Line refs refreshed 2026-10-11.

`rearrangeChat` ([core/chat-vectorization.js:1299](../core/chat-vectorization.js#L1299)) runs **EventBase Phase A** then unconditionally falls through to **ChunkBase Phase B**. (It also early-returns above Phase A entirely when `isVectFoxEnabled(settings)` is false — that master-switch gate is orthogonal to the Phase B early-gate discussed here.) Phase B has two existing gates:

1. **Early (cheap)** at [line 1394-1401](../core/chat-vectorization.js#L1394): `hasCollections = gatherCollectionsToQuery(settings).length > 0` — passes if *any* non-EventBase collection has `enabled=true`. No lock/scope/activation check.
2. **Post-activation (expensive)** at [line 1435](../core/chat-vectorization.js#L1435): `filterActiveCollections` runs the full [`shouldCollectionActivate`](../core/collection-metadata.js#L1133) priority chain (triggers → conditions → chat lock → character lock).

EventBase-only users (the typical case) hit gate 1 and short-circuit — debug log `[VECTFOX ChunkBase] No enabled ChunkBase collections ...` fires once per generation to confirm.

**What was considered**: tightening the early gate so it requires not just "enabled" but "enabled AND has some activation mechanism that could match the current context" — would avoid the keyword-extraction work at [line 1415-1422](../core/chat-vectorization.js#L1415-L1422) when a user has enabled lorebooks that aren't locked/triggered for the current chat.

**Why deferred**: A naïve `isLocked`-only gate would break users who rely on **Activation Triggers** or **Advanced Conditions** for activation without ever locking a collection (priorities 2-3 of `shouldCollectionActivate`). The safe shape is `enabled AND (chat-locked OR character-locked OR has triggers OR has conditions)` — a cheap pre-check that matches every activation path. Not worth doing in isolation; revisit if/when we touch Phase B for another reason.

**Caller count**: 1 — `rearrangeChat` is the only place running the EventBase→ChunkBase ordered workflow ([index.js:458](../index.js#L458) — `vectfox_rearrangeChat` is its sole caller via ST's `generate_interceptor`). No util-extraction is needed if/when we change the gate.

**Search tag in code**: none yet. When acted on, target [core/chat-vectorization.js:1398](../core/chat-vectorization.js#L1398) (the `if (!hasCollections && !canQueryWI)` block).

---

### 16.2 ~~Pre-existing test failures~~ — RESOLVED 2026-05-26 (+ stale-fixture follow-up RESOLVED 2026-05-30)

**Status**: Fully resolved. `npm test` now shows **602 passed | 0 failed | 14 test files passed**.

> **2026-05-30 follow-up:** A *new, unrelated* set of 3 failures appeared after the
> 2026-05-26 fix below, introduced by the language-neutral / English-stopword
> commits (`2c54c19 "fix stopwords for english"`, `45ad61d`, `5c14e47`). They were
> **stale test fixtures**, not source bugs:
> - [tests/bm25-scorer.test.js](../tests/bm25-scorer.test.js) "should split text into
>   tokens" used `'hello world test'` and asserted `world` survives — but `world`
>   is now an English stopword, so `tokenize()` correctly drops it. Fixed by
>   swapping the fixture to a content word (`dragon`).
> - [tests/keyword-boost.test.js](../tests/keyword-boost.test.js) (×2) asserted
>   `extractTextKeywords`/`extractBM25Keywords` filter out `'will'` — but `'will'`
>   is **not** in the project stopword set (only `willing` is), so that assertion
>   was always wrong. Fixed by asserting on `'within'`, which the set actually
>   contains. The `'the'`/`'and'` assertions still prove filtering works.
>
> Lesson reinforced: when a stopword test breaks, check whether the word is
> actually in `core/stop-words.js` (the set is curated, not the full line-224
> source list) before assuming a source regression.

Documented here for historical reference — the original 2026-05-26 problem and the fix had broader implications than just "make the tests pass."

#### Original state (before fix)

```
Test Files  4 failed | 9 passed (13)
Tests       20 failed | 443 passed (463)
```

Two distinct buckets of failure:

- **Bucket 1 — `tests/backends.test.js` (20 individual test failures)**
  `vi.mock('../core/providers.js')` factory was missing `getModelFromSettings`. Function was added to `providers.js` after the mock was written; every test path that reached `getModelFromSettings(settings)` threw `[vitest] No "getModelFromSettings" export is defined on the mock`.
- **Bucket 2 — `tests/backend-manager.test.js`, `tests/hybrid-search.test.js`, `tests/world-info-integration.test.js` (file-load failures)**
  Vitest tries to resolve ST relative paths (e.g. `../../../../extensions.js`) that live outside the project root. The test files didn't mock all the SillyTavern host modules their transitive imports needed → module-load fails → file fails to load → tests inside never run (silently hidden in the failing test-file count).

#### Fix summary

| Action                                                                                               | Where                                                                                                | Effect                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Added `getModelFromSettings: vi.fn(() => 'test-model')` to providers mock                            | [tests/backends.test.js:54](../tests/backends.test.js#L54)                                           | Resolved Bucket 1 (20 → 0 test failures)                                                             |
| Removed `@vitest-environment jsdom` directive                                                        | [tests/backend-manager.test.js](../tests/backend-manager.test.js)                                    | The jsdom env broke vite's import-analysis pre-pass for the SillyTavern mocks; removing it fixed 21 tests |
| Added SillyTavern + transitive mocks (extensions.js, script.js, plus `porterStemmer`, `getBackendForCollection`) | [tests/hybrid-search.test.js](../tests/hybrid-search.test.js)                                        | File loads; 56/56 tests pass                                                                         |
| Added SillyTavern + transitive mocks, `vi.hoisted` shared state for registry/sourceName/disabled flags, vf_ prefix + _T0 suffix on test collection IDs to match production format | [tests/world-info-integration.test.js](../tests/world-info-integration.test.js)                      | File loads; 37/37 tests pass                                                                         |
| 2 assertion updates for API drift                                                                    | hybrid-search.test.js (6th `filters` arg added to `backend.hybridQuery`), world-info-integration.test.js (`scope` default changed `'global'` → `'character'`, `isLorebookVectorized` no longer calls `buildLorebookCollectionId`) | Test assertions match shipped behavior                                                               |

#### **2 real source bugs uncovered and fixed**

The restoration surfaced two pre-existing latent bugs in `core/world-info-integration.js` that would crash any caller of `window.VectFox_WorldInfo.*` helpers from the browser console:

1. **[core/world-info-integration.js:16](../core/world-info-integration.js#L16)** — `getCollectionRegistry` was called at line 275 but was not imported. Anyone calling `isLorebookVectorized()` or `getLorebookVectorStats()` would have hit `ReferenceError: getCollectionRegistry is not defined`. Fixed by adding to the import.
2. **[core/world-info-integration.js:17](../core/world-info-integration.js#L17)** — `isCollectionEnabled` was called at line 337 in `getLorebookVectorStats` but was not imported. Same `ReferenceError` failure mode. Fixed by adding to the import.

Both bugs were invisible in production because the affected helpers are exposed on `window.VectFox_WorldInfo` for debugging — they're never called from VectFox's own code paths. The tests were the only callers that exercised them. **Without test restoration, these stayed latent indefinitely.**

#### **1 dead-code refactor** (test surfaced it)

- **[core/world-info-integration.js:277](../core/world-info-integration.js#L277)** — `_findLorebookRegistryEntry`'s `settings` parameter was effectively dead (function read from module-global `getCollectionRegistry()`, ignored the argument). Updated to honor `settings.vectfox_collection_registry` when caller supplies it; falls back to the global otherwise. Removes hidden dead code and aligns with test expectations.

#### Lesson

The test restoration discovered 2 production source bugs and 1 dead-code path that no other code path would have caught. Restoring tests when their assertions still look reasonable is a high-yield activity even when "just deleting them and trusting Playwright" feels easier — the Playwright suite only exercises the main flows, not the low-traffic helpers exposed for browser-console debugging.

If a future contributor sees broken-looking tests in the suite, the playbook is: (1) make them load by adding the missing mocks, (2) check whether failing assertions reveal real source bugs or stale test expectations, (3) only delete if the tested code has been removed.

---

### 16.3 BananaBread provider — fully removed (2026-06-13)

**Status**: Done. The BananaBread provider and all its code paths were removed across both the extension and the Similharity plugin. The earlier "partial cleanup, deeper paths remain" state described here is no longer applicable.

**What was removed** (extension): `createBananaBreadEmbeddings()` and `rerankWithBananaBread()` + STAGE 5 dispatch, the `case 'bananabread'` provider branches in [backends/standard.js](../backends/standard.js) and [backends/qdrant.js](../backends/qdrant.js), `'bananabread'` from every `clientSideEmbeddingSources`/known-sources array, the `bananabread_rerank` default + UI handler, `checkBananaBreadConnection` + the API-key/URL diagnostic branches, and the `bananabread_api_key` plaintext-drain migration in [core/api-keys.js](../core/api-keys.js). Plugin side: the bananabread embedding branch and the `/rerank` endpoint in the Similharity plugin.

**Reranking note**: this removed only the unreachable BananaBread cross-encoder rerank. The EventBase native weighted re-ranker (`eventbase_native_rerank` / `hybridQueryWithRerank`) is unrelated and remains fully intact.

### 16.4 Purge redundant `vectfox_chunk_meta_*` keys from `extension_settings` — deferred to ~2026-09

**Status**: Deferred. Do **not** implement before ~2026-09 (≈3 months after 2026-06-01).
**Depends on**: `plans/chunk-metadata-read-source-fix.md` Phase B having shipped and run in the wild for a while.

**Background**: Per-chunk metadata (`name`, `context`, `xmlTag`, `position`, `depth`, `keywords`, `conditions`, `links`, `enabled`) was dual-written to both the vector backend (Vectra-via-plugin / Qdrant) **and** `extension_settings['vectfox_chunk_meta_*']` since day one. That was the wrong design for the plugin/Qdrant paths — the backend is the durable, portable source of truth and `extension_settings` was only ever the *required* store for the long-gone Standard-no-plugin browser path. The read-source fix flips every reader to backend-first and (Phase B) stops the dual write. See `plans/chunk-metadata-read-source-fix.md`.

**What this cleanup is**: once Phase B has been live long enough that we're confident no reader still falls back to `extension_settings` for the targeted fields, write a one-shot purge that removes the now-orphaned `vectfox_chunk_meta_*` keys from `settings.json`.

**Why deferred, not now**:

- Phase A/B keep the ext_settings **read fallback** specifically to protect any chunk whose backend payload lacks a field — chiefly chunks text-edited under the old R8 path, whose annotations live only in ext_settings (see `plans/chunk-metadata-read-source-fix.md` §4.6/§5). Purging immediately would remove that safety net before we've validated the backend-first paths in real usage.
- No reconciliation pass was run (intentional — dual-write means the backend already mirrors ext_settings for everything except R8 text-edited chunks). Give the backend-first paths a few months of real traffic before pulling the fallback.

**Backfill decision (user, 2026-06-01): NONE.** We do **not** backfill the R8 orphan set before purging. Losing those chunks' annotations does not break anything — fields degrade to defaults and the chunk text is preserved. The user accepts the loss of post-import annotations on text-edited chunks (re-annotatable). So this purge can run after the soak as a straight delete, no backfill stage.

**When implementing (≈2026-09)**:

- Iterate `extension_settings.vectfox`, match the `vectfox_chunk_meta_` prefix (see `getAllChunkMetadata()` in [core/collection-metadata.js:396](../core/collection-metadata.js#L396)), delete those keys, `saveSettingsDebounced()`.
- Gate it: only purge fields that Phase B confirmed are backend-authoritative. If any field is still client-only (e.g. `summaries`, or some genuinely local UI state), preserve those keys/sub-fields.
- Per `CLAUDE.md`, this is migration logic — **confirm with the user before adding it**, and consider a one-time guarded run (versioned flag) rather than something that fires on every load.
- Tripwire: a user who downgrades to a pre-Phase-B build after the purge would lose their per-chunk overrides from the UI's perspective *only if* that old build read ext_settings-first — which it did. The backend still has the data; the old build just wouldn't show/use it. Acceptable, but note it in the purge's release notes.