# 🦊 VectFox — Advanced RAG for SillyTavern

> *Persistent memory for long-running roleplay stories*. VectFox delivers LLM-extracted story events, native sparse-vector hybrid search, and scalable performance powered by a real vector database.

![License](https://img.shields.io/badge/license-GPLv3-blue) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

**Languages:** **English** | [繁體中文](README_ZH.md) | [日本語](README_JP.md) | [한국어](README_KR.md)

![](assets/20260514_163417_vectfox.jpg)

---

## 🎯 What is VectFox?

Built on the excellent VectHare foundation, VectFox is a **high-performance long-term memory system for SillyTavern**. It goes well beyond a language-extended fork — all intelligent retrieval logic runs server-side inside a real vector database (Qdrant), a structured event-based approach replaces raw chunk summarization for dramatically more accurate recall, and queries return in under 3 seconds even at 2,000+ messages. Works with virtually any language out of the box, with extra stop-word tuning for English, Japanese, Korean, Traditional Chinese, and Simplified Chinese.

I branched the original VectHare to handle the massive scale of my personal [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) projects, which feature:

- **Extreme scale: 2,000+ replies per story, with 1,000+ words per reply. Summary retrieval returns in less than 3 seconds**
- Multi-language support: works with virtually any language out of the box, with extra stop-word tuning for English, Japanese, Korean, Traditional Chinese, and Simplified Chinese. Spanish, German, Arabic, Hindi, and others work without any extra setup.
- Strip out all functional tag from [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker).
- Super long term memory that actually works (2000+ messages)

Ordinary SillyTavern memory extensions completely buckle under this load, especially when there are a lot of functional tags reside inside the story used by [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker), which is useless for memory lookup. So, I need something that is able to clean up all these functional tags while maintain high speed vectorization on extreme scale.

Most memory extensions are designed for chats with 100 messages or fewer, and they work perfectly well at that scale. But as the chat grows past that, they're forced to summarize older messages more and more aggressively. You end up with full detail on recent history and a heavily compressed blur for everything older — and there's no real way around it, because you simply can't fit 100+ messages worth of raw context into the prompt or auto-created lorebook entries. Old memory *has* to be compressed, which means detail is lost.

Cars with square wheels will never solve the problem, no matter how much you fine-tune them. I need the right tool for the job. What I actually need is a dedicated vector database backend to properly store all these memories.

***I decided to build an architecturally correct memory system for SillyTavern that is close to a production-like design. Let's make memory hardcore!***

To tackle this, VectFox uses a dedicated vector database that stores **every single meaningful event** from the chat. Whether it's the first message or the 2,000th, every meaningful event stays in the database and is always available for SillyTavern to search.  I want a production grade memory vector system for SillyTavern which is scalable to 10k+ messages and round trip time within seconds.

### The Problem It Solves

- 🧠 **The original VectHare doesn't think about what's worth remembering.** VectFox adds an LLM-driven **EventBase** extraction layer on top: the AI decides which moments are meaningful events and tags each event with the characters, items, locations, and concepts involved.
- 🤖 **The original VectHare doesn't reason about your query** — it only matches surface-level text similarity. VectFox adds optional **Agent Mode** that uses a small LLM to plan multi-angle searches, surfacing memories your raw query wouldn't have found on its own.
- ⏳ **Semantic search can't *guarantee* the AI remembers what just happened.** Retrieval surfaces old events by relevance — but the last few turns of continuity (who's in the room, the thread you're mid-way through, the promise made two replies ago) should *always* be present, not have to win a recall slot. VectFox adds optional **Summarizer Injection** that pins the most recent N extracted events into every prompt, in chronological order — so short-term memory is guaranteed while long-term recall stays relevance-driven.
- 😩 Strip out all functional tags used by [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) before memory storage.
- 🧠 Adding story-based memory on top of character-based memory in [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker).
- 💸 Long conversations choke your token budget with irrelevant history.
- ✍️ You no longer need to manually edit context to remind characters of key events.
- 🎯 **Garbage in → Garbage out.** Summarizing raw chat into unstructured text blobs and vectorizing them produces noisy, low-signal retrieval. EventBase enforces a **strict structured format** (`characters`, `items`, `locations`, `concepts`, `keywords`, `importance`, `DateTime`) stored natively in the vector DB — not just text chunks. Agent Mode then queries this highly structured data with **targeted structural queries** (filtering by character, concept, location), dramatically increasing hit rate compared to pure text similarity over unstructured summaries.

**VectFox Solution:** Use **Qdrant** as a dedicated vector database that stores every meaningful event from the chat, no matter how long it gets. For users who aren't ready to run an extra service, a **"light" version using the A1 and A2 paths** runs on SillyTavern's built-in vector store with no additional software — it shares many features of the full vector DB at smaller scale. When you're ready for a real long-term memory system, upgrade to the **A3 path** with Qdrant.

Note: Qdrant is free and open source

### What VectFox is NOT trying to solve

VectFox is a **memory** system, not a tracker. It does not track quest progress, character stats, or live world state. For that, pair it with [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) — a character-based tracking system with a built-in GUI for quests, characters, and stats. Running both together covers roughly 90% of the memory and state problems that plague long-form SillyTavern roleplay.

---

## 🧠 How It Works

Vector search is like a really smart "find" function. Instead of matching exact words, it matches **meaning** — type "I'm hungry" and it can find a message that said "let's grab lunch" because the *meaning* is similar.

VectFox is built around two ideas that work together:

### 1. EventBase — events extracted from windows, not summary-per-reply

Most memory extensions take each/several AI replies and summarize it into one blob of text. That sounds fine until you look at what's actually in a reply:

- A 100-sentence reply might contain **5 meaningful events** (a fight, a discovery, a promise, an item swap, a relationship beat) buried in 95 sentences of filler dialogue, scene-setting, and chitchat
- Another reply might contain **zero events** — just banter
- A third might pack **1 event** into 1000 words.

Summary-per-reply flattens all three cases into "one blob per reply" — losing event boundaries, mixing important beats with filler, and producing the same data shape whether anything actually happened or not.

**EventBase looks at a window of recent messages and extracts 0, 1, or many structured events** depending on what actually occurred. Each event is its own record with rich metadata (`characters`, `locations`, `items`, `concepts`, `importance`, `DateTime`, etc.) — not just a description string.

If Tav had a long shopping trip with Astarion across 100 sentences of conversation among 3 other teammates and background story noise, EventBase might extract one event out of that wall of text:

```
{
event_type:    item_acquired
importance:    6
text:          Tav and Astarion shopped for armor in Baldur's Gate. Astarion mocked the prices.
               Tav bought a leather chestpiece for 80gp.
DateTime:      1492-08-15T14:00:00
cause:         Tav needed better armor before the Gauntlet of Shar expedition
result:        Tav now wears the leather chestpiece; 80gp spent from party funds
characters:    [Tav, Astarion]
locations:     [Baldur's Gate, Sorcerous Sundries district]
factions:      []
items:         [leather chestpiece, 80gp]
concepts:      [armor shopping, party economy]
keywords:      [armor, leather, chestpiece, gold, shopping]
open_threads:  [Gauntlet of Shar preparation]
should_persist: false

}
```

Later when you mention "remember the shopping trip?", VectFox retrieves **the event** — not 100 raw sentences, and not a blurry summary that averaged the shopping trip with the unrelated banter that surrounded it.

### 2. Why a dedicated vector DB is the natural fit

If you only do summary-per-reply, you don't really *need* a vector database. You're producing ~1 blob per reply, always the same shape, and you re-summarize them recursively as the chat grows. A simple text file would do — and that's exactly why many older memory extensions never bothered with a real DB.

But once you commit to EventBase, the picture changes:

- 2,000 replies → potentially **1,000–3,000 structured events** (some replies extract several, some extract none)
- Each event has rich fields: characters, locations, items, concepts, keywords, importance, timestamps
- You need to find the relevant 5–10 events by **meaning + keyword + metadata filtering**, in real time, while the user is mid-conversation

That's exactly the workload a **dedicated vector database like Qdrant is designed for**: many small structured records with both dense vector similarity and sparse keyword search, plus metadata filtering, plus global BM25 weighting across the full corpus. Trying to do this with a flat file of summaries would mean linear scans, no keyword indexing, no metadata filters, and no scale beyond a few hundred entries.

EventBase doesn't *force* you onto Qdrant — the A1/A2 light paths run on SillyTavern's built-in Vectra. But once your chat passes a few hundreds events, Qdrant is the storage layer that was actually built for this shape of data.

### 3. Agent Mode — let an AI plan your search (optional, Qdrant / A3 only)

Plain vector search has one weakness: it can only search for what you literally typed. Ask *"do you remember why I paid the ransom?"* and the search looks for events matching those words. But the real answer might involve the kidnapping that led to the ransom, the negotiation where the price was decided, and your character's reaction afterward — and your raw question doesn't mention any of those.

**Agent Mode adds a small "planner" LLM** that reads your recent chat plus the top semantic matches, then asks: *"What other angles should I search for to really answer this?"* It outputs 1–4 follow-up queries that fan out in parallel against Qdrant.

**Concrete example.** You type:

> *I say to Mayla, "Do you remember why I paid your ransom back then?"*

Without Agent Mode the search finds:

- ✓ The ransom payment event itself (direct keyword match on "ransom")

With Agent Mode the planner adds these angles automatically (illustrative planner output for this kind of query):

```json
{
  "queries": [
    "Critblade ransom Mayla reason",
    "Mayla past fear of abandonment",
    "Critblade promise to help find her father",
    "Mayla leadership challenge moment"
  ],
  "filters": {
    "characters_any": ["Critblade", "Mayla"],
    "concepts_any": ["ransom", "abandonment", "leadership"]
  }
}
```

Four parallel Qdrant searches return:

- ✓ The ransom payment (direct)
- ✓ Mayla's past fear of abandonment (emotional context)
- ✓ The promise to find her missing father (a related narrative beat the planner inferred from recent chat context)
- ✓ The leadership-challenge moment (a related arc the planner pulled in)

All four merge with the original search and feed the same 4-weight re-ranker. The main reply LLM then has the **full causal chain plus emotional context** instead of just the moment of payment.

**Why Agent Mode pairs with A3 (Qdrant)**:

- Each planner query is a separate Qdrant call. Qdrant fanout completes in 1–3 seconds for 4 parallel queries.
- AgentMode requires Qdrant — on the Standard backend it skips entirely (logs `mode=SKIPPED reason=requires_qdrant_backend`) and just returns the pre-search unchanged. No graceful degradation, by design.
- Qdrant's payload filters (`characters_any`, `locations_any`, `factions_any`, `items_any`, `concepts_any`, `event_type_any`, `importance_gte`) let the planner narrow each search precisely — the standard backend doesn't expose these.

**Cost & latency**: ~$0.0002 with GPT-4o-mini or Haiku as the planner, ~2–5 seconds added per turn. It's purely additive — never replaces normal search, and falls back cleanly to the standard flow if the planner fails. Configure it in the dedicated **AgentMode** tab; default off.

> 💡 Agent Mode works best on **reflective questions** ("why...", "remember when..."), **vague callbacks** ("that thing about my father"), and **cause-chain queries** where the literal user message doesn't contain the search anchors. For direct lookups where your message already contains the right keywords, the standard pre-search already does most of the work; Agent Mode is incremental polish.

### 4. Summarizer Injection — guaranteed recent-turn memory (optional)

Semantic retrieval answers *"which old event is relevant to this message?"*. But every reply also needs a second, different question answered: *"what just happened over the last few turns?"* — the running thread, who's present, the deal struck two replies ago. That continuity shouldn't have to **win** a relevance contest to be remembered; it should always be there.

**Summarizer Injection** does exactly that. Every turn it pulls the **most recent N extracted events** (default 20) straight off the EventBase collection — newest-first by message index — and pins them into the prompt in chronological order, each tagged with how far back it is:

```
<VectFoxSummarizer>
(3 turns ago) Critblade agreed to escort Mayla to the harbor before dawn.
(2 turns ago) They were ambushed in the alley; Mayla took a knife wound to the arm.
(latest turn) Critblade carried her into the apothecary and demanded a healer.
</VectFoxSummarizer>
```

It's independent of semantic retrieval and **stacks on top of it** (its own prompt slot, so the two never clobber each other). Retrieval still pulls the relevant *old* events by meaning; the summarizer guarantees the *recent* ones are always present regardless of score. With **full detail** on (default), each line also carries the event's structured fields (cause, result, characters, locations, items, time, concepts, keywords, open threads) — so it's effectively a structured "last-N-events" recap rebuilt fresh every turn from the database, never recursively re-compressed.

Because "most recent" only means anything if the database is current, the feature **requires auto-sync** and forces the auto-sync window to 1 turn while enabled, so the latest reply is always extracted before the next injection. A character budget (default 10 000) caps the block — if the events overflow it, the *oldest* are dropped and the newest always kept, so a huge recap can never blow out the model's context. Configure it in the **AutoSync** tab; default off.

> 💡 Think of it as the one genuinely useful thing rolling-summary extensions do — *"always remind the AI what just happened"* — rebuilt on EventBase's structured events instead of a lossy recursive text blob. You get the guaranteed recent context **without** the detail-destroying re-summarization.

#### 👻 Ghost vectorized messages — the token-saver payoff

Once Summarizer Injection guarantees the recent thread is always in the prompt, the raw text of *older* messages becomes redundant — those turns already live in EventBase, and the structured recap above covers the recent ones. **Ghosting** cashes that in: every turn it keeps the most recent N messages verbatim and **blanks all older already-vectorized messages from the outgoing prompt**, so the model leans on EventBase memory (the injection above + semantic retrieval) instead of paying for the same history twice.

- **Nothing is destroyed.** The wipe happens on a throwaway copy of the prompt only — your chat UI and the saved file are **untouched**, and the effect **resets every turn** (nothing to un-ghost, branch-safe). Lower the slider and the recap simply reaches further back next turn.
- **Scales to any chat length.** "Keep the last N raw" auto-scales — a 2,000-message chat sends roughly the same number of raw turns as a 200-message one, with everything older served from memory. Token cost stops growing with chat length.
- **Recall is the dial.** The fewer raw turns you keep, the more the AI relies on retrieval quality — so **check your recall as you lower the slider** and stop where the model still tracks the scene cleanly.
- **World Info stays safe.** The wipe is floored so it never blanks a message World Info needs to scan, and it auto-pauses if WI could scan the whole chat — keyword triggers keep firing at any slider value.

Because it leans entirely on EventBase being current, ghosting **requires Summarizer Injection** (which in turn forces the auto-sync window to 1, keeping the database one turn behind the live chat). Enable it right under Summarizer Injection in the **AutoSync** tab; default off.

### 🧠 Difference between traditional memory extensions

Most existing memory extensions use one of two approaches. Both lose detail as the chat grows. Here's why — and how EventBase avoids it:

| Aspect                      | 📝 Rolling Summary<br>*(most "memory" extensions)*                      | ✂️ Raw Chunking<br>*(older vector RAG)*                              | 🧬 EventBase<br>*(VectFox)*                                                                         |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **What gets stored**        | One ever-growing summary text                                            | Every message cut into raw chunks                                     | Structured event records with metadata                                                               |
| **At msg 100**              | Mostly intact                                                            | Intact                                                                | Intact                                                                                               |
| **At msg 200**              | Heavily compressed — names, numbers, and one-off details drift or vanish | Token budget overflow — older chunks score-pruned or dropped          | **Intact** — old events still in DB, surfaced by relevance                                           |
| **At msg 1,000+**           | Effectively a blur                                                       | DB bloat; retrieval gets noisy because raw chunks are low signal      | **Intact** — only the few events relevant to the current scene are pulled                            |
| **What "compression" does** | Re-summarizes the summary recursively, so every pass loses information   | None — but no synthesis either; raw text is hit-or-miss for retrieval | One-time, semantic — extracts*the meaningful event* and drops filler. Detail in the event itself is preserved. |
| **Retrieval signal**        | None — the whole summary is always injected                              | Vector similarity over raw text (catches paraphrases but also noise)  | Vector + BM25 hybrid over rich fields (`characters`, `items`, `locations`, `concepts`, `keywords`, `open_threads`, plus dense meaning) |
| **Where detail goes**       | Lost forever once compressed                                             | Lost when chunk drops below score threshold                           | **Doesn't go anywhere** — events live in the vector DB and surface when relevant                     |
| **What gets injected**      | The whole running summary (every turn, every time)                       | A few semantically-close raw messages                                 | Only the events that matter for the current message                                                  |

**The core insight:** rolling summaries lose detail because they *throw away* old content to make room. Raw chunking loses detail because *retrieval breaks* at scale. EventBase keeps every meaningful event around forever — and lets vector + keyword search decide which 5–10 of them are worth showing the AI right now. Detail isn't compressed; **irrelevance is filtered**.

**Where Summarizer Injection fits:** the one thing rolling summaries get *right* is that they always keep recent context in front of the AI. VectFox's optional **Summarizer Injection** rebuilds that guarantee on EventBase — it pins the most recent N structured events into every prompt — but without the recursive re-compression that makes rolling summaries lose detail over time. So you get rolling-summary's *"always remember what just happened"* **and** EventBase's *"never lose an old detail,"* from one structured store: recent turns are always injected, older turns surface by relevance.

> 💡 **The way you phrase your message has a big impact on what gets retrieved.** Because retrieval is driven by the text of your reply, the words you use matter. For example, *"Mayla, Do you remember why I paid the ransom?"* and *"Mayla, Do you remember why I paid 2,000 bucks?"* will return very different events — "ransom" pulls in every event tied to that storyline (the kidnapping, the negotiation, the drop-off), while "2,000 bucks" mostly matches events that literally mention the number 2,000. If you want the AI to recall a specific scene, anchor your message with the **story-meaningful words** from that scene rather than incidental details like exact numbers.
>
> In side-by-side testing on a 1,500-event chat, A3 (Qdrant) ranked the ransom events at **#1 / #2** for the well-anchored query and still surfaced them at the top for the numeric-detail query. A1 / A2 (standard backend) *did* find the same ransom events but ranked them lower (around **#3 / #5** for the well-anchored query, often outside the top events that actually get injected into the prompt). The difference is structural — A3 searches the full corpus via a sparse keyword index, while A1 / A2 score only the candidates the dense vector layer happened to surface (see the Path comparison below). Anchor wording matters on every backend; A3 is just more forgiving when you guess wrong.

---

## 🔍 Hybrid Search: A1 vs A2 vs A3 Path

VectFox combines **two signals** to find the best results:

- **Signal 1 - Vector similarity** — meaning-based ("hungry" matches "let's grab lunch")
- **Signal 2 - BM25 keyword score** — exact word match ("Astarion" matches "Astarion")

There are **three paths** for combining them, depending on backend and settings:  (From your browser to dedicated vector database on a docker)

### A1 — Standard backend + BM25

VectFox first finds about **100 events that *feel* related** to your message (by meaning), then re-checks only those 100 for your exact words and blends the two scores. It's fast and light, so it's a good fit for slower computers.

**The catch:** if the event with the perfect keyword wasn't in that first batch of 100, it never gets looked at — it's invisible to the keyword step.

<details>
<summary>⚙️ Technical detail</summary>

Browser does a vector search to get the top ~100 candidates, then computes BM25 keyword scores on just those candidates. Simple weighted sum: `α × vectorScore + β × bm25Score`.

</details>

### A2 — Standard backend + Hybrid (Recommend for most users that don't go the A3 path)

Same first step as A1 — grab the ~100 events that *feel* related — but A2 is **smarter about ordering** them. It ranks that same batch two ways (once by meaning, once by keyword), blends the two lists, and gives a bonus to events that score well on *both* signals. Recommended for most users who aren't on A3.

**The catch:** it's the same as A1's. A2 can only re-order the 100 events it already grabbed — it still can't pull in a keyword match that was missed in that first step. (Only A3 fixes this.)

<details>
<summary>⚙️ Technical detail</summary>

Browser does a vector search to get the top ~100 candidates, then ranks **the same candidate pool** two ways — once by vector similarity, once by BM25 — and fuses the two ranked lists via:

- **RRF (Reciprocal Rank Fusion)** — combines results by *position* in each list instead of raw score
- **Dual-signal bonus** — results that appear in *both* lists get up to +8% boost; single-signal results take a small penalty (×0.55 vector-only / ×0.60 text-only)

> ⚠️ **A2 is not independent sparse retrieval.** Both ranked lists are drawn from the *same dense ANN candidate pool*. BM25 can re-order what the dense layer already returned, but it cannot surface a keyword-only match that the dense ANN missed. Only **A3** stores a true sparse vector per event and runs sparse retrieval over the full corpus.

**Example:** Searching "Astarion drinks blood." If the dense ANN returned an event mentioning Astarion and blood (e.g. because "vampires/hunger" is semantically close), both rankings will surface it and the dual-signal bonus pushes it up. If a rare keyword-only event is outside the top-100 window, A2 won't find it — A3 would.

</details>

### A3 — Qdrant native sparse + server-side RRF + formula rerank (best accuracy)

A3 is the big upgrade. Instead of grabbing ~100 events first, Qdrant searches your **entire history two ways at once** — by meaning **and** by exact keyword — and does all the ranking and filtering on the server in a single request. So even a rare word buried in one event from 1,500 chats ago gets found directly, instead of being missed because it didn't make the first cut.

If you use **AgentMode**, it goes further: it breaks your question into several angles (*how did this happen? what led up to it? who else was involved?*) and narrows the search by who/where/what *before* searching, so irrelevant events never compete for a slot.

**Tradeoff:** Best accuracy, fastest at scale. Requires a Qdrant instance (free, open-source). → [Qdrant installation guide](Doc/Qdrant_install.md)

<details>
<summary>⚙️ Technical detail</summary>

A3 runs **everything inside Qdrant in a single API call**. The key structural advantage over A1 / A2 isn't just "faster" — it's that **A3 actually searches the full corpus by keywords**, while A1 / A2 only search by dense vectors:

1. **Dense + sparse hybrid retrieval over the FULL corpus** — Qdrant stores a sparse keyword vector on every event at upsert time. At query time it runs the dense index (meaning) and the sparse index (keywords) **in parallel against every event in the collection**, then fuses the two result lists via native RRF. This is the part that genuinely scales: if a rare keyword only appears in one obscure event from 1,500 chats ago, the sparse index finds it directly — no dependence on the dense vector layer happening to surface it. (A1 / A2 only score the ANN top-K candidates the dense layer returned, so events outside that window are invisible no matter how well their keywords match.) BM25 IDF is also computed globally on the server, so rare-word scoring is correct by construction.
2. **Server-side formula rerank** — Qdrant then applies a 4-weight rerank formula to those hybrid results inside the same call. Each `w_X` is a user-tunable weight slider; the term it multiplies is normalized so weights compose cleanly: `w_cosine × RRF_score + w_importance × (importance/10) + w_persist × (1 if should_persist else 0) + w_recency × exp_decay(source_window_end → chatLength)`. The final ranked list comes back already sorted. No extra round-trip. No browser JavaScript doing the scoring.
3. **Server-side filtering** — Minimum importance threshold and context dedup cutoff (events already visible in recent chat) are enforced inside Qdrant, not after the results arrive. Events below the threshold never leave the server.
4. **AgentMode semantic pre-filtering + multi-angle querying** — AgentMode does two things that compound each other. First, the planner LLM decomposes the user's question into multiple sub-queries from different angles — not just the surface meaning, but also *how did this happen?*, *what led up to it?*, *what were the consequences?*, *who else was involved?* Each angle runs as a separate vector search. Second, the planner emits structured entity filters (`characters_any`, `locations_any`, `factions_any`, `items_any`, `concepts_any`, `event_type_any`, `importance_gte`) applied as Qdrant payload clauses in the same call, narrowing the candidate pool *before* vector search even runs. The combination is powerful: multi-angle queries cast a wide semantic net while pinpoint filters ensure every search stays scoped to the right entities — irrelevant characters, locations, or event types never compete for recall slots.

The browser only handles anchor boost (phrase matching), pairwise dedup, and the final merge across multiple collections.

**Example:** Searching "I cast Fireball at the dragon." Qdrant searches dense (spell/attack meanings) and sparse (literal "Fireball" + "dragon") at the same time, fuses via RRF, ranks by importance/recency formula, filters low-importance events — and returns the final ready-to-inject list in one call.

**AgentMode example:** Asking "What deal did we make with Shadowheart?" The planner emits `characters_any: ["Shadowheart"]` and fans out into sub-queries: the original question, *"what agreement or promise involving Shadowheart"*, *"what event led to the deal with Shadowheart"*, *"what did Shadowheart ask for in return"*. Each sub-query runs against a Qdrant candidate pool already restricted to Shadowheart-tagged events — broad semantic recall, zero cross-character noise.

</details>

| What runs where                  | A1 — Standard + BM25                                        | A2 — Standard + Hybrid                                                           | A3 — Qdrant Native                                                       |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Requires Qdrant                  | ❌ No                                                       | ❌ No                                                                            | ✅ Yes (free, open-source)                                               |
| **Keyword search scope**         | Scores top ~100 dense candidates only (`topK × 2`, cap 100) | Scores top ~100 dense candidates only (`topK × 3`, cap 100)                      | **Searches every event in the collection by keywords** (sparse index)    |
| BM25 IDF weights                 | Corpus-wide (default on)                                    | Corpus-wide (default on)                                                         | Corpus-wide (server-side, always)                                        |
| Recall ceiling                   | Bounded by dense vector top-K                               | Bounded by dense vector top-K                                                    | **Union of dense + sparse results** — keyword-only matches still surface |
| Vector + BM25 score fusion       | Weighted-sum `0.5·v + 0.5·bm25`, browser                    | RRF + dual-signal bonus (+0–8%) + single-signal penalty (×0.55 / ×0.60), browser | **Server-side native RRF over dense + sparse vectors, 1 call**           |
| Importance / recency re-ranking  | Browser JS                                                  | Browser JS                                                                       | **Server-side formula** (Qdrant ≥ 1.13)                                  |
| Minimum importance filter        | Browser JS                                                  | Browser JS                                                                       | **Server-side**                                                          |
| Context dedup filter             | Browser JS                                                  | Browser JS                                                                       | **Server-side**                                                          |
| AgentMode semantic pre-filtering | ❌ Not supported                                            | ❌ Not supported                                                                 | **Server-side** (characters, locations, factions, concepts, event type)  |
| Network calls per query          | 1                                                           | 1                                                                                | **1** (hybrid + rerank + filter, all in one)                             |
| Scale ceiling                    | Hundreds of events (sub-second BM25 over ANN top-K)         | Hundreds of events (sub-second BM25 over ANN top-K)                              | **Thousands+ events** (sparse index, server-side rerank)                 |

| Backend setting                                                 | Path you get |
| --------------------------------------------------------------- | ------------ |
| Standard (Vectra - standard SillyTavern vector format) + BM25   | A1           |
| Standard (Vectra - standard SillyTavern vector format) + Hybrid | A2           |
| Qdrant (dedicated vector DB)                                    | A3           |

---

## ✨ Features

### 🧬 EventBase — LLM-extracted chat memory

LLM summarizes chat into structured events with importance/recency/persistence weights. A 4-weight re-ranker decides what gets injected. Built-in dedup suppresses events already visible in recent messages.

Each event is a structured record, not raw text. Example of what the LLM produces from the Astarion shopping window:

```
event_type:    item_acquired
importance:    6
text:          Tav and Astarion shopped for armor in Baldur's Gate. Astarion mocked the prices.
               Tav bought a leather chestpiece for 80gp.
DateTime:      1492-08-15T14:00:00
cause:         Tav needed better armor before the Gauntlet of Shar expedition
result:        Tav now wears the leather chestpiece; 80gp spent from party funds
characters:    [Tav, Astarion]
locations:     [Baldur's Gate, Sorcerous Sundries district]
factions:      []
items:         [leather chestpiece, 80gp]
concepts:      [armor shopping, party economy]
keywords:      [armor, leather, chestpiece, gold, shopping]
open_threads:  [Gauntlet of Shar preparation]
should_persist: false
```

Both signals (meaning + keywords) operate over this rich field set, so a query like "armor for the dungeon" hits via concepts/open_threads, while "Astarion 80gp" hits via characters/items/keywords.  The structure is native to Qdrant vector database so that hit rate is WAY higher than any other kind of memory extension.

### 🧠 Summarizer Injection — guaranteed recent-turn memory

Pins the most recent **N extracted events** (default 20) into every prompt, in chronological order, each labeled with its recency (`latest turn`, `3 turns ago`). Independent of — and stacked on top of — semantic retrieval, so short-term continuity is *always* present while long-term recall stays relevance-driven. With **full detail** on (default) each event carries its structured fields (cause, result, characters, locations, items, time, concepts, keywords, open threads); a character budget (default 10 000) caps the block, dropping oldest-first if it overflows so it can never blow out the model's context.

It's the useful half of a rolling summary — *"always remind the AI what just happened"* — rebuilt on structured events instead of a lossy recursive text blob, so recent context is guaranteed without the detail loss. Requires auto-sync (forces the window to 1 turn while on, keeping the database current). A **Debug Summarizer** button (Actions tab) previews the exact block that would be injected — same code path, minus the injection. Configure it in the **AutoSync** tab; default off. Needs the Similharity plugin on the Standard backend (it reads per-event metadata); works natively on Qdrant.

### 🤖 Agent Mode — LLM-planned multi-angle retrieval (Qdrant / A3 only)

A small planner LLM reads your recent chat plus the top pre-search candidates, then emits 1–4 follow-up Qdrant queries each targeting a different angle of what you asked about. Results fan out in parallel and merge through the same 4-weight re-ranker — purely additive, never replaces normal search. Falls back cleanly to the standard flow on any failure. Best for **reflective questions, vague callbacks, and cause-chain queries** where the literal user message doesn't contain the right search anchors.

- **Provider/model inheritance** — leave blank in AgentMode tab to inherit from your summarizer config; override with a cheaper model (e.g. Haiku 4.5, GPT-4o-mini) to cut planner cost.
- **Language-matching prompt** — planner emits queries in the chat language (Chinese, Japanese, Korean, Latin-script, English), preserving proper nouns. No cross-language pollution.
- **Configurable sliders** — past chat turns sent to planner (1–10), candidates shown to planner (5–20), max queries (1–6), timeout (1–60s), debug logging.
- **Real cost** — ~$0.0002 per turn with a small fast model, ~2–5 seconds added latency. Disabled by default — opt in when long-form recall matters.

See the **AgentMode** tab in settings, or the "How It Works → Agent Mode" section above for the full architecture.

### 🌏 Multi-language support

VectFox tokenizes and indexes any language — the BM25/keyword half is fully language-neutral. Every language works out of the box; five have extra stop-word tuning.

| Language                                      | Segmenter            | Stop-word list | Notes                                                                                 |
| --------------------------------------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------- |
| **English**                                   | Intl.Segmenter       | ✅ 667 words   | Always-on baseline; present in every mode                                             |
| **Japanese**                                  | TinySegmenter        | ✅ 672 words   | Particles 「は・を・の…」 stripped                                                    |
| **Korean**                                    | Intl.Segmenter       | ✅ 679 words   | Particles 「의・은・는…」 stripped                                                    |
| **Traditional Chinese**                       | Jieba WASM (TW dict) | ✅ 899 words   | `jieba_tw` mode only; distinct from Simplified                                        |
| **Simplified Chinese**                        | Jieba WASM           | ✅ 994 words   | `jieba` mode only; distinct from Traditional                                          |
| **Spanish, French, German, Arabic, Hindi, …** | Intl.Segmenter       | —              | Tokenize and index correctly; English stop-word baseline only (no dedicated list yet) |

**Stop-word lists are per-mode, not a global union.** A Korean collection consults only English + Korean (~1 346 words) — never the 2 200+ Chinese entries it used to. This prevents a Sino-Korean word from being silently dropped because it happened to match a Chinese grammar particle.

**Combining-mark scripts** (Indic: Hindi, Tamil, Bengali…; Arabic harakat) tokenize as whole words — matras and virama (`्`) are preserved rather than stripped, so `युद्ध` ("war") indexes intact instead of shattering into fragments. Dense/semantic search has always been language-neutral; this extends the same quality to the BM25/keyword half.

**Adding a language's stop list** is a one-file PR: add the word array + one line in the locale registry + one record in the mode table. Nothing else changes.

- CJK tokenizer mode is **locked per Qdrant collection** at upsert — switching modes shows a warning modal

### 🛡️ Resilient vectorization — built to finish, no matter what

Long stories on bad connections are where naive vectorizers die: one stalled embedding call, one flaky timeout, and a 2,000-message ingest is wrecked halfway through. VectFox is built so vectorization **always makes forward progress and always recovers** — three independent safety nets, each containing a different failure mode.

- **Request hedging** — when an embedding call goes quiet past a threshold (15s by default), VectFox fires a *duplicate* request on a fresh connection instead of waiting. Up to 3 hedges race the original; first to answer wins, stragglers are dropped. A single stuck SiliconFlow worker or a bad OpenRouter routing decision no longer freezes the whole run — a new connection simply routes around it. (Skipped for local GPU endpoints, where a new connection lands on the same server anyway.)
- **Parallel-split embedding** — instead of one giant batched POST where a *single* stuck item hangs everything (we measured 555-second monster batches), VectFox splits the batch into one-item requests fired in concurrent waves of up to 16. The blast radius of any bad item is exactly one item: it retries in isolation while everything else sails through.
- **Pipelined extract → insert with overlap** — batch N's vector insert overlaps batch N+1's LLM extraction, so the pipeline never idles on a single slow phase (~35% faster wall-clock on long chats). Overlapping extraction windows capture events that straddle a window boundary, and a fingerprint cache that survives Chrome restarts lets a half-finished run resume exactly where it stopped instead of starting over.

Together these compound: the worse the environment — longer story, flakier connection, slower provider — the harder they work. Vectorization recovers and completes rather than stalling out.

### 🔍 Native sparse-vector hybrid search (Qdrant)

A3 path described above — server-side RRF with globally-accurate BM25 IDF. Single round-trip per query.

### 📝 Summarize before store

Mandatory LLM summarization before vector storage. Supports OpenRouter and local vLLM-compatible endpoints. Configurable prompt template.

### ⏯️ Better vectorization controls

Stop button, pause/resume, fingerprint cache that survives Chrome restarts mid-run.

### 🔒 Per-chat collection scoping

New collections auto-activate for the current chat. "Active for current chat" checkbox controls the chat lock. Lock button in the Database Browser shows whether a lock is for *this* chat or another.

### 📡 Smarter status indicators

Auto-Sync card shows whether the current chat is vectorized and how many events exist. World Info card shows vectorized lorebooks by name. Both link to the right vectorizer if something's missing.

### 🗂️ Tabbed interface

Settings split into **Core** (backend, embedding, hybrid), **EventBase** (chat hsitory/archive chat file .jsonl), **ChunkBase** (lorebook/docs/URLs/wiki), **Action** (diagnostics, dev tools).

### ⚡ Parallel Windows — Vectorization Speedup

Vectorizing a long chat normally processes one window at a time: send window 1 to the LLM → wait → embed → send window 2 → wait → embed → ... For a 2000-message chat that's a lot of serialized waiting.

The **Parallel Windows** slider (Chunking Strategy section in Vectorize Content) lets you spawn up to **8 LLM extraction + embedding calls at the same time**. Window 1 is being extracted while windows 2–8 are also in flight, dramatically cutting total ingestion time.

| Slider value   | Behavior                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **1 (safe)**   | One window at a time. Lowest provider load, no risk of rate limits, slowest.                         |
| **2–4**        | Mild parallelism. Good middle ground for most providers.                                             |
| **5–8 (fast)** | Aggressive parallelism. Best for cloud providers with high rate limits (OpenRouter, OpenAI, vLLM). May trip rate limits on free tiers. |

Use **1** if you're on a strict rate-limited free tier or a single local GPU. Crank to **8** if you're on a paid cloud provider and want a 2000-message chat ingested in minutes instead of an hour.

### 🧹 Multilingual keyword quality

Better single-character filtering for CJK, mode-specific exceptions for high-signal 1-character RPG/Slice of Life/school terms.

### 🧹 Major cleanup

Numerous bug fixes around mixed-backend search, handle ID filtering, and other enhancement from the original VectHare.

---

## 🎭 Activation Rules

Each collection card has an Activation panel. The priority chain is:

1. **Disabled** (pause button) → never queries
2. **Triggers** → keywords match recent messages → activates
3. **Advanced Conditions** → if triggers empty/no match, evaluate condition rules → activates
4. **Active for current chat / Character lock** → manual always-on fallback
5. **Nothing matched** → does not activate

Conditions support keywords/patterns, speaker, character-present, message/turn count, time of day, and combined AND/OR rules.

> ⚠️ **Legacy feature note:** Triggers and condition-based activation are **inherited from VectHare** and kept here for backward compatibility only. Due to major architectural changes in VectFox, **users should always make collections "Active for current chat" or use Character lock** instead of relying on triggers/conditions. The whole point of vector search is to let the search engine search everything — selective activation based on keyword triggers defeats that purpose.
>
> **CJK note:** Triggers and condition-based activation are **language-neutral** — keyword/pattern matching uses plain substring search, which works for Chinese/Japanese/Korean the same as English. (Only user-written regex with ASCII `\b` boundaries won't fire across CJK — use plain substrings or `\p{L}` + the `u` flag.)

---

## 📦 Backends

| Backend                                                   | Best for                                      | Notes                                                                                 |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Standard (Vectra - SillyTavern default vector format)** | Small datasets, multilingual, getting started | No dependencies. Limited to A1/A2 hybrid.                                             |
| **Qdrant**                                                | Large chats, multilingual, production         | A3 hybrid (best accuracy). Requires Qdrant + Similharity plugin (installation below). |

Use **Qdrant vector database** for any ultra fast and accurate delopment — A3 is materially more accurate than A1/A2, especially for CJK and multi-language content, and it is free and opensource.  2000+ events in the database takes less than 3 seconds round trip search.

---

## 💾 Installation

> **Recommended: Use Qdrant Cloud (Free)**
> A free Qdrant Cloud account is available at https://qdrant.tech/ — it includes **4 GB of storage**, which comfortably fits **100 000+ messages** with no cost. After registration you receive an **API URL** and **API Key** that you paste directly into VectFox — no server to manage.
>
> We encourage Qdrant over the Standard backend because it uses the **A3 hybrid search algorithm**, which is materially more accurate than A1/A2 — especially for CJK and long-form narratives.
>
> Prefer lower latency? A **local Qdrant installation** is significantly faster (no network round-trip). See [Doc/Qdrant_install.md](Doc/Qdrant_install.md) for setup instructions.

### Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Go to **Extensions** panel (puzzle piece icon)
3. Click **"Install Extension"**
4. Paste this URL:

   ```
   https://github.com/KritBlade/VectFox
   ```
5. Click **Install**

That's it! VectFox will be downloaded and enabled automatically.

### Step 2: Install Similharity Plugin (Required for Qdrant — Optional but recommended for Standard)

**Required if using Qdrant backend.** Optional if using the Standard backend, but installing it unlocks additional functionality even there:

| Feature                                   | Standard without plugin             | Standard with plugin            | **Qdrant (Cloud or Local)** ⭐                                                    |
| ----------------------------------------- | ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Event search & injection                  | ✅ Full functionality               | ✅ Full functionality           | ✅ Full functionality                                                             |
| Summarizer Injection (recent-turn memory) | ❌ Needs per-event metadata         | ✅ Available                    | ✅ Available                                                                      |
| Embedding & vectorization                 | ✅ Works                            | ✅ Works                        | ✅ Works                                                                          |
| Keywords stored in DB (boost search)      | ❌ Saved to local settings only     | ✅ Stored in vector DB          | ✅ Stored in vector DB                                                            |
| Event importance score                    | ❌ Lost (native API drops metadata) | ⚠️ Stored, not used in re-rank | ✅ Stored & used in re-rank                                                       |
| View Chunks in Database Browser           | ❌ Not available                    | ✅ Available                    | ✅ Available                                                                      |
| Edit individual chunks                    | ❌ Not available                    | ✅ Available                    | ✅ Available                                                                      |
| Search algorithm                          | A1/A2 hybrid                        | A1/A2 hybrid                    | **A3 hybrid (best accuracy)**                                                     |
| Scales to large datasets                  | ⚠️ Degrades on long story          | ⚠️ Degrades on long story      | ✅ 10 k+ messages, stays fast                                                     |
| Setup                                     | None                                | Plugin install                  | Plugin install + Free cloud account **or** [local install](Doc/Qdrant_install.md) |

If you are on the Standard backend and do not install the plugin, event search and injection still work correctly — you just won't have chunk inspection or keyword metadata. For the best retrieval quality, **Qdrant is strongly recommended** — the free cloud tier at https://qdrant.tech/ requires no local setup at all.

#### First-time on Windows? Install Git and Node.js first

The install commands below use `git` and `npm`. On Windows you need to install these once before they will work. (If you already run SillyTavern from source you have Node.js/npm already — you may only need Git.)

1. Press the **Windows key**, type **`cmd`**, and press **Enter**. A black Command Prompt window opens.
2. Type these two commands one at a time, pressing **Enter** after each and letting it finish:

   ```bat
   winget install Git.Git
   winget install OpenJS.NodeJS.LTS
   ```

   `Git.Git` gives you the `git` command; `OpenJS.NodeJS.LTS` installs Node.js, which includes `npm`. `winget` is built into Windows 10/11 — nothing extra to install.
3. **Close the Command Prompt and open a new one** (repeat step 1) so the new commands are picked up.
4. Verify: type `git --version` then `npm --version`. Each should print a version number.

> On **Linux/Mac**, install Git and Node.js with your package manager instead (e.g. `sudo apt install git nodejs npm`, or `brew install git node`).

#### Instruction on installing the plugin:

Open the Command Prompt (Windows) / Terminal (Linux/Mac) / Console (Docker), then run:

```bash
cd SillyTavern/plugins
git clone -b Similharity-Plugin https://github.com/KritBlade/VectFox.git similharity
cd similharity
npm install
```

Search the following key in `config.yaml` and change to true:  (Windows will be at SillyTavern\config.yaml while linux/Mac should be at SillyTavern\config\config.yaml)

```yaml
enableServerPlugins: true
```

Restart SillyTavern.

### Step 3: Configure VectFox

1. Open **VectFox Settings** (Core tab in the extensions panel).
2. Choose your vector storage (Standard or Qdrant).
3. Select your embedding provider (Transformers, vLLM, Ollama, OpenRouter, etc.).

   - 💡 **Recommended:** use `qwen/qwen3-embedding-8b` through **OpenRouter**. It's extremely cheap ($0.00000015/run), multilingual (excellent CJK + Latin), and produces high-quality dense vectors for the corpus size VectFox targets. The better embedding model you use, the better result you will receive from recall, this is the most important model that you do NOT want to use cheap model.
4. Select your Summarization LLM (OpenRouter or vLLM) — used by EventBase extraction during vectorization.

   - 💡 **Recommended OpenRouter models:** for a cheap & fast extraction path, use `openai/gpt-4o-mini` or `google/gemini-3.1-flash-lite` — both keep cost and ingestion latency low. If you want higher extraction quality and don't mind paying more, `x-ai/grok-4.3` is a stronger but more expensive option. Avoid older model IDs such as `x-ai/grok-4.1-fast` if OpenRouter returns a 404/deprecation error; model availability changes over time, so verify the exact ID on OpenRouter before long ingestion runs. The same recommendation applies to the **Agent Mode LLM** (configured separately in the AgentMode tab) — if you leave the AgentMode model field blank it inherits this summarizer setting.
5. Configure API keys if using cloud providers (OpenRouter / vLLM ).
6. Under **Keyword Extraction**, choose the language of your story.
7. Most settings work fine on default — feel free to tweak.
8. Open your chat in SillyTavern, then click the VectFox extension icon again. You **HAVE** to click "Vectorize Content" and choose **Chat History** to vectorize your first DB.
9. Enable Auto-Sync if needed in the **AutoSync** tab. Frequency is controlled by the EventBase tab under *Extraction > Window Size*.
10. Vectorize your lorebook / World Info if needed in the **WorldInfo** tab.
11. (Optional) Turn on **Agent Mode** in the AgentMode tab once everything else works. Leave provider/model/API-key blank to inherit from your summarizer config — that way the same cheap/fast model used in step 4 also drives the planner. See "How It Works → Agent Mode" above for what it does.

---

## 🔄 Auto-Updates

VectFox has **two halves that update separately**: the extension (this repo) and the Similharity server plugin (Step 2 above). Updating one does not update the other, and a stale plugin against a current extension is a combination we do not test — it produces confusing, hard-to-diagnose failures. Keep both current.

### The extension

VectFox has `auto_update: true` in its manifest. If you installed via `git clone`, SillyTavern will automatically check for and apply updates.

Look for the update notification in the Extensions panel, or manually check with the "Check for Updates" button.

### The Similharity plugin

**If you installed the plugin via `git clone` (Step 2 above)**, it updates automatically every time you restart SillyTavern — SillyTavern runs `git pull` on every plugin folder that is a git repository at startup. This is enabled by default.

To verify it is working:

1. Check that a `.git` folder exists inside `SillyTavern/plugins/similharity/`.
2. On startup, look for this in the SillyTavern **server console** (the terminal, not browser F12):

   ```
   Auto-updating server plugins...
   ```

3. Confirm the running version — visit `/api/plugins/similharity/version` in your browser, or look for this line on startup:

   ```
   [similharity] Initializing v3.3.4...
   ```

**If you downloaded the plugin as a ZIP**, auto-updates will **not** work — there is no `.git` folder for SillyTavern to pull. This is the most common cause of a silently outdated plugin. To fix:

1. Delete the `SillyTavern/plugins/similharity` folder.
2. Reinstall via `git clone` — see Step 2 above.
3. Your settings and vectorized data live elsewhere and are not affected.

To disable plugin auto-updates, add to `config.yaml`:

```yaml
enableServerPluginsAutoUpdate: false
```

Note that `enableServerPlugins: true` is required for the Qdrant backend regardless.

---

## ❓ FAQ

**Why are there two separate pipelines under the hood?**
Internally VectFox routes content through one of two retrieval paths, picked by content type:

| Pipeline             | What it handles                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **EventBase**        | Your chat history (live chat + uploaded`.jsonl` archives)                                    |
| **Standard (Chunk)** | Everything else: Lorebook, Character Cards, URLs, documents, wiki pages, YouTube transcripts |

They never see each other's content — so the same chat message can't get retrieved twice (once as an event and once as a raw chunk). You don't normally need to think about this; it just means EventBase owns chat, and the standard chunk pipeline owns everything else.

**Can I change the CJK Tokenizer Mode mid-chat?**
No — don't do it. The CJK Tokenizer Mode is **locked into each Qdrant collection at upsert time** via a sentinel point. Switching modes after you've already vectorized content will trigger a "Tokenizer mismatch" warning modal on the next query, and your only real options are:

1. **Revert** to the original mode (preserve existing vectors), or
2. **Re-vectorize the collection from scratch** with the new mode (throw away all extracted events and start over).

Pick your tokenizer mode *before* you start vectorizing a chat and stick with it. There's no in-place migration — sparse vectors were tokenized with the original mode, so they're incompatible with a different tokenizer's output.  Pick your embedding model *before* you start vectorizing a chat and stick with it.

**Can I use triggers/conditions on Chinese/Japanese/Korean chats?**
Yes. Keyword/pattern matching uses plain substring search, so it works for CJK the same as English. The only caveat is user-written regex using ASCII `\b` word boundaries (which don't fire between CJK characters) — use plain substrings or Unicode `\p{L}` with the `u` flag. Numeric conditions (Message Count / Turn Count) are always language-independent.

**How do I delete a collection safely?**
**ALWAYS use the Database Browser inside VectFox** (Action tab → "Database Browser" button) to delete collections. Click the red "Delete" button on the collection card. This properly cleans up both the vector database **and** VectFox's internal registry + metadata. Never delete collections manually from Qdrant's web UI or by editing SillyTavern's `settings.json` — doing so leaves orphaned metadata that causes sync conflicts, "collection not found" errors, and other strange behavior.

**Why "scene" settings can't be found?  It was in the original VectHare**
Scene support was removed (it was a chunk-based-chat-era feature, and chat now runs through EventBase). Grouping events together is not quite logical, so the feature was removed.

**The explanation of the system sounds way too technical and I can't understand!**
I agree. This extension might be overkill for a typical SillyTavern chat. Who the hell will chat for 10,000+ replies? But the quality of retrieval does matter.

**Is this extension safe for multi-user or public-facing deployments?**
VectFox + Similharity is designed for **personal use on your own machine or a trusted private LAN** — not for public internet or shared multi-user environments. Two reasons:

- **Qdrant** ships without per-user access control in its default installation. On a shared Qdrant instance, anyone who can reach the port can read and write all collections. Two users sharing the same Qdrant server can read and modify each other's VectFox collections.
- **The Similharity plugin** has no per-user authentication. It relays embedding and query requests to your backend (OpenAI, Ollama, vLLM, etc.) without user-level isolation.

Adding proper RBAC to Qdrant and per-user ACLs to the plugin is significant engineering work that is out of scope for a drop-in vector memory extension. If you need multi-user isolation, run a separate Qdrant instance and a separate SillyTavern install per user, or use containerised deployments.

Note: SillyTavern itself does support per-user data isolation via `enableUserAccounts = true` — that isolates ST's own data (chats, settings, characters) per user, but does not extend to the shared Qdrant server.

**I keep getting long timeouts or "500" errors while vectorizing. What can I do?**
Try **unchecking "Group embedding calls"** (Core tab → Embedding section).

By default VectFox packs a whole batch of text into **one** request to your embedding provider — faster and cheaper when everything is healthy. But if the provider, or the gateway in front of it (OpenRouter, a cloud relay, etc.), is having a bad moment, that single big request can hang or come back as a `500`, and the **entire batch fails together**.

Unchecking the box switches VectFox to **one request per item**. Now if a single item lands on a stuck server worker, only that one item is affected and the rest go through. It's a bit more network chatter, but it routes *around* an unstable upstream instead of going down with it.

> 💡 Leave it **checked** normally. The moment you start seeing batch-wide timeouts or `500`s, **uncheck it** as a quick rescue and re-run.

**What does "Hedge slow embedding calls" do, and do I need it?**
It's an automatic safety net for **stuck** embedding requests. It's **on by default (15 seconds)** and most people never need to touch it.

The problem it solves: sometimes a request to a cloud embedding provider doesn't fail — it just **hangs**. The connection gets routed to a frozen worker and sits there doing nothing, often until SillyTavern finally gives up about 2 minutes later. That one stuck request can stall your whole vectorization run for no reason.

Hedging fixes this. If a request hasn't answered within the time limit (15s), VectFox quietly fires a **second, identical request on a fresh connection** — without cancelling the first. Whichever one replies first wins; the loser is thrown away. The fresh connection usually gets routed to a *healthy* worker, so you recover in seconds instead of waiting out the full timeout. (Sending the same text twice is harmless — a duplicate just overwrites the same database entry with identical data.)

> 💡 Leave it on — it only ever activates when something is already going wrong, and it makes flaky cloud providers far less painful. It's automatically skipped for **local** models (Ollama, Transformers, llama.cpp, KoboldCpp), where a second connection wouldn't change anything. Set it to `0` to disable.

**How do I configure NanoGPT as a provider?**
First select **vLLM** as the provider — that's the OpenAI-compatible slot that exposes the custom URL fields NanoGPT needs. From there the embedding and summariser endpoints must be set up *differently*; the same base URL won't work for both. These settings are courtesy of Reddit user **[u/aturbofrog](https://www.reddit.com/user/aturbofrog/)**:

| Setting             | Value                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Embeddings URL**  | `https://nano-gpt.com/api/v1/embeddings` — the full path is required; the base URL alone fails |
| **Embeddings Model**| `Qwen/Qwen3-Embedding-8B`                                                                       |
| **Summariser URL**  | `https://nano-gpt.com/api/v1/` — leave it at the base; appending `chat/completions` oddly fails the tests |
| **Summariser Model**| `nvidia/nemotron-3-ultra-550b-a55b` (or any chat model you prefer)                              |

A couple of gotchas:

- **Enable paid models.** For embeddings to pass VectFox's connection tests, toggle **"Enable paid models on API"** on in your NanoGPT account settings.
- **Zero output tokens is normal.** The NanoGPT usage page shows **zero output tokens** for every embedding run — that's expected (embeddings don't generate output tokens), not a sign anything is broken.

---

## 🐛 Troubleshooting

**"No embeddings available"** — Click the Vectorize Content icon, Enable Vectors extension in main ST settings, select an embedding provider, add API key if needed, run Diagnostics.

**Events/chunks not retrieved** — Make sure you are already in the chat, not in the lobby of Sillytavern, Click Database Browser icon, click on the collection of the chat, confirm the collection is "Active for current chat".

**"What would the AI actually recall for this message?"** — Use the **Debug Query** button in the Actions tab for "what-if" testing. Type any text and run it against the live database to see exactly which events would be retrieved and their scores, without sending a real chat message. Useful for tuning thresholds and verifying that important events are indexed correctly.

**"Backend health check failed"** — On Qdrant, make sure the Qdrant server is running and the Similharity plugin is installed.

**Slow performance** — Switch to Qdrant + A3 (single round-trip, server-side fusion). Reduce EventBase Top K. Use API embedding providers (parallel) instead of local GPU (sequential).

**Vectorization is slow on large chat histories** — VectFox applies API rate limiting by default (60 calls per 60 seconds) to protect free-tier backends. To speed up vectorization: **Settings → Core Tab → Embedding → API Rate Limiting → set "Max Calls" to 0 to disable**. For production Qdrant, you can increase it to 100+ calls/min depending on your server capacity.

---

## 🙏 Credits

**VectFox** is branched from VectHare, originally created by **Coneja Chibi**. Thanks to the SillyTavern community for feedback and testing.

GPLv3 License — see LICENSE.

---

*"Let's make memory hardcore!"* 🦊✨